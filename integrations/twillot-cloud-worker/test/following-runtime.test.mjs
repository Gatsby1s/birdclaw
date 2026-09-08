import assert from "node:assert/strict";
import test from "node:test";
import {
	createFollowingSynchronizer,
	isFollowingPageUrl,
	safeWorkerError,
} from "../following-runtime.mjs";

const ready = {
	rows: 1,
	count: 1,
	signature: "42",
	followingLabel: "Following 1",
	syncVisible: false,
	syncEnabled: false,
	nextVisible: false,
	nextEnabled: false,
};
function fixture({
	pages = [],
	inspectPage = async () => ready,
	timeoutMs = 100,
	readinessMs = 15,
} = {}) {
	let created = 0;
	const uploads = [];
	const logs = [];
	const context = {
		pages: () => pages.filter((page) => !page.closed),
		newPage: async () => {
			created += 1;
			const page = fakePage();
			pages.push(page);
			return page;
		},
	};
	const sync = createFollowingSynchronizer({
		context,
		inspectPage,
		timeoutMs,
		readinessMs,
		stableMs: 0,
		pollMs: 1,
		scrapePage: async () => [{ id: "42", username: "alice", name: "Alice" }],
		uploadSnapshot: async (users, pageCount) => {
			uploads.push({ count: users.size, pageCount });
		},
		log: (event, detail) => logs.push({ event, ...detail }),
	});
	return { sync, pages, uploads, logs, created: () => created };
}

function fakePage(url = "about:blank") {
	return {
		closed: false,
		address: url,
		navigations: 0,
		url() {
			return this.address;
		},
		isClosed() {
			return this.closed;
		},
		setDefaultTimeout() {},
		setDefaultNavigationTimeout() {},
		async goto(target) {
			this.address = target;
			this.navigations += 1;
		},
		async close() {
			this.closed = true;
		},
		getByRole() {
			return { isVisible: async () => false, isEnabled: async () => false };
		},
	};
}

test("reuses language-prefixed following pages and rejects unrelated hosts/routes", () => {
	for (const url of [
		"https://www.twillot.com/en/twitter-following",
		"https://www.twillot.com/twitter-following?x=1",
		"https://www.twillot.com/zh-CN/twitter-following",
	])
		assert.equal(isFollowingPageUrl(url), true);
	for (const url of [
		"https://evil.com/en/twitter-following",
		"https://www.twillot.com/en/export-twitter-posts?publicUid=42",
		"bad",
	])
		assert.equal(isFollowingPageUrl(url), false);
});

test("repeated failed empty snapshots retain exactly one page and never upload", async () => {
	const f = fixture({
		inspectPage: async () => ({
			...ready,
			rows: 0,
			count: null,
			followingLabel: null,
		}),
		readinessMs: 3,
	});
	for (let n = 0; n < 10; n += 1)
		await assert.rejects(f.sync(), /following_not_ready/);
	assert.equal(f.created(), 1);
	assert.equal(f.pages.filter((page) => !page.closed).length, 1);
	assert.equal(f.uploads.length, 0);
});

test("closes leaked following pages but preserves export/job pages", async () => {
	const keep = fakePage("https://www.twillot.com/en/twitter-following");
	const leaked = fakePage("https://www.twillot.com/en/twitter-following");
	const job = fakePage(
		"https://www.twillot.com/en/export-twitter-posts?publicUid=42",
	);
	const f = fixture({ pages: [keep, leaked, job] });
	await f.sync();
	await f.sync();
	assert.equal(f.created(), 0);
	assert.equal(leaked.closed, true);
	assert.equal(job.closed, false);
	assert.equal(keep.navigations, 2);
});

test("waits through delayed rendering instead of uploading an empty snapshot", async () => {
	let reads = 0;
	const f = fixture({
		inspectPage: async () =>
			++reads < 3 ? { ...ready, rows: 0, count: null } : ready,
	});
	await f.sync();
	assert.ok(reads >= 3);
	assert.deepEqual(f.uploads, [{ count: 1, pageCount: 1 }]);
});

test("classifies missing extension and logs only safe page diagnostics", async () => {
	const page = fakePage(
		"https://www.twillot.com/en/twitter-following?token=SECRET",
	);
	const f = fixture({
		pages: [page],
		inspectPage: async () => ({
			...ready,
			rows: 0,
			count: 0,
			followingLabel: "Following 0",
			extensionMissing: true,
			syncVisible: true,
			syncEnabled: true,
		}),
	});
	await assert.rejects(f.sync(), /following_extension_missing/);
	assert.equal(f.uploads.length, 0);
	assert.ok(
		f.logs.some(
			(entry) =>
				entry.extensionMissing && entry.followingLabel === "Following 0",
		),
	);
	assert.equal(JSON.stringify(f.logs).includes("SECRET"), false);
	assert.equal(
		safeWorkerError(new Error("token=SECRET")),
		"worker_operation_failed",
	);
});

test("login-required is distinct from a slow or empty page", async () => {
	const f = fixture({
		inspectPage: async () => ({ ...ready, needsLogin: true }),
	});
	await assert.rejects(f.sync(), /following_login_required/);
	assert.equal(f.uploads.length, 0);
});

test("whole-operation timeout closes a stuck page and allows a fresh retry", async () => {
	const page = fakePage("https://www.twillot.com/en/twitter-following");
	page.goto = () => new Promise(() => {});
	const f = fixture({ pages: [page], timeoutMs: 20 });
	await assert.rejects(f.sync(), /following_timeout/);
	assert.equal(page.closed, true);
	await f.sync();
	assert.equal(f.created(), 1);
	assert.equal(f.uploads.length, 1);
});

test("coalesces concurrent attempts rather than opening competing pages", async () => {
	const f = fixture();
	await Promise.all([f.sync(), f.sync()]);
	assert.equal(f.created(), 1);
	assert.equal(f.uploads.length, 1);
});

test("rejects a nonempty but incomplete snapshot", async () => {
	const f = fixture({ inspectPage: async () => ({ ...ready, count: 2 }) });
	await assert.rejects(f.sync(), /following_incomplete/);
	assert.equal(f.uploads.length, 0);
});
