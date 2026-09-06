import type {
	PersonDetail,
	PersonItem,
	PersonSummary,
} from "./person-archive-types";

export const personArchiveKeys = ["person-archive"] as const;

async function request<T>(url: string, init?: RequestInit): Promise<T> {
	const response = await fetch(url, init);
	const body = await response.json();
	if (!response.ok || body.ok === false) {
		throw new Error(
			body.message || body.error || "人物资料暂时无法读取，请重试。",
		);
	}
	return body as T;
}

export function fetchPeople(q = "", before?: string, unreadOnly = false) {
	const search = new URLSearchParams({ q });
	if (before) search.set("before", before);
	if (unreadOnly) search.set("unread", "1");
	return request<{
		ok: true;
		people: PersonSummary[];
		nextCursor: string | null;
		total: number;
	}>(`/api/people?${search}`);
}

export function fetchPerson(personId: string) {
	return request<{ ok: true; person: PersonDetail }>(
		`/api/people?personId=${encodeURIComponent(personId)}`,
	);
}

export type PersonAction =
	| {
			action: "create";
			name: string;
			description?: string;
			kind?: "x" | "telegram";
			url?: string;
	  }
	| { action: "update"; personId: string; name: string; description: string }
	| {
			action: "addSource";
			personId: string;
			kind: "x" | "telegram";
			url: string;
	  }
	| { action: "sourceState"; sourceId: string; enabled: boolean }
	| { action: "retry"; sourceId: string }
	| { action: "read"; personId: string; throughSequence: number }
	| { action: "merge"; personId: string; targetPersonId: string }
	| { action: "resolve"; handle: string };

export function personAction(body: PersonAction) {
	return request<{ ok: true; person: PersonDetail }>("/api/people", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

export function fetchPersonItems(
	personId: string,
	kind: string,
	q: string,
	before?: string,
	itemId?: string,
) {
	const search = new URLSearchParams({ personId, kind, q });
	if (before) search.set("before", before);
	if (itemId) search.set("itemId", itemId);
	return request<{
		ok: true;
		items: PersonItem[];
		nextCursor: string | null;
		latestSequence: number;
	}>(`/api/person-items?${search}`);
}

export function uploadPersonFile(form: FormData) {
	return request<{ ok: true; item: PersonItem }>("/api/person-files", {
		method: "POST",
		body: form,
	});
}

export function personFileUrl(id: string) {
	return `/api/person-files?id=${encodeURIComponent(id)}`;
}
