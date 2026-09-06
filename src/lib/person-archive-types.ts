export type PersonSourceKind = "x" | "telegram";
export interface PersonSource {
	id: string;
	personId: string;
	kind: PersonSourceKind;
	identifier: string;
	url: string;
	enabled: boolean;
	historyStatus: string;
	lastSyncedAt: string | null;
	lastError: string | null;
	itemCount: number;
	mediaStoredCount: number;
	mediaPendingCount: number;
	mediaFailedCount: number;
	coverage: string;
}
export interface PersonSummary {
	id: string;
	name: string;
	description: string;
	avatarUrl: string | null;
	sources: PersonSource[];
	itemCount: number;
	unreadCount: number;
	updatedAt: string;
}
export interface PersonDetail extends PersonSummary {
	createdAt: string;
	latestSequence: number;
	stats: { items: number; media: number; documents: number; unread: number };
}
export interface PersonMedia {
	id: string;
	kind: string;
	mimeType: string | null;
	url: string | null;
	remoteUrl: string;
	storageStatus: string;
}
export interface PersonItem {
	id: string;
	personId: string;
	sourceId: string | null;
	kind: "x" | "telegram" | "document";
	title: string;
	text: string;
	textTruncated?: boolean;
	publishedAt: string;
	ingestedAt: string;
	sourceUrl: string | null;
	media: PersonMedia[];
	document?: {
		filename: string;
		downloadUrl: string;
		extractionStatus: string;
	};
	ragStatus: string;
	attribution: string | null;
}
