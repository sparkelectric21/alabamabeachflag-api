import type { Env } from "../types";
import { runVerification } from "./run";

export class VerificationCoordinator {
	constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {}

	async fetch(request: Request): Promise<Response> {
		const { slot, now } = await request.json<{ slot: string; now: string }>();
		const claimed = await this.ctx.storage.get<string>("slot");
		if (claimed === slot) return Response.json({ outcome: "duplicate", slot }, { status: 409 });
		await this.ctx.storage.put("slot", slot);
		try {
			return Response.json({ outcome: "completed", report: await runVerification(this.env, new Date(now)) });
		} catch {
			await this.ctx.storage.delete("slot");
			return Response.json({ outcome: "failed", slot }, { status: 500 });
		}
	}
}
