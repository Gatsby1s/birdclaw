import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_SOURCE = await readFile(
	path.join(HERE, "..", "bridge", "birdclaw-bridge.js"),
	"utf8",
);
const OBSERVER_SOURCE = await readFile(
	path.join(HERE, "..", "bridge", "birdclaw-idb-observer.js"),
	"utf8",
);
const FIXED_SOURCE_ID = "11111111-2222-4333-8444-555555555555";
const DEFAULT_TOKEN = "a".repeat(43);

async function drain(rounds = 16) {
	for (let index = 0; index < rounds; index += 1) {
		await new Promise((resolve) => setImmediate(resolve));
	}
}

function fakeIndexedDb(data, control) {
	const storeNames = Object.keys(data);
	const database = {
		version: 7,
		objectStoreNames: { contains: (name) => storeNames.includes(name) },
		close() {},
		transaction(requestedStoreNames, mode) {
			assert.equal(mode, "readonly");
			assert.deepEqual(
				[...requestedStoreNames],
				["remarks", "tags", "categories"],
			);
			let completedRequests = 0;
			const transaction = {
				oncomplete: null,
				onerror: null,
				onabort: null,
				objectStore(name) {
					return {
						getAll() {
							const request = {
								result: undefined,
								onsuccess: null,
								onerror: null,
							};
							queueMicrotask(() => {
								request.result = structuredClone(data[name]);
								request.onsuccess?.();
								completedRequests += 1;
								if (completedRequests === requestedStoreNames.length) {
									queueMicrotask(() => transaction.oncomplete?.());
								}
							});
							return request;
						},
					};
				},
			};
			return transaction;
		},
	};

	const api = {
		open(name) {
			assert.equal(name, "xRemark");
			control.openCalls += 1;
			const request = {
				result: undefined,
				transaction: null,
				onsuccess: null,
				onerror: null,
				onblocked: null,
				onupgradeneeded: null,
			};
			queueMicrotask(() => {
				if (!control.present) {
					request.transaction = {
						abort() {
							control.upgradeAborts += 1;
						},
					};
					request.onupgradeneeded?.();
					queueMicrotask(() => request.onerror?.());
					return;
				}
				request.result = database;
				request.onsuccess?.();
			});
			return request;
		},
	};
	if (control.databasesAvailable) {
		api.databases = async () =>
			control.present ? [{ name: "xRemark", version: 7 }] : [];
	}
	return api;
}

