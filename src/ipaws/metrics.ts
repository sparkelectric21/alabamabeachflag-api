import type { IpawsCapParseResult, IpawsSnsType } from "./types";
import { logWarn } from "../utils/logger";

export const IPAWS_METRICS_OBJECT_NAME = "__ipaws_staging_metrics_v1__";
export const IPAWS_METRICS_RETENTION_DAYS = 35;
const DAY_MS = 24 * 60 * 60 * 1_000;

const COUNTER_DIMENSIONS = {
	request: ["received"],
	httpStatus: ["2xx", "4xx", "5xx"],
	handlerOutcome: [
		"accepted", "duplicate", "delivery_in_progress", "subscription_confirmed", "subscription_skipped",
		"unsubscribe_recorded", "disabled", "misconfigured", "invalid_request", "security_rejection",
		"processing_failure", "unexpected_exception",
	],
	snsType: ["Notification", "SubscriptionConfirmation", "UnsubscribeConfirmation", "unknown"],
	signature: ["success", "failure", "not_attempted"],
	topicArnValidation: ["failure"],
	timestampValidation: ["failure"],
	capParse: ["success", "failure", "not_applicable"],
	capLifecycle: ["Alert", "Update", "Cancel", "Test", "other", "not_applicable"],
	idempotency: ["acquired", "processing_duplicate", "completed_duplicate", "lease_recovery", "completion", "failure", "not_reached"],
	normalizedRecord: ["success", "reconstruction", "failure", "not_applicable"],
	rejection: ["retryable", "permanent", "none"],
	exception: ["unexpected"],
} as const;

type MetricDimension = keyof typeof COUNTER_DIMENSIONS;
type CounterValue<D extends MetricDimension> = (typeof COUNTER_DIMENSIONS)[D][number];
type MetricCounters = { [D in MetricDimension]: Partial<Record<CounterValue<D>, number>> };

export interface IpawsMetricsEvent {
	httpStatus: CounterValue<"httpStatus">;
	handlerOutcome: CounterValue<"handlerOutcome">;
	snsType: CounterValue<"snsType">;
	signature: CounterValue<"signature">;
	topicArnValidation?: "failure";
	timestampValidation?: "failure";
	capParse: CounterValue<"capParse">;
	capLifecycle: CounterValue<"capLifecycle">;
	idempotency: CounterValue<"idempotency">[];
	normalizedRecord: CounterValue<"normalizedRecord">[];
	rejection: CounterValue<"rejection">;
	unexpectedException?: true;
	latencyMs: number;
	successfulDelivery?: true;
}

interface LatencyAggregate {
	count: number;
	sumMs: number;
	maxMs: number;
	buckets: Record<"le100" | "le500" | "le1000" | "le5000" | "gt5000", number>;
}

export interface IpawsMetricsBucket {
	day: string;
	counters: MetricCounters;
	latency: LatencyAggregate;
	lastSuccessfulDeliveryAt: string | null;
}

function isAllowed<D extends MetricDimension>(dimension: D, value: unknown): value is CounterValue<D> {
	return typeof value === "string" && (COUNTER_DIMENSIONS[dimension] as readonly string[]).includes(value);
}

export function isIpawsMetricsEvent(value: unknown): value is IpawsMetricsEvent {
	if (!value || typeof value !== "object") return false;
	const event = value as Record<string, unknown>;
	return isAllowed("httpStatus", event.httpStatus)
		&& isAllowed("handlerOutcome", event.handlerOutcome)
		&& isAllowed("snsType", event.snsType)
		&& isAllowed("signature", event.signature)
		&& (event.topicArnValidation === undefined || isAllowed("topicArnValidation", event.topicArnValidation))
		&& (event.timestampValidation === undefined || isAllowed("timestampValidation", event.timestampValidation))
		&& isAllowed("capParse", event.capParse)
		&& isAllowed("capLifecycle", event.capLifecycle)
		&& Array.isArray(event.idempotency) && event.idempotency.every((item) => isAllowed("idempotency", item))
		&& Array.isArray(event.normalizedRecord) && event.normalizedRecord.every((item) => isAllowed("normalizedRecord", item))
		&& isAllowed("rejection", event.rejection)
		&& (event.unexpectedException === undefined || event.unexpectedException === true)
		&& typeof event.latencyMs === "number" && Number.isFinite(event.latencyMs)
		&& (event.successfulDelivery === undefined || event.successfulDelivery === true);
}

