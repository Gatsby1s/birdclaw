const FOLLOWING_URL = "https://www.twillot.com/en/twitter-following";
const SYNC_NAME =
	/Sync Twitter following to your local browser|Sync Following/i;

export class FollowingSyncError extends Error {
	constructor(code) {
		super(code);
		this.code = code;
	}
}

export function isFollowingPageUrl(value) {
	try {
		const url = new URL(value);
		return (
			["www.twillot.com", "twillot.com"].includes(url.hostname) &&
			/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?twitter-following\/?$/i.test(
				url.pathname,
			)
		);
	} catch {
		return false;
	}
}

// Only fixed diagnostic codes may reach logs; provider errors can contain secrets.
export function safeWorkerError(error) {
	const allowed = new Set([
		"following_timeout",
		"following_not_ready",
		"following_login_required",
		"following_extension_missing",
		"following_incomplete",
		"following_pagination_stalled",
		"following_page_limit",
	]);
	return error instanceof FollowingSyncError && allowed.has(error.code)
		? error.code
		: "worker_operation_failed";
}

export async function inspectFollowingPage(page) {
	const summary = await page.evaluate(() => {
		const links = [
			...document.querySelectorAll('a[href*="export-twitter-posts"]'),
		];
		const ids = links.flatMap((link) => {
			try {
				const id = new URL(
					link.getAttribute("href"),
					location.href,
				).searchParams.get("publicUid");
				return id ? [id] : [];
			} catch {
				return [];
			}
		});
		const labels = [
			...document.querySelectorAll('a,button,[role="link"],[role="tab"]'),
		];
		const counts = labels.flatMap((node) => {
			const match = (node.textContent || "")
				.trim()
				.match(/^Following\s*\(?\s*([\d,\s]+)\s*\)?$/i);
			if (!match) return [];
			const count = Number(match[1].replace(/[\s,]/g, ""));
			return Number.isSafeInteger(count) && count >= 0 ? [count] : [];
		});
		return {
			rows: ids.length,
			count: counts[0] ?? null,
			followingLabel: counts.length ? `Following ${counts[0]}` : null,
			signature: ids.join(","),
		};
	});
	const sync = page.getByRole("button", { name: SYNC_NAME }).first();
	const connect = page
		.getByRole("button", { name: /Connect Twitter Now/i })
		.first();
	const next = page.getByRole("button", { name: "Next page", exact: true });
	const syncVisible = await sync.isVisible();
	const nextVisible = await next.isVisible();
	return {
		...summary,
		extensionMissing: await page
			.getByText("Extension not installed", { exact: false })
			.first()
			.isVisible(),
		needsLogin: await connect.isVisible(),
		syncVisible,
		syncEnabled: syncVisible && (await sync.isEnabled()),
		nextVisible,
		nextEnabled: nextVisible && (await next.isEnabled()),
	};
}

