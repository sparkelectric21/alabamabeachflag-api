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
	const generatedAt = "2026-07-06T14:30:00.000Z";

	async function parseGulfShores(html: string) {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
			new Response(html, { status: 200 }),
		));

		return getGulfShoresFlags(generatedAt);
	}

	function currentConditions(primary: string, secondary?: string): string {
		return `
			<html>
				<p>Surf Conditions:</p>
				<p>${primary}</p>
				${secondary ? `<p>${secondary}</p>` : ""}
			</html>
		`;
	}

	it.each([
		["Low Hazard", "green"],
		["Medium Hazard", "yellow"],
		["High Hazard", "red"],
		["Double Red Flags - Water Closed", "doubleRed"],
	] as const)("parses %s as %s", async (status, expectedFlag) => {
		const result = await parseGulfShores(currentConditions(status));

		expect(result.errors).toEqual([]);
		expect(result.reports).toHaveLength(3);
		expect(result.reports[0]).toMatchObject({
			primaryFlag: expectedFlag,
			hasPurpleFlag: false,
		});
	});

	it("parses yellow with a purple dangerous-marine-life flag", async () => {
		const result = await parseGulfShores(
			currentConditions("Medium Hazard", "Dangerous Marine Life"),
		);

		expect(result.errors).toEqual([]);
		expect(result.reports[0]).toMatchObject({
			primaryFlag: "yellow",
			hasPurpleFlag: true,
		});
	});

	it("ignores purple text in the static educational legend", async () => {
		const result = await parseGulfShores(`
			${currentConditions("Medium Hazard")}
			<section id="flag-legend">
				<h2>Beach Warning Flags</h2>
				<p>Purple Flag - Dangerous Marine Life</p>
			</section>
		`);

		expect(result.reports[0]).toMatchObject({
			primaryFlag: "yellow",
			hasPurpleFlag: false,
		});
	});

	it("does not treat the static educational legend as current conditions", async () => {
		const result = await parseGulfShores(`
			<section id="flag-legend">
				<p>Green Flag - Low Hazard</p>
				<p>Yellow Flag - Medium Hazard</p>
				<p>Red Flag - High Hazard</p>
				<p>Double Red Flags - Water Closed</p>
				<p>Purple Flag - Dangerous Marine Life</p>
			</section>
		`);

		expect(result.reports).toEqual([]);
		expect(result.errors).toHaveLength(3);
	});

	it("does not publish an official report when the source format is unrecognized", async () => {
		const result = await parseGulfShores(
			"<html><p>Beach information unavailable</p></html>",
		);

		expect(result.reports).toEqual([]);
		expect(result.errors).toHaveLength(3);
	});
});
