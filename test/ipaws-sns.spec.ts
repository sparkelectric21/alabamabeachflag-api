import { readFileSync } from "node:fs";
import { createPrivateKey, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleIpawsPubSubRequest } from "../src/ipaws/handler";
import { IpawsSnsError, parseSigningString, validateSubscribeUrl, verifySnsSignature } from "../src/ipaws/sns";
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
		Timestamp: "2026-09-17T21:04:07.000Z",
		TopicArn: topicArn,
		SigningCertURL: CERT_URL,
		Signature: "pending",
		SignatureVersion: version,
		Token: "test-token-not-a-real-subscription-token",
		SubscribeURL: `https://sns.us-gov-west-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(topicArn)}&Token=test-token`,
	};
	value.Signature = sign(version === "1" ? "RSA-SHA1" : "RSA-SHA256", Buffer.from(parseSigningString(value)), PRIVATE_KEY).toString("base64");
	return value;
}

function certificateFetch() {
	return vi.fn(async () => new Response(CERTIFICATE, { status: 200 }));
}

function environment(): Env {
	return {
		BEACH_DATA: {
			get: vi.fn(async () => null),
			put: vi.fn(async () => undefined),
		} as unknown as KVNamespace,
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

afterEach(() => vi.unstubAllGlobals());

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
});
