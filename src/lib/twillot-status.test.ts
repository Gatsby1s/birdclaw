// @vitest-environment node
import {
	enqueueTwillotHistoryJob,
	claimTwillotHistoryJob,
} from "./twillot-history-queue";
import { getTwillotProviderStatus } from "./twillot-status";
import { useTestHome } from "../test/test-home";
import { describe, expect, it } from "vitest";

describe("Twillot provider status", () => {
	const getHome = useTestHome({ prefix: "birdclaw-twillot-status-" });

	it("does not report an expired lease as an active worker", () => {
		const { db } = getHome();
		db.prepare(
			`insert into accounts (
				id, name, handle, external_user_id, transport, is_default, created_at
			) values ('acct', 'Owner', 'owner', '1', 'xurl', 1, ?)`,
		).run("2026-08-10T00:00:00.000Z");
		enqueueTwillotHistoryJob(db, {
			accountId: "acct",
			profileId: "profile_user_42",
			externalUserId: "42",
			handle: "target",
			now: new Date("2026-08-10T01:00:00.000Z"),
		});
		claimTwillotHistoryJob(db, {
			now: new Date("2026-08-10T01:00:00.000Z"),
			leaseMs: 1_000,
		});

		const status = getTwillotProviderStatus(
			db,
			new Date("2026-08-10T01:00:02.000Z"),
		);

		expect(status.queueCounts.active).toBe(0);
		expect(status.jobs[0]?.state).toBe("leased");
	});
});
