import type { Env } from "../../types";
import type { RefreshJob, RefreshRunRequest, RefreshRunResult } from "./types";

export async function dispatchRefresh(
	env: Env,
	request: RefreshRunRequest,
): Promise<RefreshRunResult> {
	const id = env.REFRESH_COORDINATOR.idFromName(request.job);
	const stub = env.REFRESH_COORDINATOR.get(id);
	const response = await stub.fetch("https://refresh-coordinator/run", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(request),
	});
	return await response.json<RefreshRunResult>();
}

export function scheduledIdempotencyKey(job: RefreshJob, scheduledTime: number): string {
	return `scheduled:${job}:${scheduledTime}`;
}
