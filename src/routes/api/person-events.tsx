import { createFileRoute } from "@tanstack/react-router";
import { getReadDb } from "#/lib/db";
import { sensitiveRequestErrorResponse } from "#/lib/http-effect";
import { requirePerson } from "#/lib/person-archive-store";

export function personEventsResponse(request: Request) {
	const denied = sensitiveRequestErrorResponse(request);
	if (denied) return denied;
	const params = new URL(request.url).searchParams;
	const personId = params.get("personId");
	const db = getReadDb({ seedDemoData: false });
	if (personId) {
		try {
			requirePerson(db, personId);
		} catch {
			return new Response("Person not found", { status: 404 });
		}
	}
	const current = () =>
		Number(
			(
				db
					.prepare(
						"select max(sequence) n from person_events where (? is null or person_id=?)",
					)
					.get(personId, personId) as { n: number | null }
			).n ?? 0,
		);
	const rawAfter = request.headers.get("last-event-id") ?? params.get("after");
	let sequence =
		rawAfter && /^\d{1,15}$/.test(rawAfter)
			? Math.min(current(), Number(rawAfter))
			: current();
	let timer: ReturnType<typeof setInterval> | undefined;
	let closed = false;
	let detach = () => {};
	const stop = () => {
		if (closed) return;
		closed = true;
		if (timer) clearInterval(timer);
		detach();
	};
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const send = (text: string) => controller.enqueue(encoder.encode(text));
			const abort = () => {
				stop();
				try {
					controller.close();
				} catch {
					/* already closed */
				}
			};
			request.signal.addEventListener("abort", abort, { once: true });
			detach = () => request.signal.removeEventListener("abort", abort);
			if (request.signal.aborted) {
				abort();
				return;
			}
			send(
				`retry: 5000\nevent: ready\ndata: ${JSON.stringify({ personId, latestSequence: sequence })}\n\n`,
			);
			let ticks = 0;
			timer = setInterval(() => {
				if (closed) return;
				try {
					const latest = current();
					if (latest > sequence) {
						sequence = latest;
						send(
							`id: ${sequence}\nevent: archive-updated\ndata: ${JSON.stringify({ personId, latestSequence: sequence })}\n\n`,
						);
					} else if (++ticks % 3 === 0) send(": keepalive\n\n");
				} catch {
					abort();
				}
			}, 5000);
			timer.unref?.();
		},
		cancel() {
			stop();
		},
	});
	return new Response(stream, {
		headers: {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "private, no-cache, no-transform",
			"x-accel-buffering": "no",
			"x-content-type-options": "nosniff",
		},
	});
}
export const Route = createFileRoute("/api/person-events")({
	server: { handlers: { GET: ({ request }) => personEventsResponse(request) } },
});
