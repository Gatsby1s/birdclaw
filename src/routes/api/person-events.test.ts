// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTestHome } from "#/test/test-home";
import { createPerson, recordPersonEvent } from "#/lib/person-archive-store";
import { personEventsResponse } from "./person-events";
afterEach(() => vi.useRealTimers());
describe("person event stream", () => {
	it("pushes only new events for the selected person and releases its interval on disconnect", () =>
		withTestHome(async ({ db }) => {
			vi.useFakeTimers();
			const id = createPerson(db, "SSE人物");
			const other = createPerson(db, "其他人物");
			const response = personEventsResponse(
				new Request(`http://localhost/api/person-events?personId=${id}`),
			);
			expect(response.headers.get("content-type")).toContain(
				"text/event-stream",
			);
			const reader = response.body!.getReader();
			expect(new TextDecoder().decode((await reader.read()).value)).toContain(
				"event: ready",
			);
			recordPersonEvent(db, other, "doc:other");
			recordPersonEvent(db, id, "doc:first");
			await vi.advanceTimersByTimeAsync(5000);
			const event = new TextDecoder().decode((await reader.read()).value);
			expect(event).toContain("event: archive-updated");
			expect(event).toContain(id);
			expect(event).not.toContain(other);
			await reader.cancel();
			expect(vi.getTimerCount()).toBe(0);
		}));
	it("rejects unknown people without starting a stream", () =>
		withTestHome(() => {
			const response = personEventsResponse(
				new Request("http://localhost/api/person-events?personId=missing"),
			);
			expect(response.status).toBe(404);
		}));
});
