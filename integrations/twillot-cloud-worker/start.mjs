#!/usr/bin/env node

import process from "node:process";

process.stdout.write(
	`${JSON.stringify({ time: new Date().toISOString(), event: "node_runtime_started" })}\n`,
);
await import("./cloud-worker.mjs");
process.stdout.write(
	`${JSON.stringify({ time: new Date().toISOString(), event: "module_imported" })}\n`,
);
