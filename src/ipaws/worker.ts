import type { Env } from "../types";
import { handleIpawsPubSubRequest } from "./handler";

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
>;

function json(body: unknown, init: ResponseInit = {}): Response {
	return Response.json(body, {
		...init,
		headers: { "Content-Type": "application/json; charset=utf-8", ...init.headers },
	});
}

export default {
	async fetch(request: Request, env: IpawsStandaloneEnv): Promise<Response> {
		if (new URL(request.url).pathname !== "/v1/ipaws/pubsub") {
			return json({ error: "Not Found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
		}
		if (request.method !== "POST") {
			return json({ error: "Method Not Allowed" }, { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } });
		}
		return handleIpawsPubSubRequest(request, env as Env);
	},
} satisfies ExportedHandler<IpawsStandaloneEnv>;
