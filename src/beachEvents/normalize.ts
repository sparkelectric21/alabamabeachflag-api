export interface NormalizedDescription {
	fullDescription?: string;
	summary?: string;
	extractedURLs: string[];
	warnings: string[];
}

const entities: Record<string, string> = {
	amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"',
	ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", bull: "•",
};

export function decodeHTMLEntities(value: string): string {
	return value.replace(/&(#x[\da-f]+|#\d+|[a-z][\da-z]+);?/gi, (match, entity: string) => {
		if (entity[0] === "#") {
			const hex = entity[1]?.toLowerCase() === "x";
			const point = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
			return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
		}
		return entities[entity.toLowerCase()] ?? match;
	});
}

const DROP_CONTENT = new Set(["script", "style", "template", "svg", "canvas", "noscript"]);
const BLOCK = new Set(["address", "article", "aside", "blockquote", "div", "footer", "header", "main", "nav", "p", "section", "table", "tr", "h1", "h2", "h3", "h4", "h5", "h6"]);

function attribute(tag: string, name: string): string | undefined {
	const pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
	const match = tag.match(pattern);
	return decodeHTMLEntities(match?.[1] ?? match?.[2] ?? match?.[3] ?? "") || undefined;
}

export function sanitizeEventURL(value: unknown, baseURL?: string): string | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	try {
		const url = new URL(decodeHTMLEntities(value.trim()), baseURL);
		if (url.protocol !== "https:") return undefined;
		if (/^(?:www\.)?google\.com$/i.test(url.hostname) && url.pathname === "/url") {
			const destination = url.searchParams.get("url") ?? url.searchParams.get("q");
			if (!destination) return undefined;
			const unwrapped = new URL(destination);
			if (/^(?:www\.)?google\.com$/i.test(unwrapped.hostname) && unwrapped.pathname === "/url") return undefined;
			return sanitizeEventURL(unwrapped.toString());
		}
		if (/^(?:localhost|127(?:\.\d+){3}|\[?::1\]?)$/i.test(url.hostname) || /\.(?:ics|ical)(?:$|\?)/i.test(url.pathname) || /(?:webcal|subscribe|calendar-feed|\/api\/)/i.test(url.hostname + url.pathname) || /\/common\/modules\/iCalendar\//i.test(url.pathname)) return undefined;
		for (const key of [...url.searchParams.keys()]) {
			if (/^(?:utm_.+|fbclid|gclid|mc_(?:cid|eid)|_hsenc|_hsmi)$/i.test(key)) url.searchParams.delete(key);
		}
		url.hash = "";
		return url.toString();
	} catch { return undefined; }
}

function plainTextFromHTML(input: string, baseURL?: string): { text: string; urls: string[]; hadMarkup: boolean } {
	input = decodeHTMLEntities(input);
	let output = "", cursor = 0, hiddenDepth = 0, hadMarkup = false;
	const hiddenTags: string[] = [];
	const urls: string[] = [];
	while (cursor < input.length) {
		const open = input.indexOf("<", cursor);
		if (open < 0) { if (!hiddenDepth) output += input.slice(cursor); break; }
		if (!hiddenDepth) output += input.slice(cursor, open);
		if (input.startsWith("<!--", open)) {
			const close = input.indexOf("-->", open + 4); cursor = close < 0 ? input.length : close + 3; hadMarkup = true; continue;
		}
		const close = input.indexOf(">", open + 1);
		if (close < 0) { if (!hiddenDepth) output += input.slice(open); break; }
		const raw = input.slice(open + 1, close), closing = /^\s*\//.test(raw);
		const name = raw.match(/^\s*\/?\s*([a-z][\w:-]*)/i)?.[1]?.toLowerCase();
		if (!name) { if (!hiddenDepth) output += input.slice(open, close + 1); cursor = close + 1; continue; }
		hadMarkup = true;
		const hiddenElement = DROP_CONTENT.has(name) || (!closing && (/(?:^|\s)(?:hidden|aria-hidden\s*=\s*["']?true)/i.test(raw) || /style\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(raw)));
		if (!closing && hiddenElement && !/\/\s*$/.test(raw)) { hiddenTags.push(name); hiddenDepth += 1; }
		else if (closing && hiddenTags.at(-1) === name) { hiddenTags.pop(); hiddenDepth = Math.max(0, hiddenDepth - 1); }
		if (!hiddenDepth && !closing && name === "a") {
			const href = sanitizeEventURL(attribute(raw, "href"), baseURL); if (href) urls.push(href);
		}
		if (!hiddenDepth) {
			if (name === "br") output += "\n";
			else if (name === "li" && !closing) output += "\n• ";
			else if (BLOCK.has(name)) output += "\n\n";
		}
		cursor = close + 1;
	}
	return { text: decodeHTMLEntities(output), urls: [...new Set(urls)], hadMarkup };
}

function cleanLines(value: string, knownURLs: string[]): string {
	let text = value.replace(/\r\n?/g, "\n").replace(/[\t\f\v ]+/g, " ");
	text = text.replace(/\b(Registration|Location|Parking|Contact)\s*:\s*\1(\s*:)?\s*/gi, (_match, label: string, repeatedColon: string | undefined) => `${label}${repeatedColon ? ":" : ""} `);
	for (const url of knownURLs) text = text.split(url).join("");
	text = text.replace(/https?:\/\/\S+/gi, "");
	const seen = new Set<string>();
	return text.split("\n").map((line) => line.trim().replace(/\s+([,.;:!?])/g, "$1"))
		.filter((line, index, lines) => line || Boolean(lines[index - 1]))
		.filter((line) => { const key = line.toLowerCase(); if (!line || !seen.has(key)) { if (line) seen.add(key); return true; } return false; })
		.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function summaryFrom(text: string, context: string[]): string | undefined {
	const contextText = context.join(" ").toLowerCase();
	const boilerplate = /^(?:for more (?:information|details)|learn more|visit (?:our|the) website|click here|event details|source:|location:|date:)/i;
	const paragraphs = text.split(/\n+/).map((line) => line.replace(/^•\s*/, "").trim()).filter(Boolean);
	const sentences = paragraphs.flatMap((line) => line.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? []).map((item) => item.trim());
	const selected: string[] = [];
	for (const sentence of sentences) {
		if (sentence.length < 20 || boilerplate.test(sentence)) continue;
		if (contextText.includes(sentence.replace(/[.!?]+$/, "").toLowerCase())) continue;
		selected.push(sentence); if (selected.length === 3 || selected.join(" ").length >= 280) break;
	}
	return selected.length ? selected.join(" ").slice(0, 420).trim() : undefined;
}

export function normalizeDescription(input: unknown, context: string[] = [], baseURL?: string): NormalizedDescription {
	if (typeof input !== "string" || !input.trim()) return { extractedURLs: [], warnings: [] };
	const parsed = plainTextFromHTML(input, baseURL);
	const fullDescription = cleanLines(parsed.text, parsed.urls) || undefined;
	return {
		fullDescription,
		summary: fullDescription ? summaryFrom(fullDescription, context) : undefined,
		extractedURLs: parsed.urls,
		warnings: parsed.hadMarkup ? ["Imported HTML was normalized"] : [],
	};
}

export function resolveOfficialEventURL(input: { officialURL?: string; extractedURLs?: string[] }): string | undefined {
	return sanitizeEventURL(input.officialURL)
		?? input.extractedURLs?.map((value) => sanitizeEventURL(value)).find(Boolean);
}
