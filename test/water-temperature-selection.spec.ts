import { describe, expect, it, vi } from "vitest";
import { beaches, type BeachDefinition } from "../src/config/BeachRegistry";
import { estimateVibrioConditions } from "../src/services/vibrio/estimator";
import {
	fetchLatestWaterTemperature,
	type WaterTemperatureObservationWithSource,
} from "../src/services/waterTemperature/service";

const now = new Date("2026-07-17T18:00:00.000Z");
const sources = (...items: Array<["ndbc" | "coops", string]>): NonNullable<BeachDefinition["waterTemperature"]> => ({
	sources: items.map(([provider, stationId]) => ({ provider, stationId })),
});
const observation = (
	provider: "ndbc" | "coops",
	stationId: string,
	observedAt: string,
	temperature = 84,
): WaterTemperatureObservationWithSource => ({
	provider,
	stationId,
	observedAt,
	temperature,
	temperatureUnit: "F",
});

function loader(entries: Record<string, WaterTemperatureObservationWithSource | Error>) {
	return vi.fn(async (source: { provider: "ndbc" | "coops"; stationId: string }) => {
		const value = entries[`${source.provider}:${source.stationId}`];
		if (value instanceof Error) throw value;
		if (!value) throw new Error("Unexpected source");
		return value;
	});
}

