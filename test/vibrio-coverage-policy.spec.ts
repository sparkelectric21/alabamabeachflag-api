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

	it("keeps the corrected Pavilion destination isolated from provider-driving geography", () => {
		const pavilion = beach("gulf-state-park-pavilion");
		expect(pavilion.location).toEqual({ latitude: 30.25517036, longitude: -87.64240986 });
		expect(pavilion.regionalCondition).toEqual({
			region: "gulfShores",
			latitude: 30.2499,
			longitude: -87.6847,
		});
		expect(pavilion.weather).toEqual({ latitude: 30.2499, longitude: -87.6847 });
		expect(pavilion.vibrioConditions).toMatchObject({
			eligible: false,
			mappingLocation: { latitude: 30.25517036, longitude: -87.64240986 },
		});
	});

	it("uses separate general-temperature and Vibrio station policies", () => {
		const gulfShores = beach("gulf-shores-public-beach");
		expect(gulfShores.waterTemperature?.sources.map(({ stationId }) => stationId)).toEqual(["PPTA1", "42012", "42357"]);
		expect(gulfShores.vibrioConditions).toMatchObject({
			eligible: true,
			waterTemperature: { sources: [
				{ provider: "ndbc", stationId: "PPTA1" },
			] },
		});
	});

	it("keeps Fort Morgan's general hierarchy separate from its Vibrio source", () => {
		const fortMorgan = beach("fort-morgan-public-beach");
		expect(fortMorgan.waterTemperature?.sources.map(({ stationId }) => stationId)).toEqual(["DPHA1", "42357", "42012"]);
		if (!fortMorgan.vibrioConditions.eligible) throw new Error("Fort Morgan unexpectedly excluded");
		expect(fortMorgan.vibrioConditions.waterTemperature.sources.map(({ stationId }) => stationId)).toEqual(["42357", "DPHA1", "8735180"]);
	});

	it("regression: keeps every Vibrio water-temperature source array unchanged", () => {
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
		expect(Object.fromEntries(eligible.map((candidate) => [
			candidate.id,
			candidate.vibrioConditions.eligible
				? candidate.vibrioConditions.waterTemperature.sources.map(({ provider, stationId }) => `${provider}:${stationId}`)
				: [],
		]))).toEqual({
			"alabama-point": ["ndbc:PPTA1"],
			"cotton-bayou": ["ndbc:PPTA1"],
			"gulf-shores-public-beach": ["ndbc:PPTA1"],
			"florida-point": ["ndbc:PPTA1"],
			"fort-morgan-public-beach": ["ndbc:42357", "ndbc:DPHA1", "coops:8735180"],
			"dauphin-island-public-beach": ["coops:8735180", "ndbc:DPHA1", "ndbc:42357"],
			"dauphin-island-east-end": ["ndbc:DPHA1", "coops:8735180", "ndbc:42357"],
		});
	});

	it("regression: keeps the complete Vibrio coverage configuration unchanged", () => {
		expect(Object.fromEntries(beaches.map(({ id, vibrioConditions }) => [id, vibrioConditions]))).toEqual({
			"alabama-point": {
				eligible: true,
				waterTemperature: { sources: [{ provider: "ndbc", stationId: "PPTA1" }] },
				limitation: "Perdido Pass observations are nearby proxies, not measurements at this beach.",
			},
			"cotton-bayou": {
				eligible: true,
				waterTemperature: { sources: [{ provider: "ndbc", stationId: "PPTA1" }] },
				limitation: "Perdido Pass observations are nearby proxies, not measurements at this beach.",
			},
			"gulf-shores-public-beach": {
				eligible: true,
				waterTemperature: { sources: [{ provider: "ndbc", stationId: "PPTA1" }] },
				limitation: "Perdido Pass and Mobile Bay entrance observations are proxies, not Gulf Shores beach measurements.",
			},
			"gulf-state-park-pavilion": {
				eligible: false,
				reason: "Corrected Pavilion coordinates and NOAA proxy mapping require external validation before public output.",
				mappingLocation: {
					latitude: 30.25517036,
					longitude: -87.64240986,
					source: "Alabama State Parks address; federal Geographic Response Plan site AL-25 coordinates",
				},
			},
			"little-lagoon-pass": {
				eligible: false,
				reason: "The lagoon-pass environment lacks a validated approved direct-observation proxy.",
			},
			"florida-point": {
				eligible: true,
				waterTemperature: { sources: [{ provider: "ndbc", stationId: "PPTA1" }] },
				limitation: "Perdido Pass observations are nearby proxies, not measurements at this beach.",
			},
			"fort-morgan-public-beach": {
				eligible: true,
				waterTemperature: { sources: [
					{ provider: "ndbc", stationId: "42357" },
					{ provider: "ndbc", stationId: "DPHA1" },
					{ provider: "coops", stationId: "8735180" },
				] },
				limitation: "The Gulf-facing 42357 observation and Dauphin Island/Mobile Bay entrance observations are proxies, not Fort Morgan beach measurements.",
			},
			"dauphin-island-public-beach": {
				eligible: true,
				waterTemperature: { sources: [
					{ provider: "coops", stationId: "8735180" },
					{ provider: "ndbc", stationId: "DPHA1" },
					{ provider: "ndbc", stationId: "42357" },
				] },
				limitation: "East-end observations and the lower-priority Gulf-facing 42357 observation are proxies for the public beach farther west.",
			},
			"dauphin-island-east-end": {
				eligible: true,
				waterTemperature: { sources: [
					{ provider: "ndbc", stationId: "DPHA1" },
					{ provider: "coops", stationId: "8735180" },
					{ provider: "ndbc", stationId: "42357" },
				] },
				limitation: "The east-end stations are the strongest spatial match; lower-priority 42357 is Gulf-facing, but all remain point observations.",
			},
		});
	});
});
