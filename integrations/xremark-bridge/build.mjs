#!/usr/bin/env node

import {
	chmod,
	copyFile,
	lstat,
	mkdir,
	readFile,
	readdir,
	realpath,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const BRIDGE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const ASSET_ROOT = path.join(BRIDGE_ROOT, "bridge");
const MARKER_FILE = ".birdclaw-xremark-bridge.json";
const ROLLBACK_MARKER_FILE = ".birdclaw-xremark-official-rollback.json";
const INJECTION_START = "// BIRDCLAW_XREMARK_BRIDGE_START";
const INJECTION_END = "// BIRDCLAW_XREMARK_BRIDGE_END";
const OBSERVER_INJECTION_START = "<!-- BIRDCLAW_XREMARK_IDB_OBSERVER_START -->";
const OBSERVER_INJECTION_END = "<!-- BIRDCLAW_XREMARK_IDB_OBSERVER_END -->";
const DEFAULT_DESTINATION = path.join(homedir(), ".birdclaw", "xremark-bridge");
const DEFAULT_ROLLBACK_DESTINATION = path.join(
	homedir(),
	".birdclaw",
	"xremark-official-rollback",
);
const REQUIRED_ASSETS = [
	"birdclaw-bridge.js",
	"birdclaw-idb-observer.js",
	"birdclaw-options.css",
	"birdclaw-options.html",
	"birdclaw-options.js",
];

function expandHome(input) {
	if (input === "~") return homedir();
	if (input.startsWith(`~${path.sep}`))
		return path.join(homedir(), input.slice(2));
	return input;
}

function resolvePath(input) {
	return path.resolve(expandHome(input));
}

function isInside(parent, child) {
	const relative = path.relative(parent, child);
	return (
		relative !== "" &&
		!relative.startsWith(`..${path.sep}`) &&
		relative !== ".." &&
		!path.isAbsolute(relative)
	);
}

async function pathExists(target) {
	try {
		await lstat(target);
		return true;
	} catch (error) {
		if (error && error.code === "ENOENT") return false;
		throw error;
	}
}

async function assertDirectory(target, label) {
	const stat = await lstat(target);
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw new Error(`${label} must be a real directory, not a symlink.`);
	}
}

async function copyTree(source, destination) {
	const stat = await lstat(source);
	if (stat.isSymbolicLink()) {
		throw new Error(
			"The official extension contains a symlink; refusing an unsafe copy.",
		);
	}

	if (stat.isDirectory()) {
		await mkdir(destination, { recursive: true, mode: stat.mode });
		const entries = await readdir(source, { withFileTypes: true });
		for (const entry of entries) {
			await copyTree(
				path.join(source, entry.name),
				path.join(destination, entry.name),
			);
		}
		return;
	}

	if (!stat.isFile()) {
		throw new Error(
			"The official extension contains a special file; refusing an unsafe copy.",
		);
	}

	await copyFile(source, destination);
	await chmod(destination, stat.mode);
}

async function readJson(target, label) {
	let parsed;
	try {
		parsed = JSON.parse(await readFile(target, "utf8"));
	} catch {
		throw new Error(`${label} is missing or is not valid JSON.`);
	}
	return parsed;
}

function uniqueStrings(values) {
	return [...new Set(values.filter((value) => typeof value === "string"))];
}

function validateManifest(manifest) {
	if (manifest.manifest_version !== 3) {
		throw new Error(
			"Only the official Manifest V3 X Remark extension is supported.",
		);
	}
	if (typeof manifest.key !== "string" || manifest.key.trim() === "") {
		throw new Error(
			"The source manifest has no extension key, so its extension ID cannot be preserved.",
		);
	}
	if (manifest.background?.service_worker !== "service-worker-loader.js") {
		throw new Error(
			"The source does not use the expected service-worker-loader.js background worker.",
		);
	}
	if (manifest.background?.type && manifest.background.type !== "module") {
		throw new Error("The source background worker type is unsupported.");
	}
}

function patchManifest(manifest) {
	const originalKey = manifest.key;
	const patched = structuredClone(manifest);
	delete patched.update_url;
	patched.permissions = uniqueStrings([
		...(patched.permissions ?? []),
		"storage",
		"alarms",
	]);
	patched.host_permissions = uniqueStrings([
		...(patched.host_permissions ?? []),
		"http://127.0.0.1:3001/*",
	]);
	patched.options_ui = {
		page: "birdclaw-options.html",
		open_in_tab: true,
	};

	if (patched.key !== originalKey) {
		throw new Error(
			"Internal error: the extension key changed while patching the manifest.",
		);
	}
	return patched;
}

