import { importX509 } from "jose";
import { logWarn } from "../utils/logger";
import { validateSafeHttpsUrl } from "../utils/http";
import type { IpawsSnsMessage, IpawsSnsNotification, IpawsSnsSubscriptionConfirmation, IpawsSnsType, IpawsSignatureResult } from "./types";
import { SNS_TYPES } from "./types";

const MAX_CERT_BYTES = 96_000;
const AWS_FETCH_TIMEOUT_MS = 5_000;
const SIGNATURE_VERSION_ALGORITHMS: Record<string, { hash: string }> = {
	"1": { hash: "SHA-1" },
	"2": { hash: "SHA-256" },
};

async function importSnsVerificationKey(pem: string, hash: string): Promise<CryptoKey> {
	// jose expects a JOSE/JWA algorithm identifier here, not a Web Crypto
	// algorithm name. RS256 extracts the RSA SPKI from the X.509 certificate.
	const rsaSha256Key = await importX509(pem, "RS256", { extractable: true });
	if (hash === "SHA-256") return rsaSha256Key;

	// Web Crypto binds the digest to an RSASSA-PKCS1-v1_5 CryptoKey. SNS
	// SignatureVersion 1 therefore needs the same SPKI imported with SHA-1.
	const spki = await crypto.subtle.exportKey("spki", rsaSha256Key);
	return crypto.subtle.importKey(
		"spki",
		spki,
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-1" },
		false,
		["verify"],
	);
}

async function fetchWithTimeout(input: string, init: RequestInit<RequestInitCfProperties>): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), AWS_FETCH_TIMEOUT_MS);
	try {
		return await fetch(input, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timeout);
	}
}

export class IpawsSnsError extends Error {
	constructor(public readonly code: string, message: string) {
		super(message);
		this.name = "IpawsSnsError";
	}
}

export function validateType(value: string): IpawsSnsType {
	if (SNS_TYPES.includes(value as IpawsSnsType)) return value as IpawsSnsType;
	throw new IpawsSnsError("ipaws_unsupported_sns_type", `Unsupported SNS Type: ${value}`);
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new IpawsSnsError("ipaws_invalid_sns_field", `${label} is required and must be a string.`);
	}
	return value;
}

function validateSignedDate(value: string): string {
	const parsed = Date.parse(value);
	if (Number.isNaN(parsed)) throw new IpawsSnsError("ipaws_invalid_timestamp", "Timestamp is not valid ISO-8601.");
	return new Date(parsed).toISOString();
}

function validateAwsDomain(hostname: string): boolean {
	return /^sns\.[a-z0-9-]+\.amazonaws\.com$/i.test(hostname);
}

function validateSigningCertPath(pathname: string): void {
	if (!/^\/SimpleNotificationService-[A-Za-z0-9_-]+\.pem$/.test(pathname)) {
		throw new IpawsSnsError("ipaws_invalid_cert_path", "SigningCertURL path is invalid for AWS SNS certificates.");
	}
}

function validateAwsUrl(url: URL): void {
	try {
		validateSafeHttpsUrl(url);
	} catch {
		throw new IpawsSnsError("ipaws_unsafe_aws_url", "unsafe_upstream_url: AWS URL must use a safe HTTPS origin.");
	}
	if (url.username || url.password || url.hash || url.port) {
		throw new IpawsSnsError("ipaws_unsafe_aws_url", "AWS URL must be HTTPS with no credentials, hash, or port.");
	}
	if (!validateAwsDomain(url.hostname)) {
		throw new IpawsSnsError("ipaws_invalid_aws_hostname", `Unexpected AWS hostname: ${url.hostname}`);
	}
}

export function parseSigningString(message: IpawsSnsMessage): string {
	const lines: string[] = [];
	if (message.Type === "Notification") {
		const typed = message as IpawsSnsNotification;
		if (typed.Subject !== undefined) lines.push("Subject", typed.Subject);
		lines.push("Message", typed.Message);
		lines.push("MessageId", typed.MessageId);
		lines.push("Timestamp", typed.Timestamp);
		lines.push("TopicArn", typed.TopicArn);
		lines.push("Type", typed.Type);
		return lines.join("\n") + "\n";
	}

	const confirmed = message as IpawsSnsSubscriptionConfirmation;
	lines.push("Message", confirmed.Message);
	lines.push("MessageId", confirmed.MessageId);
	lines.push("SubscribeURL", confirmed.SubscribeURL);
	lines.push("Timestamp", confirmed.Timestamp);
	lines.push("Token", confirmed.Token);
	lines.push("TopicArn", confirmed.TopicArn);
	lines.push("Type", confirmed.Type);
	return lines.join("\n") + "\n";
}