export function createFollowingSynchronizer({
	context,
	scrapePage,
	uploadSnapshot,
	log = () => {},
	inspectPage = inspectFollowingPage,
	timeoutMs = 120_000,
	readinessMs = 30_000,
	pollMs = 500,
	stableMs = 2_000,
}) {
	let ownedPage = null;
	let running = null;
	async function synchronize() {
		let expired = false;
		let page = null;
		let timer;
		let diagnostic = () => {};
		const check = () => {
			if (expired) throw new FollowingSyncError("following_timeout");
		};
		const operation = async () => {
			const candidates = context
				.pages()
				.filter(
					(candidate) =>
						!candidate.isClosed() && isFollowingPageUrl(candidate.url()),
				);
			page =
				ownedPage && !ownedPage.isClosed()
					? ownedPage
					: (candidates[0] ?? (await context.newPage()));
			if (expired) {
				await page.close().catch(() => {});
				check();
			}
			ownedPage = page;
			page.setDefaultTimeout(10_000);
			page.setDefaultNavigationTimeout(30_000);
			// Reclaim pages leaked by earlier cycles; never close export/job pages.
			for (const extra of candidates) {
				if (extra !== page) await extra.close();
				check();
			}
			let lastState = null;
			let diagnosticPageCount = 0;
			diagnostic = () => {
				let pathname = null;
				try {
					pathname = new URL(page.url()).pathname;
				} catch {}
				log("following_page_state", {
					pathname,
					extensionMissing: Boolean(lastState?.extensionMissing),
					loginRequired: Boolean(lastState?.needsLogin),
					followingLabel: lastState?.followingLabel ?? null,
					syncVisible: Boolean(lastState?.syncVisible),
					recordsCount: lastState?.rows ?? 0,
					pageCount: diagnosticPageCount,
				});
			};
			const waitReady = async (
				previousSignature = null,
				allowSyncAction = false,
			) => {
				const until = Date.now() + readinessMs;
				let lastKey = null;
				let stableSince = Date.now();
				let state;
				while (Date.now() < until) {
					check();
					state = await inspectPage(page);
					lastState = state;
					check();
					if (state.needsLogin) {
						diagnostic();
						throw new FollowingSyncError("following_login_required");
					}
					const key = JSON.stringify([
						state.signature,
						state.count,
						state.syncEnabled,
						state.nextEnabled,
					]);
					if (key !== lastKey) {
						lastKey = key;
						stableSince = Date.now();
					}
					if (
						!state.extensionMissing &&
						state.rows > 0 &&
						state.count !== null &&
						(!state.syncVisible || state.syncEnabled) &&
						(previousSignature === null ||
							state.signature !== previousSignature) &&
						Date.now() - stableSince >= stableMs
					)
						return state;
					// An empty cache must be allowed to expose its first Sync action.
					if (
						allowSyncAction &&
						!state.extensionMissing &&
						state.syncVisible &&
						state.syncEnabled &&
						Date.now() - stableSince >= stableMs
					)
						return state;
					await new Promise((resolve) => setTimeout(resolve, pollMs));
				}
				diagnostic();
				throw new FollowingSyncError(
					state?.extensionMissing
						? "following_extension_missing"
						: previousSignature === null
							? "following_not_ready"
							: "following_pagination_stalled",
				);
			};
			await page.goto(FOLLOWING_URL, {
				waitUntil: "domcontentloaded",
				timeout: 30_000,
			});
			check();
			let state = await waitReady(null, true);
			if (state.syncVisible && state.syncEnabled) {
				await page.getByRole("button", { name: SYNC_NAME }).first().click();
				state = await waitReady();
			}
			const first = page.getByRole("button", {
				name: "Go to first page",
				exact: true,
			});
			if ((await first.isVisible()) && (await first.isEnabled())) {
				await first.click();
				state = await waitReady(state.signature);
			}
			const users = new Map();
			const seenPages = new Set();
			let pageCount = 0;
			for (; pageCount < 1_000; ) {
				check();
				if (seenPages.has(state.signature))
					throw new FollowingSyncError("following_pagination_stalled");
				seenPages.add(state.signature);
				for (const user of await scrapePage(page))
					users.set(user.username.toLowerCase(), user);
				pageCount += 1;
				diagnosticPageCount = pageCount;
				if (!state.nextVisible || !state.nextEnabled) break;
				await page
					.getByRole("button", { name: "Next page", exact: true })
					.click();
				state = await waitReady(state.signature);
			}
			check();
			diagnostic();
			log("following_snapshot_checked", {
				count: users.size,
				expectedCount: state.count,
				pageCount,
			});
			if (pageCount >= 1_000 && state.nextEnabled)
				throw new FollowingSyncError("following_page_limit");
			if (!users.size || state.count === null || users.size !== state.count)
				throw new FollowingSyncError("following_incomplete");
			return await uploadSnapshot(users, pageCount);
		};
		try {
			return await Promise.race([
				operation(),
				new Promise((_, reject) => {
					timer = setTimeout(() => {
						expired = true;
						if (ownedPage === page) ownedPage = null;
						void page?.close().catch(() => {});
						reject(new FollowingSyncError("following_timeout"));
					}, timeoutMs);
				}),
			]);
		} catch (error) {
			diagnostic();
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}
	return () => {
		if (!running)
			running = synchronize().finally(() => {
				running = null;
			});
		return running;
	};
}
