type ClaimState =
	| { status: "processing"; leaseUntil: number; token: string }
	| { status: "complete"; leaseUntil: 0 };

export type IpawsClaimResult =
	| { result: "acquired"; token: string }
	| { result: "processing" | "complete" };

const PROCESSING_LEASE_MS = 60_000;

function tokenFromRequest(request: Request): Promise<{ token?: unknown }> {
	return request.json<{ token?: unknown }>().catch(() => ({}));
}

export class IpawsIdempotencyCoordinator {
	constructor(private readonly state: DurableObjectState) {}

	async fetch(request: Request): Promise<Response> {
		const action = new URL(request.url).pathname;
		if (action === "/claim" || action === "/recover") {
			const now = Date.now();
			const token = crypto.randomUUID();
			const result = await this.state.storage.transaction(async (transaction): Promise<IpawsClaimResult> => {
				const current = await transaction.get<ClaimState>("state");
				if (action === "/claim" && current?.status === "complete") return { result: "complete" };
				if (current?.status === "processing" && current.leaseUntil > now) return { result: "processing" };
				await transaction.put("state", { status: "processing", leaseUntil: now + PROCESSING_LEASE_MS, token } satisfies ClaimState);
				return { result: "acquired", token };
			});
			return Response.json(result);
		}

		if (action === "/renew" || action === "/complete" || action === "/release") {
			const body = await tokenFromRequest(request);
			if (typeof body.token !== "string" || body.token.length === 0) return Response.json({ result: "stale" }, { status: 409 });
			const now = Date.now();
			const mutated = await this.state.storage.transaction(async (transaction): Promise<boolean> => {
				const current = await transaction.get<ClaimState>("state");
				if (current?.status !== "processing" || current.token !== body.token || current.leaseUntil <= now) return false;
				if (action === "/renew") {
					await transaction.put("state", { ...current, leaseUntil: now + PROCESSING_LEASE_MS } satisfies ClaimState);
				} else if (action === "/complete") {
					await transaction.put("state", { status: "complete", leaseUntil: 0 } satisfies ClaimState);
				} else {
					await transaction.delete("state");
				}
				return true;
			});
			return mutated ? Response.json({ result: "ok" }) : Response.json({ result: "stale" }, { status: 409 });
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
	const value = await response.json<Record<string, unknown>>();
	if (value.result === "acquired" && typeof value.token === "string" && value.token.length > 0) return { result: "acquired", token: value.token };
	if (value.result === "processing" || value.result === "complete") return { result: value.result };
	throw new Error("ipaws_idempotency_unavailable");
}

async function mutate(namespace: DurableObjectNamespace, messageId: string, path: "/renew" | "/complete" | "/release", token: string): Promise<boolean> {
	const response = await stub(namespace, messageId).fetch(`https://idempotency.internal${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ token }),
	});
	if (response.status === 409) return false;
	if (!response.ok) throw new Error("ipaws_idempotency_unavailable");
	return true;
}

export function claimIpawsDelivery(namespace: DurableObjectNamespace, messageId: string): Promise<IpawsClaimResult> {
	return claim(namespace, messageId, "/claim");
}

export function recoverIpawsDelivery(namespace: DurableObjectNamespace, messageId: string): Promise<IpawsClaimResult> {
	return claim(namespace, messageId, "/recover");
}

export function renewIpawsDelivery(namespace: DurableObjectNamespace, messageId: string, token: string): Promise<boolean> {
	return mutate(namespace, messageId, "/renew", token);
}

export function completeIpawsDelivery(namespace: DurableObjectNamespace, messageId: string, token: string): Promise<boolean> {
	return mutate(namespace, messageId, "/complete", token);
}

export function releaseIpawsDelivery(namespace: DurableObjectNamespace, messageId: string, token: string): Promise<boolean> {
	return mutate(namespace, messageId, "/release", token);
}
