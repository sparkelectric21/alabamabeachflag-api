import { afterEach, describe, expect, it, vi } from "vitest";
import { handleIpawsPubSubRequest } from "../src/ipaws/handler";
import { parseCapPayload } from "../src/ipaws/parser";
import { parseSigningString, parseSnsMessage, validateSnsRequired, validateSubscribeUrl, validateType } from "../src/ipaws/sns";
import type { Env } from "../src/types";
import * as sns from "../src/ipaws/sns";

vi.mock("../src/ipaws/sns", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/ipaws/sns")>();
	return {
		...original,
		verifySnsSignature: vi.fn(),
	};
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const CAP_XML = `<?xml version="1.0"?><alert><identifier>CAP-TEST-1</identifier><sender>nws</sender><sent>2026-08-22T16:00:00Z</sent><status>Actual</status><msgType>Alert</msgType><scope>Public</scope><info><event>Test Event</event><headline>Wave Advisory</headline><description>Test</description><urgency>Immediate</urgency><severity>Moderate</severity></info></alert>`;
const CAP_JSON = {
	identifier: "CAP-TEST-JSON",
	event: "Beach Warning",
	status: "Actual",
	msgType: "Alert",
	info: [{ event: "Beach Warning", severity: "Severe", certainty: "Likely" }],
};
const CAP_JSON_STRING = JSON.stringify(CAP_JSON);
const validSubscribeUrl = "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=example-token&TopicArn=arn:aws:sns:us-east-1:123456789012:alabama-beachflag";
const defaultTopicArn = "arn:aws:sns:us-east-1:123456789012:alabama-beachflag";

const baseNotification = {
	Type: "Notification" as const,
	MessageId: "11111111-1111-1111-1111-111111111111",
	Message: CAP_XML,
	Timestamp: "2026-08-22T16:10:00Z",
	TopicArn: "arn:aws:sns:us-east-1:123456789012:alabama-beachflag",
	SigningCertURL: "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-PEM.pem",
	Signature: "AAAA",
	SignatureVersion: "1",
};

function createStore() {
	const map = new Map<string, string>();
	return {
		get: vi.fn(async (key: string) => map.get(key) ?? null),
		put: vi.fn(async (key: string, value: string) => {
			map.set(key, value);
		}),
	};
}

function createEnv(overrides: Partial<Env> = {}) {
	const store = createStore();
	return {
		BEACH_DATA: store,
		IPAWS_INGESTION_ENABLED: "true",
		IPAWS_ENVIRONMENT: "staging",
		IPAWS_PARSE_BYTE_LIMIT: "262144",
		IPAWS_RECORD_TTL_SECONDS: "3600",
		IPAWS_SUBSCRIPTION_TTL_SECONDS: "3600",
		IPAWS_HEALTH_TTL_SECONDS: "3600",
		IPAWS_AUTO_CONFIRM_SUBSCRIPTION: "false",
		IPAWS_ALLOWED_TOPIC_ARNS: defaultTopicArn,
		...overrides,
	} as Env & { BEACH_DATA: ReturnType<typeof createStore> };
}

describe("IPAWS CAP parser", () => {
	it("parses CAP XML with event fields", () => {
		const parsed = parseCapPayload(CAP_XML);
		expect(parsed.status).toBe("parsed");
		expect(parsed.message.parsed.identifier).toBe("CAP-TEST-1");
		expect(parsed.message.source).toBe("cap");
	});

	it("parses CAP JSON fixture defensively", () => {
		const parsed = parseCapPayload(CAP_JSON_STRING);
		expect(parsed.status).toBe("parsed");
		expect(parsed.message.source).toBe("json");
		expect(parsed.message.parsed.event).toBe("Beach Warning");
		expect(parsed.message.parsed.info?.[0]?.severity).toBe("Severe");
	});

	it("rejects malformed XML payloads safely", () => {
		expect(parseCapPayload("<alert><identifier></alert>")).toMatchObject({ status: "parse_failed" });
	});
});

describe("IPAWS SNS validation utilities", () => {
	it("builds deterministic signing strings", () => {
		const signing = parseSigningString(parseSnsMessage({
			...baseNotification,
			Type: "Notification",
			Message: "msg",
			MessageId: "msg-id",
			Timestamp: "2026-08-22T16:00:00.000Z",
			TopicArn: "arn:1",
			Subject: "hello",
		}));
		expect(signing).toBe("Subject\nhello\nMessage\nmsg\nMessageId\nmsg-id\nTimestamp\n2026-08-22T16:00:00.000Z\nTopicArn\narn:1\nType\nNotification\n");
	});

	it("accepts valid SNS types and rejects others", () => {
		expect(() => validateType("Notification")).not.toThrow();
		expect(() => validateType("NotAType" as never)).toThrow("Unsupported SNS Type");
	});

	it("rejects unsafe SubscribeURL values", () => {
		expect(() => validateSubscribeUrl("http://example.com/")).toThrow("unsafe_upstream_url");
		expect(() => validateSubscribeUrl("https://sns.example.com/?Action=ConfirmSubscription&Token=t&TopicArn=a")).toThrow("Unexpected AWS hostname");
	});

	it("validates required SNS fields", () => {
		expect(() => validateSnsRequired(parseSnsMessage(baseNotification))).not.toThrow();
		expect(() => parseSnsMessage({ ...baseNotification, MessageId: "" })).toThrow();
	});
});

describe("IPAWS pub/sub handler", () => {
	it("fails closed when TopicArn allowlist is not configured", async () => {
		const verify = vi.spyOn(sns, "verifySnsSignature").mockResolvedValue({ valid: true, reason: undefined, algorithm: "SHA-1" });
		const response = await handleIpawsPubSubRequest(new Request("https://example.com/v1/ipaws/pubsub", {
			method: "POST",
			body: JSON.stringify({ ...baseNotification, Message: CAP_JSON_STRING }),
		}), createEnv({ IPAWS_ALLOWED_TOPIC_ARNS: "" }));
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ code: "ipaws_misconfigured" });
		expect(verify).not.toHaveBeenCalled();
	});

	it("rejects oversized envelopes", async () => {
		const oversize = JSON.stringify({
			...baseNotification,
			Message: "x".repeat(600_000),
			MessageId: "99999999-9999-9999-9999-999999999999",
		});
		const response = await handleIpawsPubSubRequest(new Request("https://example.com/v1/ipaws/pubsub", {
			method: "POST",
			body: oversize,
			headers: { "content-type": "application/json", "content-length": String(oversize.length) },
		}), createEnv());
		expect(response.status).toBe(413);
	});

	it("rejects unsupported methods", async () => {
		const response = await handleIpawsPubSubRequest(new Request("https://example.com/v1/ipaws/pubsub", { method: "GET" }), createEnv());
		expect(response.status).toBe(405);
	});

	it("rejects missing body and malformed JSON", async () => {
		const env = createEnv();
		const empty = await handleIpawsPubSubRequest(new Request("https://example.com/v1/ipaws/pubsub", { method: "POST" }), env);
		expect(empty.status).toBe(400);
		const badJson = await handleIpawsPubSubRequest(new Request("https://example.com/v1/ipaws/pubsub", { method: "POST", body: "[{" }), env);
		expect(badJson.status).toBe(400);
	});

	it("persists duplicate notifications as successful idempotent acknowledgements", async () => {
		const verify = vi.spyOn(sns, "verifySnsSignature").mockResolvedValue({ valid: true, reason: undefined, algorithm: "SHA-1" });
		const env = createEnv();
		const requestBody = JSON.stringify({ ...baseNotification, Message: CAP_JSON_STRING });
		const request = new Request("https://example.com/v1/ipaws/pubsub", { method: "POST", body: requestBody });
		const first = await handleIpawsPubSubRequest(request, env);
		const second = await handleIpawsPubSubRequest(new Request("https://example.com/v1/ipaws/pubsub", { method: "POST", body: requestBody }), env);
		const firstBody = await first.json() as { status: string; outcome: string };
		const secondBody = await second.json() as { status: string; outcome: string };
		expect(firstBody.status).toBe("ok");
		expect(firstBody.outcome).toBe("accepted");
		expect(secondBody.outcome).toBe("duplicate");
		expect(verify).toHaveBeenCalled();
	});

	it("fails closed on invalid signatures", async () => {
		const verify = vi.spyOn(sns, "verifySnsSignature").mockResolvedValue({ valid: false, reason: "ipaws_signature_mismatch" });
		const env = createEnv();
		const response = await handleIpawsPubSubRequest(new Request("https://example.com/v1/ipaws/pubsub", {
			method: "POST",
			body: JSON.stringify(baseNotification),
		}), env);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ code: "ipaws_signature_mismatch" });
		expect(verify).toHaveBeenCalled();
	});

	it("safely handles subscription confirmations and respects auto-confirm flag", async () => {
		const verify = vi.spyOn(sns, "verifySnsSignature").mockResolvedValue({ valid: true, reason: undefined, algorithm: "SHA-1" });
		const confirmation = {
			...baseNotification,
			Type: "SubscriptionConfirmation" as const,
			Message: "subscribe",
			Token: "token",
			SubscribeURL: validSubscribeUrl,
		};
		const env = createEnv();
		const skipped = await handleIpawsPubSubRequest(new Request("https://example.com/v1/ipaws/pubsub", {
			method: "POST",
			body: JSON.stringify(confirmation),
		}), env);
		expect(skipped.status).toBe(200);
		expect(await skipped.json()).toMatchObject({ outcome: "subscription_confirmation_skipped" });
		expect(verify).toHaveBeenCalled();

		const envAuto = createEnv({ IPAWS_AUTO_CONFIRM_SUBSCRIPTION: "true" } as Partial<Env>);
		const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const confirmed = await handleIpawsPubSubRequest(new Request("https://example.com/v1/ipaws/pubsub", {
			method: "POST",
			body: JSON.stringify({
				...confirmation,
				MessageId: "22222222-2222-2222-2222-222222222222",
				SubscribeURL: validSubscribeUrl,
			}),
		}), envAuto);
		expect(confirmed.status).toBe(200);
		expect(await confirmed.json()).toMatchObject({ outcome: "subscription_confirmed" });
	});

	it("rejects unsafe subscription URLs", async () => {
		const verify = vi.spyOn(sns, "verifySnsSignature").mockResolvedValue({ valid: true, reason: undefined, algorithm: "SHA-1" });
		const env = createEnv();
		const response = await handleIpawsPubSubRequest(new Request("https://example.com/v1/ipaws/pubsub", {
			method: "POST",
			body: JSON.stringify({
				...baseNotification,
				Type: "SubscriptionConfirmation" as const,
				Message: "subscribe",
				Token: "token",
				SubscribeURL: "https://example.com/?Action=ConfirmSubscription&Token=t&TopicArn=a",
			}),
		}), env);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ code: "ipaws_invalid_aws_hostname" });
		expect(verify).toHaveBeenCalled();
	});

	it("rejects subscription URLs for a different TopicArn", async () => {
		const verify = vi.spyOn(sns, "verifySnsSignature").mockResolvedValue({ valid: true, reason: undefined, algorithm: "SHA-1" });
		const env = createEnv();
		const response = await handleIpawsPubSubRequest(new Request("https://example.com/v1/ipaws/pubsub", {
			method: "POST",
			body: JSON.stringify({
				...baseNotification,
				Type: "SubscriptionConfirmation" as const,
				Message: "subscribe",
				Token: "token",
				SubscribeURL: "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=example-token&TopicArn=arn:aws:sns:us-east-1:123456789012:other-topic",
			}),
		}), env);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ code: "ipaws_invalid_subscribe_url" });
		expect(verify).toHaveBeenCalled();
	});
});
