import {
	createRootRoute,
	HeadContent,
	Scripts,
	useRouterState,
} from "@tanstack/react-router";
import { useEffect } from "react";
import type { ReactNode } from "react";
import { AppNav } from "#/components/AppNav";
import { XRemarkLiveUpdater } from "#/components/XRemarkLiveUpdater";
import { BirdclawQueryProvider } from "#/lib/query-client";
import { ThemeProvider, themeScript } from "#/lib/theme";
import {
	bodyClass,
	mainColumnClass,
	mainColumnDmClass,
	siteShellClass,
} from "#/lib/ui";

import appCss from "../styles.css?url";

const liveVersionManifestPath = "/birdclaw-live-version.json";
const liveVersionPollMs = 30_000;

export const Route = createRootRoute({
	head: () => ({
		meta: [
			{
				charSet: "utf-8",
			},
			{
				name: "viewport",
				content: "width=device-width, initial-scale=1",
			},
			{
				title: "birdclaw",
			},
		],
		links: [
			{
				rel: "stylesheet",
				href: appCss,
			},
		],
	}),
	notFoundComponent: NotFoundView,
	shellComponent: RootDocument,
});

function NotFoundView() {
	return (
		<main className={mainColumnClass}>
			<div className="px-4 py-10 text-[var(--ink-soft)]">Not Found</div>
		</main>
	);
}

function RootDocument({ children }: { children: ReactNode }) {
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});
	const compactNavigation =
		pathname.startsWith("/dms") || pathname.startsWith("/network-map");
	const wideMain = compactNavigation || pathname.startsWith("/discuss");

	return (
		<html lang="en" suppressHydrationWarning>
			<head>
				<HeadContent />
				<script suppressHydrationWarning>{themeScript}</script>
			</head>
			<body className={bodyClass}>
				<BirdclawQueryProvider>
					<ThemeProvider>
						<LiveVersionReloader />
						<XRemarkLiveUpdater />
						<div className={siteShellClass}>
							<AppNav compact={compactNavigation} />
							<main className={wideMain ? mainColumnDmClass : mainColumnClass}>
								{children}
							</main>
						</div>
					</ThemeProvider>
				</BirdclawQueryProvider>
				<Scripts />
			</body>
		</html>
	);
}

function manifestCommit(data: unknown) {
	if (!data || typeof data !== "object") return undefined;
	const commit = (data as { commit?: unknown }).commit;
	return typeof commit === "string" && commit.length > 0 ? commit : undefined;
}

export function LiveVersionReloader({
	manifestPath = liveVersionManifestPath,
	pollMs = liveVersionPollMs,
	reloadPage = () => window.location.reload(),
	fetchManifest = globalThis.fetch,
}: {
	manifestPath?: string;
	pollMs?: number;
	reloadPage?: () => void;
	fetchManifest?: typeof fetch;
}) {
	useEffect(() => {
		let disposed = false;
		let currentCommit: string | undefined;

		async function checkManifest() {
			try {
				const response = await fetchManifest(
					`${manifestPath}?t=${Date.now()}`,
					{ cache: "no-store" },
				);
				if (!response.ok) return;
				const nextCommit = manifestCommit(await response.json());
				if (!nextCommit || disposed) return;
				if (!currentCommit) {
					currentCommit = nextCommit;
					return;
				}
				if (nextCommit !== currentCommit) {
					reloadPage();
				}
			} catch {
				// The manifest only exists for source-served local installs.
			}
		}

		void checkManifest();
		const timer = window.setInterval(() => {
			void checkManifest();
		}, pollMs);

		return () => {
			disposed = true;
			window.clearInterval(timer);
		};
	}, [fetchManifest, manifestPath, pollMs, reloadPage]);

	return null;
}
