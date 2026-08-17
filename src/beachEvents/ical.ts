import type { SourceFacts } from "./types";
import { decodeHTMLEntities, normalizeDescription, sanitizeEventURL } from "./normalize";
import { stableHash } from "./sourceChanges";
import type { ProviderFetchDiagnostics } from "../providerHealth/types";

export class ICalendarParseError extends Error {
	readonly diagnostics: ProviderFetchDiagnostics;
	constructor(message: string, diagnostics: ProviderFetchDiagnostics) {
		super(message.slice(0, 240));
		this.name = "ICalendarParseError";
		this.diagnostics = diagnostics;
	}
}

function unfold(input: string): string[] {
	return input.replace(/^\uFEFF/, "").replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/);
}

const unescape = (value: string) => value.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");

function zonedDate(parts: { y: number; m: number; d: number; hh: number; mm: number; ss: number }, timeZone = "America/Chicago"): Date {
	const target = Date.UTC(parts.y, parts.m - 1, parts.d, parts.hh, parts.mm, parts.ss);
	let guess = target;
	let formatter: Intl.DateTimeFormat;
	try {
		formatter = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
	} catch {
		formatter = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
	}
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
	const numeric = { y: Number(y), m: Number(m), d: Number(d), hh: Number(hh), mm: Number(mm), ss: Number(ss) };
	const dateOnly = new Date(Date.UTC(numeric.y, numeric.m - 1, numeric.d));
	if (dateOnly.getUTCFullYear() !== numeric.y || dateOnly.getUTCMonth() + 1 !== numeric.m || dateOnly.getUTCDate() !== numeric.d || numeric.hh > 23 || numeric.mm > 59 || numeric.ss > 59) return null;
	const timeZone = parameters.match(/(?:^|;)TZID=(?:"([^"]+)"|([^;]+))/i)?.slice(1).find(Boolean) ?? "America/Chicago";
	const parts = numeric;
	const provisional = z
		? new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss)))
		: zonedDate(parts, timeZone);
	const tomorrow = new Date(Date.UTC(parts.y, parts.m - 1, parts.d + 1));
	const fallbackEnd = allDay
		? zonedDate({ y: tomorrow.getUTCFullYear(), m: tomorrow.getUTCMonth() + 1, d: tomorrow.getUTCDate(), hh: 0, mm: 0, ss: 0 }, timeZone)
		: new Date(provisional.getTime() + defaultDurationMs);
	return { date: provisional, allDay, fallbackEnd };
}

function cleanField(value: string): string {
	const decoded = decodeHTMLEntities(unescape(value));
	return (normalizeDescription(decoded).fullDescription ?? decoded).replace(/\s*\n\s*/g, " ").replace(/\s+/g, " ").trim();
}

function location(value: string): { venue: string; address?: string } {
	const decoded = decodeHTMLEntities(unescape(value));
	const normalized = normalizeDescription(decoded).fullDescription ?? decoded;
	const lines = normalized.split(/\n+/).map((item) => item.trim()).filter(Boolean);
	if (lines.length > 1) return { venue: lines[0], address: lines.slice(1).join(", ") };
	const single = lines[0] ?? "";
	const embeddedAddress = single.match(/^(.+?),\s*(\d{1,6}\s+.+)$/);
	if (embeddedAddress) return { venue: embeddedAddress[1].trim(), address: embeddedAddress[2].trim() };
	return /^\d{1,6}\s+\S/.test(single) ? { venue: single, address: single } : { venue: single };
}

function parsedSourceStatus(status: string | undefined, title: string, calendarMethod: string | undefined): SourceFacts["sourceStatus"] {
	if (status?.toUpperCase() === "CANCELLED" || calendarMethod?.toUpperCase() === "CANCEL" || /^\s*(?:\[?cancel(?:led|ed)\]?|cancelled\s*:)/i.test(title)) return "cancelled";
	if (/^\s*(?:\[?postponed\]?|postponed\s*:|rescheduled\s*:)/i.test(title)) return "postponed";
	if (status?.toUpperCase() === "TENTATIVE") return "tentative";
	return "confirmed";
}

