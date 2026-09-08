import assert from "node:assert/strict";
import test from "node:test";
import {
	createFollowingSynchronizer,
	isFollowingPageUrl,
	safeWorkerError,
	reconnectExistingXSession,
} from "../following-runtime.mjs";
import { uploadFollowingSnapshot } from "../following-upload.mjs";

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
	reconnectSession = async () => false,
	loginGraceMs = 0,
	onFailure = async () => {},
	refreshSync = async () => {},
	uploadSnapshot,
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
		onFailure,
		inspectPage,
		refreshSync,
		reconnectSession,
		timeoutMs,
		readinessMs,
		stableMs: 0,
		loginGraceMs,
		pollMs: 1,
		scrapePage: async () => [{ id: "42", username: "alice", name: "Alice" }],
		uploadSnapshot:
			uploadSnapshot ??
			(async (users, pageCount) => {
				uploads.push({ count: users.size, pageCount });
			}),
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

test("reconnects an existing X session once before retrying the following page", async () => {
	let connected = false;
	let attempts = 0;
	const f = fixture({
		inspectPage: async () => ({ ...ready, needsLogin: !connected }),
		reconnectSession: async () => {
			attempts += 1;
			connected = true;
			return true;
		},
	});
	await f.sync();
	assert.equal(attempts, 1);
	assert.equal(f.uploads.length, 1);
	assert.equal(f.created(), 1);
});

test("existing-session reconnect only opens X and waits for the account control", async () => {
	const page = fakePage();
	let marker;
	page.getByTestId = (name) => ({
		waitFor: async () => {
			marker = name;
		},
	});
	assert.equal(
		await reconnectExistingXSession({ newPage: async () => page }),
		true,
	);
	assert.equal(page.address, "https://x.com/home");
	assert.equal(marker, "SideNav_AccountSwitcher_Button");
	assert.equal(page.closed, true);
	page.closed = false;
	page.getByTestId = () => ({
		waitFor: async () => {
			throw new Error("login required");
		},
	});
	assert.equal(
		await reconnectExistingXSession({ newPage: async () => page }),
		false,
	);
	assert.equal(page.closed, true);
});

test("ignores a transient login overlay while the extension hydrates", async () => {
	let reads = 0;
	let attempts = 0;
	const f = fixture({
		loginGraceMs: 10,
		readinessMs: 100,
		inspectPage: async () => ({ ...ready, needsLogin: ++reads < 3 }),
		reconnectSession: async () => {
			attempts += 1;
			return true;
		},
	});
	await f.sync();
	assert.equal(attempts, 0);
	assert.equal(f.uploads.length, 1);
});

test("completes Twillot's existing-account dialog after checking the cloud X session", async () => {
	const x = fakePage();
	x.getByTestId = () => ({ waitFor: async () => {} });
	const actions = [];
	const following = {
		getByRole: (_role, { name }) => ({
			first: () => ({
				or: () => ({ first: () => ({ waitFor: async () => {} }) }),
				isVisible: async () => true,
				click: async () => actions.push(`click:${name.source}`),
				waitFor: async ({ state }) =>
					actions.push(`wait:${name.source}:${state}`),
			}),
		}),
	};
	assert.equal(
		await reconnectExistingXSession({ newPage: async () => x }, following),
		true,
	);
	assert.deepEqual(actions, [
		"click:Connect Twitter Now",
		"wait:Continue as:visible",
		"click:Continue as",
		"wait:Continue as:hidden",
		"wait:Connect Twitter Now:hidden",
	]);
	assert.equal(x.closed, true);
});

test("does not interact with Twillot auth when the existing X session is invalid", async () => {
	const x = fakePage();
	x.getByTestId = () => ({
		waitFor: async () => {
			throw new Error("expired");
		},
	});
	let accessed = false;
	assert.equal(
		await reconnectExistingXSession(
			{ newPage: async () => x },
			{
				getByRole: () => {
					accessed = true;
					throw new Error("must not interact");
				},
			},
		),
		false,
	);
	assert.equal(accessed, false);
	assert.equal(x.closed, true);
});

test("reclaims only new verification tabs when persisted-auth completion times out", async () => {
	const existing = fakePage("https://x.com/i/bookmarks?twillot=reauth");
	const job = fakePage(
		"https://www.twillot.com/en/export-twitter-posts?publicUid=42",
	);
	const auth = fakePage("https://x.com/i/bookmarks?twillot=reauth");
	const x = fakePage();
	x.getByTestId = () => ({ waitFor: async () => {} });
	const pages = [existing, job];
	const context = {
		pages: () => pages,
		newPage: async () => {
			pages.push(x);
			return x;
		},
	};
	const following = {
		getByRole: (_role, { name }) => ({
			first: () => ({
				or: () => ({ first: () => ({ waitFor: async () => {} }) }),
				isVisible: async () => true,
				click: async () => {
					if (name.test("Continue as Alice")) pages.push(auth);
				},
				waitFor: async ({ state, timeout }) => {
					if (state === "hidden" && name.test("Continue as Alice")) {
						assert.equal(timeout, 60_000);
						throw new Error("auth persistence timeout");
					}
				},
			}),
		}),
	};
	assert.equal(await reconnectExistingXSession(context, following), false);
	assert.equal(auth.closed, true);
	assert.equal(x.closed, true);
	assert.equal(existing.closed, false);
	assert.equal(job.closed, false);
});

