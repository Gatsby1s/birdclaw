(() => {
	"use strict";

	const ENDPOINT = "http://127.0.0.1:3001/api/integrations/xremark/snapshot";
	const DATABASE_NAME = "xRemark";
	const STORE_NAMES = ["remarks", "tags", "categories"];
	const RETRY_ALARM = "birdclaw-xremark-retry";
	const HEARTBEAT_ALARM = "birdclaw-xremark-heartbeat";
	const HEARTBEAT_MINUTES = 5;
	const DEBOUNCE_MS = 800;
	const STORAGE = {
		settings: "birdclawXRemarkSettings",
		identity: "birdclawXRemarkIdentity",
		pending: "birdclawXRemarkPendingMutation",
		outbox: "birdclawXRemarkOutbox",
		status: "birdclawXRemarkStatus",
	};
	const CONTROL = {
		getState: "birdclaw:xremark:get-state",
		setToken: "birdclaw:xremark:set-token",
		syncNow: "birdclaw:xremark:sync-now",
	};
	const DATABASE_MUTATED = "birdclaw:xremark:database-mutated";
	const MUTATION_TYPES = new Set([
		"XR-UPSERT-REMARK",
		"XR-UPDATE-REMARK",
		"XR-SIDEPANEL-UPSERTREMARK",
		"XR-AUTO-UPDATE-REAMRK-USER-INFO",
		"XR-DELETE-REMARK",
		"XR-SIDEPANEL-DELETEREMARK",
		"XR-ADD-TAG",
		"XR-SIDEPANEL-ADD-TAG",
		"XR-SIDEPANEL-UPDATE-TAG",
		"XR-UPDATE-TAG",
		"XR-DELETE-TAG",
		"XR-SIDEPANEL-DELETETAG",
		"XR-ADD-CATEGORY",
		"XR-SIDEPANEL-ADD-CATEGORY",
		"XR-SIDEPANEL-UPDATE-CATEGORY",
		"XR-UPDATE-CATEGORY",
		"XR-DELETE-CATEGORY",
		"XR-SIDEPANEL-DELETECATEGORY",
		"XR-INIT-CATEGORIES",
	]);

	const DEFAULT_STATUS = {
		state: "idle",
		pending: false,
		lastAttemptAt: null,
		lastSuccessAt: null,
		lastError: null,
	};

	let debounceTimer = null;
	let stateQueue = Promise.resolve();
	let activeFlush = null;
	let activePendingDrain = null;

	class BridgeError extends Error {}

	function serializeState(work) {
		const result = stateQueue.then(work, work);
		stateQueue = result.catch(() => {});
		return result;
	}

	async function getStored(key) {
		const result = await chrome.storage.local.get(key);
		return result[key];
	}

	async function setStored(key, value) {
		await chrome.storage.local.set({ [key]: value });
	}

	async function mergeStatus(patch) {
		const current = await getStored(STORAGE.status);
		const next = {
			...DEFAULT_STATUS,
			...(current && typeof current === "object" ? current : {}),
			...patch,
		};
		await setStored(STORAGE.status, next);
		return next;
	}

	function controlledError(error) {
		if (error instanceof BridgeError) return error.message;
		if (error instanceof TypeError) return "BirdClaw is unreachable.";
		return "The bridge could not complete the local sync.";
	}

	function isValidIdentity(value) {
		return Boolean(
			value &&
			typeof value === "object" &&
			typeof value.sourceId === "string" &&
			value.sourceId.length >= 16 &&
			Number.isSafeInteger(value.sequence) &&
			value.sequence >= 0,
		);
	}

	async function ensureIdentity() {
		const stored = await getStored(STORAGE.identity);
		if (isValidIdentity(stored)) return stored;
		const identity = { sourceId: crypto.randomUUID(), sequence: 0 };
		await setStored(STORAGE.identity, identity);
		return identity;
	}

	async function nextIdentity({ increment }) {
		const identity = await ensureIdentity();
		const nextSequence = increment
			? Math.max(1, identity.sequence + 1)
			: Math.max(1, identity.sequence);
		if (nextSequence === identity.sequence) return identity;
		const next = { sourceId: identity.sourceId, sequence: nextSequence };
		await setStored(STORAGE.identity, next);
		return next;
	}

	function requestAsPromise(request, message) {
		return new Promise((resolve, reject) => {
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(new BridgeError(message));
		});
	}

	async function openDatabaseReadOnly() {
		if (typeof indexedDB.databases === "function") {
			let databases;
			try {
				databases = await indexedDB.databases();
			} catch {
				throw new BridgeError("X Remark storage is not available yet.");
			}
			if (!databases.some((database) => database?.name === DATABASE_NAME)) {
				throw new BridgeError("X Remark storage is not available yet.");
			}
		}

		let request;
		try {
			request = indexedDB.open(DATABASE_NAME);
		} catch {
			throw new BridgeError("X Remark storage could not be opened.");
		}
		return new Promise((resolve, reject) => {
			let settled = false;
			const rejectMissing = () => {
				if (settled) return;
				settled = true;
				reject(new BridgeError("X Remark storage is not available yet."));
			};
			request.onupgradeneeded = () => {
				try {
					request.transaction?.abort();
				} catch {
					// Rejecting the open is sufficient if the browser has already aborted it.
				}
				rejectMissing();
			};
			request.onsuccess = () => {
				if (settled) {
					request.result?.close();
					return;
				}
				settled = true;
				resolve(request.result);
			};
			request.onerror = rejectMissing;
			request.onblocked = rejectMissing;
		});
	}

	async function readFullSnapshot(identity) {
		const database = await openDatabaseReadOnly();
		try {
			for (const storeName of STORE_NAMES) {
				if (!database.objectStoreNames.contains(storeName)) {
					throw new BridgeError(
						"This X Remark version does not expose the expected local stores.",
					);
				}
			}

			const transaction = database.transaction(STORE_NAMES, "readonly");
			const completion = new Promise((resolve, reject) => {
				transaction.oncomplete = resolve;
				transaction.onerror = () =>
					reject(new BridgeError("X Remark storage could not be read."));
				transaction.onabort = () =>
					reject(new BridgeError("X Remark storage could not be read."));
			});
			const requests = STORE_NAMES.map((storeName) =>
				requestAsPromise(
					transaction.objectStore(storeName).getAll(),
					"X Remark storage could not be read.",
				),
			);
			const [remarks, tags, categories] = await Promise.all(requests);
			await completion;

			const capturedAt = Date.now();
			return {
				sourceId: identity.sourceId,
				sequence: identity.sequence,
				capturedAt,
				database: {
					name: DATABASE_NAME,
					version: database.version,
					backupID: `birdclaw:${identity.sourceId}:${identity.sequence}`,
					backupTime: capturedAt,
				},
				remarks,
				tags,
				categories,
			};
		} finally {
			database.close();
		}
	}

	async function currentToken() {
		const settings = await getStored(STORAGE.settings);
		return typeof settings?.token === "string" && settings.token.trim() !== ""
			? settings.token.trim()
			: null;
	}

	async function scheduleRetry(attempts) {
		const exponent = Math.min(Math.max(0, attempts - 1), 6);
		const delayInMinutes = Math.min(60, 2 ** exponent);
		await chrome.alarms.create(RETRY_ALARM, { delayInMinutes });
	}

	async function ensureHeartbeatAlarm() {
		const existing = await chrome.alarms.get(HEARTBEAT_ALARM);
		if (existing?.periodInMinutes === HEARTBEAT_MINUTES) return;
		await chrome.alarms.create(HEARTBEAT_ALARM, {
			delayInMinutes: HEARTBEAT_MINUTES,
			periodInMinutes: HEARTBEAT_MINUTES,
		});
	}

	function isValidPendingMutation(value) {
		return Boolean(
			value &&
			typeof value === "object" &&
			Number.isSafeInteger(value.count) &&
			value.count > 0 &&
			Number.isFinite(value.dueAt) &&
			value.dueAt >= 0,
		);
	}

	function schedulePendingDrain(pending) {
		if (!isValidPendingMutation(pending)) return;
		if (debounceTimer !== null) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(
			() => {
				debounceTimer = null;
				void drainPendingMutations();
			},
			Math.max(0, pending.dueAt - Date.now()),
		);
	}

	async function pendingMutation() {
		const pending = await getStored(STORAGE.pending);
		return isValidPendingMutation(pending) ? pending : null;
	}

	async function performFlush() {
		while (true) {
			const pending = await pendingMutation();
			if (pending) {
				schedulePendingDrain(pending);
				return { ok: true, deferred: true };
			}
			const outbox = await getStored(STORAGE.outbox);
			if (!outbox?.id || !outbox?.payload) return { ok: true, empty: true };

			const token = await currentToken();
			if (!token) {
				await mergeStatus({
					state: "needs-pairing",
					pending: true,
					lastError: "A BirdClaw pairing token is required.",
				});
				return { ok: false, needsPairing: true };
			}

			const attemptAt = Date.now();
			await mergeStatus({
				state: "syncing",
				pending: true,
				lastAttemptAt: attemptAt,
				lastError: null,
			});

			try {
				const response = await fetch(ENDPOINT, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${token}`,
						"Content-Type": "application/json",
					},
					cache: "no-store",
					body: JSON.stringify(outbox.payload),
				});
				if (!response.ok) {
					throw new BridgeError(`BirdClaw returned HTTP ${response.status}.`);
				}

				const current = await getStored(STORAGE.outbox);
				if (current?.id === outbox.id) {
					await chrome.storage.local.remove(STORAGE.outbox);
				}
				await chrome.alarms.clear(RETRY_ALARM);
				await mergeStatus({
					state: "ready",
					pending: false,
					lastSuccessAt: Date.now(),
					lastError: null,
				});

				const newer = await getStored(STORAGE.outbox);
				if (!newer?.id) return { ok: true };
			} catch (error) {
				const attempts = Number.isSafeInteger(outbox.attempts)
					? outbox.attempts + 1
					: 1;
				const current = await getStored(STORAGE.outbox);
				if (current?.id === outbox.id) {
					await setStored(STORAGE.outbox, { ...outbox, attempts });
				}
				await scheduleRetry(attempts);
				const message = controlledError(error);
				await mergeStatus({
					state: "error",
					pending: true,
					lastError: message,
				});
				return { ok: false, error: message };
			}
		}
	}

	function flushOutbox() {
		if (activeFlush) return activeFlush;
		activeFlush = performFlush().finally(() => {
			activeFlush = null;
		});
		return activeFlush;
	}

	async function queueFullSnapshot({ increment }) {
		let queued;
		try {
			queued = await serializeState(async () => {
				const pending = await pendingMutation();
				if (pending) return { kind: "deferred", pending };
				const identity = await nextIdentity({ increment });
				const payload = await readFullSnapshot(identity);
				const outbox = {
					id: `${identity.sourceId}:${identity.sequence}:${payload.capturedAt}`,
					payload,
					attempts: 0,
					queuedAt: Date.now(),
				};
				await setStored(STORAGE.outbox, outbox);
				await mergeStatus({ state: "queued", pending: true, lastError: null });
				return { kind: "queued", outbox };
			});
		} catch (error) {
			const message = controlledError(error);
			const paired = Boolean(await currentToken());
			if (paired) await scheduleRetry(1);
			await mergeStatus({
				state: "error",
				pending: paired,
				lastError: message,
			});
			return { ok: false, error: message };
		}
		if (queued?.kind === "deferred") {
			schedulePendingDrain(queued.pending);
			return { ok: true, deferred: true };
		}
		if (queued?.kind !== "queued") {
			return { ok: false, error: "The bridge could not queue a snapshot." };
		}
		return flushOutbox();
	}

	async function performPendingDrain() {
		let drained;
		try {
			drained = await serializeState(async () => {
				const pending = await pendingMutation();
				if (!pending) return { kind: "empty" };
				if (pending.dueAt > Date.now()) return { kind: "deferred", pending };

				const identity = await ensureIdentity();
				const sequence = Math.min(
					Number.MAX_SAFE_INTEGER,
					Math.max(1, identity.sequence + pending.count),
				);
				const nextIdentityValue = { sourceId: identity.sourceId, sequence };
				const payload = await readFullSnapshot(nextIdentityValue);
				const outbox = {
					id: `${identity.sourceId}:${sequence}:${payload.capturedAt}`,
					payload,
					attempts: 0,
					queuedAt: Date.now(),
				};
				await chrome.storage.local.set({
					[STORAGE.identity]: nextIdentityValue,
					[STORAGE.outbox]: outbox,
				});
				await chrome.storage.local.remove(STORAGE.pending);
				await mergeStatus({ state: "queued", pending: true, lastError: null });
				return { kind: "queued" };
			});
		} catch (error) {
			const message = controlledError(error);
			const paired = Boolean(await currentToken());
			if (paired) await scheduleRetry(1);
			await mergeStatus({ state: "error", pending: true, lastError: message });
			return { ok: false, error: message };
		}

		if (drained.kind === "deferred") {
			schedulePendingDrain(drained.pending);
			return { ok: true, deferred: true };
		}
		if (drained.kind === "empty") {
			return flushOutbox();
		}
		return flushOutbox();
	}

	function drainPendingMutations() {
		if (activePendingDrain) return activePendingDrain;
		activePendingDrain = performPendingDrain().finally(() => {
			activePendingDrain = null;
		});
		return activePendingDrain;
	}

	function recordMutation() {
		return serializeState(async () => {
			const current = await pendingMutation();
			const pending = {
				count: Math.min(Number.MAX_SAFE_INTEGER, (current?.count ?? 0) + 1),
				dueAt: Date.now() + DEBOUNCE_MS,
			};
			await setStored(STORAGE.pending, pending);
			await mergeStatus({ state: "pending", pending: true, lastError: null });
			schedulePendingDrain(pending);
		}).catch(async (error) => {
			await mergeStatus({ state: "error", lastError: controlledError(error) });
		});
	}

	function isMutationMessage(message) {
		const type = typeof message?.type === "string" ? message.type : "";
		if (type === DATABASE_MUTATED) {
			return !message.database || message.database === DATABASE_NAME;
		}
		if (MUTATION_TYPES.has(type)) return true;
		return /^XR-(?:SIDEPANEL-)?(?:UPSERT|ADD|UPDATE|DELETE).*(?:REMARK|TAG|CATEGOR)/.test(
			type,
		);
	}

	async function publicState() {
		const [identity, status, token] = await Promise.all([
			serializeState(ensureIdentity),
			getStored(STORAGE.status),
			currentToken(),
		]);
		return {
			ok: true,
			tokenConfigured: Boolean(token),
			sourceId: identity.sourceId,
			sequence: identity.sequence,
			status: { ...DEFAULT_STATUS, ...status },
		};
	}

	async function saveToken(token) {
		const normalized = typeof token === "string" ? token.trim() : "";
		if (!/^[A-Za-z0-9_-]{40,128}$/.test(normalized)) {
			return { ok: false, error: "Enter a valid BirdClaw pairing token." };
		}
		await setStored(STORAGE.settings, { token: normalized });
		await ensureHeartbeatAlarm();
		return syncNow();
	}

	async function syncNow() {
		while (true) {
			const pending = await pendingMutation();
			if (pending) {
				const remaining = Math.max(0, pending.dueAt - Date.now());
				if (remaining > 0) {
					await new Promise((resolve) => setTimeout(resolve, remaining));
				}
				const result = await drainPendingMutations();
				if (result.ok === false) return result;
				if (await serializeState(pendingMutation)) continue;
				return result;
			}
			const result = await queueFullSnapshot({ increment: true });
			if (result.deferred) continue;
			return result;
		}
	}

	async function runHeartbeat() {
		if (!(await currentToken())) return { ok: false, needsPairing: true };
		const pending = await pendingMutation();
		if (pending) {
			if (pending.dueAt <= Date.now()) return drainPendingMutations();
			schedulePendingDrain(pending);
			return { ok: true, deferred: true };
		}
		const outbox = await getStored(STORAGE.outbox);
		if (outbox?.id) return flushOutbox();
		return queueFullSnapshot({ increment: false });
	}

	chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
		if (isMutationMessage(message)) {
			void recordMutation();
			return false;
		}

		let operation = null;
		if (message?.type === CONTROL.getState) operation = publicState();
		if (message?.type === CONTROL.setToken)
			operation = saveToken(message.token);
		if (message?.type === CONTROL.syncNow) operation = syncNow();
		if (!operation) return false;

		operation
			.then((result) => sendResponse(result))
			.catch((error) =>
				sendResponse({ ok: false, error: controlledError(error) }),
			);
		return true;
	});

	chrome.alarms.onAlarm.addListener((alarm) => {
		if (alarm.name === RETRY_ALARM) void runHeartbeat();
		if (alarm.name === HEARTBEAT_ALARM) void runHeartbeat();
	});

	chrome.runtime.onInstalled.addListener(() => {
		void ensureHeartbeatAlarm();
	});

	chrome.runtime.onStartup.addListener(() => {
		void ensureHeartbeatAlarm().then(runHeartbeat);
	});

	void serializeState(ensureIdentity);
	void ensureHeartbeatAlarm();
	void pendingMutation().then((pending) => {
		if (pending) schedulePendingDrain(pending);
	});
	void flushOutbox();
})();
