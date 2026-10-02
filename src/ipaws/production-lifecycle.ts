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

export interface ProductionEffectRecord {
	effectKey: string;
	inboxKey: string;
	versionKey: string;
	lineageKey: string;
	decision: ProductionAuthorizationDecision;
}

export interface ProductionLedgerTransaction {
	appendVersion(versionKey: string, version: ProductionAlertVersion): Promise<void>;
	/** Must read the same strongly consistent transactional snapshot mutated by appendVersion. */
	listVersionsForLineage(lineageKey: string): Promise<ProductionAlertVersion[]>;
	putProjection(projection: ProductionLifecycleProjection): Promise<void>;
	insertInboxIfAbsent(inboxKey: string): Promise<boolean>;
	insertEffectIfAbsent(effect: ProductionEffectRecord): Promise<boolean>;
	suppressEffectsForLineage(lineageKey: string): Promise<void>;
}

export interface ProductionLifecycleLedger {
	transaction<T>(operation: (transaction: ProductionLedgerTransaction) => Promise<T>): Promise<T>;
}

export interface ProductionApplyResult {
	duplicate: boolean;
	effectCreated: boolean;
	decision: ProductionAuthorizationDecision;
	decisions: Readonly<Record<string, ProductionAuthorizationDecision>>;
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

function authorizeLineage(
	version: ProductionAlertVersion,
	policy: ProductionAuthorizationPolicy,
	projectionBefore: ProductionLifecycleProjection,
	now = Date.now(),
): ProductionAuthorizationDecision {
	const base = authorizeProductionVersion(version, policy, now);
	if (!base.allowed || version.messageType !== "Update") return base;
	return projectionBefore.state === "active" && projectionBefore.currentVersion !== null
		? base
		: { allowed: false, policyVersion: policy.policyVersion, reason: "lifecycle" };
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
	const inboxKey = stableKey([version.source, version.topicArn, version.messageId, String(version.schemaVersion)]);
	return ledger.transaction(async (transaction) => {
		const inserted = await transaction.insertInboxIfAbsent(inboxKey);
		if (!inserted) {
			const projections = await Promise.all(targets.map(async (target) => projectProductionLifecycle(await transaction.listVersionsForLineage(target), target)));
			const decisions = Object.fromEntries(projections.map((projection) => [projection.lineageKey, authorizeLineage(version, policy, projection)]));
			return { duplicate: true, effectCreated: false, decision: decisions[targets[0]], decisions, projection: projections[0], projections };
		}
		const projectionsBefore = await Promise.all(targets.map(async (target) => projectProductionLifecycle(await transaction.listVersionsForLineage(target), target)));
		const decisions = Object.fromEntries(projectionsBefore.map((projection) => [projection.lineageKey, authorizeLineage(version, policy, projection)]));
		const versionKey = stableKey([version.sender, version.identifier, version.sentAt, version.contentDigest]);
		await transaction.appendVersion(versionKey, version);
		const projections = await Promise.all(targets.map(async (target) => projectProductionLifecycle(await transaction.listVersionsForLineage(target), target)));
		for (const projection of projections) await transaction.putProjection(projection);
		if (version.messageType === "Cancel") for (const target of targets) await transaction.suppressEffectsForLineage(target);
		// This repository only records the authorization decision. No notification or downstream effect is dispatched.
		let effectCreated = false;
		for (const target of targets) {
			const effectKey = stableKey([target, version.messageType, version.contentDigest, policy.policyVersion]);
			effectCreated = (await transaction.insertEffectIfAbsent({ effectKey, inboxKey, versionKey, lineageKey: target, decision: decisions[target] })) || effectCreated;
		}
		return { duplicate: false, effectCreated, decision: decisions[targets[0]], decisions, projection: projections[0], projections };
	});
}

export function reconciliationKeySets(input: {
	ingress: readonly { ingressKey: string; inboxKey: string }[];
	versions: readonly { versionKey: string; inboxKey: string; expectedLineageKeys: readonly string[]; terminal: boolean }[];
	inbox: readonly string[];
	effects: readonly ProductionEffectRecord[];
}): { missingVersions: string[]; missingInbox: string[]; missingEffects: string[]; orphanEffects: string[]; unexpectedEffects: string[]; duplicateEffects: string[]; terminalAllowedEffects: string[] } {
	const inbox = new Set(input.inbox);
	const versionsByKey = new Map(input.versions.map((version) => [version.versionKey, version]));
	const versionInbox = new Set(input.versions.map(({ inboxKey }) => inboxKey));
	const expectedRelationships = new Set(input.versions.flatMap(({ inboxKey, versionKey, expectedLineageKeys }) =>
		expectedLineageKeys.map((target) => stableKey([inboxKey, versionKey, target]))));
	const effectRelationships = new Set(input.effects.map(({ inboxKey, versionKey, lineageKey }) => stableKey([inboxKey, versionKey, lineageKey])));
	const relationshipCounts = new Map<string, number>();
	for (const effect of input.effects) {
		const relationship = stableKey([effect.inboxKey, effect.versionKey, effect.lineageKey]);
		relationshipCounts.set(relationship, (relationshipCounts.get(relationship) ?? 0) + 1);
	}
	const terminalVersionKeys = new Set(input.versions.filter(({ terminal }) => terminal).map(({ versionKey }) => versionKey));
	return {
		missingVersions: input.ingress.filter(({ inboxKey }) => !versionInbox.has(inboxKey)).map(({ ingressKey }) => ingressKey).sort(),
		missingInbox: input.versions.filter(({ inboxKey }) => !inbox.has(inboxKey)).map(({ versionKey }) => versionKey).sort(),
		missingEffects: input.versions.flatMap(({ inboxKey, versionKey, expectedLineageKeys }) => expectedLineageKeys
			.filter((target) => !effectRelationships.has(stableKey([inboxKey, versionKey, target])))
			.map((target) => stableKey([versionKey, target]))).sort(),
		orphanEffects: input.effects.filter(({ inboxKey, versionKey }) => !inbox.has(inboxKey) || !versionsByKey.has(versionKey)).map(({ effectKey }) => effectKey).sort(),
		unexpectedEffects: input.effects.filter(({ inboxKey, versionKey, lineageKey }) => {
			const version = versionsByKey.get(versionKey);
			return Boolean(version) && inbox.has(inboxKey) && !expectedRelationships.has(stableKey([inboxKey, versionKey, lineageKey]));
		}).map(({ effectKey }) => effectKey).sort(),
		duplicateEffects: [...relationshipCounts].filter(([, count]) => count > 1).map(([relationship]) => relationship).sort(),
		terminalAllowedEffects: input.effects.filter(({ versionKey, decision }) => terminalVersionKeys.has(versionKey) && decision.allowed).map(({ effectKey }) => effectKey).sort(),
	};
}
