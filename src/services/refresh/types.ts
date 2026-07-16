export type RefreshJob = "beach-flags" | "beach-conditions" | "water-quality";
export type RefreshTrigger = "admin" | "scheduled";

export interface RefreshRunRequest {
	job: RefreshJob;
	trigger: RefreshTrigger;
	idempotencyKey: string;
}

export type RefreshOutcome =
	| "completed"
	| "duplicate"
	| "in_progress"
	| "cooldown"
	| "fenced"
	| "failed";

export interface RefreshRunResult {
	outcome: RefreshOutcome;
	generation?: number;
	retryAt?: string;
	generatedAt?: string;
	count?: number;
}
