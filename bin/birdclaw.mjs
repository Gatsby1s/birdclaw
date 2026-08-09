#!/usr/bin/env node
import { ensurePreMigrationBackup } from "./migration-backup.mjs";

async function main() {
	await ensurePreMigrationBackup();
	const { runCli } = await import("../dist/cli/birdclaw.js");
	await runCli();
}

void main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
