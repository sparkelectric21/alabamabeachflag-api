import { afterEach, describe, expect, it, vi } from "vitest";
import { extractLatestSample } from "../src/services/adem/mapper";
import { getGulfShoresFlags } from "../src/services/beachFlags/providers/gulfshores";
import { getOrangeBeachFlags } from "../src/services/beachFlags/providers/orangeBeach";
import { getDauphinIslandFlags } from "../src/services/beachFlags/providers/dauphinIsland";
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
	const dds = (dimension = 10) => `Dataset {\n Int32 time[time = ${dimension}];\n} station;`;
	const ascii = (temperature: string, epochSeconds = 1785448800) =>
		"sea_surface_temperature.sea_surface_temperature[1][1][1]\n"
		+ `[0][0], ${temperature}\n\n`
		+ `time[1]\n${epochSeconds}\n`;
	const response = (body: string, contentType = "text/plain") =>
		new Response(body, { status: 200, headers: { "Content-Type": contentType } });

	it("uses the observation timestamp", async () => {
		vi.stubGlobal("fetch", vi.fn()
			.mockResolvedValueOnce(response(dds()))
			.mockResolvedValueOnce(response(ascii("28.5", 1783348200))));

		const result = await fetchNDBCWaterTemperature("TEST");

		expect(result.temperature).toBe(83);
		expect(result.observedAt).toBe("2026-07-06T14:30:00.000Z");
	});

	it("rejects NDBC missing-value sentinels", async () => {
		vi.stubGlobal("fetch", vi.fn()
			.mockResolvedValueOnce(response(dds()))
			.mockResolvedValueOnce(response(ascii("999.0"))));

		await expect(fetchNDBCWaterTemperature("TEST")).rejects.toThrow(
			"No valid water temperature",
		);
	});

	it("rejects malformed or excessive THREDDS dimensions before requesting data", async () => {
		const fetchMock = vi.fn().mockResolvedValue(response(dds(1_000_001)));
		vi.stubGlobal("fetch", fetchMock);

		await expect(fetchNDBCWaterTemperature("PPTA1")).rejects.toThrow(
			"Unexpected NDBC schema",
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("uses a bounded last-value query and bypasses shared upstream caching", async () => {
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(response(dds(8459)))
			.mockResolvedValueOnce(response(ascii("29.6", 1785456600)));
		vi.stubGlobal("fetch", fetchMock);

		await expect(fetchNDBCWaterTemperature("42012")).resolves.toMatchObject({
			temperature: 85,
			observedAt: "2026-07-31T00:10:00.000Z",
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
		for (const call of fetchMock.mock.calls) {
			expect(call[1]).toEqual(expect.objectContaining({
				cache: "no-store",
				redirect: "manual",
			}));
		}
		const requestHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
		expect((fetchMock.mock.calls[0]?.[0] as URL).href).toBe(
			"https://dods.ndbc.noaa.gov/thredds/dodsC/data/stdmet/42012/42012h9999.nc.dds",
		);
		expect(decodeURIComponent((fetchMock.mock.calls[1]?.[0] as URL).href)).toBe(
			"https://dods.ndbc.noaa.gov/thredds/dodsC/data/stdmet/42012/42012h9999.nc.ascii"
			+ "?time[8458:1:8458],sea_surface_temperature[8458:1:8458][0:1:0][0:1:0]",
		);
		expect(requestHeaders.get("Accept")).toBe("text/plain");
		expect(requestHeaders.get("User-Agent")).toBe(
			"AlabamaBeachFlagAPI/1.0 (operations@alabamabeachflag.com)",
		);
	});

	it("rejects HTML denial responses instead of parsing them", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(
			"<html><body>upstream error</body></html>",
			"text/html",
		)));
		await expect(fetchNDBCWaterTemperature("PPTA1")).rejects.toThrow(
			"unexpected_content_type",
		);
	});

	it("rejects unsafe station identifiers before fetching", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		await expect(fetchNDBCWaterTemperature("../PPTA1")).rejects.toThrow(
			"Invalid NDBC station identifier",
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("beach-flag parsing", () => {
	const generatedAt = "2026-07-06T14:30:00.000Z";

	async function parseGulfShores(html: string) {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
			new Response(html, { status: 200, headers: { "Content-Type": "text/html" } }),
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

	function surfImage(documentId: string, attributes = "alt=\"\""): string {
		return `
			<div id="surfTS">
				<div class="pageContent">
					<div class="widgetBody">
						<img src="/ImageRepository/Document?documentID=${documentId}" ${attributes}>
					</div>
				</div>
			</div>
		`;
	}

	it("parses the captured live #surfTS image markup", async () => {
		const result = await parseGulfShores(`
			<div data-cpRole="contentContainer" id="surfTS">
				<div class="pageContent cpGrid cpGrid24 isLockedContainer showInMobile">
					<li class="widgetItem GraphicLinks"><a href="/1136/Beach-Safety">
						<img src="/ImageRepository/Document?documentID=4339"
							class="graphicButtonLink" alt=""
							onmouseover="this.src='/ImageRepository/Document?documentID=4340'"
							onmouseout="this.src='/ImageRepository/Document?documentID=4339'">
					</a></li>
				</div>
			</div>
		`);

		expect(result.errors).toEqual([]);
		expect(result.reports).toHaveLength(3);
		expect(result.reports[0]).toMatchObject({
			primaryFlag: "doubleRed",
			hasPurpleFlag: false,
		});
	});

	it.each([
		["3006", "doubleRed", false],
		["3007", "doubleRed", false],
		["4339", "doubleRed", false],
		["4340", "doubleRed", false],
		["3010", "red", false],
		["3011", "red", true],
		["3012", "green", true],
		["3013", "green", true],
		["3014", "green", false],
		["3015", "green", false],
		["3016", "yellow", true],
		["3017", "yellow", true],
		["3018", "red", false],
		["3019", "red", true],
		["3020", "yellow", true],
		["3021", "yellow", true],
		["3022", "yellow", false],
		["3023", "yellow", false],
	] as const)(
		"maps current-condition image %s to %s with purple=%s",
		async (documentId, expectedFlag, expectedPurple) => {
			const result = await parseGulfShores(surfImage(documentId));

			expect(result.errors).toEqual([]);
			expect(result.reports[0]).toMatchObject({
				primaryFlag: expectedFlag,
				hasPurpleFlag: expectedPurple,
			});
		},
	);

	it("gives explicit Double Red semantics precedence over a lower-severity ID", async () => {
		const result = await parseGulfShores(
			surfImage("3011", 'alt="Surf Conditions: Closed to Public - Double Red Flags"'),
		);

		expect(result.errors).toEqual([]);
		expect(result.reports[0]).toMatchObject({
			primaryFlag: "doubleRed",
			hasPurpleFlag: false,
		});
	});

	it("uses active-image semantics when CivicPlus changes the document ID", async () => {
		const result = await parseGulfShores(
			surfImage("99999", 'title="Double Red Flags - Water Closed"'),
		);

		expect(result.errors).toEqual([]);
		expect(result.reports[0]).toMatchObject({
			primaryFlag: "doubleRed",
			hasPurpleFlag: false,
		});
	});

	it("preserves an active Purple Advisory when supplied with a primary flag", async () => {
		const result = await parseGulfShores(
			surfImage("99999", 'aria-label="Red Flag - High Hazard; Purple Flag - Dangerous Marine Life"'),
		);

		expect(result.errors).toEqual([]);
		expect(result.reports[0]).toMatchObject({
			primaryFlag: "red",
			hasPurpleFlag: true,
		});
	});

	it("fails safely for an unknown #surfTS image document ID", async () => {
		const result = await parseGulfShores(surfImage("99999"));

		expect(result.reports).toEqual([]);
		expect(result.errors).toHaveLength(3);
		expect(result.errors[0]?.message).toBe("provider_unavailable");
	});

	it("ignores permanent legend image IDs outside #surfTS", async () => {
		const result = await parseGulfShores(`
			${surfImage("3016")}
			<section id="flag-legend">
				<img src="/ImageRepository/Document?documentID=10807">
				<img src="/ImageRepository/Document?documentID=10804">
			</section>
		`);

		expect(result.errors).toEqual([]);
		expect(result.reports[0]).toMatchObject({
			primaryFlag: "yellow",
			hasPurpleFlag: true,
		});
	});

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

	it("returns errors when there is no current conditions container or text", async () => {
		const result = await parseGulfShores("<html><main>Beach Safety</main></html>");

		expect(result.reports).toEqual([]);
		expect(result.errors).toHaveLength(3);
	});

	it("redacts public provider implementation details", async () => {
		const gulfShores = await parseGulfShores("<html><main>unrecognized</main></html>");
		const dauphinIsland = await getDauphinIslandFlags();
		expect([...gulfShores.errors, ...dauphinIsland.errors].every((error) => error.message === "provider_unavailable")).toBe(true);
	});
});

describe("Orange Beach flag parsing", () => {
	it("parses the current live Double Red daily report without reading the legend", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(`
			<div class="fr-view">
				<blockquote><h2>Orange Beach Daily Beach Report for Tuesday, July 21, 2026 - 10:45 a.m. UPDATE</h2></blockquote>
				<ul><li><strong>Today&rsquo;s Flag Color:&nbsp;</strong>Double Red Flags. Double Red Flags represent Gulf waters are closed to the public.</li></ul>
				<p>Sign up to receive daily beach conditions and warning flag status</p>
			</div>
			<section><h3>High Hazard, Marine Life</h3><img alt="Beach Flag Red Purple - High Hazard, Marine Life"></section>
		`, { status: 200, headers: { "Content-Type": "text/html" } })));

		const result = await getOrangeBeachFlags("2026-07-21T16:45:00.000Z");

		expect(result.errors).toEqual([]);
		expect(result.reports.map(({ beachId, primaryFlag, hasPurpleFlag }) => ({
			beachId,
			primaryFlag,
			hasPurpleFlag,
		}))).toEqual([
			{ beachId: "cotton-bayou", primaryFlag: "doubleRed", hasPurpleFlag: false },
			{ beachId: "alabama-point", primaryFlag: "doubleRed", hasPurpleFlag: false },
			{ beachId: "florida-point", primaryFlag: "doubleRed", hasPurpleFlag: false },
		]);
	});
});
