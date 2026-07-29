const TIME_ZONE = "America/Chicago";
export const BEACH_EVENT_REFRESH_HOUR = 7;
export const BEACH_EVENT_SCHEDULE_DESCRIPTION = "Daily at 7:00 AM Central Time (America/Chicago; CST/CDT)";

function centralHour(date: Date): number {
	const part = new Intl.DateTimeFormat("en-US", {
		timeZone: TIME_ZONE,
		hour: "2-digit",
		hourCycle: "h23",
	}).formatToParts(date).find((item) => item.type === "hour");
	return Number(part?.value);
}

export function isBeachEventRefreshHour(date: Date): boolean {
	return centralHour(date) === BEACH_EVENT_REFRESH_HOUR;
}

export function nextBeachEventRefresh(after: Date): string {
	const nextHour = new Date(Math.floor(after.getTime() / 3_600_000) * 3_600_000 + 3_600_000);
	for (let offset = 0; offset < 48; offset += 1) {
		const candidate = new Date(nextHour.getTime() + offset * 3_600_000);
		if (isBeachEventRefreshHour(candidate)) return candidate.toISOString();
	}
	throw new Error("Unable to calculate next beach-event refresh");
}
