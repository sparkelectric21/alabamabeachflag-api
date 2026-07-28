import { describe, expect, it } from "vitest";
import { beaches } from "../src/config/BeachRegistry";

const beach = (id: string) => {
	const result = beaches.find((candidate) => candidate.id === id);
	if (!result) throw new Error(`Missing beach ${id}`);
	return result;
};

describe("per-beach Vibrio coverage policy", () => {
	it.each(["little-lagoon-pass", "gulf-state-park-pavilion"])("excludes %s from public Vibrio output", (id) => {
		expect(beach(id).vibrioConditions.eligible).toBe(false);
	});

	it("keeps the corrected Pavilion coordinate isolated from shared app geography", () => {
		const pavilion = beach("gulf-state-park-pavilion");
		expect(pavilion.location).toEqual({ latitude: 30.2499, longitude: -87.6847 });
		expect(pavilion.weather).toEqual({ latitude: 30.2499, longitude: -87.6847 });
		expect(pavilion.vibrioConditions).toMatchObject({
			eligible: false,
			mappingLocation: { latitude: 30.25517036, longitude: -87.64240986 },
		});
	});

	it("uses separate general-temperature and Vibrio station policies", () => {
		const gulfShores = beach("gulf-shores-public-beach");
		expect(gulfShores.waterTemperature?.sources.map(({ stationId }) => stationId)).toEqual(["42012", "PPTA1"]);
		expect(gulfShores.vibrioConditions).toMatchObject({
			eligible: true,
			waterTemperature: { sources: [
				{ provider: "ndbc", stationId: "PPTA1" },
			] },
		});
	});

	it("keeps Fort Morgan's general hierarchy separate from its Vibrio source", () => {
		const fortMorgan = beach("fort-morgan-public-beach");
		expect(fortMorgan.waterTemperature?.sources.map(({ stationId }) => stationId)).toEqual(["42357", "DPHA1", "42012"]);
		if (!fortMorgan.vibrioConditions.eligible) throw new Error("Fort Morgan unexpectedly excluded");
		expect(fortMorgan.vibrioConditions.waterTemperature.sources.map(({ stationId }) => stationId)).toEqual(["DPHA1"]);
	});

	it("keeps every other beach eligible with an explicit approved source order", () => {
		const eligible = beaches.filter((candidate) => candidate.vibrioConditions.eligible);
		expect(eligible.map(({ id }) => id)).toEqual([
			"alabama-point",
			"cotton-bayou",
			"gulf-shores-public-beach",
			"florida-point",
			"fort-morgan-public-beach",
			"dauphin-island-public-beach",
			"dauphin-island-east-end",
		]);
		for (const candidate of eligible) {
			if (!candidate.vibrioConditions.eligible) continue;
			expect(candidate.vibrioConditions.waterTemperature.sources.length).toBeGreaterThan(0);
		}
	});
});
