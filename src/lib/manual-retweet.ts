export function parseManualRetweet(text: string) {
	const match = text.match(/^RT\s+@([A-Za-z0-9_]{1,15}):\s*([\s\S]+)$/);
	if (!match?.[1] || !match[2]) {
		return null;
	}
	return {
		handle: match[1],
		text: match[2].trim(),
	};
}
