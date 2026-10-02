import type { Env } from "../types";
import { loadIpawsConfig } from "./config";
import { parseCapPayload } from "./parser";
import type { IpawsCapParseResult } from "./types";
import { readIngestionRecord, readNormalizedAlert, readSubscriptionState, updateIngestionRecord, upsertIngestionRecord, writeInvalidSignatureRecord, writeSubscriptionState } from "./persistence";
import { recordIpawsHealthEvent } from "./health";
import { IpawsSnsError, parseSnsMessage, validateSnsTimestamp, validateSubscribeUrl, verifySnsSignature } from "./sns";
import { logWarn } from "../utils/logger";
import { stageNormalizedAlert } from "./domain";
import { claimIpawsDelivery, completeIpawsDelivery, recoverIpawsDelivery, releaseIpawsDelivery, renewIpawsDelivery } from "./idempotency";
import { capLifecycle, recordIpawsMetrics, snsType, type IpawsFailureClass, type IpawsMetricsEvent, type IpawsProcessingStage } from "./metrics";

const MAX_ENVELOPE_BYTE_LIMIT = 512 * 1024;
const SUBSCRIPTION_CONFIRM_TIMEOUT_MS = 5_000;

async function readRequestText(body: ReadableStream<Uint8Array>, byteLimit: number): Promise<string> {
	const decoder = new TextDecoder();
	let total = 0;
	const chunks: Uint8Array[] = [];
	for await (const chunk of body) {
		total += chunk.byteLength;
		if (total > byteLimit) {
			throw new Error("ipaws_request_too_large");
		}
		chunks.push(chunk);
	}
	const combined = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return decoder.decode(combined);
}

class IpawsRetryableError extends Error {
	constructor(public readonly code: string, message: string) {
		super(message);
	}
}

async function confirmSubscription(url: string): Promise<void> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), SUBSCRIPTION_CONFIRM_TIMEOUT_MS);
	try {
		const confirm = await fetch(url, { method: "GET", redirect: "manual", signal: controller.signal });
		if (confirm.ok) return;
		if (confirm.status === 429 || confirm.status >= 500) {
			throw new IpawsRetryableError("ipaws_subscription_confirmation_unavailable", `SNS confirmation returned ${confirm.status}.`);
		}
		throw new IpawsSnsError("ipaws_subscription_confirmation_rejected", `SNS confirmation returned ${confirm.status}.`);
	} catch (error) {
		if (error instanceof IpawsRetryableError || error instanceof IpawsSnsError) throw error;
		throw new IpawsRetryableError("ipaws_subscription_confirmation_unavailable", "SNS confirmation request failed temporarily.");
	} finally {
		clearTimeout(timer);
	}
}

async function deliveryOutputsComplete(env: Env, messageId: string): Promise<boolean> {
	const record = await readIngestionRecord(env, messageId);
	if (!record) return false;
	if (record.type === "Notification") {
		if (record.processingState === "notification_parse_failed" || record.processingState === "notification_unsupported") return await readSubscriptionState(env) === "confirmed";
		if (record.processingState !== "notification_done") return false;
		return Boolean(await readNormalizedAlert(env, messageId)) && await readSubscriptionState(env) === "confirmed";
	}
	if (record.type === "SubscriptionConfirmation") {
		if (record.processingState === "subscription_confirmed") return await readSubscriptionState(env) === "confirmed";
		if (record.processingState === "subscription_skipped") return await readSubscriptionState(env) === "skipped";
		return false;
	}
	return record.processingState === "unsubscribe_received";
}

function response(body: unknown, init: ResponseInit = {}): Response {
	return Response.json(body, { ...init, headers: { "Content-Type": "application/json; charset=utf-8", ...init.headers } });
}

