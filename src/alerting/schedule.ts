const TIME_ZONE = "America/Chicago";
export const MISSING_REPORT_GRACE_MINUTES = 30;

interface CentralParts { date: string; hour: number; minute: number }

function centralParts(date: Date): CentralParts {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: TIME_ZONE,
		year: "numeric", month: "2-digit", day: "2-digit",
		hour: "2-digit", minute: "2-digit", hourCycle: "h23",
	}).formatToParts(date);
	const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
	return {
		date: `${value("year")}-${value("month")}-${value("day")}`,
		hour: Number(value("hour")),
		minute: Number(value("minute")),
	};
}

export function dueVerificationSlot(now: Date, graceMinutes = MISSING_REPORT_GRACE_MINUTES): string | undefined {
	const local = centralParts(now);
	for (const hour of [12, 7]) {
		if (local.hour * 60 + local.minute >= hour * 60 + graceMinutes) {
			return `${local.date}T${String(hour).padStart(2, "0")}`;
		}
	}
	return undefined;
}

export function reportKeyForSlot(slot: string): string {
	return `verification:report:${slot.slice(0, 10)}:${slot.slice(-2)}`;
}
