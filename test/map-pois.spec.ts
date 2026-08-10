import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import {
	MAP_POI_CATALOG_VERSION,
	MAP_POI_SCHEMA_VERSION,
	canonicalMapPOICatalogContent,
	mapPOICatalog,
	mapPOICatalogFingerprint,
	validateMapPOICatalog,
	type MapPOICatalog,
} from "../src/config/MapPOICatalog";
import { MAP_POI_CACHE_CONTROL } from "../src/routes/mapPOIs";
import type { Env } from "../src/types";

const clone = (): MapPOICatalog => structuredClone(mapPOICatalog);
const invalid = (catalog: unknown, message: RegExp) => expect(() => validateMapPOICatalog(catalog)).toThrow(message);

const expectedAccesses = [
	["gs-lagoon-pass", "gulfShores", "beachAccess", 30.241812, -87.737364, "Lagoon Pass", "gs-beaches"],
	["gs-west-13th", "gulfShores", "beachAccess", 30.242293, -87.730888, "West 13th Street Beach Access", "gs-beaches"],
	["gs-west-12th", "gulfShores", "beachAccess", 30.243331, -87.722356, "West 12th Street Beach Access", "gs-beaches"],
	["gs-west-10th", "gulfShores", "beachAccess", 30.244027, -87.716654, "West 10th Street Beach Access", "gs-beaches"],
	["gs-west-6th", "gulfShores", "beachAccess", 30.246446, -87.700218, "West 6th Street Beach Access", "gs-beaches"],
	["gs-west-5th", "gulfShores", "beachAccess", 30.246770, -87.698568, "West 5th Street Beach Access", "gs-beaches"],
	["gs-west-4th", "gulfShores", "beachAccess", 30.247182, -87.696941, "West 4th Street Beach Access", "gs-beaches"],
	["gs-gulf-place", "gulfShores", "beachAccess", 30.248332, -87.688653, "Gulf Place West and East", "gs-beaches"],
	["gsp-fishing-education-pier", "gulfShores", "pier", 30.249960, -87.668190, "Gulf State Park Pier", "gsp-pier"],
	["gsp-beach-pavilion", "gulfShores", "pavilion", 30.25517036, -87.64240986, "Gulf State Park Beach Pavilion", "gsp-pavilion"],
	["ob-romar", "orangeBeach", "beachAccess", 30.264641, -87.606820, "Romar Beach Access", "gsp-beaches"],
	["ob-cotton-bayou", "orangeBeach", "beachAccess", 30.269777, -87.582456, "Cotton Bayou Beach Access", "gsp-beaches"],
	["ob-alabama-point-east", "orangeBeach", "beachAccess", 30.276754, -87.550816, "Alabama Point East", "gsp-beaches"],
	["ob-shell-beach", "orangeBeach", "beachAccess", 30.277784, -87.555281, "Shell Beach Access", "gsp-beaches"],
	["fort-morgan-mobile-street", "fortMorgan", "beachAccess", 30.229833, -87.831410, "Fort Morgan Beach — Mobile Street Access", "usfws-bon-secour"],
	["di-east-end", "dauphinIsland", "beachAccess", 30.246850, -88.075680, "Dauphin Island East End Beach", "di-beaches"],
	["di-middle", "dauphinIsland", "beachAccess", 30.250144, -88.127458, "Middle Beach", "di-beaches"],
	["di-bienville", "dauphinIsland", "beachAccess", 30.250645, -88.136241, "Bienville Beach", "di-beaches"],
	["di-west-end", "dauphinIsland", "beachAccess", 30.248769, -88.191554, "West End Beach", "di-west-end"],
] as const;

