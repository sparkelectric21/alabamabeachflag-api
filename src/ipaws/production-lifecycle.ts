export type ProductionLifecycleType = "Alert" | "Update" | "Cancel" | "Ack" | "Error";

export interface ProductionAlertVersion {
	schemaVersion: 1;
	environment: "production";
	source: "fema-ipaws";
	messageId: string;
	topicArn: string;
	identifier: string;
	sender: string;
	sentAt: string;
	expiresAt: string | null;
	messageType: ProductionLifecycleType;
	status: "Actual" | "Exercise" | "System" | "Test" | "Draft";
	scope: "Public" | "Restricted" | "Private";
	references: string[];
	contentDigest: string;
	geocodes: string[];
}

export interface ProductionLifecycleProjection {
	lineageKey: string;
	currentVersion: ProductionAlertVersion | null;
	state: "active" | "cancelled" | "non_actionable";
	orphanedVersionCount: number;
	versionCount: number;
	updatedAt: string;
	notificationsEnabled: false;
}

export interface ProductionAuthorizationPolicy {
	policyVersion: string;
	enabled: boolean;
	allowedTopicArns: readonly string[];
	allowedGeocodes: readonly string[];
	allowedStatuses: readonly ProductionAlertVersion["status"][];
	allowedScopes: readonly ProductionAlertVersion["scope"][];
	maximumAgeSeconds: number;
	maximumFutureSkewSeconds: number;
}

export interface ProductionAuthorizationDecision {
	allowed: boolean;
	policyVersion: string;
	reason: "authorized" | "disabled" | "topic" | "status" | "scope" | "geography" | "freshness" | "lifecycle";
}

export interface ProductionLedgerTransaction {
	appendVersion(versionKey: string, version: ProductionAlertVersion): Promise<void>;
	/** Must read the same strongly consistent transactional snapshot mutated by appendVersion. */
	listVersionsForLineage(lineageKey: string): Promise<ProductionAlertVersion[]>;
	putProjection(projection: ProductionLifecycleProjection): Promise<void>;
	insertInboxIfAbsent(inboxKey: string): Promise<boolean>;
	insertEffectIfAbsent(effectKey: string, decision: ProductionAuthorizationDecision): Promise<boolean>;
	suppressEffectsForLineage(lineageKey: string): Promise<void>;
}

export interface ProductionLifecycleLedger {
	transaction<T>(operation: (transaction: ProductionLedgerTransaction) => Promise<T>): Promise<T>;
}

export interface ProductionApplyResult {
	duplicate: boolean;
	effectCreated: boolean;
	decision: ProductionAuthorizationDecision;
	projection: ProductionLifecycleProjection;
	projections: ProductionLifecycleProjection[];
}

function stableKey(parts: readonly string[]): string {
	return parts.map((part) => `${part.length}:${part}`).join("|");
}

export function lineageKey(sender: string, identifier: string): string {
	return stableKey([sender, identifier]);
}

function referencedLineages(version: ProductionAlertVersion): Set<string> {
	return new Set(version.references.flatMap((reference) => {
		const parts = reference.split(",");
		return parts.length >= 2 && parts[0] && parts[1] ? [lineageKey(parts[0], parts[1])] : [];
	}));
}

function orderVersions(left: ProductionAlertVersion, right: ProductionAlertVersion): number {
	const sent = Date.parse(left.sentAt) - Date.parse(right.sentAt);
	if (sent !== 0) return sent;
	const digest = left.contentDigest.localeCompare(right.contentDigest);
	return digest !== 0 ? digest : left.messageId.localeCompare(right.messageId);
}

export function projectProductionLifecycle(versions: readonly ProductionAlertVersion[], targetLineage: string): ProductionLifecycleProjection {
	const relevant = versions
		.filter((version) => lineageKey(version.sender, version.identifier) === targetLineage || referencedLineages(version).has(targetLineage))
		.sort(orderVersions);
	let current: ProductionAlertVersion | null = null;
	let state: ProductionLifecycleProjection["state"] = "non_actionable";
	let orphanedVersionCount = 0;
	for (const version of relevant) {
		if (version.messageType === "Alert" && lineageKey(version.sender, version.identifier) === targetLineage) {
			current = version;
			state = "active";
		} else if (version.messageType === "Update" || version.messageType === "Cancel") {
			if (!current || state === "cancelled" || !referencedLineages(version).has(targetLineage)) { orphanedVersionCount++; continue; }
			current = version;
			state = version.messageType === "Cancel" ? "cancelled" : "active";
		}
	}
	return {
		lineageKey: targetLineage,
		currentVersion: current,
		state,
		orphanedVersionCount,
		versionCount: relevant.length,
		updatedAt: relevant.at(-1)?.sentAt ?? new Date(0).toISOString(),
		notificationsEnabled: false,
	};
}

