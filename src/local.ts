import worker from "./index";
import type { Env } from "./types";
import { BEACH_CONDITIONS_CACHE_KEY } from "./services/cache/kv";
import { buildBeachConditionsPayload } from "./services/refresh/beachConditionsRefresh";
import {
	applyLocalVibrioQaFixture,
	resolveLocalVibrioQaFixture,
} from "./local/vibrioQaFixture";

interface LocalEnv extends Env {
	VIBRIO_QA_FIXTURE?: string;
}

export function isLocalWranglerRequest(request: Request): boolean {
	// This check is additive to the separate src/local.ts entrypoint. A deployed
	// Worker receives its public hostname; only loopback development may refresh
	// fixture data even if this local entrypoint were selected accidentally.
	const hostname = new URL(request.url).hostname.toLowerCase();
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

async function handleLocalBeachConditionsRefresh(request: Request, env: LocalEnv): Promise<Response> {
	if (!isLocalWranglerRequest(request)) {
		return Response.json({ error: "Not Found" }, { status: 404 });
	}
	if (request.method !== "POST") {
		return new Response(null, { status: 405, headers: { Allow: "POST" } });
	}

	const now = new Date();
	const featureEnabled = env.VIBRIO_CONDITIONS_ENABLED === "true";
	const mode = resolveLocalVibrioQaFixture({
		featureEnabled,
		isLocalDevelopment: true,
		value: env.VIBRIO_QA_FIXTURE,
	});
	const genuinePayload = await buildBeachConditionsPayload({
		vibrioConditionsEnabled: featureEnabled,
		now,
	});
	const payload = mode
		? applyLocalVibrioQaFixture(genuinePayload, mode, now)
		: genuinePayload;
	const { refreshDiagnostics: _refreshDiagnostics, ...publicPayload } = payload;

	await env.BEACH_DATA.put(BEACH_CONDITIONS_CACHE_KEY, JSON.stringify(publicPayload), {
		expirationTtl: 2 * 60 * 60,
	});
	return Response.json({
		outcome: "completed",
		fixture: mode ?? "genuineNOAA",
		generatedAt: payload.generatedAt,
		count: payload.count,
	});
}

export default {
	async fetch(request: Request, env: LocalEnv): Promise<Response> {
		if (new URL(request.url).pathname === "/__local/refresh/beach-conditions") {
			return handleLocalBeachConditionsRefresh(request, env);
		}
		return worker.fetch(request, env);
	},
	async scheduled(controller: ScheduledController, env: LocalEnv): Promise<void> {
		return worker.scheduled(controller, env);
	},
};

export { RefreshCoordinator } from "./services/refresh/coordinator";
export { VerificationCoordinator } from "./verification/coordinator";
