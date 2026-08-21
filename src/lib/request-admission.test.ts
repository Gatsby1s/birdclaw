// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createRequestAdmission } from "./request-admission";

describe("request admission", () => {
	it("rejects overflow and reopens capacity after an idempotent release", () => {
		const admission = createRequestAdmission(2);
		const releaseFirst = admission.tryAcquire();
		const releaseSecond = admission.tryAcquire();

		expect(releaseFirst).toBeTypeOf("function");
		expect(releaseSecond).toBeTypeOf("function");
		expect(admission.activeCount()).toBe(2);
		expect(admission.tryAcquire()).toBeNull();

		releaseFirst?.();
		releaseFirst?.();
		expect(admission.activeCount()).toBe(1);
		expect(admission.tryAcquire()).toBeTypeOf("function");
	});

	it("rejects invalid limits", () => {
		expect(() => createRequestAdmission(0)).toThrow(
			"Request admission limit must be a positive integer",
		);
		expect(() => createRequestAdmission(1.5)).toThrow(
			"Request admission limit must be a positive integer",
		);
	});
});
