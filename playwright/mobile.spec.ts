import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

async function expectCoreActionsInsideCard({
	card,
	page,
}: {
	card: Locator;
	page: Page;
}) {
	const actionBar = card.locator('[data-perf="timeline-actions"]');
	await expect(actionBar).toBeVisible();
	const actions = [
		actionBar.getByRole("button", { name: /conversation$/ }),
		actionBar.getByRole("button", { name: "Reply", exact: true }),
		actionBar.getByRole("link", { name: /^Analyse @/ }),
		actionBar.getByRole("button", {
			name: /^(?:Bookmark locally|Remove local bookmark)$/,
		}),
		actionBar.getByLabel(/ likes$/),
	];
	const cardBox = await card.boundingBox();
	const actionBarBox = await actionBar.boundingBox();
	const viewport = page.viewportSize();
	expect(cardBox).not.toBeNull();
	expect(actionBarBox).not.toBeNull();
	expect(viewport).not.toBeNull();
	if (!cardBox || !actionBarBox || !viewport) return;

	for (const action of actions) {
		await expect(action).toBeVisible();
		const box = await action.boundingBox();
		expect(box).not.toBeNull();
		if (!box) continue;
		expect(box.x).toBeGreaterThanOrEqual(cardBox.x - 0.5);
		expect(box.x + box.width).toBeLessThanOrEqual(
			Math.min(cardBox.x + cardBox.width, viewport.width) + 0.5,
		);
		expect(box.x).toBeGreaterThanOrEqual(actionBarBox.x - 0.5);
		expect(box.x + box.width).toBeLessThanOrEqual(
			actionBarBox.x + actionBarBox.width + 0.5,
		);
	}

	for (const action of actions.slice(0, 4)) {
		const box = await action.boundingBox();
		expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
	}
	const dimensions = await page.evaluate(() => ({
		clientWidth: document.documentElement.clientWidth,
		scrollWidth: document.documentElement.scrollWidth,
	}));
	expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
}

async function expectHeaderActionsInsideCard({
	card,
	requireTouchTarget = true,
}: {
	card: Locator;
	requireTouchTarget?: boolean;
}) {
	const printAction = card.getByRole("button", { name: "Print tweet" });
	const openAction = card.getByRole("link", { name: "Reply open" });
	await expect(printAction).toBeVisible();
	await expect(openAction).toBeVisible();
	const cardBox = await card.boundingBox();
	const printBox = await printAction.boundingBox();
	const openBox = await openAction.boundingBox();
	expect(cardBox).not.toBeNull();
	expect(printBox).not.toBeNull();
	expect(openBox).not.toBeNull();
	if (!cardBox || !printBox || !openBox) return;
	for (const box of [printBox, openBox]) {
		expect(box.x).toBeGreaterThanOrEqual(cardBox.x - 0.5);
		expect(box.x + box.width).toBeLessThanOrEqual(
			cardBox.x + cardBox.width + 0.5,
		);
	}
	expect(printBox.x + printBox.width).toBeLessThanOrEqual(openBox.x + 0.5);
	if (requireTouchTarget) {
		expect(printBox.width).toBeGreaterThanOrEqual(44);
		expect(printBox.height).toBeGreaterThanOrEqual(44);
	}
}

