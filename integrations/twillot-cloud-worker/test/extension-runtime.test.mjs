import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { ensureExtensionRuntime } from "../extension-runtime.mjs";

const ID = "flkokionhgagpmnhlngldhbfnblmenen";
const REVISION = "new-revision";
const options = { extensionId: ID, expectedRevision: REVISION, timeoutMs: 600 };

function fakePage(profile = { developerMode: false, updates: 0 }) {
	return {
		closed: false,
		address: "about:blank",
		url() {
			return this.address;
		},
		isClosed() {
			return this.closed;
		},
		async goto(url) {
			this.address = url;
		},
		async evaluate(fn) {
			const settings = this.address === "chrome://extensions";
			return vm.runInNewContext(`(${fn.toString()})()`, {
				chrome: {
					developerPrivate: settings
						? {
								async getProfileConfiguration() {
									return { inDeveloperMode: profile.developerMode };
								},
								async updateProfileConfiguration(config) {
									assert.equal(config.inDeveloperMode, true);
									profile.updates += 1;
									profile.developerMode = true;
								},
							}
						: undefined,
					runtime: {
						sendMessage(message, callback) {
							assert.equal(message.type, "getCapabilities");
							assert.equal(message.messageId, "birdclaw-runtime-check");
							callback();
						},
					},
				},
			});
		},
		async close() {
			this.closed = true;
		},
	};
}

function harness({
	revision = REVISION,
	apiReady = true,
	immutable = true,
	onReload,
	developerMode = false,
} = {}) {
	const context = new EventEmitter();
	const pages = [];
	let currentWorkers = [];
	let reloads = 0;
	let apiCalls = 0;
	const profile = { developerMode, updates: 0 };
	context.newPage = async () => {
		const page = fakePage(profile);
		pages.push(page);
		return page;
	};
	context.serviceWorkers = () => currentWorkers;
	function worker(value, { id = ID, ready = true, frozen = true } = {}) {
		const globals = vm.createContext({
			chrome: {
				runtime: {
					reload() {
						assert.ok(context.listenerCount("serviceworker") > 0);
						assert.equal(profile.developerMode, true);
						reloads += 1;
						return onReload?.(fixture);
					},
				},
			},
		});
		function initialize(nextRevision, nextReady = true, nextFrozen = true) {
			if (nextRevision !== undefined) {
				Object.defineProperty(globals, "__BIRDCLAW_TWILLOT_REVISION__", {
					value: nextRevision,
					writable: !nextFrozen,
					configurable: !nextFrozen,
				});
			}
			if (nextReady)
				globals.__BIRDCLAW_TWILLOT_CLOUD__ = {
					getState() {
						apiCalls += 1;
					},
					syncNow() {
						apiCalls += 1;
					},
				};
		}
		initialize(value, ready, frozen);
		return {
			url: () => `chrome-extension://${id}/service-worker-loader.js`,
			async evaluate(fn) {
				return vm.runInContext(`(${fn.toString()})()`, globals);
			},
			initialize,
		};
	}
	const initial = worker(revision === null ? undefined : revision, {
		ready: apiReady,
		frozen: immutable,
	});
	currentWorkers = [initial];
	const fixture = {
		context,
		pages,
		profile,
		initial,
		worker,
		reloads: () => reloads,
		apiCalls: () => apiCalls,
		replace(next) {
			currentWorkers = [next];
			context.emit("serviceworker", next);
		},
	};
	return fixture;
}

test("matching immutable runtime returns options and worker without pairing or reload", async () => {
	const f = harness();
	const result = await ensureExtensionRuntime(f.context, options);
	assert.equal(result.serviceWorker, f.initial);
	assert.equal(result.page, f.pages[0]);
	assert.equal(result.page.closed, false);
	assert.equal(f.reloads(), 0);
	assert.equal(f.profile.updates, 0);
	assert.equal(
		f.pages.some((p) => p.url() === "chrome://extensions"),
		false,
	);
	assert.equal(f.apiCalls(), 0);
	assert.equal(f.context.listenerCount("serviceworker"), 0);
	assert.equal(f.context.listenerCount("close"), 0);
});

