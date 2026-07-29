import type { Env } from "../types";
import type { SourceFacts } from "./types";
import type { BeachEventProvider } from "./providers";

export const TOWN_CRIER_ARCHIVE_URL = "https://www.townofdauphinisland.org/newsletters";
export const TOWN_CRIER_SOURCE_NOTE = "Event information is sourced from the Town of Dauphin Island’s monthly Town Crier newsletter and may change after publication.";
const MAX_ARCHIVE_BYTES = 1_000_000;
const MAX_PDF_BYTES = 10_000_000;
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_PATTERN = MONTHS.map((month) => month.slice(0, 3)).join("|");

export interface TownCrierIssue {
	month: string;
	monthNumber: number;
	year: number;
	pdfURL: string;
}

export interface TownCrierExtractedEvent {
	name: string;
	date: string;
	endDate?: string;
	startTime?: string;
	endTime?: string;
	location?: string;
	description: string;
	contact?: string;
	sourceNewsletterMonth: string;
	sourcePDFURL: string;
}

function validCalendarDate(year: number, month: number, day: number): boolean {
	const value = new Date(Date.UTC(year, month - 1, day));
	return value.getUTCFullYear() === year && value.getUTCMonth() === month - 1 && value.getUTCDate() === day;
}

function decodeHtml(value: string): string {
	return value.replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ");
}

