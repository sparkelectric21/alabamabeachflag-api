import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const argument = (name, fallback) => resolve(root, process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback);
const evidence = JSON.parse(readFileSync(argument("evidence", "config/ipaws-production-evidence.json"), "utf8"));
const config = readFileSync(argument("config", "wrangler.ipaws.production.jsonc"));
const failures = [];
const fail = (condition, message) => { if (condition) failures.push(message); };
const allowedEvidence = new Set(["femaProductionContract", "snsSubscriptionAndDeliveryPolicy", "auxiliaryMessageFormats", "cloudflareResourceIsolation", "cloudflareBuildsGovernance", "analyticsAccess", "independentSecurityReview"]);
const allowedOwners = new Set(["monitoring", "privacy", "incidentResponse", "femaCoordination", "secretCustody", "rollback"]);

fail(evidence.schemaVersion !== 1, "evidence schemaVersion must be 1");
fail(Object.keys(evidence).sort().join(",") !== "configurationSha256,evidence,owners,schemaVersion", "evidence manifest contains unapproved top-level fields");
fail(!evidence.evidence || Object.keys(evidence.evidence).length !== allowedEvidence.size, "evidence manifest must contain every reviewed evidence class exactly once");
for (const [key, item] of Object.entries(evidence.evidence ?? {})) {
	fail(!allowedEvidence.has(key), `unapproved evidence field: ${key}`);
	fail(!item || Object.keys(item).sort().join(",") !== "evidenceSha256,status", `${key} contains unapproved properties`);
	fail(!["unverified", "verified"].includes(item?.status), `${key} has an invalid status`);
	fail(item?.status === "unverified" && item?.evidenceSha256 !== null, `${key} must not contain a digest until verified`);
}
fail(!evidence.owners || Object.keys(evidence.owners).length !== allowedOwners.size, "evidence manifest must contain every operational owner exactly once");
for (const key of Object.keys(evidence.owners ?? {})) fail(!allowedOwners.has(key), `unapproved owner field: ${key}`);

if (process.argv.includes("--require-complete")) {
	const configDigest = createHash("sha256").update(config).digest("hex");
	fail(evidence.configurationSha256 !== configDigest, "evidence manifest must pin the exact production configuration digest");
	for (const [key, item] of Object.entries(evidence.evidence ?? {})) {
		fail(item?.status !== "verified", `${key} evidence is not verified`);
		fail(!/^[a-f0-9]{64}$/.test(item?.evidenceSha256 ?? ""), `${key} must contain a non-reversible evidence SHA-256`);
	}
	for (const [key, owner] of Object.entries(evidence.owners ?? {})) fail(typeof owner !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,127}$/.test(owner), `${key} owner is unresolved`);
}

if (failures.length) { console.error(failures.map((failure) => `- ${failure}`).join("\n")); process.exit(1); }
console.log(`IPAWS production evidence passed (${process.argv.includes("--require-complete") ? "complete" : "template"}; values not emitted).`);
