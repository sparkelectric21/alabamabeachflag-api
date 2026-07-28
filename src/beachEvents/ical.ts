import type { SourceFacts } from "./types";

function unfold(input: string): string[] {
	return input.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/);
}

const unescape = (value: string) => value.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");

function centralDate(parts: { y: number; m: number; d: number; hh: number; mm: number; ss: number }): Date {
	const target = Date.UTC(parts.y, parts.m - 1, parts.d, parts.hh, parts.mm, parts.ss);
	let guess = target;
	const formatter = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
	for (let attempt = 0; attempt < 3; attempt++) {
		const values = Object.fromEntries(formatter.formatToParts(new Date(guess)).filter((item) => item.type !== "literal").map((item) => [item.type, Number(item.value)]));
		const represented = Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute, values.second);
		const delta = target - represented;
		guess += delta;
		if (delta === 0) break;
	}
	return new Date(guess);
}

function parseDate(value: string, parameters: string, defaultDurationMs: number): { date: Date; allDay: boolean; fallbackEnd: Date } | null {
	const allDay = /VALUE=DATE/i.test(parameters) || /^\d{8}$/.test(value);
	const match = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?(Z)?$/);
	if (!match) return null;
	const [, y, m, d, hh = "00", mm = "00", ss = "00", z] = match;
	const provisional = z
		? new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss)))
		: centralDate({ y: Number(y), m: Number(m), d: Number(d), hh: Number(hh), mm: Number(mm), ss: Number(ss) });
	return { date: provisional, allDay, fallbackEnd: new Date(provisional.getTime() + (allDay ? 24 * 60 * 60 * 1000 : defaultDurationMs)) };
}

export function parseICalendar(input: string, provider: { id: string; name: string; feedURL: string }): SourceFacts[] {
	const events: SourceFacts[] = [];
	let fields: Record<string, { value: string; params: string }> | null = null;
	for (const line of unfold(input)) {
		if (line === "BEGIN:VEVENT") { fields = {}; continue; }
		if (line === "END:VEVENT" && fields) {
			const start = fields.DTSTART && parseDate(fields.DTSTART.value, fields.DTSTART.params, 60 * 60 * 1000);
			const end = fields.DTEND && parseDate(fields.DTEND.value, fields.DTEND.params, 60 * 60 * 1000);
			if (start && fields.SUMMARY?.value && fields.UID?.value) {
				events.push({
					providerId: provider.id,
					externalId: unescape(fields.UID.value),
					title: unescape(fields.SUMMARY.value),
					venue: unescape(fields.LOCATION?.value ?? ""),
					startAt: start.date.toISOString(),
					endAt: (end?.date ?? start.fallbackEnd).toISOString(),
					allDay: start.allDay,
					recurring: Boolean(fields.RRULE),
					sourceName: provider.name,
					sourceURL: provider.feedURL,
					officialURL: fields.URL?.value ? unescape(fields.URL.value) : undefined,
					description: fields.DESCRIPTION?.value ? unescape(fields.DESCRIPTION.value) : undefined,
				});
			}
			fields = null; continue;
		}
		if (!fields) continue;
		const colon = line.indexOf(":");
		if (colon < 0) continue;
		const lhs = line.slice(0, colon), value = line.slice(colon + 1);
		const [name, ...params] = lhs.split(";");
		fields[name.toUpperCase()] = { value, params: params.join(";") };
	}
	return events;
}
