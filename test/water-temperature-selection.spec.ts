import { describe, expect, it, vi } from "vitest";
import { beaches, type BeachDefinition } from "../src/config/BeachRegistry";
import { estimateVibrioConditions } from "../src/services/vibrio/estimator";
import {
	fetchLatestWaterTemperature,
	type WaterTemperatureObservationWithSource,
} from "../src/services/waterTemperature/service";
import { sourceFreshnessThresholds } from "../src/services/waterTemperature/freshness";

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
const classified = (
	provider: "ndbc" | "coops",
	stationId: string,
	observedAt: string,
	freshnessStatus: "current" | "stale",
	temperature = 84,
) => ({
	...observation(provider, stationId, observedAt, temperature),
	freshnessStatus,
	ageMinutes: Math.max(0, Math.round((now.getTime() - new Date(observedAt).getTime()) / 60_000)),
	staleAfterMinutes: sourceFreshnessThresholds(provider, stationId).freshAfterMinutes,
	unavailableAfterMinutes: sourceFreshnessThresholds(provider, stationId).unavailableAfterMinutes,
	ingestedAt: now.toISOString(),
	sourceName: undefined,
	sourceType: "observation",
	environment: undefined,
	sensorDepthM: undefined,
	isModeled: false,
	selectionReason: freshnessStatus === "current"
		? "Highest-priority fresh approved observation"
		: "Latest approved observation; no fresh approved source was available",
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
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const loadSource = loader({
			"ndbc:PPTA1": observation("ndbc", "PPTA1", "2026-07-17T17:00:00.000Z"),
			"coops:8735180": observation("coops", "8735180", "2026-07-17T17:50:00.000Z"),
		});

		const result = await fetchLatestWaterTemperature(sources(["ndbc", "PPTA1"], ["coops", "8735180"]), new Map(), { now, loadSource });

		expect(result).toEqual(classified("ndbc", "PPTA1", "2026-07-17T17:00:00.000Z", "current"));
		expect(loadSource).toHaveBeenCalledTimes(1);
		expect(log).toHaveBeenCalledWith(expect.stringMatching(
			/Current observation accepted.*provider=ndbc.*stationId=PPTA1.*observedAt=2026-07-17T17:00:00.000Z.*ageMinutes=60.*staleAfterMinutes=90.*unavailableAfterMinutes=180/,
		));
		log.mockRestore();
	});

	it.each([
		["exactly 90 minutes as current", "2026-07-17T16:30:00.000Z", "current"],
		["immediately beyond 90 minutes as stale", "2026-07-17T16:29:59.999Z", "stale"],
		["exactly 180 minutes as stale", "2026-07-17T15:00:00.000Z", "stale"],
	] as const)("classifies PPTA1 %s", async (_case, observedAt, freshnessStatus) => {
		const expected = observation("ndbc", "PPTA1", observedAt);
		const result = await fetchLatestWaterTemperature(sources(["ndbc", "PPTA1"]), new Map(), {
			now,
			loadSource: async () => expected,
		});

		expect(result).toEqual(classified("ndbc", "PPTA1", observedAt, freshnessStatus));
	});

	it("rejects PPTA1 observations immediately beyond 180 minutes", async () => {
		const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const loadSource = async () => observation("ndbc", "PPTA1", "2026-07-17T14:59:59.999Z");

		await expect(fetchLatestWaterTemperature(sources(["ndbc", "PPTA1"]), new Map(), { now, loadSource }))
			.rejects.toThrow("No approved usable water temperature source");
		expect(log).toHaveBeenCalledWith(expect.stringMatching(
			/Observation rejected beyond hard cutoff.*provider=ndbc.*stationId=PPTA1.*observedAt=2026-07-17T14:59:59.999Z.*ageMinutes=180.*staleAfterMinutes=90.*unavailableAfterMinutes=180/,
		));
		log.mockRestore();
	});

	it("uses the configured NDBC stale window", async () => {
		const provider = "ndbc" as const;
		const stationId = "DPHA1";
		const observedAt = "2026-07-17T15:59:59.999Z";
		const loadSource = async () => observation(provider, stationId, observedAt);

		await expect(fetchLatestWaterTemperature(sources([provider, stationId]), new Map(), { now, loadSource }))
			.resolves.toEqual(classified(provider, stationId, observedAt, "stale"));
	});

	it("uses the tighter six-minute CO-OPS freshness window", async () => {
		const observedAt = "2026-07-17T17:00:00.000Z";
		const loadSource = async () => observation("coops", "8735180", observedAt);

		await expect(fetchLatestWaterTemperature(sources(["coops", "8735180"]), new Map(), { now, loadSource }))
			.resolves.toEqual(classified("coops", "8735180", observedAt, "stale"));
	});

	it.each([
		["Gulf Shores", "ndbc", "PPTA1"],
		["Orange Beach / Cotton Bayou", "ndbc", "PPTA1"],
		["Fort Morgan", "ndbc", "DPHA1"],
		["Dauphin Island", "coops", "8735180"],
	] as const)("uses %s's configured primary station", async (_beachName, provider, stationId) => {
		const expected = observation(provider, stationId, provider === "coops"
			? "2026-07-17T17:45:00.000Z"
			: "2026-07-17T17:00:00.000Z");
		const loadSource = loader({ [`${provider}:${stationId}`]: expected });

		await expect(fetchLatestWaterTemperature(sources([provider, stationId]), new Map(), { now, loadSource }))
			.resolves.toEqual(classified(provider, stationId, expected.observedAt, "current"));
	});

	it("skips a stale preferred NDBC observation for an approved fresh CO-OPS fallback", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const loadSource = loader({
			"ndbc:PPTA1": observation("ndbc", "PPTA1", "2026-07-17T15:00:00.000Z"),
			"coops:8735180": observation("coops", "8735180", "2026-07-17T17:50:00.000Z", 86),
		});

		const result = await fetchLatestWaterTemperature(sources(["ndbc", "PPTA1"], ["coops", "8735180"]), new Map(), { now, loadSource });

		expect(result).toEqual(classified("coops", "8735180", "2026-07-17T17:50:00.000Z", "current", 86));
		expect(log).toHaveBeenCalledWith(expect.stringContaining("staleCandidates=ndbc:PPTA1"));
		log.mockRestore();
	});

	it("returns the preferred delayed observation when no current fallback exists", async () => {
		const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const preferred = observation("ndbc", "PPTA1", "2026-07-17T15:00:00.000Z", 82);
		const loadSource = loader({
			"ndbc:PPTA1": preferred,
			"coops:8735180": observation("coops", "8735180", "2026-07-17T14:00:00.000Z", 84),
		});

		await expect(fetchLatestWaterTemperature(
			sources(["ndbc", "PPTA1"], ["coops", "8735180"]),
			new Map(),
			{ now, loadSource },
		)).resolves.toEqual(classified("ndbc", "PPTA1", preferred.observedAt, "stale", 82));
		expect(log).toHaveBeenCalledWith(expect.stringMatching(
			/Stale observation accepted.*provider=ndbc.*stationId=PPTA1.*observedAt=2026-07-17T15:00:00.000Z.*ageMinutes=180.*staleAfterMinutes=90.*unavailableAfterMinutes=180/,
		));
		log.mockRestore();
	});

	it("continues when the preferred station fails to parse", async () => {
		const loadSource = loader({
			"ndbc:PPTA1": new Error("NDBC parse failure"),
			"coops:8735180": observation("coops", "8735180", "2026-07-17T17:45:00.000Z"),
		});

		const result = await fetchLatestWaterTemperature(sources(["ndbc", "PPTA1"], ["coops", "8735180"]), new Map(), { now, loadSource });

		expect(result.stationId).toBe("8735180");
	});

	it("classifies provider failures without logging response data", async () => {
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

	it.each([
		["ndbc", "PPTA1", "NDBC parse failure", "ndbc_parser_failure"],
		["coops", "8735180", "No water temperature available for station 8735180", "coops_missing_water_temperature"],
		["coops", "8735180", "Invalid water temperature", "coops_invalid_water_temperature"],
		["coops", "8735180", "Invalid time value", "coops_invalid_timestamp"],
	] as const)("logs %s:%s failure as %s", async (provider, stationId, message, condition) => {
		const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		await expect(fetchLatestWaterTemperature(
			sources([provider, stationId]),
			new Map(),
			{ now, loadSource: loader({ [`${provider}:${stationId}`]: new Error(message) }) },
		)).rejects.toThrow();
		expect(log).toHaveBeenCalledWith(expect.stringContaining(`condition=${condition}`));
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
			.rejects.toThrow("No approved usable water temperature source");
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
			.rejects.toThrow("No approved usable water temperature source");
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

	it("configures each beach with its approved observation hierarchy", () => {
		const expected = new Map([
			["gulf-shores-public-beach", ["ndbc:PPTA1", "ndbc:42012", "ndbc:42357"]],
			["cotton-bayou", ["ndbc:PPTA1", "ndbc:42012", "ndbc:42357"]],
			["fort-morgan-public-beach", ["ndbc:DPHA1", "ndbc:42357", "ndbc:42012"]],
			["dauphin-island-public-beach", ["coops:8735180", "ndbc:42357", "ndbc:DPHA1"]],
		]);

		for (const [beachId, sourceKeys] of expected) {
			const configured = beaches.find((candidate) => candidate.id === beachId)?.waterTemperature?.sources
				.map(({ provider, stationId }) => `${provider}:${stationId}`);
			expect(configured).toEqual(sourceKeys);
		}
	});

	it("moves through every approved main-card fallback in configured order", async () => {
		const mainCards = [
			["gulf-shores-public-beach", ["ndbc:PPTA1", "ndbc:42012", "ndbc:42357"]],
			["cotton-bayou", ["ndbc:PPTA1", "ndbc:42012", "ndbc:42357"]],
			["fort-morgan-public-beach", ["ndbc:DPHA1", "ndbc:42357", "ndbc:42012"]],
			["dauphin-island-public-beach", ["coops:8735180", "ndbc:42357", "ndbc:DPHA1"]],
		] as const;

		for (const [beachId, sourceKeys] of mainCards) {
			const configured = beaches.find((candidate) => candidate.id === beachId)?.waterTemperature;
			if (!configured) throw new Error(`Missing water-temperature configuration for ${beachId}`);

			for (const [selectedIndex, selectedKey] of sourceKeys.entries()) {
				const attempted: string[] = [];
				const selected = await fetchLatestWaterTemperature(configured, new Map(), {
					now,
					loadSource: async (source) => {
						const key = `${source.provider}:${source.stationId}`;
						attempted.push(key);
						if (attempted.length <= selectedIndex) throw new Error("simulated provider failure");
						return observation(source.provider, source.stationId, source.provider === "coops"
							? "2026-07-17T17:45:00.000Z"
							: "2026-07-17T17:00:00.000Z");
					},
				});
				expect(attempted).toEqual(sourceKeys.slice(0, selectedIndex + 1));
				expect(`${selected.provider}:${selected.stationId}`).toBe(selectedKey);
			}
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

		await expect(fetchLatestWaterTemperature(sources(["ndbc", "PPTA1"]), new Map(), { now, loadSource, diagnosticScope: "vibrio_conditions" }))
			.rejects.toThrow("No approved usable water temperature source");
	});
});
