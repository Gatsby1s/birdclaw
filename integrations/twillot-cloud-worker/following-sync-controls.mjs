const TITLE = "AI-Powered Analysis of Your Following Network";
const TOOLBAR_NAME =
	/Sync Twitter following to your local browser|Sync Following/i;
const announcement = (page) =>
	page.getByRole("dialog", {
		name: "New: More control over your X data",
		exact: true,
	});

export class FollowingSyncControlsError extends Error {
	constructor(code) {
		super(code);
		this.code = code;
	}
}

function followingSheet(page) {
	return page.getByRole("dialog", { includeHidden: true }).filter({
		has: page.getByRole("heading", {
			name: TITLE,
			exact: true,
			includeHidden: true,
		}),
	});
}
const button = (root, name) => root.getByRole("button", { name, exact: true });

export async function inspectFollowingSyncControls(page) {
	const sheet = followingSheet(page);
	const sheetVisible = await sheet.isVisible();
	const toolbar = page.getByRole("button", { name: TOOLBAR_NAME }).first();
	const toolbarVisible = await toolbar.isVisible();
	const announcementVisible = await announcement(page).isVisible();
	return {
		sheetVisible,
		syncVisible: sheetVisible || toolbarVisible || announcementVisible,
		// The refresh helper handles an existing busy sheet without cancelling it.
		syncEnabled:
			announcementVisible ||
			sheetVisible ||
			(toolbarVisible && (await toolbar.isEnabled())),
	};
}

async function inspectSheet(sheet) {
	const evidence = await sheet.evaluate((root) => {
		const prefix = "Last full sync time:";
		const normalized = (node) =>
			(node.innerText || "").replace(/\s+/g, " ").trim();
		const markers = [...root.querySelectorAll("p,span,div")].filter((node) => {
			const text = normalized(node);
			return text.startsWith(prefix) && /\d/.test(text.slice(prefix.length));
		});
		// Select the innermost footer so other changing progress text cannot
		// masquerade as a changed full-sync timestamp.
		const marker = markers.find(
			(node) =>
				!markers.some((other) => other !== node && node.contains(other)),
		);
		const errorText = [
			...root.querySelectorAll(
				'[role="alert"],[data-state="error"],[data-status="error"]',
			),
		]
			.filter((node) => node.getBoundingClientRect().width > 0)
			.map(normalized)
			.join(" ");
		const errorCode = !errorText
			? null
			: /rate.?limit|too many requests|\b429\b/i.test(errorText)
				? "following_sync_rate_limited"
				: /upgrade|quota|subscription|plan limit|payment/i.test(errorText)
					? "following_sync_upgrade_required"
					: "following_sync_failed";
		return { marker: marker ? normalized(marker) : null, errorCode };
	});
	const busy = await button(sheet, "Syncing").isVisible();
	const enabled = async (name) => {
		const target = button(sheet, name);
		return (await target.isVisible()) && (await target.isEnabled());
	};
	const first = await enabled("Start First Sync");
	const latest = await enabled("Sync Latest Data");
	const incomplete = await enabled("Continue Incomplete Sync");
	return {
		...evidence,
		busy,
		first,
		latest,
		incomplete,
		idle: first || latest || incomplete,
	};
}

/** Read-only Following cache refresh through its public UI; no X mutations.
 * The caller's existing 180-second deadline remains authoritative.
 */
