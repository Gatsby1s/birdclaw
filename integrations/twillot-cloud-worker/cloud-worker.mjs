#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { prepareTwillotExtension } from "./prepare-extension.mjs";
import { applySessionBootstrap } from "./session-bootstrap.mjs";
import {
	DEFAULT_ENDPOINT,
	followingEndpoint,
	normalizeEndpoint,
} from "./worker-core.mjs";

const DEFAULT_PROFILE_DIR = "/data/twillot-browser";
const DEFAULT_SYNC_INTERVAL_MINUTES = 360;
const JOB_POLL_MS = 5_000;
const JOB_RETRY_CLICK_MS = 10 * 60_000;

function positiveNumber(value, fallback) {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readConfig() {
	const token = process.env.BIRDCLAW_TWILLOT_TOKEN?.trim() ?? "";
	if (!/^[A-Za-z0-9_-]{40,128}$/.test(token)) {
		throw new Error("BIRDCLAW_TWILLOT_TOKEN is missing or invalid.");
	}
	return {
		token,
		endpoint: normalizeEndpoint(
			process.env.BIRDCLAW_TWILLOT_ENDPOINT || DEFAULT_ENDPOINT,
		),
		profileDir: process.env.BIRDCLAW_TWILLOT_PROFILE_DIR || DEFAULT_PROFILE_DIR,
		chromiumPath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
		bootstrap: process.env.BIRDCLAW_TWILLOT_BOOTSTRAP_B64,
		syncIntervalMs:
			Math.max(
				60,
				positiveNumber(
					process.env.BIRDCLAW_TWILLOT_FOLLOW_SYNC_INTERVAL_MINUTES,
					DEFAULT_SYNC_INTERVAL_MINUTES,
				),
			) * 60_000,
	};
}

function log(event, detail = {}) {
	process.stdout.write(
		`${JSON.stringify({ time: new Date().toISOString(), event, ...detail })}\n`,
	);
}

async function pairCompanion(context, extensionId, config) {
	const page = await context.newPage();
	await page.goto(
		`chrome-extension://${extensionId}/birdclaw-twillot-options.html`,
		{ waitUntil: "domcontentloaded" },
	);
	await page.locator("#endpoint").fill(config.endpoint);
	await page.locator("#token").fill(config.token);
	await page.locator("#settings-form button[type='submit']").click();
	await page
		.locator("#pairing-status")
		.filter({ hasText: "Configured" })
		.waitFor({
			timeout: 20_000,
		});
	log("companion_paired", { endpoint: config.endpoint });
	return page;
}

async function companionState(extensionPage) {
	return extensionPage.evaluate(async () => {
		const response = await chrome.runtime.sendMessage({
			type: "birdclaw:twillot:get-state",
		});
		if (!response?.ok)
			throw new Error(response?.error || "Companion unavailable");
		return response.state;
	});
}

async function companionSyncNow(extensionPage) {
	return extensionPage.evaluate(async () => {
		const response = await chrome.runtime.sendMessage({
			type: "birdclaw:twillot:sync-now",
		});
		if (!response?.ok)
			throw new Error(response?.error || "Companion sync failed");
		return response;
	});
}

async function scrapeFollowingPage(page) {
	const records = await page
		.locator('a[href*="export-twitter-posts?publicUid="]')
		.evaluateAll((anchors) =>
			anchors.flatMap((anchor) => {
				const href = anchor.getAttribute("href") || "";
				const id = new URL(href, location.href).searchParams.get("publicUid");
				const container =
					anchor.closest("button") || anchor.parentElement?.parentElement;
				const profileLink = container?.querySelector(
					'a[href^="https://x.com/"]',
				);
				const profileUrl = profileLink?.getAttribute("href") || "";
				const username = new URL(
					profileUrl || "https://x.com/",
					location.href,
				).pathname
					.split("/")[1]
					?.replace(/^@/, "");
				if (!id || !username) return [];
				const text = (profileLink?.textContent || username).trim();
				const name = text
					.replace(new RegExp(`\\s*@${username}\\s*$`, "i"), "")
					.trim();
				const image = anchor.querySelector("img");
				return [
					{
						id,
						username,
						name: name || username,
						...(image?.src ? { profileImageUrl: image.src } : {}),
					},
				];
			}),
		);
	return records;
}

async function uploadFollowingSnapshot(
	extensionPage,
	config,
	users,
	pageCount,
) {
	const url = followingEndpoint(config.endpoint);
	const result = await extensionPage.evaluate(
		async ({ url, token, users, pageCount }) => {
			const response = await fetch(url, {
				method: "POST",
				credentials: "omit",
				cache: "no-store",
				headers: {
					Accept: "application/json",
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					action: "following_snapshot",
					users,
					pageCount,
					complete: true,
				}),
			});
			const data = await response.json().catch(() => ({}));
			if (!response.ok || data.ok === false) {
				throw new Error(data.message || `HTTP ${response.status}`);
			}
			return data;
		},
		{ url, token: config.token, users, pageCount },
	);
	log("following_uploaded", { count: users.length, pageCount });
	return result;
}

