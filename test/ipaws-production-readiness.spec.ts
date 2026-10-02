import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
	applyProductionLifecycle,
	authorizeProductionVersion,
	lineageKey,
	projectProductionLifecycle,
	reconciliationKeySets,
	type ProductionAlertVersion,
	type ProductionAuthorizationPolicy,
	type ProductionLifecycleLedger,
} from "../src/ipaws/production-lifecycle";

const alert: ProductionAlertVersion = {
	schemaVersion: 1, environment: "production", source: "fema-ipaws", messageId: "message-alert", topicArn: "topic-production",
	identifier: "alert-one", sender: "sender", sentAt: "2026-10-01T00:00:00.000Z", messageType: "Alert", status: "Actual", scope: "Public",
	expiresAt: "2026-10-02T00:00:00.000Z",
	references: [], contentDigest: "a".repeat(64), geocodes: ["target"],
};
const update: ProductionAlertVersion = {
	...alert, messageId: "message-update", identifier: "update-one", sentAt: "2026-10-01T01:00:00.000Z", messageType: "Update",
	references: ["sender,alert-one,2026-10-01T00:00:00.000Z"], contentDigest: "b".repeat(64),
};
const cancel: ProductionAlertVersion = {
	...alert, messageId: "message-cancel", identifier: "cancel-one", sentAt: "2026-10-01T02:00:00.000Z", messageType: "Cancel",
	references: ["sender,alert-one,2026-10-01T00:00:00.000Z"], contentDigest: "c".repeat(64),
};
const disabledPolicy: ProductionAuthorizationPolicy = {
	policyVersion: "disabled-baseline-v1", enabled: false, allowedTopicArns: [], allowedGeocodes: [], allowedStatuses: [], allowedScopes: [], maximumAgeSeconds: 3600, maximumFutureSkewSeconds: 300,
};
const enabledPolicy: ProductionAuthorizationPolicy = {
	policyVersion: "enabled-test-v1", enabled: true, allowedTopicArns: [alert.topicArn], allowedGeocodes: ["target"],
	allowedStatuses: ["Actual"], allowedScopes: ["Public"], maximumAgeSeconds: 10 * 365 * 24 * 60 * 60, maximumFutureSkewSeconds: 300,
};

function referencedTarget(reference: string): string | null {
	const [sender, identifier] = reference.split(",");
	return sender && identifier ? lineageKey(sender, identifier) : null;
}

