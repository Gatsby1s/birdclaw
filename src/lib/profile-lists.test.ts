// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
	insertTestAccount,
	insertTestProfile,
	useTestHome,
} from "../test/test-home";
import {
	createProfileList,
	createProfileListSnapshot,
	deleteProfileList,
	getProfileListMembershipStatus,
	listProfileListMembers,
	listProfileLists,
	searchProfileListCandidates,
	setProfileListMembership,
	updateProfileList,
} from "./profile-lists";

describe("profile Lists", () => {
	const getHome = useTestHome({ prefix: "birdclaw-profile-lists-" });

	it("creates, renames, isolates, and soft-deletes private Lists", () => {
		const { db } = getHome();
		insertTestAccount(db, { id: "acct-one" });
		insertTestAccount(db, { id: "acct-two", handle: "@two" });
		const created = createProfileList(
			{
				accountId: "acct-one",
				name: "  美股   事实源 ",
				description: "  公司 与 媒体  ",
			},
			db,
			new Date("2026-08-18T01:00:00.000Z"),
		);
		expect(created).toMatchObject({
			accountId: "acct-one",
			name: "美股 事实源",
			description: "公司 与 媒体",
			memberCount: 0,
		});
		expect(() =>
			createProfileList({ accountId: "acct-one", name: "美股 事实源" }, db),
		).toThrow(/already exists/i);
		expect(
			createProfileList({ accountId: "acct-two", name: "美股 事实源" }, db),
		).toMatchObject({ accountId: "acct-two" });

		expect(
			updateProfileList(
				{
					accountId: "acct-one",
					listId: created.id,
					name: "财报源",
					description: "只看事实",
				},
				db,
				new Date("2026-08-18T02:00:00.000Z"),
			),
		).toMatchObject({ name: "财报源", description: "只看事实" });
		expect(() =>
			updateProfileList(
				{ accountId: "acct-two", listId: created.id, name: "越权" },
				db,
			),
		).toThrow(/not found/i);

		deleteProfileList(
			{ accountId: "acct-one", listId: created.id },
			db,
			new Date("2026-08-18T03:00:00.000Z"),
		);
		expect(listProfileLists("acct-one", db)).toEqual([]);
		expect(
			createProfileList({ accountId: "acct-one", name: "财报源" }, db),
		).toMatchObject({ name: "财报源" });
	});

	it("persists membership tombstones and promotes a handle to a stable ID", () => {
		const { db } = getHome();
		insertTestAccount(db, { id: "acct" });
		insertTestProfile(db, {
			id: "profile_user_42",
			handle: "Ada",
			displayName: "Ada",
		});
		const list = createProfileList({ accountId: "acct", name: "Core" }, db);

		setProfileListMembership(
			{
				accountId: "acct",
				listId: list.id,
				handle: "@Ada",
				included: true,
			},
			db,
			new Date("2026-08-18T01:00:00.000Z"),
		);
		expect(
			listProfileListMembers({ accountId: "acct", listId: list.id }, db),
		).toEqual([
			expect.objectContaining({ memberKey: "handle:ada", handle: "Ada" }),
		]);

		setProfileListMembership(
			{
				accountId: "acct",
				listId: list.id,
				handle: "ada",
				identifier: "profile_user_42",
				included: true,
			},
			db,
			new Date("2026-08-18T02:00:00.000Z"),
		);
		expect(
			listProfileListMembers({ accountId: "acct", listId: list.id }, db),
		).toEqual([
			expect.objectContaining({ memberKey: "id:42", identifier: "42" }),
		]);
		expect(
			createProfileListSnapshot({ accountId: "acct", listId: list.id }, db),
		).toMatchObject({
			priorityProfileIds: ["42", "profile_user_42"],
			priorityHandleOnlyHandles: [],
		});

		setProfileListMembership(
			{
				accountId: "acct",
				listId: list.id,
				handle: "ada",
				identifier: "profile_user_42",
				included: false,
			},
			db,
			new Date("2026-08-18T03:00:00.000Z"),
		);
		expect(
			listProfileListMembers({ accountId: "acct", listId: list.id }, db),
		).toEqual([]);
		expect(
			db
				.prepare(
					"select is_member from birdclaw_list_members where list_id = ? and member_key = 'id:42'",
				)
				.get(list.id),
		).toEqual({ is_member: 0 });
	});

	it("reports per-profile membership and searches only local profiles", () => {
		const { db } = getHome();
		insertTestAccount(db, { id: "acct" });
		insertTestProfile(db, {
			id: "profile_user_42",
			handle: "facts_wire",
			displayName: "Facts Wire",
		});
		insertTestProfile(db, {
			id: "profile_user_43",
			handle: "opinion",
			displayName: "Opinion Desk",
		});
		const first = createProfileList({ accountId: "acct", name: "Facts" }, db);
		createProfileList({ accountId: "acct", name: "Research" }, db);
		setProfileListMembership(
			{
				accountId: "acct",
				listId: first.id,
				handle: "facts_wire",
				identifier: "profile_user_42",
				included: true,
			},
			db,
		);

		expect(
			getProfileListMembershipStatus(
				{
					accountId: "acct",
					handle: "facts_wire",
					identifier: "profile_user_42",
				},
				db,
			).lists.map(({ name, included }) => ({ name, included })),
		).toEqual([
			{ name: "Facts", included: true },
			{ name: "Research", included: false },
		]);
		expect(
			searchProfileListCandidates(
				{ accountId: "acct", listId: first.id, search: "facts" },
				db,
			),
		).toEqual([
			expect.objectContaining({
				included: true,
				profile: expect.objectContaining({ handle: "facts_wire" }),
			}),
		]);
	});
});
