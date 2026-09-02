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
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MARKER_FILE = ".birdclaw-twillot-bridge.json";
const ROLLBACK_MARKER_FILE = ".birdclaw-twillot-official-rollback.json";
const INJECTION_START = "// BIRDCLAW_TWILLOT_BRIDGE_START";
const INJECTION_END = "// BIRDCLAW_TWILLOT_BRIDGE_END";
const DEFAULT_DESTINATION = path.join(homedir(), ".birdclaw", "twillot-bridge");
const DEFAULT_ROLLBACK_DESTINATION = path.join(
	homedir(),
	".birdclaw",
	"twillot-official-rollback",
);
const OFFICIAL = {
	manifestName: "__MSG_extensionName__",
	displayName: "Twillot - X Bookmarks, Search & Export",
	version: "11.0.8",
	defaultLocale: "en",
	localeFile: "_locales/en/messages.json",
	localeSha256:
		"ac2d635bdb3fae524df2d123a7bdc6a9d5c2a928b24587c9640c35fcc2da7c05",
	keySha256: "0959a05eb4fc6579f664ab0ffb8d831da7c8db7111a4ff1376e2baa0eeffebe3",
	workerSha256:
		"9c82f3e3db1c4c71fab1aefb7eba3703c0eba1a6b9620b01db43e6307dd35e6e",
	workerChunk: "assets/chunk-0542871d.js",
	workerChunkSha256:
		"b510093b8d5f7bd2383a659025af22edddfb7d56a02b6d2cdce96839165a1b7b",
};
const ASSETS = [
	{
		source: "birdclaw-twillot-worker.js",
		target: "birdclaw-twillot-worker.js",
	},
	{
		source: "birdclaw-twillot-page.js",
		target: "birdclaw-twillot-page.js",
	},
	{ source: "options.html", target: "birdclaw-twillot-options.html" },
	{ source: "options.css", target: "birdclaw-twillot-options.css" },
	{ source: "options.js", target: "birdclaw-twillot-options.js" },
];

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

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
		if (error?.code === "ENOENT") return false;
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
			"The official Twillot extension contains a symlink; refusing an unsafe copy.",
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
			"The official Twillot extension contains a special file; refusing an unsafe copy.",
		);
	}
	await copyFile(source, destination);
	await chmod(destination, stat.mode);
}

async function readJson(target, label) {
	try {
		return JSON.parse(await readFile(target, "utf8"));
	} catch {
		throw new Error(`${label} is missing or is not valid JSON.`);
	}
}

function uniqueStrings(values) {
	return [...new Set(values.filter((value) => typeof value === "string"))];
}

async function validateOfficialSource(sourcePath, manifest) {
	if (
		manifest.manifest_version !== 3 ||
		manifest.name !== OFFICIAL.manifestName ||
		manifest.version !== OFFICIAL.version ||
		manifest.default_locale !== OFFICIAL.defaultLocale ||
		manifest.background?.service_worker !== "service-worker-loader.js" ||
		manifest.background?.type !== "module" ||
		typeof manifest.key !== "string" ||
		sha256(manifest.key) !== OFFICIAL.keySha256
	) {
		throw new Error(
			"Only the audited official Twillot 11.0.8 Manifest V3 source is supported.",
		);
	}
	if (
		!manifest.host_permissions?.includes("https://*.x.com/*") ||
		!manifest.host_permissions?.includes("https://*.twillot.com/*") ||
		manifest.permissions?.includes("cookies")
	) {
		throw new Error(
			"The official Twillot permission baseline is not recognized.",
		);
	}
	const loader = await readFile(
		path.join(sourcePath, "service-worker-loader.js"),
	);
	const locale = await readFile(path.join(sourcePath, OFFICIAL.localeFile));
	const workerChunk = await readFile(
		path.join(sourcePath, OFFICIAL.workerChunk),
	);
	if (
		sha256(loader) !== OFFICIAL.workerSha256 ||
		sha256(locale) !== OFFICIAL.localeSha256 ||
		sha256(workerChunk) !== OFFICIAL.workerChunkSha256
	) {
		throw new Error(
			"The Twillot 11.0.8 worker and locale files do not match the audited source hashes.",
		);
	}
}

