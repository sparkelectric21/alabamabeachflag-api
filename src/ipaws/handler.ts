import type { Env } from "../types";
import { loadIpawsConfig } from "./config";
import { parseCapPayload } from "./parser";
import type { IpawsCapParseResult } from "./types";
import { updateIngestionRecord, upsertIngestionRecord, writeSubscriptionState } from "./persistence";
import { recordIpawsHealthEvent } from "./health";
import { IpawsSnsError, parseSnsMessage, validateSubscribeUrl, verifySnsSignature } from "./sns";
import { logWarn } from "../utils/logger";

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

async function confirmSubscription(url: string): Promise<boolean> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), SUBSCRIPTION_CONFIRM_TIMEOUT_MS);
	try {
		const confirm = await fetch(url, { method: "GET", redirect: "manual", signal: controller.signal });
		return confirm.ok;
	} finally {
		clearTimeout(timer);
	}
}

function response(body: unknown, init: ResponseInit = {}): Response {
	return Response.json(body, { ...init, headers: { "Content-Type": "application/json; charset=utf-8", ...init.headers } });
}

function responseError(code: string, message: string, status: number) {
	return response({ status: "error", code, message }, { status, headers: { "Cache-Control": "no-store" } });
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

	const signatureResult = await verifySnsSignature(message);
	if (!signatureResult.valid) {
		const parseResult = parseCapPayload(message.Message, config.parseByteLimit);
		await upsertIngestionRecord(
			env,
			message,
			"signature_invalid",
			message.Message,
			"failure",
			parseResult,
			message.TopicArn,
			config.recordTtlSeconds,
		);
		await recordIpawsHealthEvent(env, `signature_failed:${signatureResult.reason ?? "unknown"}`, config.healthTtlSeconds);
		return responseError(signatureResult.reason ?? "ipaws_signature_invalid", "SNS signature verification failed.", 400);
	}

	const parseResult: IpawsCapParseResult = message.Type === "Notification"
		? parseCapPayload(message.Message, config.parseByteLimit)
		: {
			status: "parse_failed" as const,
			message: { source: "unknown", parsed: {} },
			reason: "not_notification",
		};

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
	if (receipt.duplicate) {
		await recordIpawsHealthEvent(env, "delivery_duplicate", config.healthTtlSeconds);
		return response({ status: "ok", outcome: "duplicate", messageId: message.MessageId, ingestionId: receipt.record.id }, { headers: { "Cache-Control": "no-store" } });
	}

	if (message.Type === "Notification") {
		await updateIngestionRecord(
			env,
			message.MessageId,
			{
				processingState: parseResult.status === "parsed" ? "notification_done" : "notification_parse_failed",
				parseStatus: parseResult.status,
				parseError: parseResult.status === "parse_failed" ? (parseResult.reason ?? "parse_failed") : null,
				parseResultSummary: parseResult.status,
			},
			config.recordTtlSeconds,
		);
		await recordIpawsHealthEvent(env, parseResult.status === "parsed" ? "delivery_notification_parsed" : "delivery_notification_parse_failed", config.healthTtlSeconds, {
			environment: config.environment,
			stagingEnabled: config.enabled,
		});
		return response({ status: "ok", outcome: "accepted", messageId: message.MessageId, ingestionId: receipt.record.id }, { headers: { "Cache-Control": "no-store" } });
	}

	if ((message.Type === "SubscriptionConfirmation" || message.Type === "UnsubscribeConfirmation") && !message.SubscribeURL) {
		await updateIngestionRecord(env, message.MessageId, {
			processingState: "subscription_received",
			parseStatus: "parse_failed",
			parseError: "missing_subscribe_url",
		}, config.recordTtlSeconds);
		return responseError("ipaws_missing_subscribe_url", "SubscribeURL is required.", 400);
	}

	if (message.Type === "SubscriptionConfirmation" || message.Type === "UnsubscribeConfirmation") {
		try {
			validateSubscribeUrl(message.SubscribeURL!);
			const url = new URL(message.SubscribeURL!);
			if (url.searchParams.get("TopicArn") !== message.TopicArn) {
				return responseError("ipaws_invalid_subscribe_url", "SubscribeURL TopicArn does not match message TopicArn.", 400);
			}
		} catch (error) {
			if (error instanceof IpawsSnsError) {
				await updateIngestionRecord(env, message.MessageId, {
					processingState: "subscription_skipped",
					parseStatus: "parse_failed",
					parseError: error.message,
				}, config.recordTtlSeconds);
				return responseError(error.code, error.message, 400);
			}
		}
		if (!config.autoConfirmSubscription) {
			await writeSubscriptionState(env, "skipped", config.subscriptionStateTtlSeconds);
			await updateIngestionRecord(env, message.MessageId, {
				processingState: "subscription_skipped",
				parseStatus: "parse_failed",
				parseError: "subscription_confirmation_disabled",
			}, config.recordTtlSeconds);
			await recordIpawsHealthEvent(env, "subscription_confirmation_disabled", config.healthTtlSeconds, {
				environment: config.environment,
				stagingEnabled: config.enabled,
			});
			return response({ status: "ok", outcome: "subscription_confirmation_skipped", messageId: message.MessageId, ingestionId: receipt.record.id }, { headers: { "Cache-Control": "no-store" } });
		}

		try {
			if (!(await confirmSubscription(message.SubscribeURL ?? ""))) {
				throw new Error("ipaws_subscription_confirm_failed");
			}
			await writeSubscriptionState(env, "confirmed", config.subscriptionStateTtlSeconds);
			await updateIngestionRecord(env, message.MessageId, {
				processingState: "subscription_confirmed",
				parseStatus: "parse_failed",
				parseError: null,
			}, config.recordTtlSeconds);
			await recordIpawsHealthEvent(env, "subscription_confirmed", config.healthTtlSeconds, {
				environment: config.environment,
				stagingEnabled: config.enabled,
			});
			return response({ status: "ok", outcome: "subscription_confirmed", messageId: message.MessageId, ingestionId: receipt.record.id }, { headers: { "Cache-Control": "no-store" } });
		} catch (error) {
			await writeSubscriptionState(env, "unknown", config.subscriptionStateTtlSeconds);
			await updateIngestionRecord(env, message.MessageId, {
				processingState: "subscription_skipped",
				parseStatus: "parse_failed",
				parseError: error instanceof Error ? error.message : "subscription_confirmation_failed",
			}, config.recordTtlSeconds);
			logWarn("IPAWS", "Subscription confirmation failed", { reason: error instanceof Error ? error.message : "unknown", messageId: message.MessageId });
			return responseError("ipaws_subscription_confirmation_failed", "Unable to confirm subscription URL.", 400);
		}
	}

	await recordIpawsHealthEvent(env, "unsupported_type", config.healthTtlSeconds, {
		environment: config.environment,
		stagingEnabled: config.enabled,
	});
	await updateIngestionRecord(env, message.MessageId, {
		processingState: "unsupported_type",
		parseStatus: "parse_failed",
		parseError: `Unsupported SNS Type: ${message.Type}`,
	}, config.recordTtlSeconds);
	return responseError("ipaws_unsupported_type", "Unsupported SNS message type.", 400);
}
