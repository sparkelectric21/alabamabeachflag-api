import { generateKeyPair, jwtVerify, SignJWT } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
	authenticateAdminRequest,
	forbiddenAdminResponse,
	type AccessTokenVerifier,
} from "../src/services/admin/auth";
import type { Env } from "../src/types";

const issuer = "https://alabama-beach-flag.cloudflareaccess.com";
const audience = "phase-2-test-audience";
let privateKey: CryptoKey;
let verifier: AccessTokenVerifier;

beforeAll(async () => {
	const keys = await generateKeyPair("RS256");
	privateKey = keys.privateKey;
	verifier = async (token, expectedIssuer, expectedAudience) =>
		(await jwtVerify(token, keys.publicKey, {
			issuer: expectedIssuer,
			audience: expectedAudience,
		})).payload;
});

function env(overrides: Partial<Env> = {}): Env {
	return {
		ACCESS_TEAM_DOMAIN: issuer,
		ACCESS_AUD: audience,
		ACCESS_ALLOWED_IDENTITIES: "admin@example.com,service-subject",
		ACCESS_ALLOWED_GROUPS: "beach-api-admins",
		ACCESS_ALLOWED_SERVICE_TOKENS: "allowed-client.access",
		REFRESH_SECRET: "migration-secret",
		ALLOW_LEGACY_REFRESH_SECRET: "false",
		...overrides,
	} as Env;
}

async function token(claims: Record<string, unknown> = {}, tokenIssuer = issuer, tokenAudience = audience): Promise<string> {
	return new SignJWT({ email: "admin@example.com", ...claims })
		.setProtectedHeader({ alg: "RS256" })
		.setIssuer(tokenIssuer)
		.setAudience(tokenAudience)
		.setSubject(String(claims.sub ?? "admin-subject"))
		.setIssuedAt()
		.setExpirationTime("5m")
		.sign(privateKey);
}

async function serviceToken(claims: Record<string, unknown> = {}): Promise<string> {
	return new SignJWT({ common_name: "allowed-client.access", ...claims })
		.setProtectedHeader({ alg: "RS256" })
		.setIssuer(issuer)
		.setAudience(audience)
		.setSubject("")
		.setIssuedAt()
		.setExpirationTime("5m")
		.sign(privateKey);
}

function request(jwt?: string, secret?: string): Request {
	const headers = new Headers();
	if (jwt) headers.set("cf-access-jwt-assertion", jwt);
	if (secret) headers.set("x-refresh-secret", secret);
	return new Request("https://example.com/internal/refresh/beach-flags", { method: "POST", headers });
}

