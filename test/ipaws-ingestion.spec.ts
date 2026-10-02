import { afterEach, describe, expect, it, vi } from "vitest";
import { handleIpawsPubSubRequest } from "../src/ipaws/handler";
import { IpawsIdempotencyCoordinator } from "../src/ipaws/idempotency";
import { parseCapPayload } from "../src/ipaws/parser";
import { normalizeIpawsAlert } from "../src/ipaws/domain";
import { upsertIngestionRecord } from "../src/ipaws/persistence";
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
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const CAP_XML = `<?xml version="1.0"?><alert xmlns="urn:oasis:names:tc:emergency:cap:1.2"><identifier>CAP-TEST-1</identifier><sender>nws</sender><sent>2026-08-22T16:00:00Z</sent><status>Actual</status><msgType>Alert</msgType><scope>Public</scope><info><event>Test Event</event><headline>Wave Advisory</headline><description>Test</description><urgency>Immediate</urgency><severity>Moderate</severity></info></alert>`;
const CAP_JSON = {
	identifier: "CAP-TEST-JSON",
	event: "Beach Warning",
	status: "Actual",
	msgType: "Alert",
	info: [{ event: "Beach Warning", severity: "Severe", certainty: "Likely" }],
};
const CAP_JSON_STRING = JSON.stringify(CAP_JSON);
const validSubscribeUrl = "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=token&TopicArn=arn:aws:sns:us-east-1:123456789012:alabama-beachflag";
const defaultTopicArn = "arn:aws:sns:us-east-1:123456789012:alabama-beachflag";

const baseNotification = {
	Type: "Notification" as const,
	MessageId: "11111111-1111-1111-1111-111111111111",
	Message: CAP_XML,
	Timestamp: new Date().toISOString(),
	TopicArn: "arn:aws:sns:us-east-1:123456789012:alabama-beachflag",
	SigningCertURL: "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-PEM.pem",
	Signature: "AAAA",
	SignatureVersion: "1",
};

function createStore() {
	const map = new Map<string, string>();
	const failNextPut = new Set<string>();
	const failPutNumber = new Map<string, number>();
	const putCounts = new Map<string, number>();
	return {
		get: vi.fn(async (key: string) => map.get(key) ?? null),
		put: vi.fn(async (key: string, value: string) => {
			if ([...failNextPut].some((prefix) => key.startsWith(prefix))) { failNextPut.clear(); throw new Error("injected_kv_failure"); }
			for (const [prefix, failureNumber] of failPutNumber) {
				if (!key.startsWith(prefix)) continue;
				const count = (putCounts.get(prefix) ?? 0) + 1;
				putCounts.set(prefix, count);
				if (count === failureNumber) throw new Error("injected_kv_failure");
			}
			map.set(key, value);
		}),
		delete: vi.fn(async (key: string) => map.delete(key)),
		map,
		failNextPut,
		failPutNumber,
	};
}