function responseError(code: string, message: string, status: number) {
	return response({ status: "error", code, message }, { status, headers: { "Cache-Control": "no-store" } });
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

type MetricsTracker = Omit<IpawsMetricsEvent, "httpStatus" | "handlerOutcome" | "latencyMs" | "rejection"> & { currentStage?: IpawsProcessingStage; correlationMessageId?: string; correlationAction?: "preclaim_failure" | "accepted" };

function enterStage(metrics: MetricsTracker, stage: IpawsProcessingStage): void {
	metrics.currentStage = stage;
	if (!metrics.processingStages.includes(stage)) metrics.processingStages.push(stage);
}

function failureClass(code: string, stage: IpawsProcessingStage, retryable: boolean): IpawsFailureClass {
	if (/disabled|misconfigured/.test(code)) return "configuration";
	if (/topic/.test(code)) return "topic_validation";
	if (/timestamp/.test(code)) return "timestamp_validation";
	if (/cert|certificate/.test(code)) return "certificate_unavailable";
	if (/signature/.test(code)) return "signature_invalid";
	if (/idempotency|recovery/.test(code) || stage === "initial_idempotency_claim") return "idempotency_unavailable";
	if (/in_progress/.test(code)) return "delivery_in_progress";
	if (/output_verification/.test(code)) return "output_verification";
	if (/stale_delivery_claim/.test(code) || stage === "completion") return "completion_unavailable";
	if (stage === "persistence") return "persistence_unavailable";
	if (stage === "normalization") return "normalization_unavailable";
	if (/unexpected/.test(code)) return "unexpected_exception";
	if (/invalid|unsupported|too_large|missing/.test(code)) return "invalid_request";
	return retryable ? "other_retryable" : "other_permanent";
}

function outcomeFor(responseBody: Record<string, unknown>): IpawsMetricsEvent["handlerOutcome"] {
	const outcome = responseBody.outcome;
	if (outcome === "accepted" || outcome === "duplicate" || outcome === "subscription_confirmed" || outcome === "unsubscribe_recorded") return outcome;
	if (outcome === "subscription_confirmation_skipped") return "subscription_skipped";
	const code = typeof responseBody.code === "string" ? responseBody.code : "";
	if (code === "ipaws_disabled") return "disabled";
	if (code.includes("misconfigured")) return "misconfigured";
	if (code === "ipaws_delivery_in_progress") return "delivery_in_progress";
	if (["ipaws_request_too_large", "ipaws_missing_body", "ipaws_invalid_json", "ipaws_invalid_payload", "ipaws_invalid_sns_field", "ipaws_unsupported_sns_type"].includes(code)) return "invalid_request";
	if (/signature|topic|timestamp|subscribe_url|certificate|unsafe/.test(code)) return "security_rejection";
	if (code === "ipaws_unexpected_exception") return "unexpected_exception";
	if (code.startsWith("ipaws_") && responseBody.status === "error") return "processing_failure";
	return "invalid_request";
}

function statusClass(status: number): IpawsMetricsEvent["httpStatus"] {
	return status >= 500 ? "5xx" : status >= 400 ? "4xx" : "2xx";
}

async function handleIpawsPubSubRequestInner(request: Request, env: Env, metrics: MetricsTracker): Promise<Response> {
	enterStage(metrics, "envelope_validation");
	if (request.method !== "POST") {
		return response({ error: "Method Not Allowed" }, { status: 405, headers: { Allow: "POST" } });
	}

	const config = loadIpawsConfig(env);
	if (config.environment === "production" && (config.notificationsEnabled || config.downstreamEffectsEnabled)) {
		return responseError("ipaws_unsafe_production_effects", "Production notification and downstream effects must remain disabled.", 503);
	}
	if (!config.enabled) {
		return responseError("ipaws_disabled", "IPAWS ingestion is disabled in this environment.", 503);
	}

	if (config.allowedTopicArns.length === 0) {
		return responseError("ipaws_misconfigured", "IPAWS ingestion is enabled but no TopicArn allowlist is configured.", 503);
	}

	const contentLengthHeader = request.headers.get("content-length");
	if (contentLengthHeader) {
		const contentLength = Number.parseInt(contentLengthHeader, 10);
		if (Number.isFinite(contentLength) && contentLength > MAX_ENVELOPE_BYTE_LIMIT) {
			return responseError("ipaws_request_too_large", `Request payload exceeds ${MAX_ENVELOPE_BYTE_LIMIT} bytes.`, 413);
		}
	}

	let bodyText: string;
	try {
		if (!request.body) {
			return responseError("ipaws_missing_body", "Request body is required.", 400);
		}
		bodyText = await readRequestText(request.body, MAX_ENVELOPE_BYTE_LIMIT);
	} catch (error) {
		if (error instanceof Error && error.message === "ipaws_request_too_large") {
			return responseError("ipaws_request_too_large", "Request payload exceeds the allowed size.", 413);
		}
		return responseError("ipaws_request_too_large", "Request payload exceeds the allowed size.", 413);
	}
	if (!bodyText.trim()) return responseError("ipaws_missing_body", "Request body is required.", 400);

	let rawPayload: unknown;
	try {
		rawPayload = JSON.parse(bodyText);
	} catch {
		return responseError("ipaws_invalid_json", "Invalid JSON payload.", 400);
	}

	let message;
	try {
		message = parseSnsMessage(rawPayload);
		metrics.snsType = snsType(message.Type);
		metrics.correlationMessageId = message.MessageId;
	} catch (error) {
		if (error instanceof IpawsSnsError) return responseError(error.code, error.message, 400);
		return responseError("ipaws_invalid_payload", "Unable to parse SNS envelope.", 400);
	}

	enterStage(metrics, "security_validation");
	if (!config.allowedTopicArns.includes(message.TopicArn.trim())) {
		metrics.topicArnValidation = "failure";
		return responseError("ipaws_unexpected_topic", "TopicArn is not configured as allowed.", 400);
	}
	try {
		validateSnsTimestamp(message.Timestamp, config.snsMaxAgeSeconds, config.snsMaxFutureSkewSeconds);
	} catch (error) {
		metrics.timestampValidation = "failure";
		if (error instanceof IpawsSnsError) return responseError(error.code, error.message, 400);
		return responseError("ipaws_invalid_timestamp", "SNS Timestamp is invalid.", 400);
	}

	let signatureResult;
	enterStage(metrics, "certificate_retrieval");
	try {
		signatureResult = await verifySnsSignature(message);
	} catch (error) {
		metrics.signature = "failure";
		if (error instanceof IpawsSnsError) return responseError(error.code, error.message, 400);
		return responseError("ipaws_signature_validation_unavailable", "SNS signature validation is temporarily unavailable.", 503);
	}
	if (!signatureResult.valid) {
		metrics.signature = "failure";
		if (signatureResult.retryable) {
			return responseError(signatureResult.reason ?? "ipaws_certificate_unavailable", "SNS certificate retrieval is temporarily unavailable.", 503);
		}
		enterStage(metrics, "security_validation");
		const messageDigest = await sha256Hex(message.Message);
		enterStage(metrics, "persistence");
		await writeInvalidSignatureRecord(env, message, messageDigest, config.recordTtlSeconds);
		await recordIpawsHealthEvent(env, `signature_failed:${signatureResult.reason ?? "unknown"}`, config.healthTtlSeconds);
		enterStage(metrics, "security_validation");
		return responseError(signatureResult.reason ?? "ipaws_signature_invalid", "SNS signature verification failed.", 400);
	}
	metrics.signature = "success";
	enterStage(metrics, "security_validation");
	if (!env.IPAWS_IDEMPOTENCY) {
		return responseError("ipaws_idempotency_misconfigured", "Strongly consistent IPAWS idempotency is not configured.", 503);
	}
	if (message.Type === "SubscriptionConfirmation") {
		try {
			validateSubscribeUrl(message.SubscribeURL ?? "", message.TopicArn, message.Token ?? "");
		} catch (error) {
			if (error instanceof IpawsSnsError) return responseError(error.code, error.message, 400);
			return responseError("ipaws_invalid_subscribe_url", "SubscribeURL is invalid.", 400);
		}
	}

	let claim;
	enterStage(metrics, "initial_idempotency_claim");
	try {
		claim = await claimIpawsDelivery(env.IPAWS_IDEMPOTENCY, message.MessageId);
		if (claim.result === "acquired" && claim.recovered) metrics.idempotency.push("lease_recovery");
	} catch {
		metrics.idempotency.push("failure");
		metrics.correlationAction = "preclaim_failure";
		return responseError("ipaws_idempotency_unavailable", "IPAWS idempotency coordinator is unavailable.", 503);
	}
	if (claim.result === "processing") {
		metrics.idempotency.push("processing_duplicate");
		return response({ status: "error", code: "ipaws_delivery_in_progress", message: "Delivery processing is still in progress." }, {
			status: 503,
			headers: { "Cache-Control": "no-store", "Retry-After": "2" },
		});
	}
	if (claim.result === "complete") {
		try {
			if (await deliveryOutputsComplete(env, message.MessageId)) {
				metrics.idempotency.push("completed_duplicate");
				await recordIpawsHealthEvent(env, "delivery_duplicate", config.healthTtlSeconds);
				return response({ status: "ok", outcome: "duplicate" }, { headers: { "Cache-Control": "no-store" } });
			}
			claim = await recoverIpawsDelivery(env.IPAWS_IDEMPOTENCY, message.MessageId);
			if (claim.result === "acquired") metrics.idempotency.push("lease_recovery");
		} catch {
			metrics.idempotency.push("failure");
			return responseError("ipaws_recovery_unavailable", "Delivery recovery is temporarily unavailable.", 503);
		}
		if (claim.result !== "acquired") {
			return responseError("ipaws_delivery_in_progress", "Delivery recovery is already in progress.", 503);
		}
	}
	if (claim.result !== "acquired") return responseError("ipaws_idempotency_unavailable", "IPAWS delivery ownership was not acquired.", 503);
	if (!metrics.idempotency.includes("lease_recovery")) metrics.idempotency.push("acquired");
	const claimToken = claim.token;

	enterStage(metrics, "cap_parsing");
	const parseResult: IpawsCapParseResult = message.Type === "Notification"
		? parseCapPayload(message.Message, config.parseByteLimit)
		: {
			status: "parse_failed" as const,
			message: { source: "unknown", parsed: {} },
			reason: "not_notification",
		};
	metrics.capParse = message.Type === "Notification" ? (parseResult.status === "parsed" ? "success" : parseResult.status === "unsupported" ? "unsupported" : "failure") : "not_applicable";
	metrics.unsupportedInput = parseResult.status === "unsupported" ? parseResult.unsupportedClass : undefined;
	metrics.capLifecycle = message.Type === "Notification" ? capLifecycle(parseResult) : "not_applicable";

	try {
		enterStage(metrics, "persistence");
		const receipt = await upsertIngestionRecord(
			env,
			message,
			"signature_verified",
			message.Message,
			"success",
			parseResult,
			message.TopicArn,
			config.recordTtlSeconds,
		);
		if (!(await renewIpawsDelivery(env.IPAWS_IDEMPOTENCY, message.MessageId, claimToken))) {
			throw new IpawsRetryableError("ipaws_stale_delivery_claim", "Delivery ownership expired before processing completed.");
		}

		if (message.Type === "Notification") {
			if (parseResult.status === "parsed") {
				enterStage(metrics, "normalization");
				let reconstructing = false;
				if (receipt.duplicate) {
					try { reconstructing = !(await readNormalizedAlert(env, message.MessageId)); } catch { /* Metrics classification must not affect delivery. */ }
				}
				try {
					await stageNormalizedAlert(env, receipt.record, config.recordTtlSeconds);
					metrics.normalizedRecord.push(reconstructing ? "reconstruction" : "success");
				} catch (error) {
					metrics.normalizedRecord.push("failure");
					throw error;
				}
			}
			enterStage(metrics, "persistence");
			// SNS delivers notifications only after the HTTPS subscription is confirmed.
			await writeSubscriptionState(env, "confirmed", config.subscriptionStateTtlSeconds);
			await recordIpawsHealthEvent(env, parseResult.status === "parsed" ? "delivery_notification_parsed" : parseResult.status === "unsupported" ? "delivery_notification_unsupported" : "delivery_notification_parse_failed", config.healthTtlSeconds, {
				environment: config.environment,
				stagingEnabled: config.enabled,
			});
			await updateIngestionRecord(env, message.MessageId, {
				processingState: parseResult.status === "parsed" ? "notification_done" : parseResult.status === "unsupported" ? "notification_unsupported" : "notification_parse_failed",
				parseStatus: parseResult.status,
				parseError: parseResult.status === "parsed" ? null : (parseResult.reason ?? parseResult.status),
				parseResultSummary: parseResult.status,
			}, config.recordTtlSeconds);
			enterStage(metrics, "completion");
			if (!(await deliveryOutputsComplete(env, message.MessageId))) throw new IpawsRetryableError("ipaws_output_verification_failed", "Required notification outputs are not yet visible.");
			if (!(await renewIpawsDelivery(env.IPAWS_IDEMPOTENCY, message.MessageId, claimToken))) throw new IpawsRetryableError("ipaws_stale_delivery_claim", "Delivery ownership expired before completion.");
			if (!(await completeIpawsDelivery(env.IPAWS_IDEMPOTENCY, message.MessageId, claimToken))) throw new IpawsRetryableError("ipaws_stale_delivery_claim", "Delivery ownership changed before completion.");
			metrics.idempotency.push("completion");
			metrics.correlationAction = "accepted";
			return response({ status: "ok", outcome: "accepted", ingestionId: receipt.record.id }, { headers: { "Cache-Control": "no-store" } });
		}

		if (message.Type === "UnsubscribeConfirmation") {
			enterStage(metrics, "persistence");
			await recordIpawsHealthEvent(env, "unsubscribe_confirmation_received", config.healthTtlSeconds, {
				environment: config.environment,
				stagingEnabled: config.enabled,
			});
			await updateIngestionRecord(env, message.MessageId, {
				processingState: "unsubscribe_received",
				parseStatus: "parse_failed",
				parseError: "unsubscribe_confirmation_no_action",
			}, config.recordTtlSeconds);
			enterStage(metrics, "completion");
			if (!(await deliveryOutputsComplete(env, message.MessageId))) throw new IpawsRetryableError("ipaws_output_verification_failed", "Required unsubscribe output is not yet visible.");
			if (!(await completeIpawsDelivery(env.IPAWS_IDEMPOTENCY, message.MessageId, claimToken))) throw new IpawsRetryableError("ipaws_stale_delivery_claim", "Delivery ownership changed before completion.");
			metrics.idempotency.push("completion");
			metrics.correlationAction = "accepted";
			return response({ status: "ok", outcome: "unsubscribe_recorded", ingestionId: receipt.record.id }, { headers: { "Cache-Control": "no-store" } });
		}

		if (!config.autoConfirmSubscription) {
			enterStage(metrics, "persistence");
			await writeSubscriptionState(env, "skipped", config.subscriptionStateTtlSeconds);
			await recordIpawsHealthEvent(env, "subscription_confirmation_disabled", config.healthTtlSeconds, {
				environment: config.environment,
				stagingEnabled: config.enabled,
			});
			await updateIngestionRecord(env, message.MessageId, {
				processingState: "subscription_skipped",
				parseStatus: "parse_failed",
				parseError: "subscription_confirmation_disabled",
			}, config.recordTtlSeconds);
			enterStage(metrics, "completion");
			if (!(await deliveryOutputsComplete(env, message.MessageId))) throw new IpawsRetryableError("ipaws_output_verification_failed", "Required subscription output is not yet visible.");
			if (!(await completeIpawsDelivery(env.IPAWS_IDEMPOTENCY, message.MessageId, claimToken))) throw new IpawsRetryableError("ipaws_stale_delivery_claim", "Delivery ownership changed before completion.");
			metrics.idempotency.push("completion");
			metrics.correlationAction = "accepted";
			return response({ status: "ok", outcome: "subscription_confirmation_skipped", ingestionId: receipt.record.id }, { headers: { "Cache-Control": "no-store" } });
		}

		await confirmSubscription(message.SubscribeURL ?? "");
		enterStage(metrics, "persistence");
		await writeSubscriptionState(env, "confirmed", config.subscriptionStateTtlSeconds);
		await recordIpawsHealthEvent(env, "subscription_confirmed", config.healthTtlSeconds, {
			environment: config.environment,
			stagingEnabled: config.enabled,
		});
		await updateIngestionRecord(env, message.MessageId, {
			processingState: "subscription_confirmed",
			parseStatus: "parse_failed",
			parseError: null,
		}, config.recordTtlSeconds);
		enterStage(metrics, "completion");
		if (!(await deliveryOutputsComplete(env, message.MessageId))) throw new IpawsRetryableError("ipaws_output_verification_failed", "Required subscription output is not yet visible.");
		if (!(await completeIpawsDelivery(env.IPAWS_IDEMPOTENCY, message.MessageId, claimToken))) throw new IpawsRetryableError("ipaws_stale_delivery_claim", "Delivery ownership changed before completion.");
		metrics.idempotency.push("completion");
		metrics.correlationAction = "accepted";
		return response({ status: "ok", outcome: "subscription_confirmed", ingestionId: receipt.record.id }, { headers: { "Cache-Control": "no-store" } });
	} catch (error) {
		metrics.idempotency.push("failure");
		try {
			await releaseIpawsDelivery(env.IPAWS_IDEMPOTENCY, message.MessageId, claimToken);
		} catch {
			logWarn("IPAWS", "Unable to release failed delivery claim");
		}
		if (error instanceof IpawsSnsError) return responseError(error.code, error.message, 400);
		logWarn("IPAWS", "Retryable IPAWS processing failure", { stage: metrics.currentStage ?? "persistence" });
		return responseError(error instanceof IpawsRetryableError ? error.code : "ipaws_processing_unavailable", "IPAWS processing is temporarily unavailable.", 503);
	}
}

export async function handleIpawsPubSubRequest(request: Request, env: Env, ctx?: Pick<ExecutionContext, "waitUntil">): Promise<Response> {
	const startedAt = Date.now();
	const metrics: MetricsTracker = {
		snsType: "unknown", signature: "not_attempted", capParse: "not_applicable", capLifecycle: "not_applicable",
		idempotency: [], normalizedRecord: [], processingStages: [],
	};
	let result: Response;
	let unexpectedException = false;
	try {
		result = await handleIpawsPubSubRequestInner(request, env, metrics);
	} catch {
		unexpectedException = true;
		result = responseError("ipaws_unexpected_exception", "IPAWS processing is temporarily unavailable.", 503);
	}
	let body: Record<string, unknown> = {};
	try { body = await result.clone().json<Record<string, unknown>>(); } catch { /* Responses are normally JSON. */ }
	const rejection: IpawsMetricsEvent["rejection"] = result.status >= 500 ? "retryable" : result.status >= 400 ? "permanent" : "none";
	const code = typeof body.code === "string" ? body.code : "";
	if (result.status >= 400) {
		metrics.failureStage = metrics.currentStage ?? "envelope_validation";
		metrics.failureClass = failureClass(code, metrics.failureStage, rejection === "retryable");
	}
	const { currentStage: _currentStage, correlationMessageId, correlationAction, ...publicMetrics } = metrics;
	const metricsWrite = recordIpawsMetrics(env.IPAWS_IDEMPOTENCY, {
		...publicMetrics,
		idempotency: metrics.idempotency.length ? metrics.idempotency : ["not_reached"],
		normalizedRecord: metrics.normalizedRecord.length ? metrics.normalizedRecord : ["not_applicable"],
		httpStatus: statusClass(result.status), handlerOutcome: outcomeFor(body), rejection,
		unexpectedException: unexpectedException || undefined,
		latencyMs: Date.now() - startedAt,
		successfulDelivery: result.status >= 200 && result.status < 300 ? true : undefined,
	}, correlationMessageId && correlationAction ? { messageId: correlationMessageId, action: correlationAction } : undefined);
	if (ctx) ctx.waitUntil(metricsWrite);
	else await metricsWrite;
	return result;
}
