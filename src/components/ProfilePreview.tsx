import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { formatCompactNumber } from "#/lib/present";
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
import { AvatarChip } from "./AvatarChip";

export function ProfilePreview({
	profile,
	children,
	className = "",
}: {
	profile: ProfileRecord;
	children: ReactNode;
	className?: string;
}) {
	const [placeAbove, setPlaceAbove] = useState(false);
	const shellRef = useRef<HTMLSpanElement | null>(null);
	const cardRef = useRef<HTMLSpanElement | null>(null);

	function updatePlacement() {
		const shell = shellRef.current;
		if (!shell) return;
		const shellRect = shell.getBoundingClientRect();
		const cardHeight = cardRef.current?.offsetHeight ?? 180;
		const belowSpace = window.innerHeight - shellRect.bottom;
		const aboveSpace = shellRect.top;
		setPlaceAbove(belowSpace < cardHeight + 18 && aboveSpace > belowSpace);
	}

	useLayoutEffect(updatePlacement, []);

	return (
		<span
			ref={shellRef}
			className={cx(profilePreviewClass, "group", className)}
			onFocus={updatePlacement}
			onPointerEnter={updatePlacement}
		>
			<a
				className={profilePreviewTriggerClass}
				href={`https://x.com/${profile.handle}`}
				rel="noreferrer"
				target="_blank"
			>
				{children}
			</a>
			<span
				ref={cardRef}
				className={cx(
					profilePreviewCardClass,
					placeAbove
						? "bottom-[calc(100%+8px)] -translate-y-1 group-hover:translate-y-0 group-focus-within:translate-y-0"
						: "top-[calc(100%+8px)] translate-y-1 group-hover:translate-y-0 group-focus-within:translate-y-0",
				)}
			>
				<span className={profilePreviewHeaderClass}>
					<AvatarChip
						avatarUrl={profile.avatarUrl}
						hue={profile.avatarHue}
						name={profile.displayName}
						profileId={profile.id}
					/>
					<span className="flex min-w-0 flex-col">
						<span className={profilePreviewNameClass}>
							{profile.displayName}
						</span>
						<span className={profilePreviewHandleClass}>@{profile.handle}</span>
					</span>
				</span>
				{profile.bio ? (
					<span className={profilePreviewBioClass}>{profile.bio}</span>
				) : null}
				<span className={profilePreviewMetaClass}>
					{formatCompactNumber(profile.followersCount)} followers
				</span>
			</span>
		</span>
	);
}