async function createHarness({
	token = DEFAULT_TOKEN,
	responses = [{ ok: true, status: 200 }],
	databasePresent = true,
	databasesAvailable = true,
	installObserver = false,
} = {}) {
	const storage = new Map();
	if (token !== null) storage.set("birdclawXRemarkSettings", { token });
	const messageListeners = [];
	const alarmListeners = [];
	const installedListeners = [];
	const startupListeners = [];
	const alarms = new Map();
	const clearedAlarms = [];
	const timers = new Map();
	const fetchCalls = [];
	const consoleCalls = [];
	const observerMessages = [];
	let timerId = 0;
	let responseIndex = 0;
	let clock = 1_770_000_000_000;
	const databaseControl = {
		present: databasePresent,
		databasesAvailable,
		openCalls: 0,
		upgradeAborts: 0,
	};
	const databaseData = {
		remarks: [
			{ identifier: "synthetic-user", remark: "Synthetic private note" },
		],
		tags: [{ id: "tag-1", name: "Synthetic tag" }],
		categories: [{ id: "category-1", name: "Synthetic category" }],
	};
	const requestTokens = {
		add: { method: "add" },
		put: { method: "put" },
		delete: { method: "delete" },
		clear: { method: "clear" },
		cursorUpdate: { method: "cursor-update" },
		cursorDelete: { method: "cursor-delete" },
	};

	class SyntheticTransaction {
		constructor() {
			this.db = { name: "xRemark" };
			this.listeners = new Map();
		}
		addEventListener(type, listener, options) {
			const listeners = this.listeners.get(type) ?? [];
			listeners.push({ listener, once: Boolean(options?.once) });
			this.listeners.set(type, listeners);
		}
		complete() {
			const listeners = this.listeners.get("complete") ?? [];
			for (const entry of listeners) entry.listener();
			this.listeners.set(
				"complete",
				listeners.filter((entry) => !entry.once),
			);
		}
	}

	class SyntheticObjectStore {
		constructor(name, transaction) {
			this.name = name;
			this.transaction = transaction;
		}
		add() {
			return requestTokens.add;
		}
		put() {
			return requestTokens.put;
		}
		delete() {
			return requestTokens.delete;
		}
		clear() {
			return requestTokens.clear;
		}
	}

	class SyntheticCursor {
		constructor(source) {
			this.source = source;
		}
		update() {
			return requestTokens.cursorUpdate;
		}
		delete() {
			return requestTokens.cursorDelete;
		}
	}

	const clone = (value) =>
		value === undefined ? undefined : structuredClone(value);
	const chrome = {
		storage: {
			local: {
				async get(key) {
					if (typeof key === "string")
						return { [key]: clone(storage.get(key)) };
					throw new Error("Test harness only supports string storage keys.");
				},
				async set(values) {
					for (const [key, value] of Object.entries(values))
						storage.set(key, clone(value));
				},
				async remove(key) {
					storage.delete(key);
				},
			},
		},
		runtime: {
			onMessage: { addListener: (listener) => messageListeners.push(listener) },
			onInstalled: {
				addListener: (listener) => installedListeners.push(listener),
			},
			onStartup: { addListener: (listener) => startupListeners.push(listener) },
			async sendMessage(message) {
				observerMessages.push(clone(message));
				for (const listener of messageListeners)
					listener(message, {}, () => {});
			},
		},
		alarms: {
			onAlarm: { addListener: (listener) => alarmListeners.push(listener) },
			async get(name) {
				return clone(alarms.get(name));
			},
			async create(name, options) {
				alarms.set(name, { name, ...clone(options) });
			},
			async clear(name) {
				clearedAlarms.push(name);
				return alarms.delete(name);
			},
		},
	};

	const context = vm.createContext({
		chrome,
		indexedDB: fakeIndexedDb(databaseData, databaseControl),
		IDBObjectStore: SyntheticObjectStore,
		IDBCursor: SyntheticCursor,
		crypto: { randomUUID: () => FIXED_SOURCE_ID },
		fetch: async (url, options) => {
			fetchCalls.push({ url, options: clone(options) });
			return responses[Math.min(responseIndex++, responses.length - 1)];
		},
		setTimeout: (callback, delay) => {
			const id = ++timerId;
			timers.set(id, { callback, delay });
			return id;
		},
		clearTimeout: (id) => timers.delete(id),
		console: {
			log: (...args) => consoleCalls.push(["log", ...args]),
			info: (...args) => consoleCalls.push(["info", ...args]),
			warn: (...args) => consoleCalls.push(["warn", ...args]),
			error: (...args) => consoleCalls.push(["error", ...args]),
		},
		Date: { now: () => clock },
		JSON,
		Number,
		Promise,
		Set,
		TypeError,
	});
	vm.runInContext(BRIDGE_SOURCE, context, { filename: "birdclaw-bridge.js" });
	if (installObserver) {
		vm.runInContext(OBSERVER_SOURCE, context, {
			filename: "birdclaw-idb-observer.js",
		});
	}
	await drain();

	async function mutation(type) {
		assert.equal(messageListeners.length, 1);
		const returned = messageListeners[0]({ type }, {}, () => {
			throw new Error("Mutation messages must not receive a bridge response.");
		});
		assert.equal(returned, false);
		await drain();
	}

	async function control(message) {
		return new Promise((resolve, reject) => {
			const returned = messageListeners[0](message, {}, resolve);
			if (returned !== true)
				reject(
					new Error("Control message did not keep the response channel open."),
				);
		});
	}

	async function fireDebounce() {
		assert.equal(timers.size, 1);
		await firePendingDeadline();
	}

	async function firePendingDeadline() {
		assert.ok(timers.size >= 1);
		const nextDelay = Math.min(
			...[...timers.values()].map((timer) => timer.delay),
		);
		const dueTimers = [...timers.entries()].filter(
			([, timer]) => timer.delay === nextDelay,
		);
		assert.equal(nextDelay, 800);
		clock += nextDelay;
		for (const [id, timer] of dueTimers) {
			timers.delete(id);
			timer.callback();
		}
		await drain(24);
	}

	async function fireSingleTimer() {
		assert.equal(timers.size, 1);
		const [id, timer] = [...timers.entries()][0];
		timers.delete(id);
		assert.equal(timer.delay, 800);
		clock += timer.delay;
		timer.callback();
		await drain(24);
	}

	async function fireAlarm(name) {
		assert.equal(alarmListeners.length, 1);
		alarmListeners[0]({ name });
		await drain(24);
	}

	return {
		storage,
		databaseControl,
		databaseData,
		observerMessages,
		requestTokens,
		alarms,
		clearedAlarms,
		fetchCalls,
		consoleCalls,
		installedListeners,
		startupListeners,
		mutation,
		control,
		fireDebounce,
		firePendingDeadline,
		fireSingleTimer,
		fireAlarm,
		directTransaction(storeName = "remarks") {
			const transaction = new SyntheticTransaction();
			const store = new SyntheticObjectStore(storeName, transaction);
			const cursor = new SyntheticCursor(store);
			return { transaction, store, cursor };
		},
	};
}

