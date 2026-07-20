import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";

function harness(initial: unknown = null) {
	let stored = initial;
	const kv = {
		get: vi.fn(async () => stored),
		put: vi.fn(async (_key: string, value: string) => { stored = JSON.parse(value); }),
		delete: vi.fn(async () => { stored = null; }),
	};
	return { env: { BEACH_DATA: kv, REFRESH_SECRET: "secret", ALLOW_LEGACY_REFRESH_SECRET: "true" } as unknown as Env, kv };
}

const valid = {
	id: "provider-delay-2026-07-20",
	title: "Service Notice",
	message: "Beach flag updates may be delayed.",
	severity: "important",
	startsAt: "2026-07-20T00:00:00Z",
	expiresAt: "2099-07-21T00:00:00Z",
	actionTitle: "Learn More",
	actionUrl: "https://alabamabeachflag.com/status",
};

function admin(method: "PUT" | "DELETE", body?: unknown, secret = "secret") {
	return new Request("https://example.com/internal/app-announcement", {
		method,
		headers: { "x-refresh-secret": secret, "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

const adminOrigins = ["https://alabamabeachflag.com", "https://www.alabamabeachflag.com"];
const adminOrigin = adminOrigins[1];

describe("app announcement", () => {
	it("returns an explicit inactive state with cache headers", async () => {
		const h = harness();
		const response = await worker.fetch(new Request("https://example.com/v1/app-announcement"), h.env);
		expect(await response.json()).toEqual({ status: "ok", announcement: null });
		expect(response.headers.get("Cache-Control")).toContain("max-age=60");
		expect(response.headers.get("ETag")).toBe('"app-announcement-inactive"');
	});

	it("publishes, replaces with a new revision, and clears through authenticated routes", async () => {
		const h = harness();
		const first = await worker.fetch(admin("PUT", valid), h.env);
		expect(first.status).toBe(200);
		expect(first.headers.get("Cache-Control")).toBe("no-store");
		const firstBody = await first.json() as { announcement: { revision: string } };
		const second = await worker.fetch(admin("PUT", { ...valid, message: "Updated." }), h.env);
		const secondBody = await second.json() as { announcement: { revision: string } };
		expect(secondBody.announcement.revision).not.toBe(firstBody.announcement.revision);
		expect(h.kv.put).toHaveBeenCalledTimes(2);
		const cleared = await worker.fetch(admin("DELETE"), h.env);
		expect(await cleared.json()).toEqual({ status: "ok", announcement: null });
		expect(h.kv.delete).toHaveBeenCalledOnce();
	});

	it("requires authentication for writes and deletes", async () => {
		const h = harness();
		expect((await worker.fetch(admin("PUT", valid, "wrong"), h.env)).status).toBe(403);
		expect((await worker.fetch(admin("DELETE", undefined, "wrong"), h.env)).status).toBe(403);
	});

	it("allows both official admin origins in credentialed CORS responses", async () => {
		const h = harness();
		for (const origin of adminOrigins) {
			const publicResponse = await worker.fetch(new Request("https://example.com/v1/app-announcement", { headers: { Origin: origin } }), h.env);
			expect(publicResponse.headers.get("Access-Control-Allow-Origin")).toBe(origin);
			expect(publicResponse.headers.get("Access-Control-Allow-Credentials")).toBe("true");
		}

		const untrusted = await worker.fetch(new Request("https://example.com/v1/app-announcement", { headers: { Origin: "https://evil.example" } }), h.env);
		expect(untrusted.headers.get("Access-Control-Allow-Origin")).toBeNull();
	});

	it("handles exact-origin preflight without weakening administrative authentication", async () => {
		const h = harness();
		const response = await worker.fetch(new Request("https://example.com/internal/app-announcement", {
			method: "OPTIONS",
			headers: { Origin: adminOrigin, "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "content-type" },
		}), h.env);
		expect(response.status).toBe(204);
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe(adminOrigin);
		expect(response.headers.get("Access-Control-Allow-Methods")).toContain("PUT");
		expect(h.kv.put).not.toHaveBeenCalled();
	});

	it("rejects untrusted browser origins while retaining non-browser service clients", async () => {
		const h = harness();
		const hostile = admin("PUT", valid);
		hostile.headers.set("Origin", "https://evil.example");
		expect((await worker.fetch(hostile, h.env)).status).toBe(403);
		expect(h.kv.put).not.toHaveBeenCalled();
		expect((await worker.fetch(admin("PUT", valid), h.env)).status).toBe(200);
	});

	it("rejects untrusted and unsupported preflights", async () => {
		const h = harness();
		for (const [origin, method] of [["https://evil.example", "PUT"], [adminOrigin, "POST"]]) {
			const response = await worker.fetch(new Request("https://example.com/internal/app-announcement", {
				method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": method },
			}), h.env);
			expect(response.status).toBe(403);
		}
	});

	it.each([
		[{ ...valid, severity: "warning" }, "severity"],
		[{ ...valid, title: "" }, "title"],
		[{ ...valid, message: "x".repeat(501) }, "message"],
		[{ ...valid, startsAt: "July 20" }, "timestamps"],
		[{ ...valid, startsAt: "2026-02-30T00:00:00Z" }, "timestamps"],
		[{ ...valid, expiresAt: "2026-07-19T00:00:00Z" }, "later"],
		[{ ...valid, actionUrl: "http://alabamabeachflag.com/status" }, "HTTPS"],
		[{ ...valid, actionUrl: "https://example.com/status" }, "approved"],
		[{ ...valid, actionUrl: "https://alabamabeachflag.com/status#internal" }, "approved"],
		[{ ...valid, actionUrl: "https://user:password@alabamabeachflag.com/status" }, "approved"],
		[{ ...valid, actionUrl: "https://alabamabeachflag.com:8443/status" }, "approved"],
		[{ ...valid, unexpected: true }, "Unexpected"],
	])("rejects invalid administrative input %#", async (body, message) => {
		const h = harness();
		const response = await worker.fetch(admin("PUT", body), h.env);
		expect(response.status).toBe(400);
		expect(JSON.stringify(await response.json())).toContain(message);
		expect(h.kv.put).not.toHaveBeenCalled();
	});

	it("allows factual NWS data availability wording without allowing impersonation", async () => {
		const h = harness();
		const allowed = await worker.fetch(admin("PUT", { ...valid, message: "NWS data is temporarily unavailable." }), h.env);
		expect(allowed.status).toBe(200);

		for (const message of ["NWS alert from the National Weather Service.", "Government emergency notice.", "Coast Guard warning."]) {
			const response = await worker.fetch(admin("PUT", { ...valid, message }), h.env);
			expect(response.status).toBe(400);
		}
	});

	it("hides future and expired announcements", async () => {
		for (const stored of [
			{ ...valid, revision: "future", startsAt: "2098-01-01T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z" },
			{ ...valid, revision: "expired", startsAt: "2020-01-01T00:00:00Z", expiresAt: "2020-01-02T00:00:00Z" },
		]) {
			const response = await worker.fetch(new Request("https://example.com/v1/app-announcement"), harness(stored).env);
			expect((await response.json() as { announcement: unknown }).announcement).toBeNull();
		}
	});

	it("becomes inactive at the exact expiration instant", async () => {
		const stored = { ...valid, revision: "boundary", startsAt: "2026-07-20T00:00:00Z", expiresAt: "2026-07-21T00:00:00Z" };
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date(stored.expiresAt));
			const response = await worker.fetch(new Request("https://example.com/v1/app-announcement"), harness(stored).env);
			expect((await response.json() as { announcement: unknown }).announcement).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("returns an active announcement and honors If-None-Match", async () => {
		const stored = { ...valid, revision: "revision-1" };
		const h = harness(stored);
		const response = await worker.fetch(new Request("https://example.com/v1/app-announcement"), h.env);
		expect((await response.json() as { announcement: unknown }).announcement).toEqual(stored);
		const etag = response.headers.get("ETag")!;
		const conditional = await worker.fetch(new Request("https://example.com/v1/app-announcement", { headers: { "If-None-Match": etag } }), h.env);
		expect(conditional.status).toBe(304);
		expect(await conditional.text()).toBe("");
	});

	it("returns only documented public fields", async () => {
		const stored = { ...valid, revision: "revision-1", privateNote: "must not leak" };
		const response = await worker.fetch(new Request("https://example.com/v1/app-announcement"), harness(stored).env);
		const body = await response.json() as { announcement: Record<string, unknown> };
		expect(Object.keys(body.announcement).sort()).toEqual([
			"actionTitle", "actionUrl", "expiresAt", "id", "message", "revision", "severity", "startsAt", "title",
		].sort());
	});
});