function patchManifest(manifest) {
	const originalKey = manifest.key;
	const patched = structuredClone(manifest);
	delete patched.update_url;
	patched.name = `${OFFICIAL.displayName} (BirdClaw Bridge)`;
	patched.permissions = uniqueStrings([
		...(patched.permissions || []),
		"alarms",
		"storage",
		"tabs",
	]);
	patched.host_permissions = uniqueStrings([
		...(patched.host_permissions || []),
		"https://birdclaw-production.up.railway.app/*",
		"http://127.0.0.1/*",
		"http://localhost/*",
	]);
	patched.options_ui = {
		page: "birdclaw-twillot-options.html",
		open_in_tab: true,
	};
	patched.content_scripts = [
		...(patched.content_scripts || []),
		{
			matches: [
				"https://www.twillot.com/export-twitter-posts*",
				"https://www.twillot.com/*/export-twitter-posts*",
			],
			js: ["birdclaw-twillot-page.js"],
			run_at: "document_idle",
		},
	];
	if (patched.key !== originalKey) {
		throw new Error(
			"Internal error: the Twillot extension key changed while patching.",
		);
	}
	if (patched.permissions.includes("cookies")) {
		throw new Error(
			"Internal error: the bridge must not request cookie access.",
		);
	}
	return patched;
}

function injectWorker(loaderSource) {
	if (
		loaderSource.includes(INJECTION_START) ||
		loaderSource.includes("birdclaw-twillot-worker.js")
	) {
		throw new Error(
			"The source worker already contains a BirdClaw Twillot injection.",
		);
	}
	const suffix = loaderSource.endsWith("\n") ? "" : "\n";
	return `${loaderSource}${suffix}${INJECTION_START}\nimport './birdclaw-twillot-worker.js';\n${INJECTION_END}\n`;
}

export { injectWorker, patchManifest };

