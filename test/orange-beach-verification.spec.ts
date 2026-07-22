import { afterEach, describe, expect, it, vi } from "vitest";
import { parseOfficialOrangeBeachHtml } from "../src/verification/orangeBeachOfficial";
import { runOrangeBeachVerification } from "../src/verification/orangeBeach";
import type { Env } from "../src/types";

const fixture = (flag: string, suffix = "") => `<h2>Orange Beach Daily Beach Report</h2><ul><li><strong>Today’s Flag Color:</strong> ${flag}</li><li>Surf Conditions: calm</li></ul>${suffix}<p>Sign up to receive daily beach conditions</p>`;

describe("independent Orange Beach official source", () => {
	it.each([
		["Green Flag", "green", false], ["Yellow Flag", "yellow", false], ["Single Red Flag", "red", false],
		["Double Red Flags", "doubleRed", false], ["Yellow and Purple Flag", "yellow", true],
	])("parses %s", (value, primaryFlag, hasPurpleFlag) => {
		expect(parseOfficialOrangeBeachHtml(fixture(value))).toEqual({ primaryFlag, hasPurpleFlag });
	});
	it.each(["<html>unavailable</html>", "Orange Beach Daily Beach Report Today's Flag Color: Blue Sign up to receive daily beach conditions", "Orange Beach Daily Beach Report Today's Flag Color: Yellow"])
		("rejects malformed or changed format", (html) => expect(() => parseOfficialOrangeBeachHtml(html)).toThrow());
});

describe("Orange Beach verifier", () => {
	afterEach(() => vi.restoreAllMocks());
	it("compares all three locations and persists independent keys", async () => {
		vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => String(input).includes("orangebeachal.gov")
			? new Response(fixture("Yellow Flag", " dangerous marine life"), { headers: { "Content-Type": "text/html" } })
			: Response.json({ generatedAt: "2026-07-22T12:00:00Z", beachFlags: ["cotton-bayou", "alabama-point", "florida-point"].map((beachId) => ({ beachId, primaryFlag: "yellow", hasPurpleFlag: true })), errors: [] })));
		const put = vi.fn(); const env = { VERIFICATION_API_BASE_URL: "https://api.example.com", BEACH_DATA: { put } } as unknown as Env;
		const report = await runOrangeBeachVerification(env, new Date("2026-07-22T12:05:00Z"));
		expect(report.status).toBe("pass");
		expect(report.checks.filter((check) => check.location)).toHaveLength(3);
		expect(put).toHaveBeenCalledWith("verification:orange-beach-flags:latest", expect.any(String));
		expect(put).toHaveBeenCalledTimes(2);
	});
	it("reports provider errors, stale data, missing locations, and mismatches", async () => {
		vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => String(input).includes("orangebeachal.gov")
			? new Response(fixture("Red Flag"), { headers: { "Content-Type": "text/html" } })
			: Response.json({ generatedAt: "2026-07-22T08:00:00Z", beachFlags: [{ beachId: "cotton-bayou", primaryFlag: "yellow", hasPurpleFlag: true }], errors: [{ beachId: "orange-beach" }] })));
		const report = await runOrangeBeachVerification({ VERIFICATION_API_BASE_URL: "https://api.example.com", BEACH_DATA: { put: vi.fn() } } as unknown as Env, new Date("2026-07-22T12:05:00Z"));
		expect(report.status).toBe("fail");
		expect(report.checks.map((check) => check.message)).toEqual(expect.arrayContaining(["orange_beach_provider_error", "primary_flag_mismatch", "missing_location"]));
	});
});