test("debounces official mutations and sends the required full snapshot contract", async () => {
	const harness = await createHarness();
	await harness.mutation("XR-UPSERT-REMARK");
	await harness.mutation("XR-UPDATE-TAG");
	await harness.fireDebounce();

	assert.equal(harness.fetchCalls.length, 1);
	const request = harness.fetchCalls[0];
	assert.equal(
		request.url,
		"http://127.0.0.1:3001/api/integrations/xremark/snapshot",
	);
	assert.equal(request.options.method, "POST");
	assert.equal(
		request.options.headers.Authorization,
		`Bearer ${DEFAULT_TOKEN}`,
	);
	assert.equal(request.options.cache, "no-store");

	const payload = JSON.parse(request.options.body);
	assert.equal(payload.sourceId, FIXED_SOURCE_ID);
	assert.equal(payload.sequence, 2);
	assert.equal(Number.isFinite(payload.capturedAt), true);
	assert.equal(payload.database.name, "xRemark");
	assert.equal(payload.database.version, 7);
	assert.equal(payload.database.backupID, `birdclaw:${FIXED_SOURCE_ID}:2`);
	assert.equal(payload.database.backupTime, payload.capturedAt);
	assert.deepEqual(payload.remarks, [
		{ identifier: "synthetic-user", remark: "Synthetic private note" },
	]);
	assert.deepEqual(payload.tags, [{ id: "tag-1", name: "Synthetic tag" }]);
	assert.deepEqual(payload.categories, [
		{ id: "category-1", name: "Synthetic category" },
	]);
	assert.equal(harness.storage.has("birdclawXRemarkOutbox"), false);
	assert.equal(harness.storage.get("birdclawXRemarkStatus").state, "ready");
	assert.deepEqual(harness.consoleCalls, []);

	const heartbeat = harness.alarms.get("birdclaw-xremark-heartbeat");
	assert.equal(heartbeat.delayInMinutes, 5);
	assert.equal(heartbeat.periodInMinutes, 5);

	await harness.fireAlarm("birdclaw-xremark-heartbeat");
	assert.equal(harness.fetchCalls.length, 2);
	const heartbeatPayload = JSON.parse(harness.fetchCalls[1].options.body);
	assert.equal(heartbeatPayload.sequence, 2);
	assert.equal(heartbeatPayload.sourceId, FIXED_SOURCE_ID);
});

