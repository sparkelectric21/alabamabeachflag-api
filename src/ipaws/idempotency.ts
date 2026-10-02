import { applyMetricsEvent, buildSoakReport, hourKey, IPAWS_CORRELATION_MAX_MARKERS, IPAWS_CORRELATION_ROTATION_MS, IPAWS_CORRELATION_TTL_MS, isIpawsMetricsEvent, newMetricsBucket, retainedMetricHours, validMetricsWindow, type IpawsCorrelationAction, type IpawsMetricsBucket } from "./metrics";

type ClaimState =
	| { status: "processing"; leaseUntil: number; token: string }
	| { status: "complete"; leaseUntil: 0 };

export type IpawsClaimResult =
	| { result: "acquired"; token: string; recovered?: true }
	| { result: "processing" | "complete" };

const PROCESSING_LEASE_MS = 60_000;
interface CorrelationKey { createdAt: number; key: string }
interface CorrelationMarker { digest: string; expiresAt: number }

function validCorrelation(value: unknown): value is { action: IpawsCorrelationAction; messageId: string } {
	if (!value || typeof value !== "object") return false;
	const item = value as Record<string, unknown>;
	return (item.action === "preclaim_failure" || item.action === "accepted") && typeof item.messageId === "string" && item.messageId.length > 0 && item.messageId.length <= 256;
}

async function hmac(key: string, value: string): Promise<string> {
	const imported = await crypto.subtle.importKey("raw", Uint8Array.from(atob(key), (char) => char.charCodeAt(0)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const digest = await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function newCorrelationKey(now: number): CorrelationKey {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return { createdAt: now, key: btoa(String.fromCharCode(...bytes)) };
}

function tokenFromRequest(request: Request): Promise<{ token?: unknown }> {
	return request.json<{ token?: unknown }>().catch(() => ({}));
}

export class IpawsIdempotencyCoordinator {
	constructor(private readonly state: DurableObjectState) {}

	async fetch(request: Request): Promise<Response> {
		const action = new URL(request.url).pathname;
		if (action === "/metrics/record") {
			const body = await request.json<Record<string, unknown>>().catch(() => null);
			const event: unknown = body?.event;
			if (!isIpawsMetricsEvent(event)) return new Response("Invalid metrics event", { status: 400 });
			if (body?.correlation !== undefined && !validCorrelation(body.correlation)) return new Response("Invalid correlation event", { status: 400 });
			const correlation = validCorrelation(body?.correlation) ? body.correlation : undefined;
			const now = Date.now();
			const hour = hourKey(now);
			await this.state.storage.transaction(async (transaction) => {
				const hours = await transaction.get<string[]>("metrics:hours") ?? [];
				const bucket = await transaction.get<IpawsMetricsBucket>(`metrics:hour:${hour}`) ?? newMetricsBucket(hour);
				applyMetricsEvent(bucket, event, now);
				const retained = retainedMetricHours([...hours, hour], now);
				const expired = hours.filter((value) => !retained.includes(value));
				const writes: Record<string, unknown> = { "metrics:hours": retained, [`metrics:hour:${hour}`]: bucket };
				if (correlation) {
					let keys = (await transaction.get<CorrelationKey[]>("metrics:correlation:keys") ?? []).filter((key) => now - key.createdAt < IPAWS_CORRELATION_TTL_MS + IPAWS_CORRELATION_ROTATION_MS);
					if (!keys.length || now - keys.at(-1)!.createdAt >= IPAWS_CORRELATION_ROTATION_MS) keys.push(newCorrelationKey(now));
					keys = keys.slice(-3);
					let markers = (await transaction.get<CorrelationMarker[]>("metrics:correlation:markers") ?? []).filter((marker) => marker.expiresAt > now);
					if (correlation.action === "preclaim_failure") markers.push({ digest: await hmac(keys.at(-1)!.key, correlation.messageId), expiresAt: now + IPAWS_CORRELATION_TTL_MS });
					else {
						const digests = new Set(await Promise.all(keys.map((key) => hmac(key.key, correlation.messageId))));
						const before = markers.length; markers = markers.filter((marker) => !digests.has(marker.digest));
						if (markers.length < before) { const counters = bucket.counters.retryResolution as Record<string, number>; counters.resolved_after_preclaim_failure = (counters.resolved_after_preclaim_failure ?? 0) + 1; }
					}
					writes["metrics:correlation:keys"] = keys; writes["metrics:correlation:markers"] = markers.sort((a, b) => a.expiresAt - b.expiresAt).slice(-IPAWS_CORRELATION_MAX_MARKERS);
				}
				await transaction.put(writes);
				if (expired.length) await transaction.delete(expired.map((value) => `metrics:hour:${value}`));
			});
			return new Response(null, { status: 204 });
		}
		if (action === "/metrics/report") {
			const url = new URL(request.url); const start = url.searchParams.get("start") ?? ""; const end = url.searchParams.get("end") ?? "";
			if ([...url.searchParams.keys()].some((key) => key !== "start" && key !== "end")
				|| url.searchParams.getAll("start").length !== 1
				|| url.searchParams.getAll("end").length !== 1
				|| !validMetricsWindow(start, end, Date.now())) return new Response("Invalid metrics window", { status: 400 });
			const hours = retainedMetricHours(await this.state.storage.get<string[]>("metrics:hours") ?? [], Date.now()).filter((hour) => hour >= start && hour < end);
			const values = hours.length ? await this.state.storage.get<IpawsMetricsBucket>(hours.map((hour) => `metrics:hour:${hour}`)) : new Map();
			return Response.json(buildSoakReport(hours.flatMap((hour) => {
				const bucket = values.get(`metrics:hour:${hour}`);
				return bucket ? [bucket] : [];
			}), start, end));
		}
		if (action === "/claim" || action === "/recover") {
			const now = Date.now();
			const token = crypto.randomUUID();
			const result = await this.state.storage.transaction(async (transaction): Promise<IpawsClaimResult> => {
				const current = await transaction.get<ClaimState>("state");
				if (action === "/claim" && current?.status === "complete") return { result: "complete" };
				if (current?.status === "processing" && current.leaseUntil > now) return { result: "processing" };
				await transaction.put("state", { status: "processing", leaseUntil: now + PROCESSING_LEASE_MS, token } satisfies ClaimState);
				return { result: "acquired", token, ...(current ? { recovered: true as const } : {}) };
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
	if (value.result === "acquired" && typeof value.token === "string" && value.token.length > 0) {
		return { result: "acquired", token: value.token, ...(value.recovered === true || path === "/recover" ? { recovered: true as const } : {}) };
	}
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
