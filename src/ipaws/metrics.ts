import type { IpawsCapParseResult, IpawsSnsType } from "./types";
import { logWarn } from "../utils/logger";

export const IPAWS_METRICS_OBJECT_NAME = "__ipaws_staging_metrics_v1__";
export const IPAWS_METRICS_RETENTION_DAYS = 35;
export const IPAWS_METRICS_MAX_REPORT_HOURS = 7 * 24;
export const IPAWS_METRICS_DEFAULT_REPORT_HOURS = 72;
export const IPAWS_CORRELATION_TTL_MS = 2 * 60 * 60 * 1_000;
export const IPAWS_CORRELATION_ROTATION_MS = 60 * 60 * 1_000;
export const IPAWS_CORRELATION_MAX_MARKERS = 256;
const HOUR_MS = 60 * 60 * 1_000;

const COUNTER_DIMENSIONS = {
	request: ["received"], httpStatus: ["2xx", "4xx", "5xx"],
	handlerOutcome: ["accepted", "duplicate", "delivery_in_progress", "subscription_confirmed", "subscription_skipped", "unsubscribe_recorded", "disabled", "misconfigured", "invalid_request", "security_rejection", "processing_failure", "unexpected_exception"],
	snsType: ["Notification", "SubscriptionConfirmation", "UnsubscribeConfirmation", "unknown"], signature: ["success", "failure", "not_attempted"],
	topicArnValidation: ["failure"], timestampValidation: ["failure"], capParse: ["success", "failure", "not_applicable"],
	capLifecycle: ["Alert", "Update", "Cancel", "Test", "other", "not_applicable"],
	idempotency: ["acquired", "processing_duplicate", "completed_duplicate", "lease_recovery", "completion", "failure", "not_reached"],
	normalizedRecord: ["success", "reconstruction", "failure", "not_applicable"], rejection: ["retryable", "permanent", "none"], exception: ["unexpected"],
	processingStage: ["envelope_validation", "security_validation", "certificate_retrieval", "initial_idempotency_claim", "cap_parsing", "persistence", "normalization", "completion", "metrics_recording"],
	failureClass: ["invalid_request", "configuration", "topic_validation", "timestamp_validation", "certificate_unavailable", "signature_invalid", "idempotency_unavailable", "delivery_in_progress", "persistence_unavailable", "normalization_unavailable", "completion_unavailable", "output_verification", "unexpected_exception", "other_retryable", "other_permanent"],
	retryResolution: ["resolved_after_preclaim_failure"],
} as const;
type MetricDimension = keyof typeof COUNTER_DIMENSIONS;
type CounterValue<D extends MetricDimension> = (typeof COUNTER_DIMENSIONS)[D][number];
type MetricCounters = { [D in MetricDimension]: Partial<Record<CounterValue<D>, number>> };
export type IpawsProcessingStage = CounterValue<"processingStage">;
export type IpawsFailureClass = CounterValue<"failureClass">;
export interface IpawsMetricsEvent {
	httpStatus: CounterValue<"httpStatus">; handlerOutcome: CounterValue<"handlerOutcome">; snsType: CounterValue<"snsType">; signature: CounterValue<"signature">;
	topicArnValidation?: "failure"; timestampValidation?: "failure"; capParse: CounterValue<"capParse">; capLifecycle: CounterValue<"capLifecycle">;
	idempotency: CounterValue<"idempotency">[]; normalizedRecord: CounterValue<"normalizedRecord">[]; rejection: CounterValue<"rejection">;
	unexpectedException?: true; latencyMs: number; successfulDelivery?: true; processingStages: IpawsProcessingStage[]; failureStage?: IpawsProcessingStage; failureClass?: IpawsFailureClass;
}
interface LatencyAggregate { count: number; sumMs: number; maxMs: number; buckets: Record<"le100" | "le500" | "le1000" | "le5000" | "gt5000", number> }
export interface IpawsLatestFailure { timestamp: string; stage: IpawsProcessingStage; failureClass: IpawsFailureClass }
export interface IpawsMetricsBucket { hour: string; counters: MetricCounters; latency: LatencyAggregate; lastSuccessfulDeliveryAt: string | null; latestFailure: IpawsLatestFailure | null }
export interface IpawsSoakReport { schemaVersion: 2; environment: "staging"; retentionDays: number; maxWindowHours: number; windowStart: string; windowEnd: string; counters: MetricCounters; latency: LatencyAggregate & { averageMs: number | null }; lastSuccessfulDeliveryAt: string | null; latestFailure: IpawsLatestFailure | null; limitations: string[] }

