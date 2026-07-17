import type { Env } from "../types";
import { verificationSlot } from "../verification/run";

export async function handleLatestVerification(env: Env): Promise<Response> {
	const report = await env.BEACH_DATA.get("verification:latest", "json");
	return report
		? Response.json(report, { headers: { "Cache-Control": "no-store" } })
		: Response.json({ error: "verification_report_unavailable" }, { status: 404 });
}

export async function dispatchVerification(env: Env, now = new Date()): Promise<Response> {
	const slot = verificationSlot(now);
	const id = env.VERIFICATION_COORDINATOR.idFromName("gulf-shores");
	return env.VERIFICATION_COORDINATOR.get(id).fetch("https://verification.internal/run", {
		method: "POST",
		body: JSON.stringify({ slot, now: now.toISOString() }),
	});
}
