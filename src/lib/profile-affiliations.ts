import { createHash } from "node:crypto";
import type { Database } from "./sqlite";
import type { ProfileAffiliation, XurlMentionUser } from "./types";

interface NormalizedAffiliationInput {
	organizationProfileId: string;
	organizationName?: string;
	organizationHandle?: string;
	badgeUrl?: string | null;
	url?: string | null;
	label?: string | null;
	source: string;
	raw: Record<string, unknown>;
}

function getString(value: unknown) {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

function getStringArray(value: unknown) {
	if (Array.isArray(value)) {
		return value.filter(
			(item): item is string => typeof item === "string" && item.length > 0,
		);
	}
	const single = getString(value);
	return single ? [single] : [];
}

function readFirst(record: Record<string, unknown>, keys: string[]) {
	for (const key of keys) {
		const value = getString(record[key]);
		if (value) {
			return value;
		}
	}
	return undefined;
}

function inferHandleFromUrl(value: string | undefined) {
	if (!value) {
		return undefined;
	}
	try {
		const url = new URL(value);
		if (!/(^|\.)x\.com$|(^|\.)twitter\.com$/.test(url.hostname)) {
			return undefined;
		}
		const [handle] = url.pathname.split("/").filter(Boolean);
		return handle?.replace(/^@/, "");
	} catch {
		return undefined;
	}
}

function syntheticOrganizationId({
	label,
	url,
	badgeUrl,
}: {
	label?: string | null;
	url?: string | null;
	badgeUrl?: string | null;
}) {
	const hash = createHash("sha1")
		.update([label, url, badgeUrl].filter(Boolean).join("|"))
		.digest("hex")
		.slice(0, 16);
	return hash ? `profile_affiliation_${hash}` : undefined;
}

export function normalizeProfileAffiliationsFromUser(
	user: XurlMentionUser,
): NormalizedAffiliationInput[] {
	const raw = user.affiliation;
	if (!raw || typeof raw !== "object") {
		return [];
	}

	const organizationIds = [
		...getStringArray(raw.organizationIds),
		...getStringArray(raw.organization_ids),
		...getStringArray(raw.userId),
		...getStringArray(raw.user_id),
	];
	const label =
		readFirst(raw, ["label", "description", "organizationName"]) ?? null;
	const url = readFirst(raw, ["url", "expandedUrl", "expanded_url"]) ?? null;
	const badgeUrl = readFirst(raw, ["badgeUrl", "badge_url"]) ?? null;
	if (
		organizationIds.length === 0 &&
		label === null &&
		url === null &&
		badgeUrl === null
	) {
		return [];
	}
	const organizationHandle =
		readFirst(raw, ["organizationHandle", "organization_handle", "username"]) ??
		inferHandleFromUrl(url ?? undefined);
	const ids =
		organizationIds.length > 0
			? Array.from(new Set(organizationIds))
			: [
					syntheticOrganizationId({
						label,
						url,
						badgeUrl,
					}),
				].filter((item): item is string => Boolean(item));

	return ids.map((organizationProfileId) => ({
		organizationProfileId,
		...(label ? { organizationName: label } : {}),
		...(organizationHandle ? { organizationHandle } : {}),
		badgeUrl,
		url,
		label,
		source: "x_profile",
		raw,
	}));
}

export function syncProfileAffiliationsFromUser(
	db: Database,
	subjectProfileId: string,
	user: XurlMentionUser,
) {
	const affiliations = normalizeProfileAffiliationsFromUser(user);
	if (affiliations.length === 0) {
		return [];
	}

	const now = new Date().toISOString();
	const statement = db.prepare(`
    insert into profile_affiliations (
      subject_profile_id, organization_profile_id, organization_name,
      organization_handle, badge_url, url, label, source, is_active,
      first_seen_at, last_seen_at, raw_json, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
    on conflict(subject_profile_id, organization_profile_id) do update set
      organization_name = coalesce(excluded.organization_name, profile_affiliations.organization_name),
      organization_handle = coalesce(excluded.organization_handle, profile_affiliations.organization_handle),
      badge_url = coalesce(excluded.badge_url, profile_affiliations.badge_url),
      url = coalesce(excluded.url, profile_affiliations.url),
      label = coalesce(excluded.label, profile_affiliations.label),
      source = excluded.source,
      is_active = 1,
      last_seen_at = excluded.last_seen_at,
      raw_json = excluded.raw_json,
      updated_at = excluded.updated_at
  `);

	for (const affiliation of affiliations) {
		statement.run(
			subjectProfileId,
			affiliation.organizationProfileId,
			affiliation.organizationName ?? null,
			affiliation.organizationHandle ?? null,
			affiliation.badgeUrl ?? null,
			affiliation.url ?? null,
			affiliation.label ?? null,
			affiliation.source,
			now,
			now,
			JSON.stringify(affiliation.raw),
			now,
		);
	}

	return affiliations;
}

export function fetchProfileAffiliations(db: Database, profileIds: string[]) {
	if (profileIds.length === 0) {
		return new Map<string, ProfileAffiliation[]>();
	}

	const placeholders = profileIds.map(() => "?").join(",");
	const rows = db
		.prepare(
			`
      select
        subject_profile_id,
        organization_profile_id,
        organization_name,
        organization_handle,
        badge_url,
        url,
        label,
        source,
        is_active,
        first_seen_at,
        last_seen_at
      from profile_affiliations
      where subject_profile_id in (${placeholders})
        and is_active = 1
      order by subject_profile_id, last_seen_at desc, organization_profile_id
      `,
		)
		.all(...profileIds) as Array<Record<string, unknown>>;

	const result = new Map<string, ProfileAffiliation[]>();
	for (const row of rows) {
		const subjectProfileId = String(row.subject_profile_id);
		const affiliation: ProfileAffiliation = {
			organizationProfileId: String(row.organization_profile_id),
			...(typeof row.organization_name === "string" &&
			row.organization_name.length > 0
				? { organizationName: row.organization_name }
				: {}),
			...(typeof row.organization_handle === "string" &&
			row.organization_handle.length > 0
				? { organizationHandle: row.organization_handle }
				: {}),
			badgeUrl:
				typeof row.badge_url === "string" ? String(row.badge_url) : null,
			url: typeof row.url === "string" ? String(row.url) : null,
			label: typeof row.label === "string" ? String(row.label) : null,
			source: String(row.source),
			firstSeenAt: String(row.first_seen_at),
			lastSeenAt: String(row.last_seen_at),
			isActive: Boolean(row.is_active),
		};
		const existing = result.get(subjectProfileId);
		if (existing) {
			existing.push(affiliation);
		} else {
			result.set(subjectProfileId, [affiliation]);
		}
	}

	return result;
}

export function attachAffiliationsToProfiles<T extends { id: string }>(
	db: Database,
	profiles: T[],
): Array<
	T & {
		affiliations?: ProfileAffiliation[];
		primaryAffiliation?: ProfileAffiliation;
	}
> {
	const affiliations = fetchProfileAffiliations(
		db,
		profiles.map((profile) => profile.id),
	);
	return profiles.map((profile) => {
		const profileAffiliations = affiliations.get(profile.id) ?? [];
		if (profileAffiliations.length === 0) {
			return profile;
		}
		return {
			...profile,
			affiliations: profileAffiliations,
			primaryAffiliation: profileAffiliations[0],
		};
	});
}