test.describe("mobile shell", () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test("uses touch navigation without horizontal overflow", async ({
		page,
	}) => {
		await page.goto("/");
		await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
		const mobileNav = page.getByRole("navigation", {
			name: "Mobile primary",
		});
		await expect(mobileNav).toBeVisible();
		await expect(
			page.getByRole("navigation", { name: "Primary", exact: true }),
		).toBeHidden();
		await expect(mobileNav.getByRole("link", { name: "Home" })).toBeVisible();
		const homeHeading = page.getByRole("heading", { name: "Home" });
		const homeHeader = page
			.locator("header")
			.filter({ has: homeHeading })
			.first();
		expect(
			await homeHeader.evaluate(
				(element) => getComputedStyle(element).position,
			),
		).toBe("static");
		const cards = page.locator('[data-perf="timeline-card"]');
		await expect
			.poll(async () => cards.count(), { timeout: 15_000 })
			.toBeGreaterThan(0);
		const repliedTab = page.getByRole("button", {
			name: "Replied",
			exact: true,
		});
		await repliedTab.click();
		await expect(repliedTab).toHaveAttribute("aria-pressed", "true");

		const dimensions = await page.evaluate(() => ({
			clientWidth: document.documentElement.clientWidth,
			scrollWidth: document.documentElement.scrollWidth,
		}));
		expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);

		await mobileNav.getByText("More", { exact: true }).click();
		await mobileNav.getByRole("link", { name: "DMs" }).click();
		await expect(page.getByRole("heading", { name: "Messages" })).toBeVisible();
	});

	test("edits and persists both private note fields on an author profile", async ({
		page,
	}) => {
		await page.goto("/authors/avawires");
		await expect(
			page.getByRole("heading", { name: "Ava Wires" }).first(),
		).toBeVisible();
		await page.getByRole("button", { name: "Add note" }).click();
		await page.getByRole("textbox", { name: "Remark" }).fill("Mobile remark");
		await page
			.getByRole("textbox", { name: "Description" })
			.fill("Mobile profile description");
		await page.getByRole("button", { name: "Save note" }).click();
		const profileNote = page.getByRole("region", {
			name: "Private note for @avawires",
		});
		await expect(profileNote.getByText("Mobile remark")).toBeVisible();
		await expect(
			profileNote.getByText("Mobile profile description"),
		).toBeVisible();

		await page.reload();
		await expect(profileNote.getByText("Mobile remark")).toBeVisible();
		await expect(
			profileNote.getByText("Mobile profile description"),
		).toBeVisible();
		await expect(page.getByRole("button", { name: "Edit note" })).toBeVisible();
	});

	test("keeps every card action in view and persists a local bookmark", async ({
		page,
	}) => {
		await page.goto("/");
		const surveyCard = page.locator('[data-perf="timeline-card"]').filter({
			hasText: "New developer-platform pricing survey",
		});
		await expect(surveyCard).toBeVisible();
		await expectCoreActionsInsideCard({ card: surveyCard, page });
		await expectHeaderActionsInsideCard({ card: surveyCard });

		await page.setViewportSize({ width: 320, height: 800 });
		await expectCoreActionsInsideCard({ card: surveyCard, page });
		await expectHeaderActionsInsideCard({ card: surveyCard });
		const bookmarkButton = surveyCard.getByRole("button", {
			name: "Bookmark locally",
		});
		const bookmarkResponse = page.waitForResponse(
			(response) =>
				response.url().endsWith("/api/bookmark") &&
				response.request().method() === "POST",
		);
		await bookmarkButton.click();
		expect((await bookmarkResponse).ok()).toBe(true);
		await expect(
			surveyCard.getByRole("button", { name: "Remove local bookmark" }),
		).toHaveAttribute("aria-pressed", "true");

		await page.reload();
		const reloadedSurveyCard = page
			.locator('[data-perf="timeline-card"]')
			.filter({ hasText: "New developer-platform pricing survey" });
		await expect(
			reloadedSurveyCard.getByRole("button", {
				name: "Remove local bookmark",
			}),
		).toHaveAttribute("aria-pressed", "true");

		await page.goto("/bookmarks");
		const savedSurveyCard = page
			.locator('[data-perf="timeline-card"]')
			.filter({ hasText: "New developer-platform pricing survey" });
		await expect(savedSurveyCard).toBeVisible();
		const removeResponse = page.waitForResponse(
			(response) =>
				response.url().endsWith("/api/bookmark") &&
				response.request().method() === "POST",
		);
		await savedSurveyCard
			.getByRole("button", { name: "Remove local bookmark" })
			.click();
		expect((await removeResponse).ok()).toBe(true);
		await expect(savedSurveyCard).toHaveCount(0);

		await page.goto("/");
		await expect(
			page
				.locator('[data-perf="timeline-card"]')
				.filter({ hasText: "New developer-platform pricing survey" })
				.getByRole("button", { name: "Bookmark locally" }),
		).toHaveAttribute("aria-pressed", "false");
	});

	test("keeps the author preview inside the viewport from avatar and name", async ({
		page,
	}) => {
		await page.goto("/");
		const surveyCard = page.locator('[data-perf="timeline-card"]').filter({
			hasText: "New developer-platform pricing survey",
		});
		await expect(surveyCard).toBeVisible({ timeout: 15_000 });
		const preview = page.getByRole("group", {
			name: "Ava Wires profile preview",
		});

		for (const width of [390, 320]) {
			await page.setViewportSize({ width, height: 844 });
			for (const trigger of [
				surveyCard.getByRole("link", { name: "Ava Wires @avawires" }),
				surveyCard.getByRole("link", {
					name: "View @avawires local posts",
				}),
			]) {
				await trigger.hover();
				await expect(preview).toBeVisible();
				const box = await preview.boundingBox();
				expect(box).not.toBeNull();
				if (!box) continue;
				expect(box.x).toBeGreaterThanOrEqual(11.5);
				expect(box.x + box.width).toBeLessThanOrEqual(width - 11.5);
				expect(box.y).toBeGreaterThanOrEqual(11.5);
				expect(box.y + box.height).toBeLessThanOrEqual(832.5);
				expect(
					await preview.evaluate((element) => {
						const rect = element.getBoundingClientRect();
						return (
							document
								.elementFromPoint(rect.right - 2, rect.top + 16)
								?.closest('[role="group"]') === element
						);
					}),
				).toBe(true);
				await page.mouse.move(0, 0);
				await expect(preview).toBeHidden();
			}
		}
	});
});