describe("water-temperature source selection", () => {
	it("uses the preferred NDBC station when it is fresh", async () => {
		const loadSource = loader({
			"ndbc:PPTA1": observation("ndbc", "PPTA1", "2026-07-17T17:00:00.000Z"),
			"coops:8735180": observation("coops", "8735180", "2026-07-17T17:50:00.000Z"),
		});

		const result = await fetchLatestWaterTemperature(sources(["ndbc", "PPTA1"], ["coops", "8735180"]), new Map(), { now, loadSource });

		expect(result.stationId).toBe("PPTA1");
		expect(loadSource).toHaveBeenCalledTimes(1);
	});

	it.each([
		["exactly two hours", "2026-07-17T16:00:00.000Z"],
		["inside the PPTA1 grace period", "2026-07-17T15:30:00.000Z"],
	])("accepts PPTA1 observations %s", async (_case, observedAt) => {
		const expected = observation("ndbc", "PPTA1", observedAt);
		const result = await fetchLatestWaterTemperature(sources(["ndbc", "PPTA1"]), new Map(), {
			now,
			loadSource: async () => expected,
		});

		expect(result).toEqual(expected);
	});

	it("rejects PPTA1 observations older than two hours thirty minutes", async () => {
		const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const loadSource = async () => observation("ndbc", "PPTA1", "2026-07-17T15:29:59.999Z");

		await expect(fetchLatestWaterTemperature(sources(["ndbc", "PPTA1"]), new Map(), { now, loadSource }))
			.rejects.toThrow("No approved fresh water temperature source");
		expect(log).toHaveBeenCalledWith(expect.stringMatching(
			/stale_observation.*provider=ndbc.*stationId=PPTA1.*observedAt=2026-07-17T15:29:59.999Z.*ageMinutes=150.*freshnessThresholdMinutes=150/,
		));
		log.mockRestore();
	});

	it.each([
		["ndbc", "DPHA1"],
		["coops", "8735180"],
	] as const)("keeps the two-hour default for %s:%s", async (provider, stationId) => {
		const loadSource = async () => observation(provider, stationId, "2026-07-17T15:59:59.999Z");

		await expect(fetchLatestWaterTemperature(sources([provider, stationId]), new Map(), { now, loadSource }))
			.rejects.toThrow("No approved fresh water temperature source");
	});

	it.each([
		["Gulf Shores", "ndbc", "PPTA1"],
		["Orange Beach / Cotton Bayou", "ndbc", "PPTA1"],
		["Fort Morgan", "ndbc", "DPHA1"],
		["Dauphin Island", "coops", "8735180"],
	] as const)("uses %s's configured primary station", async (_beachName, provider, stationId) => {
		const expected = observation(provider, stationId, "2026-07-17T17:00:00.000Z");
		const loadSource = loader({ [`${provider}:${stationId}`]: expected });

		await expect(fetchLatestWaterTemperature(sources([provider, stationId]), new Map(), { now, loadSource }))
			.resolves.toEqual(expected);
	});

	it("skips a stale preferred NDBC observation for an approved fresh CO-OPS fallback", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const loadSource = loader({
			"ndbc:PPTA1": observation("ndbc", "PPTA1", "2026-07-17T15:00:00.000Z"),
			"coops:8735180": observation("coops", "8735180", "2026-07-17T17:50:00.000Z", 86),
		});

		const result = await fetchLatestWaterTemperature(sources(["ndbc", "PPTA1"], ["coops", "8735180"]), new Map(), { now, loadSource });

		expect(result).toEqual(observation("coops", "8735180", "2026-07-17T17:50:00.000Z", 86));
		expect(log).toHaveBeenCalledWith(expect.stringContaining("staleCandidates=ndbc:PPTA1"));
		log.mockRestore();
	});

	it("returns unavailable when all configured stations are stale", async () => {
		const preferred = observation("ndbc", "PPTA1", "2026-07-17T15:00:00.000Z", 82);
		const loadSource = loader({
			"ndbc:PPTA1": preferred,
			"coops:8735180": observation("coops", "8735180", "2026-07-17T14:00:00.000Z", 84),
		});

		await expect(fetchLatestWaterTemperature(
			sources(["ndbc", "PPTA1"], ["coops", "8735180"]),
			new Map(),
			{ now, loadSource },
		)).rejects.toThrow("No approved fresh water temperature source");
	});

	it("continues when the preferred station fails to parse", async () => {
		const loadSource = loader({
			"ndbc:PPTA1": new Error("NDBC parse failure"),
			"coops:8735180": observation("coops", "8735180", "2026-07-17T17:45:00.000Z"),
		});

		const result = await fetchLatestWaterTemperature(sources(["ndbc", "PPTA1"], ["coops", "8735180"]), new Map(), { now, loadSource });

		expect(result.stationId).toBe("8735180");
	});

	it("classifies parser, timeout, and HTTP failures without logging response data", async () => {
		const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const loadSource = loader({
			"ndbc:PPTA1": new Error("WTMP column not found for station PPTA1"),
			"ndbc:DPHA1": new Error("Request timed out after 10000ms"),
			"coops:8735180": new Error("NOAA CO-OPS request failed (504)"),
		});

		await expect(fetchLatestWaterTemperature(
			sources(["ndbc", "PPTA1"], ["ndbc", "DPHA1"], ["coops", "8735180"]),
			new Map(),
			{ now, loadSource, beachId: "test-beach", diagnosticScope: "vibrio_conditions" },
		)).rejects.toThrow();
		expect(log).toHaveBeenCalledWith(expect.stringContaining("condition=ndbc_missing_water_temperature"));
		expect(log).toHaveBeenCalledWith(expect.stringContaining("condition=ndbc_timeout"));
		expect(log).toHaveBeenCalledWith(expect.stringContaining("condition=coops_http_failure"));
		log.mockRestore();
	});

	it("uses configured preference when multiple observations are fresh", async () => {
		const loadSource = loader({
			"ndbc:PPTA1": observation("ndbc", "PPTA1", "2026-07-17T17:00:00.000Z"),
			"coops:8735180": observation("coops", "8735180", "2026-07-17T17:55:00.000Z"),
		});

		const result = await fetchLatestWaterTemperature(sources(["ndbc", "PPTA1"], ["coops", "8735180"]), new Map(), { now, loadSource });

		expect(result.stationId).toBe("PPTA1");
	});

	it("never requests or selects a station outside the beach configuration", async () => {
		const loadSource = loader({
			"ndbc:PPTA1": observation("ndbc", "PPTA1", "2026-07-17T17:00:00.000Z"),
		});

		const result = await fetchLatestWaterTemperature(sources(["ndbc", "PPTA1"]), new Map(), { now, loadSource });

		expect(result.stationId).toBe("PPTA1");
		expect(loadSource).toHaveBeenCalledOnce();
		expect(loadSource.mock.calls.flatMap((call) => call.map((value) => value.stationId))).not.toContain("UNAPPROVED");
	});

	it("returns unavailable when no approved fallback is configured", async () => {
		const loadSource = loader({
			"ndbc:PPTA1": new Error("Request timed out after 10000ms"),
		});

		await expect(fetchLatestWaterTemperature(sources(["ndbc", "PPTA1"]), new Map(), { now, loadSource }))
			.rejects.toThrow("No approved fresh water temperature source");
		expect(loadSource).toHaveBeenCalledOnce();
	});

	it("reuses the request cache across beach selections", async () => {
		const loadSource = loader({
			"ndbc:PPTA1": observation("ndbc", "PPTA1", "2026-07-17T17:00:00.000Z"),
		});
		const requestCache = new Map();
		await fetchLatestWaterTemperature(sources(["ndbc", "PPTA1"]), requestCache, { now, loadSource });
		await fetchLatestWaterTemperature(sources(["ndbc", "PPTA1"]), requestCache, { now, loadSource });
		expect(loadSource).toHaveBeenCalledOnce();
	});

	it("keeps selection independent when one beach primary fails", async () => {
		const loadSource = loader({
			"ndbc:PPTA1": new Error("Request timed out after 10000ms"),
			"ndbc:DPHA1": observation("ndbc", "DPHA1", "2026-07-17T17:00:00.000Z", 86),
		});
		const requestCache = new Map<string, Promise<WaterTemperatureObservationWithSource>>();

		await expect(fetchLatestWaterTemperature(sources(["ndbc", "PPTA1"]), requestCache, { now, loadSource }))
			.rejects.toThrow("No approved fresh water temperature source");
		await expect(fetchLatestWaterTemperature(sources(["ndbc", "DPHA1"]), requestCache, { now, loadSource }))
			.resolves.toMatchObject({ provider: "ndbc", stationId: "DPHA1", temperature: 86 });
	});

	it("keeps station-scoped request reuse from contaminating beach selection", async () => {
		const loadSource = loader({
			"ndbc:PPTA1": observation("ndbc", "PPTA1", "2026-07-17T17:00:00.000Z", 84),
			"ndbc:DPHA1": observation("ndbc", "DPHA1", "2026-07-17T17:00:00.000Z", 86),
		});
		const requestCache = new Map<string, Promise<WaterTemperatureObservationWithSource>>();
		const gulf = await fetchLatestWaterTemperature(sources(["ndbc", "PPTA1"]), requestCache, { now, loadSource });
		const fortMorgan = await fetchLatestWaterTemperature(sources(["ndbc", "DPHA1"]), requestCache, { now, loadSource });

		expect(gulf).toMatchObject({ stationId: "PPTA1", temperature: 84 });
		expect(fortMorgan).toMatchObject({ stationId: "DPHA1", temperature: 86 });
	});

	it("configures the sole-source beaches with only their approved station", () => {
		const expected = new Map([
			["gulf-shores-public-beach", ["ndbc:PPTA1"]],
			["cotton-bayou", ["ndbc:PPTA1"]],
			["gulf-state-park-pavilion", ["ndbc:PPTA1"]],
			["fort-morgan-public-beach", ["ndbc:DPHA1"]],
			["dauphin-island-public-beach", ["coops:8735180"]],
		]);

		for (const [beachId, sourceKeys] of expected) {
			const configured = beaches.find((candidate) => candidate.id === beachId)?.waterTemperature?.sources
				.map(({ provider, stationId }) => `${provider}:${stationId}`);
			expect(configured).toEqual(sourceKeys);
		}
	});

	it("allows seasonal awareness only for the selected fresh direct observation", async () => {
		const loadSource = loader({
			"ndbc:PPTA1": observation("ndbc", "PPTA1", "2026-07-17T15:00:00.000Z"),
			"coops:8735180": observation("coops", "8735180", "2026-07-17T17:50:00.000Z"),
		});
		const selected = await fetchLatestWaterTemperature(sources(["ndbc", "PPTA1"], ["coops", "8735180"]), new Map(), { now, loadSource });
		const estimatorObservation = (candidate: WaterTemperatureObservationWithSource) => ({
			waterTemperature: candidate.temperature,
			waterTemperatureUnit: candidate.temperatureUnit,
			observedAt: candidate.observedAt,
			provider: candidate.provider,
			stationId: candidate.stationId,
		});

		expect(estimateVibrioConditions({ enabled: true, now, observation: estimatorObservation(selected) }).status).toBe("seasonalAwareness");

		await expect(fetchLatestWaterTemperature(sources(["ndbc", "PPTA1"]), new Map(), { now, loadSource }))
			.rejects.toThrow("No approved fresh water temperature source");
	});
});
