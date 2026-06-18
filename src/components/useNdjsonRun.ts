import { useCallback, useEffect, useRef, useState } from "react";
import type { z } from "zod";
import { responseError } from "#/lib/client-http";
import { consumeNdjson } from "#/lib/client-ndjson";

export interface NdjsonRunContext {
	signal: AbortSignal;
	isActive: () => boolean;
}

interface UseNdjsonRunOptions<TEvent, TArgs extends unknown[]> {
	schema: z.ZodType<TEvent>;
	request: (signal: AbortSignal, ...args: TArgs) => Promise<Response>;
	onStart?: (context: NdjsonRunContext, ...args: TArgs) => void;
	onEvent: (event: TEvent, context: NdjsonRunContext) => void | Promise<void>;
	onError?: (cause: unknown) => void;
	isTerminal: (event: TEvent) => boolean;
	errorLabel: string;
	emptyBodyMessage: string;
	prematureEofError: () => Error;
	formatError?: (cause: unknown) => string;
	statusMessages?: Readonly<Record<number, string>>;
}

function defaultErrorMessage(cause: unknown) {
	return cause instanceof Error ? cause.message : String(cause);
}

export function useNdjsonRun<TEvent, TArgs extends unknown[]>({
	schema,
	request,
	onStart,
	onEvent,
	onError,
	isTerminal,
	errorLabel,
	emptyBodyMessage,
	prematureEofError,
	formatError = defaultErrorMessage,
	statusMessages,
}: UseNdjsonRunOptions<TEvent, TArgs>) {
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const abortRef = useRef<AbortController | null>(null);
	const requestIdRef = useRef(0);

	const run = useCallback(
		(...args: TArgs) => {
			abortRef.current?.abort();
			const controller = new AbortController();
			const requestId = requestIdRef.current + 1;
			requestIdRef.current = requestId;
			abortRef.current = controller;
			const isActive = () =>
				abortRef.current === controller &&
				requestIdRef.current === requestId &&
				!controller.signal.aborted;
			const context = { signal: controller.signal, isActive };

			setError(null);
			setLoading(true);
			onStart?.(context, ...args);

			void request(controller.signal, ...args)
				.then(async (response) => {
					if (!isActive()) return;
					if (!response.ok) {
						throw await responseError(response, {
							label: errorLabel,
							statusMessages,
						});
					}
					if (!response.body) throw new Error(emptyBodyMessage);
					await consumeNdjson({
						body: response.body,
						schema,
						signal: controller.signal,
						isTerminal,
						prematureEofError,
						onEvent: async (event) => {
							if (isActive()) await onEvent(event, context);
						},
					});
				})
				.catch((cause: unknown) => {
					if (isActive()) {
						onError?.(cause);
						setError(formatError(cause));
					}
				})
				.finally(() => {
					if (isActive()) setLoading(false);
				});
		},
		[
			emptyBodyMessage,
			errorLabel,
			formatError,
			isTerminal,
			onEvent,
			onError,
			onStart,
			prematureEofError,
			request,
			schema,
			statusMessages,
		],
	);

	useEffect(() => () => abortRef.current?.abort(), []);

	return { error, loading, run, setError };
}