test("does not complete or close verification while Connect is hidden but Continue still verifies", async () => {
	const x = fakePage();
	x.getByTestId = () => ({ waitFor: async () => {} });
	const auth = fakePage("https://x.com/i/bookmarks?twillot=reauth");
	const pages = [];
	let finishPersistence;
	const persisted = new Promise((resolve) => {
		finishPersistence = resolve;
	});
	let settled = false;
	let awaitingPersistence = false;
	let connectHiddenChecks = 0;
	const logs = [];
	const following = {
		getByRole: (_role, { name }) => ({
			first: () => ({
				or: () => ({ first: () => ({ waitFor: async () => {} }) }),
				isVisible: async () => true,
				click: async () => {
					if (name.test("Continue as Alice")) pages.push(auth);
				},
				waitFor: async ({ state, timeout }) => {
					if (state !== "hidden") return;
					if (name.test("Continue as Alice")) {
						assert.equal(timeout, 60_000);
						awaitingPersistence = true;
						await persisted;
					} else {
						// The modal hides this button immediately, even before token polling.
						connectHiddenChecks += 1;
					}
				},
			}),
		}),
	};
	const result = reconnectExistingXSession(
		{
			pages: () => pages,
			newPage: async () => {
				pages.push(x);
				return x;
			},
		},
		following,
		(_event, detail) => logs.push(detail),
	).then((value) => {
		settled = true;
		return value;
	});
	try {
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(awaitingPersistence, true);
		assert.equal(settled, false);
		assert.equal(connectHiddenChecks, 0);
		assert.equal(auth.closed, false);
		assert.equal(x.closed, false);
		assert.equal(
			logs.some((entry) => entry.stage === "complete"),
			false,
		);
	} finally {
		finishPersistence();
	}
	assert.equal(await result, true);
	assert.equal(connectHiddenChecks, 1);
	assert.equal(auth.closed, true);
	assert.equal(x.closed, true);
	assert.equal(logs.at(-1).stage, "complete");
});

test("discovers an uncached account through Twillot before verifying its session", async () => {
	const x = fakePage();
	x.getByTestId = () => ({ waitFor: async () => {} });
	let discovered = false;
	const actions = [];
	const logs = [];
	const following = {
		getByRole: (_role, { name }) => ({
			first: () => ({
				or: () => ({ first: () => ({ waitFor: async () => {} }) }),
				isVisible: async () => discovered,
				waitFor: async () => {
					if (name instanceof RegExp && name.test("Continue as"))
						assert.equal(discovered, true);
				},
				click: async () => {
					actions.push(String(name));
					if (name === "Connect Twitter") discovered = true;
				},
			}),
		}),
	};
	assert.equal(
		await reconnectExistingXSession(
			{ newPage: async () => x },
			following,
			(event, fields) => logs.push({ event, ...fields }),
		),
		true,
	);
	assert.deepEqual(actions, [
		"/Connect Twitter Now/i",
		"Connect Twitter",
		"/Continue as/i",
	]);
	assert.ok(logs.some((entry) => entry.stage === "account_discovery"));
	assert.equal(logs.at(-1).stage, "complete");
	assert.equal(x.closed, true);
});

test("a failed diagnostic does not replace the original collection error", async () => {
	let observed = 0;
	const f = fixture({
		inspectPage: async () => ({ ...ready, count: 2 }),
		onFailure: async (page) => {
			assert.ok(page);
			observed += 1;
			throw new Error("artifact failure");
		},
	});
	await assert.rejects(f.sync(), /following_incomplete/);
	assert.equal(observed, 1);
	assert.equal(f.uploads.length, 0);
});

test("whole-operation deadline aborts an in-flight native upload", async () => {
	let aborted = false;
	const f = fixture({
		timeoutMs: 50,
		uploadSnapshot: (users, pageCount, { signal }) =>
			uploadFollowingSnapshot(
				{
					endpoint:
						"https://birdclaw-production.up.railway.app/api/integrations/twillot-history",
					token: "synthetic-token",
				},
				[...users.values()],
				pageCount,
				{
					signal,
					fetchImpl: async (_url, options) =>
						new Promise((_resolve, reject) => {
							options.signal.addEventListener(
								"abort",
								() => {
									aborted = true;
									reject(options.signal.reason);
								},
								{ once: true },
							);
						}),
				},
			),
	});
	await assert.rejects(f.sync(), /following_timeout/);
	assert.equal(aborted, true);
	assert.equal(f.pages[0].closed, true);
});