test("observes direct and bulk IndexedDB writes once after commit, then snapshots them", async () => {
	const harness = await createHarness({ installObserver: true });
	const { transaction, store, cursor } = harness.directTransaction("remarks");

	assert.equal(store.add({}), harness.requestTokens.add);
	assert.equal(store.put({}), harness.requestTokens.put);
	assert.equal(store.delete("synthetic-user"), harness.requestTokens.delete);
	assert.equal(store.clear(), harness.requestTokens.clear);
	assert.equal(cursor.update({}), harness.requestTokens.cursorUpdate);
	assert.equal(cursor.delete(), harness.requestTokens.cursorDelete);
	assert.equal(harness.observerMessages.length, 0);
	assert.equal(harness.storage.get("birdclawXRemarkIdentity").sequence, 0);

	harness.databaseData.remarks = [
		{
			identifier: "direct-idb-user",
			remark: "Committed direct IndexedDB note",
		},
	];
	transaction.complete();
	await drain(24);

	assert.deepEqual(harness.observerMessages, [
		{ type: "birdclaw:xremark:database-mutated", database: "xRemark" },
	]);
	assert.equal(harness.fetchCalls.length, 0);
	assert.equal(harness.storage.get("birdclawXRemarkPendingMutation").count, 1);
	assert.equal(harness.storage.get("birdclawXRemarkIdentity").sequence, 0);

	await harness.fireDebounce();
	assert.equal(harness.fetchCalls.length, 1);
	const payload = JSON.parse(harness.fetchCalls[0].options.body);
	assert.equal(payload.sequence, 1);
	assert.deepEqual(payload.remarks, harness.databaseData.remarks);
});

test("heartbeat alarm during the 800ms mutation window cannot send a stale snapshot", async () => {
	const harness = await createHarness();
	await harness.mutation("XR-UPSERT-REMARK");
	harness.databaseData.remarks = [
		{
			identifier: "post-mutation-user",
			remark: "Only the post-mutation state",
		},
	];

	assert.equal(harness.storage.get("birdclawXRemarkIdentity").sequence, 0);
	await harness.fireAlarm("birdclaw-xremark-heartbeat");
	assert.equal(harness.fetchCalls.length, 0);
	assert.equal(harness.storage.get("birdclawXRemarkIdentity").sequence, 0);
	assert.equal(harness.storage.get("birdclawXRemarkPendingMutation").count, 1);

	await harness.fireDebounce();
	assert.equal(harness.fetchCalls.length, 1);
	const payload = JSON.parse(harness.fetchCalls[0].options.body);
	assert.equal(payload.sequence, 1);
	assert.deepEqual(payload.remarks, harness.databaseData.remarks);
});

test("manual sync waits for the pending debounce and sends only the post-mutation state", async () => {
	const harness = await createHarness();
	await harness.mutation("XR-UPDATE-REMARK");
	harness.databaseData.remarks = [
		{
			identifier: "manual-sync-user",
			remark: "Committed before manual response",
		},
	];

	let settled = false;
	const manual = harness
		.control({ type: "birdclaw:xremark:sync-now" })
		.then((result) => {
			settled = true;
			return result;
		});
	await drain(12);
	assert.equal(settled, false);
	assert.equal(harness.fetchCalls.length, 0);

	await harness.firePendingDeadline();
	assert.equal((await manual).ok, true);
	assert.equal(harness.fetchCalls.length, 1);
	const payload = JSON.parse(harness.fetchCalls[0].options.body);
	assert.equal(payload.sequence, 1);
	assert.deepEqual(payload.remarks, harness.databaseData.remarks);
});

