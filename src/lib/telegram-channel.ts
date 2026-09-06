/** Reads only Telegram's unauthenticated public channel preview. */
export type TelegramPublicMedia = {
	kind: "image" | "video" | "audio";
	url: string;
};
export type TelegramPublicPost = {
	id: number;
	text: string;
	publishedAt: string;
	url: string;
	media: TelegramPublicMedia[];
	unsupportedMedia: boolean;
	textUnavailable: boolean;
	forwardedFrom: string | null;
};
export type TelegramChannelPage = {
	posts: TelegramPublicPost[];
	before: number | null;
	coverage: "public_web";
};

type HtmlNode = {
	tag: string;
	attrs: Record<string, string>;
	children: Array<HtmlNode | string>;
};
const VOID_TAGS = new Set([
	"area",
	"base",
	"br",
	"col",
	"embed",
	"hr",
	"img",
	"input",
	"link",
	"meta",
	"param",
	"source",
	"track",
	"wbr",
]);
const MAX_PAGE_BYTES = 2 * 1024 * 1024;

function decodeEntities(value: string) {
	return value.replace(
		/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
		(original, entity: string) => {
			const named: Record<string, string> = {
				amp: "&",
				lt: "<",
				gt: ">",
				quot: '"',
				apos: "'",
				nbsp: " ",
			};
			if (!entity.startsWith("#"))
				return named[entity.toLowerCase()] ?? original;
			const code =
				entity[1]?.toLowerCase() === "x"
					? Number.parseInt(entity.slice(2), 16)
					: Number(entity.slice(1));
			return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
				? String.fromCodePoint(code)
				: "\ufffd";
		},
	);
}

function parseHtml(html: string) {
	if (Buffer.byteLength(html) > MAX_PAGE_BYTES)
		throw new Error("Telegram public page exceeds the size limit");
	const root: HtmlNode = { tag: "root", attrs: {}, children: [] };
	const stack = [root];
	let count = 0;
	for (const match of html.matchAll(
		/<!--[\s\S]*?-->|<![^>]*>|<\/?[a-zA-Z][^>]*>|[^<]+/g,
	)) {
		if (++count > 60_000)
			throw new Error("Telegram public page is too complex");
		const token = match[0];
		if (token.startsWith("<!")) continue;
		const name = token.match(/^<\/?([\w-]+)/)?.[1]?.toLowerCase();
		if (!name) {
			stack[stack.length - 1]?.children.push(decodeEntities(token));
			continue;
		}
		if (token.startsWith("</")) {
			let index = stack.length - 1;
			while (index > 0 && stack[index]?.tag !== name) index--;
			if (index > 0) stack.length = index;
			continue;
		}
		const attrs: Record<string, string> = Object.create(null) as Record<
			string,
			string
		>;
		for (const attr of token.matchAll(
			/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g,
		)) {
			attrs[attr[1]!.toLowerCase()] = decodeEntities(
				attr[2] ?? attr[3] ?? attr[4] ?? "",
			);
		}
		const node: HtmlNode = { tag: name, attrs, children: [] };
		stack[stack.length - 1]?.children.push(node);
		if (!VOID_TAGS.has(name) && !token.endsWith("/>")) {
			if (stack.length >= 100)
				throw new Error("Telegram public page nesting is too deep");
			stack.push(node);
		}
	}
	return root;
}

function descendants(node: HtmlNode): HtmlNode[] {
	return node.children.flatMap((child) =>
		typeof child === "string" ? [] : [child, ...descendants(child)],
	);
}
function hasClass(node: HtmlNode, value: string) {
	return (node.attrs.class ?? "").split(/\s+/).includes(value);
}
function content(node: HtmlNode): string {
	if (["script", "style", "svg"].includes(node.tag)) return "";
	if (node.tag === "br") return "\n";
	if (node.tag === "img") return node.attrs.alt ?? "";
	return (
		node.children
			.map((child) => (typeof child === "string" ? child : content(child)))
			.join("") + (["p", "blockquote"].includes(node.tag) ? "\n" : "")
	);
}

export function normalizeTelegramChannel(value: string) {
	const raw = value.trim();
	let identifier = raw.replace(/^@/, "");
	if (/^https?:\/\//i.test(raw)) {
		const url = new URL(raw);
		if (
			url.protocol !== "https:" ||
			!["t.me", "telegram.me"].includes(url.hostname) ||
			url.username ||
			url.password ||
			url.port
		)
			throw new Error("Use a public https://t.me/channel link");
		const parts = url.pathname.split("/").filter(Boolean);
		if (parts[0] === "s") parts.shift();
		if (parts.length !== 1)
			throw new Error(
				"Use the public channel link, not a private invite or message link",
			);
		identifier = parts[0] ?? "";
	}
	if (
		!/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(identifier) ||
		["joinchat", "share", "login", "proxy", "socks", "c", "s"].includes(
			identifier.toLowerCase(),
		)
	)
		throw new Error("A public Telegram channel username is required");
	return identifier.toLowerCase();
}

