import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const rawArgument = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const phase = rawArgument("phase") ?? "disabled-baseline";
const requireComplete = process.argv.includes("--require-complete");
const evidenceDefaults = { "disabled-baseline": "config/ipaws-production-disabled-baseline-evidence.json", "passive-ingestion": "config/ipaws-production-passive-ingestion-evidence.json" };
const evidenceKeys = {
	"disabled-baseline": ["independentTechnicalReview", "resourceIsolation", "automaticDeploymentGovernance", "dedicatedKvIdentity", "proposedResourceIdentities", "disabledCapabilityBaseline", "inertPreRoutingResponse", "analyticsAccess", "rollbackAndVerificationPlan", "dnsReadiness", "metricsSecretReadiness", "releaseCredentialReadiness", "githubEnvironmentReadiness", "runnerDiagnostic"],
	"passive-ingestion": ["disabledBaselineDeployment", "femaProductionTopic", "awsPartitionAndRegion", "subscriptionInitiation", "subscriptionArnAndState", "deliveryRetryPolicy", "rawMessageDelivery", "dlqRedrive", "auxiliaryFormats", "nonemptyTopicAllowlistReview", "ingestionEnablementApproval", "automaticConfirmationDisabled", "notificationsAndEffectsDisabled"],
};
const evidencePacketFiles = {
	"disabled-baseline": {
		independentTechnicalReview: "config/ipaws-production-evidence/independent-review.json",
		analyticsAccess: "config/ipaws-production-evidence/analytics-access.json",
		dnsReadiness: "config/ipaws-production-evidence/dns-readiness.json",
		metricsSecretReadiness: "config/ipaws-production-evidence/metrics-secret-readiness.json",
		releaseCredentialReadiness: "config/ipaws-production-evidence/release-credential-readiness.json",
		githubEnvironmentReadiness: "config/ipaws-production-evidence/github-environment-readiness.json",
		runnerDiagnostic: "config/ipaws-production-evidence/runner-diagnostic.json",
	},
};
const ownerKeys = ["monitoring", "privacy", "incidentResponse", "femaCoordination", "secretCustody", "rollback"];
const canonicalOwner = "william-dickens";
const hex = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const hash = (value) => createHash("sha256").update(value).digest("hex");
if (!(phase in evidenceDefaults)) { console.error("- evidence phase must be disabled-baseline or passive-ingestion"); process.exit(1); }
const file = (value) => resolve(root, value);
const packetDirectory = rawArgument("packet-dir");
const packetFile = (value) => packetDirectory ? resolve(packetDirectory, basename(value)) : file(value);
const evidencePath = file(rawArgument("evidence") ?? evidenceDefaults[phase]);
const configPath = file(rawArgument("config") ?? "wrangler.ipaws.production.jsonc");
const evidenceSource = readFileSync(evidencePath);
const evidence = JSON.parse(evidenceSource);
const configSource = readFileSync(configPath, "utf8");
let json = "", string = false, escaped = false, line = false, block = false;
for (let index = 0; index < configSource.length; index++) {
	const character = configSource[index], next = configSource[index + 1];
	if (line) { if (character === "\n") { line = false; json += character; } continue; }
	if (block) { if (character === "*" && next === "/") { block = false; index++; } continue; }
	if (string) { json += character; if (escaped) escaped = false; else if (character === "\\") escaped = true; else if (character === '"') string = false; continue; }
	if (character === '"') { string = true; json += character; continue; }
	if (character === "/" && next === "/") { line = true; index++; continue; }
	if (character === "/" && next === "*") { block = true; index++; continue; }
	json += character;
}
const config = JSON.parse(json);
const failures = [];
const fail = (condition, message) => { if (condition) failures.push(message); };
const exactProperties = (value, properties, name) => fail(!value || Object.keys(value).sort().join(",") !== [...properties].sort().join(","), `${name} contains unapproved properties`);

