import type { Env } from "../types";
import { consoleProviderAlertTransport, formatProviderAlertEmail, type ProviderAlertTransport } from "./delivery";
import { evaluateProviderHealth, evaluateQualityGateRejection } from "./state";
import type { ProviderAlertEvent, ProviderHealthObservation, ProviderHealthOptions, ProviderHealthState } from "./types";

export const PROVIDER_HEALTH_STATE_PREFIX = "provider-health:v1:state:";
export const PROVIDER_HEALTH_EVENT_PREFIX = "provider-health:v1:event:";
export const PROVIDER_HEALTH_STATES_KEY = "provider-health:v1:states";
export const PROVIDER_HEALTH_RETENTION_SECONDS = 90 * 24 * 60 * 60;

export interface ProviderHealthStore {
	get<T>(key: string, type: "json"): Promise<T | null>;
	put(key: string, value: string, options?: KVNamespacePutOptions): Promise<void>;
}

interface ProviderHealthStateIndex {
	version: 1;
	updatedAt: string;
	states: ProviderHealthState[];
}

function key(provider: string, domain: string): string {
	return `${PROVIDER_HEALTH_STATE_PREFIX}${encodeURIComponent(provider)}:${encodeURIComponent(domain)}`;
}

function safeState(value: unknown, provider: string, domain: string): ProviderHealthState | undefined {
	if (!value || typeof value !== "object") return undefined;
	const state = value as Partial<ProviderHealthState>;
	if (state.provider !== provider || state.domain !== domain || typeof state.updatedAt !== "string") return undefined;
	return state as ProviderHealthState;
}

async function persist(store: ProviderHealthStore, state: ProviderHealthState, alertEvent?: ProviderAlertEvent): Promise<void> {
	await store.put(key(state.provider, state.domain), JSON.stringify(state));
	if (alertEvent) await store.put(`${PROVIDER_HEALTH_EVENT_PREFIX}${encodeURIComponent(alertEvent.id)}`, JSON.stringify(alertEvent), { expirationTtl: PROVIDER_HEALTH_RETENTION_SECONDS });
}

export async function processProviderHealthObservations(
	env: Pick<Env, "BEACH_DATA">,
	observations: ProviderHealthObservation[],
	now: string,
	transport: ProviderAlertTransport = consoleProviderAlertTransport,
	options: ProviderHealthOptions = {},
): Promise<ProviderAlertEvent[]> {
	const events: ProviderAlertEvent[] = [];
	const priorIndex = await env.BEACH_DATA.get<unknown>(PROVIDER_HEALTH_STATES_KEY, "json");
	const indexedStates = new Map<string, ProviderHealthState>();
	if (priorIndex && typeof priorIndex === "object" && Array.isArray((priorIndex as Partial<ProviderHealthStateIndex>).states)) {
		for (const state of (priorIndex as ProviderHealthStateIndex).states) {
			if (state && typeof state.provider === "string" && typeof state.domain === "string") indexedStates.set(key(state.provider, state.domain), state);
		}
	}
	for (const observation of observations) {
		const stateKey = key(observation.provider, observation.domain);
		const stored = safeState(await env.BEACH_DATA.get<unknown>(stateKey, "json"), observation.provider, observation.domain);
		const decision = evaluateProviderHealth(stored, observation, now, options);
		await persist(env.BEACH_DATA, decision.state, decision.event);
		indexedStates.set(stateKey, decision.state);
		if (decision.event) {
			events.push(decision.event);
			await transport.send(decision.event, formatProviderAlertEmail(decision.event));
		}
	}
	if (observations.length > 0) await env.BEACH_DATA.put(PROVIDER_HEALTH_STATES_KEY, JSON.stringify({ version: 1, updatedAt: now, states: [...indexedStates.values()] }));
	return events;
}

export async function processQualityGateRejection(
	env: Pick<Env, "BEACH_DATA">,
	now: string,
	reason: string,
	expectedBeachCount: number,
	affectedBeachCount: number,
	transport: ProviderAlertTransport = consoleProviderAlertTransport,
): Promise<ProviderAlertEvent | undefined> {
	const provider = "publication_quality_gate";
	const domain = "beach_conditions";
	const stateKey = key(provider, domain);
	const stored = safeState(await env.BEACH_DATA.get<unknown>(stateKey, "json"), provider, domain);
	const decision = evaluateQualityGateRejection(stored, now, reason, expectedBeachCount, affectedBeachCount);
	await persist(env.BEACH_DATA, decision.state, decision.event);
	if (decision.event) await transport.send(decision.event, formatProviderAlertEmail(decision.event));
	return decision.event;
}