async function syncFollowing(context, extensionPage, config) {
	let page = context
		.pages()
		.find((candidate) =>
			candidate.url().includes("twillot.com/twitter-following"),
		);
	if (!page) page = await context.newPage();
	await page.goto("https://www.twillot.com/en/twitter-following", {
		waitUntil: "domcontentloaded",
	});
	const connect = page.getByRole("button", { name: /Connect Twitter Now/i });
	if (await connect.isVisible().catch(() => false)) {
		throw new Error("The cloud Chromium profile is not connected to X.");
	}
	const sync = page
		.getByRole("button", {
			name: /Sync Twitter following to your local browser|Sync Following/i,
		})
		.first();
	if ((await sync.isVisible().catch(() => false)) && (await sync.isEnabled())) {
		await sync.click();
		await page.waitForTimeout(8_000);
	}
	const first = page.getByRole("button", { name: "Go to first page" });
	if (
		(await first.isVisible().catch(() => false)) &&
		(await first.isEnabled())
	) {
		await first.click();
		await page.waitForTimeout(500);
	}
	const users = new Map();
	let pageCount = 0;
	for (; pageCount < 1_000; pageCount += 1) {
		for (const user of await scrapeFollowingPage(page)) {
			users.set(user.username.toLowerCase(), user);
		}
		const next = page.getByRole("button", { name: "Next page" });
		if (
			!(await next.isVisible().catch(() => false)) ||
			!(await next.isEnabled())
		) {
			pageCount += 1;
			break;
		}
		await next.click();
		await page.waitForTimeout(500);
	}
	const followingLabel = await page
		.getByRole("link", { name: /^Following \d+$/ })
		.first()
		.innerText()
		.catch(() => "");
	const expectedCount = Number(followingLabel.match(/\d+/)?.[0]);
	if (
		!users.size ||
		!Number.isFinite(expectedCount) ||
		users.size !== expectedCount
	) {
		throw new Error(
			`Twillot following snapshot is incomplete (${users.size}/${Number.isFinite(expectedCount) ? expectedCount : "unknown"}).`,
		);
	}
	return uploadFollowingSnapshot(
		extensionPage,
		config,
		[...users.values()],
		pageCount,
	);
}

async function clickActiveJob(context, extensionPage, clickedJobs) {
	const state = await companionState(extensionPage);
	const job = state.activeJob;
	if (!job?.id) return;
	const lastClick = clickedJobs.get(job.id) || 0;
	if (Date.now() - lastClick < JOB_RETRY_CLICK_MS) {
		await companionSyncNow(extensionPage);
		return;
	}
	const page = context.pages().find((candidate) => {
		if (!candidate.url().includes("twillot.com")) return false;
		const publicUid = new URL(candidate.url()).searchParams.get("publicUid");
		return [job.handle, job.externalUserId]
			.filter(Boolean)
			.some(
				(value) => String(value).toLowerCase() === publicUid?.toLowerCase(),
			);
	});
	if (!page) return;
	await page.waitForLoadState("domcontentloaded");
	const syncButton = page
		.getByRole("button", {
			name: /Sync Twitter posts to your local browser|^Sync Posts$|^同步推文$/i,
		})
		.first();
	if (!(await syncButton.isVisible().catch(() => false))) return;
	if (await syncButton.isEnabled()) {
		await syncButton.click();
		clickedJobs.set(job.id, Date.now());
		log("twillot_job_started", { jobId: job.id, handle: job.handle });
	}
	await companionSyncNow(extensionPage);
}

export async function runCloudWorker() {
	const config = readConfig();
	const prepared = await prepareTwillotExtension();
	let context;
	try {
		context = await chromium.launchPersistentContext(
			path.resolve(config.profileDir),
			{
				executablePath: config.chromiumPath,
				headless: false,
				args: [
					`--disable-extensions-except=${prepared.bridgePath}`,
					`--load-extension=${prepared.bridgePath}`,
					"--disable-dev-shm-usage",
					"--no-sandbox",
					"--no-first-run",
					"--no-default-browser-check",
				],
			},
		);
		const bootstrap = await applySessionBootstrap(
			context,
			path.resolve(config.profileDir),
			config.bootstrap,
		);
		if (bootstrap.applied) {
			log("session_bootstrap_applied", {
				cookieCount: bootstrap.cookieCount,
			});
		}
		const extensionPage = await pairCompanion(
			context,
			prepared.extensionId,
			config,
		);
		const clickedJobs = new Map();
		let nextFollowingSyncAt = 0;
		let stopping = false;
		const stop = () => {
			stopping = true;
		};
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
		log("worker_ready", { profileDir: config.profileDir });
		while (!stopping) {
			try {
				if (Date.now() >= nextFollowingSyncAt) {
					await syncFollowing(context, extensionPage, config);
					nextFollowingSyncAt = Date.now() + config.syncIntervalMs;
				}
				await clickActiveJob(context, extensionPage, clickedJobs);
			} catch (error) {
				log("worker_cycle_error", {
					message: error instanceof Error ? error.message : String(error),
				});
				if (nextFollowingSyncAt <= Date.now()) {
					nextFollowingSyncAt = Date.now() + 5 * 60_000;
				}
			}
			await new Promise((resolve) => setTimeout(resolve, JOB_POLL_MS));
		}
	} finally {
		await context?.close().catch(() => {});
		await prepared.cleanup();
	}
}

const isDirectRun =
	process.argv[1] &&
	pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
	runCloudWorker().catch((error) => {
		log("worker_fatal", {
			message: error instanceof Error ? error.message : String(error),
		});
		process.exitCode = 1;
	});
}
