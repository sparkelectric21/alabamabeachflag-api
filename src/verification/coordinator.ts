import type { Env } from "../types";
import { processAlertObservation, observationFromReport } from "../alerting/process";
import { dueVerificationSlot, reportKeyForSlot } from "../alerting/schedule";
import { runVerification } from "./run";
import { runRipCurrentOutlookVerification } from "./ripCurrentOutlook";
import { runOrangeBeachVerification } from "./orangeBeach";
import { VERIFIERS } from "./registry";

export interface VerificationCoordinatorDependencies {
	runGulfShores: typeof runVerification;
	runOrangeBeach?: typeof runOrangeBeachVerification;
	processGulfShoresAlert: typeof processAlertObservation;
	runRipCurrent: typeof runRipCurrentOutlookVerification;
}

const productionDependencies: VerificationCoordinatorDependencies = {
	runGulfShores: runVerification,
	runOrangeBeach: runOrangeBeachVerification,
	processGulfShoresAlert: processAlertObservation,
	runRipCurrent: runRipCurrentOutlookVerification,
};

export async function runVerificationSequence(
	storage: DurableObjectStorage,
	env: Env,
	now: Date,
	dependencies: VerificationCoordinatorDependencies = productionDependencies,
) {
	const runs = [dependencies.runGulfShores(env, now), ...(dependencies.runOrangeBeach ? [dependencies.runOrangeBeach(env, now)] : [])];
	const results = await Promise.allSettled(runs);
	for (const result of results) if (result.status === "fulfilled") try {
		await dependencies.processGulfShoresAlert(storage, env, observationFromReport(result.value), undefined, `alert-state:${result.value.verifierId}`);
	} catch { console.error("[Verification alerts] state processing failed"); }
	try {
		await dependencies.runRipCurrent(env, now);
	} catch {
		console.error("[Verification] rip current outlook verification failed");
	}
	return results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
}

export class VerificationCoordinator {
	constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {}

	async fetch(request: Request): Promise<Response> {
		const payload = await request.json<{ action?: "run" | "monitor" | "state"; slot?: string; now: string }>();
		if (payload.action === "state") {
			const entries = await Promise.all(VERIFIERS.map(async (verifier) => ({
				verifierId: verifier.id,
				state: await this.ctx.storage.get(`alert-state:${verifier.id}`) ?? null,
				delivery: await this.ctx.storage.get(`alert-state:${verifier.id}:delivery`) ?? null,
			})));
			return Response.json({ entries });
		}
		if (payload.action === "monitor") return this.monitor(new Date(payload.now));
		const { slot, now } = payload;
		if (!slot) return Response.json({ error: "missing_slot" }, { status: 400 });
		const claimed = await this.ctx.storage.get<string>("slot");
		if (claimed === slot) return Response.json({ outcome: "duplicate", slot }, { status: 409 });
		await this.ctx.storage.put("slot", slot);
		let report;
		try {
			report = await runVerificationSequence(this.ctx.storage, this.env, new Date(now));
		} catch {
			await this.ctx.storage.delete("slot");
			return Response.json({ outcome: "failed", slot }, { status: 500 });
		}
		return Response.json({ outcome: "completed", report });
	}

	private async monitor(now: Date): Promise<Response> {
		const slot = dueVerificationSlot(now);
		if (!slot) return Response.json({ outcome: "grace", slot: null });
		const missing: string[] = [];
		for (const verifier of VERIFIERS) {
			const report = await this.env.BEACH_DATA.get(reportKeyForSlot(slot, verifier.id), "json")
				?? (verifier.id === "gulf-shores-flags" ? await this.env.BEACH_DATA.get(reportKeyForSlot(slot), "json") : null);
			if (report) continue;
			missing.push(verifier.id);
			try { await processAlertObservation(this.ctx.storage, this.env, {
				slot,
				reportTime: now.toISOString(),
				status: "fail",
				affected: [{
					name: "scheduled_report",
					status: "fail",
					detail: `missing report for ${slot}`,
					provider: `${verifier.displayName} scheduler`,
					expectedValue: `stored report for ${slot}`,
					actualValue: "missing",
				}],
			}, undefined, `alert-state:${verifier.id}`); } catch { console.error("[Verification alerts] missing-report state processing failed"); }
		}
		return Response.json({ outcome: missing.length ? "missing" : "present", slot, missing });
	}
}