async function assertReplaceableDestination(
	destination,
	{ markerFile, kind, label },
) {
	if (!(await pathExists(destination))) return false;
	await assertDirectory(destination, `Existing ${label} destination`);
	const markerPath = path.join(destination, markerFile);
	if (!(await pathExists(markerPath))) {
		throw new Error(
			`${label} destination exists and is not BirdClaw-generated; refusing to overwrite it.`,
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
	for (const asset of ASSETS) {
		const source = path.join(ROOT, asset.source);
		const target = path.join(destination, asset.target);
		const stat = await lstat(source);
		if (!stat.isFile() || stat.isSymbolicLink()) {
			throw new Error(`Bridge asset ${asset.source} is missing or unsafe.`);
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
		throw new Error("An official Twillot extension directory is required.");
	const sourcePath = resolvePath(source);
	const destinationPath = resolvePath(destination);
	const rollbackPath = resolvePath(
		rollbackDestination || DEFAULT_ROLLBACK_DESTINATION,
	);
	await assertDirectory(sourcePath, "Source");
	const realSource = await realpath(sourcePath);
	for (const output of [destinationPath, rollbackPath]) {
		if (
			realSource === output ||
			isInside(realSource, output) ||
			isInside(output, realSource)
		) {
			throw new Error(
				"Source and destinations must be separate, non-nested directories.",
			);
		}
	}
	if (
		destinationPath === rollbackPath ||
		isInside(destinationPath, rollbackPath) ||
		isInside(rollbackPath, destinationPath)
	) {
		throw new Error(
			"Bridge and rollback destinations must be separate, non-nested directories.",
		);
	}

	await mkdir(path.dirname(destinationPath), { recursive: true });
	await mkdir(path.dirname(rollbackPath), { recursive: true });
	const destinationParent = await realpath(path.dirname(destinationPath));
	const rollbackParent = await realpath(path.dirname(rollbackPath));
	const effectiveDestination = path.join(
		destinationParent,
		path.basename(destinationPath),
	);
	const effectiveRollback = path.join(
		rollbackParent,
		path.basename(rollbackPath),
	);
	const replaceBridge = await assertReplaceableDestination(
		effectiveDestination,
		{
			markerFile: MARKER_FILE,
			kind: "birdclaw-twillot-bridge",
			label: "Bridge",
		},
	);
	const replaceRollback = await assertReplaceableDestination(
		effectiveRollback,
		{
			markerFile: ROLLBACK_MARKER_FILE,
			kind: "birdclaw-twillot-official-rollback",
			label: "Rollback",
		},
	);

	const manifest = await readJson(
		path.join(realSource, "manifest.json"),
		"Source manifest",
	);
	await validateOfficialSource(realSource, manifest);
	const officialLoader = await readFile(
		path.join(realSource, "service-worker-loader.js"),
		"utf8",
	);
	const nonce = `${process.pid}-${randomUUID()}`;
	const plans = [
		{
			label: "bridge",
			destination: effectiveDestination,
			staging: path.join(destinationParent, `.twillot-bridge.stage-${nonce}`),
			backup: path.join(destinationParent, `.twillot-bridge.backup-${nonce}`),
			replaceExisting: replaceBridge,
			marker: MARKER_FILE,
			kind: "birdclaw-twillot-bridge",
			movedExisting: false,
			installed: false,
		},
		{
			label: "rollback",
			destination: effectiveRollback,
			staging: path.join(rollbackParent, `.twillot-rollback.stage-${nonce}`),
			backup: path.join(rollbackParent, `.twillot-rollback.backup-${nonce}`),
			replaceExisting: replaceRollback,
			marker: ROLLBACK_MARKER_FILE,
			kind: "birdclaw-twillot-official-rollback",
			movedExisting: false,
			installed: false,
		},
	];

	try {
		for (const plan of plans) await copyTree(realSource, plan.staging);
		await copyBridgeAssets(plans[0].staging);
		await rm(path.join(plans[0].staging, "_metadata"), {
			recursive: true,
			force: true,
		});
		await rm(path.join(plans[1].staging, "_metadata"), {
			recursive: true,
			force: true,
		});

		const bridgeManifest = patchManifest(manifest);
		const rollbackManifest = structuredClone(manifest);
		delete rollbackManifest.update_url;
		await writeFile(
			path.join(plans[0].staging, "manifest.json"),
			`${JSON.stringify(bridgeManifest, null, 2)}\n`,
			"utf8",
		);
		await writeFile(
			path.join(plans[1].staging, "manifest.json"),
			`${JSON.stringify(rollbackManifest, null, 2)}\n`,
			"utf8",
		);
		await writeFile(
			path.join(plans[0].staging, "service-worker-loader.js"),
			injectWorker(officialLoader),
			"utf8",
		);

		for (const plan of plans) {
			await writeFile(
				path.join(plan.staging, plan.marker),
				`${JSON.stringify(
					{
						schemaVersion: 1,
						kind: plan.kind,
						generatedAt: new Date().toISOString(),
						sourceManifestName: manifest.name,
						sourceManifestVersion: manifest.version,
					},
					null,
					2,
				)}\n`,
				"utf8",
			);
		}

		const stagedBridgeManifest = await readJson(
			path.join(plans[0].staging, "manifest.json"),
			"Generated bridge manifest",
		);
		const stagedRollbackManifest = await readJson(
			path.join(plans[1].staging, "manifest.json"),
			"Generated rollback manifest",
		);
		if (
			stagedBridgeManifest.key !== manifest.key ||
			stagedRollbackManifest.key !== manifest.key
		) {
			throw new Error(
				"Generated copies did not preserve the official Twillot extension key.",
			);
		}
		if (
			(await readFile(
				path.join(plans[1].staging, "service-worker-loader.js"),
				"utf8",
			)) !== officialLoader
		) {
			throw new Error(
				"Rollback copy does not preserve the official Twillot worker.",
			);
		}
		for (const asset of ASSETS) {
			if (await pathExists(path.join(plans[1].staging, asset.target))) {
				throw new Error("Rollback copy unexpectedly contains BirdClaw assets.");
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
		rollbackPath: effectiveRollback,
	};
}

function usage() {
	return [
		"Usage:",
		"  node integrations/twillot-companion/build.mjs --source <official-11.0.8-dir> [--destination <dir>] [--rollback-destination <dir>]",
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
			if (!value || value.startsWith("--")) {
				throw new Error(`${argument} requires a value.`);
			}
			const key =
				argument === "--rollback-destination"
					? "rollbackDestination"
					: argument.slice(2);
			options[key] = value;
			index += 1;
			continue;
		}
		if (argument === "--help" || argument === "-h") return { help: true };
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
		} else {
			const result = await buildBridge(options);
			process.stdout.write(`BirdClaw Twillot bridge: ${result.bridgePath}\n`);
			process.stdout.write(`Vanilla rollback copy: ${result.rollbackPath}\n`);
			process.stdout.write(
				"Load the bridge directory as unpacked, then pair it from its options page. Keep the official managed install and rollback copy.\n",
			);
		}
	} catch (error) {
		process.stderr.write(
			`${error instanceof Error ? error.message : String(error)}\n\n${usage()}\n`,
		);
		process.exitCode = 1;
	}
}
