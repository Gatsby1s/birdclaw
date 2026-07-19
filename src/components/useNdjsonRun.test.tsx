import { act, renderHook, waitFor } from "@testing-library/react";
import { useCallback, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ndjsonResponse } from "#/test/ndjson";
import { useNdjsonRun } from "./useNdjsonRun";

const eventSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("value"), value: z.string() }),
	z.object({ type: z.literal("done") }),
]);

afterEach(() => vi.restoreAllMocks());

describe("useNdjsonRun", () => {
	it("aborts a request waiting for headers and suppresses stale results", async () => {
		const pending: Array<{
			signal: AbortSignal;
			resolve: (response: Response) => void;
		}> = [];
		const request = vi.fn(
			(signal: AbortSignal) =>
				new Promise<Response>((resolve) => pending.push({ signal, resolve })),
		);
		const { result } = renderHook(() => {
			const [values, setValues] = useState<string[]>([]);
			const onEvent = useCallback((event: z.infer<typeof eventSchema>) => {
				if (event.type === "value") {
					setValues((current) => [...current, event.value]);
				}
			}, []);
			return {
				values,
				stream: useNdjsonRun({
					schema: eventSchema,
					request,
					onEvent,
					isTerminal: (event) => event.type === "done",
					errorLabel: "Request failed",
					emptyBodyMessage: "empty",
					prematureEofError: () => new Error("premature"),
				}),
			};
		});

		act(() => result.current.stream.run());
		act(() => result.current.stream.run());
		expect(pending[0]?.signal.aborted).toBe(true);

		await act(async () => {
			pending[0]?.resolve(
				ndjsonResponse([{ type: "value", value: "stale" }, { type: "done" }]),
			);
			pending[1]?.resolve(
				ndjsonResponse([{ type: "value", value: "current" }, { type: "done" }]),
			);
		});

		await waitFor(() => expect(result.current.stream.loading).toBe(false));
		expect(result.current.values).toEqual(["current"]);
		expect(result.current.stream.error).toBeNull();
	});

	it("cancels an active request and suppresses its eventual response", async () => {
		let pending:
			| {
					signal: AbortSignal;
					resolve: (response: Response) => void;
			  }
			| undefined;
		const request = vi.fn(
			(signal: AbortSignal) =>
				new Promise<Response>((resolve) => {
					pending = { signal, resolve };
				}),
		);
		const onEvent = vi.fn();
		const { result } = renderHook(() =>
			useNdjsonRun({
				schema: eventSchema,
				request,
				onEvent,
				isTerminal: (event) => event.type === "done",
				errorLabel: "Request failed",
				emptyBodyMessage: "empty",
				prematureEofError: () => new Error("premature"),
			}),
		);

		act(() => result.current.run());
		expect(result.current.loading).toBe(true);
		act(() => result.current.cancel());
		expect(pending?.signal.aborted).toBe(true);
		expect(result.current.loading).toBe(false);

		await act(async () => {
			pending?.resolve(
				ndjsonResponse([{ type: "value", value: "stale" }, { type: "done" }]),
			);
		});
		expect(onEvent).not.toHaveBeenCalled();
		expect(result.current.error).toBeNull();
	});

	it("reports invalid events and premature EOF", async () => {
		const responses = [
			ndjsonResponse([{ type: "value", value: 4 }]),
			ndjsonResponse([{ type: "value", value: "partial" }]),
		];
		const { result } = renderHook(() =>
			useNdjsonRun({
				schema: eventSchema,
				request: async () => responses.shift() as Response,
				onEvent: vi.fn(),
				isTerminal: (event) => event.type === "done",
				errorLabel: "Request failed",
				emptyBodyMessage: "empty",
				prematureEofError: () => new Error("premature"),
			}),
		);

		act(() => result.current.run());
		await waitFor(() =>
			expect(result.current.error).toContain("expected string"),
		);
		act(() => result.current.run());
		await waitFor(() => expect(result.current.error).toBe("premature"));
	});
});
