import { describe, expect, it, vi } from "vitest";
import type { BeachDefinition } from "../src/config/BeachRegistry";
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

	it("returns the original preferred observation for the general tile when all configured stations are stale", async () => {
		const preferred = observation("ndbc", "PPTA1", "2026-07-17T15:00:00.000Z", 82);
		const loadSource = loader({
			"ndbc:PPTA1": preferred,
			"coops:8735180": observation("coops", "8735180", "2026-07-17T14:00:00.000Z", 84),
		});

		const result = await fetchLatestWaterTemperature(sources(["ndbc", "PPTA1"], ["coops", "8735180"]), new Map(), { now, loadSource });

		expect(result).toEqual(preferred);
		expect(result).toMatchObject({ temperature: 82, temperatureUnit: "F", provider: "ndbc", stationId: "PPTA1" });
	});

	it("continues when the preferred station fails to parse", async () => {
		const loadSource = loader({
			"ndbc:PPTA1": new Error("NDBC parse failure"),
			"coops:8735180": observation("coops", "8735180", "2026-07-17T17:45:00.000Z"),
		});

		const result = await fetchLatestWaterTemperature(sources(["ndbc", "PPTA1"], ["coops", "8735180"]), new Map(), { now, loadSource });

		expect(result.stationId).toBe("8735180");
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
			"ndbc:PPTA1": observation("ndbc", "PPTA1", "2026-07-17T15:00:00.000Z"),
		});

		const result = await fetchLatestWaterTemperature(sources(["ndbc", "PPTA1"]), new Map(), { now, loadSource });

		expect(result.stationId).toBe("PPTA1");
		expect(loadSource).toHaveBeenCalledOnce();
		expect(loadSource.mock.calls.flatMap((call) => call.map((value) => value.stationId))).not.toContain("UNAPPROVED");
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

		const allStale = await fetchLatestWaterTemperature(sources(["ndbc", "PPTA1"]), new Map(), { now, loadSource });
		expect(estimateVibrioConditions({ enabled: true, now, observation: estimatorObservation(allStale) }).diagnosticCode).toBe("stale_observation");
	});
});