describe("MapKit POI committed baseline", () => {
	it("matches all 26 application-owned MapKit annotations", () => {
		expect(mapPOICatalog.schemaVersion).toBe(1);
		expect(mapPOICatalog.catalogVersion).toBe("2026-08-10.1");
		expect(mapPOICatalog.count).toBe(26);
		expect(mapPOICatalog.pois).toHaveLength(26);
		expect(new Set(mapPOICatalog.pois.map(({ id }) => id))).toHaveLength(26);
	});

	it("preserves all 19 Beach Guide physical destinations and relationships", () => {
		const actual = mapPOICatalog.pois.filter(({ relationships }) => relationships).map((poi) => [
			poi.id, poi.region, poi.category, poi.coordinate.latitude, poi.coordinate.longitude, poi.display.title, poi.provenance.sourceID,
		]);
		expect(actual).toEqual(expectedAccesses);
		expect(mapPOICatalog.pois.filter(({ relationships }) => relationships).map((poi) => poi.relationships?.beachGuideAccessPointID)).toEqual(expectedAccesses.map(([id]) => id));
	});

	it("preserves the independent East End Landing and its provenance", () => {
		expect(mapPOICatalog.pois.find(({ id }) => id === "di-east-end-landing")).toEqual({
			id: "di-east-end-landing", region: "dauphinIsland", category: "pier", enabled: true,
			coordinate: { latitude: 30.2508027778, longitude: -88.0758944444 },
			display: { title: "Dauphin Island East End Landing", subtitle: "Town of Dauphin Island", directionsEnabled: true },
			provenance: {
				authority: "Town of Dauphin Island", sourceID: "di-beaches", sourceTitle: "Town of Dauphin Island Beaches",
				sourceURL: "https://www.townofdauphinisland.org/beaches",
				coordinateSourceTitle: "Town-published coordinate: 30° 15′02.89″ N, 88° 04′33.22″ W", verifiedOn: "2026-08-10",
			},
		});
	});

	it("preserves all six seasonal, informational-only lifeguard towers", () => {
		const towers = mapPOICatalog.pois.filter(({ category }) => category === "lifeguardTower");
		expect(towers.map(({ id, coordinate, display }) => [id, coordinate.latitude, coordinate.longitude, display.subtitle])).toEqual([
			["orange-beach-tower-1", 30.2756149, -87.5423135, "Shell Beach"],
			["orange-beach-tower-2", 30.2763488, -87.5524452, "Alabama Point East"],
			["orange-beach-tower-3", 30.2691727, -87.5824031, "Cotton Bayou"],
			["orange-beach-tower-4", 30.2678412, -87.5874991, "Orange Beach Resident Beach"],
			["orange-beach-tower-5", 30.2625391, -87.6070963, "Romar Beach"],
			["orange-beach-tower-6", 30.2580614, -87.6252913, "Near The Oasis at Orange Beach"],
		]);
		expect(towers.every((poi) => poi.behavior?.seasonal && poi.behavior.staffingStatus === "notProvided" && poi.provenance.verifiedOn === "2026-08-08")).toBe(true);
	});

	it("preserves required verification metadata for every baseline record", () => {
		expect(mapPOICatalog.pois.every(({ provenance }) => provenance.authority && provenance.sourceID && provenance.sourceTitle && provenance.sourceURL.startsWith("https://") && /^2026-08-(08|10)$/.test(provenance.verifiedOn))).toBe(true);
	});
});

describe("MapKit POI validation", () => {
	it("keeps schema and catalog versions independent", () => {
		expect(MAP_POI_SCHEMA_VERSION).toBe(1);
		expect(MAP_POI_CATALOG_VERSION).toBe("2026-08-10.1");
		expect(typeof MAP_POI_CATALOG_VERSION).toBe("string");
	});

	it("accepts the production catalog", () => expect(() => validateMapPOICatalog(mapPOICatalog)).not.toThrow());

	it("rejects unsupported schema, region, category, duplicate IDs, and count mismatch", () => {
		let catalog = clone(); (catalog as unknown as { schemaVersion: number }).schemaVersion = 2; invalid(catalog, /schemaVersion/);
		catalog = clone(); (catalog.pois[0] as unknown as { region: string }).region = "mobileBay"; invalid(catalog, /region/);
		catalog = clone(); (catalog.pois[0] as unknown as { category: string }).category = "restaurant"; invalid(catalog, /category/);
		catalog = clone(); catalog.pois[1].id = catalog.pois[0].id; invalid(catalog, /Duplicate POI id/);
		catalog = clone(); catalog.count -= 1; invalid(catalog, /count/);
	});

	it("rejects malformed stable IDs, empty required text, oversized catalogs, and oversized strings", () => {
		let catalog = clone(); catalog.pois[0].id = "Not Stable"; invalid(catalog, /stable-ID format/);
		catalog = clone(); catalog.pois[0].display.title = ""; invalid(catalog, /display.title/);
		catalog = clone(); catalog.pois[0].display.title = "x".repeat(161); invalid(catalog, /display.title/);
		catalog = clone(); catalog.pois = Array.from({ length: 501 }, (_, index) => ({ ...structuredClone(catalog.pois[0]), id: `future-poi-${index}`, relationships: undefined })); catalog.count = catalog.pois.length; invalid(catalog, /at most 500/);
	});

	it("rejects nonfinite, global-out-of-range, and off-coast coordinates", () => {
		let catalog = clone(); catalog.pois[0].coordinate.latitude = Number.NaN; invalid(catalog, /finite/);
		catalog = clone(); catalog.pois[0].coordinate.latitude = 91; invalid(catalog, /global bounds/);
		catalog = clone(); catalog.pois[0].coordinate.latitude = 45; invalid(catalog, /sanity envelope/);
	});

	it("rejects invalid provenance URLs and verification dates", () => {
		let catalog = clone(); catalog.pois[0].provenance.sourceURL = "http://example.gov"; invalid(catalog, /HTTPS/);
		catalog = clone(); catalog.pois[0].provenance.verifiedOn = "2026-02-30"; invalid(catalog, /YYYY-MM-DD/);
	});

	it("rejects duplicate enabled and unknown Beach Guide relationships", () => {
		let catalog = clone(); catalog.pois[1].relationships = { beachGuideAccessPointID: catalog.pois[0].id }; invalid(catalog, /Duplicate enabled/);
		catalog = clone(); catalog.pois[0].relationships = { beachGuideAccessPointID: "not-in-bundle" }; invalid(catalog, /unknown bundled/);
	});

	it("allows a duplicate relationship when all but one record are disabled", () => {
		const catalog = clone();
		catalog.pois[1].enabled = false;
		catalog.pois[1].relationships = { beachGuideAccessPointID: catalog.pois[0].id };
		expect(() => validateMapPOICatalog(catalog)).not.toThrow();
	});

	it("rejects lifeguard records that lose seasonal semantics or imply live staffing", () => {
		let catalog = clone(); const tower = catalog.pois.find(({ category }) => category === "lifeguardTower")!; tower.behavior = { seasonal: false, staffingStatus: "notProvided" }; invalid(catalog, /seasonal/);
		catalog = clone(); catalog.pois.find(({ category }) => category === "lifeguardTower")!.display.subtitle = "Currently staffed"; invalid(catalog, /live lifeguard staffing/);
	});

	it("represents disabled records and permits future catalog sizes", () => {
		const catalog = clone();
		catalog.pois[0].enabled = false;
		catalog.pois.pop();
		catalog.count = catalog.pois.length;
		expect(catalog.count).toBe(25);
		expect(() => validateMapPOICatalog(catalog)).not.toThrow();
	});
});

