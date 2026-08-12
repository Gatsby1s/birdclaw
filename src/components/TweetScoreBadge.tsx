import { createPortal } from "react-dom";
import type { TweetQualityScore, TweetScoreDimensions } from "#/lib/types";
import { cx } from "#/lib/ui";
import { useFloatingPreview } from "./FloatingPreview";

const dimensionRows: Array<{
	key: keyof TweetScoreDimensions;
	label: string;
}> = [
	{ key: "informationDelta", label: "新增信息" },
	{ key: "clearThesis", label: "观点明确" },
	{ key: "explainedMechanism", label: "机制解释" },
	{ key: "verifiability", label: "可验证性" },
	{ key: "clearBoundaries", label: "边界清晰" },
];

const sentimentLabels = {
	positive: "看多",
	negative: "看空",
	neutral: "中性",
	mixed: "多空交织",
} as const;

function deltaLabel(value: number) {
	return value > 0 ? `+${String(value)}` : String(value);
}

export function TweetScoreBadge({ score }: { score: TweetQualityScore }) {
	const preview = useFloatingPreview({ placement: "right" });
	const card = preview.open ? (
		<span
			aria-label={`帖子评分 ${String(score.score)} 分详情`}
			id={preview.floatingId}
			ref={preview.floatingRef}
			className="z-[100] block w-[420px] max-w-[calc(100vw-24px)] overflow-y-auto rounded-lg border border-[#34424f] bg-[#0d141a] px-5 py-[18px] text-left text-[#e8eef3] shadow-[0_16px_38px_rgba(0,0,0,0.38)]"
			role="group"
			style={preview.floatingStyle}
			{...preview.floatingProps}
		>
			<span
				aria-hidden="true"
				className={cx(
					"absolute size-2.5 rotate-45 border-[#34424f] bg-[#0d141a]",
					preview.side === "right"
						? "top-1/2 -left-[6px] -translate-y-1/2 border-b border-l"
						: preview.side === "bottom"
							? "-top-[6px] left-5 border-t border-l"
							: "-bottom-[6px] left-5 border-r border-b",
				)}
			/>
			<span className="grid min-w-0 gap-4" data-floating-preview-content>
				<span className="flex min-w-0 items-center justify-between gap-3 border-b border-[#293640] pb-3">
					<strong className="min-w-0 text-[18px] leading-6 font-semibold text-white">
						评分 <span className="text-[#36a9f4]">{score.score}</span>
					</strong>
					<span className="shrink-0 text-[13px] font-medium text-[#9ecdf0]">
						{score.label}
					</span>
				</span>

				<span className="grid min-w-0 gap-2.5">
					<strong className="text-[15px] leading-5 font-semibold text-white">
						评分依据
					</strong>
					<span className="grid min-w-0 grid-cols-2 gap-x-5 gap-y-2 text-[14px] leading-5">
						{dimensionRows.map(({ key, label }) => (
							<span
								key={key}
								className="flex min-w-0 items-baseline justify-between gap-3"
							>
								<span className="min-w-0 text-[#aebbc5]">{label}</span>
								<strong
									className={cx(
										"shrink-0 font-semibold tabular-nums",
										score.dimensions[key] > 0
											? "text-[#53c789]"
											: score.dimensions[key] < 0
												? "text-[#ff747a]"
												: "text-[#82909b]",
									)}
								>
									{deltaLabel(score.dimensions[key])}
								</strong>
							</span>
						))}
					</span>
				</span>

				<span className="grid min-w-0 gap-2 border-t border-[#293640] pt-3">
					<strong className="text-[15px] leading-5 font-semibold text-white">
						帖子判断
					</strong>
					<span className="grid min-w-0 gap-1.5 text-[14px] leading-5 text-[#c7d2da]">
						<span className="min-w-0 break-words">
							<span className="text-[#82909b]">倾向：</span>
							{sentimentLabels[score.sentiment]}
						</span>
						<span className="min-w-0 break-words">
							<span className="text-[#82909b]">涉及：</span>
							{score.assets.length > 0 ? score.assets.join("、") : "无明确资产"}
						</span>
					</span>
				</span>

				<span className="grid min-w-0 gap-1.5 border-t border-[#293640] pt-3">
					<strong className="text-[15px] leading-5 font-semibold text-white">
						判断理由
					</strong>
					<span className="min-w-0 whitespace-normal break-words text-[14px] leading-[1.55] text-[#c7d2da]">
						{score.reason}
					</span>
				</span>

				<span className="grid min-w-0 gap-1.5 border-t border-[#293640] pt-3">
					<strong className="text-[15px] leading-5 font-semibold text-white">
						通俗解释
					</strong>
					<span className="min-w-0 whitespace-normal break-words text-[14px] leading-[1.55] text-[#c7d2da]">
						{score.explanation}
					</span>
				</span>
			</span>
		</span>
	) : null;

	return (
		<span
			ref={preview.referenceRef}
			className="relative flex size-11 items-center justify-center"
			{...preview.referenceProps}
		>
			<button
				aria-controls={preview.open ? preview.floatingId : undefined}
				aria-expanded={preview.open}
				aria-label={`帖子评分 ${String(score.score)} 分，查看评分详情`}
				className="relative flex size-11 items-center justify-center border-0 bg-transparent p-0 text-[18px] leading-none font-semibold text-[#36a9f4] tabular-nums hover:text-[#69c1fa] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#36a9f4]"
				onClick={(event) => {
					event.stopPropagation();
					preview.togglePreview();
				}}
				type="button"
			>
				{score.score}
			</button>
			{card && typeof document !== "undefined"
				? createPortal(card, document.body)
				: null}
		</span>
	);
}