describe("Cloudflare Access authentication", () => {
	it("accepts an allowed Service Token common_name", async () => {
		expect(await authenticateAdminRequest(request(await serviceToken()), env(), verifier)).toEqual({
			method: "access",
			subject: "access-service-token",
		});
	});

	it("rejects an unknown Service Token common_name", async () => {
		expect(await authenticateAdminRequest(
			request(await serviceToken({ common_name: "unknown-client.access" })),
			env(),
			verifier,
		)).toBeNull();
	});

	it("rejects a Service Token without common_name", async () => {
		expect(await authenticateAdminRequest(
			request(await serviceToken({ common_name: undefined })),
			env(),
			verifier,
		)).toBeNull();
	});

	it("does not authorize a Service Token with empty sub through browser claims", async () => {
		const jwt = await serviceToken({ common_name: undefined, email: "admin@example.com", groups: ["beach-api-admins"] });
		expect(await authenticateAdminRequest(request(jwt), env(), verifier)).toBeNull();
	});

	it("accepts a valid authorized Access JWT", async () => {
		expect(await authenticateAdminRequest(request(await token()), env(), verifier)).toMatchObject({ method: "access" });
	});

	it("accepts an authorized browser subject", async () => {
		const jwt = await token({ email: "other@example.com", sub: "service-subject" });
		expect(await authenticateAdminRequest(request(jwt), env(), verifier)).toMatchObject({ method: "access" });
	});

	it("accepts an authorized group claim", async () => {
		const jwt = await token({ email: "other@example.com", groups: ["beach-api-admins"] });
		expect(await authenticateAdminRequest(request(jwt), env(), verifier)).toMatchObject({ method: "access" });
	});

	it.each([
		["wrong issuer", async () => token({}, "https://wrong.cloudflareaccess.com", audience)],
		["wrong audience", async () => token({}, issuer, "wrong-audience")],
		["expired", async () => new SignJWT({ email: "admin@example.com" })
			.setProtectedHeader({ alg: "RS256" }).setIssuer(issuer).setAudience(audience)
			.setIssuedAt(Date.now() / 1000 - 120).setExpirationTime(Date.now() / 1000 - 60).sign(privateKey)],
		["unauthorized identity", async () => token({ email: "other@example.com", sub: "other-subject", groups: ["other-group"] })],
	] as const)("rejects %s", async (_label, makeToken) => {
		expect(await authenticateAdminRequest(request(await makeToken()), env(), verifier)).toBeNull();
	});

	it("returns the same generic response for missing, invalid, expired, and unauthorized credentials", async () => {
		const attempts = [
			request(),
			request("not-a-jwt"),
			request(await token({}, "https://wrong.cloudflareaccess.com", audience)),
			request(await token({}, issuer, "wrong-audience")),
			request(await new SignJWT({ email: "admin@example.com" }).setProtectedHeader({ alg: "RS256" })
				.setIssuer(issuer).setAudience(audience).setIssuedAt(Date.now() / 1000 - 120)
				.setExpirationTime(Date.now() / 1000 - 60).sign(privateKey)),
			request(await token({ email: "nobody@example.com", sub: "nobody" })),
		];
		for (const attempt of attempts) {
			expect(await authenticateAdminRequest(attempt, env(), verifier)).toBeNull();
			const response = forbiddenAdminResponse();
			expect(response.status).toBe(403);
			expect(await response.text()).toBe('{"error":"Forbidden"}');
		}
	});

	it("does not log or return Access claim values on authorization failure", async () => {
		const sensitiveClaim = "sensitive-service-token-claim.access";
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

		const result = await authenticateAdminRequest(
			request(await serviceToken({ common_name: sensitiveClaim })),
			env(),
			verifier,
		);
		const response = forbiddenAdminResponse();
		const responseText = await response.text();
		const logged = [...log.mock.calls, ...warn.mock.calls, ...error.mock.calls].flat().join(" ");

		expect(result).toBeNull();
		expect(response.status).toBe(403);
		expect(responseText).toBe('{"error":"Forbidden"}');
		expect(responseText).not.toContain(sensitiveClaim);
		expect(logged).not.toContain(sensitiveClaim);
		expect(log).not.toHaveBeenCalled();
		expect(warn).not.toHaveBeenCalled();
		expect(error).not.toHaveBeenCalled();

		log.mockRestore();
		warn.mockRestore();
		error.mockRestore();
	});
});

describe("temporary shared-secret migration", () => {
	it("accepts the shared secret only when the migration flag is explicitly enabled", async () => {
		const result = await authenticateAdminRequest(
			request(undefined, "migration-secret"),
			env({ ALLOW_LEGACY_REFRESH_SECRET: "true" }),
			verifier,
		);
		expect(result).toEqual({ method: "legacy-secret", subject: "legacy-refresh-client" });
	});

	it("removes the fallback when the migration flag is disabled", async () => {
		expect(await authenticateAdminRequest(request(undefined, "migration-secret"), env(), verifier)).toBeNull();
	});

	it("rejects an incorrect shared secret while migration is enabled", async () => {
		expect(await authenticateAdminRequest(
			request(undefined, "incorrect-secret"),
			env({ ALLOW_LEGACY_REFRESH_SECRET: "true" }),
			verifier,
		)).toBeNull();
	});
});
