import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { withSanitizedNodeOptions } from "./sanitize-node-options.mjs";

const cwd = process.cwd();
const vitestBin = path.join(cwd, "node_modules", "vitest", "vitest.mjs");
const configuredTestHome = process.env.BIRDCLAW_TEST_HOME?.trim();
const isolatedHome = configuredTestHome
	? null
	: mkdtempSync(path.join(os.tmpdir(), "birdclaw-vitest-"));
const childEnv = withSanitizedNodeOptions(process.env);
const testHome = isolatedHome ?? configuredTestHome;
if (testHome) {
	childEnv.BIRDCLAW_HOME = testHome;
	childEnv.BIRDCLAW_TEST_HOME = testHome;
}

function cleanup() {
	if (isolatedHome) rmSync(isolatedHome, { recursive: true, force: true });
}

const child = spawn(process.execPath, [vitestBin, ...process.argv.slice(2)], {
	cwd,
	stdio: "inherit",
	env: childEnv,
});

child.on("exit", (code, signal) => {
	cleanup();
	if (signal) {
		process.kill(process.pid, signal);
		return;
	}

	process.exit(code ?? 0);
});

child.on("error", (error) => {
	cleanup();
	throw error;
});