function createEnv(overrides: Partial<Env> = {}) {
	const store = createStore();
	const claims = new Map<string, { status: "processing"; token: string } | { status: "complete" }>();
	const metricsEvents: unknown[] = [];
	const metricsCorrelations: unknown[] = [];
	const metricsControl = { fail: false, claimFailures: 0 };
	const idempotency = {
		idFromName: (name: string) => name,
		get: (id: string) => ({
			fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const path = new URL(String(input)).pathname;
				if (path === "/metrics/record") {
					if (metricsControl.fail) throw new Error("injected_metrics_failure");
					const body = JSON.parse(String(init?.body ?? "{}"));
					metricsEvents.push(body.event);
					if (body.correlation) metricsCorrelations.push(body.correlation);
					return new Response(null, { status: 204 });
				}
				if (path === "/claim") {
					if (metricsControl.claimFailures > 0) { metricsControl.claimFailures--; throw new Error("injected_claim_failure"); }
					if (claims.get(id)?.status === "complete") return Response.json({ result: "complete" });
					if (claims.has(id)) return Response.json({ result: "processing" });
					const token = crypto.randomUUID();
					claims.set(id, { status: "processing", token });
					return Response.json({ result: "acquired", token });
				}
				if (path === "/recover") {
					if (claims.get(id)?.status === "processing") return Response.json({ result: "processing" });
					const token = crypto.randomUUID();
					claims.set(id, { status: "processing", token });
					return Response.json({ result: "acquired", token });
				}
				const token = JSON.parse(String(init?.body ?? "{}"))?.token;
				const current = claims.get(id);
				if (current?.status !== "processing" || current.token !== token) return Response.json({ result: "stale" }, { status: 409 });
				if (path === "/complete") claims.set(id, { status: "complete" });
				if (path === "/release") claims.delete(id);
				return new Response(null, { status: 204 });
			}),
		}),
	};
	return {
		BEACH_DATA: store,
		IPAWS_IDEMPOTENCY: idempotency as unknown as DurableObjectNamespace,
		IPAWS_INGESTION_ENABLED: "true",
		IPAWS_ENVIRONMENT: "staging",
		IPAWS_PARSE_BYTE_LIMIT: "262144",
		IPAWS_RECORD_TTL_SECONDS: "3600",
		IPAWS_SUBSCRIPTION_TTL_SECONDS: "3600",
		IPAWS_HEALTH_TTL_SECONDS: "3600",
		IPAWS_AUTO_CONFIRM_SUBSCRIPTION: "false",
		IPAWS_ALLOWED_TOPIC_ARNS: defaultTopicArn,
		...overrides,
		metricsEvents,
		metricsCorrelations,
		metricsControl,
	} as Env & { BEACH_DATA: ReturnType<typeof createStore>; metricsEvents: unknown[]; metricsCorrelations: unknown[]; metricsControl: { fail: boolean; claimFailures: number } };
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

	it("classifies authenticated unsupported structures separately from malformed supported formats", () => {
		expect(parseCapPayload("[]")).toMatchObject({ status: "unsupported", reason: "authenticated_structure_unsupported", unsupportedClass: "json_array" });
		expect(parseCapPayload("true")).toMatchObject({ status: "unsupported", unsupportedClass: "json_scalar" });
		expect(parseCapPayload("not-json-or-xml")).toMatchObject({ status: "unsupported", unsupportedClass: "opaque_text" });
		expect(parseCapPayload("{\"identifier\":" )).toMatchObject({ status: "parse_failed", reason: "json_payload_malformed" });
		expect(parseCapPayload("<alert>")).toMatchObject({ status: "parse_failed" });
	});

	it("rejects malformed XML payloads safely", () => {
		expect(parseCapPayload("<alert><identifier></alert>")).toMatchObject({ status: "parse_failed" });
	});

	it("rejects namespace confusion and entity-bearing documents", () => {
		expect(parseCapPayload(CAP_XML.replace("urn:oasis:names:tc:emergency:cap:1.2", "https://attacker.example/cap"))).toMatchObject({ status: "parse_failed" });
		expect(parseCapPayload(`<!DOCTYPE alert [<!ENTITY x "injected">]><alert xmlns="urn:oasis:names:tc:emergency:cap:1.2"><identifier>&x;</identifier></alert>`)).toMatchObject({ status: "parse_failed" });
	});

	it("rejects excessive XML depth, node count, nesting, truncation, and a prohibited DTD", () => {
		const namespace = "urn:oasis:names:tc:emergency:cap:1.2";
		expect(parseCapPayload(`<alert xmlns="${namespace}">${"<x>".repeat(33)}${"</x>".repeat(33)}</alert>`)).toMatchObject({ status: "parse_failed", reason: "xml_complexity_limit" });
		expect(parseCapPayload(`<alert xmlns="${namespace}">${"<x/>".repeat(4_097)}</alert>`)).toMatchObject({ status: "parse_failed", reason: "xml_complexity_limit" });
		expect(parseCapPayload(CAP_XML.replace("<identifier>CAP-TEST-1</identifier>", "<wrapper><identifier>CAP-TEST-1</identifier></wrapper>"))).toMatchObject({ status: "parse_failed", reason: "cap_missing_required_field" });
		expect(parseCapPayload(CAP_XML.slice(0, -8))).toMatchObject({ status: "parse_failed" });
		const withDoctype = CAP_XML.replace("<?xml version=\"1.0\"?>", `<?xml version="1.0"?><!DOCTYPE alert [<!ENTITY capid "CAP-TEST-1">]>`).replace("CAP-TEST-1", "&capid;");
		expect(parseCapPayload(withDoctype)).toMatchObject({ status: "parse_failed", reason: "unsafe_xml_doctype" });
	});

	it("enforces the CAP byte limit before parsing", () => {
		expect(parseCapPayload(CAP_XML, 32)).toMatchObject({ status: "parse_failed", reason: "payload_too_large" });
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
		expect(() => validateType("NotAType" as never)).toThrow("SNS Type is unsupported.");
	});

	it("rejects unsafe SubscribeURL values", () => {
		expect(() => validateSubscribeUrl("http://example.com/")).toThrow("unsafe_upstream_url");
		expect(() => validateSubscribeUrl("https://sns.example.com/?Action=ConfirmSubscription&Token=t&TopicArn=a")).toThrow("Signing URL hostname is not an approved SNS endpoint.");
	});

	it("validates required SNS fields", () => {
		expect(() => validateSnsRequired(parseSnsMessage(baseNotification))).not.toThrow();
		expect(() => parseSnsMessage({ ...baseNotification, MessageId: "" })).toThrow();
	});
});

