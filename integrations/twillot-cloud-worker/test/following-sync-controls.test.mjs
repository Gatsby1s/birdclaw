import assert from "node:assert/strict";
import test from "node:test";
import {
	refreshFollowingSync,
	inspectFollowingSyncControls,
} from "../following-sync-controls.mjs";
import {
	createFollowingSynchronizer,
	safeWorkerError,
} from "../following-runtime.mjs";

const TITLE = "AI-Powered Analysis of Your Following Network";
const SETTINGS = { timeoutMs: 300, pollMs: 1, stableMs: 0 };

function fixture({
	cached = false,
	autoComplete = true,
	error = null,
	sameMinute = false,
	announcementAtFinish = false,
	announcementInitially = false,
	unknownModal = false,
} = {}) {
	const state = {
		sheet: false,
		menu: false,
		confirm: false,
		busy: false,
		first: !cached,
		marker: cached ? "Last full sync time: 2026-09-08 12:00" : null,
		error: null,
		starts: 0,
		index: 0,
		closed: false,
		announcement: announcementInitially,
		unknownModal,
	};
	const actions = [];
	const logs = [];
	const loc = ({
		visible = () => true,
		enabled = () => true,
		click = () => {},
	} = {}) => ({
		first() {
			return this;
		},
		isVisible: async () => visible(),
		isEnabled: async () => enabled(),
		waitFor: async ({ state: expected }) => {
			assert.equal(visible(), expected === "visible");
		},
		click: async () => {
			assert.ok(visible());
			assert.ok(enabled());
			await click();
		},
	});
	function finish() {
		state.busy = false;
		state.first = false;
		state.error = error;
		if (announcementAtFinish) state.announcement = true;
		if (!error && !sameMinute)
			state.marker = `Last full sync time: 2026-09-08 12:${String(state.starts).padStart(2, "0")}`;
	}
	const start = () => {
		state.starts += 1;
		actions.push("start-full");
		// Async job startup leaves the old idle controls visible briefly.
		if (autoComplete)
			setTimeout(() => {
				state.busy = true;
				setTimeout(finish, 3);
			}, 3);
	};
	const sheet = {
		...loc({ visible: () => state.sheet }),
		getByRole(role, { name, exact }) {
			assert.equal(role, "button");
			assert.equal(exact, true);
			return loc({
				visible: () =>
					state.sheet &&
					!state.announcement &&
					!state.unknownModal &&
					({
						"Start First Sync": state.first && !state.busy,
						Syncing: state.busy,
						"Sync Latest Data": !state.first && !state.busy,
						"Continue Incomplete Sync": false,
						Close: true,
					}[name] ??
						false),
				enabled: () => !state.busy,
				click: () => {
					if (name === "Start First Sync") start();
					else if (name === "Close") {
						assert.equal(state.busy, false);
						state.sheet = false;
						actions.push("close-sheet");
					} else assert.fail(`must not click ${name}`);
				},
			});
		},
		locator(selector) {
			assert.equal(selector, '[aria-haspopup="menu"]');
			return {
				...loc({
					visible: () => state.sheet && !state.first && !state.busy,
					click: () => {
						state.menu = true;
						actions.push("open-following-menu");
					},
				}),
				getAttribute: async (name) => {
					assert.equal(name, "aria-controls");
					return "following-menu";
				},
			};
		},
		evaluate: async (fn) => {
			const element = (text) => ({
				innerText: text,
				contains: () => false,
				getBoundingClientRect: () => ({ width: 100 }),
			});
			return fn({
				querySelectorAll: (selector) =>
					selector === "p,span,div"
						? state.marker
							? [element(state.marker)]
							: []
						: state.error
							? [element(state.error)]
							: [],
			});
		},
	};
	const page = {
		url: () => "https://www.twillot.com/en/twitter-following",
		isClosed: () => state.closed,
		close: async () => {
			state.closed = true;
		},
		setDefaultTimeout() {},
		setDefaultNavigationTimeout() {},
		goto: async () => {
			state.index = 0;
		},
		getByRole(role, options) {
			if (role === "heading") {
				assert.equal(options.name, TITLE);
				assert.equal(options.exact, true);
				return { title: TITLE };
			}
			if (role === "dialog" && options.includeHidden)
				return {
					filter: ({ has }) => {
						assert.equal(has.title, TITLE);
						return sheet;
					},
				};
			if (role === "dialog") {
				if (options.name === "New: More control over your X data") {
					assert.equal(options.exact, true);
					return {
						...loc({ visible: () => state.announcement }),
						getByRole: (role, options) => {
							assert.equal(role, "button");
							assert.deepEqual(options, { name: "Close", exact: true });
							return loc({
								visible: () => state.announcement,
								click: () => {
									state.announcement = false;
									actions.push("dismiss-announcement");
								},
							});
						},
					};
				}
				assert.equal(options.name, "Confirm Full Sync");
				assert.equal(options.exact, true);
				return {
					...loc({ visible: () => state.confirm }),
					getByRole: (role, options) => {
						assert.equal(role, "button");
						assert.deepEqual(options, { name: "Confirm", exact: true });
						return loc({
							visible: () => state.confirm,
							click: () => {
								state.confirm = false;
								actions.push("confirm-full");
								start();
							},
						});
					},
				};
			}
			assert.equal(role, "button");
			if (options.name instanceof RegExp)
				return loc({
					visible: () =>
						!state.sheet && !state.announcement && !state.unknownModal,
					click: () => {
						state.sheet = true;
						actions.push("open-following-sheet");
					},
				});
			if (options.name === "Go to first page")
				return loc({
					visible: () => !state.sheet,
					enabled: () => state.index > 0,
					click: () => {
						state.index = 0;
					},
				});
			assert.equal(options.name, "Next page");
			return loc({
				visible: () =>
					!state.sheet && !state.announcement && !state.unknownModal,
				enabled: () => state.index === 0,
				click: () => {
					state.index = 1;
					actions.push("next-page");
				},
			});
		},
		locator(selector) {
			assert.equal(selector, '[id="following-menu"]');
			return {
				getByRole: (role, options) => {
					assert.equal(role, "menuitem");
					assert.deepEqual(options, { name: "Restart Full Sync", exact: true });
					return loc({
						visible: () => state.menu,
						click: () => {
							state.menu = false;
							state.confirm = true;
							actions.push("restart-full");
						},
					});
				},
			};
		},
	};
	const run = () =>
		refreshFollowingSync(page, {
			...SETTINGS,
			log: (event) => logs.push(event),
		});
	return { state, page, actions, logs, run, finish };
}