function validateDisabledBaselinePacket(key, packet) {
	if (key === "independentTechnicalReview") {
		exactProperties(packet, ["reviewPhase", "scope", "reviewedAtUtc", "verdict", "exactCommitAcceptance", "reviewedHeadStoredInManifest"], "independent review packet");
		fail(packet?.reviewPhase !== "disabled-baseline-final-evidence", "independent review phase is invalid");
		fail(packet?.scope !== "fresh-release-environment-credential-runner-and-disabled-baseline-evidence", "independent review scope is invalid");
		fail(packet?.verdict !== "approve", "independent review verdict must be approve");
		fail(packet?.exactCommitAcceptance !== "external-workflow-input-after-merge", "exact-head acceptance must remain external");
		fail(packet?.reviewedHeadStoredInManifest !== false, "review packet must not embed a reviewed head");
		fail(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(packet?.reviewedAtUtc ?? ""), "independent review timestamp is invalid");
	}
	if (key === "metricsSecretReadiness") {
		exactProperties(packet, ["observedAtUtc", "environment", "secretName", "generation", "minimumRandomBytes", "storedAs", "secretValueRetainedInRepository", "secretValueRetrievedForVerification", "workflowDispatched"], "metrics secret packet");
		fail(packet?.environment !== "ipaws-production-release", "metrics secret environment is invalid");
		fail(packet?.secretName !== "IPAWS_METRICS_READ_TOKEN", "metrics secret name is invalid");
		fail(packet?.generation !== "cryptographically-secure-operating-system-randomness", "metrics secret generation method is invalid");
		fail(!Number.isInteger(packet?.minimumRandomBytes) || packet.minimumRandomBytes < 32, "metrics secret must contain at least 32 random bytes");
		fail(packet?.storedAs !== "protected-github-environment-secret", "metrics secret storage is invalid");
		fail(packet?.secretValueRetainedInRepository !== false || packet?.secretValueRetrievedForVerification !== false, "metrics secret value must not be retained or retrieved");
		fail(packet?.workflowDispatched !== false, "metrics readiness must not claim a workflow dispatch");
		fail(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(packet?.observedAtUtc ?? ""), "metrics secret observation timestamp is invalid");
	}
	if (key === "githubEnvironmentReadiness") {
		exactProperties(packet, ["observedAtUtc", "environment", "deploymentBranches", "secretNames", "variableNames", "releaseEnableGatePresent", "workflowDispatched"], "GitHub environment packet");
		fail(packet?.environment !== "ipaws-production-release", "GitHub environment name is invalid");
		fail(JSON.stringify(packet?.deploymentBranches) !== JSON.stringify(["main"]), "GitHub environment must be restricted to main");
		fail(JSON.stringify([...(packet?.secretNames ?? [])].sort()) !== JSON.stringify(["CLOUDFLARE_API_TOKEN", "IPAWS_METRICS_READ_TOKEN"].sort()), "GitHub environment secret names are invalid");
		fail(JSON.stringify(packet?.variableNames) !== JSON.stringify(["CLOUDFLARE_ACCOUNT_ID"]), "GitHub environment variable names are invalid");
		fail(packet?.releaseEnableGatePresent !== false, "release-enable gate must remain absent");
		fail(packet?.workflowDispatched !== false, "GitHub environment must not claim a workflow dispatch");
		fail(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(packet?.observedAtUtc ?? ""), "GitHub environment observation timestamp is invalid");
	}
	if (key === "releaseCredentialReadiness") {
		exactProperties(packet, ["observedAtUtc", "credentialName", "environment", "expiresOn", "accountScope", "zoneScope", "permissions", "excludedPermissions", "tokenValueRetainedInRepository", "tokenValueRetrievedForVerification"], "release credential packet");
		fail(packet?.credentialName !== "IPAWS production release bootstrap", "release credential name is invalid");
		fail(packet?.environment !== "ipaws-production-release", "release credential environment is invalid");
		fail(packet?.expiresOn !== "2026-10-09", "release credential expiration is invalid");
		fail(packet?.accountScope !== "approved-cloudflare-account-only" || packet?.zoneScope !== "alabamabeachflag.com-only", "release credential resource scope is invalid");
		fail(JSON.stringify(packet?.permissions) !== JSON.stringify(["Workers Scripts:Edit", "Workers Routes:Edit"]), "release credential permissions are invalid");
		for (const permission of ["DNS:Edit", "KV Storage:Edit", "D1:Edit", "R2:Edit", "Queues:Edit", "Workers AI:Edit", "Billing:Edit", "Memberships:Edit", "Account Administration:Edit"]) fail(!packet?.excludedPermissions?.includes(permission), `release credential must exclude ${permission}`);
		fail(packet?.tokenValueRetainedInRepository !== false || packet?.tokenValueRetrievedForVerification !== false, "release credential value must not be retained or retrieved");
	}
	if (key === "runnerDiagnostic") {
		exactProperties(packet, ["observedAtUtc", "environment", "runId", "headSha", "runner", "checkoutCompleted", "stoppingStep", "failureClass", "laterStepsExecuted", "cloudflareCommandExecuted", "workflowDispatchedForDeployment"], "runner diagnostic packet");
		fail(packet?.environment !== "ipaws-production-release", "runner diagnostic environment is invalid");
		fail(packet?.runId !== 37072027774 || packet?.headSha !== "be2425df4be38be9d31174cf0ef88231484b9a74", "runner diagnostic immutable identity is invalid");
		fail(packet?.runner !== "ubuntu-latest" || packet?.checkoutCompleted !== true, "runner diagnostic did not establish runner acquisition and checkout");
		fail(packet?.stoppingStep !== "Validate immutable approval inputs" || packet?.failureClass !== "release_gate_absent", "runner diagnostic did not fail at the expected gate");
		fail(packet?.laterStepsExecuted !== false || packet?.cloudflareCommandExecuted !== false || packet?.workflowDispatchedForDeployment !== false, "runner diagnostic must not claim deployment activity");
	}
}

