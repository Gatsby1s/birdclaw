import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { recoverOrphanedProfileLock } from "../profile-lock.mjs";

const NAMES = ["SingletonLock", "SingletonCookie", "SingletonSocket"];

async function findBackup(profile) {
	const names = (await fs.readdir(profile)).filter((name) =>
		name.startsWith(".birdclaw-orphaned-singletons-"),
	);
	assert.equal(names.length, 1);
	return path.join(profile, names[0]);
}

async function fixture(
	t,
	{ args = ["node", "worker.mjs"], platform = "linux" } = {},
) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "birdclaw-lock-test-"));
	const profile = path.join(root, "profile");
	await fs.mkdir(profile);
	const targets = {
		SingletonLock: "old-host-123",
		SingletonCookie: "random-cookie",
		SingletonSocket: path.join(root, "missing-socket"),
	};
	for (const name of NAMES)
		await fs.symlink(targets[name], path.join(profile, name));
	await fs.writeFile(path.join(profile, "Cookies"), "auth sentinel");
	await fs.writeFile(path.join(profile, "History"), "database sentinel");
	const priorProject = process.env.RAILWAY_PROJECT_ID;
	const priorService = process.env.RAILWAY_SERVICE_ID;
	process.env.RAILWAY_PROJECT_ID = "synthetic-project";
	process.env.RAILWAY_SERVICE_ID = "synthetic-service";
	t.after(async () => {
		if (priorProject === undefined) delete process.env.RAILWAY_PROJECT_ID;
		else process.env.RAILWAY_PROJECT_ID = priorProject;
		if (priorService === undefined) delete process.env.RAILWAY_SERVICE_ID;
		else process.env.RAILWAY_SERVICE_ID = priorService;
		await fs.rm(root, { recursive: true, force: true });
	});
	t.mock.method(os, "platform", () => platform);
	t.mock.method(os, "hostname", () => "new-host");
	const readdir = fs.readdir.bind(fs);
	const readFile = fs.readFile.bind(fs);
	let scans = 0;
	t.mock.method(fs, "readdir", async (file, ...rest) => {
		if (file === "/proc") {
			scans += 1;
			return ["1", "self"];
		}
		return readdir(file, ...rest);
	});
	t.mock.method(fs, "readFile", async (file, ...rest) => {
		if (file === "/proc/1/cmdline")
			return (
				(typeof args === "function" ? args(scans, profile) : args).join("\0") +
				"\0"
			);
		return readFile(file, ...rest);
	});
	return {
		root,
		profile,
		targets,
		async intact() {
			for (const name of NAMES)
				assert.equal(
					await fs.readlink(path.join(profile, name)),
					targets[name],
				);
			assert.equal(
				await fs.readFile(path.join(profile, "Cookies"), "utf8"),
				"auth sentinel",
			);
			assert.equal(
				await fs.readFile(path.join(profile, "History"), "utf8"),
				"database sentinel",
			);
		},
	};
}

test("stashes exactly three orphaned symlinks privately, preserving auth and database", async (t) => {
	const f = await fixture(t);
	const result = await recoverOrphanedProfileLock(f.profile);
	assert.equal(result.recovered, true);
	assert.equal(result.reason, "orphaned_links_stashed");
	assert.deepEqual(Object.keys(result).sort(), ["reason", "recovered"]);
	const backupDir = await findBackup(f.profile);
	assert.equal((await fs.stat(backupDir)).mode & 0o777, 0o700);
	assert.deepEqual((await fs.readdir(backupDir)).sort(), [...NAMES].sort());
	for (const name of NAMES) {
		assert.equal(
			await fs.readlink(path.join(backupDir, name)),
			f.targets[name],
		);
		await assert.rejects(fs.lstat(path.join(f.profile, name)), {
			code: "ENOENT",
		});
	}
	assert.equal(
		await fs.readFile(path.join(f.profile, "Cookies"), "utf8"),
		"auth sentinel",
	);
	assert.equal(
		await fs.readFile(path.join(f.profile, "History"), "utf8"),
		"database sentinel",
	);
});

