(() => {
	"use strict";

	const BIRDCLAW_ORIGIN = "https://birdclaw-production.up.railway.app";
	const ENDPOINT = `${BIRDCLAW_ORIGIN}/api/integrations/xremark/snapshot`;
	const CHANGES_ENDPOINT = `${BIRDCLAW_ORIGIN}/api/integrations/xremark/changes`;
	const DATABASE_NAME = "xRemark";
	const STORE_NAMES = ["remarks", "tags", "categories"];
	const RETRY_ALARM = "birdclaw-xremark-retry";
	const HEARTBEAT_ALARM = "birdclaw-xremark-heartbeat";
	const HEARTBEAT_MINUTES = 0.5;
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

	async function openDatabase() {
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
		const database = await openDatabase();
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

	function normalizedNames(values) {
		const result = [];
		const seen = new Set();
		for (const value of Array.isArray(values) ? values : []) {
			const name = typeof value === "string" ? value.trim() : "";
			const key = name.toLocaleLowerCase();
			if (!name || seen.has(key)) continue;
			seen.add(key);
			result.push(name);
		}
		return result;
	}

	function comparableState(note, tagNames, categoryName) {
		if (!note) return { exists: false };
		return {
			exists: true,
			remark: typeof note.remark === "string" ? note.remark : "",
			description: typeof note.description === "string" ? note.description : "",
			tags: normalizedNames(tagNames),
			category:
				typeof categoryName === "string" && categoryName.trim()
					? categoryName.trim()
					: null,
		};
	}

	function targetState(change) {
		const tags = normalizedNames(change.tags);
		const category =
			typeof change.category === "string" && change.category.trim()
				? change.category.trim()
				: null;
		if (
			!change.remark &&
			!change.description &&
			tags.length === 0 &&
			!category
		) {
			return { exists: false };
		}
		return {
			exists: true,
			remark: change.remark,
			description: change.description,
			tags,
			category,
		};
	}

	function sameState(left, right) {
		return JSON.stringify(left) === JSON.stringify(right);
	}

	async function applyRemoteChanges(changes) {
		if (!Array.isArray(changes) || changes.length === 0) {
			return { applied: [], conflicts: [], changed: false };
		}
		const database = await openDatabase();
		try {
			for (const storeName of STORE_NAMES) {
				if (!database.objectStoreNames.contains(storeName)) {
					throw new BridgeError(
						"This X Remark version does not expose the expected local stores.",
					);
				}
			}
			const transaction = database.transaction(STORE_NAMES, "readwrite");
			const completion = new Promise((resolve, reject) => {
				transaction.oncomplete = resolve;
				transaction.onerror = () =>
					reject(new BridgeError("X Remark storage could not be updated."));
				transaction.onabort = () =>
					reject(new BridgeError("X Remark storage could not be updated."));
			});
			const remarksStore = transaction.objectStore("remarks");
			const tagsStore = transaction.objectStore("tags");
			const categoriesStore = transaction.objectStore("categories");
			const [remarks, tags, categories] = await Promise.all([
				requestAsPromise(
					remarksStore.getAll(),
					"X Remark storage could not be read.",
				),
				requestAsPromise(
					tagsStore.getAll(),
					"X Remark storage could not be read.",
				),
				requestAsPromise(
					categoriesStore.getAll(),
					"X Remark storage could not be read.",
				),
			]);
			const remarkById = new Map(
				remarks.map((note) => [String(note?.identifier ?? ""), note]),
			);
			const tagById = new Map(tags.map((tag) => [String(tag?.id ?? ""), tag]));
			const tagByName = new Map(
				tags
					.filter((tag) => typeof tag?.name === "string" && tag.name.trim())
					.map((tag) => [tag.name.trim().toLocaleLowerCase(), tag]),
			);
			const categoryById = new Map(
				categories.map((category) => [String(category?.id ?? ""), category]),
			);
			const categoryByName = new Map(
				categories
					.filter(
						(category) =>
							typeof category?.name === "string" && category.name.trim(),
					)
					.map((category) => [
						category.name.trim().toLocaleLowerCase(),
						category,
					]),
			);
			const applied = [];
			const conflicts = [];
			let changed = false;
			const now = Date.now();

			for (const change of changes) {
				const identifier = String(change?.identifier ?? "").trim();
				const revision = Number(change?.revision);
				if (!identifier || !Number.isSafeInteger(revision) || revision < 0) {
					throw new BridgeError(
						"BirdClaw returned an invalid X Remark change.",
					);
				}
				const currentNote = remarkById.get(identifier);
				const currentTagNames = (currentNote?.tags ?? []).map(
					(id) => tagById.get(String(id))?.name ?? "",
				);
				const currentCategory = currentNote?.category
					? categoryById.get(String(currentNote.category))?.name
					: null;
				const current = comparableState(
					currentNote,
					currentTagNames,
					currentCategory,
				);
				const target = targetState(change);
				const acceptableBases = Array.isArray(change.acceptableBases)
					? change.acceptableBases
					: [change.base];
				if (
					!acceptableBases.some((base) => sameState(current, base)) &&
					!sameState(current, target)
				) {
					conflicts.push(revision);
					continue;
				}
				if (sameState(current, target)) {
					applied.push(revision);
					continue;
				}
				changed = true;
				if (!target.exists) {
					remarksStore.delete(identifier);
					remarkById.delete(identifier);
					applied.push(revision);
					continue;
				}
				const tagIds = target.tags.map((name) => {
					const key = name.toLocaleLowerCase();
					const existing = tagByName.get(key);
					if (existing) return existing.id;
					const tag = {
						id: crypto.randomUUID(),
						name,
						description: "",
						updateTime: now,
					};
					tagsStore.add(tag);
					tagByName.set(key, tag);
					tagById.set(String(tag.id), tag);
					return tag.id;
				});
				const categoryId = target.category
					? (categoryByName.get(target.category.toLocaleLowerCase())?.id ??
						null)
					: null;
				const nextNote = {
					...currentNote,
					identifier,
					additionalName: change.handle || currentNote?.additionalName || "",
					givenName: change.displayName || currentNote?.givenName || "",
					remark: target.remark,
					description: target.description,
					tags: tagIds,
					category: categoryId,
					createTime: currentNote?.createTime ?? now,
					updateTime: now,
				};
				remarksStore.put(nextNote);
				remarkById.set(identifier, nextNote);
				applied.push(revision);
			}
			await completion;
			if (changed) {
				try {
					await chrome.runtime.sendMessage({ type: "XR-TAGS-UPDATED" });
					for (const change of changes) {
						await chrome.runtime.sendMessage({
							type: "XR-SINGLE-REMARK-UPDATED",
							identifier: change.identifier,
						});
					}
				} catch {
					// X Remark will still read the committed IndexedDB state on its next render.
				}
			}
			return { applied, conflicts, changed };
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

	async function bridgeFetch(url, options = {}) {
		const token = await currentToken();
		if (!token) throw new BridgeError("A BirdClaw pairing token is required.");
		const response = await fetch(url, {
			...options,
			headers: {
				Authorization: `Bearer ${token}`,
				...(options.body ? { "Content-Type": "application/json" } : {}),
				...options.headers,
			},
			cache: "no-store",
		});
		if (!response.ok) {
			throw new BridgeError(`BirdClaw returned HTTP ${response.status}.`);
		}
		return response;
	}

	async function pullRemoteChanges() {
		let response;
		try {
			response = await bridgeFetch(CHANGES_ENDPOINT, { method: "GET" });
		} catch (error) {
			const message = controlledError(error);
			await mergeStatus({ state: "error", pending: true, lastError: message });
			return { ok: false, error: message };
		}
		let body;
		try {
			body = await response.json();
		} catch {
			return { ok: false, error: "BirdClaw returned invalid change data." };
		}
		if (!body?.ok || !Array.isArray(body.changes)) {
			return { ok: false, error: "BirdClaw returned invalid change data." };
		}
		if (body.changes.length === 0) return { ok: true, handled: false };

		let result;
		try {
			result = await applyRemoteChanges(body.changes);
		} catch (error) {
			const message = controlledError(error);
			await mergeStatus({ state: "error", pending: true, lastError: message });
			return { ok: false, error: message };
		}
		const snapshotResult = await queueFullSnapshot({
			increment: true,
			absorbPending: true,
		});
		if (snapshotResult.ok === false || !snapshotResult.snapshotUploaded) {
			return snapshotResult;
		}
		try {
			await bridgeFetch(CHANGES_ENDPOINT, {
				method: "POST",
				body: JSON.stringify({
					applied: result.applied,
					conflicts: result.conflicts,
				}),
			});
			await mergeStatus({
				state: result.conflicts.length > 0 ? "conflict" : "ready",
				pending: false,
				lastSuccessAt: Date.now(),
				lastError:
					result.conflicts.length > 0
						? "A newer X Remark edit was kept instead of being overwritten."
						: null,
			});
			return { ok: true, handled: true, ...result };
		} catch (error) {
			const message = controlledError(error);
			await mergeStatus({ state: "error", pending: true, lastError: message });
			return { ok: false, error: message };
		}
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

	async function queueFullSnapshot({ increment, absorbPending = false }) {
		let queued;
		try {
			queued = await serializeState(async () => {
				const pending = await pendingMutation();
				if (pending && !absorbPending) return { kind: "deferred", pending };
				let identity;
				if (pending) {
					const current = await ensureIdentity();
					identity = {
						sourceId: current.sourceId,
						sequence: Math.min(
							Number.MAX_SAFE_INTEGER,
							Math.max(
								1,
								current.sequence + pending.count + (increment ? 1 : 0),
							),
						),
					};
					await setStored(STORAGE.identity, identity);
				} else {
					identity = await nextIdentity({ increment });
				}
				const payload = await readFullSnapshot(identity);
				const outbox = {
					id: `${identity.sourceId}:${identity.sequence}:${payload.capturedAt}`,
					payload,
					attempts: 0,
					queuedAt: Date.now(),
				};
				await setStored(STORAGE.outbox, outbox);
				if (pending) await chrome.storage.local.remove(STORAGE.pending);
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
		const result = await flushOutbox();
		return result.ok === false || result.deferred
			? result
			: { ...result, snapshotUploaded: true };
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
				if (result.ok === false) return result;
				return pullRemoteChanges();
			}
			const result = await queueFullSnapshot({ increment: true });
			if (result.deferred) continue;
			if (result.ok === false) return result;
			return pullRemoteChanges();
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
		const remote = await pullRemoteChanges();
		if (remote.ok === false || remote.handled) return remote;
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
