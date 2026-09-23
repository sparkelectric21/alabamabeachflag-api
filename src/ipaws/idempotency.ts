interface ClaimState {
	status: "processing" | "complete";
	leaseUntil: number;
}

export type IpawsClaimResult = "acquired" | "processing" | "complete";

const PROCESSING_LEASE_MS = 60_000;

export class IpawsIdempotencyCoordinator {
	constructor(private readonly state: DurableObjectState) {}

	async fetch(request: Request): Promise<Response> {
		const action = new URL(request.url).pathname;
		if (action === "/claim") {
			const now = Date.now();
			const result = await this.state.storage.transaction(async (transaction): Promise<IpawsClaimResult> => {
				const current = await transaction.get<ClaimState>("state");
				if (current?.status === "complete") return "complete";
				if (current?.status === "processing" && current.leaseUntil > now) return "processing";
				await transaction.put("state", { status: "processing", leaseUntil: now + PROCESSING_LEASE_MS } satisfies ClaimState);
				return "acquired";
			});
			return Response.json({ result });
		}
		if (action === "/recover") {
			const now = Date.now();
			const result = await this.state.storage.transaction(async (transaction): Promise<IpawsClaimResult> => {
				const current = await transaction.get<ClaimState>("state");
				if (current?.status === "processing" && current.leaseUntil > now) return "processing";
				await transaction.put("state", { status: "processing", leaseUntil: now + PROCESSING_LEASE_MS } satisfies ClaimState);
				return "acquired";
			});
			return Response.json({ result });
		}
		if (action === "/complete") {
			await this.state.storage.put("state", { status: "complete", leaseUntil: 0 } satisfies ClaimState);
			return new Response(null, { status: 204 });
		}
		if (action === "/release") {
			await this.state.storage.delete("state");
			return new Response(null, { status: 204 });
		}
		return new Response("Not Found", { status: 404 });
	}
}

function stub(namespace: DurableObjectNamespace, messageId: string): DurableObjectStub {
	return namespace.get(namespace.idFromName(messageId));
}

async function claim(namespace: DurableObjectNamespace, messageId: string, path: "/claim" | "/recover"): Promise<IpawsClaimResult> {
	const response = await stub(namespace, messageId).fetch(`https://idempotency.internal${path}`, { method: "POST" });
	if (!response.ok) throw new Error("ipaws_idempotency_unavailable");
	const result = (await response.json<{ result: IpawsClaimResult }>()).result;
	if (!(["acquired", "processing", "complete"] as const).includes(result)) throw new Error("ipaws_idempotency_unavailable");
	return result;
}

export function claimIpawsDelivery(namespace: DurableObjectNamespace, messageId: string): Promise<IpawsClaimResult> {
	return claim(namespace, messageId, "/claim");
}

export function recoverIpawsDelivery(namespace: DurableObjectNamespace, messageId: string): Promise<IpawsClaimResult> {
	return claim(namespace, messageId, "/recover");
}

export async function completeIpawsDelivery(namespace: DurableObjectNamespace, messageId: string): Promise<void> {
	const response = await stub(namespace, messageId).fetch("https://idempotency.internal/complete", { method: "POST" });
	if (!response.ok) throw new Error("ipaws_idempotency_unavailable");
}

export async function releaseIpawsDelivery(namespace: DurableObjectNamespace, messageId: string): Promise<void> {
	const response = await stub(namespace, messageId).fetch("https://idempotency.internal/release", { method: "POST" });
	if (!response.ok) throw new Error("ipaws_idempotency_unavailable");
}
