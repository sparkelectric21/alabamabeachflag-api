import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
	REFRESH_JOB_CONFIG,
	RefreshCoordinatorCore,
	type RefreshRunners,
} from "../src/services/refresh/coordinator";
import type { RefreshJob, RefreshRunRequest } from "../src/services/refresh/types";
import type { Env } from "../src/types";
import { defaultOperationalControl } from "../src/operationalControl/store";

class MemoryStorage {
	private readonly values = new Map<string, unknown>();

	async get<T>(key: string): Promise<T | undefined> {
		return this.values.get(key) as T | undefined;
	}

	async put(key: string, value: unknown): Promise<void> {
		this.values.set(key, structuredClone(value));
	}

	async transaction<T>(callback: (transaction: MemoryStorage) => Promise<T>): Promise<T> {
		return callback(this);
	}
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

function payload(generatedAt = "2026-07-16T18:00:00.000Z") {
	return { status: "ok", generatedAt, count: 9 };
}

function beachConditionsPayload(count: number, nwsFailures: number, generatedAt = "2026-07-16T18:00:00.000Z") {
	return {
		status: count > 0 ? "ok" : "unavailable",
		generatedAt,
		count,
		beachConditions: Array.from({ length: count }, (_, index) => ({ beachId: `beach-${index}` })),
		errors: Array.from({ length: nwsFailures }, () => ({ message: "provider_unavailable" })),
		refreshDiagnostics: { expectedBeachCount: 9, providerFailures: { nws: nwsFailures } },
	};
}

function request(job: RefreshJob, key: string, trigger: "admin" | "scheduled" = "admin"): RefreshRunRequest {
	return { job, trigger, idempotencyKey: key };
}

function harness(runners?: Partial<RefreshRunners>, beachData?: Partial<KVNamespace>) {
	const storage = new MemoryStorage();
	const blockConcurrencyWhile = vi.fn(async <T>(callback: () => Promise<T>) => callback());
	const ctx = { storage, blockConcurrencyWhile } as unknown as DurableObjectState;
	const put = vi.fn().mockResolvedValue(undefined);
	const get = vi.fn().mockResolvedValue(null);
	const getWithMetadata = vi.fn().mockResolvedValue({ value: new ArrayBuffer(1), metadata: { revision: "new" } });
	const env = { BEACH_DATA: { put, get, getWithMetadata, ...beachData } } as unknown as Env;
	const defaults = {
		"beach-flags": vi.fn().mockResolvedValue(payload()),
		"beach-conditions": vi.fn().mockResolvedValue(payload()),
		"water-quality": vi.fn().mockResolvedValue(payload()),
		"rip-current-outlook": vi.fn().mockResolvedValue(payload()),
	} satisfies RefreshRunners;
	const allRunners = { ...defaults, ...runners } as RefreshRunners;
	let now = Date.parse("2026-07-16T18:00:00.000Z");
	const core = new RefreshCoordinatorCore(ctx, env, allRunners, () => now);
	return { core, storage, put: env.BEACH_DATA.put as typeof put, get: env.BEACH_DATA.get as typeof get, getWithMetadata: env.BEACH_DATA.getWithMetadata as typeof getWithMetadata, runners: allRunners, setNow: (value: number) => { now = value; } };
}

function writesFor(h: ReturnType<typeof harness>, key: string) {
	return h.put.mock.calls.filter(([writtenKey]) => writtenKey === key);
}

describe("refresh coordinator", () => {
	it("collapses duplicate administrative idempotency keys", async () => {
		const h = harness();
		expect((await h.core.run(request("beach-flags", "admin-request-001"))).outcome).toBe("completed");
		expect((await h.core.run(request("beach-flags", "admin-request-001"))).outcome).toBe("duplicate");
		expect(h.runners["beach-flags"]).toHaveBeenCalledOnce();
		expect(h.put).toHaveBeenCalledOnce();
	});

	it("collapses duplicate scheduled delivery", async () => {
		const h = harness();
		const scheduled = request("water-quality", "scheduled:water-quality:1000", "scheduled");
		expect((await h.core.run(scheduled)).outcome).toBe("completed");
		expect((await h.core.run(scheduled)).outcome).toBe("duplicate");
		expect(h.runners["water-quality"]).toHaveBeenCalledOnce();
		expect(h.put).toHaveBeenCalledOnce();
	});

	it("enforces administrative cooldown without provider fetches or KV writes", async () => {
		const h = harness();
		await h.core.run(request("beach-conditions", "admin-request-001"));
		h.put.mockClear();
		vi.mocked(h.runners["beach-conditions"]).mockClear();
		h.setNow(Date.parse("2026-07-16T18:01:00.000Z"));
		const result = await h.core.run(request("beach-conditions", "admin-request-002"));
		expect(result.outcome).toBe("cooldown");
		expect(h.runners["beach-conditions"]).not.toHaveBeenCalled();
		expect(h.put).not.toHaveBeenCalled();
	});

	it("rejects concurrent refresh attempts without duplicate work", async () => {
		const first = deferred<ReturnType<typeof payload>>();
		const started = deferred<void>();
		const runner = vi.fn(() => { started.resolve(); return first.promise; });
		const h = harness({ "beach-flags": runner });
		const firstRun = h.core.run(request("beach-flags", "admin-request-001"));
		await started.promise;
		const second = await h.core.run(request("beach-flags", "admin-request-002", "scheduled"));
		expect(second.outcome).toBe("in_progress");
		expect(runner).toHaveBeenCalledOnce();
		expect(h.put).not.toHaveBeenCalled();
		first.resolve(payload());
		expect((await firstRun).outcome).toBe("completed");
	});

	it("recovers an expired lease and permanently fences the abandoned generation", async () => {
		const oldResult = deferred<ReturnType<typeof payload>>();
		const oldStarted = deferred<void>();
		const runner = vi.fn()
			.mockImplementationOnce(() => { oldStarted.resolve(); return oldResult.promise; })
			.mockResolvedValueOnce(payload("2026-07-16T18:03:00.000Z"));
		const h = harness({ "water-quality": runner });
		const oldRun = h.core.run(request("water-quality", "scheduled:water-quality:1000", "scheduled"));
		await oldStarted.promise;
		h.setNow(Date.parse("2026-07-16T18:00:00.000Z") + REFRESH_JOB_CONFIG["water-quality"].leaseMs + 1);
		const replacement = await h.core.run(request("water-quality", "scheduled:water-quality:2000", "scheduled"));
		expect(replacement).toMatchObject({ outcome: "completed", generation: 2 });
		expect(h.put).toHaveBeenCalledOnce();
		expect(runner).toHaveBeenCalledTimes(2);

		oldResult.resolve(payload("2026-07-16T17:59:00.000Z"));
		expect(await oldRun).toMatchObject({ outcome: "fenced", generation: 1 });
		expect(h.put).toHaveBeenCalledOnce();
		expect(runner).toHaveBeenCalledTimes(2);
		const written = JSON.parse(h.put.mock.calls[0][1] as string);
		expect(written.generatedAt).toBe("2026-07-16T18:03:00.000Z");
	});

	it("allows an administrator to recover an expired lease even when the normal cooldown is longer", async () => {
		const abandoned = deferred<ReturnType<typeof payload>>();
		const started = deferred<void>();
		const runner = vi.fn()
			.mockImplementationOnce(() => { started.resolve(); return abandoned.promise; })
			.mockResolvedValueOnce(payload("2026-07-16T18:11:00.000Z"));
		const h = harness({ "water-quality": runner });
		const oldRun = h.core.run(request("water-quality", "admin-request-001"));
		await started.promise;
		h.setNow(Date.parse("2026-07-16T18:00:00.000Z") + REFRESH_JOB_CONFIG["water-quality"].leaseMs + 1);
		expect((await h.core.run(request("water-quality", "admin-request-002"))).outcome).toBe("completed");
		abandoned.resolve(payload("2026-07-16T17:59:00.000Z"));
		expect((await oldRun).outcome).toBe("fenced");
		expect(h.put).toHaveBeenCalledOnce();
	});

	it("uses the same coordinator state for scheduled and administrative requests", async () => {
		const pending = deferred<ReturnType<typeof payload>>();
		const started = deferred<void>();
		const runner = vi.fn(() => { started.resolve(); return pending.promise; });
		const h = harness({ "beach-flags": runner });
		const cron = h.core.run(request("beach-flags", "scheduled:beach-flags:1000", "scheduled"));
		await started.promise;
		const admin = await h.core.run(request("beach-flags", "admin-request-001", "admin"));
		expect(admin.outcome).toBe("in_progress");
		expect(runner).toHaveBeenCalledOnce();
		pending.resolve(payload());
		await cron;
	});

	it("does not write KV when provider execution fails", async () => {
		const h = harness({ "water-quality": vi.fn().mockRejectedValue(new Error("provider detail\ninjected")) });
		expect((await h.core.run(request("water-quality", "admin-request-001"))).outcome).toBe("failed");
		expect(h.put).not.toHaveBeenCalled();
	});

	it("rechecks controls at commit so a pre-disable refresh cannot publish Gulf Shores", async () => {
		const pending = deferred<any>();
		let controls = defaultOperationalControl(new Date("2026-07-16T18:00:00.000Z"));
		const get = vi.fn(async (key: string) => key === "operational-control:v1:current" ? controls : null);
		const h = harness({ "beach-flags": vi.fn(() => pending.promise) }, { get } as Partial<KVNamespace>);
		const run = h.core.run(request("beach-flags", "race", "scheduled"));
		await Promise.resolve();
		controls = { ...controls, revision: "disabled-revision", controls: { ...controls.controls, "providers.gulfShoresFlags": { state: "disabled", activatedAt: "2026-07-16T18:00:00.000Z" } } };
		pending.resolve({ generatedAt: "2026-07-16T18:00:00.000Z", count: 2, beachFlags: [
			{ beachId: "gulf-shores-public-beach", primaryFlag: "green", lastUpdated: "2026-07-16T18:00:00.000Z" },
			{ beachId: "cotton-bayou", primaryFlag: "yellow", lastUpdated: "2026-07-16T18:00:00.000Z" },
		], errors: [] });
		expect((await run).outcome).toBe("completed");
		const published = JSON.parse(writesFor(h, "beach-flags")[0][1] as string);
		expect(published.beachFlags.map((item: { beachId: string }) => item.beachId)).toEqual(["cotton-bayou"]);
	});

	it("rejects a total empty flag candidate instead of replacing a valid snapshot", async () => {
		const prior = { count: 1, beachFlags: [{ beachId: "cotton-bayou", primaryFlag: "yellow", lastUpdated: "2026-07-16T18:00:00.000Z" }] };
		const get = vi.fn(async (key: string) => key === "beach-flags" ? prior : null);
		const h = harness({ "beach-flags": vi.fn().mockResolvedValue({ generatedAt: "2026-07-16T18:00:00.000Z", count: 0, beachFlags: [], errors: [] }) }, { get } as Partial<KVNamespace>);
		expect((await h.core.run(request("beach-flags", "empty", "scheduled"))).outcome).toBe("failed");
		expect(writesFor(h, "beach-flags")).toHaveLength(0);
	});

	it("preserves a healthy nine-beach snapshot when a shared outage produces zero beaches", async () => {
		const prior = beachConditionsPayload(9, 0, "2026-07-16T17:00:00.000Z");
		const get = vi.fn().mockResolvedValue(prior);
		const runner = vi.fn().mockResolvedValue(beachConditionsPayload(0, 9));
		const h = harness({ "beach-conditions": runner }, { get } as Partial<KVNamespace>);

		expect((await h.core.run(request("beach-conditions", "zero-candidate", "scheduled"))).outcome).toBe("failed");
		expect(writesFor(h, "beach-conditions")).toHaveLength(1);
		expect(JSON.parse(writesFor(h, "beach-conditions")[0][1] as string)).toEqual(prior);
	});

	it("rejects an empty candidate even when legacy runner diagnostics are absent", async () => {
		const prior = beachConditionsPayload(9, 0, "2026-07-16T17:00:00.000Z");
		const get = vi.fn().mockResolvedValue(prior);
		const legacyEmpty = { status: "unavailable", generatedAt: "2026-07-16T18:00:00.000Z", count: 0, beachConditions: [], errors: [] };
		const h = harness(
			{ "beach-conditions": vi.fn().mockResolvedValue(legacyEmpty) },
			{ get } as Partial<KVNamespace>,
		);

		expect((await h.core.run(request("beach-conditions", "legacy-empty", "scheduled"))).outcome).toBe("failed");
		expect(JSON.parse(writesFor(h, "beach-conditions")[0][1] as string)).toEqual(prior);
	});

	it("preserves a healthy nine-beach snapshot when a concentrated outage produces a near-zero candidate", async () => {
		const prior = beachConditionsPayload(9, 0, "2026-07-16T17:00:00.000Z");
		const get = vi.fn().mockResolvedValue(prior);
		const runner = vi.fn().mockResolvedValue(beachConditionsPayload(2, 7));
		const h = harness({ "beach-conditions": runner }, { get } as Partial<KVNamespace>);

		expect((await h.core.run(request("beach-conditions", "near-zero-candidate", "scheduled"))).outcome).toBe("failed");
		expect(writesFor(h, "beach-conditions")).toHaveLength(1);
		expect(JSON.parse(writesFor(h, "beach-conditions")[0][1] as string)).toEqual(prior);
	});

	it("rejects an invalid candidate payload when a healthy snapshot exists", async () => {
		const prior = beachConditionsPayload(9, 0, "2026-07-16T17:00:00.000Z");
		const get = vi.fn().mockResolvedValue(prior);
		const invalidCandidate = { ...beachConditionsPayload(9, 0), beachConditions: [] };
		const h = harness(
			{ "beach-conditions": vi.fn().mockResolvedValue(invalidCandidate) },
			{ get } as Partial<KVNamespace>,
		);

		expect((await h.core.run(request("beach-conditions", "invalid-candidate", "scheduled"))).outcome).toBe("failed");
		expect(writesFor(h, "beach-conditions")).toHaveLength(1);
		expect(JSON.parse(writesFor(h, "beach-conditions")[0][1] as string)).toEqual(prior);
	});

	it("publishes an ordinary isolated provider failure and strips internal diagnostics", async () => {
		const prior = beachConditionsPayload(9, 0, "2026-07-16T17:00:00.000Z");
		const get = vi.fn().mockResolvedValue(prior);
		const runner = vi.fn().mockResolvedValue(beachConditionsPayload(8, 1));
		const h = harness({ "beach-conditions": runner }, { get } as Partial<KVNamespace>);

		expect((await h.core.run(request("beach-conditions", "isolated-candidate", "scheduled"))).outcome).toBe("completed");
		expect(writesFor(h, "beach-conditions")).toHaveLength(1);
		const published = JSON.parse(writesFor(h, "beach-conditions")[0][1] as string);
		expect(published).toMatchObject({ count: 8 });
		expect(published).not.toHaveProperty("refreshDiagnostics");
	});

	it("publishes normal recovery after rejecting a degraded candidate", async () => {
		const prior = beachConditionsPayload(9, 0, "2026-07-16T17:00:00.000Z");
		const get = vi.fn().mockResolvedValue(prior);
		const runner = vi.fn()
			.mockResolvedValueOnce(beachConditionsPayload(0, 9))
			.mockResolvedValueOnce(beachConditionsPayload(9, 0, "2026-07-16T18:30:00.000Z"));
		const h = harness({ "beach-conditions": runner }, { get } as Partial<KVNamespace>);

		expect((await h.core.run(request("beach-conditions", "outage", "scheduled"))).outcome).toBe("failed");
		h.put.mockClear();
		expect((await h.core.run(request("beach-conditions", "recovery", "scheduled"))).outcome).toBe("completed");
		expect(writesFor(h, "beach-conditions")).toHaveLength(1);
		expect(JSON.parse(writesFor(h, "beach-conditions")[0][1] as string)).toMatchObject({ count: 9, generatedAt: "2026-07-16T18:30:00.000Z" });
	});

	it("does not publish metadata when a revision image write fails", async () => {
		const put = vi.fn(async (key: string) => { if (key === "rip-current-outlook:image:new") throw new Error("image write failed"); });
		const runner = vi.fn().mockResolvedValue({ ...payload(), revision: "new", kvWrites: [{ key: "rip-current-outlook:image:new", value: new ArrayBuffer(1), expectedRevision: "new" }] });
		const h = harness({ "rip-current-outlook": runner }, { put } as Partial<KVNamespace>);
		expect((await h.core.run(request("rip-current-outlook", "image-fails"))).outcome).toBe("failed");
		expect(put).toHaveBeenCalledTimes(1);
		expect(put).not.toHaveBeenCalledWith("rip-current-outlook", expect.anything(), expect.anything());
	});

	it("keeps prior publication usable when metadata publication fails after staging", async () => {
		const objects = new Map<string, unknown>([["rip-current-outlook", { revision: "prior" }], ["rip-current-outlook:image:prior", new ArrayBuffer(1)]]);
		const put = vi.fn(async (key: string, value: unknown) => {
			if (key === "rip-current-outlook") throw new Error("metadata write failed");
			objects.set(key, value);
		});
		const getWithMetadata = vi.fn(async (key: string) => ({ value: objects.get(key) as ArrayBuffer | undefined, metadata: { revision: "new" } }));
		const runner = vi.fn().mockResolvedValue({ ...payload(), revision: "new", kvWrites: [{ key: "rip-current-outlook:image:new", value: new ArrayBuffer(2), expectedRevision: "new" }] });
		const h = harness({ "rip-current-outlook": runner }, { put, getWithMetadata } as Partial<KVNamespace>);
		expect((await h.core.run(request("rip-current-outlook", "metadata-fails"))).outcome).toBe("failed");
		expect(objects.get("rip-current-outlook")).toEqual({ revision: "prior" });
		expect(objects.has("rip-current-outlook:image:prior")).toBe(true);
		expect(objects.has("rip-current-outlook:image:new")).toBe(true);
		expect(put.mock.calls.map(([key]) => key)).toEqual(["rip-current-outlook:image:new", "rip-current-outlook"]);
	});

	it("validates a staged revision before publishing matching metadata", async () => {
		const events: string[] = [];
		const put = vi.fn(async (key: string) => { events.push(`put:${key}`); });
		const getWithMetadata = vi.fn(async (key: string) => { events.push(`validate:${key}`); return { value: new ArrayBuffer(1), metadata: { revision: "new" } }; });
		const runner = vi.fn().mockResolvedValue({ ...payload(), revision: "new", kvWrites: [{ key: "rip-current-outlook:image:new", value: new ArrayBuffer(1), expectedRevision: "new" }] });
		const h = harness({ "rip-current-outlook": runner }, { put, getWithMetadata } as Partial<KVNamespace>);
		expect((await h.core.run(request("rip-current-outlook", "ordered"))).outcome).toBe("completed");
		expect(events).toEqual(["put:rip-current-outlook:image:new", "validate:rip-current-outlook:image:new", "put:rip-current-outlook"]);
	});
});

describe("Durable Object configuration", () => {
	it("uses the approved administrative cooldowns", () => {
		expect(REFRESH_JOB_CONFIG["beach-flags"].cooldownMs).toBe(60_000);
		expect(REFRESH_JOB_CONFIG["beach-conditions"].cooldownMs).toBe(5 * 60_000);
		expect(REFRESH_JOB_CONFIG["water-quality"].cooldownMs).toBe(30 * 60_000);
		expect(REFRESH_JOB_CONFIG["rip-current-outlook"].cooldownMs).toBe(30 * 60_000);
	});

	it("declares the binding and SQLite migration", () => {
		const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
		expect(config).toContain('"name": "REFRESH_COORDINATOR"');
		expect(config).toContain('"class_name": "RefreshCoordinator"');
		expect(config).toContain('"new_sqlite_classes": ["RefreshCoordinator"]');
		expect(config).toContain('"ALLOW_LEGACY_REFRESH_SECRET": "false"');
	});
});
