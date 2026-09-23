import type { Env } from "../types";
import { loadIpawsConfig } from "./config";
import { parseCapPayload } from "./parser";
import type { IpawsCapParseResult } from "./types";
import { readIngestionRecord, readNormalizedAlert, readSubscriptionState, updateIngestionRecord, upsertIngestionRecord, writeSubscriptionState } from "./persistence";
import { recordIpawsHealthEvent } from "./health";
import { IpawsSnsError, parseSnsMessage, validateSnsTimestamp, validateSubscribeUrl, verifySnsSignature } from "./sns";
import { logWarn } from "../utils/logger";
import { stageNormalizedAlert } from "./domain";
import { claimIpawsDelivery, completeIpawsDelivery, recoverIpawsDelivery, releaseIpawsDelivery, renewIpawsDelivery } from "./idempotency";

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
		if (record.processingState === "notification_parse_failed") return await readSubscriptionState(env) === "confirmed";
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

export async function handleIpawsPubSubRequest(request: Request, env: Env): Promise<Response> {
	if (request.method !== "POST") {
		return response({ error: "Method Not Allowed" }, { status: 405, headers: { Allow: "POST" } });
	}

	const config = loadIpawsConfig(env);
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
	} catch (error) {
		if (error instanceof IpawsSnsError) return responseError(error.code, error.message, 400);
		return responseError("ipaws_invalid_payload", "Unable to parse SNS envelope.", 400);
	}

	if (!config.allowedTopicArns.includes(message.TopicArn.trim())) {
		return responseError("ipaws_unexpected_topic", "TopicArn is not configured as allowed.", 400);
	}
	try {
		validateSnsTimestamp(message.Timestamp, config.snsMaxAgeSeconds, config.snsMaxFutureSkewSeconds);
	} catch (error) {
		if (error instanceof IpawsSnsError) return responseError(error.code, error.message, 400);
		return responseError("ipaws_invalid_timestamp", "SNS Timestamp is invalid.", 400);
	}

	let signatureResult;
	try {
		signatureResult = await verifySnsSignature(message);
	} catch (error) {
		if (error instanceof IpawsSnsError) return responseError(error.code, error.message, 400);
		return responseError("ipaws_signature_validation_unavailable", "SNS signature validation is temporarily unavailable.", 503);
	}
	if (!signatureResult.valid) {
		if (signatureResult.retryable) {
			return responseError(signatureResult.reason ?? "ipaws_certificate_unavailable", "SNS certificate retrieval is temporarily unavailable.", 503);
		}
		const parseResult: IpawsCapParseResult = {
			status: "parse_failed",
			message: null,
			reason: "invalid_signature_untrusted_payload",
		};
		const messageDigest = await sha256Hex(message.Message);
		await upsertIngestionRecord(
			env,
			message,
			"signature_invalid",
			"",
			"failure",
			parseResult,
			message.TopicArn,
			config.recordTtlSeconds,
			messageDigest,
		);
		await recordIpawsHealthEvent(env, `signature_failed:${signatureResult.reason ?? "unknown"}`, config.healthTtlSeconds);
		return responseError(signatureResult.reason ?? "ipaws_signature_invalid", "SNS signature verification failed.", 400);
	}
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
	try {
		claim = await claimIpawsDelivery(env.IPAWS_IDEMPOTENCY, message.MessageId);
	} catch {
		return responseError("ipaws_idempotency_unavailable", "IPAWS idempotency coordinator is unavailable.", 503);
	}
	if (claim.result === "processing") {
		return response({ status: "error", code: "ipaws_delivery_in_progress", message: "Delivery processing is still in progress." }, {
			status: 503,
			headers: { "Cache-Control": "no-store", "Retry-After": "2" },
		});
	}
	if (claim.result === "complete") {
		try {
			if (await deliveryOutputsComplete(env, message.MessageId)) {
				await recordIpawsHealthEvent(env, "delivery_duplicate", config.healthTtlSeconds);
				return response({ status: "ok", outcome: "duplicate", messageId: message.MessageId }, { headers: { "Cache-Control": "no-store" } });
			}
			claim = await recoverIpawsDelivery(env.IPAWS_IDEMPOTENCY, message.MessageId);
		} catch {
			return responseError("ipaws_recovery_unavailable", "Delivery recovery is temporarily unavailable.", 503);
		}
		if (claim.result !== "acquired") {
			return responseError("ipaws_delivery_in_progress", "Delivery recovery is already in progress.", 503);
		}
	}
	if (claim.result !== "acquired") return responseError("ipaws_idempotency_unavailable", "IPAWS delivery ownership was not acquired.", 503);
	const claimToken = claim.token;

	const parseResult: IpawsCapParseResult = message.Type === "Notification"
		? parseCapPayload(message.Message, config.parseByteLimit)
		: {
			status: "parse_failed" as const,
			message: { source: "unknown", parsed: {} },
			reason: "not_notification",
		};

	try {
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
			if (parseResult.status === "parsed") await stageNormalizedAlert(env, receipt.record, config.recordTtlSeconds);
			// SNS delivers notifications only after the HTTPS subscription is confirmed.
			await writeSubscriptionState(env, "confirmed", config.subscriptionStateTtlSeconds);
			await recordIpawsHealthEvent(env, parseResult.status === "parsed" ? "delivery_notification_parsed" : "delivery_notification_parse_failed", config.healthTtlSeconds, {
				environment: config.environment,
				stagingEnabled: config.enabled,
			});
			await updateIngestionRecord(env, message.MessageId, {
				processingState: parseResult.status === "parsed" ? "notification_done" : "notification_parse_failed",
				parseStatus: parseResult.status,
				parseError: parseResult.status === "parse_failed" ? (parseResult.reason ?? "parse_failed") : null,
				parseResultSummary: parseResult.status,
			}, config.recordTtlSeconds);
			if (!(await deliveryOutputsComplete(env, message.MessageId))) throw new IpawsRetryableError("ipaws_output_verification_failed", "Required notification outputs are not yet visible.");
			if (!(await renewIpawsDelivery(env.IPAWS_IDEMPOTENCY, message.MessageId, claimToken))) throw new IpawsRetryableError("ipaws_stale_delivery_claim", "Delivery ownership expired before completion.");
			if (!(await completeIpawsDelivery(env.IPAWS_IDEMPOTENCY, message.MessageId, claimToken))) throw new IpawsRetryableError("ipaws_stale_delivery_claim", "Delivery ownership changed before completion.");
			return response({ status: "ok", outcome: "accepted", messageId: message.MessageId, ingestionId: receipt.record.id }, { headers: { "Cache-Control": "no-store" } });
		}

		if (message.Type === "UnsubscribeConfirmation") {
			await recordIpawsHealthEvent(env, "unsubscribe_confirmation_received", config.healthTtlSeconds, {
				environment: config.environment,
				stagingEnabled: config.enabled,
			});
			await updateIngestionRecord(env, message.MessageId, {
				processingState: "unsubscribe_received",
				parseStatus: "parse_failed",
				parseError: "unsubscribe_confirmation_no_action",
			}, config.recordTtlSeconds);
			if (!(await deliveryOutputsComplete(env, message.MessageId))) throw new IpawsRetryableError("ipaws_output_verification_failed", "Required unsubscribe output is not yet visible.");
			if (!(await completeIpawsDelivery(env.IPAWS_IDEMPOTENCY, message.MessageId, claimToken))) throw new IpawsRetryableError("ipaws_stale_delivery_claim", "Delivery ownership changed before completion.");
			return response({ status: "ok", outcome: "unsubscribe_recorded", messageId: message.MessageId, ingestionId: receipt.record.id }, { headers: { "Cache-Control": "no-store" } });
		}

		if (!config.autoConfirmSubscription) {
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
			if (!(await deliveryOutputsComplete(env, message.MessageId))) throw new IpawsRetryableError("ipaws_output_verification_failed", "Required subscription output is not yet visible.");
			if (!(await completeIpawsDelivery(env.IPAWS_IDEMPOTENCY, message.MessageId, claimToken))) throw new IpawsRetryableError("ipaws_stale_delivery_claim", "Delivery ownership changed before completion.");
			return response({ status: "ok", outcome: "subscription_confirmation_skipped", messageId: message.MessageId, ingestionId: receipt.record.id }, { headers: { "Cache-Control": "no-store" } });
		}

		await confirmSubscription(message.SubscribeURL ?? "");
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
		if (!(await deliveryOutputsComplete(env, message.MessageId))) throw new IpawsRetryableError("ipaws_output_verification_failed", "Required subscription output is not yet visible.");
		if (!(await completeIpawsDelivery(env.IPAWS_IDEMPOTENCY, message.MessageId, claimToken))) throw new IpawsRetryableError("ipaws_stale_delivery_claim", "Delivery ownership changed before completion.");
		return response({ status: "ok", outcome: "subscription_confirmed", messageId: message.MessageId, ingestionId: receipt.record.id }, { headers: { "Cache-Control": "no-store" } });
	} catch (error) {
		try {
			await releaseIpawsDelivery(env.IPAWS_IDEMPOTENCY, message.MessageId, claimToken);
		} catch (releaseError) {
			logWarn("IPAWS", "Unable to release failed delivery claim", { messageId: message.MessageId, reason: releaseError instanceof Error ? releaseError.message : "unknown" });
		}
		if (error instanceof IpawsSnsError) return responseError(error.code, error.message, 400);
		logWarn("IPAWS", "Retryable IPAWS processing failure", { messageId: message.MessageId, reason: error instanceof Error ? error.message : "unknown" });
		return responseError(error instanceof IpawsRetryableError ? error.code : "ipaws_processing_unavailable", "IPAWS processing is temporarily unavailable.", 503);
	}
}
