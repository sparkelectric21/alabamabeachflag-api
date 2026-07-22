import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { handleVerificationAdminRequest } from "../src/routes/verificationAdmin";
import type { Env } from "../src/types";

const report = (status: "pass" | "warning" | "fail", slot = "2026-07-21T12", completedAt = "2026-07-21T17:00:02Z") => ({
	version: 1, slot, startedAt: "2026-07-21T17:00:00Z", completedAt, status,
	checks: [
		{ name: "freshness", status: "pass", message: "4 minutes old", provider: "Alabama Beach Flag API", expectedValue: "90 minutes old or less", actualValue: "4 minutes old" },
		{ name: "provider_errors", status: "pass", message: "no Gulf Shores provider errors", provider: "City of Gulf Shores" },
		...(["gulf-shores-public-beach", "gulf-state-park-pavilion", "little-lagoon-pass"].map((id, index) => ({ name: id, location: id, status: index === 0 ? status : "pass", message: status === "fail" && index === 0 ? "published result differs from official source token=private https://raw.test/page" : "flag and purple advisory match", expectedValue: "yellow; purple=false", actualValue: index === 0 && status === "fail" ? "red; purple=true" : "yellow; purple=false" }))),
	],
});

function harness(records: Record<string, unknown>, alerting = false) {
	const get = vi.fn(async (key: string) => key in records ? structuredClone(records[key]) : null);
	const list = vi.fn(async ({ prefix }: { prefix: string }) => ({ keys: Object.keys(records).filter((key) => key.startsWith(prefix)).map((name) => ({ name })) }));
	return { BEACH_DATA: { get, list }, REFRESH_SECRET: "secret", ALLOW_LEGACY_REFRESH_SECRET: "true", VERIFICATION_ALERTS_ENABLED: alerting ? "true" : "false", VERIFICATION_ALERT_EMAIL: alerting ? {} : undefined } as unknown as Env;
}

describe("verification admin endpoint", () => {
	it("rejects unauthenticated and non-GET requests", async () => {
		const env = harness({ "verification:latest": report("pass") });
		expect((await worker.fetch(new Request("https://example.com/admin/verification"), env)).status).toBe(403);
		expect((await worker.fetch(new Request("https://example.com/admin/verification", { method: "POST", headers: { "x-refresh-secret": "secret" } }), env)).status).toBe(405);
	});

	it.each(["pass", "warning", "fail"] as const)("returns a sanitized %s response with exact coverage", async (status) => {
		const current = report(status);
		const body = await (await handleVerificationAdminRequest(harness({ "verification:latest": current, "verification:report:2026-07-21:12": current }, true))).json() as any;
		expect(body).toMatchObject({ schemaVersion: 2, status: "ok", summary: { overallStatus: status, coverageLabel: "Gulf Shores flags", coverageCount: 3, alertingEnabled: true }, latest: { status, locations: [{ name: "Gulf Shores Public Beach" }, { name: "Gulf State Park Pavilion" }, { name: "Little Lagoon Pass" }] } });
		expect(body.coverage.filter((item: any) => item.status === "active")).toHaveLength(2);
		expect(JSON.stringify(body)).not.toContain("private");
		expect(JSON.stringify(body)).not.toContain("raw.test");
	});

	it("returns unavailable without reports, sorts newest first, and skips malformed history", async () => {
		const older = report("pass", "2026-07-20T12", "2026-07-20T17:00:02Z");
		const newer = report("warning", "2026-07-21T07", "2026-07-21T12:00:02Z");
		const body = await (await handleVerificationAdminRequest(harness({ "verification:report:bad": { rawHtml: "secret" }, "verification:report:older": older, "verification:report:newer": newer }))).json() as any;
		expect(body.history.map((item: any) => item.slot)).toEqual(["2026-07-21T07", "2026-07-20T12"]);
		expect(body.summary.lastSuccessfulVerificationAt).toBe(new Date(older.completedAt).toISOString());
		const empty = await (await handleVerificationAdminRequest(harness({}))).json() as any;
		expect(empty).toMatchObject({ summary: { overallStatus: "unavailable", latestSlot: null }, latest: null, history: [] });
	});

	it("retains authenticated manual-run reports outside scheduled hours", async () => {
		const manual = report("pass", "2026-07-21T14", "2026-07-21T19:00:02Z");
		const body = await (await handleVerificationAdminRequest(harness({ "verification:gulf-shores-flags:latest": manual }))).json() as any;
		expect(body.verifiers[0].latest.slot).toBe("2026-07-21T14");
	});
});
