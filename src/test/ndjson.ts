export function ndjsonBody(events: readonly unknown[]) {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const event of events) {
				controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
			}
			controller.close();
		},
	});
}

export function ndjsonResponse(
	events: readonly unknown[],
	init?: ResponseInit,
) {
	const headers = new Headers(init?.headers);
	headers.set("content-type", "application/x-ndjson");
	return new Response(ndjsonBody(events), { ...init, headers });
}
