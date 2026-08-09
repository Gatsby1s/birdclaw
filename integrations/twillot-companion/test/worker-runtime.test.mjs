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
const TOKEN = "t".repeat(43);
const PAGE_URL =
	"https://www.twillot.com/export-twitter-posts?publicUid=synthetic_user";

async function drain(rounds = 12) {
	for (let index = 0; index < rounds; index += 1) {
		await new Promise((resolve) => setImmediate(resolve));
	}
}

function response(body, { status = 200 } = {}) {
	return new Response(body === null ? null : JSON.stringify(body), {
		status,
		headers: body === null ? undefined : { "content-type": "application/json" },
	});
}

function domStringList(values) {
	return {
		contains: (value) => values.includes(value),
		[Symbol.iterator]: () => values[Symbol.iterator](),
	};
}

function createWorkerDatabase(state) {
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
		close() {},
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
									request.result = structuredClone(state.settingsRows);
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
										if (position >= state.postRows.length) {
											request.result = null;
											request.onsuccess?.();
											queueMicrotask(() => transaction.oncomplete?.());
											return;
										}
										const row = state.postRows[position];
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

async function createHarness(fetchResponses = [], { databaseState } = {}) {
	const storage = new Map([
		[
			"birdclawTwillotSettings",
			{
				endpoint: "http://127.0.0.1:3001/api/integrations/twillot-history",
				token: TOKEN,
			},
		],
		[
			"birdclawTwillotIdentity",
			{ sourceId: "11111111-2222-4333-8444-555555555555" },
		],
	]);
	const createdTabs = [];
	const fetchCalls = [];
	const alarms = [];
	let responseIndex = 0;
	const clone = (value) =>
		value === undefined ? undefined : structuredClone(value);
	const chrome = {
		storage: {
			local: {
				async get(key) {
					return { [key]: clone(storage.get(key)) };
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
			onMessage: { addListener() {} },
			onInstalled: { addListener() {} },
			onStartup: { addListener() {} },
			async openOptionsPage() {},
		},
		alarms: {
			async create(name, config) {
				alarms.push({ name, config: clone(config) });
			},
			onAlarm: { addListener() {} },
		},
		tabs: {
			async query() {
				return [];
			},
			async create(config) {
				const tab = { id: createdTabs.length + 1, ...config };
				createdTabs.push(tab);
				return tab;
			},
		},
	};
	const fetch = async (url, init) => {
		fetchCalls.push({
			url: String(url),
			init: {
				method: init.method,
				headers: clone(init.headers),
				body: init.body,
				credentials: init.credentials,
			},
		});
		const next = fetchResponses[responseIndex++];
		if (next instanceof Error) throw next;
		return next || response(null, { status: 204 });
	};
	const database = databaseState ? createWorkerDatabase(databaseState) : null;
	const indexedDB = database
		? {
				async databases() {
					if (databaseState.available === false) return [];
					return [{ name: "twillot", version: database.version }];
				},
				open() {
					const request = {};
					queueMicrotask(() => {
						request.result = database;
						request.onsuccess?.();
					});
					return request;
				},
			}
		: {};
	const context = vm.createContext({
		__BIRDCLAW_TWILLOT_TEST__: true,
		AbortController,
		IDBKeyRange: {
			bound(lower, upper) {
				return { lower, upper };
			},
		},
		Response,
		TextEncoder,
		URL,
		chrome,
		console: { error() {}, warn() {}, log() {} },
		crypto: webcrypto,
		fetch,
		indexedDB,
		setTimeout,
		clearTimeout,
		structuredClone,
	});
	vm.runInContext(SOURCE, context, { filename: "birdclaw-twillot-worker.js" });
	await drain();
	return {
		api: context.__birdclawTwillotWorkerTest,
		storage,
		createdTabs,
		fetchCalls,
		alarms,
	};
}

function syntheticJob() {
	return {
		id: "job-1",
		handle: "synthetic_user",
		externalUserId: "12345",
		cursor: null,
		leaseToken: "lease-token-123456",
		allowance: 200,
	};
}

function storedCapture(harness, job = syntheticJob()) {
	const stored = harness.storage.get("birdclawTwillotCapture");
	const entries = Array.isArray(stored?.entries) ? stored.entries : [stored];
	return entries.find(
		(capture) =>
			capture?.jobId === job.id &&
			capture?.externalUserId === job.externalUserId,
	);
}

function putStoredCapture(harness, capture) {
	const stored = harness.storage.get("birdclawTwillotCapture");
	const entries = (Array.isArray(stored?.entries) ? stored.entries : [stored])
		.filter(Boolean)
		.filter(
			(entry) =>
				entry.jobId !== capture.jobId ||
				entry.externalUserId !== capture.externalUserId,
		);
	entries.push(capture);
	harness.storage.set("birdclawTwillotCapture", { version: 1, entries });
}

function batchBody(job, done = false) {
	return {
		action: "batch",
		protocolVersion: 1,
		jobId: job.id,
		leaseToken: job.leaseToken,
		batchId: `bc-twillot-${"a".repeat(32)}`,
		records: [
			{
				id: "9_owner_public-post",
				owner_id: "owner",
				user_id: job.externalUserId,
				category_name: "public-post",
				full_text: "Synthetic public tweet",
			},
		],
		cursor: {
			indexKey: ["owner", "public-post", job.externalUserId, "9"],
			primaryKey: "9_owner_public-post",
		},
		done,
		lastSyncTime: 1_770_000_000,
	};
}

test("claims with sourceId/requestedCap and opens Twillot without clicking", async () => {
	const job = syntheticJob();
	const harness = await createHarness([response({ ok: true, job })], {
		databaseState: { settingsRows: [], postRows: [] },
	});
	const result = await harness.api.claimNextJob();
	assert.equal(result.ok, true);
	const claimUrl = new URL(harness.fetchCalls[0].url);
	assert.equal(claimUrl.pathname, "/api/integrations/twillot-history");
	assert.equal(
		claimUrl.searchParams.get("sourceId"),
		"11111111-2222-4333-8444-555555555555",
	);
	assert.equal(claimUrl.searchParams.get("requestedCap"), "200");
	assert.equal(harness.createdTabs[0].active, true);
	assert.match(harness.createdTabs[0].url, /publicUid=synthetic_user/);
	assert.equal(harness.fetchCalls[0].init.method, "GET");
	assert.equal(harness.fetchCalls[0].init.credentials, "omit");
	assert.equal(
		harness.fetchCalls[0].init.headers.Authorization,
		`Bearer ${TOKEN}`,
	);
});

test("never opens export before baseline capture succeeds", async () => {
	const job = syntheticJob();
	const databaseState = {
		available: false,
		settingsRows: [
			{
				id: "public-post_12345_owner_lastSyncTime",
				owner_id: "owner",
				option_value: 100,
				updated_at: 100,
			},
		],
		postRows: [],
	};
	const harness = await createHarness(
		[response({ ok: true, job }), response({ ok: true })],
		{ databaseState },
	);
	const claim = await harness.api.claimNextJob();
	assert.equal(claim.baselinePending, true);
	assert.equal(harness.createdTabs.length, 0);
	assert.equal(harness.storage.has("birdclawTwillotActiveJob"), true);
	assert.equal(storedCapture(harness, job).baselineCaptured, false);
	assert.equal((await harness.api.claimNextJob()).baselinePending, true);
	assert.equal(harness.createdTabs.length, 0);

	databaseState.available = true;
	const scan = await harness.api.scanActiveJob();
	assert.equal(scan.baselineCaptured, true);
	assert.equal(harness.createdTabs.length, 1);
	assert.equal(storedCapture(harness, job).baselineLastSyncTime, 100);
	const heartbeat = harness.fetchCalls
		.map((call) => (call.init.body ? JSON.parse(call.init.body) : null))
		.find((body) => body?.action === "heartbeat");
	assert.equal(heartbeat.status, "waiting_for_twillot");
	assert.equal("state" in heartbeat, false);
	assert.equal(
		harness.fetchCalls.some(
			(call) => call.init.body && JSON.parse(call.init.body).action === "batch",
		),
		false,
	);
});

test("only the matching Twillot page can see or wake the job", async () => {
	const job = syntheticJob();
	const harness = await createHarness();
	harness.storage.set("birdclawTwillotActiveJob", job);
	const trusted = await harness.api.handleMessage(
		{ type: harness.api.CONTROL.getActiveJob, publicUid: "synthetic_user" },
		{ url: PAGE_URL },
	);
	assert.equal(trusted.job.externalUserId, job.externalUserId);
	const wrong = await harness.api.handleMessage(
		{ type: harness.api.CONTROL.getActiveJob, publicUid: "other_user" },
		{ url: PAGE_URL },
	);
	assert.equal(wrong.job, null);
	const untrusted = await harness.api.handleMessage(
		{ type: harness.api.CONTROL.getActiveJob, publicUid: "synthetic_user" },
		{ url: "https://example.com/" },
	);
	assert.equal(untrusted.ok, false);
});

test("POST uses the single endpoint and backs off the exact failed batch", async () => {
	const job = syntheticJob();
	const body = batchBody(job);
	const harness = await createHarness([new TypeError("offline")]);
	harness.storage.set("birdclawTwillotActiveJob", job);
	harness.storage.set("birdclawTwillotOutbox", {
		batchId: body.batchId,
		body,
		attempts: 0,
	});
	const result = await harness.api.flushOutbox();
	assert.equal(result.queued, true);
	assert.equal(
		harness.fetchCalls[0].url,
		"http://127.0.0.1:3001/api/integrations/twillot-history",
	);
	const sent = JSON.parse(harness.fetchCalls[0].init.body);
	assert.equal(sent.action, "batch");
	assert.equal(sent.sourceId, "11111111-2222-4333-8444-555555555555");
	assert.equal(sent.leaseToken, job.leaseToken);
	assert.equal(
		harness.storage.get("birdclawTwillotOutbox").batchId,
		body.batchId,
	);
	assert.equal(harness.storage.get("birdclawTwillotOutbox").attempts, 1);
	assert.ok(
		harness.storage.get("birdclawTwillotOutbox").nextAttemptAt > Date.now(),
	);
	assert.equal(harness.alarms.at(-1).name, "birdclaw-twillot-retry");
	assert.equal(harness.api.outboxRetryDelay(1), 30_000);
	assert.equal(harness.api.outboxRetryDelay(30), 15 * 60_000);
});

test("every accepted batch discards its lease and the second batch reclaims server cursor", async () => {
	const job = syntheticJob();
	const firstBody = batchBody(job, false);
	const secondJob = {
		...job,
		cursor: firstBody.cursor,
		leaseToken: "new-lease-token-654321",
		allowance: 199,
	};
	const first = await createHarness([
		response({ ok: true }),
		response({ ok: true, job: secondJob }),
	]);
	first.storage.set("birdclawTwillotActiveJob", job);
	putStoredCapture(first, {
		jobId: job.id,
		externalUserId: job.externalUserId,
		baselineCaptured: true,
		baselineLastSyncTime: 1,
		observedLastSyncTime: 2,
		stableSince: 1,
		approvedLastSyncTime: 2,
	});
	first.storage.set("birdclawTwillotOutbox", {
		batchId: firstBody.batchId,
		body: firstBody,
	});
	assert.equal((await first.api.flushOutbox()).accepted, true);
	assert.equal(first.storage.has("birdclawTwillotActiveJob"), false);
	assert.equal(first.storage.has("birdclawTwillotCapture"), true);
	assert.equal((await first.api.claimNextJob()).ok, true);
	assert.equal(first.fetchCalls[1].init.method, "GET");
	assert.equal(
		first.storage.get("birdclawTwillotActiveJob").leaseToken,
		secondJob.leaseToken,
	);
	assert.deepEqual(
		first.storage.get("birdclawTwillotActiveJob").cursor,
		firstBody.cursor,
	);

	const doneBody = batchBody(job, true);
	const done = await createHarness([response({ ok: true })]);
	done.storage.set("birdclawTwillotActiveJob", job);
	done.storage.set("birdclawTwillotOutbox", {
		batchId: doneBody.batchId,
		body: doneBody,
	});
	assert.equal((await done.api.flushOutbox()).finished, true);
	assert.equal(done.storage.has("birdclawTwillotActiveJob"), false);
	assert.equal(
		done.storage.get("birdclawTwillotStatus").state,
		"caught_up_unverified",
	);
});

test("STALE_LEASE drops only the stale outbox and lease so the cursor is reclaimed", async () => {
	const job = syntheticJob();
	const body = batchBody(job);
	const harness = await createHarness([
		response({ ok: false, code: "STALE_LEASE" }, { status: 409 }),
	]);
	harness.storage.set("birdclawTwillotActiveJob", job);
	harness.storage.set("birdclawTwillotOutbox", {
		batchId: body.batchId,
		body,
		attempts: 0,
	});
	const result = await harness.api.flushOutbox();
	assert.equal(result.staleLease, true);
	assert.equal(harness.storage.has("birdclawTwillotOutbox"), false);
	assert.equal(harness.storage.has("birdclawTwillotActiveJob"), false);
	assert.equal(harness.alarms.at(-1).name, "birdclaw-twillot-claim");
});

test("TARGET_MISMATCH fails the renamed job closed and releases the queue", async () => {
	const job = syntheticJob();
	const body = batchBody(job);
	const harness = await createHarness([
		response({ ok: false, code: "TARGET_MISMATCH" }, { status: 409 }),
		response({ ok: true }),
	]);
	harness.storage.set("birdclawTwillotActiveJob", job);
	harness.storage.set("birdclawTwillotOutbox", {
		batchId: body.batchId,
		body,
		attempts: 0,
	});

	const result = await harness.api.flushOutbox();

	assert.equal(result.permanent, true);
	assert.equal(harness.storage.has("birdclawTwillotOutbox"), false);
	assert.equal(harness.storage.has("birdclawTwillotActiveJob"), false);
	assert.equal(harness.storage.has("birdclawTwillotCapture"), false);
	assert.equal(
		harness.storage.get("birdclawTwillotStatus").state,
		"schema-blocked",
	);
});

test("STALE_LEASE from a waiting heartbeat drops the lease and reclaims", async () => {
	const job = syntheticJob();
	const databaseState = {
		settingsRows: [
			{
				id: "public-post_12345_owner_lastSyncTime",
				owner_id: "owner",
				option_value: 100,
				updated_at: 100,
			},
		],
		postRows: [],
	};
	const harness = await createHarness(
		[response({ ok: false, code: "STALE_LEASE" }, { status: 409 })],
		{ databaseState },
	);
	harness.storage.set("birdclawTwillotActiveJob", job);
	putStoredCapture(harness, {
		jobId: job.id,
		externalUserId: job.externalUserId,
		baselineCaptured: true,
		baselineLastSyncTime: 100,
		observedLastSyncTime: null,
		stableSince: null,
		approvedLastSyncTime: null,
	});
	const result = await harness.api.scanActiveJob();
	assert.equal(result.staleLease, true);
	assert.equal(harness.storage.has("birdclawTwillotActiveJob"), false);
	assert.equal(storedCapture(harness, job).baselineLastSyncTime, 100);
	assert.equal(harness.alarms.at(-1).name, "birdclaw-twillot-claim");
});

test("captures stay isolated when the server interleaves two jobs", async () => {
	const jobA = syntheticJob();
	const jobB = {
		id: "job-2",
		handle: "second_user",
		externalUserId: "67890",
		cursor: null,
		leaseToken: "lease-token-second",
		allowance: 200,
	};
	const databaseState = {
		settingsRows: [
			{
				id: "public-post_67890_owner_lastSyncTime",
				owner_id: "owner",
				option_value: 500,
				updated_at: 500,
			},
		],
		postRows: [],
	};
	const body = batchBody(jobA, false);
	const harness = await createHarness(
		[
			response({ ok: true }),
			response({ ok: true, job: jobB }),
			response({ ok: true, job: jobA }),
		],
		{ databaseState },
	);
	harness.storage.set("birdclawTwillotActiveJob", jobA);
	putStoredCapture(harness, {
		jobId: jobA.id,
		externalUserId: jobA.externalUserId,
		baselineCaptured: true,
		baselineLastSyncTime: 100,
		observedLastSyncTime: 101,
		stableSince: 1,
		approvedLastSyncTime: 101,
	});
	harness.storage.set("birdclawTwillotOutbox", {
		batchId: body.batchId,
		body,
	});
	assert.equal((await harness.api.flushOutbox()).accepted, true);
	assert.equal((await harness.api.claimNextJob()).job.id, jobB.id);
	assert.equal(storedCapture(harness, jobA).approvedLastSyncTime, 101);
	assert.equal(storedCapture(harness, jobB).baselineLastSyncTime, 500);
	harness.storage.delete("birdclawTwillotActiveJob");
	assert.equal((await harness.api.claimNextJob()).job.id, jobA.id);
	assert.equal(storedCapture(harness, jobA).approvedLastSyncTime, 101);
});

test("pageOpened ignores cached lastSyncTime and starts only after a stable update", async () => {
	const job = syntheticJob();
	const databaseState = {
		settingsRows: [
			{
				id: "public-post_12345_owner_lastSyncTime",
				owner_id: "owner",
				option_value: 100,
				updated_at: 100,
			},
		],
		postRows: [
			{
				id: "9_owner_public-post",
				tweet_id: "9",
				owner_id: "owner",
				category_name: "public-post",
				user_id: "12345",
				sort_index: "9",
				created_at: 1_700_000_000,
				full_text: "Freshly synchronized tweet",
				screen_name: "synthetic_user",
				reply_to_id: "8",
				media_items: [
					{
						media_key: "m9",
						type: "photo",
						media_url_https: "https://example.com/9.jpg",
						forbidden: "MEDIA_DB_SENTINEL",
					},
				],
				_data: { forbidden: "PRIVATE_DB_SENTINEL" },
				forbidden: "ROW_DB_SENTINEL",
			},
		],
	};
	const harness = await createHarness(
		[
			response({ ok: true, job }),
			response({ ok: true }),
			response({ ok: true }),
			response({ ok: true }),
		],
		{ databaseState },
	);
	assert.equal((await harness.api.claimNextJob()).ok, true);
	assert.equal(storedCapture(harness, job).baselineLastSyncTime, 100);

	const opened = {
		type: harness.api.CONTROL.pageOpened,
		publicUid: job.handle,
	};
	const sender = { url: PAGE_URL };
	assert.equal((await harness.api.handleMessage(opened, sender)).waiting, true);
	assert.equal(
		harness.fetchCalls.some(
			(call) => call.init.body && JSON.parse(call.init.body).action === "batch",
		),
		false,
	);

	databaseState.settingsRows[0].option_value = 101;
	databaseState.settingsRows[0].updated_at = 101;
	assert.equal((await harness.api.handleMessage(opened, sender)).waiting, true);
	const capture = storedCapture(harness, job);
	putStoredCapture(harness, {
		...capture,
		stableSince: Date.now() - 5_001,
	});
	assert.equal(
		(await harness.api.handleMessage(opened, sender)).accepted,
		true,
	);
	const batchCall = harness.fetchCalls.find(
		(call) => call.init.body && JSON.parse(call.init.body).action === "batch",
	);
	assert.ok(batchCall);
	const uploaded = JSON.parse(batchCall.init.body);
	assert.equal(uploaded.lastSyncTime, 101);
	assert.equal(uploaded.records[0].reply_to_id, "8");
	assert.equal(uploaded.records[0].media_items[0].media_key, "m9");
	assert.equal(uploaded.records[0]._data, undefined);
	assert.equal(uploaded.records[0].forbidden, undefined);
	assert.equal(JSON.stringify(uploaded).includes("SENTINEL"), false);
});

test("temporary IndexedDB readiness errors retry without reporting a job error", async () => {
	const harness = await createHarness([response({ ok: true })]);
	harness.storage.set("birdclawTwillotActiveJob", syntheticJob());
	const result = await harness.api.scanActiveJob();
	assert.equal(result.ok, false);
	assert.equal(harness.storage.has("birdclawTwillotActiveJob"), true);
	const actions = harness.fetchCalls
		.filter((call) => call.init.body)
		.map((call) => JSON.parse(call.init.body).action);
	assert.deepEqual(actions, ["heartbeat"]);
	assert.equal(harness.alarms.at(-1).name, "birdclaw-twillot-retry");
});

test("post projection emits only the strict server whitelist", async () => {
	const harness = await createHarness();
	const job = syntheticJob();
	const projected = harness.api.projectPostRecord(
		{
			id: "9_owner_public-post",
			tweet_id: "9",
			conversation_id: "8",
			owner_id: "owner",
			user_id: "12345",
			category_name: "public-post",
			sort_index: "9",
			created_at: 1_700_000_000,
			full_text: "Synthetic tweet",
			screen_name: "synthetic_user",
			reply_to_id: "7",
			quoted_tweet_id: "6",
			entities: {
				hashtags: [{ tag: "BirdClaw", forbidden: "ENTITY_SENTINEL" }],
			},
			media_items: [
				{
					media_key: "m1",
					id: "legacy-media-id",
					type: "video",
					media_url_https: "https://example.com/media.jpg",
					forbidden: "MEDIA_SENTINEL",
				},
			],
			_data: {
				forbidden: "PRIVATE_SENTINEL",
				legacy: { quoted_tweet: { secret: true }, conversations: ["secret"] },
			},
			quoted_tweet: { forbidden: "QUOTE_SENTINEL" },
			conversations: ["CONVERSATION_SENTINEL"],
			forbidden: "ROW_SENTINEL",
		},
		job,
		"owner",
		"9_owner_public-post",
	);
	assert.equal(projected.reply_to_id, "7");
	assert.equal(projected.quoted_tweet_id, "6");
	assert.equal(projected.entities.hashtags[0].tag, "BirdClaw");
	assert.equal(projected.media_items[0].media_key, "m1");
	assert.equal(projected.media_items[0].id, "legacy-media-id");
	const allowed = new Set([
		"id",
		"tweet_id",
		"conversation_id",
		"owner_id",
		"user_id",
		"category_name",
		"sort_index",
		"created_at",
		"full_text",
		"screen_name",
		"username",
		"avatar_url",
		"lang",
		"views_count",
		"bookmark_count",
		"favorite_count",
		"quote_count",
		"reply_count",
		"retweet_count",
		"is_reply",
		"is_quote",
		"reply_to_id",
		"quoted_tweet_id",
		"entities",
		"media_items",
	]);
	assert.equal(
		Object.keys(projected).every((key) => allowed.has(key)),
		true,
	);
	assert.equal(
		Object.keys(projected.media_items[0]).every((key) =>
			new Set([
				"media_key",
				"id",
				"type",
				"url",
				"preview_image_url",
				"media_url",
				"media_url_https",
				"width",
				"height",
				"video_info",
			]).has(key),
		),
		true,
	);
	assert.equal(Object.hasOwn(projected, "_data"), false);
	assert.equal(Object.hasOwn(projected, "quoted_tweet"), false);
	assert.equal(Object.hasOwn(projected, "conversations"), false);
	const serialized = JSON.stringify(projected);
	for (const forbidden of [
		"PRIVATE_SENTINEL",
		"ENTITY_SENTINEL",
		"MEDIA_SENTINEL",
		"ROW_SENTINEL",
	]) {
		assert.equal(serialized.includes(forbidden), false);
	}
	assert.throws(
		() =>
			harness.api.projectPostRecord(
				{
					id: "9_owner_public-post",
					owner_id: "owner",
					user_id: "12345",
					category_name: "public-post",
					created_at: 1_700_000_000,
					full_text: "Missing tweet id",
					screen_name: "synthetic_user",
				},
				job,
				"owner",
				"9_owner_public-post",
			),
		/schema checks/,
	);
});

test("configuration rejects every non-loopback endpoint", async () => {
	const harness = await createHarness();
	assert.throws(
		() => harness.api.normalizeEndpoint("https://example.com/api"),
		/loopback/,
	);
	assert.throws(
		() => harness.api.normalizeEndpoint("http://127.0.0.1:3001/api?token=x"),
		/loopback/,
	);
	assert.equal(
		harness.api.normalizeEndpoint("http://localhost:3001/api/"),
		"http://localhost:3001/api",
	);
});

test("worker never reads session storage or calls a Twillot/X private API", () => {
	assert.equal(SOURCE.includes("chrome.storage.session"), false);
	assert.equal(SOURCE.includes("x.com/i/api"), false);
	assert.equal(SOURCE.includes("apix.twillot.com"), false);
	assert.equal(SOURCE.includes("verified_complete"), false);
});
