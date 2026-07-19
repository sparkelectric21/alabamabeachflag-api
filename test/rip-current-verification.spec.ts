import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";
import { runVerificationSequence } from "../src/verification/coordinator";
import { runRipCurrentOutlookVerification } from "../src/verification/ripCurrentOutlook";

function env() {
	return {
		VERIFICATION_API_BASE_URL: "https://api.example.com",
		BEACH_DATA: { put: vi.fn() },
	} as unknown as Env;
}

function hangingResponse(input: string | URL | Request, init?: RequestInit): Promise<Response> {
	return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));
}

afterEach(() => vi.restoreAllMocks());

describe("rip current verification isolation", () => {
	it("bounds a hung metadata request and stores an isolated failure", async () => {
		vi.stubGlobal("fetch", vi.fn(hangingResponse));
		const e = env();
		const report = await runRipCurrentOutlookVerification(e, new Date("2026-07-19T12:00:00.000Z"), 5);
		expect(report.status).toBe("fail");
		expect(e.BEACH_DATA.put).toHaveBeenCalledWith("verification:rip-current-outlook:latest", expect.any(String));
	});

	it("bounds a hung image request after valid metadata", async () => {
		vi.stubGlobal("fetch", vi.fn()
			.mockResolvedValueOnce(Response.json({ provider: "National Weather Service Mobile/Pensacola", sourceUrl: "https://www.weather.gov/beach/mob", revision: "abc", freshness: "current", usingCachedImage: false }))
			.mockImplementationOnce(hangingResponse));
		expect((await runRipCurrentOutlookVerification(env(), new Date("2026-07-19T12:00:00.000Z"), 5)).status).toBe("fail");
	});

	it("accepts stale last-known-good content as a warning when revision matches", async () => {
		vi.stubGlobal("fetch", vi.fn()
			.mockResolvedValueOnce(Response.json({ provider: "National Weather Service Mobile/Pensacola", sourceUrl: "https://www.weather.gov/beach/mob", revision: "abc", freshness: "stale", usingCachedImage: true }))
			.mockResolvedValueOnce(new Response(new Uint8Array([1]), { headers: { "Content-Type": "image/png", ETag: '"abc"' } })));
		expect((await runRipCurrentOutlookVerification(env())).status).toBe("warning");
	});

	it("rejects stale metadata when its referenced image is absent", async () => {
		vi.stubGlobal("fetch", vi.fn()
			.mockResolvedValueOnce(Response.json({ provider: "National Weather Service Mobile/Pensacola", sourceUrl: "https://www.weather.gov/beach/mob", revision: "abc", freshness: "stale", usingCachedImage: true }))
			.mockResolvedValueOnce(Response.json({ status: "unavailable" }, { status: 503 })));
		expect((await runRipCurrentOutlookVerification(env())).status).toBe("fail");
	});

	it("finishes Gulf Shores alert processing before isolated Rip Current work", async () => {
		const order: string[] = [];
		const report = { status: "pass", slot: "2026-07-19T07", reportTime: "2026-07-19T12:00:00.000Z", checks: [] } as never;
		await runVerificationSequence({} as DurableObjectStorage, env(), new Date(), {
			runGulfShores: vi.fn(async () => { order.push("gulf-report"); return report; }),
			processGulfShoresAlert: vi.fn(async () => { order.push("gulf-alert"); }),
			runRipCurrent: vi.fn(async () => { order.push("rip-start"); throw new Error("isolated"); }),
		});
		expect(order).toEqual(["gulf-report", "gulf-alert", "rip-start"]);
	});
});
