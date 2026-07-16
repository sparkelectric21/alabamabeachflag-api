

import { BeachFlagProviderResult } from "../types";

export async function getDauphinIslandFlags(): Promise<BeachFlagProviderResult> {
	return {
		reports: [],
		errors: [
			{
				beachId: "dauphin-island-public-beach",
				displayName: "Dauphin Island Public Beach",
					message: "provider_unavailable",
			},
			{
				beachId: "dauphin-island-east-end",
				displayName: "Dauphin Island East End",
					message: "provider_unavailable",
			},
		],
	};
}
