import { describe, expect, it } from "vitest";
import {
	applyLocalVibrioQaFixture,
	buildLocalVibrioQaFixture,
	resolveLocalVibrioQaFixture,
} from "../src/local/vibrioQaFixture";
import { isLocalWranglerRequest } from "../src/local";

const now = new Date("2026-07-17T18:00:00.000Z");

describe("local-only Vibrio QA fixture", () => {
	it("allows only loopback requests through the local entrypoint guard", () => {
		expect(isLocalWranglerRequest(new Request("http://127.0.0.1:8787/__local/refresh/beach-conditions"))).toBe(true);
		expect(isLocalWranglerRequest(new Request("http://localhost:8787/__local/refresh/beach-conditions"))).toBe(true);
		expect(isLocalWranglerRequest(new Request("https://api.example.com/__local/refresh/beach-conditions"))).toBe(false);
	});
	it("returns the deterministic seasonal-awareness contract", () => {
		const result = buildLocalVibrioQaFixture("seasonalAwareness", now);
		expect(result).toMatchObject({
			status: "seasonalAwareness",
			waterTemperature: { value: 84, unit: "F" },
			dataTimestamp: now.toISOString(),
			generatedAt: now.toISOString(),
			source: { provider: "fixture", stationId: "LOCAL-QA", kind: "observation" },
		});
		expect(new Date(result.dataTimestamp ?? "invalid").getTime()).toBe(now.getTime());
		expect(new Date(result.generatedAt).getTime()).toBe(now.getTime());
		expect(result).not.toHaveProperty("diagnosticCode");
	});

	it("returns unavailable without inventing a temperature", () => {
		const result = buildLocalVibrioQaFixture("unavailable", now);
		expect(result.status).toBe("unavailable");
		expect(result.waterTemperature).toBeUndefined();
		expect(result).not.toHaveProperty("diagnosticCode");
	});

	it.each([undefined, "", "SeasonalAwareness", "malformed", "null"])(
		"falls back to genuine NOAA behavior for absent or malformed value %s",
		(value) => {
			expect(resolveLocalVibrioQaFixture({ featureEnabled: true, isLocalDevelopment: true, value })).toBeUndefined();
		},
	);

	it("cannot activate outside local development", () => {
		expect(resolveLocalVibrioQaFixture({
			featureEnabled: true,
			isLocalDevelopment: false,
			value: "seasonalAwareness",
		})).toBeUndefined();
	});

	it("cannot override a disabled Vibrio feature", () => {
		expect(resolveLocalVibrioQaFixture({
			featureEnabled: false,
			isLocalDevelopment: true,
			value: "seasonalAwareness",
		})).toBeUndefined();
	});

	it("changes only Vibrio Conditions and preserves ordinary water temperature", () => {
		const waterTemperature = {
			temperature: 82,
			temperatureUnit: "F",
			observedAt: "2026-07-17T15:00:00.000Z",
			provider: "ndbc",
			stationId: "PPTA1",
		};
		const payload = {
			generatedAt: now.toISOString(),
			count: 1,
			beachConditions: [{
				beachId: "gulf-shores-public-beach",
				waterTemperature,
				vibrioConditions: { status: "unavailable" },
			}],
		};

		const result = applyLocalVibrioQaFixture(payload, "seasonalAwareness", now);

		expect(result.beachConditions[0].waterTemperature).toEqual(waterTemperature);
		expect(result.beachConditions[0].vibrioConditions).toMatchObject({
			status: "seasonalAwareness",
			source: { provider: "fixture", stationId: "LOCAL-QA" },
		});
	});
});