test("persists a failed outbox and retries it from an alarm", async () => {
	const harness = await createHarness({
		responses: [
			{ ok: false, status: 503 },
			{ ok: true, status: 200 },
		],
	});
	await harness.mutation("XR-SIDEPANEL-DELETEREMARK");
	await harness.fireDebounce();

	const failedOutbox = harness.storage.get("birdclawXRemarkOutbox");
	assert.equal(failedOutbox.attempts, 1);
	assert.equal(failedOutbox.payload.sequence, 1);
	assert.equal(
		harness.storage.get("birdclawXRemarkStatus").lastError,
		"BirdClaw returned HTTP 503.",
	);
	assert.equal(harness.alarms.get("birdclaw-xremark-retry").delayInMinutes, 1);

	await harness.fireAlarm("birdclaw-xremark-retry");
	assert.equal(harness.fetchCalls.length, 2);
	assert.equal(harness.storage.has("birdclawXRemarkOutbox"), false);
	assert.equal(harness.storage.get("birdclawXRemarkStatus").state, "ready");
	assert.ok(harness.clearedAlarms.includes("birdclaw-xremark-retry"));
	assert.deepEqual(harness.consoleCalls, []);
});

test("retries a local snapshot-read failure from the alarm", async () => {
	const harness = await createHarness({ databasePresent: false });
	await harness.mutation("XR-ADD-TAG");
	await harness.fireDebounce();

	assert.equal(harness.fetchCalls.length, 0);
	assert.equal(harness.storage.has("birdclawXRemarkOutbox"), false);
	assert.equal(
		harness.storage.get("birdclawXRemarkStatus").lastError,
		"X Remark storage is not available yet.",
	);
	assert.equal(harness.alarms.get("birdclaw-xremark-retry").delayInMinutes, 1);
	assert.equal(harness.databaseControl.openCalls, 0);

	harness.databaseControl.present = true;
	await harness.fireAlarm("birdclaw-xremark-retry");
	assert.equal(harness.fetchCalls.length, 1);
	assert.equal(JSON.parse(harness.fetchCalls[0].options.body).sequence, 1);
	assert.equal(harness.storage.get("birdclawXRemarkStatus").state, "ready");
});

test("aborts onupgradeneeded when database enumeration is unavailable", async () => {
	const harness = await createHarness({
		databasePresent: false,
		databasesAvailable: false,
	});
	await harness.mutation("XR-DELETE-CATEGORY");
	await harness.fireDebounce();

	assert.equal(harness.databaseControl.openCalls, 1);
	assert.equal(harness.databaseControl.upgradeAborts, 1);
	assert.equal(harness.databaseControl.present, false);
	assert.equal(harness.fetchCalls.length, 0);
	assert.equal(harness.storage.has("birdclawXRemarkOutbox"), false);
	assert.equal(
		harness.storage.get("birdclawXRemarkStatus").lastError,
		"X Remark storage is not available yet.",
	);
});

test("keeps a snapshot pending until a token is paired and never returns the token", async () => {
	const harness = await createHarness({ token: null });
	await harness.mutation("XR-ADD-CATEGORY");
	await harness.fireDebounce();

	assert.equal(harness.fetchCalls.length, 0);
	assert.equal(harness.storage.has("birdclawXRemarkOutbox"), true);
	assert.equal(
		harness.storage.get("birdclawXRemarkStatus").state,
		"needs-pairing",
	);

	const before = await harness.control({ type: "birdclaw:xremark:get-state" });
	assert.equal(before.tokenConfigured, false);
	assert.equal("token" in before, false);

	const invalid = await harness.control({
		type: "birdclaw:xremark:set-token",
		token: "too-short",
	});
	assert.equal(invalid.ok, false);
	assert.equal(harness.storage.has("birdclawXRemarkSettings"), false);

	const paired = harness.control({
		type: "birdclaw:xremark:set-token",
		token: "b".repeat(43),
	});
	await drain(32);
	assert.equal((await paired).ok, true);
	assert.equal(harness.fetchCalls.length, 1);
	assert.equal(JSON.parse(harness.fetchCalls[0].options.body).sequence, 2);

	const after = await harness.control({ type: "birdclaw:xremark:get-state" });
	assert.equal(after.tokenConfigured, true);
	assert.equal("token" in after, false);
	assert.equal(JSON.stringify(after).includes("b".repeat(43)), false);
	assert.equal(
		JSON.stringify(harness.storage.get("birdclawXRemarkStatus")).includes(
			"Synthetic private note",
		),
		false,
	);
});
