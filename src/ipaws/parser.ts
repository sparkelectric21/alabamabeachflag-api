import type { IpawsCapParseResult, IpawsRawCapDetails, IpawsRawCapPayload } from "./types";

function sanitizeText(value: string): string {
	return value
		.replace(/\s+/g, " ")
		.replace(/[\u0000-\u001F\u007F]+/g, " ")
		.trim();
}

function matchFirst(xml: string, tag: string): string | undefined {
	const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
	const match = regex.exec(xml);
	if (!match?.[1]) return undefined;
	return sanitizeText(match[1]);
}

function matchAll(xml: string, tag: string): string[] {
	const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "ig");
	return [...xml.matchAll(regex)]
		.map((match) => sanitizeText(match[1] ?? ""))
		.filter(Boolean);
}

function parseArea(xml: string): IpawsRawCapDetails["area"] {
	const polygon = matchFirst(xml, "polygon");
	const circle = matchFirst(xml, "circle");
	const description = matchFirst(xml, "areaDesc") || matchFirst(xml, "areaDescription");
	const geocodeEntries: string[] = [];
	for (const block of [...xml.matchAll(new RegExp("<geocode[^>]*>([\\s\\S]*?)</geocode>", "gi"))]) {
		const values = matchAll(block[1] ?? "", "value");
		const names = matchAll(block[1] ?? "", "valueName");
		for (let index = 0; index < Math.min(values.length, names.length); index++) {
			if (names[index] || values[index]) geocodeEntries.push(`${names[index] ?? ""}:${values[index] ?? ""}`);
		}
	}
	const geocode = geocodeEntries.map((entry) => {
		const [valueName, value] = entry.split(":", 2);
		return { valueName, value };
	});
	return {
		...(description ? { description } : {}),
		...(polygon ? { polygon } : {}),
		...(circle ? { circle } : {}),
		...(geocode.length > 0 ? { geocode } : {}),
	};
}

function parseInfoBlock(xml: string): NonNullable<IpawsRawCapDetails["info"]>[number] {
	return {
		event: matchFirst(xml, "event") || undefined,
		headline: matchFirst(xml, "headline") || undefined,
		description: matchFirst(xml, "description") || undefined,
		instruction: matchFirst(xml, "instruction") || undefined,
		references: matchFirst(xml, "references") || undefined,
		urgency: matchFirst(xml, "urgency") || undefined,
		severity: matchFirst(xml, "severity") || undefined,
		certainty: matchFirst(xml, "certainty") || undefined,
		effective: matchFirst(xml, "effective") || undefined,
		onset: matchFirst(xml, "onset") || undefined,
		expires: matchFirst(xml, "expires") || undefined,
		area: parseArea(xml),
	};
}

function parseInfoBlocks(xml: string): NonNullable<IpawsRawCapDetails["info"]> {
	const blocks = [...xml.matchAll(new RegExp("<info\\b([\\s\\S]*?)</info>", "gi"))];
	return blocks
		.map((block) => parseInfoBlock(block[0] ?? ""))
		.filter((info) => Object.values(info).some((value) => Boolean(value && (!Array.isArray(value) || value.length > 0))));
}

function toAreaFromObject(value: unknown): IpawsRawCapDetails["area"] | undefined {
	if (!value || typeof value !== "object") return undefined;
	const area = value as Record<string, unknown>;
	const geocode = Array.isArray(area.geocode) ? area.geocode
		.filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object")
		.map((entry) => ({
			valueName: typeof entry.valueName === "string" ? sanitizeText(entry.valueName) : undefined,
			value: typeof entry.value === "string" ? sanitizeText(entry.value) : undefined,
		})).filter((item) => item.valueName || item.value)
		: undefined;
	const next: IpawsRawCapDetails["area"] = {
		description: typeof area.areaDesc === "string" ? sanitizeText(area.areaDesc) : (typeof area.areaDescription === "string" ? sanitizeText(area.areaDescription) : undefined),
		polygon: typeof area.polygon === "string" ? sanitizeText(area.polygon) : undefined,
		circle: typeof area.circle === "string" ? sanitizeText(area.circle) : undefined,
	};
	if (geocode && geocode.length > 0) next.geocode = geocode;
	return Object.keys(next).length === 0 ? undefined : next;
}

