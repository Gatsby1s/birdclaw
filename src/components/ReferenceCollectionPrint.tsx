export interface ReferenceCollectionGroup {
	section: string;
	title: string;
	summary: string;
	tweetIds: string[];
}

export interface ReferenceCollectionTweet {
	id: string;
	author: string;
	name?: string;
	createdAt?: string;
	text: string;
	replyToTweet?: {
		author: string;
		createdAt?: string;
		text: string;
	};
}

export interface ReferenceCollectionDm {
	id: string;
	participant: string;
	name?: string;
	text: string;
}

export interface ReferenceCollectionInsight {
	title: string;
	items: string[];
}

interface ReferenceCollectionPrintProps {
	ariaLabel?: string;
	coverTitle: string;
	documentTitle: string;
	documentSummary: string;
	metadata: string[];
	groups: ReferenceCollectionGroup[];
	tweets: ReferenceCollectionTweet[];
	dms?: ReferenceCollectionDm[];
	insights?: ReferenceCollectionInsight[];
	sectionLabels?: Record<string, string>;
	sectionNotes?: Record<string, string>;
	testId: string;
}

function normalizeTweetId(value: string) {
	const trimmed = value.trim().replace(/^[\s(]+|[\s)]+$/g, "");
	return trimmed.replace(/^tweet[_:]/, "");
}

function tweetLookupKeys(value: string) {
	const normalized = normalizeTweetId(value);
	const withoutPrefix = value.trim().replace(/^tweet_/, "");
	return [
		...new Set([
			value.trim(),
			normalized,
			withoutPrefix,
			`tweet_${normalized}`,
		]),
	];
}

function buildTweetLookup(tweets: ReferenceCollectionTweet[]) {
	const lookup = new Map<string, ReferenceCollectionTweet>();
	for (const tweet of tweets) {
		for (const key of tweetLookupKeys(tweet.id)) lookup.set(key, tweet);
	}
	return lookup;
}

function tweetFor(
	lookup: Map<string, ReferenceCollectionTweet>,
	tweetId: string,
) {
	for (const key of tweetLookupKeys(tweetId)) {
		const tweet = lookup.get(key);
		if (tweet) return tweet;
	}
	return null;
}

function formatAuthor(tweet: ReferenceCollectionTweet) {
	const handle = tweet.author.startsWith("@")
		? tweet.author
		: `@${tweet.author}`;
	const normalizedName = tweet.name?.trim().replace(/^@/, "");
	const normalizedAuthor = tweet.author.trim().replace(/^@/, "");
	return tweet.name && normalizedName !== normalizedAuthor
		? `${tweet.name} (${handle})`
		: handle;
}

function formatDate(value: string | undefined) {
	if (!value) return "";
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) return "";
	return parsed.toLocaleDateString("sv-SE");
}

function ReferenceTweetCard({
	anchorId,
	label,
	tweet,
}: {
	anchorId?: string;
	label: string;
	tweet: ReferenceCollectionTweet | null;
}) {
	if (!tweet) {
		return (
			<section className="today-reference-source">
				<div className="today-reference-source-head" id={anchorId}>
					<span className="today-reference-badge">{label}</span>
					<strong className="today-reference-author">缺失原文</strong>
				</div>
				<p className="today-reference-source-body">
					当前缓存结果里没有这条来源的正文。
				</p>
			</section>
		);
	}
	return (
		<section className="today-reference-source">
			<div className="today-reference-source-head" id={anchorId}>
				<span className="today-reference-badge">{label}</span>
				<strong className="today-reference-author">
					{formatAuthor(tweet)}
				</strong>
				{tweet.createdAt ? (
					<time dateTime={tweet.createdAt}>{formatDate(tweet.createdAt)}</time>
				) : null}
			</div>
			<p className="today-reference-source-body">
				{tweet.text || "(empty text)"}
			</p>
			{tweet.replyToTweet ? (
				<blockquote>
					<strong>
						回复上下文：@{tweet.replyToTweet.author}
						{tweet.replyToTweet.createdAt
							? ` · ${formatDate(tweet.replyToTweet.createdAt)}`
							: ""}
					</strong>
					<span>{tweet.replyToTweet.text}</span>
				</blockquote>
			) : null}
		</section>
	);
}

function ReferenceDmCard({ item }: { item: ReferenceCollectionDm }) {
	return (
		<section className="today-reference-source">
			<div className="today-reference-source-head">
				<span className="today-reference-badge">DM</span>
				<strong className="today-reference-author">
					{item.name || item.participant}
				</strong>
			</div>
			<p className="today-reference-source-body">
				{item.text || "(empty message)"}
			</p>
		</section>
	);
}

