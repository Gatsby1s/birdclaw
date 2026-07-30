import { Data, Effect } from "effect";
import { z } from "zod";
import {
	actionResponseSchemaFor,
	type ActionRequest,
	type ActionResponseFor,
	localBookmarkResponseSchema,
	type LocalBookmarkRequest,
	queryEnvelopeSchema,
	queryResponseSchema,
	webSyncJobSchema,
} from "./api-contracts";
import { runEffectPromise } from "./effect-runtime";
import {
	defaultRuntimeServices,
	type RuntimeServices,
} from "./runtime-services";
import type {
	WebSyncJobSnapshot,
	WebSyncKind,
	WebSyncOptions,
} from "./web-sync";
const SYNC_POLL_INTERVAL_MS = 500;

export class ApiFetchError extends Data.TaggedError("ApiFetchError")<{
	readonly message: string;
	readonly status?: number;
	readonly cause?: unknown;
}> {}

function responseMessage(data: unknown, fallback: string) {
	if (data && typeof data === "object") {
		const record = data as {
			message?: unknown;
			error?: unknown;
			summary?: unknown;
		};
		if (typeof record.message === "string") return record.message;
		if (typeof record.error === "string") return record.error;
		if (typeof record.summary === "string") return record.summary;
	}
	return fallback;
}

function apiFetchErrorFromCause(cause: unknown, fallbackMessage: string) {
	if (cause instanceof DOMException && cause.name === "AbortError") {
		return cause;
	}
	if (cause instanceof ApiFetchError) return cause;
	if (cause instanceof Error) {
		return new ApiFetchError({ message: cause.message, cause });
	}
	if (typeof cause === "string") {
		return new ApiFetchError({ message: cause, cause });
	}
	return new ApiFetchError({ message: fallbackMessage, cause });
}

function readJsonEffect(response: Response) {
	return Effect.promise(() => response.json().catch(() => null as unknown));
}

function runApiEffect<T, E>(effect: Effect.Effect<T, E>) {
	return runEffectPromise(effect);
}

export function fetchJsonEffect<T>(
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	schema: z.ZodType<T>,
	fallbackMessage: string,
	runtime: RuntimeServices = defaultRuntimeServices,
) {
	return Effect.gen(function* () {
		const response = yield* Effect.tryPromise({
			try: () =>
				init === undefined ? runtime.fetch(input) : runtime.fetch(input, init),
			catch: (cause) => apiFetchErrorFromCause(cause, fallbackMessage),
		});
		const data = yield* readJsonEffect(response);
		if (!response.ok) {
			return yield* Effect.fail(
				new ApiFetchError({
					message: responseMessage(data, fallbackMessage),
					status: response.status,
				}),
			);
		}

		const parsed = schema.safeParse(data);
		if (!parsed.success) {
			return yield* Effect.fail(
				new ApiFetchError({
					message: fallbackMessage,
					cause: parsed.error,
				}),
			);
		}
		return parsed.data;
	});
}

export function fetchJson<T>(
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	schema: z.ZodType<T>,
	fallbackMessage: string,
	runtime: RuntimeServices = defaultRuntimeServices,
): Promise<T> {
	return runApiEffect(
		fetchJsonEffect(input, init, schema, fallbackMessage, runtime),
	);
}

export function fetchQueryEnvelope(init?: RequestInit) {
	return runApiEffect(fetchQueryEnvelopeEffect(init));
}

export function fetchQueryEnvelopeEffect(init?: RequestInit) {
	return fetchJsonEffect(
		"/api/status",
		init,
		queryEnvelopeSchema,
		"Status unavailable",
	);
}

export function fetchQueryResponse(
	input: RequestInfo | URL,
	init?: RequestInit,
) {
	return runApiEffect(fetchQueryResponseEffect(input, init));
}

export function fetchQueryResponseEffect(
	input: RequestInfo | URL,
	init?: RequestInit,
) {
	return fetchJsonEffect(input, init, queryResponseSchema, "Query unavailable");
}

export function setLocalBookmark(input: LocalBookmarkRequest) {
	return fetchJson(
		"/api/bookmark",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(input),
		},
		localBookmarkResponseSchema,
		"Bookmark update failed",
	);
}

export function postAction<K extends ActionRequest["kind"]>(
	body: Extract<ActionRequest, { kind: K }>,
): Promise<ActionResponseFor<K>> {
	return runApiEffect(postActionEffect(body));
}

export function postActionEffect<K extends ActionRequest["kind"]>(
	body: Extract<ActionRequest, { kind: K }>,
) {
	return fetchJsonEffect(
		"/api/action",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
		actionResponseSchemaFor(body.kind),
		"Action failed",
	);
}

export function postSync(
	kind: WebSyncKind,
	accountId?: string,
	options: WebSyncOptions = {},
) {
	return runApiEffect(postSyncEffect(kind, accountId, options));
}

export function postSyncEffect(
	kind: WebSyncKind,
	accountId?: string,
	options: WebSyncOptions = {},
) {
	return fetchJsonEffect(
		"/api/sync",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				kind,
				...(accountId ? { accountId } : {}),
				...options,
			}),
		},
		webSyncJobSchema,
		"Sync failed",
	).pipe(Effect.flatMap(waitForWebSyncJobEffect));
}

function fetchSyncJobEffect(id: string) {
	const url = new URL("/api/sync", window.location.origin);
	url.searchParams.set("id", id);
	return fetchJsonEffect(
		url,
		undefined,
		webSyncJobSchema,
		"Sync status unavailable",
	);
}

export function waitForWebSyncJobEffect(job: WebSyncJobSnapshot) {
	return Effect.gen(function* () {
		let current = job;
		while (current.inProgress) {
			yield* Effect.sleep(SYNC_POLL_INTERVAL_MS);
			current = yield* fetchSyncJobEffect(current.id);
		}

		if (!current.result) {
			return yield* Effect.fail(
				new ApiFetchError({ message: current.error ?? current.summary }),
			);
		}
		if (!current.result.ok) {
			return yield* Effect.fail(
				new ApiFetchError({
					message: current.result.error ?? current.result.summary,
				}),
			);
		}
		return current.result;
	});
}
