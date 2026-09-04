import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildBridge, injectWorker, patchManifest } from "../build.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INSTALLED_SOURCE = path.join(
	process.env.HOME || "",
	"Library",
	"Application Support",
	"Google",
	"Chrome",
	"Default",
	"Extensions",
	"flkokionhgagpmnhlngldhbfnblmenen",
	"11.0.8_0",
);

test("manifest patch keeps the key and adds only the companion surfaces", () => {
	const manifest = {
		manifest_version: 3,
		name: "__MSG_extensionName__",
		version: "11.0.8",
		default_locale: "en",
		key: "stable-key",
		permissions: ["downloads", "storage", "tabs"],
		host_permissions: ["https://*.x.com/*", "https://*.twillot.com/*"],
		content_scripts: [],
		update_url: "https://clients2.google.com/service/update2/crx",
	};
	const patched = patchManifest(manifest);
	assert.equal(patched.key, manifest.key);
	assert.equal(
		patched.name,
		"Twillot - X Bookmarks, Search & Export (BirdClaw Bridge)",
	);
	assert.equal(patched.update_url, undefined);
	assert.equal(patched.permissions.includes("cookies"), false);
	assert.equal(patched.permissions.includes("alarms"), true);
	assert.equal(patched.host_permissions.includes("http://127.0.0.1/*"), true);
	assert.equal(
		patched.host_permissions.includes(
			"https://birdclaw-production.up.railway.app/*",
		),
		true,
	);
	assert.deepEqual(patched.options_ui, {
		page: "birdclaw-twillot-options.html",
		open_in_tab: true,
	});
	assert.equal(
		patched.content_scripts.at(-1).js[0],
		"birdclaw-twillot-page.js",
	);
});

test("worker injection is explicit and refuses an already patched loader", () => {
	const official = "import './assets/chunk-0542871d.js';\n";
	const patched = injectWorker(official);
	assert.match(patched, /BIRDCLAW_TWILLOT_BRIDGE_START/);
	assert.match(patched, /import '\.\/birdclaw-twillot-worker\.js';/);
	assert.ok(
		patched.indexOf("birdclaw-twillot-worker.js") <
			patched.indexOf("assets/chunk-0542871d.js"),
	);
	assert.throws(() => injectWorker(patched), /already contains/);
});

test(
	"audited local 11.0.8 source builds separate bridge and vanilla rollback copies",
	{ skip: !process.env.HOME },
	async (context) => {
		try {
			await readFile(path.join(INSTALLED_SOURCE, "manifest.json"));
		} catch {
			context.skip(
				"Audited Twillot 11.0.8 source is not installed in this profile.",
			);
			return;
		}
		const nonce = `${process.pid}-${Date.now()}`;
		const bridge = path.join(tmpdir(), `birdclaw-twillot-bridge-${nonce}`);
		const rollback = path.join(tmpdir(), `birdclaw-twillot-rollback-${nonce}`);
		try {
			const built = await buildBridge({
				source: INSTALLED_SOURCE,
				destination: bridge,
				rollbackDestination: rollback,
			});
			assert.equal(path.basename(built.bridgePath), path.basename(bridge));
			assert.equal(path.basename(built.rollbackPath), path.basename(rollback));
			const sourceManifest = JSON.parse(
				await readFile(path.join(INSTALLED_SOURCE, "manifest.json"), "utf8"),
			);
			const bridgeManifest = JSON.parse(
				await readFile(path.join(bridge, "manifest.json"), "utf8"),
			);
			const rollbackManifest = JSON.parse(
				await readFile(path.join(rollback, "manifest.json"), "utf8"),
			);
			assert.equal(bridgeManifest.key, sourceManifest.key);
			assert.equal(rollbackManifest.key, sourceManifest.key);
			assert.equal(bridgeManifest.update_url, undefined);
			assert.equal(rollbackManifest.update_url, undefined);
			assert.match(
				await readFile(path.join(bridge, "service-worker-loader.js"), "utf8"),
				/birdclaw-twillot-worker\.js/,
			);
			assert.equal(
				await readFile(path.join(rollback, "service-worker-loader.js"), "utf8"),
				await readFile(
					path.join(INSTALLED_SOURCE, "service-worker-loader.js"),
					"utf8",
				),
			);
			await assert.rejects(
				readFile(path.join(rollback, "birdclaw-twillot-worker.js")),
				/ENOENT/,
			);
		} finally {
			await rm(bridge, { recursive: true, force: true });
			await rm(rollback, { recursive: true, force: true });
		}
	},
);

test("builder source assets stay inside the integration directory", async () => {
	for (const name of [
		"build.mjs",
		"birdclaw-twillot-worker.js",
		"birdclaw-twillot-page.js",
		"options.html",
		"options.css",
		"options.js",
	]) {
		await readFile(path.join(HERE, "..", name));
	}
});
