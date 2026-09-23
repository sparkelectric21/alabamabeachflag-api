import type { Env } from "../types";
import type { IpawsIngestionConfig } from "./types";

const DEFAULT_PARSE_LIMIT_BYTES = 256 * 1024;
const DEFAULT_RECORD_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_SUBSCRIPTION_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_HEALTH_TTL_SECONDS = 7 * 24 * 60 * 60;

function envBoolean(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined) return fallback;
	return ["1", "true", "yes", "y", "on"].includes(value.trim().toLowerCase());
}
function parseNumber(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseTopicArns(value: string | undefined): string[] {
	if (!value) return [];
	return value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

export function loadIpawsConfig(env: Pick<Env, "IPAWS_INGESTION_ENABLED" | "IPAWS_ENVIRONMENT" | "IPAWS_ALLOWED_TOPIC_ARNS" | "IPAWS_AUTO_CONFIRM_SUBSCRIPTION" | "IPAWS_PARSE_BYTE_LIMIT" | "IPAWS_RECORD_TTL_SECONDS" | "IPAWS_SUBSCRIPTION_TTL_SECONDS" | "IPAWS_HEALTH_TTL_SECONDS">
): IpawsIngestionConfig {
	return {
		enabled: envBoolean(env.IPAWS_INGESTION_ENABLED, false),
		environment: env.IPAWS_ENVIRONMENT === "production" ? "production" : "staging",
		allowedTopicArns: parseTopicArns(env.IPAWS_ALLOWED_TOPIC_ARNS),
		autoConfirmSubscription: envBoolean(env.IPAWS_AUTO_CONFIRM_SUBSCRIPTION, false),
		parseByteLimit: parseNumber(env.IPAWS_PARSE_BYTE_LIMIT, DEFAULT_PARSE_LIMIT_BYTES),
		recordTtlSeconds: parseNumber(env.IPAWS_RECORD_TTL_SECONDS, DEFAULT_RECORD_TTL_SECONDS),
		subscriptionStateTtlSeconds: parseNumber(env.IPAWS_SUBSCRIPTION_TTL_SECONDS, DEFAULT_SUBSCRIPTION_TTL_SECONDS),
		healthTtlSeconds: parseNumber(env.IPAWS_HEALTH_TTL_SECONDS, DEFAULT_HEALTH_TTL_SECONDS),
	};
}
