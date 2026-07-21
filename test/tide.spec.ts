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
		expect(beaches.find((beach) => beach.id === "alabama-point")?.tide?.stationType).toBe("harmonic");
		expect(beaches.find((beach) => beach.id === "gulf-shores-public-beach")?.tide?.stationType).toBe("harmonic");
		expect(beaches.find((beach) => beach.id === "fort-morgan-public-beach")?.tide?.stationType).toBe("subordinate");
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

	it("surfaces the exact HTTP 200 prediction error returned in production", async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
			error: { message: "No Predictions data was found. Please make sure the Datum input is valid." },
		}), { status: 200, headers: { "Content-Type": "application/json" } }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(fetchTideEvents("8735180", "20260718")).rejects.toThrow(
			"No Predictions data was found. Please make sure the Datum input is valid.",
		);
		const url = new URL(fetchMock.mock.calls[0][0]);
		expect(Object.fromEntries(url.searchParams)).toEqual({
			application: "alabama-beach-flag",
			format: "json",
			product: "predictions",
			station: "8735180",
			begin_date: "20260718",
			end_date: "20260718",
			time_zone: "lst_ldt",
			datum: "MLLW",
			units: "english",
			interval: "hilo",
		});
	});

	it("returns subordinate high/low data without fabricating a curve", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ predictions: [
			{ t: "2026-07-18 06:00", v: "0.2", type: "L" },
			{ t: "2026-07-18 16:00", v: "1.1", type: "H" },
		] }), { status: 200, headers: { "Content-Type": "application/json" } })));
		const tide = await fetchTidePrediction(
			{ stationId: "8734635", stationName: "Mobile Point (Fort Morgan), AL", stationType: "subordinate" },
			new Date("2026-07-18T15:00:00Z"),
		);
		expect(tide.points).toEqual([]);
		expect(tide.direction).toBeUndefined();
		expect(tide.nextEvent?.type).toBe("high");
	});

	it("uses expired same-day cached events when a refresh fails", async () => {
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({ predictions: [
				{ t: "2026-07-18 06:00", v: "0.2", type: "L" },
				{ t: "2026-07-18 16:00", v: "1.1", type: "H" },
			] }), { status: 200, headers: { "Content-Type": "application/json" } }))
			.mockRejectedValueOnce(new Error("temporary NOAA outage"));
		vi.stubGlobal("fetch", fetchMock);
		const configuration = { stationId: "8734635", stationName: "Mobile Point (Fort Morgan), AL", stationType: "subordinate" as const };
		const initial = await fetchTidePrediction(configuration, new Date("2026-07-18T06:00:00Z"));
		const fallback = await fetchTidePrediction(configuration, new Date("2026-07-18T13:01:00Z"));
		expect(fallback.events).toEqual(initial.events);
		expect(fetchMock).toHaveBeenCalledTimes(4); // Initial success plus three retry attempts.
	});

	it("requests real interval points for corrected harmonic station classifications", async () => {
		const fetchMock = vi.fn().mockImplementation(async (input: string) => {
			const interval = new URL(input).searchParams.get("interval");
			return new Response(JSON.stringify({ predictions: interval === "hilo" ? [
				{ t: "2026-07-18 06:00", v: "0.2", type: "L" },
				{ t: "2026-07-18 16:00", v: "1.1", type: "H" },
			] : [
				{ t: "2026-07-18 09:00", v: "0.3" },
				{ t: "2026-07-18 09:15", v: "0.4" },
			] }), { status: 200, headers: { "Content-Type": "application/json" } });
		});
		vi.stubGlobal("fetch", fetchMock);

		const tide = await fetchTidePrediction(
			{ stationId: "8730667", stationName: "Alabama Point, AL", stationType: "harmonic" },
			new Date("2026-07-18T14:05:00Z"),
		);
		expect(tide.points).toHaveLength(2);
		expect(tide.direction).toBe("rising");
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls.map(([input]) => new URL(input).searchParams.get("interval")).sort()).toEqual(["15", "hilo"]);
	});

	it("preserves high and low events when harmonic interval points fail", async () => {
		const fetchMock = vi.fn().mockImplementation(async (input: string) => {
			const interval = new URL(input).searchParams.get("interval");
			if (interval === "15") return new Response(JSON.stringify({ error: { message: "interval unavailable" } }), {
				status: 200, headers: { "Content-Type": "application/json" },
			});
			return new Response(JSON.stringify({ predictions: [
				{ t: "2026-07-18 06:00", v: "0.2", type: "L" },
				{ t: "2026-07-18 16:00", v: "1.1", type: "H" },
			] }), { status: 200, headers: { "Content-Type": "application/json" } });
		});
		vi.stubGlobal("fetch", fetchMock);

		const tide = await fetchTidePrediction(
			{ stationId: "8730667", stationName: "Alabama Point, AL", stationType: "harmonic" },
			new Date("2026-07-18T15:00:00Z"),
		);
		expect(tide.events).toHaveLength(2);
		expect(tide.points).toEqual([]);
		expect(tide.nextEvent?.type).toBe("high");
	});

	it("rejects predictions returned for the wrong local date", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ predictions: [
			{ t: "2026-07-17 06:00", v: "0.2", type: "L" },
		] }), { status: 200, headers: { "Content-Type": "application/json" } })));
		await expect(fetchTidePrediction(
			{ stationId: "8734635", stationName: "Mobile Point (Fort Morgan), AL", stationType: "subordinate" },
			new Date("2026-07-18T15:00:00Z"),
		)).rejects.toThrow("wrong date");
	});
});
