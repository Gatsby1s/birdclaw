import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = await readFile(
	path.join(HERE, "..", "birdclaw-twillot-worker.js"),
	"utf8",
);

function domStringList(values) {
	return {
		contains: (value) => values.includes(value),
		[Symbol.iterator]: () => values[Symbol.iterator](),
	};
}

function loadApi() {
	const chrome = {
		storage: {
			local: {
				async get(key) {
					return { [key]: undefined };
				},
				async set() {},
				async remove() {},
			},
		},
		runtime: {
			onMessage: { addListener() {} },
			onInstalled: { addListener() {} },
			onStartup: { addListener() {} },
		},
		alarms: { async create() {}, onAlarm: { addListener() {} } },
		tabs: {
			async query() {
				return [];
			},
			async create() {},
		},
	};
	const context = vm.createContext({
		__BIRDCLAW_TWILLOT_TEST__: true,
		AbortController,
		IDBKeyRange: { bound: (lower, upper) => ({ lower, upper }) },
		TextEncoder,
		URL,
		chrome,
		console: { error() {}, warn() {}, log() {} },
		crypto: webcrypto,
		fetch: async () => new Response(null, { status: 204 }),
		indexedDB: {},
		setTimeout,
		clearTimeout,
	});
	vm.runInContext(SOURCE, context, { filename: "birdclaw-twillot-worker.js" });
	return context.__birdclawTwillotWorkerTest;
}

function createDatabase({ settingsRows = [], postRows = [] } = {}) {
	const indexNames = [
		"owner_category_sort_index",
		"public_index",
		"owner_category_public_created_at_sort_index",
		"public_count_index",
		"onwer_category_index",
		"owner_category_created_at_index",
		"owner_user_created_at",
		"owner_created_at_index",
	];
	return {
		version: 41,
		objectStoreNames: domStringList(["posts", "settings"]),
		transaction(_names, mode) {
			assert.equal(mode, "readonly");
			const transaction = {
				oncomplete: null,
				onerror: null,
				onabort: null,
				abort() {},
				objectStore(name) {
					if (name === "settings") {
						return {
							keyPath: "id",
							autoIncrement: false,
							getAll() {
								const request = {};
								queueMicrotask(() => {
									request.result = structuredClone(settingsRows);
									request.onsuccess?.();
									queueMicrotask(() => transaction.oncomplete?.());
								});
								return request;
							},
						};
					}
					return {
						keyPath: "id",
						autoIncrement: false,
						indexNames: domStringList(indexNames),
						index(indexName) {
							assert.equal(indexName, "public_index");
							return {
								keyPath: ["owner_id", "category_name", "user_id", "sort_index"],
								openCursor(_range, direction) {
									assert.equal(direction, "prev");
									const request = {};
									let position = 0;
									const emit = () => {
										if (position >= postRows.length) {
											request.result = null;
											request.onsuccess?.();
											queueMicrotask(() => transaction.oncomplete?.());
											return;
										}
										const row = postRows[position];
										let continued = false;
										request.result = {
											key: [
												row.owner_id,
												row.category_name,
												row.user_id,
												row.sort_index,
											],
											primaryKey: row.id,
											value: structuredClone(row),
											continue() {
												continued = true;
												position += 1;
												queueMicrotask(emit);
											},
										};
										request.onsuccess?.();
										if (!continued)
											queueMicrotask(() => transaction.oncomplete?.());
									};
									queueMicrotask(emit);
									return request;
								},
							};
						},
					};
				},
			};
			return transaction;
		},
	};
}

function post(id) {
	return {
		id: `${id}_owner_public-post`,
		tweet_id: id,
		owner_id: "owner",
		category_name: "public-post",
		user_id: "12345",
		sort_index: id,
		created_at: 1_700_000_000,
		full_text: `Synthetic tweet ${id}`,
		screen_name: "synthetic_user",
	};
}

test("fails closed on any database version other than audited v41", () => {
	const api = loadApi();
	assert.doesNotThrow(() => api.assertSchema(createDatabase()));
	const database = createDatabase();
	database.version = 42;
	assert.throws(
		() => api.assertSchema(database),
		/Unsupported Twillot database version/,
	);
});

test("finds lastSyncTime only for the exact public external user", async () => {
	const api = loadApi();
	const database = createDatabase({
		settingsRows: [
			{
				id: "public-post_99999_owner_lastSyncTime",
				owner_id: "owner",
				option_value: 1_800_000_000,
			},
			{
				id: "public-post_12345_owner_lastSyncTime",
				owner_id: "owner",
				option_value: 1_770_000_000,
				updated_at: 1_770_000_001,
			},
		],
	});
	const sync = await api.readSyncSettings(database, "12345");
	assert.equal(sync.ownerId, "owner");
	assert.equal(sync.lastSyncTime, 1_770_000_000);
	assert.equal(await api.readSyncSettings(createDatabase(), "12345"), null);
});

test("reads at most allowance records and resumes at the stable cursor", async () => {
	const api = loadApi();
	const rows = [post("300"), post("200"), post("100")];
	const job = {
		id: "job-1",
		handle: "synthetic_user",
		externalUserId: "12345",
		cursor: null,
		leaseToken: "lease-token-123456",
		allowance: 2,
	};
	const first = await api.readPostBatch(
		createDatabase({ postRows: rows }),
		job,
		{ ownerId: "owner" },
	);
	assert.equal(
		[...first.records].map((record) => record.id).join(","),
		"300_owner_public-post,200_owner_public-post",
	);
	assert.equal(first.hasMore, true);
	const second = await api.readPostBatch(
		createDatabase({ postRows: rows }),
		{ ...job, cursor: first.cursor, allowance: 2 },
		{ ownerId: "owner" },
	);
	assert.equal(
		[...second.records].map((record) => record.id).join(","),
		"100_owner_public-post",
	);
	assert.equal(second.hasMore, false);
});

test("rejects non-JSON values instead of silently corrupting a Twillot row", () => {
	const api = loadApi();
	assert.throws(() => api.jsonSafe(new Map([["x", "y"]])), /unsupported value/);
	assert.throws(() => api.jsonSafe({ count: Number.NaN }), /not JSON-safe/);
});
