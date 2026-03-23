// --- Granola Data Types ---

export interface GranolaTokens {
	accessToken: string;
	clientId: string;
	/** Unix timestamp in milliseconds */
	expiresAt: number;
	refreshToken: string;
}

export interface GranolaAttendee {
	email: string;
	name: string;
}

export interface GranolaMeeting {
	attendees?: GranolaAttendee[];
	endTime?: string;
	id: string;
	startTime: string;
	title: string;
}

export interface GranolaPayload {
	attendees: GranolaAttendee[];
	calendar_event_ID: string;
	calendar_event_time: string;
	calendar_event_title: string;
	creator_email: string;
	creator_name: string;
	enhanced_notes: string;
	id: string;
	link: string;
	my_notes: string;
	title: string;
	transcript: string;
}

export interface OAuthState {
	clientId: string;
	codeVerifier: string;
	redirectUri: string;
	state: string;
}

// --- Library Configuration Interfaces ---

/**
 * Pluggable token storage. Consumers implement this to persist tokens
 * in their own storage backend (Redis, database, etc.).
 */
export interface TokenStore {
	getTokens(userId: string): Promise<GranolaTokens | null>;
	storeTokens(userId: string, tokens: GranolaTokens): Promise<void>;
}

/**
 * Optional request tracking callback. Called after every MCP request
 * with the tool name, HTTP status, and duration.
 */
export interface RequestTracker {
	trackRequest(
		toolName: string,
		status: number,
		durationMs: number,
	): void | Promise<void>;
}

/**
 * Options for creating a GranolaClient instance.
 */
export interface GranolaClientOptions {
	/**
	 * Name used for the MCP client during session initialization.
	 * @default 'Granola API Client'
	 */
	clientName?: string;

	/**
	 * Version string sent during MCP initialization.
	 * @default '1.0.0'
	 */
	clientVersion?: string;

	/**
	 * Optional external request tracker. If not provided,
	 * basic in-memory RPM tracking is used (accessible via getCurrentRPM).
	 */
	requestTracker?: RequestTracker;

	/**
	 * Token store for automatic token refresh via getValidAccessToken().
	 * Required only if you use getValidAccessToken(); direct MCP methods
	 * accept an accessToken string directly.
	 */
	tokenStore?: TokenStore;
}

// --- MCP Internal Types ---

export interface MCPResult {
	content: Array<{ type: string; text: string }>;
}