export function ReferenceCollectionPrint({
	ariaLabel = "参考内容合集",
	coverTitle,
	documentTitle,
	documentSummary,
	metadata,
	groups,
	tweets,
	dms = [],
	insights = [],
	sectionLabels = {},
	sectionNotes = {},
	testId,
}: ReferenceCollectionPrintProps) {
	const sections: Array<{
		key: string;
		title: string;
		groups: ReferenceCollectionGroup[];
	}> = [];
	const sectionsByKey = new Map<string, (typeof sections)[number]>();
	for (const group of groups) {
		let section = sectionsByKey.get(group.section);
		if (!section) {
			section = {
				key: group.section,
				title: sectionLabels[group.section] ?? group.section,
				groups: [],
			};
			sectionsByKey.set(group.section, section);
			sections.push(section);
		}
		section.groups.push(group);
	}

	const orderedIds: string[] = [];
	const labelsById = new Map<string, string>();
	for (const group of groups) {
		for (const tweetId of group.tweetIds) {
			const normalized = normalizeTweetId(tweetId);
			if (labelsById.has(normalized)) continue;
			orderedIds.push(normalized);
			labelsById.set(
				normalized,
				`S${String(orderedIds.length).padStart(2, "0")}`,
			);
		}
	}

	const tweetLookup = buildTweetLookup(tweets);
	const groupAnchors = new Map(
		groups.map((group, index) => [
			group,
			`reference-topic-${String(index + 1)}`,
		]),
	);
	const groupIndexes = new Map(groups.map((group, index) => [group, index]));
	const firstGroupBySource = new Map<string, number>();
	for (const [groupIndex, group] of groups.entries()) {
		for (const tweetId of group.tweetIds) {
			const normalized = normalizeTweetId(tweetId);
			if (!firstGroupBySource.has(normalized)) {
				firstGroupBySource.set(normalized, groupIndex);
			}
		}
	}
	const sourceLabelsFor = (group: ReferenceCollectionGroup) =>
		group.tweetIds
			.map((tweetId) => labelsById.get(normalizeTweetId(tweetId)))
			.filter((label): label is string => Boolean(label));

	return (
		<article
			aria-label={ariaLabel}
			className="today-reference-pdf"
			data-testid={testId}
		>
			<header className="today-reference-cover today-reference-sheet">
				<h1>{coverTitle}</h1>
				<p className="today-reference-cover-subtitle">{documentTitle}</p>
				<p className="today-reference-cover-summary">{documentSummary}</p>
				<p className="today-reference-cover-meta">
					{metadata.map((line, index) => (
						<span key={`${String(index)}-${line}`}>
							{line}
							{index < metadata.length - 1 ? <br /> : null}
						</span>
					))}
				</p>
				<table className="today-reference-cover-table">
					<tbody>
						<tr>
							<th>排版目标</th>
							<td>
								适合打印、逐条阅读和做边注；黑白打印仍能清楚区分主题与原文。
							</td>
						</tr>
						<tr>
							<th>组织方式</th>
							<td>
								按 AI 讨论中的主题分组，每组摘要后接对应原文；全册使用统一的 S
								编号。
							</td>
						</tr>
						<tr>
							<th>作者信息</th>
							<td>
								每条原文突出显示作者昵称与账号
								ID，只保留发帖日期，不显示点赞量和原文链接。
							</td>
						</tr>
					</tbody>
				</table>
				<h2>本册导航</h2>
				<table className="today-reference-navigation-table">
					<thead>
						<tr>
							<th>内容块</th>
							<th>主题</th>
							<th>原文</th>
							<th>读法</th>
						</tr>
					</thead>
					<tbody>
						{sections.map((section) => (
							<tr key={section.key}>
								<th>{section.title}</th>
								<td>{String(section.groups.length)} 个</td>
								<td>
									{String(
										new Set(section.groups.flatMap(sourceLabelsFor)).size,
									)}{" "}
									条
								</td>
								<td>{sectionNotes[section.key] ?? "按主题阅读。"}</td>
							</tr>
						))}
					</tbody>
				</table>
				<h2 className="today-reference-cover-topics-title">重点主题</h2>
				<ol className="today-reference-cover-topics">
					{groups.slice(0, 6).map((group) => (
						<li key={`cover-${groupAnchors.get(group) ?? group.title}`}>
							{group.title}
						</li>
					))}
				</ol>
			</header>

			<section className="today-reference-guide today-reference-sheet">
				<h2>阅读说明</h2>
				<p>
					这份合集不是网页截图，而是把讨论引用的原始推文重新编成一份可打印文档。每个主题先保留
					AI 总结，随后按引用顺序列出原文。S01、S02
					等是全局来源编号，方便在纸上做标记。
				</p>
				<h2>目录</h2>
				{groups.length > 0 ? (
					<div className="today-reference-toc">
						{sections.map((section) => (
							<section key={section.key}>
								<h3>{section.title}</h3>
								<ol>
									{section.groups.map((group) => (
										<li key={groupAnchors.get(group)}>
											<a href={`#${groupAnchors.get(group) ?? ""}`}>
												<span>{group.title}</span>
												<small
													data-reference-page-target={groupAnchors.get(group)}
												>
													…
												</small>
											</a>
										</li>
									))}
								</ol>
							</section>
						))}
					</div>
				) : (
					<p>当前讨论没有可映射的引用来源。</p>
				)}
			</section>

			{insights
				.filter((section) => section.items.length > 0)
				.map((section) => (
					<section className="today-reference-section" key={section.title}>
						<h2>{section.title}</h2>
						<ul>
							{section.items.map((item) => (
								<li key={item}>{item}</li>
							))}
						</ul>
					</section>
				))}

			<section className="today-reference-matrix today-reference-sheet">
				<h2>来源矩阵</h2>
				<p>
					先看这一页可以知道每个主题涉及哪些原文。文末还有按 S
					编号排序的来源索引。
				</p>
				<table>
					<thead>
						<tr>
							<th>分类</th>
							<th>主题</th>
							<th>来源编号</th>
						</tr>
					</thead>
					<tbody>
						{groups.map((group) => (
							<tr key={`matrix-${groupAnchors.get(group) ?? group.title}`}>
								<td>{sectionLabels[group.section] ?? group.section}</td>
								<td>{group.title}</td>
								<td>{sourceLabelsFor(group).join(", ")}</td>
							</tr>
						))}
					</tbody>
				</table>
			</section>

			{sections.map((section) => (
				<section className="today-reference-section" key={section.key}>
					<h2>{section.title}</h2>
					{section.groups.map((group) => (
						<section
							className="today-reference-group"
							key={groupAnchors.get(group)}
						>
							<h3 id={groupAnchors.get(group)}>{group.title}</h3>
							<p>{group.summary}</p>
							<p className="today-reference-source-list">
								本主题原文：{sourceLabelsFor(group).join(", ")} · 共{" "}
								{String(group.tweetIds.length)} 条
							</p>
							{group.tweetIds.map((tweetId) => {
								const normalized = normalizeTweetId(tweetId);
								const label = labelsById.get(normalized) ?? normalized;
								return (
									<ReferenceTweetCard
										anchorId={
											firstGroupBySource.get(normalized) ===
											groupIndexes.get(group)
												? `reference-source-${label}`
												: undefined
										}
										key={`${groupAnchors.get(group) ?? group.title}-${normalized}`}
										label={label}
										tweet={tweetFor(tweetLookup, tweetId)}
									/>
								);
							})}
						</section>
					))}
				</section>
			))}

			{dms.length > 0 ? (
				<section className="today-reference-section">
					<h2>DM 摘录</h2>
					{dms.map((item) => (
						<ReferenceDmCard item={item} key={item.id} />
					))}
				</section>
			) : null}

			{orderedIds.length > 0 ? (
				<section className="today-reference-index today-reference-sheet">
					<h2>来源索引</h2>
					<p>
						这里按全局编号列出每条原文的作者、账号 ID、推文 ID
						和日期，便于从纸面快速反查。
					</p>
					<table>
						<thead>
							<tr>
								<th>编号</th>
								<th>作者 / 账号 ID</th>
								<th>推文 ID</th>
								<th>日期</th>
								<th>页码</th>
							</tr>
						</thead>
						<tbody>
							{orderedIds.map((tweetId) => {
								const label = labelsById.get(tweetId) ?? tweetId;
								const tweet = tweetFor(tweetLookup, tweetId);
								return (
									<tr key={tweetId}>
										<td>
											<a href={`#reference-source-${label}`}>{label}</a>
										</td>
										<td>{tweet ? formatAuthor(tweet) : "缺失原文"}</td>
										<td>{tweet?.id ?? tweetId}</td>
										<td>{formatDate(tweet?.createdAt)}</td>
										<td>
											<a
												aria-label={`${label} 所在页`}
												className="today-reference-index-page"
												data-reference-page-target={`reference-source-${label}`}
												href={`#reference-source-${label}`}
											>
												…
											</a>
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</section>
			) : null}
		</article>
	);
}