test("legacy worker reloads once, captures an immediate replacement event, and reopens options", async () => {
	let fresh;
	const f = harness({
		revision: null,
		onReload(f) {
			f.pages[0].closed = true;
			fresh = f.worker(REVISION);
			f.replace(fresh);
			throw new Error("Execution context destroyed; private provider message");
		},
	});
	const result = await ensureExtensionRuntime(f.context, options);
	assert.equal(result.serviceWorker, fresh);
	assert.notEqual(result.page, f.pages[0]);
	assert.equal(result.page.closed, false);
	assert.equal(f.pages[0].closed, true);
	assert.equal(f.reloads(), 1);
	assert.equal(f.profile.updates, 1);
	assert.ok(
		f.pages
			.filter((p) => p.url() === "chrome://extensions")
			.every((p) => p.closed),
	);
	assert.equal(f.apiCalls(), 0);
});

test("an initialized mismatched replacement fails closed after exactly one reload", async () => {
	const f = harness({
		revision: "old",
		onReload(f) {
			f.replace(f.worker("still-old"));
		},
	});
	await assert.rejects(ensureExtensionRuntime(f.context, options), {
		code: "extension_runtime_mismatch",
	});
	assert.equal(f.reloads(), 1);
	assert.equal(f.apiCalls(), 0);
	assert.ok(f.pages.every((page) => page.closed));
});

test("accepts the verified immutable revision when Playwright reuses a worker handle", async () => {
	const f = harness({
		revision: "old",
		onReload(f) {
			f.initial.evaluate = f.worker(REVISION).evaluate;
		},
	});
	const result = await ensureExtensionRuntime(f.context, options);
	assert.equal(result.serviceWorker, f.initial);
	assert.equal(f.reloads(), 1);
});

test("retries failed navigation even if the page URL already matches options", async () => {
	const f = harness();
	const create = f.context.newPage;
	let attempts = 0;
	f.context.newPage = async () => {
		const page = await create();
		const goto = page.goto.bind(page);
		page.goto = async (url) => {
			await goto(url);
			if (++attempts === 1) throw Error("extension temporarily unavailable");
		};
		return page;
	};
	await ensureExtensionRuntime(f.context, options);
	assert.equal(attempts, 2);
	assert.equal(f.reloads(), 0);
});

test("correct revision waits for API initialization without reloading", async () => {
	const f = harness({ apiReady: false });
	const result = ensureExtensionRuntime(f.context, options);
	setImmediate(() => f.initial.initialize(undefined, true));
	assert.equal((await result).serviceWorker, f.initial);
	assert.equal(f.reloads(), 0);
});

test("a mutable marker cannot pass the gate even when its value matches", async () => {
	const f = harness({
		immutable: false,
		onReload(f) {
			f.replace(f.worker(REVISION, { frozen: false }));
		},
	});
	await assert.rejects(ensureExtensionRuntime(f.context, options), {
		code: "extension_runtime_mismatch",
	});
	assert.equal(f.reloads(), 1);
});

test("unrelated extension workers are never evaluated", async () => {
	const f = harness();
	f.context.serviceWorkers = () => [
		{
			url: () => `chrome-extension://${"a".repeat(32)}/worker.js`,
			evaluate() {
				assert.fail("unrelated extension accessed");
			},
		},
		f.initial,
	];
	assert.equal(
		(await ensureExtensionRuntime(f.context, options)).serviceWorker,
		f.initial,
	);
});

test("deadline bounds a stuck evaluate and cleans owned pages and listeners", async () => {
	const f = harness();
	f.initial.evaluate = () => new Promise(() => {});
	await assert.rejects(
		ensureExtensionRuntime(f.context, { ...options, timeoutMs: 25 }),
		{ code: "extension_runtime_timeout" },
	);
	assert.ok(f.pages.every((page) => page.closed));
	assert.equal(f.context.listenerCount("serviceworker"), 0);
	assert.equal(f.context.listenerCount("close"), 0);
});

test("late newPage completion after the deadline is reclaimed", async () => {
	const f = harness();
	let deliver;
	f.context.newPage = () =>
		new Promise((resolve) => {
			deliver = resolve;
		});
	await assert.rejects(
		ensureExtensionRuntime(f.context, { ...options, timeoutMs: 25 }),
		{ code: "extension_runtime_timeout" },
	);
	const late = fakePage();
	deliver(late);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(late.closed, true);
});

