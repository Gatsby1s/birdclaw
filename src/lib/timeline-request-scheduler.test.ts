// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { BoundedRequestScheduler } from "./timeline-request-scheduler";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	return { promise, reject, resolve };
}

async function flushMicrotasks() {
	await Promise.resolve();
	await Promise.resolve();
}

describe("timeline request scheduler", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("never runs more than the configured number of requests", async () => {
		const scheduler = new BoundedRequestScheduler({ concurrency: 2 });
		const gates = Array.from({ length: 5 }, () => deferred<number>());
		let active = 0;
		let peak = 0;
		const started: number[] = [];
		const requests = gates.map((gate, index) =>
			scheduler.schedule(async () => {
				started.push(index);
				active += 1;
				peak = Math.max(peak, active);
				const value = await gate.promise;
				active -= 1;
				return value;
			}),
		);

		await flushMicrotasks();
		expect(started).toEqual([0, 1]);
		gates[0]?.resolve(0);
		gates[1]?.resolve(1);
		await Promise.all([requests[0], requests[1]]);
		await flushMicrotasks();
		expect(started).toEqual([0, 1, 2, 3]);
		gates[2]?.resolve(2);
		gates[3]?.resolve(3);
		await Promise.all([requests[2], requests[3]]);
		await flushMicrotasks();
		expect(started).toEqual([0, 1, 2, 3, 4]);
		gates[4]?.resolve(4);

		await expect(Promise.all(requests)).resolves.toEqual([0, 1, 2, 3, 4]);
		expect(peak).toBe(2);
	});

	it("drops an aborted queued request before it can call the server", async () => {
		const scheduler = new BoundedRequestScheduler({ concurrency: 1 });
		const running = deferred<void>();
		const first = scheduler.schedule(() => running.promise);
		const controller = new AbortController();
		const queuedTask = vi.fn(async () => "should not run");
		const queued = scheduler.schedule(queuedTask, [controller.signal]);

		await flushMicrotasks();
		controller.abort();
		await expect(queued).rejects.toMatchObject({ name: "AbortError" });
		expect(queuedTask).not.toHaveBeenCalled();

		running.resolve();
		await expect(first).resolves.toBeUndefined();
		await flushMicrotasks();
		expect(queuedTask).not.toHaveBeenCalled();
	});

	it("aborts a running fetch when its viewport signal is cancelled", async () => {
		const scheduler = new BoundedRequestScheduler({ concurrency: 1 });
		const controller = new AbortController();
		let receivedSignal: AbortSignal | undefined;
		const request = scheduler.schedule(
			(signal) => {
				receivedSignal = signal;
				return new Promise((_resolve, reject) => {
					signal.addEventListener(
						"abort",
						() => reject(new DOMException("cancelled", "AbortError")),
						{ once: true },
					);
				});
			},
			[controller.signal],
		);

		await flushMicrotasks();
		expect(receivedSignal?.aborted).toBe(false);
		controller.abort();
		await expect(request).rejects.toMatchObject({ name: "AbortError" });
		expect(receivedSignal?.aborted).toBe(true);
	});

	it.each([429, 503])(
		"sheds queued work and pauses new work after an HTTP %s overload",
		async (status) => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date("2026-08-21T00:00:00.000Z"));
			const scheduler = new BoundedRequestScheduler({
				concurrency: 1,
				cooldownMs: 10_000,
			});
			const overload = Object.assign(new Error("overloaded"), { status });
			const firstTask = vi.fn(async () => Promise.reject(overload));
			const queuedTask = vi.fn(async () => "queued");
			const first = scheduler.schedule(firstTask);
			const queued = scheduler.schedule(queuedTask);

			await expect(first).rejects.toBe(overload);
			await expect(queued).rejects.toBe(overload);
			expect(queuedTask).not.toHaveBeenCalled();

			const duringCooldownTask = vi.fn(async () => "too early");
			await expect(scheduler.schedule(duringCooldownTask)).rejects.toBe(
				overload,
			);
			expect(duringCooldownTask).not.toHaveBeenCalled();

			vi.advanceTimersByTime(10_001);
			await expect(scheduler.schedule(async () => "recovered")).resolves.toBe(
				"recovered",
			);
		},
	);
});
