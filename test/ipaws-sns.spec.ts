import { readFileSync } from "node:fs";
import { createPrivateKey, sign, X509Certificate } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleIpawsPubSubRequest } from "../src/ipaws/handler";
import { IpawsSnsError, parseSigningString, validateSnsCertificate, validateSnsTimestamp, validateSubscribeUrl, verifySnsSignature } from "../src/ipaws/sns";
import type { IpawsSnsSubscriptionConfirmation } from "../src/ipaws/types";
import type { Env } from "../src/types";

const CERTIFICATE = readFileSync(new URL("./fixtures/sns-test-cert.pem", import.meta.url), "utf8");
const PRIVATE_KEY = createPrivateKey(readFileSync(new URL("./fixtures/sns-test-key.pem", import.meta.url), "utf8"));
const TOPIC_ARN = "arn:aws-us-gov:sns:us-gov-west-1:594897668655:EAS_PUBLIC_FEED";
const CERT_URL = "https://sns.us-gov-west-1.amazonaws.com/SimpleNotificationService-test.pem";

function message(version: "1" | "2" = "1", topicArn = TOPIC_ARN): IpawsSnsSubscriptionConfirmation {
	const value: IpawsSnsSubscriptionConfirmation = {
		Type: "SubscriptionConfirmation",
		MessageId: "c5e14a67-3a64-480f-9dd2-23f94599cb9f",
		Message: `You have chosen to subscribe to the topic ${topicArn}.`,
		Timestamp: new Date().toISOString(),
		TopicArn: topicArn,
		SigningCertURL: CERT_URL,
		Signature: "pending",
		SignatureVersion: version,
		Token: "test-token-not-a-real-subscription-token",
		SubscribeURL: `https://sns.us-gov-west-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(topicArn)}&Token=test-token-not-a-real-subscription-token`,
	};
	value.Signature = sign(version === "1" ? "RSA-SHA1" : "RSA-SHA256", Buffer.from(parseSigningString(value)), PRIVATE_KEY).toString("base64");
	return value;
}

function certificateFetch() {
	return vi.fn(async () => new Response(CERTIFICATE, { status: 200 }));
}

function observeAbortListeners(signal: AbortSignal, afterAdd?: () => void): () => number {
	const add = signal.addEventListener.bind(signal);
	const remove = signal.removeEventListener.bind(signal);
	let active = 0;
	signal.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions | boolean) => {
		add(type, listener, options);
		if (type === "abort") {
			active += 1;
			afterAdd?.();
		}
	}) as typeof signal.addEventListener;
	signal.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: EventListenerOptions | boolean) => {
		remove(type, listener, options);
		if (type === "abort") active -= 1;
	}) as typeof signal.removeEventListener;
	return () => active;
}