function parseICalendarStrict(input: string, provider: { id: string; name: string; feedURL: string }): SourceFacts[] {
	const events: SourceFacts[] = [];
	const totalVEventCount = (input.match(/^BEGIN:VEVENT\s*$/gim) ?? []).length;
	let componentIndex = 0;
	let fields: Record<string, { value: string; params: string }> | null = null;
	let calendarMethod: string | undefined;
	let calendarStarted = false, calendarEnded = false;
	for (const line of unfold(input)) {
		const upper = line.toUpperCase();
		if (upper === "BEGIN:VCALENDAR") {
			if (calendarStarted || calendarEnded || fields) throw new Error("Malformed iCalendar: invalid VCALENDAR start");
			calendarStarted = true;
			continue;
		}
		if (upper === "END:VCALENDAR") {
			if (!calendarStarted || calendarEnded || fields) throw new Error("Malformed iCalendar: invalid VCALENDAR end");
			calendarEnded = true;
			continue;
		}
		if (upper === "BEGIN:VEVENT") {
			if (!calendarStarted || calendarEnded || fields) throw new Error("Malformed iCalendar: invalid VEVENT start");
			fields = {};
			componentIndex += 1;
			continue;
		}
		if (upper === "END:VEVENT") {
			if (!fields) throw new Error("Malformed iCalendar: unmatched END:VEVENT");
			const start = fields.DTSTART && parseDate(fields.DTSTART.value, fields.DTSTART.params, 60 * 60 * 1000);
			const end = fields.DTEND && parseDate(fields.DTEND.value, fields.DTEND.params, 60 * 60 * 1000);
			const uidValue = fields.UID?.value ? unescape(fields.UID.value).trim() : "";
			const diagnosticError = (fieldCategory: string, message: string): never => { throw new ICalendarParseError(message, {
				componentIndex, ...(uidValue ? { uidHash: stableHash(uidValue) } : {}), fieldCategory,
				totalVEventCount, validVEventCount: events.length, rejectedVEventCount: 1,
			}); };
			if (!fields.UID?.value || !uidValue) diagnosticError("uid_missing", "Malformed iCalendar: VEVENT requires UID, SUMMARY, and valid DTSTART");
			if (!fields.SUMMARY?.value) diagnosticError("summary_missing", "Malformed iCalendar: VEVENT requires UID, SUMMARY, and valid DTSTART");
			if (!fields.DTSTART?.value) diagnosticError("dtstart_missing", "Malformed iCalendar: VEVENT requires UID, SUMMARY, and valid DTSTART");
			if (!start) diagnosticError("dtstart_invalid", "Malformed iCalendar: VEVENT requires UID, SUMMARY, and valid DTSTART");
			if (fields.DTEND && !end) diagnosticError("dtend_invalid", "Malformed iCalendar: VEVENT has invalid DTEND");
			const validStart = start as NonNullable<typeof start>;
			{
				const description = fields.DESCRIPTION?.value ? unescape(fields.DESCRIPTION.value) : undefined;
				const extracted = normalizeDescription(description, [], provider.feedURL).extractedURLs;
				const propertyURL = fields.URL?.value ? sanitizeEventURL(unescape(fields.URL.value), provider.feedURL) : undefined;
				const isRegistrationURL = (url: string | undefined) => Boolean(url && /register|registration|ticket|reserve|booking|signup|sign-up/i.test(url));
				const registrationURL = isRegistrationURL(propertyURL) ? propertyURL : extracted.find(isRegistrationURL);
				const title = cleanField(fields.SUMMARY.value);
				const parsedLocation = location(fields.LOCATION?.value ?? "");
				const recurrence = fields["RECURRENCE-ID"] && parseDate(fields["RECURRENCE-ID"].value, fields["RECURRENCE-ID"].params, 0);
				const uid = uidValue;
				if (!title) diagnosticError("summary_empty", "Malformed iCalendar: VEVENT has an empty UID or SUMMARY");
				if (fields["RECURRENCE-ID"] && !recurrence) diagnosticError("recurrence_id_invalid", "Malformed iCalendar: VEVENT has invalid RECURRENCE-ID");
				const eventEnd = end?.date ?? validStart.fallbackEnd;
				if (eventEnd.getTime() <= validStart.date.getTime()) diagnosticError("event_range_invalid", "Malformed iCalendar: VEVENT end must follow start");
				events.push({
					providerId: provider.id,
					externalId: recurrence ? `${uid}::${recurrence.date.toISOString()}` : uid,
					title,
					venue: parsedLocation.venue,
					...(parsedLocation.address ? { address: parsedLocation.address } : {}),
					startAt: validStart.date.toISOString(),
					endAt: eventEnd.toISOString(),
					allDay: validStart.allDay,
					recurring: Boolean(fields.RRULE || recurrence),
					sourceName: provider.name,
					sourceURL: provider.feedURL,
					officialURL: propertyURL && propertyURL !== registrationURL ? propertyURL : extracted.find((url) => url !== registrationURL),
					...(registrationURL ? { registrationURL } : {}),
					description,
					...(!fields.DTEND && !validStart.allDay ? { endTimeUnavailable: true } : {}),
					sourceStatus: parsedSourceStatus(fields.STATUS?.value, title, calendarMethod),
					...(recurrence ? { recurrenceId: recurrence.date.toISOString() } : {}),
					...(fields.SEQUENCE && Number.isFinite(Number(fields.SEQUENCE.value)) ? { sequence: Number(fields.SEQUENCE.value) } : {}),
					...(fields["LAST-MODIFIED"] ? { lastModified: parseDate(fields["LAST-MODIFIED"].value, fields["LAST-MODIFIED"].params, 0)?.date.toISOString() ?? unescape(fields["LAST-MODIFIED"].value) } : {}),
				});
			}
			fields = null; continue;
		}
		if (calendarEnded && line.trim()) throw new Error("Malformed iCalendar: content follows VCALENDAR end");
		const colon = line.indexOf(":");
		if (colon < 0) continue;
		const lhs = line.slice(0, colon), value = line.slice(colon + 1);
		const [name, ...params] = lhs.split(";");
		if (!fields) { if (name.toUpperCase() === "METHOD") calendarMethod = value; continue; }
		fields[name.toUpperCase()] = { value, params: params.join(";") };
	}
	if (!calendarStarted || !calendarEnded || fields) throw new Error("Malformed or incomplete iCalendar response");
	const exact = new Map<string, SourceFacts>();
	for (const event of events) {
		const key = `${event.externalId}|${event.startAt}|${event.endAt}|${event.title}`;
		if (!exact.has(key)) exact.set(key, event);
	}
	const deduped = [...exact.values()];
	const counts = new Map<string, number>();
	for (const event of deduped) counts.set(event.externalId, (counts.get(event.externalId) ?? 0) + 1);
	return deduped.map((event) => counts.get(event.externalId)! > 1 ? { ...event, externalId: `${event.externalId}::${event.startAt}` } : event);
}