function injectBridge(loaderSource, isModule) {
	if (
		loaderSource.includes(INJECTION_START) ||
		loaderSource.includes("birdclaw-bridge.js")
	) {
		throw new Error(
			"The source worker already contains a BirdClaw bridge injection.",
		);
	}
	const statement = isModule
		? "import './birdclaw-bridge.js';"
		: "importScripts('birdclaw-bridge.js');";
	const suffix = loaderSource.endsWith("\n") ? "" : "\n";
	return `${loaderSource}${suffix}${INJECTION_START}\n${statement}\n${INJECTION_END}\n`;
}

function injectSidepanelObserver(sidepanelSource) {
	if (
		sidepanelSource.includes(OBSERVER_INJECTION_START) ||
		sidepanelSource.includes("birdclaw-idb-observer.js")
	) {
		throw new Error(
			"The source sidepanel already contains a BirdClaw IndexedDB observer injection.",
		);
	}
	const moduleScript =
		/^([ \t]*)<script\b(?=[^>]*\stype=["']module["'])[^>]*>/im;
	const match = moduleScript.exec(sidepanelSource);
	if (!match) {
		throw new Error(
			"The source sidepanel.html has no official module script to observe safely.",
		);
	}
	const indentation = match[1] ?? "";
	const injection = [
		`${indentation}${OBSERVER_INJECTION_START}`,
		`${indentation}<script src="/birdclaw-idb-observer.js"></script>`,
		`${indentation}${OBSERVER_INJECTION_END}`,
		"",
	].join("\n");
	return `${sidepanelSource.slice(0, match.index)}${injection}${sidepanelSource.slice(match.index)}`;
}

async function assertReplaceableDestination(
	destination,
	{ markerFile, kind, label },
) {
	if (!(await pathExists(destination))) return false;
	await assertDirectory(destination, `Existing ${label} destination`);
	const markerPath = path.join(destination, markerFile);
	if (!(await pathExists(markerPath))) {
		throw new Error(
			`${label} destination already exists and is not BirdClaw-generated; refusing to overwrite it.`,
		);
	}
	const marker = await readJson(markerPath, `BirdClaw ${label} marker`);
	if (marker.schemaVersion !== 1 || marker.kind !== kind) {
		throw new Error(
			`${label} destination marker is not recognized; refusing to overwrite it.`,
		);
	}
	return true;
}

async function copyBridgeAssets(destination) {
	for (const name of REQUIRED_ASSETS) {
		const source = path.join(ASSET_ROOT, name);
		const target = path.join(destination, name);
		const stat = await lstat(source);
		if (!stat.isFile() || stat.isSymbolicLink()) {
			throw new Error(`Bridge asset ${name} is missing or unsafe.`);
		}
		await copyFile(source, target);
		await chmod(target, stat.mode);
	}
}

export async function buildBridge({
	source,
	destination = DEFAULT_DESTINATION,
	rollbackDestination,
}) {
	if (!source)
		throw new Error("An official X Remark extension directory is required.");

	const sourcePath = resolvePath(source);
	const destinationPath = resolvePath(destination);
	const rollbackDestinationPath = resolvePath(
		rollbackDestination ??
			path.join(path.dirname(destinationPath), "xremark-official-rollback"),
	);
	await assertDirectory(sourcePath, "Source");

	const realSource = await realpath(sourcePath);
	for (const outputPath of [destinationPath, rollbackDestinationPath]) {
		if (
			sourcePath === outputPath ||
			realSource === outputPath ||
			isInside(realSource, outputPath) ||
			isInside(outputPath, realSource)
		) {
			throw new Error(
				"Source and destinations must be separate, non-nested directories.",
			);
		}
	}
	if (
		destinationPath === rollbackDestinationPath ||
		isInside(destinationPath, rollbackDestinationPath) ||
		isInside(rollbackDestinationPath, destinationPath)
	) {
		throw new Error(
			"Bridge and rollback destinations must be separate, non-nested directories.",
		);
	}

	const destinationParent = path.dirname(destinationPath);
	const rollbackDestinationParent = path.dirname(rollbackDestinationPath);
	await mkdir(destinationParent, { recursive: true });
	await mkdir(rollbackDestinationParent, { recursive: true });
	const realDestinationParent = await realpath(destinationParent);
	const realRollbackDestinationParent = await realpath(
		rollbackDestinationParent,
	);
	const effectiveDestination = path.join(
		realDestinationParent,
		path.basename(destinationPath),
	);
	const effectiveRollbackDestination = path.join(
		realRollbackDestinationParent,
		path.basename(rollbackDestinationPath),
	);
	for (const outputPath of [
		effectiveDestination,
		effectiveRollbackDestination,
	]) {
		if (
			realSource === outputPath ||
			isInside(realSource, outputPath) ||
			isInside(outputPath, realSource)
		) {
			throw new Error(
				"Source and destinations must be separate, non-nested directories.",
			);
		}
	}
	if (
		effectiveDestination === effectiveRollbackDestination ||
		isInside(effectiveDestination, effectiveRollbackDestination) ||
		isInside(effectiveRollbackDestination, effectiveDestination)
	) {
		throw new Error(
			"Bridge and rollback destinations must be separate, non-nested directories.",
		);
	}

	const replaceExisting = await assertReplaceableDestination(
		effectiveDestination,
		{
			markerFile: MARKER_FILE,
			kind: "birdclaw-xremark-bridge",
			label: "Bridge",
		},
	);
	const replaceExistingRollback = await assertReplaceableDestination(
		effectiveRollbackDestination,
		{
			markerFile: ROLLBACK_MARKER_FILE,
			kind: "birdclaw-xremark-official-rollback",
			label: "Rollback",
		},
	);
	const manifestPath = path.join(realSource, "manifest.json");
	const manifest = await readJson(manifestPath, "Source manifest");
	validateManifest(manifest);

	const loaderPath = path.join(realSource, "service-worker-loader.js");
	const loaderStat = await lstat(loaderPath);
	if (!loaderStat.isFile() || loaderStat.isSymbolicLink()) {
		throw new Error(
			"The source service-worker-loader.js is missing or unsafe.",
		);
	}
	const sidepanelPath = path.join(realSource, "sidepanel.html");
	const sidepanelStat = await lstat(sidepanelPath);
	if (!sidepanelStat.isFile() || sidepanelStat.isSymbolicLink()) {
		throw new Error("The source sidepanel.html is missing or unsafe.");
	}

	const nonce = `${process.pid}-${randomUUID()}`;
	const plans = [
		{
			label: "bridge",
			destination: effectiveDestination,
			staging: path.join(
				realDestinationParent,
				`.xremark-bridge.stage-${nonce}`,
			),
			backup: path.join(
				realDestinationParent,
				`.xremark-bridge.backup-${nonce}`,
			),
			replaceExisting,
			movedExisting: false,
			installed: false,
		},
		{
			label: "rollback",
			destination: effectiveRollbackDestination,
			staging: path.join(
				realRollbackDestinationParent,
				`.xremark-official-rollback.stage-${nonce}`,
			),
			backup: path.join(
				realRollbackDestinationParent,
				`.xremark-official-rollback.backup-${nonce}`,
			),
			replaceExisting: replaceExistingRollback,
			movedExisting: false,
			installed: false,
		},
	];
	const bridgePlan = plans[0];
	const rollbackPlan = plans[1];

	try {
		await copyTree(realSource, bridgePlan.staging);
		await copyTree(realSource, rollbackPlan.staging);
		await copyBridgeAssets(bridgePlan.staging);

		const patchedManifest = patchManifest(manifest);
		await writeFile(
			path.join(bridgePlan.staging, "manifest.json"),
			`${JSON.stringify(patchedManifest, null, 2)}\n`,
			"utf8",
		);
		const rollbackManifest = structuredClone(manifest);
		delete rollbackManifest.update_url;
		await writeFile(
			path.join(rollbackPlan.staging, "manifest.json"),
			`${JSON.stringify(rollbackManifest, null, 2)}\n`,
			"utf8",
		);
		await rm(path.join(rollbackPlan.staging, "_metadata"), {
			recursive: true,
			force: true,
		});

		const originalLoader = await readFile(loaderPath, "utf8");
		await writeFile(
			path.join(bridgePlan.staging, "service-worker-loader.js"),
			injectBridge(originalLoader, manifest.background?.type === "module"),
			"utf8",
		);
		const originalSidepanel = await readFile(sidepanelPath, "utf8");
		await writeFile(
			path.join(bridgePlan.staging, "sidepanel.html"),
			injectSidepanelObserver(originalSidepanel),
			"utf8",
		);

		const marker = {
			schemaVersion: 1,
			kind: "birdclaw-xremark-bridge",
			generatedAt: new Date().toISOString(),
			sourceManifestName: manifest.name ?? "X Remark",
			sourceManifestVersion: manifest.version ?? null,
		};
		await writeFile(
			path.join(bridgePlan.staging, MARKER_FILE),
			`${JSON.stringify(marker, null, 2)}\n`,
			"utf8",
		);
		const rollbackMarker = {
			schemaVersion: 1,
			kind: "birdclaw-xremark-official-rollback",
			generatedAt: new Date().toISOString(),
			sourceManifestName: manifest.name ?? "X Remark",
			sourceManifestVersion: manifest.version ?? null,
		};
		await writeFile(
			path.join(rollbackPlan.staging, ROLLBACK_MARKER_FILE),
			`${JSON.stringify(rollbackMarker, null, 2)}\n`,
			"utf8",
		);

		const stagedManifest = await readJson(
			path.join(bridgePlan.staging, "manifest.json"),
			"Generated manifest",
		);
		const stagedRollbackManifest = await readJson(
			path.join(rollbackPlan.staging, "manifest.json"),
			"Generated rollback manifest",
		);
		if (
			stagedManifest.key !== manifest.key ||
			stagedRollbackManifest.key !== manifest.key
		) {
			throw new Error(
				"Generated extension keys do not match the official extension key.",
			);
		}
		if (
			(await readFile(
				path.join(rollbackPlan.staging, "service-worker-loader.js"),
				"utf8",
			)) !== originalLoader ||
			(await readFile(
				path.join(rollbackPlan.staging, "sidepanel.html"),
				"utf8",
			)) !== originalSidepanel
		) {
			throw new Error("Rollback copy does not preserve the official code.");
		}
		for (const asset of REQUIRED_ASSETS) {
			if (await pathExists(path.join(rollbackPlan.staging, asset))) {
				throw new Error(
					"Rollback copy unexpectedly contains BirdClaw bridge assets.",
				);
			}
		}

		for (const plan of plans) {
			if (plan.replaceExisting) {
				await rename(plan.destination, plan.backup);
				plan.movedExisting = true;
			}
		}
		for (const plan of plans) {
			await rename(plan.staging, plan.destination);
			plan.installed = true;
		}
	} catch (error) {
		for (const plan of [...plans].reverse()) {
			if (plan.installed) {
				await rm(plan.destination, { recursive: true, force: true }).catch(
					() => {},
				);
			}
			if (plan.movedExisting && !(await pathExists(plan.destination))) {
				await rename(plan.backup, plan.destination).catch(() => {});
			}
			await rm(plan.staging, { recursive: true, force: true }).catch(() => {});
		}
		throw error;
	}
	for (const plan of plans) {
		await rm(plan.backup, { recursive: true, force: true }).catch(() => {});
	}

	return {
		bridgePath: effectiveDestination,
		rollbackPath: effectiveRollbackDestination,
	};
}

function usage() {
	return [
		"Usage:",
		"  node integrations/xremark-bridge/build.mjs --source <official-extension-dir> [--destination <dir>] [--rollback-destination <dir>]",
		"",
		`Default bridge destination: ${DEFAULT_DESTINATION}`,
		`Default rollback destination: ${DEFAULT_ROLLBACK_DESTINATION}`,
	].join("\n");
}

function parseArgs(argv) {
	const options = {};
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (
			argument === "--source" ||
			argument === "--destination" ||
			argument === "--rollback-destination"
		) {
			const value = argv[index + 1];
			if (!value || value.startsWith("--"))
				throw new Error(`${argument} requires a value.`);
			const key =
				argument === "--rollback-destination"
					? "rollbackDestination"
					: argument.slice(2);
			options[key] = value;
			index += 1;
			continue;
		}
		if (argument === "--help" || argument === "-h") {
			return { help: true };
		}
		throw new Error(`Unknown argument: ${argument}`);
	}
	return options;
}

const isDirectRun =
	process.argv[1] &&
	pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
	try {
		const options = parseArgs(process.argv.slice(2));
		if (options.help) {
			process.stdout.write(`${usage()}\n`);
			process.exitCode = 0;
		} else {
			const built = await buildBridge(options);
			process.stdout.write(
				`BirdClaw X Remark bridge built at ${built.bridgePath}\n`,
			);
			process.stdout.write(
				`Vanilla official rollback copy built at ${built.rollbackPath}\n`,
			);
			process.stdout.write(
				"Load the bridge directory as an unpacked extension, then open its options page to pair. Keep the rollback copy for safe restoration.\n",
			);
		}
	} catch (error) {
		process.stderr.write(
			`${error instanceof Error ? error.message : String(error)}\n\n${usage()}\n`,
		);
		process.exitCode = 1;
	}
}