describe("IPAWS production lifecycle prerequisites", () => {
	it("rebuilds Alert, Update, and Cancel state deterministically, including out-of-order input", () => {
		const target = lineageKey(alert.sender, alert.identifier);
		const ordered = projectProductionLifecycle([alert, update, cancel], target);
		const shuffled = projectProductionLifecycle([cancel, alert, update], target);
		expect(ordered).toEqual(shuffled);
		expect(ordered).toMatchObject({ state: "cancelled", versionCount: 3, orphanedVersionCount: 0, notificationsEnabled: false });
		expect(ordered.currentVersion?.messageType).toBe("Cancel");
	});

	it("keeps cancellation terminal when a later update arrives", () => {
		const lateUpdate = { ...update, messageId: "message-late-update", sentAt: "2026-10-01T03:00:00.000Z", contentDigest: "d".repeat(64) };
		expect(projectProductionLifecycle([alert, cancel, lateUpdate], lineageKey(alert.sender, alert.identifier))).toMatchObject({
			state: "cancelled", currentVersion: { messageType: "Cancel" }, orphanedVersionCount: 1, versionCount: 3,
		});
	});

	it("does not attach an unrelated update and defaults authorization to deny", () => {
		const unrelated = { ...update, references: ["sender,another-alert,2026-10-01T00:00:00.000Z"] };
		expect(projectProductionLifecycle([alert, unrelated], lineageKey(alert.sender, alert.identifier))).toMatchObject({ state: "active", versionCount: 1 });
		expect(authorizeProductionVersion(alert, disabledPolicy)).toEqual({ allowed: false, policyVersion: "disabled-baseline-v1", reason: "disabled" });
	});

	it("records inbox, immutable version, projection, and effect decision in one transaction and deduplicates retries", async () => {
		const inbox = new Set<string>(); const effects = new Set<string>(); const versions: ProductionAlertVersion[] = []; const suppressed: string[] = [];
		const transaction = vi.fn(async (operation: Parameters<ProductionLifecycleLedger["transaction"]>[0]) => operation({
			appendVersion: async (_key, version) => { versions.push(version); },
			listVersionsForLineage: async (key) => versions.filter((version) => lineageKey(version.sender, version.identifier) === key
				|| version.references.some((reference) => reference.startsWith(`${alert.sender},${alert.identifier},`))),
			putProjection: async () => undefined,
			insertInboxIfAbsent: async (key) => { if (inbox.has(key)) return false; inbox.add(key); return true; },
			insertEffectIfAbsent: async ({ effectKey }) => { if (effects.has(effectKey)) return false; effects.add(effectKey); return true; },
			suppressEffectsForLineage: async (key) => { suppressed.push(key); },
		}));
		const ledger = { transaction } as ProductionLifecycleLedger;
		expect(await applyProductionLifecycle(ledger, alert, disabledPolicy)).toMatchObject({ duplicate: false, effectCreated: true, decision: { allowed: false } });
		expect(await applyProductionLifecycle(ledger, alert, disabledPolicy)).toMatchObject({ duplicate: true, effectCreated: false });
		expect(transaction).toHaveBeenCalledTimes(2);
		expect(versions).toHaveLength(1);
		expect(await applyProductionLifecycle(ledger, cancel, disabledPolicy)).toMatchObject({ duplicate: false, decision: { allowed: false, reason: "disabled" }, projection: { state: "cancelled" } });
		expect(suppressed).toEqual([lineageKey(alert.sender, alert.identifier)]);
	});

	it("denies orphan and post-cancellation Updates from each lineage's transactional projection", async () => {
		const activeTwo = { ...alert, messageId: "active-two", identifier: "active-two", contentDigest: "e".repeat(64) };
		const versions = [alert, cancel, activeTwo];
		const mixedUpdate = { ...update, messageId: "mixed", references: [
			"sender,alert-one,2026-10-01T00:00:00.000Z",
			"sender,active-two,2026-10-01T00:00:00.000Z",
			"sender,missing,2026-10-01T00:00:00.000Z",
		], contentDigest: "f".repeat(64), expiresAt: "2099-01-01T00:00:00.000Z" };
		const ledger: ProductionLifecycleLedger = { transaction: async (operation) => operation({
			insertInboxIfAbsent: async () => true,
			appendVersion: async (_key, version) => { versions.push(version); },
			listVersionsForLineage: async (target) => versions.filter((version) => lineageKey(version.sender, version.identifier) === target || version.references.some((reference) => referencedTarget(reference) === target)),
			putProjection: async () => undefined,
			insertEffectIfAbsent: async () => true,
			suppressEffectsForLineage: async () => undefined,
		}) };
		const result = await applyProductionLifecycle(ledger, mixedUpdate, enabledPolicy);
		expect(result.decisions[lineageKey("sender", "alert-one")]).toMatchObject({ allowed: false, reason: "lifecycle" });
		expect(result.decisions[lineageKey("sender", "active-two")]).toMatchObject({ allowed: true, reason: "authorized" });
		expect(result.decisions[lineageKey("sender", "missing")]).toMatchObject({ allowed: false, reason: "lifecycle" });
	});

	it("denies a single orphan Update under an enabled policy", async () => {
		const versions: ProductionAlertVersion[] = [];
		const ledger: ProductionLifecycleLedger = { transaction: async (operation) => operation({
			insertInboxIfAbsent: async () => true, appendVersion: async (_key, version) => { versions.push(version); },
			listVersionsForLineage: async () => versions, putProjection: async () => undefined,
			insertEffectIfAbsent: async () => true, suppressEffectsForLineage: async () => undefined,
		}) };
		const orphan = { ...update, expiresAt: "2099-01-01T00:00:00.000Z" };
		expect(await applyProductionLifecycle(ledger, orphan, enabledPolicy)).toMatchObject({ decision: { allowed: false, reason: "lifecycle" } });
	});

	it("cancels every referenced lineage in the same transaction", async () => {
		const secondAlert = { ...alert, messageId: "message-alert-two", identifier: "alert-two", contentDigest: "e".repeat(64) };
		const multiCancel = { ...cancel, references: [
			"sender,alert-one,2026-10-01T00:00:00.000Z",
			"sender,alert-two,2026-10-01T00:00:00.000Z",
		] };
		const versions = [alert, secondAlert]; const suppressed: string[] = [];
		const ledger: ProductionLifecycleLedger = { transaction: async (operation) => operation({
			insertInboxIfAbsent: async () => true,
			appendVersion: async (_key, version) => { versions.push(version); },
			listVersionsForLineage: async (target) => versions.filter((version) => lineageKey(version.sender, version.identifier) === target || version.references.some((reference) => referencedTarget(reference) === target)),
			putProjection: async () => undefined,
			insertEffectIfAbsent: async () => true,
			suppressEffectsForLineage: async (target) => { suppressed.push(target); },
		}) };
		const result = await applyProductionLifecycle(ledger, multiCancel, disabledPolicy);
		expect(result.projections).toHaveLength(2);
		expect(result.projections.every((projection) => projection.state === "cancelled")).toBe(true);
		expect(suppressed).toEqual([lineageKey("sender", "alert-one"), lineageKey("sender", "alert-two")]);
	});

	it("reports reconciliation gaps without including record content", () => {
		const denied = { allowed: false, policyVersion: "disabled-baseline-v1", reason: "disabled" as const };
		expect(reconciliationKeySets({
			ingress: [{ ingressKey: "ingress-a", inboxKey: "inbox-a" }, { ingressKey: "ingress-b", inboxKey: "inbox-b" }],
			versions: [
				{ versionKey: "version-a", inboxKey: "inbox-a", expectedLineageKeys: ["lineage-a"], terminal: false },
				{ versionKey: "version-c", inboxKey: "inbox-c", expectedLineageKeys: ["lineage-c"], terminal: true },
			],
			inbox: ["inbox-a"],
			effects: [
				{ effectKey: "effect-a", inboxKey: "inbox-a", versionKey: "version-a", lineageKey: "lineage-a", decision: denied },
				{ effectKey: "effect-orphan", inboxKey: "inbox-z", versionKey: "version-z", lineageKey: "lineage-z", decision: denied },
			],
		})).toEqual({
			missingVersions: ["ingress-b"], missingInbox: ["version-c"], missingEffects: ["9:version-c|9:lineage-c"], orphanEffects: ["effect-orphan"],
			unexpectedEffects: [], duplicateEffects: [], terminalAllowedEffects: [],
		});
	});

	it("flags additional wrong-lineage, cross-paired, and duplicate effects even when valid effects exist", () => {
		const denied = { allowed: false, policyVersion: "disabled-baseline-v1", reason: "disabled" as const };
		const effectA = { effectKey: "effect-a", inboxKey: "inbox-a", versionKey: "version-a", lineageKey: "lineage-a", decision: denied };
		const result = reconciliationKeySets({
			ingress: [{ ingressKey: "ingress-a", inboxKey: "inbox-a" }, { ingressKey: "ingress-b", inboxKey: "inbox-b" }],
			versions: [
				{ versionKey: "version-a", inboxKey: "inbox-a", expectedLineageKeys: ["lineage-a"], terminal: false },
				{ versionKey: "version-b", inboxKey: "inbox-b", expectedLineageKeys: ["lineage-b"], terminal: false },
			],
			inbox: ["inbox-a", "inbox-b"],
			effects: [
				effectA,
				{ ...effectA, effectKey: "effect-a-duplicate" },
				{ ...effectA, effectKey: "effect-wrong-lineage", lineageKey: "lineage-z" },
				{ effectKey: "effect-cross-paired", inboxKey: "inbox-a", versionKey: "version-b", lineageKey: "lineage-b", decision: denied },
				{ effectKey: "effect-b", inboxKey: "inbox-b", versionKey: "version-b", lineageKey: "lineage-b", decision: denied },
			],
		});
		expect(result.missingEffects).toEqual([]);
		expect(result.orphanEffects).toEqual([]);
		expect(result.unexpectedEffects).toEqual(["effect-cross-paired", "effect-wrong-lineage"]);
		expect(result.duplicateEffects).toEqual(["7:inbox-a|9:version-a|9:lineage-a"]);
	});
});

