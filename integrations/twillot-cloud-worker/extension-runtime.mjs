const POLL_MS = 50;

function runtimeError(code) {
	return Object.assign(new Error(code), { code });
}

function inspectRuntime() {
	const revision = Object.getOwnPropertyDescriptor(
		globalThis,
		"__BIRDCLAW_TWILLOT_REVISION__",
	);
	const api = globalThis.__BIRDCLAW_TWILLOT_CLOUD__;
	return {
		revision: typeof revision?.value === "string" ? revision.value : null,
		immutable: revision?.writable === false && revision?.configurable === false,
		apiReady:
			typeof api?.getState === "function" && typeof api?.syncNow === "function",
	};
}

// Verify executed code, not files on disk or values stored in the profile.
// This helper never pairs, syncs, or changes extension storage.
export async function ensureExtensionRuntime(
	context,
	{ extensionId, expectedRevision, timeoutMs = 30_000, log = () => {} },
) {
	if (
		!/^[a-p]{32}$/.test(extensionId ?? "") ||
		typeof expectedRevision !== "string" ||
		!expectedRevision.trim() ||
		!Number.isFinite(timeoutMs) ||
		timeoutMs <= 0
	) {
		throw runtimeError("extension_runtime_invalid_config");
	}
	const optionsUrl = `chrome-extension://${extensionId}/birdclaw-twillot-options.html`;
	const startedAt = performance.now();
	const remaining = () =>
		Math.max(1, timeoutMs - (performance.now() - startedAt));
	const initialGraceMs = Math.min(1_000, timeoutMs / 4);
	const ownedPages = new Set();
	const workers = new Set();
	let beforeReload = null;
	let page = null;
	let pageReady = false;
	let returnedPage = null;
	let finished = false;
	let failure = null;
	let rejectAbort;
	const aborted = new Promise((_, reject) => {
		rejectAbort = reject;
	});
	// All browser calls race this deadline, including calls without native timeouts.
	void aborted.catch(() => {});
	const abort = (code) => {
		failure ??= runtimeError(code);
		rejectAbort(failure);
	};
	const timer = setTimeout(() => abort("extension_runtime_timeout"), timeoutMs);
	const onClosed = () => abort("extension_runtime_closed");
	const onWorker = (worker) => workers.add(worker);
	const check = () => {
		if (failure) throw failure;
	};
	const within = (operation) => Promise.race([operation, aborted]);
	const pause = async () => {
		let delay;
		try {
			await within(
				new Promise((resolve) => {
					delay = setTimeout(resolve, Math.min(POLL_MS, remaining()));
				}),
			);
		} finally {
			clearTimeout(delay);
		}
	};
	const emit = (event, detail) => {
		try {
			log(event, detail);
		} catch {}
	};
	const closePage = (owned) => {
		// Cleanup must not defeat the startup deadline if the browser is stuck.
		try {
			return Promise.resolve(owned.close()).catch(() => {});
		} catch {
			return Promise.resolve();
		}
	};
	const scoped = (worker) => {
		try {
			const url = new URL(worker.url());
			return (
				url.protocol === "chrome-extension:" && url.hostname === extensionId
			);
		} catch {
			return false;
		}
	};
	const newOwnedPage = async () => {
		check();
		const creating = context.newPage();
		// A newPage call can complete after timeout or context shutdown.
		void creating.then(
			(created) => {
				ownedPages.add(created);
				if (finished || failure) void closePage(created);
			},
			() => {},
		);
		return within(creating);
	};
	const prepareReload = async () => {
		// This context belongs to the dedicated cloud automation profile. Modern
		// Chromium disables unpacked extensions on reload without developer mode.
		const settings = await newOwnedPage();
		try {
			await within(
				settings.goto("chrome://extensions", {
					waitUntil: "domcontentloaded",
					timeout: Math.min(5_000, remaining()),
				}),
			);
			const configured = await within(
				settings.evaluate(async () => {
					const api = chrome.developerPrivate;
					const before = await api.getProfileConfiguration();
					if (before.inDeveloperMode === true) return true;
					await api.updateProfileConfiguration({ inDeveloperMode: true });
					return (await api.getProfileConfiguration()).inDeveloperMode === true;
				}),
			);
			if (!configured) throw runtimeError("extension_runtime_failed");
		} finally {
			void closePage(settings);
		}
	};
	const openOptions = async () => {
		check();
		if (!page || page.isClosed()) {
			page = await newOwnedPage();
			pageReady = false;
		}
		if (!pageReady || page.url() !== optionsUrl) {
			try {
				await within(
					page.goto(optionsUrl, {
						waitUntil: "domcontentloaded",
						timeout: Math.min(5_000, remaining()),
					}),
				);
				await within(
					page.evaluate(() => {
						chrome.runtime.sendMessage(
							{ type: "getCapabilities", messageId: "birdclaw-runtime-check" },
							() => {
								void chrome.runtime.lastError;
							},
						);
					}),
				);
				pageReady = true;
			} catch {
				check();
				pageReady = false;
				// Reload briefly removes the extension and may close its options page.
				return false;
			}
		}
		return !page.isClosed();
	};
	try {
		// Register before opening options AND before reload, which can start a
		// replacement worker before the evaluate promise settles.
		context.on("serviceworker", onWorker);
		context.on("close", onClosed);
		while (true) {
			check();
			if (!(await openOptions())) {
				await pause();
				continue;
			}
			for (const worker of context.serviceWorkers()) workers.add(worker);
			let stale = null;
			let initializedMismatch = false;
			for (const worker of [...workers].reverse()) {
				if (!scoped(worker)) continue;
				let state;
				try {
					state = await within(worker.evaluate(inspectRuntime));
				} catch {
					check();
					continue;
				}
				if (state?.revision === expectedRevision && state.immutable) {
					if (state.apiReady && !page.isClosed()) {
						returnedPage = page;
						emit("extension_runtime_verified", {
							reloaded: beforeReload !== null,
						});
						return { page, serviceWorker: worker };
					}
					continue;
				}
				if (beforeReload) {
					initializedMismatch ||=
						!beforeReload.has(worker) &&
						state?.revision != null &&
						state.apiReady;
				} else if (
					state?.revision != null ||
					state?.apiReady ||
					performance.now() - startedAt >= initialGraceMs
				) {
					stale = worker;
				}
			}
			if (initializedMismatch) throw runtimeError("extension_runtime_mismatch");
			if (stale) {
				await prepareReload();
				check();
				beforeReload = new Set([...workers, ...context.serviceWorkers()]);
				emit("extension_runtime_reload", { reason: "revision_mismatch" });
				// Reload can destroy the evaluator or reuse a Playwright handle.
				// Only executed immutable revision establishes success.
				void Promise.resolve()
					.then(() => {
						check();
						return stale.evaluate(() => chrome.runtime.reload());
					})
					.catch(() => {});
				void closePage(page);
				page = null;
			}
			await pause();
		}
	} catch (error) {
		const safe =
			failure ??
			runtimeError(
				error?.code === "extension_runtime_mismatch"
					? error.code
					: "extension_runtime_failed",
			);
		emit("extension_runtime_failed", { code: safe.code });
		throw safe;
	} finally {
		finished = true;
		clearTimeout(timer);
		context.removeListener("serviceworker", onWorker);
		context.removeListener("close", onClosed);
		for (const owned of ownedPages) {
			if (owned !== returnedPage) void closePage(owned);
		}
	}
}
