import type { AdminIdentity } from "../services/admin/auth";
import { dispatchRefresh } from "../services/refresh/dispatch";
import type { RefreshJob, RefreshRunResult } from "../services/refresh/types";
import type { Env } from "../types";
import { logInfo } from "../utils/logger";

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

function responseForResult(job: RefreshJob, result: RefreshRunResult): Response {
	switch (result.outcome) {
		case "completed":
			return Response.json({
				status: "ok",
				message: "refresh_completed",
				job,
				generation: result.generation,
				generatedAt: result.generatedAt,
				count: result.count,
			});
		case "duplicate":
			return Response.json({ error: "duplicate_request" }, { status: 409 });
		case "in_progress":
			return Response.json({ error: "refresh_in_progress" }, { status: 409 });
		case "cooldown":
			return Response.json({ error: "refresh_cooldown", retryAt: result.retryAt }, { status: 429 });
		case "fenced":
			return Response.json({ error: "refresh_fenced" }, { status: 409 });
		default:
			return Response.json({ error: "refresh_failed" }, { status: 502 });
	}
}

export async function handleAdminRefreshRequest(
	request: Request,
	env: Env,
	job: RefreshJob,
	identity: AdminIdentity,
): Promise<Response> {
	const idempotencyKey = request.headers.get("Idempotency-Key")?.trim() ?? "";
	if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
		return Response.json({ error: "invalid_idempotency_key" }, { status: 400 });
	}

	logInfo("Admin Refresh", "Accepted authenticated request", { job, authMethod: identity.method });
	return responseForResult(job, await dispatchRefresh(env, {
		job,
		trigger: "admin",
		idempotencyKey,
	}));
}
