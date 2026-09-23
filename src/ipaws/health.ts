import type { Env } from "../types";
import type { IpawsHealthState } from "./types";
import { readHealthState, writeHealthState } from "./persistence";
import { readSubscriptionState } from "./persistence";

function appendOutcome(state: IpawsHealthState, event: string): IpawsHealthState {
	const outcomes = [...state.recentOutcomes, event];
	return { ...state, recentOutcomes: outcomes.slice(-8) };
}

export async function readIpawsHealthSnapshot(env: Pick<Env, "BEACH_DATA">): Promise<IpawsHealthState> {
	const now = new Date().toISOString();
	const existing = await readHealthState(env);
	const subscriptionState = await readSubscriptionState(env);
	const base: IpawsHealthState = {
		environment: "staging",
		stagingEnabled: false,
		subscriptionState: subscriptionState === "confirmed" ? "confirmed" : subscriptionState === "skipped" ? "skipped" : subscriptionState === "received" ? "received" : "unknown",
		recentOutcomes: [],
		updatedAt: now,
	};
	if (!existing) return base;
	return {
		...base,
		environment: existing.environment,
		stagingEnabled: existing.stagingEnabled,
		lastReceiptAt: existing.lastReceiptAt,
		lastSignatureFailureAt: existing.lastSignatureFailureAt,
		lastValidDeliveryAt: existing.lastValidDeliveryAt,
		lastPayloadAt: existing.lastPayloadAt,
		lastParseFailureAt: existing.lastParseFailureAt,
		subscriptionState: existing.subscriptionState,
		recentOutcomes: existing.recentOutcomes.slice(-8),
		updatedAt: now,
	};
}

export async function recordIpawsHealthEvent(
	env: Pick<Env, "BEACH_DATA">,
	event: string,
	healthTtlSeconds: number,
	payload: { environment?: "staging" | "production"; stagingEnabled?: boolean } = {},
): Promise<IpawsHealthState> {
	const previous = await readIpawsHealthSnapshot(env);
	const next = appendOutcome({
		...previous,
		environment: payload.environment ?? previous.environment,
		stagingEnabled: payload.stagingEnabled ?? previous.stagingEnabled,
		updatedAt: new Date().toISOString(),
	}, event);
	await writeHealthState(env, next, healthTtlSeconds);
	return next;
}
