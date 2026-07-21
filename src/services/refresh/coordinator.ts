import type { Env } from "../../types";
import { BEACH_CONDITIONS_CACHE_KEY, BEACH_FLAGS_CACHE_KEY, RIP_CURRENT_OUTLOOK_CACHE_KEY, WATER_QUALITY_CACHE_KEY } from "../cache/kv";
import { logError, logInfo, logWarn } from "../../utils/logger";
import { beaches as BEACH_REGISTRY } from "../../config/BeachRegistry";
import { buildBeachFlagsPayload } from "../beachFlags/refresh";
import { buildBeachConditionsPayload } from "./beachConditionsRefresh";
import { buildWaterQualityPayload } from "./waterQualityRefresh";
import { buildRipCurrentOutlookPayload } from "../ripCurrentOutlook/refresh";
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
	beachConditions?: unknown[];
	errors?: Array<{ message?: string }>;
	refreshDiagnostics?: {
		expectedBeachCount: number;
		providerFailures: Record<string, number>;
	};
	kvWrites?: Array<{ key: string; value: string | ArrayBuffer; options?: KVNamespacePutOptions; expectedRevision?: string }>;
}

export type RefreshRunner = () => Promise<RefreshPayload>;
export type RefreshRunners = Record<RefreshJob, RefreshRunner>;

const STATE_KEY = "coordinator-state";
const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1_000;

interface BeachConditionsQualityDecision {
	reject: boolean;
	reason?: "invalid_candidate" | "catastrophic_shared_provider_degradation";
	expectedCount: number;
	priorCount: number;
	affectedProvider?: string;
	providerFailureCount: number;
}

function validPublishedCount(payload: unknown): number | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const candidate = payload as { count?: unknown; beachConditions?: unknown };
	if (!Number.isInteger(candidate.count) || (candidate.count as number) < 0) return undefined;
	if (candidate.beachConditions !== undefined && (
		!Array.isArray(candidate.beachConditions) || candidate.beachConditions.length !== candidate.count
	)) return undefined;
	return candidate.count as number;
}

export function evaluateBeachConditionsPublication(
	candidate: RefreshPayload,
	prior: unknown,
): BeachConditionsQualityDecision {
	const expectedCount = Math.max(
		BEACH_REGISTRY.length,
		candidate.refreshDiagnostics?.expectedBeachCount ?? 0,
	);
	const priorCount = validPublishedCount(prior) ?? 0;
	const candidateCount = validPublishedCount(candidate);
	const providerFailures = Object.entries(candidate.refreshDiagnostics?.providerFailures ?? {})
		.sort((left, right) => right[1] - left[1]);
	const [affectedProvider, providerFailureCount = 0] = providerFailures[0] ?? [];
	const priorIsHealthy = priorCount >= expectedCount;

	if (priorIsHealthy && candidateCount === undefined) {
		return { reject: true, reason: "invalid_candidate", expectedCount, priorCount, affectedProvider, providerFailureCount };
	}

	const catastrophicCount = Math.floor(expectedCount / 3);
	const concentratedFailureCount = Math.ceil(expectedCount * 2 / 3);
	const countLoss = priorCount - (candidateCount ?? 0);
	const catastrophicEmptyCandidate = priorIsHealthy && candidateCount === 0;
	const catastrophicSharedFailure = priorIsHealthy
		&& candidateCount !== undefined
		&& candidateCount <= catastrophicCount
		&& countLoss >= concentratedFailureCount
		&& providerFailureCount >= concentratedFailureCount;
	const reject = catastrophicEmptyCandidate || catastrophicSharedFailure;

	return {
		reject,
		...(reject ? { reason: "catastrophic_shared_provider_degradation" as const } : {}),
		expectedCount,
		priorCount,
		affectedProvider,
		providerFailureCount,
	};
}

export const REFRESH_JOB_CONFIG: Record<RefreshJob, {
	cooldownMs: number;
	leaseMs: number;
	cacheKey: string;
	expirationTtl?: number;
}> = {
	"beach-flags": { cooldownMs: 60_000, leaseMs: 2 * 60_000, cacheKey: BEACH_FLAGS_CACHE_KEY },
	"beach-conditions": { cooldownMs: 5 * 60_000, leaseMs: 5 * 60_000, cacheKey: BEACH_CONDITIONS_CACHE_KEY, expirationTtl: 2 * 60 * 60 },
	"water-quality": { cooldownMs: 30 * 60_000, leaseMs: 10 * 60_000, cacheKey: WATER_QUALITY_CACHE_KEY },
	"rip-current-outlook": { cooldownMs: 30 * 60_000, leaseMs: 5 * 60_000, cacheKey: RIP_CURRENT_OUTLOOK_CACHE_KEY },
};

function productionRunners(env: Env): RefreshRunners { return {
	"beach-flags": buildBeachFlagsPayload,
	"beach-conditions": () => buildBeachConditionsPayload({ vibrioConditionsEnabled: env.VIBRIO_CONDITIONS_ENABLED === "true" }),
	"water-quality": buildWaterQualityPayload,
	"rip-current-outlook": () => buildRipCurrentOutlookPayload(env),
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

				if (request.job === "beach-conditions") {
					const priorPayload = await this.env.BEACH_DATA.get(config.cacheKey, "json");
					const decision = evaluateBeachConditionsPublication(payload, priorPayload);
					if (decision.reject) {
						const errorSummary = [...new Set((payload.errors ?? []).map((error) => error.message).filter(Boolean))].slice(0, 5);
						logWarn("Refresh Coordinator", "Rejected degraded beach conditions candidate", {
							reason: decision.reason,
							candidateCount: payload.count,
							priorCount: decision.priorCount,
							expectedCount: decision.expectedCount,
							affectedProvider: decision.affectedProvider,
							providerFailureCount: decision.providerFailureCount,
							errorSummary: errorSummary.join(","),
						});
						await this.env.BEACH_DATA.put(
							config.cacheKey,
							JSON.stringify(priorPayload),
							config.expirationTtl ? { expirationTtl: config.expirationTtl } : undefined,
						);
						throw new Error("beach_conditions_quality_gate_rejected");
					}
				}

				for (const write of payload.kvWrites ?? []) {
					await this.env.BEACH_DATA.put(write.key, write.value, write.options);
					if (write.expectedRevision) {
						const staged = await this.env.BEACH_DATA.getWithMetadata<{ revision?: string }>(write.key, "arrayBuffer");
						if (!staged.value || staged.metadata?.revision !== write.expectedRevision) throw new Error("staged_revision_validation_failed");
					}
				}
				const { kvWrites: _kvWrites, refreshDiagnostics: _refreshDiagnostics, ...publicPayload } = payload;
				await this.env.BEACH_DATA.put(
					config.cacheKey,
					JSON.stringify(publicPayload),
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
			const errorMessage = error instanceof Error ? error.message : "unknown_error";
			if (errorMessage !== "beach_conditions_quality_gate_rejected") {
				logError("Refresh Coordinator", "Refresh failed", {
					job: request.job,
					generation,
					error: errorMessage,
				});
			}
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
