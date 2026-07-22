import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { defaultOperationalControl, evaluateFlagControl, parseOperationalControl } from "../src/operationalControl/store";
import { enforceBeachFlagPayload, parseClientIdentification } from "../src/routes/beachflags";
import type { Env } from "../src/types";

function memoryEnv(initial?: unknown) {
	const values = new Map<string, string>();
	if (initial) values.set("operational-control:v1:current", JSON.stringify(initial));
	const kv = {
		get: vi.fn(async (key: string) => values.has(key) ? JSON.parse(values.get(key)!) : null),
		put: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
		list: vi.fn(async ({ prefix }: { prefix: string }) => ({ keys: [...values.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })), list_complete: true, cursor: "" })),
	};
	return { env: { BEACH_DATA: kv, ALLOW_LEGACY_REFRESH_SECRET: "true", REFRESH_SECRET: "secret" } as unknown as Env, values, kv };
}

const adminHeaders = (revision: string) => ({ "x-refresh-secret": "secret", "If-Match": revision, "Content-Type": "application/json" });

describe("operational control schema and precedence", () => {
	it("rejects missing, extra, and malformed control fields", () => {
		const valid = defaultOperationalControl(new Date("2026-07-21T20:00:00.000Z"));
		expect(parseOperationalControl(valid)).not.toBeNull();
		expect(parseOperationalControl({ ...valid, surprise: true })).toBeNull();
		expect(parseOperationalControl({ ...valid, controls: { ...valid.controls, "domains.beachFlags": { state: "magic" } } })).toBeNull();
	});

	it("never lets a provider enable override a disabled global or domain control", () => {
		const doc = defaultOperationalControl();
		doc.controls["global.liveData"] = { state: "disabled", activatedAt: "2026-07-21T19:00:00.000Z", expiresAt: "2026-07-22T19:00:00.000Z", onExpiry: "require_review" };
		expect(evaluateFlagControl(doc, "orangeBeachFlags", new Date("2026-07-21T20:00:00.000Z"))).toMatchObject({ state: "disabled", controlId: "global.liveData" });
		doc.controls["global.liveData"] = { state: "enabled" };
		doc.controls["domains.beachFlags"] = { state: "disabled" };
		expect(evaluateFlagControl(doc, "gulfShoresFlags")).toMatchObject({ state: "disabled", controlId: "domains.beachFlags" });
	});

	it("keeps an expired review-required disable closed and permits explicit enable-on-expiry", () => {
		const doc = defaultOperationalControl();
		doc.controls["providers.gulfShoresFlags"] = { state: "disabled", expiresAt: "2026-07-21T19:00:00.000Z", onExpiry: "require_review" };
		expect(evaluateFlagControl(doc, "gulfShoresFlags", new Date("2026-07-21T20:00:00.000Z")).state).toBe("disabled");
		doc.controls["providers.gulfShoresFlags"].onExpiry = "enable";
		expect(evaluateFlagControl(doc, "gulfShoresFlags", new Date("2026-07-21T20:00:00.000Z")).state).toBe("enabled");
	});
});

