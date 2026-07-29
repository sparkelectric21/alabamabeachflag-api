import { describe, expect, it } from "vitest";
import { beaches } from "../src/config/BeachRegistry";
import { loadProviderCatalog, PROVIDER_CATALOG_ROLES } from "../src/providerHealth/catalog";
import { VERIFIERS, historyPrefix, latestReportKey } from "../src/verification/registry";

const beach = (id: string) => {
	const definition = beaches.find((candidate) => candidate.id === id);
	if (!definition) throw new Error(`Missing beach fixture: ${id}`);
	return definition;
};

describe("physical destination coordinate corrections", () => {
	it("keeps Gulf State Park Beach Pavilion purposes distinct", () => {
		const pavilion = beach("gulf-state-park-pavilion");
		const gulfPlace = beach("gulf-shores-public-beach");

		expect(pavilion).toMatchObject({
			id: "gulf-state-park-pavilion",
			ademCode: "GSP_PAV",
			displayName: "Gulf State Park Beach Pavilion",
			address: "22250 East Beach Boulevard, Gulf Shores, AL 36542",
			managingAuthority: "Alabama State Parks",
			location: { latitude: 30.25517036, longitude: -87.64240986 },
			regionalCondition: {
				region: "gulfShores",
				latitude: 30.2499,
				longitude: -87.6847,
			},
			waterQualitySample: { latitude: 30.25472, longitude: -87.64333 },
		});
		expect(pavilion.location).not.toEqual(gulfPlace.location);
		expect(pavilion.location).not.toEqual(pavilion.waterQualitySample);
	});

	it("keeps Fort Morgan Mobile Street and the ADEM sample distinct", () => {
		const fortMorgan = beach("fort-morgan-public-beach");

		expect(fortMorgan).toMatchObject({
			id: "fort-morgan-public-beach",
			ademCode: "FRT_MGN",
			displayName: "Fort Morgan — Mobile Street Beach Access",
			managingAuthority: "U.S. Fish and Wildlife Service",
			location: { latitude: 30.2299, longitude: -88.0244 },
			regionalCondition: {
				region: "fortMorgan",
				latitude: 30.2285,
				longitude: -88.0243,
			},
			waterQualitySample: { latitude: 30.2258, longitude: -88.0094 },
		});
		expect(fortMorgan.location).not.toEqual(fortMorgan.waterQualitySample);
		expect(fortMorgan.location).not.toEqual({ latitude: 30.228, longitude: -88.023 });
	});
});

describe("coordinate correction behavioral safeguards", () => {
	it("preserves registry size, ordering, stable IDs, and ADEM station mapping", () => {
		expect(beaches).toHaveLength(9);
		expect(beaches.map(({ id }) => id)).toEqual([
			"alabama-point",
			"cotton-bayou",
			"gulf-shores-public-beach",
			"gulf-state-park-pavilion",
			"little-lagoon-pass",
			"florida-point",
			"fort-morgan-public-beach",
			"dauphin-island-public-beach",
			"dauphin-island-east-end",
		]);
		expect(beach("gulf-state-park-pavilion").ademCode).toBe("GSP_PAV");
		expect(beach("fort-morgan-public-beach").ademCode).toBe("FRT_MGN");
	});

	it("preserves provider-driving weather, UV, tide, and water-temperature configuration", () => {
		expect(beach("gulf-state-park-pavilion")).toMatchObject({
			weather: { latitude: 30.2499, longitude: -87.6847 },
			uv: { region: "orangeBeach", latitude: 30.248108, longitude: -87.71726 },
			tide: { stationId: "8731439" },
			waterTemperature: { sources: [{ provider: "ndbc", stationId: "42012" }, { provider: "ndbc", stationId: "PPTA1" }] },
			supports: { beachFlags: "official", waterQuality: true },
		});
		expect(beach("fort-morgan-public-beach")).toMatchObject({
			weather: { latitude: 30.2285, longitude: -88.0243 },
			uv: { region: "fortMorgan", latitude: 30.2285, longitude: -88.0243 },
			tide: { stationId: "8734635" },
			waterTemperature: { sources: [
				{ provider: "ndbc", stationId: "42357" },
				{ provider: "ndbc", stationId: "DPHA1" },
				{ provider: "ndbc", stationId: "42012" },
			] },
			supports: { beachFlags: "future", waterQuality: true },
		});
	});

	it("preserves verification and provider catalog fixtures", async () => {
		expect(VERIFIERS).toHaveLength(2);
		expect(VERIFIERS.flatMap(({ locations }) => locations.map(({ id }) => id))).toContain("gulf-state-park-pavilion");
		expect(latestReportKey("gulf-shores-flags")).toBe("verification:gulf-shores-flags:latest");
		expect(historyPrefix("gulf-shores-flags")).toBe("verification:gulf-shores-flags:report:");
		const catalog = await loadProviderCatalog({
			BEACH_DATA: { get: async () => null } as unknown as KVNamespace,
		});
		expect(catalog).toHaveLength(27);
		expect(catalog.every(({ role }) => PROVIDER_CATALOG_ROLES.includes(role))).toBe(true);
	});
});
