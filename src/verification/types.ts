export type VerificationStatus = "pass" | "warning" | "fail";
export type VerifierId = "gulf-shores-flags" | "orange-beach-flags";

export interface VerificationCheck {
	name: string;
	status: VerificationStatus;
	message: string;
	provider?: string;
	location?: string;
	expectedValue?: string;
	actualValue?: string;
}

export interface VerificationReport {
	version: 1 | 2;
	verifierId?: VerifierId;
	verifierName?: string;
	slot: string;
	startedAt: string;
	completedAt: string;
	status: VerificationStatus;
	checks: VerificationCheck[];
}