export function authorizeProductionVersion(version: ProductionAlertVersion, policy: ProductionAuthorizationPolicy, now = Date.now()): ProductionAuthorizationDecision {
	if (!policy.enabled) return { allowed: false, policyVersion: policy.policyVersion, reason: "disabled" };
	if (!policy.allowedTopicArns.includes(version.topicArn)) return { allowed: false, policyVersion: policy.policyVersion, reason: "topic" };
	if (!policy.allowedStatuses.includes(version.status)) return { allowed: false, policyVersion: policy.policyVersion, reason: "status" };
	if (!policy.allowedScopes.includes(version.scope)) return { allowed: false, policyVersion: policy.policyVersion, reason: "scope" };
	const sentAt = Date.parse(version.sentAt);
	const expiresAt = version.expiresAt ? Date.parse(version.expiresAt) : null;
	if (!Number.isFinite(sentAt) || sentAt < now - policy.maximumAgeSeconds * 1_000 || sentAt > now + policy.maximumFutureSkewSeconds * 1_000
		|| (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= now))) return { allowed: false, policyVersion: policy.policyVersion, reason: "freshness" };
	if (!version.geocodes.some((geocode) => policy.allowedGeocodes.includes(geocode))) return { allowed: false, policyVersion: policy.policyVersion, reason: "geography" };
	if (version.messageType !== "Alert" && version.messageType !== "Update") return { allowed: false, policyVersion: policy.policyVersion, reason: "lifecycle" };
	return { allowed: true, policyVersion: policy.policyVersion, reason: "authorized" };
}

export async function applyProductionLifecycle(
	ledger: ProductionLifecycleLedger,
	version: ProductionAlertVersion,
	policy: ProductionAuthorizationPolicy,
): Promise<ProductionApplyResult> {
	const targets = version.messageType === "Alert"
		? [lineageKey(version.sender, version.identifier)]
		: [...referencedLineages(version)];
	if (targets.length === 0) targets.push(lineageKey(version.sender, version.identifier));
	const decision = authorizeProductionVersion(version, policy);
	const inboxKey = stableKey([version.source, version.topicArn, version.messageId, String(version.schemaVersion)]);
	return ledger.transaction(async (transaction) => {
		const inserted = await transaction.insertInboxIfAbsent(inboxKey);
		if (!inserted) {
			const projections = await Promise.all(targets.map(async (target) => projectProductionLifecycle(await transaction.listVersionsForLineage(target), target)));
			return { duplicate: true, effectCreated: false, decision, projection: projections[0], projections };
		}
		await transaction.appendVersion(stableKey([version.sender, version.identifier, version.sentAt, version.contentDigest]), version);
		const projections = await Promise.all(targets.map(async (target) => projectProductionLifecycle(await transaction.listVersionsForLineage(target), target)));
		for (const projection of projections) await transaction.putProjection(projection);
		if (version.messageType === "Cancel") for (const target of targets) await transaction.suppressEffectsForLineage(target);
		// This repository only records the authorization decision. No notification or downstream effect is dispatched.
		let effectCreated = false;
		for (const target of targets) {
			const effectKey = stableKey([target, version.messageType, version.contentDigest, policy.policyVersion]);
			effectCreated = (await transaction.insertEffectIfAbsent(effectKey, decision)) || effectCreated;
		}
		return { duplicate: false, effectCreated, decision, projection: projections[0], projections };
	});
}

export function reconciliationKeySets(input: {
	ingress: readonly string[];
	versions: readonly string[];
	inbox: readonly string[];
	effects: readonly string[];
}): { missingVersions: string[]; missingInbox: string[]; orphanEffects: string[] } {
	const ingress = new Set(input.ingress);
	const versions = new Set(input.versions);
	const inbox = new Set(input.inbox);
	return {
		missingVersions: [...ingress].filter((key) => !versions.has(key)).sort(),
		missingInbox: [...versions].filter((key) => !inbox.has(key)).sort(),
		orphanEffects: [...new Set(input.effects)].filter((key) => !inbox.has(key)).sort(),
	};
}
