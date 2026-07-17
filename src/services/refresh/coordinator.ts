import type { Env } from "../../types";
import { BEACH_CONDITIONS_CACHE_KEY, BEACH_FLAGS_CACHE_KEY, WATER_QUALITY_CACHE_KEY } from "../cache/kv";
import { logError, logInfo } from "../../utils/logger";
import { buildBeachFlagsPayload } from "../beachFlags/refresh";
import { buildBeachConditionsPayload } from "./beachConditionsRefresh";
import { buildWaterQualityPayload } from "./waterQualityRefresh";
import type { RefreshJob, RefreshRunRequest, RefreshRunResult } from "./types";

interface ActiveRun {
	generation: number;
	runId: string;
	trigger: "admin" | "scheduled";
	startedAt: number;
	leaseExpiresAt: number;
}

interface StoredCoordinatorState {
	job?: RefreshJob;
	generation: number;
	active?: ActiveRun;
	lastAdminStartedAt?: number;
	lastSuccessfulAt?: number;
	recentRequests: Record<string, number>;
}

interface RefreshPayload {
	generatedAt: string;
	count: number;
}

export type RefreshRunner = () => Promise<RefreshPayload>;
export type RefreshRunners = Record<RefreshJob, RefreshRunner>;

const STATE_KEY = "coordinator-state";
const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1_000;

export const REFRESH_JOB_CONFIG: Record<RefreshJob, {
	cooldownMs: number;
	leaseMs: number;
	cacheKey: string;
	expirationTtl?: number;
}> = {
	"beach-flags": { cooldownMs: 60_000, leaseMs: 2 * 60_000, cacheKey: BEACH_FLAGS_CACHE_KEY },
	"beach-conditions": { cooldownMs: 5 * 60_000, leaseMs: 5 * 60_000, cacheKey: BEACH_CONDITIONS_CACHE_KEY, expirationTtl: 2 * 60 * 60 },
	"water-quality": { cooldownMs: 30 * 60_000, leaseMs: 10 * 60_000, cacheKey: WATER_QUALITY_CACHE_KEY },
};

function productionRunners(env: Env): RefreshRunners { return {
	"beach-flags": buildBeachFlagsPayload,
	"beach-conditions": () => buildBeachConditionsPayload({ vibrioConditionsEnabled: env.VIBRIO_CONDITIONS_ENABLED === "true" }),
	"water-quality": buildWaterQualityPayload,
}; }

function initialState(): StoredCoordinatorState {
	return { generation: 0, recentRequests: {} };
}

function pruneRecentRequests(recent: Record<string, number>, now: number): Record<string, number> {
	return Object.fromEntries(
		Object.entries(recent)
			.filter(([, expiresAt]) => expiresAt > now)
			.sort((left, right) => right[1] - left[1])
			.slice(0, 256),
	);
}

export class RefreshCoordinatorCore {
	constructor(
		private readonly ctx: DurableObjectState,
		private readonly env: Env,
		private readonly runners: RefreshRunners = productionRunners(env),
		private readonly now: () => number = Date.now,
	) {}

	async run(request: RefreshRunRequest): Promise<RefreshRunResult> {
		const config = REFRESH_JOB_CONFIG[request.job];
		if (!config) return { outcome: "failed" };

		const acquired = await this.acquire(request, config.cooldownMs, config.leaseMs);
		if ("outcome" in acquired) return acquired;

		const { generation, runId } = acquired;
		try {
			const payload = await this.runners[request.job]();
			let committed = false;

			// Provider I/O has finished. This short critical section fences the generation
			// and serializes only the final KV write, never external provider requests.
			await this.ctx.blockConcurrencyWhile(async () => {
				const state = (await this.ctx.storage.get<StoredCoordinatorState>(STATE_KEY)) ?? initialState();
				if (state.active?.generation !== generation || state.active.runId !== runId) return;

				await this.env.BEACH_DATA.put(
					config.cacheKey,
					JSON.stringify(payload),
					config.expirationTtl ? { expirationTtl: config.expirationTtl } : undefined,
				);
				state.active = undefined;
				state.lastSuccessfulAt = this.now();
				await this.ctx.storage.put(STATE_KEY, state);
				committed = true;
			});

			if (!committed) {
				logInfo("Refresh Coordinator", "Fenced stale refresh", { job: request.job, generation });
				return { outcome: "fenced", generation };
			}

			return {
				outcome: "completed",
				generation,
				generatedAt: payload.generatedAt,
				count: payload.count,
			};
		} catch (error) {
			await this.clearFailedRun(generation, runId);
			logError("Refresh Coordinator", "Refresh failed", {
				job: request.job,
				generation,
				error: error instanceof Error ? error.message : "unknown_error",
			});
			return { outcome: "failed", generation };
		}
	}

	private async acquire(
		request: RefreshRunRequest,
		cooldownMs: number,
		leaseMs: number,
	): Promise<{ generation: number; runId: string } | RefreshRunResult> {
		const now = this.now();
		let result: { generation: number; runId: string } | RefreshRunResult = { outcome: "failed" };

		await this.ctx.storage.transaction(async (transaction) => {
			const state = (await transaction.get<StoredCoordinatorState>(STATE_KEY)) ?? initialState();
			if (state.job && state.job !== request.job) {
				result = { outcome: "failed" };
				return;
			}
			state.job = request.job;
			state.recentRequests = pruneRecentRequests(state.recentRequests, now);

			if (state.recentRequests[request.idempotencyKey]) {
				result = { outcome: "duplicate", generation: state.generation };
				return;
			}

			if (state.active && state.active.leaseExpiresAt > now) {
				result = { outcome: "in_progress", generation: state.active.generation };
				return;
			}
			const replacingExpiredLease = Boolean(state.active && state.active.leaseExpiresAt <= now);

			if (
				request.trigger === "admin" &&
				!replacingExpiredLease &&
				state.lastAdminStartedAt !== undefined &&
				now - state.lastAdminStartedAt < cooldownMs
			) {
				result = {
					outcome: "cooldown",
					generation: state.generation,
					retryAt: new Date(state.lastAdminStartedAt + cooldownMs).toISOString(),
				};
				return;
			}

			const generation = state.generation + 1;
			const runId = crypto.randomUUID();
			state.generation = generation;
			state.active = {
				generation,
				runId,
				trigger: request.trigger,
				startedAt: now,
				leaseExpiresAt: now + leaseMs,
			};
			state.recentRequests[request.idempotencyKey] = now + IDEMPOTENCY_RETENTION_MS;
			if (request.trigger === "admin") state.lastAdminStartedAt = now;
			await transaction.put(STATE_KEY, state);
			result = { generation, runId };
		});

		return result;
	}

	private async clearFailedRun(generation: number, runId: string): Promise<void> {
		await this.ctx.storage.transaction(async (transaction) => {
			const state = (await transaction.get<StoredCoordinatorState>(STATE_KEY)) ?? initialState();
			if (state.active?.generation === generation && state.active.runId === runId) {
				state.active = undefined;
				await transaction.put(STATE_KEY, state);
			}
		});
	}
}

export class RefreshCoordinator {
	private readonly core: RefreshCoordinatorCore;

	constructor(ctx: DurableObjectState, env: Env) {
		this.core = new RefreshCoordinatorCore(ctx, env);
	}

	async fetch(request: Request): Promise<Response> {
		if (request.method !== "POST") return new Response(null, { status: 405 });
		try {
			const runRequest = await request.json<RefreshRunRequest>();
			return Response.json(await this.core.run(runRequest));
		} catch {
			return Response.json({ outcome: "failed" }, { status: 400 });
		}
	}
}
