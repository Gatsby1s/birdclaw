const RAW_HTTP_URL_PATTERN =
	/https?:\/\/(?:www\.)?t\.co\/[A-Za-z0-9]+|https?:\/\/[^\s<>"'`，。！？；：、（）【】《》“”‘’]+/giu;
const TRAILING_URL_PUNCTUATION = /[)\],.;:!?]+$/;

export interface RawHttpUrlMatch {
	url: string;
	start: number;
	end: number;
}

export function findRawHttpUrls(text: string): RawHttpUrlMatch[] {
	const matches: RawHttpUrlMatch[] = [];
	for (const match of text.matchAll(RAW_HTTP_URL_PATTERN)) {
		const url = match[0].replace(TRAILING_URL_PUNCTUATION, "");
		if (!url) continue;
		const start = match.index ?? 0;
		matches.push({ url, start, end: start + url.length });
	}
	return matches;
}

export function extractRawHttpUrls(text: string) {
	return findRawHttpUrls(text).map((match) => match.url);
}
