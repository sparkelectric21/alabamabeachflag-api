import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";
import { isVerificationHour, runVerification, verificationSlot } from "../src/verification/run";

const officialHtml = `<div id="surfTS"><div class="nested"><img src="/ImageRepository/Document?documentID=3022"></div></div>`;
const published = {
	generatedAt: "2026-07-17T11:45:00.000Z",
	beachFlags: [
		"gulf-shores-public-beach",
		"gulf-state-park-pavilion",
		"little-lagoon-pass",
	].map((beachId) => ({ beachId, primaryFlag: "yellow", hasPurpleFlag: false })),
};

afterEach(() => vi.restoreAllMocks());

describe("verification scheduling", () => {
	it.each([
		["2026-07-17T12:00:00.000Z", true, "2026-07-17T07"],
		["2026-07-17T17:00:00.000Z", true, "2026-07-17T12"],
		["2026-01-17T13:00:00.000Z", true, "2026-01-17T07"],
		["2026-01-17T18:00:00.000Z", true, "2026-01-17T12"],
		["2026-07-17T13:00:00.000Z", false, "2026-07-17T08"],
	])("handles Central Time and DST for %s", (iso, expected, slot) => {
		const date = new Date(iso);
		expect(isVerificationHour(date)).toBe(expected);
		expect(verificationSlot(date)).toBe(slot);
	});
});

describe("verification reports", () => {
	function env() {
		return {
			VERIFICATION_API_BASE_URL: "https://api.example.com",
			BEACH_DATA: { put: vi.fn() },
		} as unknown as Env;
	}

	it("records a passing independent comparison and both KV records", async () => {
		vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			return url.includes("gulfshoresal.gov")
				? new Response(officialHtml, { headers: { "Content-Type": "text/html" } })
				: Response.json(published);
		}));
		const e = env();
		const report = await runVerification(e, new Date("2026-07-17T12:00:00.000Z"));
		expect(report.status).toBe("pass");
		expect(report.checks).toHaveLength(5);
		expect(e.BEACH_DATA.put).toHaveBeenCalledTimes(2);
		expect(e.BEACH_DATA.put).toHaveBeenCalledWith("verification:latest", expect.any(String));
	});

	it("recognizes the current CivicPlus closure IDs and public compatibility value", async () => {
		vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) =>
			String(input).includes("gulfshoresal.gov")
				? new Response(officialHtml.replace("3022", "4339"), { headers: { "Content-Type": "text/html" } })
				: Response.json({
					...published,
					beachFlags: published.beachFlags.map((flag) => ({ ...flag, primaryFlag: "double-red" })),
				})));
		const report = await runVerification(env(), new Date("2026-07-17T12:00:00.000Z"));
		expect(report.status).toBe("pass");
		expect(report.checks.filter((check) => check.location)).toHaveLength(3);
		expect(report.checks.at(-1)).toMatchObject({
			provider: "City of Gulf Shores",
			expectedValue: "doubleRed; purple=false",
			actualValue: "doubleRed; purple=false",
		});
	});

	it("warns after 45 minutes and fails after 90 minutes", async () => {
		const responses = [60, 100];
		for (const age of responses) {
			vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
				if (String(input).includes("gulfshoresal.gov")) {
					return new Response(officialHtml, { headers: { "Content-Type": "text/html" } });
				}
				return Response.json({
					...published,
					generatedAt: new Date(Date.parse("2026-07-17T12:00:00.000Z") - age * 60_000).toISOString(),
				});
			}));
			const report = await runVerification(env(), new Date("2026-07-17T12:00:00.000Z"));
			expect(report.checks[0].status).toBe(age === 60 ? "warning" : "fail");
		}
	});

	it("fails invalid timestamps and Gulf Shores provider errors", async () => {
		vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) =>
			String(input).includes("gulfshoresal.gov")
				? new Response(officialHtml, { headers: { "Content-Type": "text/html" } })
				: Response.json({
					...published,
					generatedAt: "invalid",
					errors: [{ beachId: "gulf-shores", message: "provider_unavailable" }],
				})));
		const report = await runVerification(env(), new Date("2026-07-17T12:00:00.000Z"));
		expect(report.status).toBe("fail");
		expect(report.checks.find((check) => check.name === "freshness")?.status).toBe("fail");
		expect(report.checks.find((check) => check.name === "provider_errors")?.status).toBe("fail");
	});

	it("fails a missing location or mismatched purple advisory", async () => {
		vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
			if (String(input).includes("gulfshoresal.gov")) {
				return new Response(officialHtml, { headers: { "Content-Type": "text/html" } });
			}
			return Response.json({
				...published,
				beachFlags: published.beachFlags.slice(0, 2).map((flag, index) => ({
					...flag,
					hasPurpleFlag: index === 0,
				})),
			});
		}));
		const report = await runVerification(env(), new Date("2026-07-17T12:00:00.000Z"));
		expect(report.status).toBe("fail");
		expect(report.checks.some((check) => check.message === "missing_location")).toBe(true);
	});

	it("warns instead of guessing when the official source format changes", async () => {
		vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) =>
			String(input).includes("gulfshoresal.gov")
				? new Response("<html>changed</html>", { headers: { "Content-Type": "text/html" } })
				: Response.json(published)));
		const report = await runVerification(env(), new Date("2026-07-17T12:00:00.000Z"));
		expect(report.status).toBe("warning");
		expect(report.checks.find((check) => check.name === "official_source")?.message)
			.toBe("official_source_format_changed");
	});
});

describe("protected verification routing", () => {
	it("rejects unauthenticated reads and permits authenticated latest reads", async () => {
		const env = {
			REFRESH_SECRET: "secret",
			ALLOW_LEGACY_REFRESH_SECRET: "true",
			BEACH_DATA: { get: vi.fn(async () => ({ status: "pass" })) },
		} as unknown as Env;
		const denied = await worker.fetch(new Request("https://example.com/internal/verification/latest"), env);
		expect(denied.status).toBe(403);
		const allowed = await worker.fetch(new Request("https://example.com/internal/verification/latest", {
			headers: { "x-refresh-secret": "secret" },
		}), env);
		expect(allowed.status).toBe(200);
		expect(await allowed.json()).toEqual({ status: "pass" });
	});

	it("preserves a coordinator duplicate response", async () => {
		const coordinatorFetch = vi.fn(async () => Response.json({ outcome: "duplicate" }, { status: 409 }));
		const env = {
			REFRESH_SECRET: "secret",
			ALLOW_LEGACY_REFRESH_SECRET: "true",
			VERIFICATION_COORDINATOR: {
				idFromName: vi.fn(() => "id"),
				get: vi.fn(() => ({ fetch: coordinatorFetch })),
			},
		} as unknown as Env;
		const response = await worker.fetch(new Request("https://example.com/internal/verification/run", {
			method: "POST",
			headers: { "x-refresh-secret": "secret" },
		}), env);
		expect(response.status).toBe(409);
		expect(coordinatorFetch).toHaveBeenCalledOnce();
	});
});
