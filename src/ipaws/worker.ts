import type { Env } from "../types";
import { handleIpawsPubSubRequest } from "./handler";
import { readIpawsMetrics } from "./metrics";
import { logWarn } from "../utils/logger";
export { IpawsIdempotencyCoordinator } from "./idempotency";

export type IpawsStandaloneEnv = Pick<
	Env,
	| "BEACH_DATA"
	| "IPAWS_INGESTION_ENABLED"
	| "IPAWS_ENVIRONMENT"
	| "IPAWS_ALLOWED_TOPIC_ARNS"
	| "IPAWS_AUTO_CONFIRM_SUBSCRIPTION"
	| "IPAWS_PARSE_BYTE_LIMIT"
	| "IPAWS_RECORD_TTL_SECONDS"
	| "IPAWS_SUBSCRIPTION_TTL_SECONDS"
	| "IPAWS_HEALTH_TTL_SECONDS"
	| "IPAWS_SNS_MAX_AGE_SECONDS"
	| "IPAWS_SNS_MAX_FUTURE_SKEW_SECONDS"
	| "IPAWS_IDEMPOTENCY"
>;

const METRICS_CACHE_KEY = "https://ipaws-metrics.internal/v1/report";
const METRICS_CACHE_SECONDS = 30;

function json(body: unknown, init: ResponseInit = {}): Response {
	return Response.json(body, {
		...init,
		headers: { "Content-Type": "application/json; charset=utf-8", ...init.headers },
	});
}

export default {
	async fetch(request: Request, env: IpawsStandaloneEnv, ctx: ExecutionContext): Promise<Response> {
		const pathname = new URL(request.url).pathname;
		if (pathname === "/v1/ipaws/metrics" && request.method === "GET") {
			if (env.IPAWS_ENVIRONMENT !== "staging") return json({ error: "Not Found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
			const cache = typeof caches === "undefined" ? null : caches.default;
			const cached = await cache?.match(METRICS_CACHE_KEY);
			if (cached) return json(await cached.json(), { headers: { "Cache-Control": "no-store", "X-IPAWS-Metrics-Cache": "hit" } });
			const report = await readIpawsMetrics(env.IPAWS_IDEMPOTENCY);
			if (!report) return json({ status: "error", code: "ipaws_metrics_unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
			if (cache) ctx.waitUntil(cache.put(METRICS_CACHE_KEY, json(report, { headers: { "Cache-Control": `public, max-age=${METRICS_CACHE_SECONDS}` } }))
				.catch(() => logWarn("IPAWS Metrics", "Soak report cache write unavailable")));
			return json(report, { headers: { "Cache-Control": "no-store", "X-IPAWS-Metrics-Cache": "miss" } });
		}
		if (pathname !== "/v1/ipaws/pubsub") {
			return json({ error: "Not Found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
		}
		if (request.method !== "POST") {
			return json({ error: "Method Not Allowed" }, { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } });
		}
		return handleIpawsPubSubRequest(request, env as Env, ctx);
	},
} satisfies ExportedHandler<IpawsStandaloneEnv>;
