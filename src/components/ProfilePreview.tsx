import { Fragment, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { formatCompactNumber } from "#/lib/present";
import {
	collectTweetSegmentsForText,
	profileDescriptionEntitiesFromXurl,
} from "#/lib/tweet-render";
import type { ProfileRecord } from "#/lib/types";
import {
	cx,
	profilePreviewBioClass,
	profilePreviewCardClass,
	profilePreviewClass,
	profilePreviewHandleClass,
	profilePreviewHeaderClass,
	profilePreviewMetaClass,
	profilePreviewNameClass,
	profilePreviewTriggerClass,
} from "#/lib/ui";
import { safeHttpUrl } from "#/lib/url-safety";
import { AvatarChip } from "./AvatarChip";
import { useAvatarPreload } from "./AvatarPreload";
import { useFloatingPreview } from "./FloatingPreview";
import { XRemarkAnnotationInline } from "./XRemarkAnnotation";

function ProfilePreviewBio({ profile }: { profile: ProfileRecord }) {
	const segments = collectTweetSegmentsForText(
		profile.bio,
		profileDescriptionEntitiesFromXurl(profile.entities),
	);
	let cursor = 0;

	return (
		<span className={profilePreviewBioClass}>
			{segments.map((segment, index) => {
				if (
					segment.kind !== "url" ||
					segment.start < cursor ||
					segment.end <= segment.start ||
					segment.end > profile.bio.length
				) {
					return null;
				}
				const prefix = profile.bio.slice(cursor, segment.start);
				cursor = segment.end;
				const safeExpandedUrl = safeHttpUrl(segment.expandedUrl);
				return (
					<Fragment key={`${segment.url}-${String(index)}`}>
						{prefix}
						{safeExpandedUrl ? (
							<span className="text-[var(--accent)]">
								{segment.expandedUrl}
							</span>
						) : (
							profile.bio.slice(segment.start, segment.end)
						)}
					</Fragment>
				);
			})}
			{profile.bio.slice(cursor)}
		</span>
	);
}

export function ProfilePreview({
	profile,
	children,
	className = "",
	triggerAriaLabel,
	triggerClassName = "",
}: {
	profile: ProfileRecord;
	children: ReactNode;
	className?: string;
	triggerAriaLabel?: string;
	triggerClassName?: string;
}) {
	const preview = useFloatingPreview();
	useAvatarPreload(preview.referenceRef, profile.id, profile.avatarUrl);

	return (
		<span
			ref={preview.referenceRef}
			className={cx(profilePreviewClass, className)}
			{...preview.referenceProps}
		>
			<a
				aria-controls={preview.open ? preview.floatingId : undefined}
				aria-expanded={preview.open}
				aria-label={triggerAriaLabel}
				className={cx(profilePreviewTriggerClass, triggerClassName)}
				href={`/authors/${encodeURIComponent(profile.handle)}`}
			>
				{children}
			</a>
			{preview.open && typeof document !== "undefined"
				? createPortal(
						<span
							aria-label={`${profile.displayName} profile preview`}
							id={preview.floatingId}
							ref={preview.floatingRef}
							className={profilePreviewCardClass}
							role="group"
							style={preview.floatingStyle}
							{...preview.floatingProps}
						>
							<span className="grid gap-3" data-floating-preview-content>
								<span className={profilePreviewHeaderClass}>
									<AvatarChip
										avatarUrl={profile.avatarUrl}
										hue={profile.avatarHue}
										name={profile.displayName}
										profileId={profile.id}
										size="large"
									/>
									<span className="flex min-w-0 flex-col">
										<span className={profilePreviewNameClass}>
											{profile.displayName}
										</span>
										<span className={profilePreviewHandleClass}>
											@{profile.handle}
										</span>
									</span>
								</span>
								{profile.xRemark ? (
									<XRemarkAnnotationInline annotation={profile.xRemark} />
								) : null}
								{profile.bio ? <ProfilePreviewBio profile={profile} /> : null}
								<span className={profilePreviewMetaClass}>
									{profile.followingCount !== undefined ? (
										<span>
											<strong>
												{formatCompactNumber(profile.followingCount)}
											</strong>{" "}
											following
										</span>
									) : null}
									<span>
										<strong>
											{formatCompactNumber(profile.followersCount)}
										</strong>{" "}
										followers
									</span>
								</span>
							</span>
						</span>,
						document.body,
					)
				: null}
		</span>
	);
}
