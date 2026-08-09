import { describe, expect, it, vi } from "vitest";
import {
	avatarInitial,
	avatarPath,
	boundsContainFeature,
	buildClusterIndex,
	clusterGradient,
	compareClusterFeatures,
	featureMatchesSearch,
	fetchMap,
	formatNumber,
	formatRelationship,
	getClusterDisplayAnchor,
	isCluster,
	readViewport,
	relationshipColor,
	WORLD_BOUNDS,
} from "./network-map-model";
import type { MapFeature } from "./network-map-model";

function feature(
	handle: string,
	relationship: "followers" | "following" | "mutual",
	coordinates: [number, number],
	overrides: Record<string, unknown> = {},
): MapFeature {
	return {
		type: "Feature",
		geometry: { type: "Point", coordinates },
		properties: {
			profileId: `profile_${handle}`,
			handle,
			name: handle,
			avatarUrl: null,
			location: "Shanghai",
			resolvedLocation: "Shanghai, China",
			relationship,
			followersCount: 10,
			...overrides,
		},
	} as MapFeature;
}

describe("network map model", () => {
	it("builds bounded map requests for refresh and account variants", async () => {
		const fetchMock = vi.fn().mockImplementation(async () =>
			Response.json({
				type: "FeatureCollection",
				features: [],
				meta: {
					accountId: "acct",
					type: "all",
					totalProfiles: 0,
					profilesWithLocation: 0,
					meaningfulProfiles: 0,
					locatedProfiles: 0,
					missingGeocodes: 0,
					geocodedThisRun: 0,
					suppressedGeocodes: 0,
					opencageConfigured: false,
					mapboxTokenConfigured: false,
				},
				config: { mapboxToken: null },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const controller = new AbortController();
		await fetchMap("mutual", true, "acct", controller.signal);
		const request = new URL(String(fetchMock.mock.calls[0]?.[0]));
		expect(request.searchParams.get("type")).toBe("mutual");
		expect(request.searchParams.get("geocodeLimit")).toBe("80");
		expect(request.searchParams.get("account")).toBe("acct");
		expect(request.searchParams.get("refresh")).toBe("true");
		await fetchMap("all", false);
		const passive = new URL(String(fetchMock.mock.calls[1]?.[0]));
		expect(passive.searchParams.get("geocodeLimit")).toBe("12");
		expect(passive.searchParams.has("refresh")).toBe(false);
		vi.unstubAllGlobals();
	});

	it("formats relationship labels, colors, avatars, and numbers", () => {
		expect(formatNumber(1234)).toContain("1");
		expect(
			["mutual", "following", "follower"].map((_value, index) =>
				formatRelationship(["mutual", "following", "followers"][index] as any),
			),
		).toEqual(["mutual", "following", "follower"]);
		expect(
			["mutual", "following", "followers"].map((value) =>
				relationshipColor(value as any),
			),
		).toEqual(["#22c55e", "#f59e0b", "#1d9bf0"]);
		expect(avatarInitial(feature("alice", "mutual", [0, 0]))).toBe("A");
		expect(
			avatarInitial(
				feature("bob", "followers", [0, 0], { name: "", handle: "bob" }),
			),
		).toBe("B");
		expect(
			avatarInitial(feature("", "followers", [0, 0], { name: "", handle: "" })),
		).toBe("?");
		expect(avatarPath(feature("plain", "followers", [0, 0]))).toBeNull();
		expect(
			avatarPath(
				feature("pic", "followers", [0, 0], {
					avatarUrl: "https://img/pic.jpg",
				}),
			),
		).toContain("profileId=profile_pic");
		expect(
			clusterGradient({ followers: 0, following: 0, mutual: 0 }),
		).toContain("conic-gradient");
	});

	it("clusters nearby profiles and chooses the densest display anchor", () => {
		const features = [
			feature("a", "followers", [10, 20], { followersCount: 5 }),
			feature("b", "following", [10, 20], { followersCount: 20 }),
			feature("c", "mutual", [30, 40], { followersCount: 50 }),
		];
		const index = buildClusterIndex(features);
		const results = index.getClusters(WORLD_BOUNDS, 0);
		expect(results.some((item) => isCluster(item as any))).toBe(true);
		expect(
			isCluster({ ...results[0], properties: { featureIndex: 0 } } as any),
		).toBe(false);
		expect(getClusterDisplayAnchor(features, [0, 0])).toEqual([10, 20]);
		expect(getClusterDisplayAnchor([], [1, 2])).toEqual([1, 2]);
		expect(compareClusterFeatures(features[0], features[2])).toBeGreaterThan(0);
		expect(
			compareClusterFeatures(
				feature("a", "followers", [0, 0]),
				feature("b", "followers", [0, 0]),
			),
		).toBeLessThan(0);
	});

	it("reads viewport targets and handles normal, world, and dateline bounds", () => {
		expect(readViewport(null)).toBeNull();
		expect(readViewport({ getBounds() {} })).toBeNull();
		expect(
			readViewport({
				getBounds: () => ({
					getWest: () => -10,
					getSouth: () => -20,
					getEast: () => 30,
					getNorth: () => 40,
				}),
				getZoom: () => 5,
			}),
		).toEqual({ bounds: [-10, -20, 30, 40], zoom: 5 });
		const east = feature("east", "followers", [175, 0]);
		expect(boundsContainFeature(WORLD_BOUNDS, east)).toBe(true);
		expect(boundsContainFeature([170, -10, -170, 10], east)).toBe(true);
		expect(boundsContainFeature([170, 20, -170, 30], east)).toBe(false);
		expect(boundsContainFeature([-20, -10, 20, 10], east)).toBe(false);
	});

	it("matches empty, identity, location, and relationship searches", () => {
		const item = feature("alice", "mutual", [0, 0], {
			name: "Alice Chen",
			location: "上海",
			resolvedLocation: null,
		});
		expect(featureMatchesSearch(item, " ")).toBe(true);
		expect(featureMatchesSearch(item, "alice")).toBe(true);
		expect(featureMatchesSearch(item, "上海")).toBe(true);
		expect(featureMatchesSearch(item, "mutual")).toBe(true);
		expect(featureMatchesSearch(item, "beijing")).toBe(false);
	});
});
