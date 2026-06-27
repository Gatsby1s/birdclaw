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
	defaultAutoRefreshHours?: number;
	showAccountPicker?: boolean;
	syncOptions?: WebSyncOptions;
}

const AUTO_REFRESH_DEFAULT_HOURS = 1;
const AUTO_REFRESH_HOUR_MS = 60 * 60_000;
const AUTO_REFRESH_HOUR_OPTIONS = [1, 2, 4, 6, 12, 24] as const;
const AUTO_REFRESH_STATUS_TICK_MS = 30_000;

function normalizeAutoRefreshHours(value: number, fallback: number) {
	if (!Number.isFinite(value)) return fallback;
	const rounded = Math.max(1, Math.round(value));
	return (
		AUTO_REFRESH_HOUR_OPTIONS.find((option) => option >= rounded) ??
		AUTO_REFRESH_HOUR_OPTIONS[AUTO_REFRESH_HOUR_OPTIONS.length - 1] ??
		fallback
	);
}

function readAutoRefreshEnabled(storageKey: string) {
	if (typeof window === "undefined") return false;
	return window.localStorage.getItem(`${storageKey}:enabled`) === "1";
}

function readAutoRefreshHours(storageKey: string, fallback: number) {
	if (typeof window === "undefined") return fallback;
	const storedHours = window.localStorage.getItem(`${storageKey}:hours`);
	if (storedHours !== null) {
		return normalizeAutoRefreshHours(Number(storedHours), fallback);
	}
	const storedMinutes = window.localStorage.getItem(`${storageKey}:minutes`);
	if (storedMinutes !== null) {
		return normalizeAutoRefreshHours(
			Math.ceil(Number(storedMinutes) / 60),
			fallback,
		);
	}
	return fallback;
}

function formatAutoRefreshStatus(nextAt: number | null, now: number) {
	if (nextAt === null) return "Auto on";
	const remainingMs = nextAt - now;
	if (remainingMs <= 0) return "Next now";
	const remainingHours = Math.max(
		1,
		Math.ceil(remainingMs / AUTO_REFRESH_HOUR_MS),
	);
	return `Next ${String(remainingHours)}h`;
}

function autoRefreshHourLabel(hours: number) {
	return hours === 1 ? "1 hour" : `${String(hours)} hours`;
}

export function SyncNowButton({
	kind,
	label,
	accounts,
	onSynced,
	showAutoRefreshControls = false,
	autoRefreshStorageKey,
	defaultAutoRefreshHours = AUTO_REFRESH_DEFAULT_HOURS,
	showAccountPicker = false,
	syncOptions,
}: SyncNowButtonProps) {
	const [syncing, setSyncing] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const accountList = accounts ?? [];
	const storageKey = autoRefreshStorageKey ?? `birdclaw:auto-sync:${kind}`;
	const fallbackAutoRefreshHours = normalizeAutoRefreshHours(
		defaultAutoRefreshHours,
		AUTO_REFRESH_DEFAULT_HOURS,
	);
	const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(() =>
		readAutoRefreshEnabled(storageKey),
	);
	const [autoRefreshHours, setAutoRefreshHours] = useState(() =>
		readAutoRefreshHours(storageKey, fallbackAutoRefreshHours),
	);
	const [nextAutoRefreshAt, setNextAutoRefreshAt] = useState<number | null>(
		null,
	);
	const [autoRefreshNow, setAutoRefreshNow] = useState(() => Date.now());
	const syncingRef = useRef(false);
	const syncNowRef = useRef<() => Promise<void>>(async () => undefined);
	const autoRefreshHoursRef = useRef(autoRefreshHours);
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
		autoRefreshHoursRef.current = autoRefreshHours;
	}, [autoRefreshHours]);

	useEffect(() => {
		if (!showAutoRefreshControls) return;
		setAutoRefreshEnabled(readAutoRefreshEnabled(storageKey));
		setAutoRefreshHours(
			readAutoRefreshHours(storageKey, fallbackAutoRefreshHours),
		);
	}, [fallbackAutoRefreshHours, showAutoRefreshControls, storageKey]);

	useEffect(() => {
		if (!showAutoRefreshControls || typeof window === "undefined") return;
		window.localStorage.setItem(
			`${storageKey}:enabled`,
			autoRefreshEnabled ? "1" : "0",
		);
		window.localStorage.setItem(
			`${storageKey}:hours`,
			String(autoRefreshHours),
		);
		window.localStorage.setItem(
			`${storageKey}:minutes`,
			String(autoRefreshHours * 60),
		);
	}, [
		autoRefreshEnabled,
		autoRefreshHours,
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
		setNextAutoRefreshAt(now + autoRefreshHours * AUTO_REFRESH_HOUR_MS);
	}, [autoRefreshEnabled, autoRefreshHours, showAutoRefreshControls]);

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
				setNextAutoRefreshAt(
					now + autoRefreshHoursRef.current * AUTO_REFRESH_HOUR_MS,
				);
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
					<select
						aria-label="Auto refresh interval"
						className="h-6 w-[86px] rounded-md border border-[var(--line)] bg-[var(--bg)] px-2 text-[12px] font-semibold text-[var(--ink)] outline-none focus:border-[var(--accent)]"
						onChange={(event) =>
							setAutoRefreshHours(
								normalizeAutoRefreshHours(
									Number(event.currentTarget.value),
									fallbackAutoRefreshHours,
								),
							)
						}
						value={autoRefreshHours}
					>
						{AUTO_REFRESH_HOUR_OPTIONS.map((hours) => (
							<option key={hours} value={hours}>
								{autoRefreshHourLabel(hours)}
							</option>
						))}
					</select>
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
