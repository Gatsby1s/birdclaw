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

		const dimensions = await page.evaluate(() => ({
			clientWidth: document.documentElement.clientWidth,
			scrollWidth: document.documentElement.scrollWidth,
		}));
		expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);

		await mobileNav.getByText("More", { exact: true }).click();
		await mobileNav.getByRole("link", { name: "DMs" }).click();
		await expect(page.getByRole("heading", { name: "Messages" })).toBeVisible();
	});
});

test.describe("mobile landscape shell", () => {
	test.use({ viewport: { width: 844, height: 390 } });

	test("keeps the fixed navigation inside the viewport", async ({ page }) => {
		await page.goto("/settings");
		const mobileNav = page.getByRole("navigation", {
			name: "Mobile primary",
		});
		await expect(mobileNav).toBeVisible();
		const box = await mobileNav.boundingBox();
		expect(box).not.toBeNull();
		expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(391);
	});
});
