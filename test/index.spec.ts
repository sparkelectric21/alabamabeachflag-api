import { describe, it, expect, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";

const testEnv = {} as Env;

function adminEnv(outcome = "completed") {
	const coordinatorFetch = vi.fn().mockImplementation(async () => Response.json({
		outcome,
		generation: 1,
		generatedAt: "2026-07-16T18:00:00.000Z",
		count: 9,
	}));
	const get = vi.fn(() => ({ fetch: coordinatorFetch }));
	const idFromName = vi.fn((name: string) => name);
	return {
		env: {
			REFRESH_SECRET: "migration-secret",
			ALLOW_LEGACY_REFRESH_SECRET: "true",
			REFRESH_COORDINATOR: { idFromName, get },
		} as unknown as Env,
		coordinatorFetch,
		get,
		idFromName,
	};
}

function adminRequest(path: string, idempotencyKey?: string, secret = "migration-secret") {
	const headers = new Headers({ "x-refresh-secret": secret });
	if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);
	return new Request(`https://example.com${path}`, { method: "POST", headers });
}

describe("Alabama Beach Flag API worker", () => {
	it("responds with API status (unit style)", async () => {
		const request = new Request("https://example.com");
		const response = await worker.fetch(request, testEnv);
		expect(await response.text()).toMatchInlineSnapshot(`"{\"service\":\"Alabama Beach Flag API\",\"version\":\"1.2.0\",\"status\":\"online\"}"`);
	});

	it("responds with API status (integration style)", async () => {
		const response = await worker.fetch(new Request("https://example.com"), testEnv);
		expect(await response.text()).toMatchInlineSnapshot(`"{\"service\":\"Alabama Beach Flag API\",\"version\":\"1.2.0\",\"status\":\"online\"}"`);
	});
});

describe("administrative routing", () => {
	it("rejects unauthorized requests before coordinator work", async () => {
		const h = adminEnv();
		const response = await worker.fetch(
			new Request("https://example.com/internal/refresh/water-quality", { method: "POST" }),
			h.env,
		);
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: "Forbidden" });
		expect(h.coordinatorFetch).not.toHaveBeenCalled();
	});

	it("requires an Idempotency-Key before coordinator work", async () => {
		const h = adminEnv();
		const response = await worker.fetch(adminRequest("/internal/refresh/water-quality"), h.env);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "invalid_idempotency_key" });
		expect(h.coordinatorFetch).not.toHaveBeenCalled();
	});

	it("maps duplicate coordinator results without additional work", async () => {
		const h = adminEnv("duplicate");
		const response = await worker.fetch(
			adminRequest("/internal/refresh/beach-flags", "admin-request-001"),
			h.env,
		);
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ error: "duplicate_request" });
		expect(h.coordinatorFetch).toHaveBeenCalledOnce();
	});

	it("removes the WeatherKit debug route from authenticated production routing", async () => {
		const h = adminEnv();
		const response = await worker.fetch(
			adminRequest("/internal/debug/weatherkit", "admin-request-001"),
			h.env,
		);
		expect(response.status).toBe(404);
		expect(h.coordinatorFetch).not.toHaveBeenCalled();
	});

	it("routes cron and administrative refreshes to the same named coordinator", async () => {
		const h = adminEnv();
		await worker.scheduled({
			cron: "*/5 * * * *",
			scheduledTime: 1_784_224_800_000,
		} as ScheduledController, h.env);
		await worker.fetch(adminRequest("/internal/refresh/beach-flags", "admin-request-001"), h.env);
		expect(h.idFromName).toHaveBeenNthCalledWith(1, "beach-flags");
		expect(h.idFromName).toHaveBeenNthCalledWith(2, "beach-flags");
		expect(h.get).toHaveBeenCalledTimes(2);
	});
});

describe("public API compatibility", () => {
	it.each([
		["/v1/beach-flags", "beach-flags", { status: "ok", apiVersion: "1.0.0", source: "test", generatedAt: "now", lastSuccessfulRefresh: "now", count: 0, beachFlags: [], errors: [] }],
		["/v1/beach-conditions", "beach-conditions", { status: "ok", apiVersion: "1.0.0", source: "test", generatedAt: "now", count: 0, beachConditions: [], errors: [] }],
		["/v1/water-quality", "water-quality", { status: "ok", apiVersion: "1.0.0", source: "ADEM", generatedAt: "now", lastSuccessfulRefresh: "now", count: 0, waterQuality: [] }],
	] as const)("preserves the successful schema for %s", async (path, key, payload) => {
		const env = { BEACH_DATA: { get: vi.fn(async (requested: string) => requested === key ? payload : null) } } as unknown as Env;
		const response = await worker.fetch(new Request(`https://example.com${path}`), env);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(payload);
	});
});
