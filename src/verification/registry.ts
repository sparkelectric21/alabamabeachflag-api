import type { VerificationReport, VerifierId } from "./types";

export interface VerifierDefinition {
	id: VerifierId;
	displayName: string;
	provider: string;
	locations: ReadonlyArray<{ id: string; name: string }>;
}

export const VERIFIERS: readonly VerifierDefinition[] = [
	{
		id: "gulf-shores-flags", displayName: "Gulf Shores beach flags", provider: "City of Gulf Shores",
		locations: [
			{ id: "gulf-shores-public-beach", name: "Gulf Shores Public Beach" },
			{ id: "gulf-state-park-pavilion", name: "Gulf State Park Pavilion" },
			{ id: "little-lagoon-pass", name: "Little Lagoon Pass" },
		],
	},
	{
		id: "orange-beach-flags", displayName: "Orange Beach beach flags", provider: "City of Orange Beach",
		locations: [
			{ id: "cotton-bayou", name: "Cotton Bayou" },
			{ id: "alabama-point", name: "Alabama Point" },
			{ id: "florida-point", name: "Florida Point" },
		],
	},
];

export const verifierById = (id: VerifierId) => VERIFIERS.find((item) => item.id === id)!;
export const latestReportKey = (id: VerifierId) => `verification:${id}:latest`;
export const historyPrefix = (id: VerifierId) => `verification:${id}:report:`;
export const historyReportKey = (id: VerifierId, report: VerificationReport) =>
	`${historyPrefix(id)}${report.startedAt.slice(0, 10)}:${report.slot.slice(-2)}`;

export async function persistVerifierReport(env: { BEACH_DATA: KVNamespace }, report: VerificationReport & { verifierId: VerifierId }) {
	const writes: Promise<void>[] = [
		env.BEACH_DATA.put(latestReportKey(report.verifierId), JSON.stringify(report)),
		env.BEACH_DATA.put(historyReportKey(report.verifierId, report), JSON.stringify(report), { expirationTtl: 30 * 24 * 60 * 60 }),
	];
	// Version-1 readers remain supported while new readers use collision-free keys.
	if (report.verifierId === "gulf-shores-flags") {
		writes.push(env.BEACH_DATA.put("verification:latest", JSON.stringify(report)));
		writes.push(env.BEACH_DATA.put(`verification:report:${report.startedAt.slice(0, 10)}:${report.slot.slice(-2)}`, JSON.stringify(report), { expirationTtl: 30 * 24 * 60 * 60 }));
	}
	await Promise.all(writes);
}
