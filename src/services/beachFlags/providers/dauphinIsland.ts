

import { BeachFlagProviderResult } from "../types";

export async function getDauphinIslandFlags(): Promise<BeachFlagProviderResult> {
	return {
		reports: [],
		errors: [
			{
				beachId: "dauphin-island-public-beach",
				displayName: "Dauphin Island Public Beach",
				message: "Official beach flag status is currently published through the Dauphin Island Facebook page. Backend parser not implemented yet.",
			},
			{
				beachId: "dauphin-island-east-end",
				displayName: "Dauphin Island East End",
				message: "Official beach flag status is currently published through the Dauphin Island Facebook page. Backend parser not implemented yet.",
			},
		],
	};
}