interface ClaimState {
	status: "processing" | "complete";
	leaseUntil: number;
}

const PROCESSING_LEASE_MS = 60_000;

export class IpawsIdempotencyCoordinator {
	constructor(private readonly state: DurableObjectState) {}

	async fetch(request: Request): Promise<Response> {
		const action = new URL(request.url).pathname;
		if (action === "/claim") {
			const now = Date.now();
			const claimed = await this.state.storage.transaction(async (transaction) => {
				const current = await transaction.get<ClaimState>("state");
				if (current?.status === "complete" || (current?.status === "processing" && current.leaseUntil > now)) return false;
				await transaction.put("state", { status: "processing", leaseUntil: now + PROCESSING_LEASE_MS } satisfies ClaimState);
				return true;
			});
			return Response.json({ claimed });
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

export async function claimIpawsDelivery(namespace: DurableObjectNamespace, messageId: string): Promise<boolean> {
	const response = await stub(namespace, messageId).fetch("https://idempotency.internal/claim", { method: "POST" });
	if (!response.ok) throw new Error("ipaws_idempotency_unavailable");
	return (await response.json<{ claimed: boolean }>()).claimed;
}

export async function completeIpawsDelivery(namespace: DurableObjectNamespace, messageId: string): Promise<void> {
	const response = await stub(namespace, messageId).fetch("https://idempotency.internal/complete", { method: "POST" });
	if (!response.ok) throw new Error("ipaws_idempotency_unavailable");
}

export async function releaseIpawsDelivery(namespace: DurableObjectNamespace, messageId: string): Promise<void> {
	await stub(namespace, messageId).fetch("https://idempotency.internal/release", { method: "POST" });
}