test.describe("mobile landscape shell", () => {
	test.use({ viewport: { width: 844, height: 390 } });

	test("keeps print and open inside cards with long author names", async ({
		page,
	}) => {
		await page.goto("/");
		const card = page
			.locator(
				'[data-perf="timeline-card"]:has(button[aria-label="Print tweet"]):has(a[aria-label="Reply open"])',
			)
			.first();
		await expect(card).toBeVisible({ timeout: 15_000 });
		const authorLink = card.locator('header a[href^="/authors/"]').first();
		await authorLink.evaluate((element) => {
			const labels = element.querySelectorAll("span");
			if (labels.length < 3) throw new Error("Author labels are unavailable");
			labels[labels.length - 2].textContent =
				"An Exceptionally Long Display Name From the Production Timeline";
			labels[labels.length - 1].textContent =
				"@an_exceptionally_long_production_handle";
		});

		await expectHeaderActionsInsideCard({ card, requireTouchTarget: false });
	});

	test("keeps the header scrollable and fixed navigation in view", async ({
		page,
	}) => {
		await page.goto("/");
		const homeHeading = page.getByRole("heading", { name: "Home" });
		const homeHeader = page
			.locator("header")
			.filter({ has: homeHeading })
			.first();
		expect(
			await homeHeader.evaluate(
				(element) => getComputedStyle(element).position,
			),
		).toBe("static");
		const cards = page.locator('[data-perf="timeline-card"]');
		await expect.poll(async () => cards.count()).toBeGreaterThan(0);
		for (const label of ["All", "Unreplied", "Replied"]) {
			await expect(
				page.getByRole("button", { name: label, exact: true }),
			).toBeVisible();
		}
		const unrepliedTab = page.getByRole("button", {
			name: "Unreplied",
			exact: true,
		});
		await unrepliedTab.click();
		await expect(unrepliedTab).toHaveAttribute("aria-pressed", "true");
		const mobileNav = page.getByRole("navigation", {
			name: "Mobile primary",
		});
		await expect(mobileNav).toBeVisible();
		const box = await mobileNav.boundingBox();
		expect(box).not.toBeNull();
		expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(391);
	});
});
