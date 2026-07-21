export type VerificationStatus = "pass" | "warning" | "fail";

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
	version: 1;
	slot: string;
	startedAt: string;
	completedAt: string;
	status: VerificationStatus;
	checks: VerificationCheck[];
}