function validateManifest(manifest, expectedPhase, complete, expectedConfigurationDigest) {
	const allowedEvidence = new Set(evidenceKeys[expectedPhase]);
	const expectedTopLevel = expectedPhase === "passive-ingestion"
		? "configurationSha256,disabledBaseline,evidence,owners,phase,schemaVersion"
		: "configurationSha256,evidence,owners,phase,schemaVersion";
	fail(manifest?.schemaVersion !== 2, `${expectedPhase} evidence schemaVersion must be 2`);
	fail(manifest?.phase !== expectedPhase, `evidence phase must be ${expectedPhase}`);
	fail(!manifest || Object.keys(manifest).sort().join(",") !== expectedTopLevel, `${expectedPhase} evidence manifest contains unapproved top-level fields`);
	fail(!manifest?.evidence || Object.keys(manifest.evidence).sort().join(",") !== [...allowedEvidence].sort().join(","), `${expectedPhase} evidence manifest must contain every phase requirement exactly once`);
	const packets = new Set();
	for (const [key, item] of Object.entries(manifest?.evidence ?? {})) {
		fail(!allowedEvidence.has(key), `unapproved ${expectedPhase} evidence field: ${key}`);
		fail(!item || Object.keys(item).sort().join(",") !== "evidenceSha256,packetSha256,status", `${expectedPhase}.${key} contains unapproved properties`);
		fail(!["unverified", "verified"].includes(item?.status), `${expectedPhase}.${key} has an invalid status`);
		if (item?.status === "unverified") fail(item.packetSha256 !== null || item.evidenceSha256 !== null, `${expectedPhase}.${key} must not contain hashes until verified`);
		if (item?.status === "verified") {
			fail(!hex(item.packetSha256), `${expectedPhase}.${key} verified evidence must contain a packet SHA-256`);
			fail(item.evidenceSha256 !== hash(`${expectedPhase}:${key}:${item.packetSha256}`), `${expectedPhase}.${key} evidence is not bound to its phase and requirement`);
			const packetPath = evidencePacketFiles[expectedPhase]?.[key];
			if (packetPath) {
				const packetSource = readFileSync(packetFile(packetPath));
				fail(item.packetSha256 !== hash(packetSource), `${expectedPhase}.${key} packet digest does not match its reviewed repository evidence`);
				if (expectedPhase === "disabled-baseline") validateDisabledBaselinePacket(key, JSON.parse(packetSource));
			}
			fail(packets.has(item.packetSha256), `${expectedPhase} evidence packets must not be reused across requirements`);
			packets.add(item.packetSha256);
		}
		if (complete) fail(item?.status !== "verified", `${expectedPhase}.${key} evidence is not verified`);
	}
	fail(!manifest?.owners || Object.keys(manifest.owners).sort().join(",") !== [...ownerKeys].sort().join(","), `${expectedPhase} evidence must contain every operational owner exactly once`);
	for (const [key, owner] of Object.entries(manifest?.owners ?? {})) fail(owner !== canonicalOwner, `${expectedPhase}.${key} owner must be ${canonicalOwner}`);
	if (complete) {
		fail(!hex(manifest.configurationSha256), `${expectedPhase} evidence must pin a configuration SHA-256`);
		if (expectedConfigurationDigest) fail(manifest.configurationSha256 !== expectedConfigurationDigest, `${expectedPhase} evidence must pin the exact phase configuration digest`);
	}
	return packets;
}