describe("operational control routes", () => {
	it("requires authorization and If-Match and appends audit/snapshots", async () => {
		const doc = defaultOperationalControl(new Date("2026-07-21T20:00:00.000Z"));
		const h = memoryEnv(doc);
		expect((await worker.fetch(new Request("https://example.com/admin/operational-control"), h.env)).status).toBe(403);
		const body = { controlId: "providers.gulfShoresFlags", state: "disabled", reasonCode: "verification_failed", operatorReason: "Official value cannot be verified", expiresAt: "2026-07-22T20:00:00.000Z" };
		expect((await worker.fetch(new Request("https://example.com/admin/operational-control", { method: "PATCH", headers: adminHeaders("wrong"), body: JSON.stringify(body) }), h.env)).status).toBe(412);
		const response = await worker.fetch(new Request("https://example.com/admin/operational-control", { method: "PATCH", headers: adminHeaders(doc.revision), body: JSON.stringify(body) }), h.env);
		expect(response.status).toBe(200);
		const next = (await response.json() as { configuration: { revision: string } }).configuration;
		expect(next.revision).not.toBe(doc.revision);
		expect([...h.values.keys()].some((key) => key.startsWith("operational-control:v1:audit:"))).toBe(true);
		expect(h.values.has(`operational-control:v1:snapshot:${doc.revision}`)).toBe(true);
	});

	it("rejects unknown fields and requires reason and expiry", async () => {
		const doc = defaultOperationalControl(); const h = memoryEnv(doc);
		for (const body of [
			{ controlId: "domains.beachFlags", state: "disabled", reasonCode: "incident_response", operatorReason: "x", expiresAt: "2026-07-22T20:00:00.000Z", extra: true },
			{ controlId: "domains.beachFlags", state: "disabled", reasonCode: "incident_response", operatorReason: "x" },
		]) expect((await worker.fetch(new Request("https://example.com/admin/operational-control", { method: "PATCH", headers: adminHeaders(doc.revision), body: JSON.stringify(body) }), h.env)).status).toBe(400);
	});

	it("sanitizes public configuration", async () => {
		const doc = defaultOperationalControl(); doc.updatedBy = "private@example.com"; doc.controls["domains.beachFlags"] = { state: "disabled", operatorReason: "private details" };
		const response = await worker.fetch(new Request("https://example.com/v1/app-configuration"), memoryEnv(doc).env);
		const text = await response.text();
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(text).not.toContain("private@example.com"); expect(text).not.toContain("private details");
	});
});

describe("availability and client compatibility", () => {
	const payload = { status: "ok", generatedAt: "2026-07-21T20:00:00.000Z", count: 3, beachFlags: [
		{ beachId: "gulf-shores-public-beach", primaryFlag: "green", lastUpdated: "2026-07-21T20:00:00.000Z" },
		{ beachId: "fort-morgan-public-beach", primaryFlag: "yellow", lastUpdated: "2026-07-21T20:00:00.000Z" },
		{ beachId: "cotton-bayou", primaryFlag: "red", lastUpdated: "2026-07-21T20:00:00.000Z" },
	], errors: [] };

	it("removes Gulf Shores and inherited Fort Morgan while preserving Orange Beach", () => {
		const doc = defaultOperationalControl(); doc.controls["providers.gulfShoresFlags"] = { state: "disabled", activatedAt: "2026-07-21T20:10:00.000Z" };
		const result = enforceBeachFlagPayload(payload, doc, new Date("2026-07-21T20:30:00.000Z"));
		expect(result.beachFlags.map((item) => item.beachId)).toEqual(["cotton-bayou"]);
		expect(result.availability.filter((item) => item.reason === "temporarily_disabled").map((item) => item.beachId)).toEqual(expect.arrayContaining(["gulf-shores-public-beach", "fort-morgan-public-beach"]));
	});

	it("hard-expires at greater than 60 minutes without serializing a magic flag", () => {
		const result = enforceBeachFlagPayload(payload, defaultOperationalControl(), new Date("2026-07-21T21:00:00.001Z"));
		expect(result.beachFlags).toEqual([]);
		expect(JSON.stringify(result)).not.toMatch(/"primaryFlag":"(green|yellow|unknown)"/);
	});

	it("parses capabilities and validates build numbers", () => {
		const request = new Request("https://example.com", { headers: { "X-ABF-App-Version": "1.3.0", "X-ABF-App-Build": "8", "X-ABF-Client": "ios", "X-ABF-Capabilities": "operational-config-v1, flag-availability-v2" } });
		expect(parseClientIdentification(request)).toMatchObject({ version: "1.3.0", build: 8, client: "ios" });
		expect(parseClientIdentification(request).capabilities.has("flag-availability-v2")).toBe(true);
	});
});
