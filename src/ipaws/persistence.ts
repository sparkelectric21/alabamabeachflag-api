import type { Env } from "../types";
import type { IpawsCapParseResult, IpawsHealthState, IpawsIngressReceipt, IpawsIngestionRecord, IpawsProcessingState, IpawsSnsMessage } from "./types";

const INTAKE_KEY_PREFIX = "ipaws:ingest:";
const HEALTH_KEY = "ipaws:health:v1";
const SUBSCRIPTION_STATE_KEY = "ipaws:subscription:state";

const HEALTH_TTL_SECONDS = 7 * 24 * 60 * 60;

function toKey(messageId: string): string {
	return `${INTAKE_KEY_PREFIX}${messageId}`;
}
function safeParse<T>(value: string | null): T | null {
	if (!value) return null;
	try {
		return JSON.parse(value) as T;
	} catch {
		return null;
	}
}

export async function readIngestionRecord(env: Pick<Env, "BEACH_DATA">, messageId: string): Promise<IpawsIngestionRecord | null> {
	return safeParse(await env.BEACH_DATA.get(toKey(messageId), "text"));
}

export async function writeIngestionRecord(
	env: Pick<Env, "BEACH_DATA">,
	record: IpawsIngestionRecord,
	ttlSeconds: number,
): Promise<void> {
	await env.BEACH_DATA.put(toKey(record.messageId), JSON.stringify(record), { expirationTtl: ttlSeconds });
}

export async function upsertIngestionRecord(
	env: Pick<Env, "BEACH_DATA">,
	message: IpawsSnsMessage,
	initialState: IpawsProcessingState,
	rawMessage: string,
	signatureResult: "success" | "failure" | "not_attempted",
	parseResult: IpawsCapParseResult,
	messageTopicArn: string,
	recordTtlSeconds: number,
): Promise<IpawsIngressReceipt> {
	const existing = await readIngestionRecord(env, message.MessageId);
	if (existing) return { duplicate: true, record: existing };

	const now = new Date().toISOString();
	const record: IpawsIngestionRecord = {
		id: crypto.randomUUID(),
		messageId: message.MessageId,
		type: message.Type,
		topicArn: messageTopicArn,
		messageTimestamp: message.Timestamp,
		receivedAt: now,
		subscriptionArn: null,
		processingState: initialState,
		signatureVersion: message.SignatureVersion,
		signatureResult,
		parseStatus: parseResult.status,
		rawMessage,
		messageBody: parseResult.message ?? null,
		parseError: parseResult.status === "parse_failed" ? (parseResult.reason ?? "parse_failed") : null,
		parseResultSummary: parseResult.status,
		subscribeUrl: message.Type === "Notification" ? null : message.SubscribeURL ?? null,
		capIdentifier: parseResult.message?.parsed.identifier ?? null,
		capReferences: parseResult.message?.parsed.references ?? null,
		parseWarnings: parseResult.message?.parsed.parseWarnings ?? [],
		updatedAt: now,
	};

	await writeIngestionRecord(env, record, recordTtlSeconds);
	return { duplicate: false, record };
}

export async function updateIngestionRecord(
	env: Pick<Env, "BEACH_DATA">,
	messageId: string,
	changes: Partial<IpawsIngestionRecord>,
	recordTtlSeconds: number,
): Promise<IpawsIngestionRecord> {
	const existing = await readIngestionRecord(env, messageId);
	if (!existing) {
		throw new Error("ipaws_missing_record");
	}
	const updated = { ...existing, ...changes, updatedAt: new Date().toISOString() };
	await writeIngestionRecord(env, updated, recordTtlSeconds);
	return updated;
}

export async function readHealthState(env: Pick<Env, "BEACH_DATA">): Promise<IpawsHealthState | null> {
	const raw = await env.BEACH_DATA.get(HEALTH_KEY);
	return safeParse(raw) as IpawsHealthState | null;
}

export async function writeHealthState(
	env: Pick<Env, "BEACH_DATA">,
	state: IpawsHealthState,
	healthTtlSeconds = HEALTH_TTL_SECONDS,
): Promise<void> {
	await env.BEACH_DATA.put(HEALTH_KEY, JSON.stringify(state), { expirationTtl: healthTtlSeconds });
}

export async function readSubscriptionState(env: Pick<Env, "BEACH_DATA">): Promise<string | null> {
	return env.BEACH_DATA.get(SUBSCRIPTION_STATE_KEY);
}

export async function writeSubscriptionState(
	env: Pick<Env, "BEACH_DATA">,
	state: string,
	ttlSeconds: number,
): Promise<void> {
	await env.BEACH_DATA.put(SUBSCRIPTION_STATE_KEY, state, { expirationTtl: ttlSeconds });
}
