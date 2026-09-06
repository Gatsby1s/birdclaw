import { describe, expect, it, vi } from "vitest";
import {
	allowedPersonMediaUrl,
	fetchTelegramChannelPage,
	normalizeTelegramChannel,
	parseTelegramChannelPage,
} from "./telegram-channel";

const html = `<div class="tgme_channel_history"><a class="tme_messages_more" data-before="40"></a>
<div class="tgme_widget_message" data-post="channel/40"><div class="tgme_widget_message_text">Hello <b>world</b><br>中文 &amp; &#x1F600;<div>nested</div><script>bad()</script></div><time datetime="2026-09-06T01:00:00Z"></time><a class="tgme_widget_message_photo_wrap" style="background-image:url('https://cdn1.telesco.pe/file/a.jpg')"></a></div>
<div class="tgme_widget_message" data-post="channel/41"><div class="tgme_widget_message_forwarded_from">Forwarded from Someone</div><video src="https://cdn1.telesco.pe/file/v.mp4?token=a&amp;b=2"></video><div class="message_media_not_supported">browser fallback</div><time datetime="2026-09-06T02:00:00Z"></time></div>
<div class="tgme_widget_message" data-post="channel/42"><div class="message_media_not_supported">Open Telegram</div><div class="message_text_not_supported">Open Telegram</div><time datetime="2026-09-06T03:00:00Z"></time></div></div>`;

describe("Telegram public channel reader", () => {
	it("normalizes public channel identities and rejects private or unsafe targets", () => {
		expect(normalizeTelegramChannel("https://t.me/s/Channel")).toBe("channel");
		for (const input of [
			"https://t.me/+invite",
			"https://t.me/c/123",
			"https://t.me/channel/12",
			"http://t.me/channel",
			"https://localhost/channel",
			"https://t.me@localhost/channel",
		])
			expect(() => normalizeTelegramChannel(input)).toThrow(/public|channel/);
	});
	it("preserves text, dates, forwarding and available media without mistaking browser fallbacks for missing media", () => {
		const page = parseTelegramChannelPage(html, "channel");
		expect(page.before).toBe(40);
		expect(page.coverage).toBe("public_web");
		expect(page.posts[0]?.text).toBe("Hello world\n中文 & 😀nested");
		expect(page.posts[0]?.media[0]?.url).toBe(
			"https://cdn1.telesco.pe/file/a.jpg",
		);
		expect(page.posts[1]).toMatchObject({
			forwardedFrom: "Forwarded from Someone",
			unsupportedMedia: false,
		});
		expect(page.posts[1]?.media[0]?.url).toBe(
			"https://cdn1.telesco.pe/file/v.mp4?token=a&b=2",
		);
		expect(page.posts[2]).toMatchObject({
			unsupportedMedia: true,
			textUnavailable: true,
		});
	});
	it("does not treat inaccessible/login pages as exhausted history", () => {
		expect(() =>
			parseTelegramChannelPage("<html>Download Telegram</html>", "channel"),
		).toThrow(/unavailable/);
		expect(
			parseTelegramChannelPage(
				'<div class="tgme_channel_history"></div>',
				"channel",
			).posts,
		).toEqual([]);
	});
	it("validates media hosts and rejects lookalike, credential-bearing and local URLs", () => {
		expect(
			allowedPersonMediaUrl("https://video.twimg.com/ext_tw_video/a.mp4"),
		).toBe(true);
		for (const input of [
			"http://cdn1.telesco.pe/file/x",
			"https://cdn1.telesco.pe.evil.test/file/x",
			"https://localhost/file/x",
			"https://u:p@cdn1.telesco.pe/file/x",
			"https://pbs.twimg.com/unknown/x",
		])
			expect(allowedPersonMediaUrl(input)).toBe(false);
	});
	it("fetches only a bounded public preview and does not follow redirects", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				new Response(html, { headers: { "content-type": "text/html" } }),
			);
		await fetchTelegramChannelPage("channel", { before: 50, fetchImpl });
		expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
			"https://t.me/s/channel?before=50",
		);
		expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe("manual");
		fetchImpl.mockResolvedValue(
			new Response("", {
				status: 302,
				headers: { location: "http://localhost/private" },
			}),
		);
		await expect(
			fetchTelegramChannelPage("channel", { fetchImpl }),
		).rejects.toThrow("HTTP 302");
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});
	it("rejects oversized bodies", async () => {
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
			new Response("x", {
				headers: { "content-type": "text/html", "content-length": "3000000" },
			}),
		);
		await expect(
			fetchTelegramChannelPage("channel", { fetchImpl }),
		).rejects.toThrow(/size limit/);
	});
});