function toPayloadFromObject(value: Record<string, unknown>): IpawsRawCapPayload {
	const alert: IpawsRawCapDetails = {
		identifier: typeof value.identifier === "string" ? sanitizeText(value.identifier) : undefined,
		sender: typeof value.sender === "string" ? sanitizeText(value.sender) : undefined,
		sent: typeof value.sent === "string" ? sanitizeText(value.sent) : undefined,
		status: typeof value.status === "string" ? sanitizeText(value.status) : undefined,
		msgType: typeof value.msgType === "string" ? sanitizeText(value.msgType) : undefined,
		scope: typeof value.scope === "string" ? sanitizeText(value.scope) : undefined,
		references: typeof value.references === "string" ? sanitizeText(value.references) : undefined,
		event: typeof value.event === "string" ? sanitizeText(value.event) : undefined,
		urgency: typeof value.urgency === "string" ? sanitizeText(value.urgency) : undefined,
		severity: typeof value.severity === "string" ? sanitizeText(value.severity) : undefined,
		certainty: typeof value.certainty === "string" ? sanitizeText(value.certainty) : undefined,
		effective: typeof value.effective === "string" ? sanitizeText(value.effective) : undefined,
		onset: typeof value.onset === "string" ? sanitizeText(value.onset) : undefined,
		expires: typeof value.expires === "string" ? sanitizeText(value.expires) : undefined,
		headline: typeof value.headline === "string" ? sanitizeText(value.headline) : undefined,
		description: typeof value.description === "string" ? sanitizeText(value.description) : undefined,
		instruction: typeof value.instruction === "string" ? sanitizeText(value.instruction) : undefined,
		parseWarnings: [],
	};
	if (typeof value.area === "object" && value.area) alert.area = toAreaFromObject(value.area);
	if (Array.isArray(value.info)) {
		alert.info = value.info
			.filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object")
			.map((entry) => {
				const area = toAreaFromObject(entry.area);
				return {
					event: typeof entry.event === "string" ? sanitizeText(entry.event) : undefined,
					headline: typeof entry.headline === "string" ? sanitizeText(entry.headline) : undefined,
					description: typeof entry.description === "string" ? sanitizeText(entry.description) : undefined,
					instruction: typeof entry.instruction === "string" ? sanitizeText(entry.instruction) : undefined,
					references: typeof entry.references === "string" ? sanitizeText(entry.references) : undefined,
					urgency: typeof entry.urgency === "string" ? sanitizeText(entry.urgency) : undefined,
					severity: typeof entry.severity === "string" ? sanitizeText(entry.severity) : undefined,
					certainty: typeof entry.certainty === "string" ? sanitizeText(entry.certainty) : undefined,
					effective: typeof entry.effective === "string" ? sanitizeText(entry.effective) : undefined,
					onset: typeof entry.onset === "string" ? sanitizeText(entry.onset) : undefined,
					expires: typeof entry.expires === "string" ? sanitizeText(entry.expires) : undefined,
					area,
				};
			});
	}
	return { source: "json", parsed: alert };
}

function hasCapFields(details: IpawsRawCapDetails): boolean {
	return Boolean(details.identifier || details.event || details.headline || details.info?.length || details.description || details.scope);
}

export function parseCapPayload(raw: string, byteLimit = 262_144): IpawsCapParseResult {
	if (!raw.trim()) {
		return { status: "parse_failed", message: { source: "unknown", parsed: {} }, reason: "empty_message" };
	}
	if (raw.length > byteLimit) {
		return { status: "parse_failed", message: { source: "unknown", parsed: {} }, reason: "payload_too_large" };
	}
	if (raw.trim().startsWith("<")) {
		if (raw.includes("<!DOCTYPE")) {
			return { status: "parse_failed", message: { source: "unknown", parsed: {} }, reason: "unsafe_xml_doctype" };
		}
		const details: IpawsRawCapDetails = {
			identifier: matchFirst(raw, "identifier"),
			sender: matchFirst(raw, "sender"),
			sent: matchFirst(raw, "sent"),
			status: matchFirst(raw, "status"),
			msgType: matchFirst(raw, "msgType"),
			scope: matchFirst(raw, "scope"),
			references: matchFirst(raw, "references"),
			event: matchFirst(raw, "event"),
			urgency: matchFirst(raw, "urgency"),
			severity: matchFirst(raw, "severity"),
			certainty: matchFirst(raw, "certainty"),
			effective: matchFirst(raw, "effective"),
			onset: matchFirst(raw, "onset"),
			expires: matchFirst(raw, "expires"),
			headline: matchFirst(raw, "headline"),
			description: matchFirst(raw, "description"),
			instruction: matchFirst(raw, "instruction"),
			area: parseArea(raw),
			info: parseInfoBlocks(raw),
		};
		if (!hasCapFields(details)) {
			return { status: "parse_failed", message: { source: "cap", parsed: { parseWarnings: ["No expected CAP fields were found"] } }, reason: "cap_parse_no_fields" };
		}
		return { status: "parsed", message: { source: "cap", parsed: details } };
	}

	try {
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { status: "parse_failed", message: { source: "unknown", parsed: {} }, reason: "json_payload_not_object" };
		}
		const payload = toPayloadFromObject(parsed as Record<string, unknown>);
		if (!hasCapFields(payload.parsed)) {
			return { status: "parse_failed", message: payload, reason: "json_payload_missing_cap_fields" };
		}
		return { status: "parsed", message: payload };
	} catch {
		return { status: "parse_failed", message: { source: "unknown", parsed: {} }, reason: "message_invalid_json_or_xml" };
	}
}