test("context shutdown cancels a blocked gate without swallowing other close listeners", async () => {
	const f = harness();
	f.initial.evaluate = () => new Promise(() => {});
	let observed = 0;
	f.context.on("close", () => {
		observed += 1;
	});
	const pending = ensureExtensionRuntime(f.context, options);
	setImmediate(() => f.context.emit("close"));
	await assert.rejects(pending, { code: "extension_runtime_closed" });
	assert.equal(observed, 1);
	assert.equal(f.context.listenerCount("close"), 1);
});

test("requires an expected revision before opening any browser page", async () => {
	const f = harness();
	await assert.rejects(
		ensureExtensionRuntime(f.context, {
			...options,
			expectedRevision: undefined,
		}),
		{ code: "extension_runtime_invalid_config" },
	);
	assert.equal(f.pages.length, 0);
});

test(
	"real Chromium verifies changed bytes after reload and process restart at the same manifest version",
	{
		skip: process.env.BIRDCLAW_TEST_EXTENSION_RUNTIME !== "1",
		timeout: 60_000,
	},
	async () => {
		const { chromium } = await import("@playwright/test");
		const root = await realpath(
			await mkdtemp(path.join(os.tmpdir(), "birdclaw-runtime-test-")),
		);
		const extension = path.join(root, "extension");
		const profile = path.join(root, "profile");
		let context;
		const source = (revision) =>
			`Object.defineProperty(globalThis, '__BIRDCLAW_TWILLOT_REVISION__', {value:${JSON.stringify(revision)}}); globalThis.__BIRDCLAW_TWILLOT_CLOUD__ = Object.freeze({getState(){throw Error('must not pair')},syncNow(){throw Error('must not sync')}}); chrome.runtime.onInstalled.addListener(()=>{}); chrome.runtime.onMessage.addListener((message,sender,respond)=>{respond(null);});`;
		const launch = async () => {
			context = await chromium.launchPersistentContext(profile, {
				channel: "chromium",
				headless: true,
				args: [
					`--disable-extensions-except=${extension}`,
					`--load-extension=${extension}`,
				],
			});
		};
		try {
			await mkdir(extension);
			await writeFile(
				path.join(extension, "manifest.json"),
				JSON.stringify({
					manifest_version: 3,
					name: "Synthetic BirdClaw runtime test",
					version: "1.0.0",
					background: { service_worker: "worker.js" },
				}),
			);
			await writeFile(
				path.join(extension, "birdclaw-twillot-options.html"),
				"<!doctype html><title>Synthetic runtime test</title>",
			);
			await writeFile(path.join(extension, "worker.js"), source("A"));
			await launch();
			const first =
				context.serviceWorkers()[0] ??
				(await context.waitForEvent("serviceworker", { timeout: 15_000 }));
			const extensionId = new URL(first.url()).hostname;
			await ensureExtensionRuntime(context, {
				extensionId,
				expectedRevision: "A",
				timeoutMs: 8_000,
			});
			await writeFile(path.join(extension, "worker.js"), source("B"));
			assert.equal(
				await first.evaluate(() => globalThis.__BIRDCLAW_TWILLOT_REVISION__),
				"A",
			);
			const logs = [];
			const result = await ensureExtensionRuntime(context, {
				extensionId,
				expectedRevision: "B",
				timeoutMs: 8_000,
				log: (event, detail) => logs.push({ event, ...detail }),
			});
			assert.equal(
				await result.serviceWorker.evaluate(
					() => globalThis.__BIRDCLAW_TWILLOT_REVISION__,
				),
				"B",
			);
			assert.equal(result.page.isClosed(), false);
			assert.equal(
				logs.filter((entry) => entry.event === "extension_runtime_reload")
					.length,
				1,
			);
			// Preserve the disk cache, replace only code, then restart the process.
			await context.close();
			await writeFile(path.join(extension, "worker.js"), source("C"));
			await launch();
			const restarted = await ensureExtensionRuntime(context, {
				extensionId,
				expectedRevision: "C",
				timeoutMs: 8_000,
			});
			assert.equal(
				await restarted.serviceWorker.evaluate(
					() => globalThis.__BIRDCLAW_TWILLOT_REVISION__,
				),
				"C",
			);
			assert.equal(restarted.page.isClosed(), false);
		} finally {
			await context?.close();
			await rm(root, { recursive: true, force: true });
		}
	},
);