test("first sync enters only the Following sheet and closes after a new full-sync marker", async () => {
	const f = fixture();
	await f.run();
	assert.deepEqual(f.actions, [
		"open-following-sheet",
		"start-full",
		"close-sheet",
	]);
	assert.deepEqual(f.logs, [
		"following_sync_sheet_opened",
		"following_full_sync_started",
		"following_full_sync_completed",
		"following_sync_sheet_closed",
	]);
});

test("cached and repeated refreshes use the linked menu and named full-sync confirmation", async () => {
	const f = fixture({ cached: true });
	await f.run();
	await f.run();
	assert.equal(f.state.starts, 2);
	assert.equal(f.actions.filter((a) => a === "confirm-full").length, 2);
	assert.equal(f.actions.filter((a) => a === "close-sheet").length, 2);
});

test("old idle controls and delayed busy state cannot complete or close early", async () => {
	const f = fixture({ cached: true, autoComplete: false });
	let settled = false;
	const running = f.run().finally(() => {
		settled = true;
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(f.state.starts, 1);
	assert.equal(settled, false);
	assert.equal(f.state.sheet, true);
	f.state.busy = true;
	f.state.marker = "Last full sync time: 2026-09-08 12:01";
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(settled, false);
	assert.equal(f.state.sheet, true);
	f.finish();
	await running;
	assert.equal(f.state.sheet, false);
});

test("an unchanged minute-rounded timestamp fails closed without closing the sheet", async () => {
	const f = fixture({ cached: true, sameMinute: true });
	await assert.rejects(
		refreshFollowingSync(f.page, { ...SETTINGS, timeoutMs: 30 }),
		{ code: "following_sync_timeout" },
	);
	assert.equal(f.state.sheet, true);
	assert.equal(f.actions.includes("close-sheet"), false);
});

for (const [message, code] of [
	["Rate limit reached token=PRIVATE", "following_sync_rate_limited"],
	["Upgrade subscription token=PRIVATE", "following_sync_upgrade_required"],
	["Sync failed token=PRIVATE", "following_sync_failed"],
]) {
	test(`${code} never closes or uploads and logs only the fixed error`, async () => {
		const f = fixture({ error: message });
		let uploaded = false;
		const sync = createFollowingSynchronizer({
			context: { pages: () => [f.page] },
			inspectPage: async () => ({
				rows: 1,
				count: 2,
				signature: "1",
				syncVisible: true,
				syncEnabled: true,
			}),
			refreshSync: (page, options) =>
				refreshFollowingSync(page, { ...options, ...SETTINGS }),
			scrapePage: async () => [],
			uploadSnapshot: async () => {
				uploaded = true;
			},
			timeoutMs: 1_000,
			stableMs: 0,
			pollMs: 1,
		});
		await assert.rejects(sync(), (error) => {
			assert.equal(safeWorkerError(error), code);
			return true;
		});
		assert.equal(uploaded, false);
		assert.equal(f.state.sheet, true);
		assert.equal(f.actions.includes("close-sheet"), false);
		assert.equal(JSON.stringify(f.logs).includes("PRIVATE"), false);
	});
}

test("finish-time announcement is dismissed before collecting two pages on every fresh cycle", async () => {
	const f = fixture({ announcementAtFinish: true });
	const uploads = [];
	const sync = createFollowingSynchronizer({
		context: { pages: () => [f.page] },
		inspectPage: async () => ({
			rows: 1,
			count: 2,
			signature: String(f.state.index + 1),
			...(await inspectFollowingSyncControls(f.page)),
			nextVisible: !f.state.sheet,
			nextEnabled: !f.state.sheet && f.state.index === 0,
		}),
		refreshSync: (page, options) =>
			refreshFollowingSync(page, { ...options, ...SETTINGS }),
		scrapePage: async () => {
			assert.equal(f.state.sheet, false);
			assert.equal(f.state.announcement, false);
			return [
				{ id: String(f.state.index + 1), username: `user${f.state.index + 1}` },
			];
		},
		uploadSnapshot: async (users, pages) =>
			uploads.push({ count: users.size, pages }),
		timeoutMs: 1_000,
		stableMs: 0,
		pollMs: 1,
	});
	await sync();
	await sync();
	assert.deepEqual(uploads, [
		{ count: 2, pages: 2 },
		{ count: 2, pages: 2 },
	]);
	assert.equal(f.state.starts, 2);
	assert.equal(f.actions.filter((a) => a === "restart-full").length, 1);
	assert.equal(f.actions.filter((a) => a === "next-page").length, 2);
	assert.equal(f.actions.filter((a) => a === "dismiss-announcement").length, 2);
	assert.ok(
		f.actions.indexOf("dismiss-announcement") <
			f.actions.indexOf("close-sheet"),
	);
	assert.ok(f.actions.indexOf("close-sheet") < f.actions.indexOf("next-page"));
});

test("only the named announcement can expose the initial workflow and be closed", async () => {
	const f = fixture({ announcementInitially: true });
	assert.equal((await inspectFollowingSyncControls(f.page)).syncEnabled, true);
	await f.run();
	assert.equal(f.actions[0], "dismiss-announcement");
	assert.equal(f.actions[1], "open-following-sheet");
});

test("an unknown blocking modal is left untouched and cannot cause a cached upload", async () => {
	const f = fixture({ unknownModal: true });
	f.state.sheet = true;
	await assert.rejects(
		refreshFollowingSync(f.page, { ...SETTINGS, timeoutMs: 25 }),
		{ code: "following_sync_timeout" },
	);
	assert.equal(f.state.unknownModal, true);
	assert.equal(f.state.sheet, true);
	assert.deepEqual(f.actions, []);
});

test("refresh timeout never uploads cached rows", async () => {
	const f = fixture({ cached: true, autoComplete: false });
	let uploaded = false;
	const sync = createFollowingSynchronizer({
		context: { pages: () => [f.page] },
		inspectPage: async () => ({
			rows: 1,
			count: 1,
			signature: "cached",
			syncVisible: true,
			syncEnabled: true,
		}),
		refreshSync: (page) =>
			refreshFollowingSync(page, { ...SETTINGS, timeoutMs: 25 }),
		scrapePage: async () => [{ username: "cached" }],
		uploadSnapshot: async () => {
			uploaded = true;
		},
		timeoutMs: 1_000,
		stableMs: 0,
		pollMs: 1,
	});
	await assert.rejects(sync(), { code: "following_sync_timeout" });
	assert.equal(uploaded, false);
	assert.equal(f.actions.includes("close-sheet"), false);
});