function isAllowed<D extends MetricDimension>(dimension: D, value: unknown): value is CounterValue<D> { return typeof value === "string" && (COUNTER_DIMENSIONS[dimension] as readonly string[]).includes(value); }
export function isIpawsMetricsEvent(value: unknown): value is IpawsMetricsEvent {
	if (!value || typeof value !== "object") return false; const event = value as Record<string, unknown>;
	return isAllowed("httpStatus", event.httpStatus) && isAllowed("handlerOutcome", event.handlerOutcome) && isAllowed("snsType", event.snsType) && isAllowed("signature", event.signature)
		&& (event.topicArnValidation === undefined || isAllowed("topicArnValidation", event.topicArnValidation)) && (event.timestampValidation === undefined || isAllowed("timestampValidation", event.timestampValidation))
		&& isAllowed("capParse", event.capParse) && isAllowed("capLifecycle", event.capLifecycle) && Array.isArray(event.idempotency) && event.idempotency.every((item) => isAllowed("idempotency", item))
		&& Array.isArray(event.normalizedRecord) && event.normalizedRecord.every((item) => isAllowed("normalizedRecord", item)) && isAllowed("rejection", event.rejection)
		&& (event.unexpectedException === undefined || event.unexpectedException === true) && typeof event.latencyMs === "number" && Number.isFinite(event.latencyMs) && (event.successfulDelivery === undefined || event.successfulDelivery === true)
		&& Array.isArray(event.processingStages) && event.processingStages.every((item) => isAllowed("processingStage", item)) && (event.failureStage === undefined || isAllowed("processingStage", event.failureStage))
		&& (event.failureClass === undefined || isAllowed("failureClass", event.failureClass)) && ((event.failureStage === undefined) === (event.failureClass === undefined));
}
function emptyCounters(): MetricCounters { return Object.fromEntries(Object.keys(COUNTER_DIMENSIONS).map((key) => [key, {}])) as MetricCounters; }
function emptyLatency(): LatencyAggregate { return { count: 0, sumMs: 0, maxMs: 0, buckets: { le100: 0, le500: 0, le1000: 0, le5000: 0, gt5000: 0 } }; }
function increment<D extends MetricDimension>(counters: MetricCounters, dimension: D, value: CounterValue<D>): void { const target = counters[dimension] as Record<string, number>; target[value] = (target[value] ?? 0) + 1; }
function addLatency(target: LatencyAggregate, milliseconds: number): void { const value = Math.max(0, Math.min(Math.round(milliseconds), 300_000)); target.count++; target.sumMs += value; target.maxMs = Math.max(target.maxMs, value); target.buckets[value <= 100 ? "le100" : value <= 500 ? "le500" : value <= 1_000 ? "le1000" : value <= 5_000 ? "le5000" : "gt5000"]++; }
export function hourKey(now: number): string { return new Date(Math.floor(now / HOUR_MS) * HOUR_MS).toISOString(); }
export function canonicalHour(value: string): boolean { return /^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/.test(value) && new Date(value).toISOString() === value; }
export function retainedMetricHours(hours: string[], now: number): string[] { const cutoff = Math.floor(now / HOUR_MS) * HOUR_MS - (IPAWS_METRICS_RETENTION_DAYS * 24 - 1) * HOUR_MS; return [...new Set(hours)].filter((hour) => canonicalHour(hour) && Date.parse(hour) >= cutoff && Date.parse(hour) <= now).sort(); }
export function applyMetricsEvent(bucket: IpawsMetricsBucket, event: IpawsMetricsEvent, now: number): void {
	increment(bucket.counters, "request", "received"); increment(bucket.counters, "httpStatus", event.httpStatus); increment(bucket.counters, "handlerOutcome", event.handlerOutcome); increment(bucket.counters, "snsType", event.snsType); increment(bucket.counters, "signature", event.signature);
	if (event.topicArnValidation) increment(bucket.counters, "topicArnValidation", event.topicArnValidation); if (event.timestampValidation) increment(bucket.counters, "timestampValidation", event.timestampValidation);
	increment(bucket.counters, "capParse", event.capParse); increment(bucket.counters, "capLifecycle", event.capLifecycle); for (const value of new Set(event.idempotency)) increment(bucket.counters, "idempotency", value); for (const value of new Set(event.normalizedRecord)) increment(bucket.counters, "normalizedRecord", value);
	increment(bucket.counters, "rejection", event.rejection); if (event.unexpectedException) increment(bucket.counters, "exception", "unexpected"); for (const value of new Set([...event.processingStages, "metrics_recording" as const])) increment(bucket.counters, "processingStage", value); if (event.failureClass) increment(bucket.counters, "failureClass", event.failureClass);
	addLatency(bucket.latency, event.latencyMs); if (event.successfulDelivery) bucket.lastSuccessfulDeliveryAt = new Date(now).toISOString();
	if (event.failureStage && event.failureClass) bucket.latestFailure = { timestamp: new Date(now).toISOString(), stage: event.failureStage, failureClass: event.failureClass };
}
export function newMetricsBucket(hour: string): IpawsMetricsBucket { return { hour, counters: emptyCounters(), latency: emptyLatency(), lastSuccessfulDeliveryAt: null, latestFailure: null }; }
function mergeBucket(report: IpawsSoakReport, bucket: IpawsMetricsBucket): void { for (const dimension of Object.keys(COUNTER_DIMENSIONS) as MetricDimension[]) { const target = report.counters[dimension] as Record<string, number>; const source = bucket.counters[dimension] as Record<string, number>; for (const key of COUNTER_DIMENSIONS[dimension] as readonly string[]) { const value = source[key]; if (Number.isSafeInteger(value) && Number(value) > 0) target[key] = (target[key] ?? 0) + Number(value); } } report.latency.count += bucket.latency.count; report.latency.sumMs += bucket.latency.sumMs; report.latency.maxMs = Math.max(report.latency.maxMs, bucket.latency.maxMs); for (const key of Object.keys(report.latency.buckets) as (keyof LatencyAggregate["buckets"])[]) report.latency.buckets[key] += bucket.latency.buckets[key]; if (bucket.lastSuccessfulDeliveryAt && (!report.lastSuccessfulDeliveryAt || bucket.lastSuccessfulDeliveryAt > report.lastSuccessfulDeliveryAt)) report.lastSuccessfulDeliveryAt = bucket.lastSuccessfulDeliveryAt; if (bucket.latestFailure && (!report.latestFailure || bucket.latestFailure.timestamp > report.latestFailure.timestamp)) report.latestFailure = bucket.latestFailure; }
export function buildSoakReport(buckets: IpawsMetricsBucket[], start: string, end: string): IpawsSoakReport { const latency = { ...emptyLatency(), averageMs: null as number | null }; const report: IpawsSoakReport = { schemaVersion: 2, environment: "staging", retentionDays: IPAWS_METRICS_RETENTION_DAYS, maxWindowHours: IPAWS_METRICS_MAX_REPORT_HOURS, windowStart: start, windowEnd: end, counters: emptyCounters(), latency, lastSuccessfulDeliveryAt: null, latestFailure: null, limitations: ["Counts cover requests whose best-effort metrics write succeeded in the requested canonical UTC-hour window.", "Retry resolution is best-effort, uses short-lived non-reversible internal markers, and can undercount if metrics storage is unavailable.", "Latency measures Worker handler wall time and excludes upstream SNS retry delay."] }; for (const bucket of buckets.filter((item) => item.hour >= start && item.hour < end).sort((a, b) => a.hour.localeCompare(b.hour))) mergeBucket(report, bucket); report.latency.averageMs = report.latency.count ? Math.round(report.latency.sumMs / report.latency.count) : null; return report; }
export function capLifecycle(parseResult: IpawsCapParseResult): CounterValue<"capLifecycle"> { if (parseResult.status !== "parsed" || !parseResult.message) return "not_applicable"; if (parseResult.message.parsed.status?.trim().toLowerCase() === "test") return "Test"; const type = parseResult.message.parsed.msgType?.trim().toLowerCase(); return type === "alert" ? "Alert" : type === "update" ? "Update" : type === "cancel" ? "Cancel" : "other"; }
export function snsType(value: IpawsSnsType | undefined): CounterValue<"snsType"> { return value ?? "unknown"; }
export type IpawsCorrelationAction = "preclaim_failure" | "accepted";
export async function recordIpawsMetrics(namespace: DurableObjectNamespace | undefined, event: IpawsMetricsEvent, correlation?: { action: IpawsCorrelationAction; messageId: string }): Promise<void> { if (!namespace) return; try { const response = await namespace.get(namespace.idFromName(IPAWS_METRICS_OBJECT_NAME)).fetch("https://metrics.internal/metrics/record", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event, correlation }) }); if (!response.ok) logWarn("IPAWS Metrics", "Durable metrics write rejected", { statusClass: response.status >= 500 ? "5xx" : "4xx" }); } catch { logWarn("IPAWS Metrics", "Durable metrics write unavailable"); } }
export async function readIpawsMetrics(namespace: DurableObjectNamespace | undefined, start: string, end: string): Promise<IpawsSoakReport | null> { if (!namespace) return null; try { const response = await namespace.get(namespace.idFromName(IPAWS_METRICS_OBJECT_NAME)).fetch(`https://metrics.internal/metrics/report?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`); return response.ok ? await response.json<IpawsSoakReport>() : null; } catch { return null; } }
