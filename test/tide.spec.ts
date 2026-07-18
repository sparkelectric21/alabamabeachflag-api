import { afterEach, describe, expect, it, vi } from "vitest";
import { beaches } from "../src/config/BeachRegistry";
import { fetchTideEvents } from "../src/services/tide/client";
import { clearTideMemoryCacheForTests, deriveTideDirection, fetchTidePrediction, selectNextTideEvent } from "../src/services/tide/service";
import { beachDate, parseNoaaLocalTime } from "../src/services/tide/time";

afterEach(() => {
	vi.unstubAllGlobals();
	clearTideMemoryCacheForTests();
});

describe("NOAA tide station mapping", () => {
	it("uses documented local prediction stations and leaves Little Lagoon unavailable", () => {
		const mapping = Object.fromEntries(beaches.map((beach) => [beach.id, beach.tide?.stationId]));
		expect(mapping).toMatchObject({
			"alabama-point": "8730667", "cotton-bayou": "8730667", "florida-point": "8730667",
			"gulf-shores-public-beach": "8731439", "gulf-state-park-pavilion": "8731439",
			"fort-morgan-public-beach": "8734635", "dauphin-island-public-beach": "8735180",
			"dauphin-island-east-end": "8735180", "little-lagoon-pass": undefined,
		});
		expect(beaches.find((beach) => beach.id === "dauphin-island-public-beach")?.tide?.stationType).toBe("harmonic");
	});
});

describe("tide derivation", () => {
	const points = [
		{ time: "2026-07-18T12:00:00.000Z", height: 0 },
		{ time: "2026-07-18T13:00:00.000Z", height: 1 },
		{ time: "2026-07-18T14:00:00.000Z", height: 0.5 },
	];
	const events = [
		{ type: "high" as const, time: "2026-07-18T13:00:00.000Z", height: 1 },
		{ type: "low" as const, time: "2026-07-18T20:00:00.000Z", height: 0 },
	];

	it("derives rising and falling from adjacent points", () => {
		expect(deriveTideDirection(points, new Date("2026-07-18T12:30:00Z"))).toBe("rising");
		expect(deriveTideDirection(points, new Date("2026-07-18T13:30:00Z"))).toBe("falling");
	});

	it("uses the outgoing segment at an exact high/low boundary", () => {
		expect(deriveTideDirection(points, new Date("2026-07-18T13:00:00Z"))).toBe("falling");
	});

	it("selects the next event, including an event exactly at now", () => {
		expect(selectNextTideEvent(events, new Date("2026-07-18T13:00:00Z"))?.type).toBe("high");
		expect(selectNextTideEvent(events, new Date("2026-07-18T13:00:01Z"))?.type).toBe("low");
	});
});

describe("NOAA tide parsing and dates", () => {
	it("parses local NOAA times across local midnight", () => {
		expect(parseNoaaLocalTime("2026-07-18 00:00").toISOString()).toBe("2026-07-18T05:00:00.000Z");
		expect(beachDate(new Date("2026-07-19T04:59:59Z"))).toBe("2026-07-18");
		expect(beachDate(new Date("2026-07-19T05:00:00Z"))).toBe("2026-07-19");
	});

	it("rejects malformed and nonfinite NOAA responses", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
			predictions: [{ t: "bad", v: "NaN", type: "H" }],
		}), { status: 200, headers: { "Content-Type": "application/json" } })));
		await expect(fetchTideEvents("8735180", "20260718")).rejects.toThrow(/Malformed|nonfinite/);
	});

	it("rejects empty NOAA responses", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ predictions: [] }), {
			status: 200, headers: { "Content-Type": "application/json" },
		})));
		await expect(fetchTideEvents("8735180", "20260718")).rejects.toThrow("empty");
	});

	it("returns subordinate high/low data without fabricating a curve", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ predictions: [
			{ t: "2026-07-18 06:00", v: "0.2", type: "L" },
			{ t: "2026-07-18 16:00", v: "1.1", type: "H" },
		] }), { status: 200, headers: { "Content-Type": "application/json" } })));
		const tide = await fetchTidePrediction(
			{ stationId: "8730667", stationName: "Alabama Point, AL", stationType: "subordinate" },
			new Date("2026-07-18T15:00:00Z"),
		);
		expect(tide.points).toEqual([]);
		expect(tide.direction).toBeUndefined();
		expect(tide.nextEvent?.type).toBe("high");
	});

	it("rejects predictions returned for the wrong local date", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ predictions: [
			{ t: "2026-07-17 06:00", v: "0.2", type: "L" },
		] }), { status: 200, headers: { "Content-Type": "application/json" } })));
		await expect(fetchTidePrediction(
			{ stationId: "8730667", stationName: "Alabama Point, AL", stationType: "subordinate" },
			new Date("2026-07-18T15:00:00Z"),
		)).rejects.toThrow("wrong date");
	});
});
