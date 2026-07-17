import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { featureFieldAbsentFixture } from "./fixtures/vibrioConditions";

describe("Vibrio deployment guardrails", () => {
	it("keeps the production Worker vars free of the feature flag", () => {
		const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
		const productionVars = config.match(/"vars"\s*:\s*\{([\s\S]*?)\n\s*\}/)?.[1] ?? "";
		expect(productionVars).not.toMatch(/"VIBRIO_CONDITIONS_ENABLED"\s*:/);
	});

	it("represents the disabled contract by omitting the field", () => {
		expect(featureFieldAbsentFixture).not.toHaveProperty("vibrioConditions");
	});

	it("enables the flag only in the non-production staging template", () => {
		const config = readFileSync(new URL("../wrangler.staging.example.jsonc", import.meta.url), "utf8");
		expect(config).toContain('"VIBRIO_CONDITIONS_ENABLED": "true"');
		expect(config).toContain('"id": "REPLACE_WITH_STAGING_KV_NAMESPACE_ID"');
		expect(config).not.toContain("ca98e7fd98f74c04bee0d8a2b0449d38");
	});

	it("keeps the local fixture variable out of production and staging configuration", () => {
		const production = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
		const staging = readFileSync(new URL("../wrangler.staging.example.jsonc", import.meta.url), "utf8");
		expect(production).not.toContain("VIBRIO_QA_FIXTURE");
		expect(staging).not.toContain("VIBRIO_QA_FIXTURE");
	});
});
