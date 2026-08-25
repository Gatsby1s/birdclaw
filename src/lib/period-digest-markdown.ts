import type { PeriodDigest } from "#/lib/period-digest";

type DigestTopic = Pick<
	PeriodDigest["keyTopics"][number],
	"title" | "tweetIds"
>;

type BulletBlock = {
	start: number;
	end: number;
	tweetIds: Set<string>;
};

function normalizeTweetId(id: string) {
	return id.trim().replace(/^tweet_/i, "");
}

function normalizeTitle(title: string) {
	return title.replace(/\s+/g, " ").trim();
}

function comparableTitle(title: string) {
	return normalizeTitle(title).normalize("NFKC").toLocaleLowerCase();
}

function tweetIdsInMarkdownBlock(lines: string[]) {
	const ids = new Set<string>();
	const text = lines.join("\n");
	for (const match of text.matchAll(/\btweet_([A-Za-z0-9_-]+)\b/gi)) {
		if (match[1]) ids.add(normalizeTweetId(match[1]));
	}
	for (const match of text.matchAll(/\b\d{12,25}\b/g)) {
		ids.add(normalizeTweetId(match[0]));
	}
	return ids;
}

function isCoarseSectionHeading(line: string) {
	const trimmed = line.trim();
	return /^##(?!#)\s+\S/.test(trimmed) || /^\*\*[^*]+\*\*$/.test(trimmed);
}

function topicSectionRange(lines: string[]) {
	const boundaries = lines.flatMap((line, index) =>
		isCoarseSectionHeading(line) ? [index] : [],
	);
	if (boundaries.length === 0) return { start: 0, end: lines.length };
	return {
		start: boundaries[0] + 1,
		end: boundaries[1] ?? lines.length,
	};
}

function bulletBlocks(lines: string[], start: number, end: number) {
	const blocks: BulletBlock[] = [];
	for (let index = start; index < end; index += 1) {
		if (!/^\s*[-*+]\s+/.test(lines[index] ?? "")) continue;
		let blockEnd = index + 1;
		while (blockEnd < end && !/^\s*[-*+]\s+/.test(lines[blockEnd] ?? "")) {
			blockEnd += 1;
		}
		blocks.push({
			start: index,
			end: blockEnd,
			tweetIds: tweetIdsInMarkdownBlock(lines.slice(index, blockEnd)),
		});
		index = blockEnd - 1;
	}
	return blocks;
}

function previousNonEmptyLine(lines: string[], index: number, floor: number) {
	for (let cursor = index - 1; cursor >= floor; cursor -= 1) {
		if (lines[cursor]?.trim()) return lines[cursor]?.trim() ?? "";
	}
	return "";
}

function hasVisualTopicHeading(
	lines: string[],
	block: BulletBlock,
	floor: number,
) {
	const previousLine = previousNonEmptyLine(lines, block.start, floor);
	return (
		/^#{3,6}\s+\S/.test(previousLine) ||
		/^\s*[-*+]\s+\*\*\S[^*]*\*\*/.test(lines[block.start] ?? "")
	);
}

export function injectTopicHeadings(markdown: string, topics: DigestTopic[]) {
	if (!markdown.trim() || topics.length === 0) return markdown;

	const newline = markdown.includes("\r\n") ? "\r\n" : "\n";
	const lines = markdown.split(/\r?\n/);
	const section = topicSectionRange(lines);
	const blocks = bulletBlocks(lines, section.start, section.end);
	if (blocks.length === 0) return markdown;

	const normalizedTopics = topics.map((topic) => ({
		title: normalizeTitle(topic.title),
		tweetIds: new Set(topic.tweetIds.map(normalizeTweetId).filter(Boolean)),
	}));
	const tweetIdOwners = new Map<string, number>();
	for (const topic of normalizedTopics) {
		for (const id of topic.tweetIds) {
			tweetIdOwners.set(id, (tweetIdOwners.get(id) ?? 0) + 1);
		}
	}

	const existingHeadings = lines.flatMap((line, index) => {
		if (index < section.start || index >= section.end) return [];
		const match = /^#{3,6}\s+(.+?)\s*#*\s*$/.exec(line.trim());
		return match?.[1] ? [{ index, title: comparableTitle(match[1]) }] : [];
	});
	const insertions = new Map<number, string>();
	let cursor = section.start;

	for (
		let topicIndex = 0;
		topicIndex < normalizedTopics.length;
		topicIndex += 1
	) {
		const topic = normalizedTopics[topicIndex];
		if (!topic?.title || topic.tweetIds.size === 0) continue;

		const existingHeading = existingHeadings.find(
			(heading) => heading.title === comparableTitle(topic.title),
		);
		if (existingHeading) {
			cursor = Math.max(cursor, existingHeading.index + 1);
			continue;
		}

		const match = blocks.find((block) => {
			if (block.start < cursor) return false;
			const sharedIds = [...block.tweetIds].filter((id) =>
				topic.tweetIds.has(id),
			);
			if (sharedIds.length === 0) return false;
			if (sharedIds.some((id) => tweetIdOwners.get(id) === 1)) return true;

			const matchingTopics = normalizedTopics.filter((candidate) =>
				[...block.tweetIds].some((id) => candidate.tweetIds.has(id)),
			);
			return matchingTopics.length === 1;
		});
		if (!match) continue;

		cursor = match.end;
		if (hasVisualTopicHeading(lines, match, section.start)) continue;
		insertions.set(match.start, topic.title);
	}

	if (insertions.size === 0) return markdown;
	const output: string[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		const title = insertions.get(index);
		if (title) {
			if (output.length > 0 && output.at(-1)?.trim()) output.push("");
			output.push(`### ${title}`, "");
		}
		output.push(lines[index] ?? "");
	}
	return output.join(newline);
}
