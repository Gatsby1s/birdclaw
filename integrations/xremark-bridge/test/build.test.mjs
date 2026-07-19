import assert from "node:assert/strict";
import {
	mkdtemp,
	mkdir,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildBridge } from "../build.mjs";

async function fixture(root, overrides = {}) {
	const source = path.join(root, "official");
	await mkdir(path.join(source, "assets"), { recursive: true });
	await mkdir(path.join(source, "_metadata"), { recursive: true });
	const manifest = {
		manifest_version: 3,
		name: "Synthetic X Remark",
		version: "1.2.3",
		key: "synthetic-extension-key",
		update_url: "https://example.invalid/update.xml",
		permissions: ["tabs", "alarms"],
		host_permissions: ["https://*.x.com/*"],
		background: { service_worker: "service-worker-loader.js", type: "module" },
		...overrides,
	};
	await writeFile(
		path.join(source, "manifest.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
	);
	await writeFile(
		path.join(source, "service-worker-loader.js"),
		"import './assets/official.js';\n",
	);
	await writeFile(
		path.join(source, "sidepanel.html"),
		'<!doctype html>\n<html><head>\n  <script type="module" src="/assets/official-sidepanel.js"></script>\n</head><body></body></html>\n',
	);
	await writeFile(
		path.join(source, "assets", "official.js"),
		"globalThis.official = true;\n",
	);
	await writeFile(
		path.join(source, "_metadata", "computed_hashes.json"),
		'{"synthetic":"computed-hash"}\n',
	);
	await writeFile(
		path.join(source, "_metadata", "verified_contents.json"),
		'{"synthetic":"verified-contents"}\n',
	);
	return { source, manifest };
}

async function withTemporaryDirectory(work) {
	const root = await mkdtemp(path.join(tmpdir(), "birdclaw-xremark-builder-"));
	try {
		await work(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test("copies and patches an official extension without modifying the source", async () => {
	await withTemporaryDirectory(async (root) => {
		const { source, manifest } = await fixture(root);
		const sourceManifestBefore = await readFile(
			path.join(source, "manifest.json"),
			"utf8",
		);
		const sourceLoaderBefore = await readFile(
			path.join(source, "service-worker-loader.js"),
			"utf8",
		);
		const sourceSidepanelBefore = await readFile(
			path.join(source, "sidepanel.html"),
			"utf8",
		);
		const sourceComputedHashesBefore = await readFile(
			path.join(source, "_metadata", "computed_hashes.json"),
		);
		const sourceVerifiedContentsBefore = await readFile(
			path.join(source, "_metadata", "verified_contents.json"),
		);
		const destination = path.join(root, "generated", "xremark-bridge");
		const rollbackDestination = path.join(
			root,
			"generated",
			"xremark-official-rollback",
		);

		const result = await buildBridge({ source, destination });
		assert.equal(result.bridgePath, await realpath(destination));
		assert.equal(result.rollbackPath, await realpath(rollbackDestination));

		const generatedManifest = JSON.parse(
			await readFile(path.join(destination, "manifest.json"), "utf8"),
		);
		assert.equal(generatedManifest.key, manifest.key);
		assert.equal("update_url" in generatedManifest, false);
		assert.deepEqual(generatedManifest.options_ui, {
			page: "birdclaw-options.html",
			open_in_tab: true,
		});
		assert.ok(generatedManifest.permissions.includes("storage"));
		assert.ok(generatedManifest.permissions.includes("alarms"));
		assert.equal(
			generatedManifest.permissions.filter((value) => value === "alarms")
				.length,
			1,
		);
		assert.ok(
			generatedManifest.host_permissions.includes("http://127.0.0.1:3001/*"),
		);

		const generatedLoader = await readFile(
			path.join(destination, "service-worker-loader.js"),
			"utf8",
		);
		assert.match(generatedLoader, /import '\.\/assets\/official\.js';/);
		assert.match(generatedLoader, /import '\.\/birdclaw-bridge\.js';/);
		assert.equal(generatedLoader.match(/birdclaw-bridge\.js/g)?.length, 1);
		assert.equal(
			await readFile(path.join(destination, "assets", "official.js"), "utf8"),
			"globalThis.official = true;\n",
		);
		assert.match(
			await readFile(path.join(destination, "birdclaw-options.html"), "utf8"),
			/Pairing token/,
		);
		const generatedSidepanel = await readFile(
			path.join(destination, "sidepanel.html"),
			"utf8",
		);
		assert.match(generatedSidepanel, /birdclaw-idb-observer\.js/);
		assert.ok(
			generatedSidepanel.indexOf("birdclaw-idb-observer.js") <
				generatedSidepanel.indexOf("official-sidepanel.js"),
		);

		const markerText = await readFile(
			path.join(destination, ".birdclaw-xremark-bridge.json"),
			"utf8",
		);
		const marker = JSON.parse(markerText);
		assert.equal(marker.kind, "birdclaw-xremark-bridge");
		assert.equal(marker.sourceManifestVersion, "1.2.3");
		assert.equal(markerText.includes(manifest.key), false);
		assert.equal(markerText.includes(source), false);

		assert.equal(
			await readFile(path.join(source, "manifest.json"), "utf8"),
			sourceManifestBefore,
		);
		assert.equal(
			await readFile(path.join(source, "service-worker-loader.js"), "utf8"),
			sourceLoaderBefore,
		);
		assert.equal(
			await readFile(path.join(source, "sidepanel.html"), "utf8"),
			sourceSidepanelBefore,
		);
		assert.deepEqual(
			await readFile(path.join(source, "_metadata", "computed_hashes.json")),
			sourceComputedHashesBefore,
		);
		assert.deepEqual(
			await readFile(path.join(source, "_metadata", "verified_contents.json")),
			sourceVerifiedContentsBefore,
		);

		const rollbackManifest = JSON.parse(
			await readFile(path.join(rollbackDestination, "manifest.json"), "utf8"),
		);
		assert.equal(rollbackManifest.key, manifest.key);
		assert.equal("update_url" in rollbackManifest, false);
		assert.equal("options_ui" in rollbackManifest, false);
		assert.equal(rollbackManifest.permissions.includes("storage"), false);
		assert.equal(
			rollbackManifest.host_permissions.includes("http://127.0.0.1:3001/*"),
			false,
		);
		assert.equal(
			await readFile(
				path.join(rollbackDestination, "service-worker-loader.js"),
				"utf8",
			),
			sourceLoaderBefore,
		);
		assert.equal(
			await readFile(path.join(rollbackDestination, "sidepanel.html"), "utf8"),
			sourceSidepanelBefore,
		);
		assert.equal(
			await readFile(
				path.join(rollbackDestination, "assets", "official.js"),
				"utf8",
			),
			"globalThis.official = true;\n",
		);
		await assert.rejects(
			readFile(path.join(rollbackDestination, "birdclaw-bridge.js")),
			/ENOENT/,
		);
		await assert.rejects(
			readFile(path.join(rollbackDestination, "birdclaw-idb-observer.js")),
			/ENOENT/,
		);
		await assert.rejects(
			readFile(path.join(rollbackDestination, "birdclaw-options.html")),
			/ENOENT/,
		);
		await assert.rejects(
			readFile(path.join(rollbackDestination, "_metadata")),
			/ENOENT|EISDIR/,
		);
		const rollbackMarker = JSON.parse(
			await readFile(
				path.join(
					rollbackDestination,
					".birdclaw-xremark-official-rollback.json",
				),
				"utf8",
			),
		);
		assert.equal(rollbackMarker.kind, "birdclaw-xremark-official-rollback");

		await writeFile(path.join(destination, "stale-file.txt"), "remove me");
		await writeFile(
			path.join(rollbackDestination, "stale-rollback-file.txt"),
			"remove me",
		);
		await buildBridge({ source, destination });
		await assert.rejects(
			readFile(path.join(destination, "stale-file.txt")),
			/ENOENT/,
		);
		await assert.rejects(
			readFile(path.join(rollbackDestination, "stale-rollback-file.txt")),
			/ENOENT/,
		);
		assert.equal(
			await readFile(path.join(source, "manifest.json"), "utf8"),
			sourceManifestBefore,
		);
	});
});

test("supports a classic service worker loader when type is omitted", async () => {
	await withTemporaryDirectory(async (root) => {
		const { source } = await fixture(root, {
			background: { service_worker: "service-worker-loader.js" },
		});
		const destination = path.join(root, "bridge");
		await buildBridge({ source, destination });
		const loader = await readFile(
			path.join(destination, "service-worker-loader.js"),
			"utf8",
		);
		assert.match(loader, /importScripts\('birdclaw-bridge\.js'\);/);
	});
});

test("refuses to overwrite an unmarked destination", async () => {
	await withTemporaryDirectory(async (root) => {
		const { source } = await fixture(root);
		const destination = path.join(root, "unrelated");
		await mkdir(destination);
		await writeFile(path.join(destination, "keep.txt"), "important");

		await assert.rejects(
			buildBridge({ source, destination }),
			/not BirdClaw-generated/,
		);
		assert.equal(
			await readFile(path.join(destination, "keep.txt"), "utf8"),
			"important",
		);
	});
});

test("refuses to overwrite an unmarked rollback destination", async () => {
	await withTemporaryDirectory(async (root) => {
		const { source } = await fixture(root);
		const destination = path.join(root, "generated", "xremark-bridge");
		const rollbackDestination = path.join(root, "protected-rollback");
		await mkdir(rollbackDestination);
		await writeFile(
			path.join(rollbackDestination, "keep.txt"),
			"important rollback data",
		);

		await assert.rejects(
			buildBridge({ source, destination, rollbackDestination }),
			/Rollback destination.*not BirdClaw-generated/,
		);
		assert.equal(
			await readFile(path.join(rollbackDestination, "keep.txt"), "utf8"),
			"important rollback data",
		);
		await assert.rejects(readFile(destination), /ENOENT|EISDIR/);
	});
});

test("requires the manifest key and expected Manifest V3 worker", async () => {
	await withTemporaryDirectory(async (root) => {
		const { source } = await fixture(root, { key: "" });
		await assert.rejects(
			buildBridge({ source, destination: path.join(root, "bridge") }),
			/extension key/,
		);
	});
});

test("rejects nested destinations before changing the official directory", async () => {
	await withTemporaryDirectory(async (root) => {
		const { source } = await fixture(root);
		const nested = path.join(source, "generated", "bridge");
		await assert.rejects(
			buildBridge({ source, destination: nested }),
			/non-nested directories/,
		);
		await assert.rejects(
			readFile(path.join(source, "generated")),
			/ENOENT|EISDIR/,
		);
	});
});

test("never allows the managed source directory to be a rollback target", async () => {
	await withTemporaryDirectory(async (root) => {
		const { source } = await fixture(root);
		const computedHashesBefore = await readFile(
			path.join(source, "_metadata", "computed_hashes.json"),
		);
		const destination = path.join(root, "safe-output", "xremark-bridge");

		await assert.rejects(
			buildBridge({
				source,
				destination,
				rollbackDestination: source,
			}),
			/non-nested directories/,
		);
		await assert.rejects(readFile(destination), /ENOENT|EISDIR/);
		assert.deepEqual(
			await readFile(path.join(source, "_metadata", "computed_hashes.json")),
			computedHashesBefore,
		);
	});
});

test("rejects symlinks in the official extension copy", async (t) => {
	if (process.platform === "win32")
		return t.skip("symlink semantics differ on Windows");
	await withTemporaryDirectory(async (root) => {
		const { source } = await fixture(root);
		await writeFile(path.join(root, "outside.txt"), "outside");
		await symlink(
			path.join(root, "outside.txt"),
			path.join(source, "unsafe-link"),
		);
		await assert.rejects(
			buildBridge({ source, destination: path.join(root, "bridge") }),
			/contains a symlink/,
		);
	});
});
