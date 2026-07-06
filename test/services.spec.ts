import { afterEach, describe, expect, it, vi } from "vitest";
import { extractLatestSample } from "../src/services/adem/mapper";
import { getGulfShoresFlags } from "../src/services/beachFlags/providers/gulfshores";
import { fetchNDBCWaterTemperature } from "../src/services/waterTemperature/ndbcClient";
import { normalizeWeatherCondition } from "../src/services/weather/normalizeWeatherCondition";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("water-quality mapping", () => {
	it("preserves decimal enterococcus values", () => {
		const sample = extractLatestSample([["7/6/2026", null, "", "103.9"]]);

		expect(sample.enterococcus).toBe(103.9);
		expect(sample.status).toBe("elevated");
	});
});

describe("weather-condition normalization", () => {
	it("matches freezing precipitation before generic rain and drizzle", () => {
		expect(normalizeWeatherCondition("Freezing Rain Likely")).toBe("Freezing Rain");
		expect(normalizeWeatherCondition("Patchy Freezing Drizzle")).toBe("Freezing Drizzle");
	});
});

describe("NDBC water temperatures", () => {
	it("uses the observation timestamp", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
			"#YY MM DD hh mm WTMP\n#yr mo dy hr mn degC\n2026 07 06 14 30 28.5\n",
			{ status: 200 },
		)));

		const result = await fetchNDBCWaterTemperature("TEST");

		expect(result.temperature).toBe(83);
		expect(result.observedAt).toBe("2026-07-06T14:30:00.000Z");
	});

	it("rejects NDBC missing-value sentinels", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
			"#YY MM DD hh mm WTMP\n#yr mo dy hr mn degC\n2026 07 06 14 30 999.0\n",
			{ status: 200 },
		)));

		await expect(fetchNDBCWaterTemperature("TEST")).rejects.toThrow(
			"Invalid water temperature",
		);
	});
});

describe("beach-flag parsing", () => {
	it("does not publish an official report when the source format is unrecognized", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
			new Response("<html><p>Beach information unavailable</p></html>", { status: 200 }),
		));

		const result = await getGulfShoresFlags("2026-07-06T14:30:00.000Z");

		expect(result.reports).toEqual([]);
		expect(result.errors).toHaveLength(3);
	});
});
