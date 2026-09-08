import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Keep Chromium's exclusion marker until last.
const NAMES = ["SingletonCookie", "SingletonSocket", "SingletonLock"];
const unchanged = (a, b) =>
	a.dev === b.dev && a.ino === b.ino && a.ctimeNs === b.ctimeNs;

async function snapshot(profile) {
	const entries = [];
	for (const name of NAMES) {
		const file = path.join(profile, name);
		const stat = await fs.lstat(file, { bigint: true });
		if (!stat.isSymbolicLink()) throw Error("not_symlinks");
		entries.push({ name, file, stat, target: await fs.readlink(file) });
	}
	return entries;
}

async function socketAbsent(profile, entries) {
	const socket = entries.find((entry) => entry.name === "SingletonSocket");
	try {
		// Even a dangling symlink at the socket target counts as present.
		await fs.lstat(path.resolve(profile, socket.target));
		return false;
	} catch (error) {
		if (error.code === "ENOENT") return true;
		throw error;
	}
}

async function noLocalBrowser(profile) {
	const pids = (await fs.readdir("/proc")).filter((pid) => /^\d+$/.test(pid));
	if (!pids.length) throw Error("process_scan_unavailable");
	for (const pid of pids) {
		let args;
		try {
			args = (await fs.readFile(`/proc/${pid}/cmdline`, "utf8"))
				.split("\0")
				.filter(Boolean);
		} catch (error) {
			if (error.code === "ENOENT" || error.code === "ESRCH") continue;
			throw error;
		}
		if (!args.length) continue;
		const index = args.findIndex(
			(arg) => arg === "--user-data-dir" || arg.startsWith("--user-data-dir="),
		);
		if (index === -1) {
			if (/chrom(?:e|ium)/i.test(path.basename(args[0]))) return false;
			continue;
		}
		const value =
			args[index] === "--user-data-dir"
				? args[index + 1]
				: args[index].slice("--user-data-dir=".length);
		if (!value || value.startsWith("--")) return false;
		const candidate = path.isAbsolute(value)
			? value
			: path.resolve(await fs.readlink(`/proc/${pid}/cwd`), value);
		let canonical;
		try {
			canonical = await fs.realpath(candidate);
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
			canonical = path.resolve(candidate);
		}
		if (canonical === profile) return false;
	}
	return true;
}

/** Before launch, in the dedicated, exclusively mounted Railway profile only.
 * Never remove auth, databases, socket targets, or ordinary files.
 * Refused recovery leaves Chromium's own lock enforcement intact.
 */
export async function recoverOrphanedProfileLock(profileDir) {
	const skip = (reason) => ({ recovered: false, reason });
	if (os.platform() !== "linux") return skip("not_linux");
	if (!process.env.RAILWAY_PROJECT_ID || !process.env.RAILWAY_SERVICE_ID)
		return skip("not_railway");
	if (typeof profileDir !== "string" || !path.isAbsolute(profileDir))
		return skip("invalid_profile");
	let profile;
	let entries;
	try {
		if (!(await fs.lstat(profileDir)).isDirectory())
			return skip("invalid_profile");
		profile = await fs.realpath(profileDir);
		entries = await snapshot(profile);
		const target = entries.find(
			(entry) => entry.name === "SingletonLock",
		).target;
		const match = /^([a-zA-Z0-9][a-zA-Z0-9._-]*)-([1-9][0-9]*)$/.exec(target);
		if (!match) return skip("invalid_lock_target");
		if (match[1].toLowerCase() === os.hostname().toLowerCase())
			return skip("same_hostname");
		if (!(await socketAbsent(profile, entries))) return skip("socket_present");
		if (!(await noLocalBrowser(profile))) return skip("local_browser_present");
	} catch {
		return skip("unverified_or_missing_locks");
	}

	const guard = path.join(profile, ".birdclaw-singleton-recovery");
	try {
		await fs.mkdir(guard, { mode: 0o700 });
	} catch {
		return skip("recovery_busy_or_unavailable");
	}
	let backupDir;
	const moved = [];
	try {
		const latest = await snapshot(profile);
		if (
			!entries.every(
				(entry, i) =>
					unchanged(entry.stat, latest[i].stat) &&
					entry.target === latest[i].target,
			)
		)
			return skip("locks_changed");
		if (
			!(await socketAbsent(profile, entries)) ||
			!(await noLocalBrowser(profile))
		)
			return skip("became_active");
		backupDir = await fs.mkdtemp(
			path.join(profile, ".birdclaw-orphaned-singletons-"),
		);
		await fs.chmod(backupDir, 0o700);
		for (const entry of entries) {
			const current = await fs.lstat(entry.file, { bigint: true });
			if (
				!current.isSymbolicLink() ||
				!unchanged(entry.stat, current) ||
				(await fs.readlink(entry.file)) !== entry.target
			)
				throw Error("locks_changed");
			if (
				!(await socketAbsent(profile, entries)) ||
				!(await noLocalBrowser(profile))
			)
				throw Error("became_active");
			await fs.rename(entry.file, path.join(backupDir, entry.name));
			moved.push(entry);
		}
		return { recovered: true, reason: "orphaned_links_stashed" };
	} catch {
		// Exclusive creation never overwrites a new Chromium lock. Retain backup.
		let restored = true;
		for (const entry of [...moved].reverse()) {
			try {
				await fs.symlink(entry.target, entry.file);
			} catch {
				restored = false;
			}
		}
		return {
			recovered: false,
			reason: restored ? "recovery_aborted" : "recovery_conflict",
		};
	} finally {
		await fs.rmdir(guard).catch(() => {});
	}
}
