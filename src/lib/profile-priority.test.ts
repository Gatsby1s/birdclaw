// @vitest-environment node
import { describe, expect, it } from "vitest";
import { useTestHome } from "../test/test-home";
import {
	createProfilePrioritySnapshot,
	getOrPromoteProfilePriority,
	getProfilePriority,
	mergeProfilePriorityRows,
	remapProfilePriorityRowsToDatabase,
	setProfileSpecialFollow,
} from "./profile-priority";

describe("profile priority", () => {
	const getHome = useTestHome({ prefix: "birdclaw-profile-priority-" });

	it("persists enabled and disabled states as stable-ID records", () => {
		const { db } = getHome();
		db.prepare(
			`insert into profiles (
			 id, handle, display_name, bio, followers_count, avatar_hue, created_at
			) values (?, ?, ?, '', 0, 0, ?)`,
		).run("profile_user_42", "Ada", "Ada", "2026-08-01T00:00:00.000Z");

		expect(
			setProfileSpecialFollow(
				{
					handle: "@Ada",
					identifier: "profile_user_42",
					specialFollow: true,
				},
				db,
				new Date("2026-08-01T01:00:00.000Z"),
			),
		).toMatchObject({ identifier: "42", specialFollow: true });
		expect(
			getProfilePriority({ handle: "ada", identifier: "profile_user_42" }, db)
				.specialFollow,
		).toBe(true);

		setProfileSpecialFollow(
			{
				handle: "Ada",
				identifier: "profile_user_42",
				specialFollow: false,
			},
			db,
			new Date("2026-08-01T02:00:00.000Z"),
		);
		expect(
			getProfilePriority({ handle: "ada", identifier: "profile_user_42" }, db)
				.specialFollow,
		).toBe(false);
		expect(
			db
				.prepare(
					"select is_special_follow from birdclaw_profile_priorities where priority_key = 'id:42'",
				)
				.get(),
		).toEqual({ is_special_follow: 0 });
	});

	it("lets a newer provisional choice win when a stable row already exists", () => {
		const { db } = getHome();
		setProfileSpecialFollow(
			{
				handle: "ada",
				identifier: "profile_user_42",
				specialFollow: false,
			},
			db,
			new Date("2026-08-01T08:00:00.000Z"),
		);
		setProfileSpecialFollow(
			{ handle: "ada", specialFollow: true },
			db,
			new Date("2026-08-01T09:00:00.000Z"),
		);

		expect(
			getOrPromoteProfilePriority(
				{ handle: "ada", identifier: "profile_user_42" },
				db,
				new Date("2026-08-01T10:00:00.000Z"),
			),
		).toMatchObject({ identifier: "42", specialFollow: true });
		expect(getProfilePriority({ handle: "ada" }, db).specialFollow).toBe(false);
	});

	it("never remaps stable priority identities by a reused handle", () => {
		const { db } = getHome();
		db.prepare(
			`insert into profiles (
			 id, handle, display_name, bio, followers_count, avatar_hue, created_at
			) values (?, ?, ?, '', 0, 0, ?)`,
		).run("profile_user_42", "reused", "New owner", "2026-08-01T00:00:00.000Z");

		expect(
			remapProfilePriorityRowsToDatabase(
				[
					{
						priorityKey: "id:41",
						identifier: "41",
						additionalName: "reused",
						isSpecialFollow: 1,
						updatedAt: "2026-08-01T01:00:00.000Z",
					},
				],
				db,
			),
		).toEqual([
			expect.objectContaining({ priorityKey: "id:41", identifier: "41" }),
		]);
	});

	it("isolates stable IDs when an X handle is reused", () => {
		const { db } = getHome();
		setProfileSpecialFollow(
			{
				handle: "reused",
				identifier: "profile_user_41",
				specialFollow: true,
			},
			db,
			new Date("2026-08-01T01:00:00.000Z"),
		);
		setProfileSpecialFollow(
			{
				handle: "reused",
				identifier: "profile_user_42",
				specialFollow: false,
			},
			db,
			new Date("2026-08-01T02:00:00.000Z"),
		);

		expect(
			getProfilePriority(
				{ handle: "reused", identifier: "profile_user_41" },
				db,
			).specialFollow,
		).toBe(true);
		expect(
			getProfilePriority(
				{ handle: "reused", identifier: "profile_user_42" },
				db,
			).specialFollow,
		).toBe(false);
		const snapshot = createProfilePrioritySnapshot(db);
		expect(
			snapshot.isSpecialFollow({
				handle: "reused",
				identifier: "profile_user_41",
			}),
		).toBe(true);
		expect(
			snapshot.isSpecialFollow({
				handle: "reused",
				identifier: "profile_user_42",
			}),
		).toBe(false);
	});

	it("promotes a provisional handle choice only after an explicit stable ID arrives", () => {
		const { db } = getHome();
		setProfileSpecialFollow(
			{ handle: "future_id", specialFollow: true },
			db,
			new Date("2026-08-01T01:00:00.000Z"),
		);
		db.prepare(
			`insert into profiles (
			 id, handle, display_name, bio, followers_count, avatar_hue, created_at
			) values (?, ?, ?, '', 0, 0, ?)`,
		).run(
			"profile_user_77",
			"future_id",
			"Future ID",
			"2026-08-01T02:00:00.000Z",
		);

		expect(getProfilePriority({ handle: "future_id" }, db)).toMatchObject({
			specialFollow: true,
		});
		expect(
			getProfilePriority(
				{ handle: "future_id", identifier: "profile_user_77" },
				db,
			).specialFollow,
		).toBe(false);
		expect(
			getOrPromoteProfilePriority(
				{ handle: "future_id", identifier: "profile_user_77" },
				db,
				new Date("2026-08-01T03:00:00.000Z"),
			),
		).toMatchObject({ identifier: "77", specialFollow: true });
		expect(getProfilePriority({ handle: "future_id" }, db).specialFollow).toBe(
			false,
		);
		const snapshot = createProfilePrioritySnapshot(db);
		expect(
			snapshot.isSpecialFollow({
				handle: "future_id",
				identifier: "profile_user_77",
			}),
		).toBe(true);
	});

	it("does not infer a stable ID from a handle-only UI lookup", () => {
		const { db } = getHome();
		db.prepare(
			`insert into profiles (
			 id, handle, display_name, bio, followers_count, avatar_hue, created_at
			) values (?, ?, ?, '', 0, 0, ?)`,
		).run(
			"profile_user_88",
			"ambiguous",
			"Ambiguous",
			"2026-08-01T00:00:00.000Z",
		);
		setProfileSpecialFollow({ handle: "ambiguous", specialFollow: true }, db);
		expect(
			db
				.prepare(
					"select priority_key, identifier from birdclaw_profile_priorities where is_special_follow = 1",
				)
				.get(),
		).toEqual({ priority_key: "handle:ambiguous", identifier: null });
	});

	it("merges cross-device tombstones with last-write-wins semantics", () => {
		const { db } = getHome();
		setProfileSpecialFollow(
			{
				handle: "ada",
				identifier: "profile_user_42",
				specialFollow: true,
			},
			db,
			new Date("2026-08-01T02:00:00.000Z"),
		);
		mergeProfilePriorityRows(
			[
				{
					priorityKey: "id:42",
					identifier: "42",
					additionalName: "ada",
					isSpecialFollow: 0,
					updatedAt: "2026-08-01T01:00:00.000Z",
				},
			],
			db,
		);
		expect(
			getProfilePriority({ handle: "ada", identifier: "profile_user_42" }, db)
				.specialFollow,
		).toBe(true);

		mergeProfilePriorityRows(
			[
				{
					priorityKey: "id:42",
					identifier: "42",
					additionalName: "ada",
					isSpecialFollow: 0,
					updatedAt: "2026-08-01T03:00:00.000Z",
				},
			],
			db,
		);
		expect(
			getProfilePriority({ handle: "ada", identifier: "profile_user_42" }, db)
				.specialFollow,
		).toBe(false);
	});
});