export interface IpawsSoakReport {
	schemaVersion: 1;
	environment: "staging";
	retentionDays: number;
	windowStart: string | null;
	windowEnd: string | null;
	counters: MetricCounters;
	latency: LatencyAggregate & { averageMs: number | null };
	lastSuccessfulDeliveryAt: string | null;
	limitations: string[];
}

function emptyCounters(): MetricCounters {
	return Object.fromEntries(Object.keys(COUNTER_DIMENSIONS).map((key) => [key, {}])) as MetricCounters;
}

function emptyLatency(): LatencyAggregate {
	return { count: 0, sumMs: 0, maxMs: 0, buckets: { le100: 0, le500: 0, le1000: 0, le5000: 0, gt5000: 0 } };
}

function increment<D extends MetricDimension>(counters: MetricCounters, dimension: D, value: CounterValue<D>): void {
	const target = counters[dimension] as Record<string, number>;
	target[value] = (target[value] ?? 0) + 1;
}

function addLatency(target: LatencyAggregate, milliseconds: number): void {
	const value = Math.max(0, Math.min(Math.round(milliseconds), 300_000));
	target.count += 1;
	target.sumMs += value;
	target.maxMs = Math.max(target.maxMs, value);
	const bucket = value <= 100 ? "le100" : value <= 500 ? "le500" : value <= 1_000 ? "le1000" : value <= 5_000 ? "le5000" : "gt5000";
	target.buckets[bucket] += 1;
}

export function applyMetricsEvent(bucket: IpawsMetricsBucket, event: IpawsMetricsEvent, now: number): void {
	increment(bucket.counters, "request", "received");
	increment(bucket.counters, "httpStatus", event.httpStatus);
	increment(bucket.counters, "handlerOutcome", event.handlerOutcome);
	increment(bucket.counters, "snsType", event.snsType);
	increment(bucket.counters, "signature", event.signature);
	if (event.topicArnValidation) increment(bucket.counters, "topicArnValidation", event.topicArnValidation);
	if (event.timestampValidation) increment(bucket.counters, "timestampValidation", event.timestampValidation);
	increment(bucket.counters, "capParse", event.capParse);
	increment(bucket.counters, "capLifecycle", event.capLifecycle);
	for (const value of new Set(event.idempotency)) increment(bucket.counters, "idempotency", value);
	for (const value of new Set(event.normalizedRecord)) increment(bucket.counters, "normalizedRecord", value);
	increment(bucket.counters, "rejection", event.rejection);
	if (event.unexpectedException) increment(bucket.counters, "exception", "unexpected");
	addLatency(bucket.latency, event.latencyMs);
	if (event.successfulDelivery) bucket.lastSuccessfulDeliveryAt = new Date(now).toISOString();
}

export function newMetricsBucket(day: string): IpawsMetricsBucket {
	return { day, counters: emptyCounters(), latency: emptyLatency(), lastSuccessfulDeliveryAt: null };
}

export function retainedMetricsDays(days: string[], now: number): string[] {
	const currentDay = new Date(now).toISOString().slice(0, 10);
	const cutoffDay = new Date(Date.parse(`${currentDay}T00:00:00.000Z`) - (IPAWS_METRICS_RETENTION_DAYS - 1) * DAY_MS).toISOString().slice(0, 10);
	return [...new Set(days)]
		.filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day) && day >= cutoffDay && day <= currentDay)
		.sort();
}

