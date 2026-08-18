import { Link, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import {
	Bell,
	Bookmark,
	CalendarDays,
	Database,
	Gauge,
	Globe2,
	Heart,
	Home,
	Inbox,
	Link as LinkIcon,
	Mail,
	Menu,
	MessagesSquare,
	Rss,
	Settings,
	ShieldOff,
	UserSearch,
} from "lucide-react";
import {
	cx,
	navLinkActiveClass,
	navLinkClass,
	navLinkCompactClass,
	navLinkIconClass,
	navLinkLabelClass,
	navLinkLabelCompactClass,
	sidebarBrandClass,
	sidebarBrandCopyClass,
	sidebarBrandCopyCompactClass,
	sidebarBrandMarkClass,
	sidebarBrandTaglineClass,
	sidebarBrandTitleClass,
	sidebarShellCompactClass,
	sidebarFooterClass,
	sidebarNavClass,
	sidebarShellClass,
} from "#/lib/ui";
import { AccountSwitcher } from "./AccountSwitcher";
import { BirdclawMark } from "./BrandMark";
import { ThemeSlider } from "./ThemeSlider";

const links = [
	{ to: "/", label: "Home", icon: Home },
	{ to: "/feed", label: "Feed", icon: Rss },
	{ to: "/inbox", label: "Inbox", icon: Inbox },
	{ to: "/today", label: "Today", icon: CalendarDays },
	{ to: "/discuss", label: "Discuss", icon: MessagesSquare },
	{ to: "/profile-analyze", label: "Analyse", icon: UserSearch },
	{ to: "/network-map", label: "Map", icon: Globe2 },
	{ to: "/data-sources", label: "Sources", icon: Database },
	{ to: "/settings", label: "Settings", icon: Settings },
	{ to: "/mentions", label: "Mentions", icon: Bell },
	{ to: "/likes", label: "Likes", icon: Heart },
	{ to: "/bookmarks", label: "Bookmarks", icon: Bookmark },
	{ to: "/links", label: "Links", icon: LinkIcon },
	{ to: "/rate-limits", label: "Rate Limits", icon: Gauge },
	{ to: "/dms", label: "DMs", icon: Mail },
	{ to: "/blocks", label: "Blocks", icon: ShieldOff },
] as const;

const mobilePrimaryLinks = [
	{ to: "/", label: "Home", icon: Home },
	{ to: "/feed", label: "Feed", icon: Rss },
	{ to: "/today", label: "Today", icon: CalendarDays },
	{ to: "/discuss", label: "Discuss", icon: MessagesSquare },
] as const;

export function AppNav({ compact = false }: { compact?: boolean }) {
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});

	return (
		<aside className={compact ? sidebarShellCompactClass : sidebarShellClass}>
			<div className="flex flex-col">
				<Link to="/" className={sidebarBrandClass}>
					<span className={sidebarBrandMarkClass}>
						<BirdclawMark className="size-10" />
					</span>
					<span
						className={
							compact ? sidebarBrandCopyCompactClass : sidebarBrandCopyClass
						}
					>
						<span className={sidebarBrandTitleClass}>birdclaw</span>
						<span className={sidebarBrandTaglineClass}>
							Fast search for your archive.
						</span>
					</span>
				</Link>
				<nav className={sidebarNavClass} aria-label="Primary">
					{links.map((link) => {
						const active = pathname === link.to;
						const Icon = link.icon;
						return (
							<Link
								key={link.to}
								to={link.to}
								aria-label={link.label}
								className={cx(
									compact ? navLinkCompactClass : navLinkClass,
									active && navLinkActiveClass,
								)}
							>
								<Icon
									className={navLinkIconClass}
									size={22}
									strokeWidth={active ? 2.4 : 1.8}
									aria-hidden="true"
								/>
								<span
									className={
										compact ? navLinkLabelCompactClass : navLinkLabelClass
									}
								>
									{link.label}
								</span>
							</Link>
						);
					})}
				</nav>
			</div>
			<div className={sidebarFooterClass}>
				<AccountSwitcher action={<ThemeSlider compact />} />
			</div>
		</aside>
	);
}

export function MobileAppNav() {
	const moreRef = useRef<HTMLDetailsElement>(null);
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});
	const moreLinks = links.filter(
		(link) => !mobilePrimaryLinks.some((primary) => primary.to === link.to),
	);
	useEffect(() => {
		if (moreRef.current) moreRef.current.open = false;
	}, [pathname]);

	return (
		<nav
			aria-label="Mobile primary"
			className="fixed inset-x-0 bottom-0 z-50 grid grid-cols-5 border-t border-[var(--line)] bg-[color:color-mix(in_srgb,var(--bg)_94%,transparent)] pb-[env(safe-area-inset-bottom)] backdrop-blur min-[900px]:hidden"
		>
			{mobilePrimaryLinks.map((link) => {
				const Icon = link.icon;
				const active = pathname === link.to;
				return (
					<Link
						key={link.to}
						to={link.to}
						className={cx(
							"flex min-h-16 flex-col items-center justify-center gap-1 px-1 text-[11px] text-[var(--ink-soft)]",
							active && "font-bold text-[var(--accent)]",
						)}
					>
						<Icon size={21} strokeWidth={active ? 2.4 : 1.8} />
						<span>{link.label}</span>
					</Link>
				);
			})}
			<details ref={moreRef} className="group relative">
				<summary className="flex min-h-16 list-none flex-col items-center justify-center gap-1 px-1 text-[11px] text-[var(--ink-soft)]">
					<Menu size={21} strokeWidth={1.9} />
					<span>More</span>
				</summary>
				<div className="absolute right-2 bottom-[calc(4rem+env(safe-area-inset-bottom))] grid max-h-[min(70dvh,560px)] w-[min(78vw,300px)] grid-cols-2 gap-1 overflow-y-auto rounded-2xl border border-[var(--line-strong)] bg-[var(--bg-elevated)] p-2 shadow-[0_16px_50px_var(--shadow-strong)]">
					{moreLinks.map((link) => {
						const Icon = link.icon;
						const active = pathname === link.to;
						return (
							<Link
								key={link.to}
								to={link.to}
								className={cx(
									"flex min-h-12 items-center gap-2 rounded-xl px-3 text-[13px] text-[var(--ink)] hover:bg-[var(--bg-hover)]",
									active && "bg-[var(--bg-active)] font-bold",
								)}
							>
								<Icon size={19} strokeWidth={active ? 2.4 : 1.8} />
								<span>{link.label}</span>
							</Link>
						);
					})}
				</div>
			</details>
		</nav>
	);
}