export async function refreshFollowingSync(
	page,
	{
		timeoutMs = 120_000,
		pollMs = 250,
		stableMs = 1_000,
		check = () => {},
		log = () => {},
	} = {},
) {
	if (
		!Number.isFinite(timeoutMs) ||
		timeoutMs <= 0 ||
		pollMs <= 0 ||
		stableMs < 0
	)
		throw new FollowingSyncControlsError("following_sync_timeout");
	const deadline = performance.now() + timeoutMs;
	let expired = false;
	let rejectDeadline;
	const cancelled = new Promise((_, reject) => {
		rejectDeadline = reject;
	});
	void cancelled.catch(() => {});
	const timer = setTimeout(() => {
		expired = true;
		rejectDeadline(new FollowingSyncControlsError("following_sync_timeout"));
	}, timeoutMs);
	const guard = () => {
		check();
		if (expired || performance.now() >= deadline)
			throw new FollowingSyncControlsError("following_sync_timeout");
	};
	const within = async (operation) => {
		guard();
		return Promise.race([operation, cancelled]);
	};
	const actionTimeout = () =>
		Math.max(1, Math.min(10_000, deadline - performance.now()));
	const click = async (target) => {
		guard();
		await within(target.click({ timeout: actionTimeout() }));
		guard();
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
	const emit = (event) => {
		try {
			log(event);
		} catch {}
	};
	const dismissAnnouncement = async () => {
		guard();
		const info = announcement(page);
		if (await within(info.isVisible())) {
			await click(button(info, "Close"));
			await within(info.waitFor({ state: "hidden", timeout: actionTimeout() }));
		}
	};
	try {
		await dismissAnnouncement();
		const sheet = followingSheet(page);
		if (!(await within(sheet.isVisible()))) {
			await click(page.getByRole("button", { name: TOOLBAR_NAME }).first());
		}
		await within(sheet.waitFor({ state: "visible", timeout: actionTimeout() }));
		emit("following_sync_sheet_opened");
		const read = async () => {
			guard();
			await dismissAnnouncement();
			const state = await within(inspectSheet(sheet));
			if (state.errorCode)
				throw new FollowingSyncControlsError(state.errorCode);
			return state;
		};
		let before;
		while (true) {
			before = await read();
			if (!before.busy && before.idle) break;
			await pause();
		}
		if (before.first) {
			await click(button(sheet, "Start First Sync"));
		} else {
			// This is the dropdown belonging to this exact Following sheet.
			const dropdown = sheet.locator('[aria-haspopup="menu"]');
			await click(dropdown);
			const menuId = await within(dropdown.getAttribute("aria-controls"));
			if (!menuId)
				throw new FollowingSyncControlsError("following_sync_failed");
			const menu = page
				.locator(`[id=${JSON.stringify(menuId)}]`)
				.getByRole("menuitem", { name: "Restart Full Sync", exact: true });
			await click(menu);
			const confirm = page.getByRole("dialog", {
				name: "Confirm Full Sync",
				exact: true,
			});
			await within(
				confirm.waitFor({ state: "visible", timeout: actionTimeout() }),
			);
			await click(button(confirm, "Confirm"));
		}
		emit("following_full_sync_started");
		let stableSince = null;
		let stableMarker = null;
		while (true) {
			const state = await read();
			// A stale idle button, a populated table, or a minute-rounded timestamp
			// that did not change cannot prove this refresh completed.
			if (
				state.marker &&
				state.marker !== before.marker &&
				!state.busy &&
				state.idle &&
				!state.incomplete
			) {
				if (stableMarker !== state.marker) {
					stableMarker = state.marker;
					stableSince = performance.now();
				}
				if (performance.now() - stableSince >= stableMs) break;
			} else {
				stableSince = null;
				stableMarker = null;
			}
			await pause();
		}
		// Never close during a running/failed sync. A hidden sheet can conceal
		// Next page from accessibility queries, so the caller must inspect again.
		emit("following_full_sync_completed");
		await dismissAnnouncement();
		if (await within(sheet.isVisible())) await click(button(sheet, "Close"));
		await within(sheet.waitFor({ state: "hidden", timeout: actionTimeout() }));
		await dismissAnnouncement();
		emit("following_sync_sheet_closed");
	} catch (error) {
		if (
			error instanceof FollowingSyncControlsError ||
			error?.code === "following_timeout"
		)
			throw error;
		throw new FollowingSyncControlsError("following_sync_failed");
	} finally {
		clearTimeout(timer);
	}
}