function environment(): Env {
	let claimed = false;
	const token = "internal-test-claim-token";
	return {
		BEACH_DATA: {
			get: vi.fn(async () => null),
			put: vi.fn(async () => undefined),
		} as unknown as KVNamespace,
		IPAWS_IDEMPOTENCY: {
			idFromName: (name: string) => name,
			get: () => ({ fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				if (new URL(String(input)).pathname === "/claim") {
					const result = !claimed;
					claimed = true;
					return Response.json(result ? { result: "acquired", token } : { result: "complete" });
				}
				if (JSON.parse(String(init?.body ?? "{}"))?.token !== token) return Response.json({ result: "stale" }, { status: 409 });
				return new Response(null, { status: 204 });
			}) }),
		} as unknown as DurableObjectNamespace,
		IPAWS_INGESTION_ENABLED: "true",
		IPAWS_ENVIRONMENT: "staging",
		IPAWS_ALLOWED_TOPIC_ARNS: TOPIC_ARN,
		IPAWS_AUTO_CONFIRM_SUBSCRIPTION: "true",
		IPAWS_HEALTH_TTL_SECONDS: "604800",
		IPAWS_RECORD_TTL_SECONDS: "604800",
		IPAWS_SUBSCRIPTION_TTL_SECONDS: "604800",
		IPAWS_PARSE_BYTE_LIMIT: "262144",
	} as Env;
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("AWS SNS signature verification", () => {
	it.each([
		["1", "SHA-1"],
		["2", "SHA-256"],
	] as const)("verifies SignatureVersion %s with %s", async (version, algorithm) => {
		vi.stubGlobal("fetch", certificateFetch());
		await expect(verifySnsSignature(message(version))).resolves.toEqual({ valid: true, algorithm });
	});

	it("fails closed when the signed payload is modified", async () => {
		vi.stubGlobal("fetch", certificateFetch());
		const value = message("1");
		value.Message += " modified";
		await expect(verifySnsSignature(value)).resolves.toMatchObject({ valid: false, reason: "ipaws_signature_mismatch" });
	});

	it("rejects a response that is not a valid X.509 certificate", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response("not a certificate", { status: 200 })));
		await expect(verifySnsSignature(message("2"))).resolves.toEqual({ valid: false, reason: "ipaws_invalid_cert" });
	});

	it("does not follow redirects and cancels their response bodies", async () => {
		vi.useFakeTimers();
		let cancelled = false;
		const body = new ReadableStream({
			start(controller) { controller.enqueue(new TextEncoder().encode("redirect body")); },
			cancel() { cancelled = true; },
		});
		const fetchMock = vi.fn(async () => new Response(body, { status: 302, headers: { location: "https://example.com/cert.pem" } }));
		vi.stubGlobal("fetch", fetchMock);
		await expect(verifySnsSignature(message("2"))).resolves.toMatchObject({ valid: false, reason: "ipaws_cert_fetch_failed" });
		expect(fetchMock).toHaveBeenCalledWith(CERT_URL, expect.objectContaining({ redirect: "manual" }));
		expect(cancelled).toBe(true);
		expect(body.locked).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("classifies transient certificate retrieval as retryable and cancels its body", async () => {
		vi.useFakeTimers();
		let cancellationCount = 0;
		const bodies: ReadableStream[] = [];
		vi.stubGlobal("fetch", vi.fn(async () => {
			const body = new ReadableStream({
				start(controller) { controller.enqueue(new TextEncoder().encode("upstream error")); },
				cancel() { cancellationCount += 1; },
			});
			bodies.push(body);
			return new Response(body, { status: 503 });
		}));
		await expect(verifySnsSignature(message("2"))).resolves.toMatchObject({ valid: false, reason: "ipaws_cert_fetch_failed", retryable: true });
		expect(cancellationCount).toBe(1);
		expect(bodies[0]?.locked).toBe(false);
		const response = await handleIpawsPubSubRequest(new Request("https://example.test/v1/ipaws/pubsub", {
			method: "POST", body: JSON.stringify(message("2")),
		}), environment());
		expect(response.status).toBe(503);
		expect(cancellationCount).toBe(2);
		expect(bodies.every((body) => !body.locked)).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("contains response-body cancellation failures without masking the HTTP result", async () => {
		vi.useFakeTimers();
		let cancellationAttempted = false;
		const body = new ReadableStream({
			start(controller) { controller.enqueue(new TextEncoder().encode("redirect body")); },
			cancel() { cancellationAttempted = true; return Promise.reject(new Error("cancel failed")); },
		});
		vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 302 })));
		await expect(verifySnsSignature(message("2"))).resolves.toMatchObject({ valid: false, reason: "ipaws_cert_fetch_failed", retryable: false });
		expect(cancellationAttempted).toBe(true);
		expect(body.locked).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("rejects oversized declared and streamed certificate bodies", async () => {
		vi.useFakeTimers();
		vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { headers: { "content-length": "96001" } })));
		await expect(verifySnsSignature(message("2"))).resolves.toMatchObject({ valid: false, reason: "ipaws_cert_too_large" });
		expect(vi.getTimerCount()).toBe(0);
		let cancelled = false;
		let activeListeners = () => -1;
		const body = new ReadableStream({
			pull(controller) { controller.enqueue(new Uint8Array(48_001)); controller.enqueue(new Uint8Array(48_001)); },
			cancel() { cancelled = true; },
		});
		vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			activeListeners = observeAbortListeners(init?.signal as AbortSignal);
			return new Response(body);
		}));
		await expect(verifySnsSignature(message("2"))).resolves.toMatchObject({ valid: false, reason: "ipaws_cert_too_large" });
		expect(cancelled).toBe(true);
		expect(body.locked).toBe(false);
		expect(activeListeners()).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([
		["rejects", () => Promise.reject(new Error("cancel failed"))],
		["never settles", () => new Promise<void>(() => undefined)],
	] as const)("preserves streamed oversize when reader cancellation %s", async (_behavior, cancelResult) => {
		vi.useFakeTimers();
		let cancellationCount = 0;
		let activeListeners = () => -1;
		const body = new ReadableStream({
			pull(controller) { controller.enqueue(new Uint8Array(48_001)); controller.enqueue(new Uint8Array(48_001)); },
			cancel() { cancellationCount += 1; return cancelResult(); },
		});
		vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			activeListeners = observeAbortListeners(init?.signal as AbortSignal);
			return new Response(body);
		}));

		const verification = verifySnsSignature(message("2"));
		await vi.advanceTimersByTimeAsync(0);
		await expect(verification).resolves.toEqual({ valid: false, reason: "ipaws_cert_too_large", retryable: false });
		expect(cancellationCount).toBe(1);
		expect(body.locked).toBe(false);
		expect(activeListeners()).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
		await Promise.resolve();
	});

	it.each([false, true])("times out and cancels a stalled certificate body (partial=%s)", async (partial) => {
		vi.useFakeTimers();
		let cancelled = false;
		const body = new ReadableStream({
			start(controller) { if (partial) controller.enqueue(new TextEncoder().encode("partial")); },
			pull() { return new Promise(() => undefined); },
			cancel() { cancelled = true; },
		});
		vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));
		const pending = verifySnsSignature(message("2"));
		await vi.advanceTimersByTimeAsync(5_001);
		await expect(pending).resolves.toMatchObject({ valid: false, reason: "ipaws_cert_fetch_unavailable", retryable: true });
		expect(cancelled).toBe(true);
		expect(body.locked).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("cancels, unlocks, and leaves no pending first read when the signal is already aborted before body consumption", async () => {
		vi.useFakeTimers();
		let cancelled = false;
		let activeListeners = () => -1;
		const body = new ReadableStream({
			pull() { return new Promise(() => undefined); },
			cancel() { cancelled = true; },
		});
		vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			activeListeners = observeAbortListeners(init?.signal as AbortSignal);
			await new Promise((resolve) => setTimeout(resolve, 5_001));
			return new Response(body);
		}));
		const pending = verifySnsSignature(message("2"));
		await vi.advanceTimersByTimeAsync(5_001);
		await expect(pending).resolves.toMatchObject({ valid: false, reason: "ipaws_cert_fetch_unavailable", retryable: true });
		expect(cancelled).toBe(true);
		expect(body.locked).toBe(false);
		expect(activeListeners()).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("contains reader-cancellation rejection without masking a timeout", async () => {
		vi.useFakeTimers();
		let cancellationAttempted = false;
		const body = new ReadableStream({
			pull() { return new Promise(() => undefined); },
			cancel() { cancellationAttempted = true; return Promise.reject(new Error("cancel failed")); },
		});
		vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));
		const pending = verifySnsSignature(message("2"));
		await vi.advanceTimersByTimeAsync(5_001);
		await expect(pending).resolves.toMatchObject({ valid: false, reason: "ipaws_cert_fetch_unavailable", retryable: true });
		expect(cancellationAttempted).toBe(true);
		expect(body.locked).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("handles an abort delivered between listener registration and the initial state check", async () => {
		vi.useFakeTimers();
		let cancelled = false;
		let activeListeners = () => -1;
		const body = new ReadableStream({
			pull() { return new Promise(() => undefined); },
			cancel() { cancelled = true; },
		});
		vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			const signal = init?.signal as AbortSignal;
			activeListeners = observeAbortListeners(signal, () => signal.dispatchEvent(new Event("abort")));
			return new Response(body);
		}));
		await expect(verifySnsSignature(message("2"))).resolves.toMatchObject({ valid: false, reason: "ipaws_cert_fetch_unavailable", retryable: true });
		expect(cancelled).toBe(true);
		expect(body.locked).toBe(false);
		expect(activeListeners()).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("releases the lock and clears listener and timer state after a read failure", async () => {
		vi.useFakeTimers();
		let activeListeners = () => -1;
		const body = new ReadableStream({ pull(controller) { controller.error(new Error("read failed")); } });
		vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			activeListeners = observeAbortListeners(init?.signal as AbortSignal);
			return new Response(body);
		}));
		await expect(verifySnsSignature(message("2"))).resolves.toMatchObject({ valid: false, reason: "ipaws_cert_fetch_unavailable", retryable: true });
		expect(body.locked).toBe(false);
		expect(activeListeners()).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("accepts a valid certificate body that completes just within the deadline", async () => {
		vi.useFakeTimers();
		let activeListeners = () => -1;
		const body = new ReadableStream({
			start(controller) {
				setTimeout(() => { controller.enqueue(new TextEncoder().encode(CERTIFICATE)); controller.close(); }, 4_999);
			},
		});
		vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			activeListeners = observeAbortListeners(init?.signal as AbortSignal);
			return new Response(body);
		}));
		const pending = verifySnsSignature(message("2"));
		await vi.advanceTimersByTimeAsync(4_999);
		await expect(pending).resolves.toEqual({ valid: true, algorithm: "SHA-256" });
		expect(body.locked).toBe(false);
		expect(activeListeners()).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("returns HTTP 503 when certificate body download times out", async () => {
		vi.useFakeTimers();
		vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
			pull() { return new Promise(() => undefined); },
		}))));
		const pending = handleIpawsPubSubRequest(new Request("https://example.test/v1/ipaws/pubsub", {
			method: "POST", body: JSON.stringify(message("2")),
		}), environment());
		await vi.advanceTimersByTimeAsync(5_001);
		expect((await pending).status).toBe(503);
	});

	it("rejects expired, not-yet-valid, and untrusted certificates", () => {
		const certificate = new X509Certificate(CERTIFICATE);
		expect(() => validateSnsCertificate(CERTIFICATE, Date.parse(certificate.validTo) + 1)).toThrowError(/expired/i);
		expect(() => validateSnsCertificate(CERTIFICATE, Date.parse(certificate.validFrom) - 1)).toThrowError(/not yet valid/i);
		const untrusted = readFileSync(new URL("./fixtures/sns-untrusted-cert.pem", import.meta.url), "utf8");
		expect(() => validateSnsCertificate(untrusted)).toThrowError(/leaf certificate|Amazon SNS identity/i);
	});

	it("rejects stale and future SNS timestamps", () => {
		const now = Date.parse("2026-09-23T12:00:00.000Z");
		expect(() => validateSnsTimestamp("2026-09-23T10:59:59.000Z", 3600, 300, now)).toThrowError(/older/i);
		expect(() => validateSnsTimestamp("2026-09-23T12:05:01.000Z", 3600, 300, now)).toThrowError(/future/i);
		expect(() => validateSnsTimestamp("2026-09-23T11:00:00.000Z", 3600, 300, now)).not.toThrow();
	});

	it.each([
		"http://sns.us-gov-west-1.amazonaws.com/SimpleNotificationService-test.pem",
		"https://user@sns.us-gov-west-1.amazonaws.com/SimpleNotificationService-test.pem",
		"https://sns.us-gov-west-1.amazonaws.com:444/SimpleNotificationService-test.pem",
		"https://sns.us-gov-west-1.amazonaws.com/SimpleNotificationService-test.pem#fragment",
		"https://sns.us-gov-west-1.amazonaws.com/SimpleNotificationService-test.pem?download=1",
		"https://sns.us-gov-west-1.amazonaws.com/not-an-sns-certificate.pem",
		"https://attacker-bucket.s3.amazonaws.com/SimpleNotificationService-test.pem",
		"https://sns.us-gov-west-1.amazonaws.com.evil.example/SimpleNotificationService-test.pem",
	])("rejects unsafe certificate URL %s", async (url) => {
		const value = message();
		value.SigningCertURL = url;
		await expect(verifySnsSignature(value)).rejects.toBeInstanceOf(IpawsSnsError);
	});

	it("rejects a topic outside the exact allowlist before fetching a certificate", async () => {
		const fetchMock = certificateFetch();
		vi.stubGlobal("fetch", fetchMock);
		const response = await handleIpawsPubSubRequest(new Request("https://example.test/v1/ipaws/pubsub", {
			method: "POST",
			body: JSON.stringify(message("1", `${TOPIC_ARN}-lookalike`)),
		}), environment());
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ code: "ipaws_unexpected_topic" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rejects a cryptographically signed SubscribeURL whose TopicArn differs", async () => {
		const value = message("2");
		value.SubscribeURL = `https://sns.us-gov-west-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(`${TOPIC_ARN}-other`)}&Token=test-token`;
		value.Signature = sign("RSA-SHA256", Buffer.from(parseSigningString(value)), PRIVATE_KEY).toString("base64");
		vi.stubGlobal("fetch", certificateFetch());
		const response = await handleIpawsPubSubRequest(new Request("https://example.test/v1/ipaws/pubsub", {
			method: "POST",
			body: JSON.stringify(value),
		}), environment());
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ code: "ipaws_invalid_subscribe_url" });
	});

	it("rejects malformed SubscribeURLs", () => {
		expect(() => validateSubscribeUrl("https://sns.us-gov-west-1.amazonaws.com/confirm?Action=ConfirmSubscription&TopicArn=x&Token=y"))
			.toThrowError(IpawsSnsError);
	});

	it.each([
		`https://sns.us-gov-west-1.amazonaws.com/?Action=ConfirmSubscription&Action=Other&TopicArn=${encodeURIComponent(TOPIC_ARN)}&Token=test-token-not-a-real-subscription-token`,
		`https://sns.us-gov-west-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(TOPIC_ARN)}&TopicArn=${encodeURIComponent(TOPIC_ARN)}&Token=test-token-not-a-real-subscription-token`,
		`https://sns.us-gov-west-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(TOPIC_ARN)}&Token=test-token-not-a-real-subscription-token&Token=test-token-not-a-real-subscription-token`,
		`https://sns.us-gov-west-1.amazonaws.com/?TopicArn=${encodeURIComponent(TOPIC_ARN)}&Token=test-token-not-a-real-subscription-token`,
		`https://sns.us-gov-west-1.amazonaws.com/?Action=ConfirmSubscription&Token=test-token-not-a-real-subscription-token`,
		`https://sns.us-gov-west-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(TOPIC_ARN)}`,
		`https://sns.us-gov-west-1.amazonaws.com/?Action=confirmSubscription&TopicArn=${encodeURIComponent(TOPIC_ARN)}&Token=test-token-not-a-real-subscription-token`,
		`https://sns.us-gov-west-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(`${TOPIC_ARN}-wrong`)}&Token=test-token-not-a-real-subscription-token`,
		`https://sns.us-gov-west-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(TOPIC_ARN)}&Token=wrong`,
	])("rejects ambiguous or mismatched SubscribeURL %s", (url) => {
		expect(() => validateSubscribeUrl(url, TOPIC_ARN, "test-token-not-a-real-subscription-token")).toThrowError(IpawsSnsError);
	});

	it("preserves and verifies the exact signed timestamp spelling", async () => {
		const value = message("2");
		value.Timestamp = "2026-09-23T12:00:00+00:00";
		value.Signature = sign("RSA-SHA256", Buffer.from(parseSigningString(value)), PRIVATE_KEY).toString("base64");
		expect(parseSigningString(value)).toContain("Timestamp\n2026-09-23T12:00:00+00:00\n");
		vi.stubGlobal("fetch", certificateFetch());
		await expect(verifySnsSignature(value)).resolves.toEqual({ valid: true, algorithm: "SHA-256" });
	});
});
