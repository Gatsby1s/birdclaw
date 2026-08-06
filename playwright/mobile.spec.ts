import { expect, test } from "@playwright/test";

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
		await expect.poll(async () => cards.count()).toBeGreaterThan(0);
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

	test("edits and persists a private note on an author profile", async ({
		page,
	}) => {
		await page.goto("/authors/avawires");
		await expect(
			page.getByRole("heading", { name: "Ava Wires" }).first(),
		).toBeVisible();
		await page.getByRole("button", { name: "Add note" }).click();
		await page
			.getByRole("textbox", { name: "Private note" })
			.fill("Mobile profile note");
		await page.getByRole("button", { name: "Save note" }).click();
		const profileNote = page.getByRole("region", {
			name: "Private note for @avawires",
		});
		await expect(profileNote.getByText("Mobile profile note")).toBeVisible();

		await page.reload();
		await expect(profileNote.getByText("Mobile profile note")).toBeVisible();
		await expect(page.getByRole("button", { name: "Edit note" })).toBeVisible();
	});
});

test.describe("mobile landscape shell", () => {
	test.use({ viewport: { width: 844, height: 390 } });

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
