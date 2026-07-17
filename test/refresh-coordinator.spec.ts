import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
	REFRESH_JOB_CONFIG,
	RefreshCoordinatorCore,
	type RefreshRunners,
} from "../src/services/refresh/coordinator";
import type { RefreshJob, RefreshRunRequest } from "../src/services/refresh/types";
import type { Env } from "../src/types";

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

function request(job: RefreshJob, key: string, trigger: "admin" | "scheduled" = "admin"): RefreshRunRequest {
	return { job, trigger, idempotencyKey: key };
}

function harness(runners?: Partial<RefreshRunners>) {
	const storage = new MemoryStorage();
	const blockConcurrencyWhile = vi.fn(async <T>(callback: () => Promise<T>) => callback());
	const ctx = { storage, blockConcurrencyWhile } as unknown as DurableObjectState;
	const put = vi.fn().mockResolvedValue(undefined);
	const env = { BEACH_DATA: { put } } as unknown as Env;
	const defaults = {
		"beach-flags": vi.fn().mockResolvedValue(payload()),
		"beach-conditions": vi.fn().mockResolvedValue(payload()),
		"water-quality": vi.fn().mockResolvedValue(payload()),
	} satisfies RefreshRunners;
	const allRunners = { ...defaults, ...runners } as RefreshRunners;
	let now = Date.parse("2026-07-16T18:00:00.000Z");
	const core = new RefreshCoordinatorCore(ctx, env, allRunners, () => now);
	return { core, storage, put, runners: allRunners, setNow: (value: number) => { now = value; } };
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
});

describe("Durable Object configuration", () => {
	it("uses the approved administrative cooldowns", () => {
		expect(REFRESH_JOB_CONFIG["beach-flags"].cooldownMs).toBe(60_000);
		expect(REFRESH_JOB_CONFIG["beach-conditions"].cooldownMs).toBe(5 * 60_000);
		expect(REFRESH_JOB_CONFIG["water-quality"].cooldownMs).toBe(30 * 60_000);
	});

	it("declares the binding and SQLite migration", () => {
		const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
		expect(config).toContain('"name": "REFRESH_COORDINATOR"');
		expect(config).toContain('"class_name": "RefreshCoordinator"');
		expect(config).toContain('"new_sqlite_classes": ["RefreshCoordinator"]');
		expect(config).toContain('"ALLOW_LEGACY_REFRESH_SECRET": "false"');
	});
});
