import assert from "node:assert/strict";
import test from "node:test";
import { scrapeFollowingPage } from "../following-page-scraper.mjs";

const URL = "https://www.twillot.com/en/twitter-following";

test("rejects unrelated pages without browser operations", async () => {
	await assert.rejects(
		scrapeFollowingPage({ url: () => "https://x.com/home" }),
		{ code: "following_not_ready" },
	);
});

test("a stuck browser acquisition is bounded and its late handle is disposed", async () => {
	let release;
	let disposed = false;
	const result = scrapeFollowingPage(
		{
			url: () => URL,
			isClosed: () => false,
			evaluateHandle: () =>
				new Promise((resolve) => {
					release = resolve;
				}),
		},
		{ timeoutMs: 15 },
	);
	await assert.rejects(result, { code: "following_timeout" });
	release({
		dispose: async () => {
			disposed = true;
		},
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(disposed, true);
});

test(
	"real Chromium collects all 50 virtual rows, resets scrolling, and rejects a stalled renderer",
	{
		skip: process.env.BIRDCLAW_TEST_FOLLOWING_SCRAPER !== "1",
		timeout: 30_000,
	},
	async (t) => {
		const { chromium } = await import("@playwright/test");
		const browser = await chromium.launch({ headless: true });
		try {
			const context = await browser.newContext();
			await context.route(URL, (route) =>
				route.fulfill({
					contentType: "text/html",
					body: `<!doctype html>
<style>body{margin:0}#outer{height:600px;overflow:auto}#grid{height:400px;width:500px;overflow-y:auto}#content{height:3000px;position:relative}.row{height:60px;position:absolute;left:0;right:0}.row img{width:20px;height:20px}.user{height:20px;margin-top:20px}</style>
<div id="outer"><div style="height:40px">Toolbar</div><div id="grid" role="grid"><div id="content"></div></div><div style="height:1000px">Unrelated content</div></div>
<script>
window.offset=0;window.count=50;window.frozen=false;window.renderCalls=0;
const grid=document.querySelector('#grid'), content=document.querySelector('#content');
window.render=()=>{if(window.frozen)return;window.renderCalls++;let start=Math.max(0,Math.floor(grid.scrollTop/60)-3);let end=Math.min(window.count,start+18);content.style.height=(window.count*60)+'px';content.innerHTML=Array.from({length:end-start},(_,i)=>{let index=start+i,id=window.offset+index+1;return '<div class="row" style="top:'+(index*60)+'px"><div role="button" class="user"><a href="/en/export-twitter-posts?publicUid='+id+'"><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="></a><a href="https://x.com/user'+id+'">Name '+id+' @user'+id+'</a></div></div>'}).join('')};
let timer;grid.addEventListener('scroll',()=>{clearTimeout(timer);timer=setTimeout(window.render,45)});window.render();
</script>`,
				}),
			);
			const page = await context.newPage();
			await page.goto(URL);
			assert.equal(await page.locator('a[href*="publicUid"]').count(), 18);
			const logs = [];
			const records = await scrapeFollowingPage(page, {
				timeoutMs: 5_000,
				pollMs: 10,
				settleMs: 70,
				log: (event, detail) => logs.push({ event, ...detail }),
			});
			assert.equal(records.length, 50);
			assert.deepEqual(
				records.map((r) => Number(r.id)).sort((a, b) => a - b),
				Array.from({ length: 50 }, (_, i) => i + 1),
			);
			assert.equal(records[0].name, "Name 1");
			assert.ok(records[0].profileImageUrl);
			assert.deepEqual(
				await page.evaluate(() => ({
					grid: document.querySelector("#grid").scrollTop,
					outer: document.querySelector("#outer").scrollTop,
				})),
				{ grid: 0, outer: 0 },
			);
			assert.ok(logs[0].windows > 1);
			await t.test(
				"next pagination page starts at its top even if scroll position was retained",
				async () => {
					await page.evaluate(() => {
						window.offset = 50;
						document.querySelector("#grid").scrollTop = 900;
						window.render();
					});
					const second = await scrapeFollowingPage(page, {
						timeoutMs: 5_000,
						pollMs: 10,
						settleMs: 70,
					});
					assert.deepEqual(
						second.map((r) => Number(r.id)).sort((a, b) => a - b),
						Array.from({ length: 50 }, (_, i) => i + 51),
					);
					assert.equal(
						await page.evaluate(
							() => document.querySelector("#grid").scrollTop,
						),
						0,
					);
				},
			);
			await t.test("a short nonvirtual final page is complete", async () => {
				await page.evaluate(() => {
					window.offset = 150;
					window.count = 2;
					window.render();
				});
				const last = await scrapeFollowingPage(page, {
					timeoutMs: 2_000,
					pollMs: 10,
					settleMs: 30,
				});
				assert.deepEqual(
					last.map((r) => r.id),
					["151", "152"],
				);
			});
			await t.test(
				"a stalled virtual renderer fails rather than returning its 18-row cache",
				async () => {
					await page.evaluate(() => {
						window.offset = 0;
						window.count = 50;
						window.render();
						window.frozen = true;
					});
					await assert.rejects(
						scrapeFollowingPage(page, {
							timeoutMs: 300,
							pollMs: 10,
							settleMs: 30,
						}),
						{ code: "following_timeout" },
					);
				},
			);
		} finally {
			await browser.close();
		}
	},
);