export function allowedPersonMediaUrl(value: string) {
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			!url.username &&
			!url.password &&
			!url.port &&
			((url.hostname === "pbs.twimg.com" &&
				/^\/(media|ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb)\//.test(
					url.pathname,
				)) ||
				(url.hostname === "video.twimg.com" &&
					/^\/(ext_tw_video|amplify_video|tweet_video)\//.test(url.pathname)) ||
				(/^cdn\d{1,2}\.telesco\.pe$/.test(url.hostname) &&
					url.pathname.startsWith("/file/")))
		);
	} catch {
		return false;
	}
}

export function parseTelegramChannelPage(
	html: string,
	channel: string,
): TelegramChannelPage {
	const identifier = normalizeTelegramChannel(channel);
	const nodes = descendants(parseHtml(html));
	const posts = new Map<number, TelegramPublicPost>();
	for (const node of nodes.filter((entry) =>
		hasClass(entry, "tgme_widget_message"),
	)) {
		const [owner, rawId] = (node.attrs["data-post"] ?? "").split("/");
		const id = Number(rawId);
		if (
			owner?.toLowerCase() !== identifier ||
			!Number.isSafeInteger(id) ||
			id <= 0
		)
			continue;
		const children = descendants(node);
		const date = children.find(
			(child) => child.tag === "time" && child.attrs.datetime,
		)?.attrs.datetime;
		if (!date || !Number.isFinite(Date.parse(date))) continue;
		const textNode = children.find((child) =>
			hasClass(child, "tgme_widget_message_text"),
		);
		const media = new Map<string, TelegramPublicMedia>();
		for (const child of children) {
			let kind: TelegramPublicMedia["kind"] | undefined;
			let url: string | undefined;
			if (["video", "audio", "source"].includes(child.tag)) {
				kind =
					child.tag === "audio" || child.attrs.type?.startsWith("audio/")
						? "audio"
						: "video";
				url = child.attrs.src;
			} else if (hasClass(child, "tgme_widget_message_photo_wrap")) {
				kind = "image";
				url = child.attrs.style?.match(
					/background-image\s*:\s*url\(\s*['"]?([^'"\s)]+)/i,
				)?.[1];
			}
			if (kind && url && allowedPersonMediaUrl(url))
				media.set(url, { kind, url });
		}
		const forwarded = children.find((child) =>
			hasClass(child, "tgme_widget_message_forwarded_from"),
		);
		const unsupported = children.some((child) =>
			hasClass(child, "message_media_not_supported"),
		);
		const textUnavailable = children.some((child) =>
			hasClass(child, "message_text_not_supported"),
		);
		posts.set(id, {
			id,
			text: textNode
				? content(textNode)
						.replace(/[ \t]+\n/g, "\n")
						.trim()
				: "",
			publishedAt: new Date(date).toISOString(),
			url: `https://t.me/${identifier}/${id}`,
			media: [...media.values()],
			unsupportedMedia: unsupported && media.size === 0,
			textUnavailable,
			forwardedFrom: forwarded ? content(forwarded).trim() || null : null,
		});
	}
	const beforeNode = nodes.find((node) => hasClass(node, "tme_messages_more"));
	const beforeValue = Number(beforeNode?.attrs["data-before"]);
	const before =
		Number.isSafeInteger(beforeValue) && beforeValue > 0 ? beforeValue : null;
	if (
		posts.size === 0 &&
		!nodes.some((node) => hasClass(node, "tgme_channel_history"))
	)
		throw new Error(
			"Telegram public preview is unavailable; the channel may require an authorized Telegram session",
		);
	return {
		posts: [...posts.values()].sort((a, b) => a.id - b.id),
		before,
		coverage: "public_web",
	};
}

export async function readLimitedResponse(response: Response, maximum: number) {
	if (Number(response.headers.get("content-length")) > maximum) {
		await response.body?.cancel();
		throw new Error("Response exceeds the size limit");
	}
	if (!response.body) throw new Error("Response has no body");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maximum) throw new Error("Response exceeds the size limit");
			chunks.push(value);
		}
	} catch (error) {
		await reader.cancel().catch(() => {});
		throw error;
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks, size);
}

export async function fetchTelegramChannelPage(
	channel: string,
	options: { before?: number; fetchImpl?: typeof fetch } = {},
) {
	const identifier = normalizeTelegramChannel(channel);
	const url = new URL(`https://t.me/s/${identifier}`);
	if (options.before !== undefined) {
		if (!Number.isSafeInteger(options.before) || options.before <= 0)
			throw new Error("Invalid Telegram history cursor");
		url.searchParams.set("before", String(options.before));
	}
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 20_000);
	try {
		const response = await (options.fetchImpl ?? fetch)(url, {
			redirect: "manual",
			signal: controller.signal,
			headers: {
				"user-agent": "BirdClaw/1.0 public-channel-archive",
				accept: "text/html",
			},
		});
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(
				`Telegram public preview returned HTTP ${response.status}`,
			);
		}
		if (!response.headers.get("content-type")?.includes("text/html")) {
			await response.body?.cancel();
			throw new Error("Telegram public preview did not return HTML");
		}
		return parseTelegramChannelPage(
			(await readLimitedResponse(response, MAX_PAGE_BYTES)).toString("utf8"),
			identifier,
		);
	} finally {
		clearTimeout(timeout);
	}
}
