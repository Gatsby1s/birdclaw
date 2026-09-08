import {
	FollowingSyncError,
	isFollowingPageUrl,
} from "./following-runtime.mjs";

function findScroller() {
	const anchors = [
		...document.querySelectorAll('a[href*="export-twitter-posts"]'),
	];
	const anchor = anchors[0];
	if (!anchor) return null;
	for (let node = anchor.parentElement; node; node = node.parentElement) {
		if (
			anchors.every((rowAnchor) => node.contains(rowAnchor)) &&
			/auto|scroll|overlay/.test(getComputedStyle(node).overflowY) &&
			node.clientHeight > 0
		) {
			return node;
		}
	}
	return (
		anchor.closest('[role="grid"],[role="table"],table') ||
		document.scrollingElement
	);
}

function readWindow(root) {
	if (!root?.isConnected || root.clientHeight <= 0) return null;
	const bounds = root.getBoundingClientRect();
	const records = [];
	const positions = [];
	for (const anchor of root.querySelectorAll(
		'a[href*="export-twitter-posts"]',
	)) {
		const id = new URL(
			anchor.getAttribute("href") || "",
			location.href,
		).searchParams.get("publicUid");
		const container =
			anchor.closest('[role="row"],tr') ||
			anchor.closest('[role="button"],button') ||
			anchor.parentElement?.parentElement;
		const profileLink = container?.querySelector('a[href^="https://x.com/"]');
		if (!id || !/^\d+$/.test(id) || !profileLink) continue;
		const username = new URL(
			profileLink.getAttribute("href"),
			location.href,
		).pathname
			.split("/")[1]
			?.replace(/^@/, "");
		if (!username || !/^[a-zA-Z0-9_]{1,15}$/.test(username)) continue;
		const text = (profileLink.textContent || username).trim();
		const name = text
			.replace(new RegExp(`\\s*@${username}\\s*$`, "i"), "")
			.trim();
		const image = anchor.querySelector("img");
		records.push({
			id,
			username,
			name: name || username,
			...(image?.src ? { profileImageUrl: image.src } : {}),
		});
		const rect = container.getBoundingClientRect();
		if (rect.height > 0)
			positions.push({
				top: rect.top - bounds.top + root.scrollTop,
				bottom: rect.bottom - bounds.top + root.scrollTop,
				height: rect.height,
			});
	}
	const top = root.scrollTop;
	const height = root.clientHeight;
	const max = Math.max(0, root.scrollHeight - height);
	const rowHeight = Math.min(
		height,
		...positions.map((position) => position.height),
	);
	// A user cell can be a 20px inner box inside a padded 60px virtual row.
	const slack = Math.max(64, rowHeight * 2);
	// A recycled render window must cover the viewport before we move again.
	// This also detects a scroll position that changed while rendering stalled.
	const covered =
		records.length > 0 &&
		(max <= 1 ||
			(positions.length > 0 &&
				Math.min(...positions.map((position) => position.top)) <= top + slack &&
				Math.max(...positions.map((position) => position.bottom)) >=
					Math.min(root.scrollHeight, top + height) - slack));
	return {
		records,
		top,
		height,
		max,
		covered,
		signature: records.map((record) => record.id).join(","),
	};
}

/** Walk one pagination page's virtual render windows; never click or paginate.
 * The synchronizer still validates the final unique roster against its total.
 */
export async function scrapeFollowingPage(
	page,
	{
		timeoutMs = 15_000,
		maxWindows = 200,
		pollMs = 40,
		settleMs = 120,
		log = () => {},
	} = {},
) {
	if (!isFollowingPageUrl(page.url()))
		throw new FollowingSyncError("following_not_ready");
	if (
		!Number.isFinite(timeoutMs) ||
		timeoutMs <= 0 ||
		!Number.isInteger(maxWindows) ||
		maxWindows < 1 ||
		pollMs <= 0 ||
		settleMs < 0
	)
		throw new FollowingSyncError("following_timeout");
	let expired = false;
	let finished = false;
	let root;
	let rejectDeadline;
	const cancelled = new Promise((_, reject) => {
		rejectDeadline = reject;
	});
	void cancelled.catch(() => {});
	const timer = setTimeout(() => {
		expired = true;
		rejectDeadline(new FollowingSyncError("following_timeout"));
	}, timeoutMs);
	const guard = () => {
		if (expired || page.isClosed())
			throw new FollowingSyncError("following_timeout");
	};
	const within = async (operation) => {
		guard();
		return Promise.race([operation, cancelled]);
	};
	const pause = async () => {
		let delay;
		try {
			await within(
				new Promise((resolve) => {
					delay = setTimeout(resolve, pollMs);
				}),
			);
		} finally {
			clearTimeout(delay);
		}
	};
	const dispose = (handle) => {
		try {
			void handle?.dispose().catch(() => {});
		} catch {}
	};
	try {
		const acquiring = page.evaluateHandle(findScroller);
		void acquiring.then(
			(handle) => {
				if (expired || finished) dispose(handle);
			},
			() => {},
		);
		root = await within(acquiring);
		const initial = await within(root.evaluate(readWindow));
		if (!initial) throw new FollowingSyncError("following_not_ready");
		if (initial.max <= 1) {
			const records = [
				...new Map(
					initial.records.map((record) => [record.id, record]),
				).values(),
			];
			try {
				log("following_page_scanned", {
					recordsCount: records.length,
					windows: 1,
				});
			} catch {}
			return records;
		}
		const scroll = async (top) => {
			guard();
			await within(
				root.evaluate((node, target) => {
					if (!node?.isConnected) throw Error("missing scroller");
					node.scrollTo({ top: target, behavior: "instant" });
				}, top),
			);
		};
		const settle = async (target) => {
			let lastKey = null;
			let stableSince = 0;
			while (true) {
				const state = await within(root.evaluate(readWindow));
				if (!state) throw new FollowingSyncError("following_not_ready");
				const key = JSON.stringify([state.top, state.max, state.signature]);
				if (
					!state.covered ||
					Math.abs(state.top - Math.min(target, state.max)) > 1
				) {
					lastKey = null;
				} else {
					if (lastKey !== key) {
						lastKey = key;
						stableSince = performance.now();
					}
					if (performance.now() - stableSince >= settleMs) return state;
				}
				await pause();
			}
		};
		const records = new Map();
		await scroll(0);
		let state = await settle(0);
		let windows = 0;
		while (true) {
			guard();
			for (const record of state.records) records.set(record.id, record);
			windows += 1;
			if (state.max - state.top <= 1) break;
			if (windows >= maxWindows)
				throw new FollowingSyncError("following_pagination_stalled");
			const target = Math.min(
				state.max,
				state.top + Math.max(1, Math.floor(state.height / 2)),
			);
			await scroll(target);
			const next = await settle(target);
			if (next.top <= state.top && next.max - next.top > 1)
				throw new FollowingSyncError("following_pagination_stalled");
			state = next;
		}
		// Keep the first-window signature and the next-page transition predictable.
		await scroll(0);
		await settle(0);
		guard();
		try {
			log("following_page_scanned", { recordsCount: records.size, windows });
		} catch {}
		return [...records.values()];
	} catch (error) {
		if (error instanceof FollowingSyncError) throw error;
		throw new FollowingSyncError("following_not_ready");
	} finally {
		finished = true;
		clearTimeout(timer);
		dispose(root);
	}
}
