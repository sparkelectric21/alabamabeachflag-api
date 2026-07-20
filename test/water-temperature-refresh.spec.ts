import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchNDBCWaterTemperature, fetchWaterTemperature } = vi.hoisted(() => ({
	fetchNDBCWaterTemperature: vi.fn(),
	fetchWaterTemperature: vi.fn(),
}));

vi.mock("../src/services/waterTemperature/ndbcClient", () => ({ fetchNDBCWaterTemperature }));
vi.mock("../src/services/waterTemperature/client", () => ({ fetchWaterTemperature }));

import { beaches } from "../src/config/BeachRegistry";
import { refreshWaterTemperatures } from "../src/services/waterTemperature/refresh";

const observedAt = "2026-07-20T18:00:00.000Z";

describe("configured water-temperature refresh", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.setSystemTime(new Date("2026-07-20T18:30:00.000Z"));
		fetchNDBCWaterTemperature.mockImplementation(async (stationId: string) => ({
			temperature: stationId === "DPHA1" ? 86 : 85,
			temperatureUnit: "F",
			observedAt,
		}));
		fetchWaterTemperature.mockResolvedValue({ temperature: 87, temperatureUnit: "F", observedAt });
	});

	it("uses PPTA1 for Pavilion and leaves Little Lagoon unavailable without requesting BSCA1", async () => {
		const results = await refreshWaterTemperatures();

		expect(results["gulf-state-park-pavilion"]).toEqual({
			temperature: 85,
			temperatureUnit: "F",
			observedAt,
			provider: "ndbc",
			stationId: "PPTA1",
			freshnessStatus: "current",
			ageMinutes: 30,
			staleAfterMinutes: 120,
			unavailableAfterMinutes: 360,
		});
		expect(results["little-lagoon-pass"]).toBeUndefined();
		expect(fetchNDBCWaterTemperature).not.toHaveBeenCalledWith("BSCA1");
	});

	it("applies the same stale-but-usable policy to all sole-source stations", async () => {
		vi.setSystemTime(new Date("2026-07-20T20:15:00.000Z"));

		const results = await refreshWaterTemperatures();
		const expected = {
			temperature: 85,
			temperatureUnit: "F",
			observedAt,
			provider: "ndbc",
			stationId: "PPTA1",
			freshnessStatus: "stale",
			ageMinutes: 135,
			staleAfterMinutes: 120,
			unavailableAfterMinutes: 360,
		};

		expect(results["gulf-shores-public-beach"]).toEqual(expected);
		expect(results["cotton-bayou"]).toEqual(expected);
		expect(results["gulf-state-park-pavilion"]).toEqual(expected);
		expect(results["fort-morgan-public-beach"]).toMatchObject({
			provider: "ndbc", stationId: "DPHA1", freshnessStatus: "stale",
			staleAfterMinutes: 120, unavailableAfterMinutes: 360,
		});
		expect(results["dauphin-island-public-beach"]).toMatchObject({
			provider: "coops", stationId: "8735180", freshnessStatus: "stale",
			staleAfterMinutes: 120, unavailableAfterMinutes: 360,
		});
		expect(results["little-lagoon-pass"]).toBeUndefined();
	});

	it("keeps every beach's approved general-temperature mapping explicit", () => {
		const configured = Object.fromEntries(beaches.map((beach) => [
			beach.id,
			beach.waterTemperature?.sources.map(({ provider, stationId }) => `${provider}:${stationId}`),
		]));

		expect(configured).toEqual({
			"alabama-point": ["ndbc:PPTA1", "coops:8735180"],
			"cotton-bayou": ["ndbc:PPTA1"],
			"gulf-shores-public-beach": ["ndbc:PPTA1"],
			"gulf-state-park-pavilion": ["ndbc:PPTA1"],
			"little-lagoon-pass": undefined,
			"florida-point": ["ndbc:PPTA1", "coops:8735180"],
			"fort-morgan-public-beach": ["ndbc:DPHA1"],
			"dauphin-island-public-beach": ["coops:8735180"],
			"dauphin-island-east-end": ["ndbc:DPHA1", "coops:8735180"],
		});
		expect(beaches.find(({ id }) => id === "little-lagoon-pass")?.supports.waterTemperature).toBe(false);
	});
});