describe("MapKit POI content identity", () => {
	it("is deterministic and agrees with an independent SHA-256 calculation", async () => {
		const first = await mapPOICatalogFingerprint(mapPOICatalog);
		const second = await mapPOICatalogFingerprint(clone());
		const independent = createHash("sha256").update(canonicalMapPOICatalogContent(mapPOICatalog)).digest("hex");
		expect(first).toBe(second);
		expect(first).toBe(independent);
		expect(first).toMatch(/^[a-f0-9]{64}$/);
	});

	it("changes for meaningful content but ignores unrelated volatile metadata", async () => {
		const changed = clone(); changed.pois[0].display.title += " corrected";
		expect(await mapPOICatalogFingerprint(changed)).not.toBe(await mapPOICatalogFingerprint(mapPOICatalog));
		const withRuntimeMetadata = { ...clone(), generatedAt: new Date().toISOString() };
		expect(await mapPOICatalogFingerprint(withRuntimeMetadata)).toBe(await mapPOICatalogFingerprint(mapPOICatalog));
	});
});

describe("GET /v1/map-pois", () => {
	it("returns the complete validated catalog and cache headers", async () => {
		const response = await worker.fetch(new Request("https://example.com/v1/map-pois"), {} as Env);
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
		expect(response.headers.get("Cache-Control")).toBe(MAP_POI_CACHE_CONTROL);
		expect(response.headers.get("ETag")).toBe(`"${await mapPOICatalogFingerprint(mapPOICatalog)}"`);
		expect(await response.json()).toEqual(mapPOICatalog);
	});

	it("returns an empty 304 with useful headers for a matching validator", async () => {
		const etag = `"${await mapPOICatalogFingerprint(mapPOICatalog)}"`;
		const response = await worker.fetch(new Request("https://example.com/v1/map-pois", { headers: { "If-None-Match": etag } }), {} as Env);
		expect(response.status).toBe(304);
		expect(await response.text()).toBe("");
		expect(response.headers.get("ETag")).toBe(etag);
		expect(response.headers.get("Cache-Control")).toBe(MAP_POI_CACHE_CONTROL);
	});

	it("returns 200 for a nonmatching validator and 405 for unsupported methods", async () => {
		expect((await worker.fetch(new Request("https://example.com/v1/map-pois", { headers: { "If-None-Match": '"old"' } }), {} as Env)).status).toBe(200);
		const unsupported = await worker.fetch(new Request("https://example.com/v1/map-pois", { method: "POST" }), {} as Env);
		expect(unsupported.status).toBe(405);
		expect(unsupported.headers.get("Allow")).toBe("GET");
	});

	it("leaves existing routes unaffected", async () => {
		const response = await worker.fetch(new Request("https://example.com"), {} as Env);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ service: "Alabama Beach Flag API", status: "online" });
	});
});
