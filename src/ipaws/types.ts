export type IpawsSnsType =
	| "Notification"
	| "SubscriptionConfirmation"
	| "UnsubscribeConfirmation";

export const SNS_TYPES: readonly IpawsSnsType[] = [
	"Notification",
	"SubscriptionConfirmation",
	"UnsubscribeConfirmation",
] as const;

export interface IpawsRawCapInfo {
	valueName?: string;
	value?: string;
}
export interface IpawsRawCapArea {
	description?: string;
	polygon?: string;
	circle?: string;
	geocode?: IpawsRawCapInfo[];
}

export interface IpawsRawCapDetails {
	identifier?: string;
	sender?: string;
	sent?: string;
	status?: string;
	msgType?: string;
	scope?: string;
	references?: string;
	event?: string;
	urgency?: string;
	severity?: string;
	certainty?: string;
	effective?: string;
	onset?: string;
	expires?: string;
	headline?: string;
	description?: string;
	instruction?: string;
	area?: IpawsRawCapArea;
	info?: {
		event?: string;
		headline?: string;
		description?: string;
		instruction?: string;
		references?: string;
		urgency?: string;
		severity?: string;
		certainty?: string;
		effective?: string;
		onset?: string;
		expires?: string;
		area?: IpawsRawCapArea;
	}[];
	parseWarnings?: string[];
}

export interface IpawsRawCapPayload {
	source: "cap" | "json" | "unknown";
	parsed: IpawsRawCapDetails;
}

export interface IpawsIngestionConfig {
	enabled: boolean;
	environment: "staging" | "production";
	allowedTopicArns: readonly string[];
	autoConfirmSubscription: boolean;
	parseByteLimit: number;
	recordTtlSeconds: number;
	subscriptionStateTtlSeconds: number;
	healthTtlSeconds: number;
}

export interface IpawsCapParseResult {
	status: "parsed" | "parse_failed";
	message: IpawsRawCapPayload | null;
	reason?: string;
}

export type IpawsProcessingState =
	| "received"
	| "signature_invalid"
	| "signature_verified"
	| "subscription_received"
	| "subscription_confirmed"
	| "subscription_skipped"
	| "notification_parsed"
	| "notification_parse_failed"
	| "notification_done"
	| "unsupported_type";

export interface IpawsIngestionRecord {
	id: string;
	messageId: string;
	type: IpawsSnsType;
	topicArn: string;
	messageTimestamp: string;
	receivedAt: string;
	subscriptionArn: string | null;
	processingState: IpawsProcessingState;
	signatureVersion: string;
	signatureResult: "success" | "failure" | "not_attempted";
	parseStatus: IpawsCapParseResult["status"];
	rawMessage: string;
	messageBody: IpawsRawCapPayload | null;
	parseError: string | null;
	parseResultSummary: string | null;
	subscribeUrl: string | null;
	capIdentifier: string | null;
	capReferences: string | null;
	parseWarnings: string[];
	updatedAt: string;
}

export interface IpawsIngressReceipt {
	duplicate: boolean;
	record: IpawsIngestionRecord;
}

export interface IpawsSignatureResult {
	valid: boolean;
	reason?: string;
	algorithm?: string;
}

export interface IpawsSnsMessage {
	Type: IpawsSnsType;
	MessageId: string;
	Message: string;
	Timestamp: string;
	TopicArn: string;
	SigningCertURL: string;
	Signature: string;
	SignatureVersion: string;
	Subject?: string;
	Token?: string;
	SubscribeURL?: string;
}

export interface IpawsSnsNotification extends IpawsSnsMessage {
	Type: "Notification";
}

export interface IpawsSnsSubscriptionConfirmation extends IpawsSnsMessage {
	Type: "SubscriptionConfirmation" | "UnsubscribeConfirmation";
	Token: string;
	SubscribeURL: string;
}

export interface IpawsHealthState {
	environment: "staging" | "production";
	stagingEnabled: boolean;
	lastReceiptAt?: string;
	lastSignatureFailureAt?: string;
	lastValidDeliveryAt?: string;
	lastPayloadAt?: string;
	lastParseFailureAt?: string;
	subscriptionState: "unknown" | "received" | "confirmed" | "skipped";
	recentOutcomes: string[];
	updatedAt: string;
}

export interface IpawsRouteResult {
	status: number;
	bypassIdempotent: boolean;
	type: IpawsSnsType;
	messageId: string;
}
