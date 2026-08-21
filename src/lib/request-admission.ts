export interface RequestAdmission {
	readonly limit: number;
	activeCount(): number;
	tryAcquire(): (() => void) | null;
}

export function createRequestAdmission(limit: number): RequestAdmission {
	if (!Number.isInteger(limit) || limit < 1) {
		throw new Error("Request admission limit must be a positive integer");
	}

	let active = 0;
	return {
		limit,
		activeCount: () => active,
		tryAcquire() {
			if (active >= limit) return null;
			active += 1;
			let released = false;
			return () => {
				if (released) return;
				released = true;
				active = Math.max(0, active - 1);
			};
		},
	};
}