function mergeBucket(report: IpawsSoakReport, bucket: IpawsMetricsBucket): void {
	for (const dimension of Object.keys(COUNTER_DIMENSIONS) as MetricDimension[]) {
		const target = report.counters[dimension] as Record<string, number>;
		const source = bucket.counters[dimension] as Record<string, number>;
		for (const key of COUNTER_DIMENSIONS[dimension] as readonly string[]) {
			const value = source[key];
			if (Number.isSafeInteger(value) && value > 0) target[key] = (target[key] ?? 0) + value;
		}
	}
	report.latency.count += bucket.latency.count;
	report.latency.sumMs += bucket.latency.sumMs;
	report.latency.maxMs = Math.max(report.latency.maxMs, bucket.latency.maxMs);
	for (const key of Object.keys(report.latency.buckets) as (keyof LatencyAggregate["buckets"])[]) report.latency.buckets[key] += bucket.latency.buckets[key];
	if (bucket.lastSuccessfulDeliveryAt && (!report.lastSuccessfulDeliveryAt || bucket.lastSuccessfulDeliveryAt > report.lastSuccessfulDeliveryAt)) {
		report.lastSuccessfulDeliveryAt = bucket.lastSuccessfulDeliveryAt;
	}
}

export function buildSoakReport(buckets: IpawsMetricsBucket[]): IpawsSoakReport {
	const ordered = buckets.filter((bucket) => /^\d{4}-\d{2}-\d{2}$/.test(bucket.day)).sort((a, b) => a.day.localeCompare(b.day));
	const latency = { ...emptyLatency(), averageMs: null as number | null };
	const report: IpawsSoakReport = {
		schemaVersion: 1, environment: "staging", retentionDays: IPAWS_METRICS_RETENTION_DAYS,
		windowStart: ordered[0]?.day ?? null, windowEnd: ordered.at(-1)?.day ?? null,
		counters: emptyCounters(), latency, lastSuccessfulDeliveryAt: null,
		limitations: [
			"Counts cover requests whose best-effort metrics write succeeded within the retained UTC-day window.",
			"A missing metrics event can indicate a metrics-path or platform failure; compare Worker request analytics before attributing a gap to the receiver.",
			"Latency measures Worker handler wall time and does not include upstream SNS retry delay or Cloudflare management API availability.",
		],
	};
	for (const bucket of ordered) mergeBucket(report, bucket);
	report.latency.averageMs = report.latency.count ? Math.round(report.latency.sumMs / report.latency.count) : null;
	return report;
}

export function capLifecycle(parseResult: IpawsCapParseResult): CounterValue<"capLifecycle"> {
	if (parseResult.status !== "parsed" || !parseResult.message) return "not_applicable";
	const status = parseResult.message.parsed.status?.trim().toLowerCase();
	if (status === "test") return "Test";
	const type = parseResult.message.parsed.msgType?.trim().toLowerCase();
	if (type === "alert") return "Alert";
	if (type === "update") return "Update";
	if (type === "cancel") return "Cancel";
	return "other";
}

export function snsType(value: IpawsSnsType | undefined): CounterValue<"snsType"> {
	return value ?? "unknown";
}

export async function recordIpawsMetrics(namespace: DurableObjectNamespace | undefined, event: IpawsMetricsEvent): Promise<void> {
	if (!namespace) return;
	try {
		const response = await namespace.get(namespace.idFromName(IPAWS_METRICS_OBJECT_NAME)).fetch("https://metrics.internal/metrics/record", {
			method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(event),
		});
		if (!response.ok) logWarn("IPAWS Metrics", "Durable metrics write rejected", { statusClass: response.status >= 500 ? "5xx" : "4xx" });
	} catch {
		// Fixed text only: observability failures must not leak delivery data or recursively write metrics.
		logWarn("IPAWS Metrics", "Durable metrics write unavailable");
	}
}

export async function readIpawsMetrics(namespace: DurableObjectNamespace | undefined): Promise<IpawsSoakReport | null> {
	if (!namespace) return null;
	try {
		const response = await namespace.get(namespace.idFromName(IPAWS_METRICS_OBJECT_NAME)).fetch("https://metrics.internal/metrics/report");
		return response.ok ? await response.json<IpawsSoakReport>() : null;
	} catch {
		return null;
	}
}
