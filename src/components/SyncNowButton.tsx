import { Clock3, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { postSync } from "#/lib/api-client";
import type { AccountRecord } from "#/lib/types";
import { cx, selectFieldClass } from "#/lib/ui";
import type {
	WebSyncKind,
	WebSyncOptions,
	WebSyncResponse,
} from "#/lib/web-sync";
import {
	defaultAccountId as getDefaultAccountId,
	setStoredAccountId,
	useSelectedAccountId,
} from "./account-selection";

interface SyncNowButtonProps {
	kind: WebSyncKind;
	label: string;
	accounts?: AccountRecord[];
	onSynced: (result: WebSyncResponse) => void;
	showAutoRefreshControls?: boolean;
	autoRefreshStorageKey?: string;
	defaultAutoRefreshMinutes?: number;
	showAccountPicker?: boolean;
	syncOptions?: WebSyncOptions;
}

const AUTO_REFRESH_DEFAULT_MINUTES = 5;
const AUTO_REFRESH_MIN_MINUTES = 1;
const AUTO_REFRESH_MAX_MINUTES = 180;
const AUTO_REFRESH_STATUS_TICK_MS = 30_000;

function clampAutoRefreshMinutes(value: number, fallback: number) {
	if (!Number.isFinite(value)) return fallback;
	return Math.min(
		AUTO_REFRESH_MAX_MINUTES,
		Math.max(AUTO_REFRESH_MIN_MINUTES, Math.round(value)),
	);
}

function readAutoRefreshEnabled(storageKey: string) {
	if (typeof window === "undefined") return false;
	return window.localStorage.getItem(`${storageKey}:enabled`) === "1";
}

function readAutoRefreshMinutes(storageKey: string, fallback: number) {
	if (typeof window === "undefined") return fallback;
	const stored = window.localStorage.getItem(`${storageKey}:minutes`);
	if (stored === null) return fallback;
	return clampAutoRefreshMinutes(Number(stored), fallback);
}

function formatAutoRefreshStatus(nextAt: number | null, now: number) {
	if (nextAt === null) return "Auto on";
	const remainingMs = nextAt - now;
	if (remainingMs <= 0) return "Next now";
	const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));
	return `Next ${String(remainingMinutes)}m`;
}

