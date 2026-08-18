import type { Env } from "../types";

export type RuntimeEnvironment = "production" | "staging" | "ambiguous";

export function runtimeEnvironment(env: Pick<Env, "APP_ENVIRONMENT" | "VERIFICATION_ALERT_ENVIRONMENT" | "HISTORICAL_DATA_ENVIRONMENT">): RuntimeEnvironment {
	const verification = env.VERIFICATION_ALERT_ENVIRONMENT;
	const history = env.HISTORICAL_DATA_ENVIRONMENT;
	if (!verification || !history || verification !== history) return "ambiguous";
	if (env.APP_ENVIRONMENT !== undefined && env.APP_ENVIRONMENT !== verification) return "ambiguous";
	// Staging must carry the dedicated application label as a third independent
	// assertion. Production retains compatibility with its existing two labels.
	if (verification === "staging" && env.APP_ENVIRONMENT !== "staging") return "ambiguous";
	return verification;
}

export function liveProviderFetchAllowed(env: Env): boolean {
	const environment = runtimeEnvironment(env);
	return environment === "production" || (environment === "staging" && env.STAGING_LIVE_PROVIDER_FETCH_ENABLED === "true");
}

export function externalEmailAllowed(env: Env): boolean {
	return runtimeEnvironment(env) === "production";
}

export function syntheticFixturesAllowed(env: Env): boolean {
	return runtimeEnvironment(env) === "staging" && env.STAGING_SYNTHETIC_FIXTURES_ENABLED === "true";
}

export function stagingIsolationDiagnostics(env: Env) {
	const environment = runtimeEnvironment(env);
	return {
		schemaVersion: 1,
		environment,
		workerLabel: environment === "staging" ? "abf-api-staging" : environment === "production" ? "abf-api-production" : "unverified",
		schedulesExpected: environment === "production",
		liveProviderFetchEnabled: liveProviderFetchAllowed(env),
		emailDeliverySuppressed: !externalEmailAllowed(env),
		syntheticFixtureModeEnabled: syntheticFixturesAllowed(env),
		bindings: {
			cache: env.BEACH_DATA ? `${environment}:beach-data` : "missing",
			history: env.HISTORICAL_DATA ? `${environment}:historical-data` : "absent",
			refreshCoordinator: env.REFRESH_COORDINATOR ? `${environment}:refresh-coordinator` : "missing",
			verificationCoordinator: env.VERIFICATION_COORDINATOR ? `${environment}:verification-coordinator` : "missing",
		},
	};
}

export function providerFetchDisabledResponse(): Response {
	return Response.json({ error: "staging_provider_fetch_disabled" }, { status: 503, headers: { "Cache-Control": "no-store" } });
}