export interface ICalendarRejectedComponent { componentIndex: number; uidHash?: string; fieldCategory: string }
export interface ICalendarParseResult {
	events: SourceFacts[];
	totalVEventCount: number;
	validVEventCount: number;
	rejectedVEventCount: number;
	rejected: ICalendarRejectedComponent[];
	complete: boolean;
}

export function iCalendarQualityFailure(result: Pick<ICalendarParseResult, "totalVEventCount" | "validVEventCount" | "rejectedVEventCount">, priorValidCount = 0): "zero_valid_quality_gate" | "malformed_ratio_quality_gate" | undefined {
	if (result.validVEventCount === 0 && priorValidCount > 0) return "zero_valid_quality_gate";
	if (result.totalVEventCount > 0 && result.rejectedVEventCount / result.totalVEventCount > 0.05) return "malformed_ratio_quality_gate";
	return undefined;
}

/** Isolates deterministic VEVENT failures while keeping envelope failures fatal. */
export function parseICalendarResult(input: string, provider: { id: string; name: string; feedURL: string }): ICalendarParseResult {
	const lines = unfold(input), meaningful = lines.map((line) => line.trim()).filter(Boolean);
	if (meaningful[0]?.toUpperCase() !== "BEGIN:VCALENDAR" || meaningful.at(-1)?.toUpperCase() !== "END:VCALENDAR") throw new Error("Malformed or incomplete iCalendar envelope");
	if (meaningful.filter((line) => line.toUpperCase() === "BEGIN:VCALENDAR").length !== 1 || meaningful.filter((line) => line.toUpperCase() === "END:VCALENDAR").length !== 1) throw new Error("Malformed iCalendar envelope");
	const method = lines.find((line) => /^METHOD:/i.test(line));
	const components: string[][] = [];
	let current: string[] | undefined;
	for (const line of lines.slice(1, -1)) {
		const upper = line.toUpperCase();
		if (upper === "BEGIN:VEVENT") { if (current) throw new Error("Malformed iCalendar envelope: nested VEVENT"); current = [line]; continue; }
		if (upper === "END:VEVENT") { if (!current) throw new Error("Malformed iCalendar envelope: unmatched VEVENT end"); current.push(line); components.push(current); current = undefined; continue; }
		if (current) current.push(line);
	}
	if (current) throw new Error("Malformed iCalendar envelope: incomplete VEVENT");
	const events: SourceFacts[] = [], rejected: ICalendarRejectedComponent[] = [];
	components.forEach((component, index) => {
		try { events.push(...parseICalendarStrict(["BEGIN:VCALENDAR", ...(method ? [method] : []), ...component, "END:VCALENDAR"].join("\r\n"), provider)); }
		catch (error) {
			if (!(error instanceof ICalendarParseError)) throw error;
			rejected.push({ componentIndex: index + 1, ...(error.diagnostics.uidHash ? { uidHash: error.diagnostics.uidHash } : {}), fieldCategory: error.diagnostics.fieldCategory ?? "invalid_component" });
		}
	});
	const exact = new Map<string, SourceFacts>();
	for (const event of events) { const key = `${event.externalId}|${event.startAt}|${event.endAt}|${event.title}`; if (!exact.has(key)) exact.set(key, event); }
	const deduped = [...exact.values()], counts = new Map<string, number>();
	for (const event of deduped) counts.set(event.externalId, (counts.get(event.externalId) ?? 0) + 1);
	const normalized = deduped.map((event) => counts.get(event.externalId)! > 1 ? { ...event, externalId: `${event.externalId}::${event.startAt}` } : event);
	return { events: normalized, totalVEventCount: components.length, validVEventCount: components.length - rejected.length, rejectedVEventCount: rejected.length, rejected, complete: rejected.length === 0 };
}

/** Strict compatibility API retained for callers that require all-or-nothing parsing. */
export function parseICalendar(input: string, provider: { id: string; name: string; feedURL: string }): SourceFacts[] {
	return parseICalendarStrict(input, provider);
}