export function SyncNowButton({
	kind,
	label,
	accounts,
	onSynced,
	showAutoRefreshControls = false,
	autoRefreshStorageKey,
	defaultAutoRefreshMinutes = AUTO_REFRESH_DEFAULT_MINUTES,
	showAccountPicker = false,
	syncOptions,
}: SyncNowButtonProps) {
	const [syncing, setSyncing] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const accountList = accounts ?? [];
	const storageKey = autoRefreshStorageKey ?? `birdclaw:auto-sync:${kind}`;
	const fallbackAutoRefreshMinutes = clampAutoRefreshMinutes(
		defaultAutoRefreshMinutes,
		AUTO_REFRESH_DEFAULT_MINUTES,
	);
	const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(() =>
		readAutoRefreshEnabled(storageKey),
	);
	const [autoRefreshMinutes, setAutoRefreshMinutes] = useState(() =>
		readAutoRefreshMinutes(storageKey, fallbackAutoRefreshMinutes),
	);
	const [nextAutoRefreshAt, setNextAutoRefreshAt] = useState<number | null>(
		null,
	);
	const [autoRefreshNow, setAutoRefreshNow] = useState(() => Date.now());
	const syncingRef = useRef(false);
	const syncNowRef = useRef<() => Promise<void>>(async () => undefined);
	const autoRefreshMinutesRef = useRef(autoRefreshMinutes);
	const globalAccountId = useSelectedAccountId(accounts);
	const defaultAccountId = useMemo(
		() => getDefaultAccountId(accounts),
		[accounts],
	);
	const accountId = globalAccountId ?? defaultAccountId;
	const accountAwareSync = kind !== "dms";
	const waitingForAccount =
		accountAwareSync &&
		accounts === undefined &&
		(showAccountPicker || kind !== "timeline");
	const birdOnlyWrongAccount =
		!accountAwareSync &&
		accountId !== undefined &&
		defaultAccountId !== undefined &&
		accountId !== defaultAccountId;
	const disabled = syncing || waitingForAccount || birdOnlyWrongAccount;
	const statusMessage = birdOnlyWrongAccount
		? "Switch to default to sync"
		: waitingForAccount
			? "Loading account"
			: (error ??
				message ??
				(autoRefreshEnabled
					? formatAutoRefreshStatus(nextAutoRefreshAt, autoRefreshNow)
					: ""));

	useEffect(() => {
		syncingRef.current = syncing;
	}, [syncing]);

	useEffect(() => {
		autoRefreshMinutesRef.current = autoRefreshMinutes;
	}, [autoRefreshMinutes]);

	useEffect(() => {
		if (!showAutoRefreshControls) return;
		setAutoRefreshEnabled(readAutoRefreshEnabled(storageKey));
		setAutoRefreshMinutes(
			readAutoRefreshMinutes(storageKey, fallbackAutoRefreshMinutes),
		);
	}, [fallbackAutoRefreshMinutes, showAutoRefreshControls, storageKey]);

	useEffect(() => {
		if (!showAutoRefreshControls || typeof window === "undefined") return;
		window.localStorage.setItem(
			`${storageKey}:enabled`,
			autoRefreshEnabled ? "1" : "0",
		);
		window.localStorage.setItem(
			`${storageKey}:minutes`,
			String(autoRefreshMinutes),
		);
	}, [
		autoRefreshEnabled,
		autoRefreshMinutes,
		showAutoRefreshControls,
		storageKey,
	]);

	function selectAccount(accountId: string) {
		setStoredAccountId(accountId);
	}

	const syncNow = useCallback(async () => {
		if (syncingRef.current || waitingForAccount || birdOnlyWrongAccount) return;
		syncingRef.current = true;
		setSyncing(true);
		setError(null);
		setMessage(null);
		try {
			const data = await postSync(
				kind,
				accountAwareSync ? accountId : undefined,
				syncOptions,
			);
			if (!data.ok) throw new Error(data.summary);
			setMessage(data.summary);
			onSynced(data);
		} catch (syncError) {
			setError(syncError instanceof Error ? syncError.message : "Sync failed");
		} finally {
			syncingRef.current = false;
			setSyncing(false);
		}
	}, [
		accountAwareSync,
		accountId,
		birdOnlyWrongAccount,
		kind,
		onSynced,
		syncOptions,
		waitingForAccount,
	]);

	useEffect(() => {
		syncNowRef.current = syncNow;
	}, [syncNow]);

	useEffect(() => {
		if (!showAutoRefreshControls || !autoRefreshEnabled) {
			setNextAutoRefreshAt(null);
			return;
		}
		const now = Date.now();
		setAutoRefreshNow(now);
		setNextAutoRefreshAt(now + autoRefreshMinutes * 60_000);
	}, [autoRefreshEnabled, autoRefreshMinutes, showAutoRefreshControls]);

	useEffect(() => {
		if (!showAutoRefreshControls || !autoRefreshEnabled) return;
		const timer = window.setInterval(() => {
			setAutoRefreshNow(Date.now());
		}, AUTO_REFRESH_STATUS_TICK_MS);
		return () => window.clearInterval(timer);
	}, [autoRefreshEnabled, showAutoRefreshControls]);

	useEffect(() => {
		if (
			!showAutoRefreshControls ||
			!autoRefreshEnabled ||
			nextAutoRefreshAt === null
		) {
			return;
		}
		let disposed = false;
		const delayMs = Math.max(0, nextAutoRefreshAt - Date.now());
		const timer = window.setTimeout(() => {
			void (async () => {
				await syncNowRef.current();
				if (disposed) return;
				const now = Date.now();
				setAutoRefreshNow(now);
				setNextAutoRefreshAt(now + autoRefreshMinutesRef.current * 60_000);
			})();
		}, delayMs);
		return () => {
			disposed = true;
			window.clearTimeout(timer);
		};
	}, [autoRefreshEnabled, nextAutoRefreshAt, showAutoRefreshControls]);

	return (
		<div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
			{showAutoRefreshControls ? (
				<div className="inline-flex h-9 shrink-0 items-center gap-2 rounded-full border border-[var(--line)] bg-[var(--panel)] px-2.5 text-[12px] font-medium text-[var(--ink-soft)] shadow-sm">
					<label className="inline-flex items-center gap-1.5 whitespace-nowrap">
						<input
							aria-label="Auto refresh timeline"
							checked={autoRefreshEnabled}
							className="size-3.5 rounded border-[var(--line)] accent-[var(--accent)]"
							onChange={(event) =>
								setAutoRefreshEnabled(event.currentTarget.checked)
							}
							type="checkbox"
						/>
						<Clock3 className="size-3.5" strokeWidth={2} />
						<span>Auto</span>
					</label>
					<input
						aria-label="Auto refresh interval minutes"
						className="h-6 w-12 rounded-md border border-[var(--line)] bg-[var(--bg)] px-1 text-center text-[12px] font-semibold tabular-nums text-[var(--ink)] outline-none focus:border-[var(--accent)]"
						max={AUTO_REFRESH_MAX_MINUTES}
						min={AUTO_REFRESH_MIN_MINUTES}
						onChange={(event) =>
							setAutoRefreshMinutes(
								clampAutoRefreshMinutes(
									Number(event.currentTarget.value),
									fallbackAutoRefreshMinutes,
								),
							)
						}
						type="number"
						value={autoRefreshMinutes}
					/>
					<span>min</span>
				</div>
			) : null}
			{showAccountPicker && accountAwareSync && accountList.length > 1 ? (
				<select
					aria-label="Sync account"
					className={cx(selectFieldClass, "h-9 w-[132px]")}
					disabled={syncing}
					onChange={(event) => selectAccount(event.target.value)}
					value={accountId ?? ""}
				>
					{accountList.map((account) => (
						<option key={account.id} value={account.id}>
							{account.handle}
						</option>
					))}
				</select>
			) : null}
			<button
				type="button"
				className={cx(
					"inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-[var(--line)] bg-[var(--bg)] px-3 text-[13px] font-semibold text-[var(--ink)] transition-[background,border-color,color,transform] duration-150 hover:border-[color:color-mix(in_srgb,var(--accent)_45%,var(--line))] hover:bg-[var(--accent-soft)] hover:text-[var(--accent)] active:scale-[0.98] disabled:opacity-65",
					syncing && "text-[var(--ink-soft)]",
					birdOnlyWrongAccount
						? "disabled:cursor-not-allowed"
						: "disabled:cursor-wait",
				)}
				aria-label={
					birdOnlyWrongAccount
						? `${label}: default account only`
						: syncing
							? `${label}: syncing`
							: label
				}
				disabled={disabled}
				onClick={syncNow}
			>
				<RefreshCw
					className={cx("size-4", syncing && "animate-spin")}
					strokeWidth={2}
				/>
				<span className="hidden sm:inline">
					{syncing ? "Syncing..." : label}
				</span>
			</button>
			<span
				className={cx(
					"hidden max-w-[120px] truncate text-[12px] tabular-nums sm:inline",
					error ? "text-[var(--alert)]" : "text-[var(--ink-soft)]",
				)}
				role="status"
			>
				{statusMessage}
			</span>
		</div>
	);
}