const configDigest = hash(configSource);
const currentPackets = validateManifest(evidence, phase, requireComplete, requireComplete ? configDigest : undefined);
const topicAllowlist = config.vars?.IPAWS_ALLOWED_TOPIC_ARNS;
const disabledFlags = ["IPAWS_AUTO_CONFIRM_SUBSCRIPTION", "IPAWS_NOTIFICATIONS_ENABLED", "IPAWS_DOWNSTREAM_EFFECTS_ENABLED"];
if (phase === "disabled-baseline") {
	fail(config.vars?.IPAWS_INGESTION_ENABLED !== "false", "disabled-baseline ingestion must remain false");
	fail(topicAllowlist !== "", "disabled-baseline TopicArn allowlist must be empty");
	for (const flag of disabledFlags) fail(config.vars?.[flag] !== "false", `disabled-baseline ${flag} must remain false`);
} else {
	fail(config.vars?.IPAWS_INGESTION_ENABLED !== "true", "passive-ingestion ingestion must be explicitly enabled");
	fail(!/^arn:(?:aws|aws-us-gov):sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]+$/.test(topicAllowlist ?? ""), "passive-ingestion TopicArn allowlist must contain exactly one structurally valid reviewed TopicArn");
	for (const flag of disabledFlags) fail(config.vars?.[flag] !== "false", `passive-ingestion ${flag} must remain false`);
}

if (phase === "passive-ingestion") {
	fail(!evidence.disabledBaseline || Object.keys(evidence.disabledBaseline).sort().join(",") !== "configurationSha256,deploymentPacketSha256,evidenceManifestSha256", "passive-ingestion disabledBaseline binding contains unapproved properties");
	if (requireComplete) {
		const baselinePath = file(rawArgument("baseline-evidence") ?? evidenceDefaults["disabled-baseline"]);
		const baselineConfigArgument = rawArgument("baseline-config");
		const baselineSource = readFileSync(baselinePath);
		const baseline = JSON.parse(baselineSource);
		fail(!baselineConfigArgument, "passive-ingestion requires the exact preserved disabled-baseline configuration artifact");
		const baselineConfigDigest = baselineConfigArgument ? hash(readFileSync(file(baselineConfigArgument))) : undefined;
		const baselinePackets = validateManifest(baseline, "disabled-baseline", true, baselineConfigDigest);
		fail(!hex(evidence.disabledBaseline?.configurationSha256), "passive-ingestion must bind the disabled-baseline configuration digest");
		fail(evidence.disabledBaseline?.configurationSha256 !== baselineConfigDigest, "passive-ingestion baseline configuration binding does not match the preserved artifact");
		fail(evidence.disabledBaseline?.evidenceManifestSha256 !== hash(baselineSource), "passive-ingestion must bind the exact disabled-baseline evidence manifest");
		fail(!hex(evidence.disabledBaseline?.deploymentPacketSha256), "passive-ingestion must bind independently verified disabled-baseline deployment evidence");
		const deploymentPacket = hash(`disabled-baseline-deployment:${evidence.disabledBaseline?.configurationSha256}:${evidence.disabledBaseline?.evidenceManifestSha256}:${evidence.disabledBaseline?.deploymentPacketSha256}`);
		fail(evidence.evidence?.disabledBaselineDeployment?.packetSha256 !== deploymentPacket, "disabled-baseline deployment evidence does not match the bound manifest, configuration, and deployment packet");
		for (const packet of currentPackets) fail(baselinePackets.has(packet), "evidence packets must not be reused across phases");
	}
}

if (failures.length) { console.error(failures.map((failure) => `- ${failure}`).join("\n")); process.exit(1); }
console.log(`IPAWS production evidence passed (${phase}; ${requireComplete ? "complete" : "template"}; values not emitted).`);
