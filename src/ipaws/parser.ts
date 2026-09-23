import type { IpawsCapParseResult, IpawsRawCapDetails, IpawsRawCapPayload } from "./types";
import { SaxesParser, type SaxesTagNS } from "saxes";

const CAP_NAMESPACE = "urn:oasis:names:tc:emergency:cap:1.2";
const MAX_XML_DEPTH = 32;
const MAX_XML_NODES = 4_096;
const MAX_XML_TEXT_BYTES = 262_144;

interface XmlNode {
	local: string;
	uri: string;
	text: string;
	children: XmlNode[];
}

function sanitizeText(value: string): string {
	return value
		.replace(/\s+/g, " ")
		.replace(/[\u0000-\u001F\u007F]+/g, " ")
		.trim();
}

function child(node: XmlNode, local: string): XmlNode | undefined {
	return node.children.find((entry) => entry.uri === CAP_NAMESPACE && entry.local === local);
}

function children(node: XmlNode, local: string): XmlNode[] {
	return node.children.filter((entry) => entry.uri === CAP_NAMESPACE && entry.local === local);
}

function nodeText(node: XmlNode | undefined): string | undefined {
	if (!node) return undefined;
	const value = sanitizeText(node.text);
	return value || undefined;
}

function parseArea(node: XmlNode | undefined): IpawsRawCapDetails["area"] {
	if (!node) return undefined;
	const geocode = children(node, "geocode").map((entry) => ({
		valueName: nodeText(child(entry, "valueName")),
		value: nodeText(child(entry, "value")),
	})).filter((entry) => entry.valueName || entry.value);
	return {
		...(nodeText(child(node, "areaDesc")) ? { description: nodeText(child(node, "areaDesc")) } : {}),
		...(nodeText(child(node, "polygon")) ? { polygon: nodeText(child(node, "polygon")) } : {}),
		...(nodeText(child(node, "circle")) ? { circle: nodeText(child(node, "circle")) } : {}),
		...(geocode.length > 0 ? { geocode } : {}),
	};
}

function parseInfoBlock(node: XmlNode): NonNullable<IpawsRawCapDetails["info"]>[number] {
	return {
		event: nodeText(child(node, "event")), headline: nodeText(child(node, "headline")),
		description: nodeText(child(node, "description")), instruction: nodeText(child(node, "instruction")),
		references: nodeText(child(node, "references")), urgency: nodeText(child(node, "urgency")),
		severity: nodeText(child(node, "severity")), certainty: nodeText(child(node, "certainty")),
		effective: nodeText(child(node, "effective")), onset: nodeText(child(node, "onset")),
		expires: nodeText(child(node, "expires")), area: parseArea(child(node, "area")),
	};
}

function parseInfoBlocks(root: XmlNode): NonNullable<IpawsRawCapDetails["info"]> {
	return children(root, "info").map(parseInfoBlock)
		.filter((info) => Object.values(info).some((value) => Boolean(value && (!Array.isArray(value) || value.length > 0))));
}

function parseXml(raw: string): XmlNode {
	let root: XmlNode | undefined;
	const stack: XmlNode[] = [];
	let nodes = 0;
	let textBytes = 0;
	let failure: Error | undefined;
	const parser = new SaxesParser({ xmlns: true });
	parser.on("doctype", () => { failure = new Error("unsafe_xml_doctype"); });
	parser.on("processinginstruction", () => { failure = new Error("unsafe_xml_processing_instruction"); });
	parser.on("opentag", (tag: SaxesTagNS) => {
		if (failure) return;
		if (++nodes > MAX_XML_NODES || stack.length >= MAX_XML_DEPTH) { failure = new Error("xml_complexity_limit"); return; }
		const node: XmlNode = { local: tag.local, uri: tag.uri, text: "", children: [] };
		if (stack.length) stack[stack.length - 1].children.push(node); else if (root) failure = new Error("multiple_xml_roots"); else root = node;
		stack.push(node);
	});
	const addText = (value: string) => {
		if (!stack.length || failure) return;
		textBytes += new TextEncoder().encode(value).byteLength;
		if (textBytes > MAX_XML_TEXT_BYTES) { failure = new Error("xml_text_limit"); return; }
		stack[stack.length - 1].text += value;
	};
	parser.on("text", addText);
	parser.on("cdata", addText);
	parser.on("closetag", () => { stack.pop(); });
	parser.on("error", (error) => { failure = error; });
	parser.write(raw).close();
	if (failure) throw failure;
	if (!root) throw new Error("xml_missing_root");
	return root;
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
	if (new TextEncoder().encode(raw).byteLength > byteLimit) {
		return { status: "parse_failed", message: { source: "unknown", parsed: {} }, reason: "payload_too_large" };
	}
	if (raw.trim().startsWith("<")) {
		try {
			const root = parseXml(raw);
			if (root.local !== "alert" || root.uri !== CAP_NAMESPACE) throw new Error("cap_invalid_root_or_namespace");
			const required = ["identifier", "sender", "sent", "status", "msgType", "scope"] as const;
			const values = Object.fromEntries(required.map((name) => [name, nodeText(child(root, name))]));
			if (required.some((name) => !values[name])) throw new Error("cap_missing_required_field");
			if (Number.isNaN(Date.parse(values.sent!))) throw new Error("cap_invalid_sent");
			if (!["Actual", "Exercise", "System", "Test", "Draft"].includes(values.status!)) throw new Error("cap_invalid_status");
			if (!["Alert", "Update", "Cancel", "Ack", "Error"].includes(values.msgType!)) throw new Error("cap_invalid_msg_type");
			if (!["Public", "Restricted", "Private"].includes(values.scope!)) throw new Error("cap_invalid_scope");
			const info = parseInfoBlocks(root);
			const firstInfo = info[0];
			const details: IpawsRawCapDetails = {
				...values,
				references: nodeText(child(root, "references")),
				event: firstInfo?.event, urgency: firstInfo?.urgency, severity: firstInfo?.severity,
				certainty: firstInfo?.certainty, effective: firstInfo?.effective, onset: firstInfo?.onset,
				expires: firstInfo?.expires, headline: firstInfo?.headline, description: firstInfo?.description,
				instruction: firstInfo?.instruction, area: firstInfo?.area, info,
			};
			return { status: "parsed", message: { source: "cap", parsed: details } };
		} catch (error) {
			return { status: "parse_failed", message: { source: "cap", parsed: {} }, reason: error instanceof Error ? error.message : "cap_xml_invalid" };
		}
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
