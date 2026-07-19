import { useEffect, useMemo, useState } from "react";
import {
	type CustomDateRange,
	dateTimeLocalValue,
	defaultCustomDateRange,
	normalizeCustomDateRange,
} from "#/lib/custom-date-range";
import { cx, primaryButtonClass, textFieldClass } from "#/lib/ui";

export function CustomDateRangePicker({
	value,
	onApply,
}: {
	value?: CustomDateRange | null;
	onApply: (range: CustomDateRange) => void;
}) {
	const initialRange = value ?? defaultCustomDateRange();
	const [sinceDraft, setSinceDraft] = useState(() =>
		dateTimeLocalValue(initialRange.since),
	);
	const [untilDraft, setUntilDraft] = useState(() =>
		dateTimeLocalValue(initialRange.until),
	);

	useEffect(() => {
		if (!value) return;
		setSinceDraft(dateTimeLocalValue(value.since));
		setUntilDraft(dateTimeLocalValue(value.until));
	}, [value?.since, value?.until]);

	const range = useMemo(
		() => normalizeCustomDateRange(sinceDraft, untilDraft),
		[sinceDraft, untilDraft],
	);
	const hasBothValues = Boolean(sinceDraft && untilDraft);

	return (
		<div
			aria-label="Custom date range"
			className="col-span-full grid w-full gap-2 rounded-2xl border border-[var(--line)] bg-[var(--bg)] p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end"
			role="group"
		>
			<label className="grid min-w-0 gap-1 text-[12px] font-semibold text-[var(--ink-soft)]">
				From
				<input
					aria-label="From"
					className={cx(textFieldClass, "min-w-0")}
					max={untilDraft || undefined}
					onChange={(event) => setSinceDraft(event.currentTarget.value)}
					step="60"
					type="datetime-local"
					value={sinceDraft}
				/>
			</label>
			<label className="grid min-w-0 gap-1 text-[12px] font-semibold text-[var(--ink-soft)]">
				To
				<input
					aria-label="To"
					className={cx(textFieldClass, "min-w-0")}
					min={sinceDraft || undefined}
					onChange={(event) => setUntilDraft(event.currentTarget.value)}
					step="60"
					type="datetime-local"
					value={untilDraft}
				/>
			</label>
			<button
				aria-label="Apply custom range"
				className={cx(primaryButtonClass, "h-[38px]")}
				disabled={!range}
				onClick={() => {
					if (range) onApply(range);
				}}
				type="button"
			>
				Apply
			</button>
			<p
				className={cx(
					"text-[12px] sm:col-span-3",
					hasBothValues && !range
						? "text-[var(--alert)]"
						: "text-[var(--ink-soft)]",
				)}
				role={hasBothValues && !range ? "alert" : undefined}
			>
				{hasBothValues && !range
					? "From must be earlier than To."
					: "Times use your local timezone. The range changes only after Apply."}
			</p>
		</div>
	);
}