export function discoverNewestTownCrier(html: string): TownCrierIssue {
	const issues: TownCrierIssue[] = [];
	const link = /<a\b[^>]*href=["']([^"']+\.pdf(?:\?[^"']*)?)["'][^>]*>([\s\S]*?)<\/a>/gi;
	for (const match of html.matchAll(link)) {
		const label = decodeHtml(match[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
		const dated = label.match(new RegExp(`\\b(${MONTHS.join("|")})\\s+(20\\d{2})\\b`, "i"));
		if (!dated) continue;
		const url = new URL(decodeHtml(match[1]), TOWN_CRIER_ARCHIVE_URL);
		if (url.protocol !== "https:" || url.hostname !== "www.townofdauphinisland.org" || !url.pathname.startsWith("/_files/ugd/")) continue;
		const monthNumber = MONTHS.indexOf(dated[1].toLowerCase()) + 1;
		issues.push({ month: `${dated[1][0].toUpperCase()}${dated[1].slice(1).toLowerCase()} ${dated[2]}`, monthNumber, year: Number(dated[2]), pdfURL: url.href });
	}
	issues.sort((a, b) => b.year - a.year || b.monthNumber - a.monthNumber || a.pdfURL.localeCompare(b.pdfURL));
	if (!issues[0]) throw new Error("town_crier_issue_not_found");
	return issues[0];
}

function centralDate(year: number, month: number, day: number, hour = 0, minute = 0): Date {
	const target = Date.UTC(year, month - 1, day, hour, minute);
	let guess = target;
	const formatter = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const parts = Object.fromEntries(formatter.formatToParts(new Date(guess)).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
		const delta = target - Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
		guess += delta;
		if (delta === 0) break;
	}
	return new Date(guess);
}

function timeParts(value?: string): { hour: number; minute: number } | null {
	if (!value) return null;
	const match = value.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
	if (!match) return null;
	let hour = Number(match[1]) % 12;
	if (match[3].toLowerCase() === "pm") hour += 12;
	return { hour, minute: Number(match[2] ?? 0) };
}

function normalized(value: string): string {
	return value.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function cleanLine(value: string): string {
	return value.replace(/^[-*#>\s]+/, "").replace(/\*\*|__/g, "").replace(/\s+/g, " ").trim();
}

function supportingParagraph(lines: string[], title: string): string {
	const tokens = normalized(title).split(" ").filter((token) => token.length > 3);
	let best = "";
	let bestScore = 0;
	for (const line of lines) {
		const value = cleanLine(line);
		const searchable = normalized(value);
		const score = tokens.filter((token) => searchable.includes(token)).length;
		if ((score > bestScore || (score === bestScore && value.length > best.length)) && value.length > title.length) { best = value; bestScore = score; }
	}
	return bestScore > 0 ? best : "";
}

function extractTimeRange(value: string): { startTime?: string; endTime?: string } {
	const range = value.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\s*(?:-|–|—|to)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i);
	if (range) return { startTime: range[1].replace(/\s+/g, "").toLowerCase(), endTime: range[2].replace(/\s+/g, "").toLowerCase() };
	const single = value.match(/\b(?:at|@|begin(?:s|ning)?|starts?)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i);
	return single ? { startTime: single[1].replace(/\s+/g, "").toLowerCase() } : {};
}

function extractLocation(value: string): string | undefined {
	const known = value.match(/\b(East End Beach|Middle Beach|Bienville Beach|West End Beach|Dauphin Island Public Beach|Water Tower Plaza|DI Community Center|Dauphin Island Community Center|Town Hall|Fort Gaines|Green Park|DI Welcome Center)\b/i);
	if (known) return known[1].replace(/^DI /i, "Dauphin Island ");
	const phrase = value.match(/\b(?:held|located|meet(?:ing)?)\s+(?:at|on)\s+([^.;]{3,100}?)(?=\s+(?:from|at|on)\s+\d|[.;]|$)/i);
	return phrase?.[1].trim();
}

function extractContact(value: string): string | undefined {
	const contacts = [
		...(value.match(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g) ?? []),
		...(value.match(/\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g) ?? []),
		...(value.match(/https:\/\/[^\s)<>"']+/g) ?? []),
	];
	return [...new Set(contacts.map((item) => item.replace(/[.,;]+$/, "")))].join(" · ") || undefined;
}

function eventDescription(title: string, paragraph: string): string {
	const lower = `${title} ${paragraph}`.toLowerCase();
	const kind = lower.includes("movie") ? "movie screening" : lower.includes("cleanup") ? "cleanup activity" : lower.includes("concert") ? "concert" : lower.includes("hearing") ? "public hearing" : lower.includes("run") ? "organized run" : lower.includes("luau") ? "community luau" : lower.includes("firework") ? "holiday activity" : "scheduled community activity";
	return `The Town Crier lists this ${kind}. Confirm details in the linked newsletter before attending.`;
}

export function extractTownCrierEvents(markdown: string, issue: TownCrierIssue, now = new Date()): TownCrierExtractedEvent[] {
	const lines = markdown.split(/\r?\n/).map(cleanLine).filter(Boolean);
	const candidates: TownCrierExtractedEvent[] = [];
	const pattern = new RegExp(`^(${MONTH_PATTERN})[a-z]*\\.?\\s+(\\d{1,2})(?:\\s*[-–—]\\s*(\\d{1,2}))?\\s+(.+)$`, "i");
	for (const line of lines) {
		const match = line.match(pattern);
		if (!match) continue;
		const monthNumber = MONTHS.findIndex((month) => month.startsWith(match[1].toLowerCase())) + 1;
		const day = Number(match[2]);
		if (!monthNumber || day < 1 || day > 31) continue;
		const year = monthNumber < issue.monthNumber - 6 ? issue.year + 1 : issue.year;
		const endDay = Number(match[3] ?? day);
		if (!validCalendarDate(year, monthNumber, day) || !validCalendarDate(year, monthNumber, endDay) || endDay < day) continue;
		const date = centralDate(year, monthNumber, day);
		if (Number.isNaN(date.getTime())) continue;
		const rawTitle = match[4].replace(/\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)(?:\s*[-–—]\s*\d{1,2}(?::\d{2})?\s*(?:am|pm))?$/i, "").trim();
		if (rawTitle.length < 3) continue;
		const paragraph = supportingParagraph(lines, rawTitle);
		const times = extractTimeRange(`${line} ${paragraph}`);
		const finalDate = centralDate(year, monthNumber, endDay + 1);
		if (finalDate <= now) continue;
		candidates.push({
			name: rawTitle,
			date: `${year}-${String(monthNumber).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
			...(endDay !== day ? { endDate: `${year}-${String(monthNumber).padStart(2, "0")}-${String(endDay).padStart(2, "0")}` } : {}),
			...times,
			...(extractLocation(paragraph) ? { location: extractLocation(paragraph) } : {}),
			description: eventDescription(rawTitle, paragraph),
			...(extractContact(paragraph) ? { contact: extractContact(paragraph) } : {}),
			sourceNewsletterMonth: issue.month,
			sourcePDFURL: issue.pdfURL,
		});
	}
	const deduped = new Map<string, TownCrierExtractedEvent>();
	for (const event of candidates) {
		const key = `${normalized(event.name)}|${event.date}|${event.startTime ?? ""}`;
		if (!deduped.has(key)) deduped.set(key, event);
	}
	return [...deduped.values()].sort((a, b) => `${a.date}T${a.startTime ?? "00:00"}`.localeCompare(`${b.date}T${b.startTime ?? "00:00"}`));
}

export function townCrierFacts(events: TownCrierExtractedEvent[], provider: BeachEventProvider): SourceFacts[] {
	return events.map((event) => {
		const [year, month, day] = event.date.split("-").map(Number);
		const [endYear, endMonth, endDay] = (event.endDate ?? event.date).split("-").map(Number);
		const startParts = timeParts(event.startTime);
		const endParts = timeParts(event.endTime);
		const start = centralDate(year, month, day, startParts?.hour ?? 0, startParts?.minute ?? 0);
		const end = endParts
			? centralDate(endYear, endMonth, endDay, endParts.hour, endParts.minute)
			: startParts
				? new Date(start.getTime() + 60_000)
				: centralDate(endYear, endMonth, endDay + 1);
		return {
			providerId: provider.id,
			externalId: `${event.sourceNewsletterMonth}:${normalized(event.name)}:${event.date}:${event.startTime ?? "all-day"}`,
			title: event.name,
			venue: event.location ?? "",
			startAt: start.toISOString(),
			endAt: end.toISOString(),
			allDay: !startParts,
			recurring: false,
			sourceName: `${provider.name} · ${event.sourceNewsletterMonth}`,
			sourceURL: event.sourcePDFURL,
			officialURL: event.sourcePDFURL,
			description: event.description,
			sourceNote: TOWN_CRIER_SOURCE_NOTE,
			sourceNewsletterMonth: event.sourceNewsletterMonth,
			...(event.contact ? { contactInformation: event.contact } : {}),
			...(!endParts && startParts ? { endTimeUnavailable: true } : {}),
		};
	});
}

async function boundedBody(response: Response, limit: number): Promise<ArrayBuffer> {
	const length = Number(response.headers.get("Content-Length"));
	if (Number.isFinite(length) && length > limit) throw new Error("town_crier_response_too_large");
	const body = await response.arrayBuffer();
	if (body.byteLength > limit) throw new Error("town_crier_response_too_large");
	return body;
}

export async function fetchTownCrierFacts(env: Env, provider: BeachEventProvider, now: Date, fetcher: typeof fetch = fetch): Promise<SourceFacts[]> {
	const archive = await fetcher(provider.feedURL, { cache: "no-store", headers: { Accept: "text/html", "User-Agent": "AlabamaBeachFlag/1.0 beach-events" } });
	if (!archive.ok) throw new Error(`town_crier_archive_http_${archive.status}`);
	const archiveText = new TextDecoder().decode(await boundedBody(archive, MAX_ARCHIVE_BYTES));
	const issue = discoverNewestTownCrier(archiveText);
	const pdf = await fetcher(issue.pdfURL, { cache: "no-store", headers: { Accept: "application/pdf", "User-Agent": "AlabamaBeachFlag/1.0 beach-events" } });
	if (!pdf.ok) throw new Error(`town_crier_pdf_http_${pdf.status}`);
	const bytes = await boundedBody(pdf, MAX_PDF_BYTES);
	if (new TextDecoder().decode(bytes.slice(0, 4)) !== "%PDF") throw new Error("town_crier_invalid_pdf");
	const converted = await env.AI.toMarkdown({ name: `Town-Crier-${issue.month.replace(/\s+/g, "-")}.pdf`, blob: new Blob([bytes], { type: "application/pdf" }) });
	const result = Array.isArray(converted) ? converted[0] : converted;
	if (!result || result.format === "error" || !("data" in result) || !result.data?.trim()) throw new Error("town_crier_pdf_conversion_failed");
	return townCrierFacts(extractTownCrierEvents(result.data, issue, now), provider);
}
