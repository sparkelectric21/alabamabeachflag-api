import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import type { Env } from "../../types";

export type AdminAuthMethod = "access" | "legacy-secret";

export interface AdminIdentity {
	method: AdminAuthMethod;
	subject: string;
}

export type AccessTokenVerifier = (
	token: string,
	issuer: string,
	audience: string,
) => Promise<JWTPayload>;

const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function csv(value: string | undefined): Set<string> {
	return new Set((value ?? "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean));
}

function normalizedIssuer(value: string): string {
	return value.replace(/\/+$/, "");
}

async function productionVerifier(token: string, issuer: string, audience: string): Promise<JWTPayload> {
	let jwks = jwksByIssuer.get(issuer);
	if (!jwks) {
		jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
		jwksByIssuer.set(issuer, jwks);
	}
	const result = await jwtVerify(token, jwks as JWTVerifyGetKey, { issuer, audience });
	return result.payload;
}

function authorized(payload: JWTPayload, env: Env): boolean {
	const identities = csv(env.ACCESS_ALLOWED_IDENTITIES);
	const groups = csv(env.ACCESS_ALLOWED_GROUPS);
	const serviceTokens = csv(env.ACCESS_ALLOWED_SERVICE_TOKENS);

	const commonName = typeof payload.common_name === "string" ? payload.common_name.toLowerCase() : "";
	const subject = typeof payload.sub === "string" ? payload.sub.toLowerCase() : "";
	const isServiceToken = commonName !== "" || payload.sub === "";
	if (isServiceToken) {
		return commonName !== "" && serviceTokens.has(commonName);
	}

	if (identities.size === 0 && groups.size === 0) return false;

	const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
	if (identities.has(email) || identities.has(subject)) return true;

	const tokenGroups = Array.isArray(payload.groups)
		? payload.groups.filter((group): group is string => typeof group === "string").map((group) => group.toLowerCase())
		: [];
	return tokenGroups.some((group) => groups.has(group));
}

function legacyMigrationEnabled(env: Env): boolean {
	return env.ALLOW_LEGACY_REFRESH_SECRET === "true";
}

export async function authenticateAdminRequest(
	request: Request,
	env: Env,
	verifyToken: AccessTokenVerifier = productionVerifier,
): Promise<AdminIdentity | null> {
	const token = request.headers.get("cf-access-jwt-assertion");
	if (token && env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) {
		try {
			const issuer = normalizedIssuer(env.ACCESS_TEAM_DOMAIN);
			const payload = await verifyToken(token, issuer, env.ACCESS_AUD);
			if (authorized(payload, env)) {
				const subject = typeof payload.common_name === "string"
					? "access-service-token"
					: String(payload.email ?? payload.sub ?? "access-identity");
				return { method: "access", subject };
			}
		} catch {
			// Authentication failures intentionally fall through to the isolated migration path.
		}
	}

	if (legacyMigrationEnabled(env)) {
		const supplied = request.headers.get("x-refresh-secret");
		if (supplied && env.REFRESH_SECRET && supplied === env.REFRESH_SECRET) {
			return { method: "legacy-secret", subject: "legacy-refresh-client" };
		}
	}

	return null;
}

export function forbiddenAdminResponse(): Response {
	return Response.json({ error: "Forbidden" }, { status: 403 });
}
