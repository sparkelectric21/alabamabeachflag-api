import type { Env } from "../types";
import type { IpawsIngestionRecord, IpawsRawCapPayload } from "./types";

export interface IpawsNormalizedAlert {
	schemaVersion: 1;
	source: "fema-ipaws";
	environment: "staging";
	messageId: string;
	topicArn: string;
	identifier: string;
	sentAt: string | null;
	event: string | null;
	severity: string | null;
	urgency: string | null;
	certainty: string | null;
	expiresAt: string | null;
	areaDescription: string | null;
	handoffState: "staged";
	notificationsEnabled: false;
	normalizedAt: string;
}

function firstInfo(payload: IpawsRawCapPayload) {
	return payload.parsed.info?.[0];
}

export function normalizeIpawsAlert(record: IpawsIngestionRecord): IpawsNormalizedAlert {
	if (!record.messageBody || !record.capIdentifier) throw new Error("ipaws_alert_not_normalizable");
	const parsed = record.messageBody.parsed;
	const info = firstInfo(record.messageBody);
	return {
		schemaVersion: 1,
		source: "fema-ipaws",
		environment: "staging",
		messageId: record.messageId,
		topicArn: record.topicArn,
		identifier: record.capIdentifier,
		sentAt: parsed.sent ?? null,
		event: info?.event ?? parsed.event ?? null,
		severity: info?.severity ?? parsed.severity ?? null,
		urgency: info?.urgency ?? parsed.urgency ?? null,
		certainty: info?.certainty ?? parsed.certainty ?? null,
		expiresAt: info?.expires ?? parsed.expires ?? null,
		areaDescription: info?.area?.description ?? parsed.area?.description ?? null,
		handoffState: "staged",
		notificationsEnabled: false,
		normalizedAt: new Date().toISOString(),
	};
}

export async function stageNormalizedAlert(env: Pick<Env, "BEACH_DATA">, record: IpawsIngestionRecord, ttlSeconds: number): Promise<IpawsNormalizedAlert> {
	const alert = normalizeIpawsAlert(record);
	await env.BEACH_DATA.put(`ipaws:normalized:${record.messageId}`, JSON.stringify(alert), { expirationTtl: ttlSeconds });
	return alert;
}