describe("IPAWS deployment policy", () => {
	const generalKvId = readFileSync("wrangler.jsonc", "utf8").match(/"binding":\s*"BEACH_DATA",\s*"id":\s*"([^"]+)"/)?.[1];
	const generalMigrationTag = readFileSync("wrangler.jsonc", "utf8").match(/"tag":\s*"([^"]+)"/)?.[1];
	function resolveProduction(config: Record<string, any>) {
		config.name = "ipaws-production-test-fixture";
		config.kv_namespaces[0].id = "1234567890abcdef1234567890abcdef";
		config.routes = [{ pattern: "ipaws-production-test.example/v1/ipaws/*", zone_name: "ipaws-production-test.example" }];
		config.vars.IPAWS_ALLOWED_TOPIC_ARNS = "";
		config.vars.IPAWS_PRODUCTION_ENDPOINT = "https://ipaws-production-test.example/v1/ipaws/pubsub";
	}
	function runPolicy(productionMutation?: (config: Record<string, any>) => void, stagingMutation?: (config: Record<string, any>) => void, deploy = false) {
		const scratch = mkdtempSync(resolve(tmpdir(), "ipaws-policy-"));
		try {
			const staging = JSON.parse(readFileSync("wrangler.ipaws.staging.jsonc", "utf8").replace(/^\s*\/\/.*$/gm, ""));
			const productionText = readFileSync("wrangler.ipaws.production.jsonc", "utf8").replace(/^\s*\/\/.*$/gm, "");
			const production = JSON.parse(productionText);
			productionMutation?.(production); stagingMutation?.(staging);
			const stagingPath = resolve(scratch, "staging.json"); const productionPath = resolve(scratch, "production.json");
			writeFileSync(stagingPath, JSON.stringify(staging)); writeFileSync(productionPath, JSON.stringify(production));
			return spawnSync(process.execPath, ["scripts/validate-ipaws-deployment-policy.mjs", ...(deploy ? ["--deploy"] : []), `--staging-config=${stagingPath}`, `--production-config=${productionPath}`], { encoding: "utf8" });
		} finally { rmSync(scratch, { recursive: true, force: true }); }
	}

	it("accepts the inert repository template but rejects unresolved real deployment", () => {
		expect(runPolicy().status).toBe(0);
		expect(runPolicy(undefined, undefined, true).status).toBe(1);
	});

	it("rejects enabled baseline behavior and staging/production resource crossover", () => {
		expect(runPolicy((config) => { config.vars.IPAWS_INGESTION_ENABLED = "true"; }).status).toBe(1);
		expect(runPolicy((config) => { config.kv_namespaces[0].id = "60f732dff736438bbb53edb2815059bb"; }).status).toBe(1);
		expect(runPolicy((config) => { config.vars.IPAWS_AUTO_CONFIRM_SUBSCRIPTION = "true"; }).status).toBe(1);
		expect(runPolicy((config) => { config.queues = { producers: [] }; }).status).toBe(1);
		 expect(runPolicy(undefined, (config) => { config.name = "ipaws-production-placeholder"; }).status).toBe(1);
		expect(runPolicy((config) => { config.name = "alabamabeachflag-api"; }).status).toBe(1);
		expect(generalKvId).toBeTruthy();
		expect(runPolicy((config) => { config.kv_namespaces[0].id = generalKvId; }).status).toBe(1);
		expect(runPolicy((config) => { config.vars.UNREVIEWED_WEBHOOK_URL = "https://example.invalid"; }).status).toBe(1);
	});

	it("rejects missing required resources and every unreviewed top-level binding", () => {
		expect(runPolicy((config) => { delete config.routes; }).status).toBe(1);
		expect(runPolicy((config) => { delete config.kv_namespaces; }).status).toBe(1);
		expect(runPolicy((config) => { delete config.durable_objects; }).status).toBe(1);
		expect(runPolicy((config) => { delete config.observability; }).status).toBe(1);
		expect(runPolicy((config) => { config.analytics_engine_datasets = [{ binding: "UNREVIEWED" }]; }).status).toBe(1);
	});

	it("rejects every unreviewed nested binding, route, and migration property", () => {
		expect(runPolicy((config) => { config.kv_namespaces[0].preview_id = "1234567890abcdef1234567890abcdef"; }).status).toBe(1);
		expect(runPolicy((config) => { config.durable_objects.bindings[0].script_name = "another-worker"; }).status).toBe(1);
		expect(runPolicy((config) => { config.migrations[0].deleted_classes = ["OtherClass"]; }).status).toBe(1);
		expect(runPolicy((config) => { config.routes[0].custom_domain = true; }).status).toBe(1);
		expect(generalMigrationTag).toBeTruthy();
		expect(runPolicy((config) => { config.migrations[0].tag = generalMigrationTag; }).status).toBe(1);
	});

	it.each([
		"https://user:password@ipaws-production-test.example/v1/ipaws/pubsub",
		"https://ipaws-production-test.example:8443/v1/ipaws/pubsub",
		"https://ipaws-production-test.example/v1/ipaws/pubsub?token=value",
		"https://ipaws-production-test.example/v1/ipaws/pubsub#fragment",
	])("rejects non-canonical reviewed endpoint %s", (endpoint) => {
		const result = runPolicy((config) => { resolveProduction(config); config.vars.IPAWS_PRODUCTION_ENDPOINT = endpoint; }, undefined, true);
		expect(result.status).toBe(1);
	});

	it("accepts a structurally valid resolved test fixture in deploy mode", () => {
		const result = runPolicy((config) => {
			resolveProduction(config);
		}, undefined, true);
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
	});

	it("requires a deny-all TopicArn bootstrap and rejects invented or staged production allowlists", () => {
		expect(runPolicy((config) => { resolveProduction(config); config.vars.IPAWS_ALLOWED_TOPIC_ARNS = "arn:aws:sns:us-east-1:111111111111:EAS_PUBLIC_FEED"; }, undefined, true).status).toBe(1);
		expect(runPolicy((config) => { resolveProduction(config); config.vars.IPAWS_ALLOWED_TOPIC_ARNS = "arn:aws-us-gov:sns:us-gov-west-1:594897668655:EAS_PUBLIC_FEED"; }, undefined, true).status).toBe(1);
	});
});
