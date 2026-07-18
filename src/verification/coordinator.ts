import type { Env } from "../types";
import { processAlertObservation, observationFromReport } from "../alerting/process";
import { dueVerificationSlot, reportKeyForSlot } from "../alerting/schedule";
import { runVerification } from "./run";

export class VerificationCoordinator {
	constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {}

	async fetch(request: Request): Promise<Response> {
		const payload = await request.json<{ action?: "run" | "monitor"; slot?: string; now: string }>();
		if (payload.action === "monitor") return this.monitor(new Date(payload.now));
		const { slot, now } = payload;
		if (!slot) return Response.json({ error: "missing_slot" }, { status: 400 });
		const claimed = await this.ctx.storage.get<string>("slot");
		if (claimed === slot) return Response.json({ outcome: "duplicate", slot }, { status: 409 });
		await this.ctx.storage.put("slot", slot);
		let report;
		try {
			report = await runVerification(this.env, new Date(now));
		} catch {
			await this.ctx.storage.delete("slot");
			return Response.json({ outcome: "failed", slot }, { status: 500 });
		}
		try {
			await processAlertObservation(this.ctx.storage, this.env, observationFromReport(report));
		} catch {
			console.error("[Verification alerts] state processing failed");
		}
		return Response.json({ outcome: "completed", report });
	}

	private async monitor(now: Date): Promise<Response> {
		const slot = dueVerificationSlot(now);
		if (!slot) return Response.json({ outcome: "grace", slot: null });
		const report = await this.env.BEACH_DATA.get(reportKeyForSlot(slot), "json");
		if (report) return Response.json({ outcome: "present", slot });
		try {
			await processAlertObservation(this.ctx.storage, this.env, {
				slot,
				reportTime: now.toISOString(),
				status: "fail",
				affected: [{ name: "scheduled_report", status: "fail", detail: `missing report for ${slot}` }],
			});
		} catch {
			console.error("[Verification alerts] missing-report state processing failed");
		}
		return Response.json({ outcome: "missing", slot });
	}
}