describe("IPAWS pub/sub handler", () => {
	it("returns a fixed bounded response for a very large attacker-controlled SNS Type", async () => {
		const env = createEnv();
		const attackerValue = `https://attacker.invalid/${"secret".repeat(20_000)}`;
		const response = await handleIpawsPubSubRequest(new Request("https://example.com/v1/ipaws/pubsub", {
			method: "POST", body: JSON.stringify({ ...baseNotification, Type: attackerValue }),
		}), env);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ status: "error", code: "ipaws_unsupported_sns_type", message: "SNS request validation failed." });
		expect(Number(response.headers.get("content-length")) || 0).toBeLessThan(256);
		expect(JSON.stringify(env.metricsEvents)).not.toContain(attackerValue);
	});

	it("fails closed for an unrecognized environment instead of relabeling it as staging", async () => {
		const env = createEnv({ IPAWS_ENVIRONMENT: "preview" });
		const response = await handleIpawsPubSubRequest(new Request("https://example.com/v1/ipaws/pubsub", {
			method: "POST", body: JSON.stringify(baseNotification),
		}), env);
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ status: "error", code: "ipaws_unexpected_exception", message: "IPAWS processing is temporarily unavailable." });
		expect(env.BEACH_DATA.map.size).toBe(0);
	});

	it("records validated environment provenance and refuses cross-environment normalization", async () => {
		const env = createEnv();
		const parsed = parseCapPayload(CAP_JSON_STRING);
		const staging = await upsertIngestionRecord(env, baseNotification, "staging", "signature_verified", CAP_JSON_STRING, "success", parsed, baseNotification.TopicArn, 3600);
		expect(staging.record.environment).toBe("staging");
		expect(normalizeIpawsAlert(staging.record).environment).toBe("staging");
		await expect(upsertIngestionRecord(env, baseNotification, "production", "signature_verified", CAP_JSON_STRING, "success", parsed, baseNotification.TopicArn, 3600))
			.rejects.toThrow("ipaws_ingestion_environment_mismatch");
		const productionMessage = { ...baseNotification, MessageId: "22222222-2222-2222-2222-222222222222" };
		const production = await upsertIngestionRecord(env, productionMessage, "production", "signature_verified", CAP_JSON_STRING, "success", parsed, productionMessage.TopicArn, 3600);
		expect(normalizeIpawsAlert(production.record).environment).toBe("production");
		await expect(upsertIngestionRecord(env, productionMessage, "staging", "signature_verified", CAP_JSON_STRING, "success", parsed, productionMessage.TopicArn, 3600))
			.rejects.toThrow("ipaws_ingestion_environment_mismatch");
	});

	it("upgrades a matching legacy authenticated record but rejects ambiguous legacy data", async () => {
		const env = createEnv();
		const parsed = parseCapPayload(CAP_JSON_STRING);
		const current = await upsertIngestionRecord(env, baseNotification, "staging", "signature_verified", CAP_JSON_STRING, "success", parsed, baseNotification.TopicArn, 3600);
		const legacy = { ...current.record } as Partial<typeof current.record>;
		delete legacy.environment;
		env.BEACH_DATA.map.set(`ipaws:ingest:${baseNotification.MessageId}`, JSON.stringify(legacy));
		expect((await upsertIngestionRecord(env, baseNotification, "production", "signature_verified", CAP_JSON_STRING, "success", parsed, baseNotification.TopicArn, 3600)).record.environment).toBe("production");
		env.BEACH_DATA.map.set(`ipaws:ingest:${baseNotification.MessageId}`, JSON.stringify({ ...legacy, rawMessage: "different" }));
		await expect(upsertIngestionRecord(env, baseNotification, "staging", "signature_verified", CAP_JSON_STRING, "success", parsed, baseNotification.TopicArn, 3600))
			.rejects.toThrow("ipaws_legacy_ingestion_record_mismatch");
	});
	it("fences stale owners after lease expiry and permits only the current owner to complete", async () => {
		const values = new Map<string, unknown>();
		const storage = {
			get: async (key: string) => values.get(key), put: async (key: string, value: unknown) => { values.set(key, value); },
			delete: async (key: string) => values.delete(key), transaction: async (callback: (transaction: unknown) => unknown) => callback(storage),
		};
		const coordinator = new IpawsIdempotencyCoordinator({ storage } as unknown as DurableObjectState);
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-23T12:00:00Z"));
		const first = await (await coordinator.fetch(new Request("https://idempotency.internal/claim"))).json() as { result: string; token: string };
		expect(first).toMatchObject({ result: "acquired" });
		expect(await (await coordinator.fetch(new Request("https://idempotency.internal/claim"))).json()).toEqual({ result: "processing" });
		vi.advanceTimersByTime(60_001);
		const second = await (await coordinator.fetch(new Request("https://idempotency.internal/claim"))).json() as { result: string; token: string };
		expect(second).toMatchObject({ result: "acquired", recovered: true });
		expect(second.token).not.toBe(first.token);
		const mutate = (action: string, token: string) => coordinator.fetch(new Request(`https://idempotency.internal/${action}`, {
			method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }),
		}));
		expect((await mutate("release", first.token)).status).toBe(409);
		expect((await mutate("complete", first.token)).status).toBe(409);
		const beforeRenew = values.get("state");
		expect((await mutate("renew", first.token)).status).toBe(409);
		expect(values.get("state")).toEqual(beforeRenew);
		expect(await (await coordinator.fetch(new Request("https://idempotency.internal/claim"))).json()).toEqual({ result: "processing" });
		expect((await mutate("complete", second.token)).status).toBe(200);
		expect(await (await coordinator.fetch(new Request("https://idempotency.internal/claim"))).json()).toEqual({ result: "complete" });
		vi.useRealTimers();
	});
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
		expect(env.metricsEvents).toEqual([
			expect.objectContaining({ handlerOutcome: "invalid_request", rejection: "permanent" }),
			expect.objectContaining({ handlerOutcome: "invalid_request", rejection: "permanent" }),
		]);
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
		expect(env.metricsEvents).toEqual([
			expect.objectContaining({ handlerOutcome: "accepted", idempotency: ["acquired", "completion"], normalizedRecord: ["success"] }),
			expect.objectContaining({ handlerOutcome: "duplicate", idempotency: ["completed_duplicate"], normalizedRecord: ["not_applicable"] }),
		]);
	});

	it("records validation failures using only bounded metric dimensions", async () => {
		const env = createEnv();
		const response = await handleIpawsPubSubRequest(new Request("https://example.com/v1/ipaws/pubsub", {
			method: "POST", body: JSON.stringify({ ...baseNotification, TopicArn: "arn:aws:sns:us-east-1:000000000000:secret-topic" }),
		}), env);
		expect(response.status).toBe(400);
		expect(env.metricsEvents).toEqual([expect.objectContaining({
			httpStatus: "4xx", handlerOutcome: "security_rejection", topicArnValidation: "failure", rejection: "permanent",
			signature: "not_attempted", idempotency: ["not_reached"],
		})]);
		const serialized = JSON.stringify(env.metricsEvents);
		expect(serialized).not.toContain("secret-topic");
		expect(serialized).not.toContain(baseNotification.MessageId);
		expect(serialized).not.toContain(baseNotification.Signature);
	});

	it("does not fail an otherwise valid delivery when the metrics write fails", async () => {
		vi.spyOn(sns, "verifySnsSignature").mockResolvedValue({ valid: true, algorithm: "SHA-256" });
		const env = createEnv();
		env.metricsControl.fail = true;
		const background: Promise<unknown>[] = [];
		const ctx = { waitUntil: vi.fn((promise: Promise<unknown>) => { background.push(promise); }) };
		const response = await handleIpawsPubSubRequest(new Request("https://example.com/v1/ipaws/pubsub", {
			method: "POST", body: JSON.stringify({ ...baseNotification, SignatureVersion: "2", Message: CAP_JSON_STRING }),
		}), env, ctx);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ outcome: "accepted" });
		expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
		await expect(Promise.all(background)).resolves.toEqual([undefined]);
	});

	it("classifies an initial claim failure and correlates a later accepted retry without exposing the identifier", async () => {
		vi.spyOn(sns, "verifySnsSignature").mockResolvedValue({ valid: true, algorithm: "SHA-256" });
		const env = createEnv(); env.metricsControl.claimFailures = 1;
		const body = JSON.stringify({ ...baseNotification, SignatureVersion: "2", Message: CAP_JSON_STRING });
		expect((await handleIpawsPubSubRequest(new Request("https://example.com/v1/ipaws/pubsub", { method: "POST", body }), env)).status).toBe(503);
		const accepted = await handleIpawsPubSubRequest(new Request("https://example.com/v1/ipaws/pubsub", { method: "POST", body }), env);
		expect(accepted.status).toBe(200);
		expect(JSON.stringify(await accepted.json())).not.toContain(baseNotification.MessageId);
		expect(env.metricsEvents[0]).toEqual(expect.objectContaining({ failureStage: "initial_idempotency_claim", failureClass: "idempotency_unavailable" }));
		expect(env.metricsCorrelations.map((item) => (item as { action: string }).action)).toEqual(["preclaim_failure", "accepted"]);
		expect(JSON.stringify(env.metricsEvents)).not.toContain(baseNotification.MessageId);
	});

	it("retains an unresolved initial-claim failure without claiming retry resolution", async () => {
		vi.spyOn(sns, "verifySnsSignature").mockResolvedValue({ valid: true, algorithm: "SHA-256" });
		const env = createEnv(); env.metricsControl.claimFailures = 1;
		const body = JSON.stringify({ ...baseNotification, SignatureVersion: "2", Message: CAP_JSON_STRING });
		expect((await handleIpawsPubSubRequest(new Request("https://example.com/v1/ipaws/pubsub", { method: "POST", body }), env)).status).toBe(503);
		expect(env.metricsCorrelations).toHaveLength(1);
		expect(env.metricsCorrelations[0]).toEqual(expect.objectContaining({ action: "preclaim_failure" }));
	});

	it("returns a sanitized 503 and records an unexpected exception", async () => {
		const env = createEnv();
		Object.defineProperty(env, "IPAWS_ALLOWED_TOPIC_ARNS", { get: () => { throw new Error("secret-config-value"); } });
		const response = await handleIpawsPubSubRequest(new Request("https://example.com/v1/ipaws/pubsub", { method: "POST", body: "{}" }), env);
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ status: "error", code: "ipaws_unexpected_exception", message: "IPAWS processing is temporarily unavailable." });
		expect(env.metricsEvents).toEqual([expect.objectContaining({ handlerOutcome: "unexpected_exception", unexpectedException: true })]);
		expect(JSON.stringify(env.metricsEvents)).not.toContain("secret-config-value");
	});

	it("serializes concurrent duplicate deliveries and stages one normalized alert", async () => {
		vi.spyOn(sns, "verifySnsSignature").mockResolvedValue({ valid: true, algorithm: "SHA-256" });
		const env = createEnv();
		const body = JSON.stringify({ ...baseNotification, SignatureVersion: "2", Message: CAP_JSON_STRING });
		const responses = await Promise.all(Array.from({ length: 8 }, () => handleIpawsPubSubRequest(new Request("https://example.com/v1/ipaws/pubsub", { method: "POST", body }), env)));
		const outcomes = await Promise.all(responses.map((item) => item.json() as Promise<{ outcome?: string; code?: string }>));
		expect(outcomes.filter((item) => item.outcome === "accepted")).toHaveLength(1);
		expect(outcomes.filter((item) => item.code === "ipaws_delivery_in_progress")).toHaveLength(7);
		const normalizedWrites = env.BEACH_DATA.put.mock.calls.filter(([key]) => String(key).startsWith("ipaws:normalized:"));
		expect(normalizedWrites).toHaveLength(1);
		const normalized = JSON.parse(String(normalizedWrites[0]?.[1]));
		expect(normalized).toMatchObject({ source: "fema-ipaws", environment: "staging", handoffState: "staged", notificationsEnabled: false });
		expect(env.BEACH_DATA.put).toHaveBeenCalledWith("ipaws:subscription:state", "confirmed", expect.any(Object));
	});

	it("does not expose internal ownership tokens in responses, persisted records, or logs", async () => {
		vi.spyOn(sns, "verifySnsSignature").mockResolvedValue({ valid: true, algorithm: "SHA-256" });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const env = createEnv();
		const body = JSON.stringify({ ...baseNotification, SignatureVersion: "2", Message: CAP_JSON_STRING });
		const response = await handleIpawsPubSubRequest(new Request("https://example.com/v1/ipaws/pubsub", { method: "POST", body }), env);
		const responseText = await response.text();
		const persisted = [...env.BEACH_DATA.map.values()].join("\n");
		expect(responseText).not.toMatch(/token/i);
		expect(persisted).not.toMatch(/token/i);
		expect(JSON.stringify(warn.mock.calls)).not.toMatch(/token/i);
	});

	it.each(["ipaws:ingest:", "ipaws:normalized:"])("releases the claim and recovers after a %s write failure", async (prefix) => {
		vi.spyOn(sns, "verifySnsSignature").mockResolvedValue({ valid: true, algorithm: "SHA-256" });
		const env = createEnv();
		env.BEACH_DATA.failNextPut.add(prefix);
		const body = JSON.stringify({ ...baseNotification, SignatureVersion: "2", Message: CAP_JSON_STRING });
		const first = await handleIpawsPubSubRequest(new Request("https://example.com/v1/ipaws/pubsub", { method: "POST", body }), env);
		expect(first.status).toBe(503);
		const retry = await handleIpawsPubSubRequest(new Request("https://example.com/v1/ipaws/pubsub", { method: "POST", body }), env);
		expect(retry.status).toBe(200);
		expect(await retry.json()).toMatchObject({ outcome: "accepted" });
		expect(env.BEACH_DATA.map.has(`ipaws:normalized:${baseNotification.MessageId}`)).toBe(true);
	});

	it.each([
		["second ingestion write", "ipaws:ingest:", 2],
		["health write", "ipaws:health:v1", 1],
		["subscription-state write", "ipaws:subscription:state", 1],
	] as const)("recovers after a %s failure", async (_label, prefix, failureNumber) => {
		vi.spyOn(sns, "verifySnsSignature").mockResolvedValue({ valid: true, algorithm: "SHA-256" });
		const env = createEnv();
		env.BEACH_DATA.failPutNumber.set(prefix, failureNumber);
		const body = JSON.stringify({ ...baseNotification, SignatureVersion: "2", Message: CAP_JSON_STRING });
		const first = await handleIpawsPubSubRequest(new Request("https://example.com/v1/ipaws/pubsub", { method: "POST", body }), env);
		expect(first.status).toBe(503);
		env.BEACH_DATA.failPutNumber.clear();
		const retry = await handleIpawsPubSubRequest(new Request("https://example.com/v1/ipaws/pubsub", { method: "POST", body }), env);
		expect(retry.status).toBe(200);
		expect(env.BEACH_DATA.map.has(`ipaws:normalized:${baseNotification.MessageId}`)).toBe(true);
	});

	it("reconstructs a missing normalized output behind a complete marker", async () => {
		vi.spyOn(sns, "verifySnsSignature").mockResolvedValue({ valid: true, algorithm: "SHA-256" });
		const env = createEnv();
		const body = JSON.stringify({ ...baseNotification, SignatureVersion: "2", Message: CAP_JSON_STRING });
		expect((await handleIpawsPubSubRequest(new Request("https://example.com/v1/ipaws/pubsub", { method: "POST", body }), env)).status).toBe(200);
		env.BEACH_DATA.map.delete(`ipaws:normalized:${baseNotification.MessageId}`);
		const recovered = await handleIpawsPubSubRequest(new Request("https://example.com/v1/ipaws/pubsub", { method: "POST", body }), env);
		expect(recovered.status).toBe(200);
		expect(env.BEACH_DATA.map.has(`ipaws:normalized:${baseNotification.MessageId}`)).toBe(true);
		expect(env.metricsEvents.at(-1)).toEqual(expect.objectContaining({
			idempotency: ["lease_recovery", "completion"], normalizedRecord: ["reconstruction"],
		}));
	});

	it("repairs matching legacy provenance behind a complete marker before acknowledging a duplicate", async () => {
		vi.spyOn(sns, "verifySnsSignature").mockResolvedValue({ valid: true, algorithm: "SHA-256" });
		const env = createEnv();
		const body = JSON.stringify({ ...baseNotification, SignatureVersion: "2", Message: CAP_JSON_STRING });
		expect((await handleIpawsPubSubRequest(new Request("https://example.com/v1/ipaws/pubsub", { method: "POST", body }), env)).status).toBe(200);
		const ingestionKey = `ipaws:ingest:${baseNotification.MessageId}`;
		const legacy = JSON.parse(env.BEACH_DATA.map.get(ingestionKey) ?? "{}");
		delete legacy.environment;
		env.BEACH_DATA.map.set(ingestionKey, JSON.stringify(legacy));
		const recovered = await handleIpawsPubSubRequest(new Request("https://example.com/v1/ipaws/pubsub", { method: "POST", body }), env);
		expect(recovered.status).toBe(200);
		expect(JSON.parse(env.BEACH_DATA.map.get(ingestionKey) ?? "{}").environment).toBe("staging");
		expect(JSON.parse(env.BEACH_DATA.map.get(`ipaws:normalized:${baseNotification.MessageId}`) ?? "{}").environment).toBe("staging");
	});

	it("fails closed on invalid signatures", async () => {
		const verify = vi.spyOn(sns, "verifySnsSignature").mockResolvedValue({ valid: false, reason: "ipaws_signature_mismatch" });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const env = createEnv();
		const response = await handleIpawsPubSubRequest(new Request("https://example.com/v1/ipaws/pubsub", {
			method: "POST",
			body: JSON.stringify(baseNotification),
		}), env);
		expect(response.status).toBe(400);
		const responseBody = await response.json();
		expect(responseBody).toMatchObject({ code: "ipaws_signature_mismatch" });
		expect(JSON.stringify(responseBody)).not.toContain(baseNotification.MessageId);
		expect(verify).toHaveBeenCalled();
		const invalidEntry = [...env.BEACH_DATA.map.entries()].find(([key]) => key.startsWith("ipaws:invalid-signature:"));
		expect(invalidEntry).toBeDefined();
		const record = JSON.parse(invalidEntry?.[1] ?? "{}");
		expect(record).toMatchObject({
			processingState: "signature_invalid",
			signatureResult: "failure",
			parseStatus: "parse_failed",
			parseError: "invalid_signature_untrusted_payload",
		});
		expect(record.rawMessageDigestSha256).toMatch(/^[a-f0-9]{64}$/);
		const retained = JSON.stringify([...env.BEACH_DATA.map.entries()]);
		expect(retained).not.toContain(baseNotification.MessageId);
		expect(retained).not.toContain(baseNotification.Message);
		expect(retained).not.toContain(baseNotification.Signature);
		expect(retained).not.toContain(baseNotification.SigningCertURL);
		expect(JSON.stringify(warn.mock.calls)).not.toContain(baseNotification.MessageId);
		expect(JSON.stringify(env.metricsEvents)).not.toContain(baseNotification.MessageId);
		expect(env.metricsCorrelations).toEqual([]);
		expect(record).not.toHaveProperty("messageId");
		expect(record).not.toHaveProperty("rawMessage");
		expect(record).not.toHaveProperty("messageBody");
		expect(env.metricsEvents.at(-1)).toEqual(expect.objectContaining({
			processingStages: expect.arrayContaining(["certificate_retrieval", "persistence", "security_validation"]),
			failureStage: "security_validation",
			failureClass: "signature_invalid",
		}));
	});

	it("retains MessageId only for successfully authenticated staging records", async () => {
		vi.spyOn(sns, "verifySnsSignature").mockResolvedValue({ valid: true, algorithm: "SHA-256" });
		const env = createEnv();
		const response = await handleIpawsPubSubRequest(new Request("https://example.com/v1/ipaws/pubsub", {
			method: "POST", body: JSON.stringify({ ...baseNotification, SignatureVersion: "2", Message: CAP_JSON_STRING }),
		}), env);
		expect(response.status).toBe(200);
		expect(env.BEACH_DATA.map.get(`ipaws:ingest:${baseNotification.MessageId}`)).toContain(baseNotification.MessageId);
		expect(env.BEACH_DATA.map.get(`ipaws:normalized:${baseNotification.MessageId}`)).toContain(baseNotification.MessageId);
		expect(JSON.stringify(await response.json())).not.toContain(baseNotification.MessageId);
		expect(JSON.stringify(env.metricsEvents)).not.toContain(baseNotification.MessageId);
	});

	it("retains a signed malformed CAP payload as parse_failed without normalized output", async () => {
		vi.spyOn(sns, "verifySnsSignature").mockResolvedValue({ valid: true, algorithm: "SHA-1" });
		const env = createEnv();
		const malformed = "<alert><identifier>broken</alert>";
		const response = await handleIpawsPubSubRequest(new Request("https://example.com/v1/ipaws/pubsub", {
			method: "POST", body: JSON.stringify({ ...baseNotification, Message: malformed }),
		}), env);
		expect(response.status).toBe(200);
		const record = JSON.parse(env.BEACH_DATA.map.get(`ipaws:ingest:${baseNotification.MessageId}`) ?? "{}");
		expect(record).toMatchObject({ processingState: "notification_parse_failed", parseStatus: "parse_failed", rawMessage: malformed });
		expect(env.BEACH_DATA.map.has(`ipaws:normalized:${baseNotification.MessageId}`)).toBe(false);
	});

	it.each([
		["json_array", "[]"],
		["json_scalar", "\"sensitive-scalar-value\""],
		["opaque_text", "authenticated auxiliary text"],
	] as const)("retains authenticated unsupported %s input as a terminal non-normalized outcome", async (unsupportedClass, messageBody) => {
		vi.spyOn(sns, "verifySnsSignature").mockResolvedValue({ valid: true, algorithm: "SHA-256" });
		const env = createEnv();
		const response = await handleIpawsPubSubRequest(new Request("https://example.com/v1/ipaws/pubsub", {
			method: "POST", body: JSON.stringify({ ...baseNotification, SignatureVersion: "2", Message: messageBody }),
		}), env);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ outcome: "accepted" });
		const record = JSON.parse(env.BEACH_DATA.map.get(`ipaws:ingest:${baseNotification.MessageId}`) ?? "{}");
		expect(record).toMatchObject({
			processingState: "notification_unsupported", parseStatus: "unsupported",
			parseError: "authenticated_structure_unsupported", rawMessage: messageBody,
		});
		expect(env.BEACH_DATA.map.has(`ipaws:normalized:${baseNotification.MessageId}`)).toBe(false);
		expect(env.metricsEvents.at(-1)).toEqual(expect.objectContaining({
			capParse: "unsupported", unsupportedInput: unsupportedClass, normalizedRecord: ["not_applicable"],
		}));
		const publicMetrics = JSON.stringify(env.metricsEvents);
		expect(publicMetrics).not.toContain(messageBody);
		expect(publicMetrics).not.toContain(baseNotification.MessageId);
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
		const maliciousUrl = `https://example.com/${"private-payload".repeat(20_000)}?Action=ConfirmSubscription&Token=t&TopicArn=a`;
		const response = await handleIpawsPubSubRequest(new Request("https://example.com/v1/ipaws/pubsub", {
			method: "POST",
			body: JSON.stringify({
				...baseNotification,
				Type: "SubscriptionConfirmation" as const,
				Message: "subscribe",
				Token: "token",
				SubscribeURL: maliciousUrl,
			}),
		}), env);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ status: "error", code: "ipaws_invalid_aws_hostname", message: "SNS request validation failed." });
		expect(JSON.stringify(env.metricsEvents)).not.toContain(maliciousUrl);
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

	it("records unsubscribe confirmations without following SubscribeURL", async () => {
		vi.spyOn(sns, "verifySnsSignature").mockResolvedValue({ valid: true, algorithm: "SHA-1" });
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const env = createEnv();
		const response = await handleIpawsPubSubRequest(new Request("https://example.com/v1/ipaws/pubsub", { method: "POST", body: JSON.stringify({
			...baseNotification, Type: "UnsubscribeConfirmation", Message: "unsubscribe", Token: "token", SubscribeURL: validSubscribeUrl,
		}) }), env);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ outcome: "unsubscribe_recorded" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("returns 503 for transient confirmation failures and permits retry", async () => {
		vi.spyOn(sns, "verifySnsSignature").mockResolvedValue({ valid: true, algorithm: "SHA-1" });
		vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
		const env = createEnv({ IPAWS_AUTO_CONFIRM_SUBSCRIPTION: "true" });
		const response = await handleIpawsPubSubRequest(new Request("https://example.com/v1/ipaws/pubsub", { method: "POST", body: JSON.stringify({
			...baseNotification, Type: "SubscriptionConfirmation", Message: "subscribe", Token: "token", SubscribeURL: validSubscribeUrl,
		}) }), env);
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ code: "ipaws_subscription_confirmation_unavailable" });
	});
});
