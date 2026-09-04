#!/usr/bin/env node

import { cp, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { prepareTwillotExtension } from "./prepare-extension.mjs";

const destination = path.resolve(process.argv[2] || "/opt/twillot-bridge");
delete process.env.BIRDCLAW_TWILLOT_PREPARED_BRIDGE_DIR;
const prepared = await prepareTwillotExtension();
try {
	await rm(destination, { recursive: true, force: true });
	await cp(prepared.bridgePath, destination, { recursive: true });
} finally {
	await prepared.cleanup();
}
