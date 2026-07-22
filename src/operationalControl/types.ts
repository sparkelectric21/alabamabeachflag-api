export const CONTROL_IDS = [
	"global.liveData",
	"domains.beachFlags",
	"providers.gulfShoresFlags",
	"providers.orangeBeachFlags",
] as const;

export type ControlId = typeof CONTROL_IDS[number];
export type ControlState = "enabled" | "disabled" | "monitorOnly";
export type ExpiryBehavior = "require_review" | "enable";

export interface OperationalControlValue {
	state: ControlState;
	reasonCode?: string;
	operatorReason?: string;
	activatedAt?: string;
	expiresAt?: string;
	onExpiry?: ExpiryBehavior;
	incidentId?: string;
}

export interface VersionPolicy {
	mode: "none" | "recommended" | "required";
	minimumSupported: { version: string; build: number } | null;
	recommended: { version: string; build: number } | null;
	revision: string | null;
}

export interface OperationalControlDocument {
	schemaVersion: 1;
	revision: string;
	updatedAt: string;
	updatedBy: string;
	controls: Record<ControlId, OperationalControlValue>;
	versionPolicy: VersionPolicy;
}

export interface OperationalControlAudit {
	schemaVersion: 1;
	auditId: string;
	requestId: string;
	timestamp: string;
	actor: string;
	authenticationMethod: string;
	action: "transition" | "rollback";
	controlId: ControlId | null;
	previousState: ControlState | null;
	nextState: ControlState | null;
	reasonCode: string;
	operatorReason: string;
	incidentId: string | null;
	resultingRevision: string;
}

export type FlagProvider = "gulfShoresFlags" | "orangeBeachFlags";
export type AvailabilityReason = "temporarily_disabled" | "stale" | "provider_unavailable" | "validation_failed";

export interface EffectiveControl {
	state: ControlState;
	controlId: ControlId | null;
	revision: string;
	effectiveAt: string | null;
	retryAfter: string | null;
	wouldBlock: boolean;
}