test("same-host lock is never reclaimed, even if its PID is gone", async (t) => {
	const f = await fixture(t);
	t.mock.method(os, "hostname", () => "old-host");
	assert.equal(
		(await recoverOrphanedProfileLock(f.profile)).reason,
		"same_hostname",
	);
	await f.intact();
});

test("present socket target prevents recovery", async (t) => {
	const f = await fixture(t);
	await fs.writeFile(f.targets.SingletonSocket, "socket placeholder");
	assert.equal(
		(await recoverOrphanedProfileLock(f.profile)).reason,
		"socket_present",
	);
	await f.intact();
});

for (const name of NAMES)
	test(`refuses ordinary ${name} without touching any files`, async (t) => {
		const f = await fixture(t);
		await fs.unlink(path.join(f.profile, name));
		await fs.writeFile(path.join(f.profile, name), "not a link");
		assert.equal(
			(await recoverOrphanedProfileLock(f.profile)).recovered,
			false,
		);
		assert.equal(
			await fs.readFile(path.join(f.profile, name), "utf8"),
			"not a link",
		);
		assert.equal((await fs.readdir(f.profile)).length, 5);
	});

test("a local Chromium using this profile blocks recovery", async (t) => {
	const f = await fixture(t, {
		args: (_, profile) => ["/usr/bin/chromium", `--user-data-dir=${profile}`],
	});
	assert.equal(
		(await recoverOrphanedProfileLock(f.profile)).reason,
		"local_browser_present",
	);
	await f.intact();
});

test("unidentified local Chromium fails closed", async (t) => {
	const f = await fixture(t, {
		args: ["/usr/bin/chromium", "--type=renderer"],
	});
	assert.equal(
		(await recoverOrphanedProfileLock(f.profile)).reason,
		"local_browser_present",
	);
	await f.intact();
});

test("unreadable process evidence fails closed with no backup or mutation", async (t) => {
	const f = await fixture(t, {
		args: () => {
			throw Object.assign(Error("private failure"), { code: "EACCES" });
		},
	});
	assert.deepEqual(await recoverOrphanedProfileLock(f.profile), {
		recovered: false,
		reason: "unverified_or_missing_locks",
	});
	await f.intact();
	assert.equal((await fs.readdir(f.profile)).length, 5);
});

test("a process appearing on recheck prevents stashing", async (t) => {
	const f = await fixture(t, {
		args: (scan, profile) =>
			scan === 1 ? ["node"] : ["chromium", "--user-data-dir", profile],
	});
	assert.equal(
		(await recoverOrphanedProfileLock(f.profile)).reason,
		"became_active",
	);
	await f.intact();
	assert.equal((await fs.readdir(f.profile)).length, 5);
});

test("partial rename failure restores links without discarding reversible backup", async (t) => {
	const f = await fixture(t);
	const rename = fs.rename.bind(fs);
	let moves = 0;
	t.mock.method(fs, "rename", async (...args) => {
		if (++moves === 2)
			throw Object.assign(Error("io failure"), { code: "EIO" });
		return rename(...args);
	});
	const result = await recoverOrphanedProfileLock(f.profile);
	assert.equal(result.reason, "recovery_aborted");
	await f.intact();
	assert.equal(
		await fs.readlink(
			path.join(await findBackup(f.profile), "SingletonCookie"),
		),
		f.targets.SingletonCookie,
	);
});

test("non-Linux is a noop", async (t) => {
	const f = await fixture(t, { platform: "darwin" });
	assert.equal(
		(await recoverOrphanedProfileLock(f.profile)).reason,
		"not_linux",
	);
	await f.intact();
});

test("Linux outside Railway is a noop", async (t) => {
	const f = await fixture(t);
	delete process.env.RAILWAY_SERVICE_ID;
	assert.equal(
		(await recoverOrphanedProfileLock(f.profile)).reason,
		"not_railway",
	);
	await f.intact();
});
