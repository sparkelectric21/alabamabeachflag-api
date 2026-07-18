const BEACH_TIME_ZONE = "America/Chicago";

function partsAt(date: Date): Record<string, number> {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: BEACH_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
		hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
	}).formatToParts(date);
	return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
}

export function beachDate(date: Date): string {
	const p = partsAt(date);
	return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function noaaDate(date: Date): string {
	return beachDate(date).replaceAll("-", "");
}

export function parseNoaaLocalTime(value: string, previous?: Date): Date {
	const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(value);
	if (!match) throw new Error("Malformed NOAA prediction time");
	const fields = match.slice(1).map(Number);
	const desired = Date.UTC(fields[0], fields[1] - 1, fields[2], fields[3], fields[4]);
	let result = new Date(desired);
	for (let attempt = 0; attempt < 3; attempt++) {
		const p = partsAt(result);
		const represented = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
		result = new Date(result.getTime() + desired - represented);
	}
	// NOAA local timestamps omit the DST fold. Preserve chronological order when
	// the repeated fall-back hour occurs.
	if (previous && result <= previous) {
		const later = new Date(result.getTime() + 60 * 60 * 1000);
		const p = partsAt(later);
		if (p.year === fields[0] && p.month === fields[1] && p.day === fields[2] && p.hour === fields[3] && p.minute === fields[4]) result = later;
	}
	if (!Number.isFinite(result.getTime())) throw new Error("Invalid NOAA prediction time");
	return result;
}
