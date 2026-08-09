import { execFile, spawn } from "node:child_process";
import {
	mkdtemp,
	mkdir,
	readFile,
	readdir,
	rm,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tempRoot = await mkdtemp(
	path.join(os.tmpdir(), "birdclaw-package-smoke-"),
);

async function run(command, args, options = {}) {
	return execFileAsync(command, args, {
		maxBuffer: 20 * 1024 * 1024,
		...options,
	});
}

async function waitForServer(child) {
	return new Promise((resolve, reject) => {
		let output = "";
		let errors = "";
		const timer = setTimeout(() => {
			reject(
				new Error(
					`Timed out waiting for production server\n${output}\n${errors}`,
				),
			);
		}, 20_000);
		child.stdout.on("data", (chunk) => {
			output += String(chunk);
			const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
			if (!match) return;
			clearTimeout(timer);
			resolve(`http://127.0.0.1:${match[1]}`);
		});
		child.stderr.on("data", (chunk) => {
			errors += String(chunk);
		});
		child.once("exit", (code, signal) => {
			clearTimeout(timer);
			reject(
				new Error(
					`Production server exited before startup (${String(code ?? signal)})\n${output}\n${errors}`,
				),
			);
		});
	});
}

try {
	const packDir = path.join(tempRoot, "pack");
	await mkdir(packDir, { recursive: true });
	await run("npm", ["pack", "--pack-destination", packDir], { cwd: root });
	const tarballName = (await readdir(packDir)).find((name) =>
		name.endsWith(".tgz"),
	);
	if (!tarballName) throw new Error("npm pack did not create a tarball");
	const tarball = path.join(packDir, tarballName);
	const { stdout: tarOutput } = await run("tar", ["-tzf", tarball]);
	const files = tarOutput.trim().split("\n");
	for (const required of [
		"package/bin/birdclaw.mjs",
		"package/bin/migration-backup.mjs",
		"package/dist/cli/birdclaw.js",
		"package/dist/server/server.js",
		"package/integrations/twillot-companion/birdclaw-twillot-worker.js",
		"package/integrations/twillot-companion/build.mjs",
	]) {
		if (!files.includes(required))
			throw new Error(`Tarball missing ${required}`);
	}
	for (const forbidden of ["package/src/", "package/scripts/", "tsx"]) {
		if (files.some((file) => file.includes(forbidden))) {
			throw new Error(`Tarball unexpectedly contains ${forbidden}`);
		}
	}

	const installDir = path.join(tempRoot, "install");
	await mkdir(installDir, { recursive: true });
	await writeFile(
		path.join(installDir, "package.json"),
		`${JSON.stringify({ name: "birdclaw-package-smoke", private: true, type: "module" })}\n`,
	);
	await run(
		"npm",
		["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
		{ cwd: installDir },
	);
	const installedRoot = path.join(installDir, "node_modules", "birdclaw");
	const manifest = JSON.parse(
		await readFile(path.join(installedRoot, "package.json"), "utf8"),
	);
	if (manifest.dependencies?.tsx || manifest.dependencies?.vite) {
		throw new Error("Installed runtime dependencies include tsx or vite");
	}
	const bin = path.join(installDir, "node_modules", ".bin", "birdclaw");
	const home = path.join(tempRoot, "home");
	const env = { ...process.env, BIRDCLAW_HOME: home };

	const versionStarted = performance.now();
	const { stdout: versionOutput } = await run(bin, ["--version"], {
		cwd: installDir,
		env,
	});
	const versionMs = performance.now() - versionStarted;
	if (versionOutput.trim() !== manifest.version) {
		throw new Error(`Unexpected version output: ${versionOutput}`);
	}
	const { stdout: helpOutput } = await run(bin, ["--help"], {
		cwd: installDir,
		env,
	});
	if (!helpOutput.includes("Run the local web app")) {
		throw new Error("Installed CLI help is missing serve");
	}
	const { stdout: statsOutput } = await run(bin, ["--json", "db", "stats"], {
		cwd: installDir,
		env,
	});
	JSON.parse(statsOutput);

	const child = spawn(bin, ["serve", "--host", "127.0.0.1", "--port", "0"], {
		cwd: installDir,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let shutdownError;
	try {
		const baseUrl = await waitForServer(child);
		const page = await fetch(baseUrl);
		if (!page.ok || !(await page.text()).toLowerCase().includes("birdclaw")) {
			throw new Error(
				`Production SSR smoke failed with ${String(page.status)}`,
			);
		}
		const asset = await fetch(`${baseUrl}/favicon.ico`);
		if (!asset.ok) {
			throw new Error(
				`Production static asset smoke failed with ${String(asset.status)}`,
			);
		}
	} finally {
		if (child.exitCode === null && child.signalCode === null) {
			const exited = new Promise((resolve) =>
				child.once("exit", (code, signal) => resolve({ code, signal })),
			);
			child.kill("SIGTERM");
			const exit = await exited;
			if (process.platform !== "win32" && exit.signal !== "SIGTERM") {
				shutdownError = new Error(
					`Production server did not preserve SIGTERM (${JSON.stringify(exit)})`,
				);
			}
		}
	}
	if (shutdownError) throw shutdownError;

	console.log(
		`Package smoke passed: ${String(files.length)} files, --version ${versionMs.toFixed(0)}ms`,
	);
} finally {
	await rm(tempRoot, { recursive: true, force: true });
}