export function validateSnsRequired(message: IpawsSnsMessage): void {
	requireString(message.MessageId, "MessageId");
	requireString(message.Message, "Message");
	requireString(message.Timestamp, "Timestamp");
	requireString(message.TopicArn, "TopicArn");
	requireString(message.SigningCertURL, "SigningCertURL");
	requireString(message.Signature, "Signature");
	requireString(message.SignatureVersion, "SignatureVersion");
	if (!(message.SignatureVersion in SIGNATURE_VERSION_ALGORITHMS)) {
		throw new IpawsSnsError("ipaws_unsupported_signature_version", `Unsupported SignatureVersion: ${message.SignatureVersion}`);
	}
	if (message.Type === "SubscriptionConfirmation" || message.Type === "UnsubscribeConfirmation") {
		requireString(message.Token, "Token");
		requireString(message.SubscribeURL, "SubscribeURL");
	}
	validateSignedDate(message.Timestamp);
}

function decodeBase64(value: string): Uint8Array {
	const raw = atob(value);
	const bytes = new Uint8Array(raw.length);
	for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
	return bytes;
}

async function readCertificate(url: string): Promise<string | null> {
	const certUrl = new URL(url);
	validateAwsUrl(certUrl);
	validateSigningCertPath(certUrl.pathname);
	if (certUrl.search) {
		throw new IpawsSnsError("ipaws_invalid_cert_path", "SigningCertURL must not contain a query string.");
	}
	try {
		const certResponse = await fetchWithTimeout(certUrl.toString(), { method: "GET", redirect: "manual" });
		if (!certResponse.ok) return null;
		const text = await certResponse.text();
		if (text.length === 0 || text.length > MAX_CERT_BYTES) return null;
		return text;
	} catch (error) {
		logWarn("IPAWS", "Signing certificate fetch failed", {
			err: error instanceof Error ? error.name : "unknown",
		});
		return null;
	}
}

export async function verifySnsSignature(message: IpawsSnsMessage): Promise<IpawsSignatureResult> {
	validateSnsRequired(message);
	let pem: string | null;
	try {
		pem = await readCertificate(message.SigningCertURL);
	} catch (error) {
		if (error instanceof IpawsSnsError) {
			throw error;
		}
		return { valid: false, reason: "ipaws_invalid_cert" };
	}
	if (!pem) return { valid: false, reason: "ipaws_cert_fetch_failed" };

	const algorithm = SIGNATURE_VERSION_ALGORITHMS[message.SignatureVersion];
	let key: CryptoKey;
	try {
		key = await importSnsVerificationKey(pem, algorithm.hash);
	} catch {
		return { valid: false, reason: "ipaws_invalid_cert" };
	}

	let signature: Uint8Array;
	try {
		signature = decodeBase64(message.Signature);
	} catch {
		return { valid: false, reason: "ipaws_invalid_signature" };
	}

	const data = new TextEncoder().encode(parseSigningString(message));
	let verified: boolean;
	try {
		verified = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, data);
	} catch {
		return { valid: false, reason: "ipaws_invalid_signature", algorithm: algorithm.hash };
	}
	return {
		valid: Boolean(verified),
		reason: verified ? undefined : "ipaws_signature_mismatch",
		algorithm: algorithm.hash,
	};
}

export function parseSnsMessage(value: unknown): IpawsSnsMessage {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new IpawsSnsError("ipaws_invalid_sns_payload", "SNS payload must be a JSON object.");
	}
	const record = value as Record<string, unknown>;
	const parsed: IpawsSnsMessage = {
		Type: validateType(requireString(record.Type, "Type")),
		MessageId: requireString(record.MessageId, "MessageId"),
		Message: requireString(record.Message, "Message"),
		Timestamp: validateSignedDate(requireString(record.Timestamp, "Timestamp")),
		TopicArn: requireString(record.TopicArn, "TopicArn"),
		SigningCertURL: requireString(record.SigningCertURL, "SigningCertURL"),
		Signature: requireString(record.Signature, "Signature"),
		SignatureVersion: requireString(record.SignatureVersion, "SignatureVersion"),
	};
	if (typeof record.Subject === "string" && record.Subject.trim().length > 0) parsed.Subject = record.Subject;
	if (typeof record.Token === "string") parsed.Token = record.Token;
	if (typeof record.SubscribeURL === "string") parsed.SubscribeURL = record.SubscribeURL;
	validateSnsRequired(parsed);
	return parsed;
}

export function validateSubscribeUrl(value: string): void {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new IpawsSnsError("ipaws_invalid_subscribe_url", "SubscribeURL is malformed.");
	}
	validateAwsUrl(url);
	if (!url.hostname.startsWith("sns.")) {
		throw new IpawsSnsError("ipaws_invalid_subscribe_url", "SubscribeURL host is not an SNS endpoint.");
	}
	if (url.pathname !== "/") {
		throw new IpawsSnsError("ipaws_invalid_subscribe_url", "SubscribeURL path is malformed.");
	}
	if (!url.searchParams.get("Action") || !url.searchParams.get("TopicArn") || !url.searchParams.get("Token")) {
		throw new IpawsSnsError("ipaws_invalid_subscribe_url", "SubscribeURL query is malformed.");
	}
}
