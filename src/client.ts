import { refreshAccessToken } from './oauth';
import type {
	GranolaClientOptions,
	GranolaTokens,
	MCPResult,
	RequestTracker,
	TokenStore,
} from './types';

const MCP_URL = 'https://mcp.granola.ai/mcp';
const MCP_PROTOCOL_VERSION = '2025-03-26';
const RATE_LIMIT_RE = /rate.?limit/i;

/**
 * Client for the Granola MCP API.
 *
 * Handles session initialization, MCP tool calls, rate-limit detection,
 * and optional token refresh via a pluggable TokenStore.
 */
export class GranolaClient {
	private clientName: string;
	private clientVersion: string;
	private tokenStore: TokenStore | null;
	private externalTracker: RequestTracker | null;

	// In-memory RPM tracking (always active)
	private requestTimestamps: number[] = [];

	// MCP session cache (per access token)
	private sessionCache = new Map<string, string>();
	private nextRequestId = 1;

	constructor(options: GranolaClientOptions = {}) {
		this.clientName = options.clientName ?? 'Granola API Client';
		this.clientVersion = options.clientVersion ?? '1.0.0';
		this.tokenStore = options.tokenStore ?? null;
		this.externalTracker = options.requestTracker ?? null;
	}

	// --- Request Tracking ---

	private trackRequest(
		toolName: string,
		status: number,
		durationMs: number,
	): void {
		const now = Date.now();
		this.requestTimestamps.push(now);

		// Prune timestamps older than 60 seconds
		const oneMinuteAgo = now - 60_000;
		while (
			this.requestTimestamps.length > 0 &&
			this.requestTimestamps[0] < oneMinuteAgo
		) {
			this.requestTimestamps.shift();
		}

		const rpm = this.requestTimestamps.length;
		console.log(
			`[granola-mcp] ${toolName} status=${status} duration=${durationMs}ms rpm=${rpm}`,
		);

		if (status === 429) {
			console.warn(
				`[granola-mcp] RATE LIMITED on ${toolName} — current RPM: ${rpm}`,
			);
		}

		// Fire external tracker (fire-and-forget for async)
		if (this.externalTracker) {
			const result = this.externalTracker.trackRequest(
				toolName,
				status,
				durationMs,
			);
			if (result instanceof Promise) {
				result.catch(() => undefined);
			}
		}
	}

	/** Get the current in-process requests-per-minute count. */
	getCurrentRPM(): number {
		const oneMinuteAgo = Date.now() - 60_000;
		while (
			this.requestTimestamps.length > 0 &&
			this.requestTimestamps[0] < oneMinuteAgo
		) {
			this.requestTimestamps.shift();
		}
		return this.requestTimestamps.length;
	}

	// --- Token Management ---

	/**
	 * Get a valid access token for a user, refreshing if needed.
	 * Requires a TokenStore to be configured.
	 */
	async getValidAccessToken(userId: string): Promise<string | null> {
		if (!this.tokenStore) {
			throw new Error(
				'TokenStore is required for getValidAccessToken(). Pass it in GranolaClientOptions or use direct access token methods instead.',
			);
		}

		const tokens = await this.tokenStore.getTokens(userId);
		if (!tokens) {
			return null;
		}

		// Refresh if token expires within 5 minutes
		const bufferMs = 5 * 60 * 1000;
		if (Date.now() < tokens.expiresAt - bufferMs) {
			return tokens.accessToken;
		}

		try {
			const refreshed = await refreshAccessToken(
				tokens.clientId,
				tokens.refreshToken,
			);
			const updated: GranolaTokens = {
				clientId: tokens.clientId,
				accessToken: refreshed.accessToken,
				refreshToken: refreshed.refreshToken,
				expiresAt: Date.now() + refreshed.expiresIn * 1000,
			};
			await this.tokenStore.storeTokens(userId, updated);
			return updated.accessToken;
		} catch (error) {
			console.error(
				`Failed to refresh Granola token for user ${userId}:`,
				error,
			);
			return null;
		}
	}

	// --- MCP Session Management ---

	private async initializeMCPSession(
		accessToken: string,
	): Promise<string | null> {
		const cached = this.sessionCache.get(accessToken);
		if (cached) {
			return cached;
		}

		const initId = this.nextRequestId++;
		console.log('[granola-mcp] Initializing MCP session...');

		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 10_000);

			const initRes = await fetch(MCP_URL, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Accept: 'application/json, text/event-stream',
					Authorization: `Bearer ${accessToken}`,
				},
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: initId,
					method: 'initialize',
					params: {
						protocolVersion: MCP_PROTOCOL_VERSION,
						capabilities: {},
						clientInfo: {
							name: this.clientName,
							version: this.clientVersion,
						},
					},
				}),
				signal: controller.signal,
			});

			clearTimeout(timeout);

			const sessionId = initRes.headers.get('mcp-session-id');

			if (sessionId) {
				console.log(
					`[granola-mcp] Got session ID: ${sessionId.slice(0, 12)}...`,
				);
				this.sessionCache.set(accessToken, sessionId);
			} else {
				console.log('[granola-mcp] No session ID returned by server');
			}

			// Consume the init response body
			await initRes.text();

			// Send the initialized notification
			const notifyController = new AbortController();
			const notifyTimeout = setTimeout(
				() => notifyController.abort(),
				10_000,
			);

			const headers: Record<string, string> = {
				'Content-Type': 'application/json',
				Accept: 'application/json, text/event-stream',
				Authorization: `Bearer ${accessToken}`,
			};
			if (sessionId) {
				headers['Mcp-Session-Id'] = sessionId;
			}

			await fetch(MCP_URL, {
				method: 'POST',
				headers,
				body: JSON.stringify({
					jsonrpc: '2.0',
					method: 'notifications/initialized',
				}),
				signal: notifyController.signal,
			}).then((r) => r.text());

			clearTimeout(notifyTimeout);

			return sessionId;
		} catch (error) {
			console.warn(
				'[granola-mcp] MCP initialization failed (non-fatal):',
				error instanceof Error ? error.message : String(error),
			);
			return null;
		}
	}

	// --- MCP Calls ---

	/**
	 * Parse an SSE response from Granola's MCP server.
	 */
	private parseMCPResponse(text: string, toolName: string): MCPResult {
		for (const line of text.split('\n')) {
			if (!line.startsWith('data: ')) {
				continue;
			}

			const parsed = JSON.parse(line.slice(6));
			if (parsed.error) {
				const errMsg =
					parsed.error.message || JSON.stringify(parsed.error);
				if (RATE_LIMIT_RE.test(errMsg)) {
					console.warn(
						`[granola-mcp] Rate limit in MCP error for ${toolName}`,
					);
					throw new Error('Rate limit exceeded');
				}
				throw new Error(`MCP error: ${errMsg}`);
			}

			const result = parsed.result as MCPResult & { isError?: boolean };
			if (result.isError) {
				const errText =
					result.content?.map((c) => c.text).join(' ') ??
					'unknown error';
				if (RATE_LIMIT_RE.test(errText)) {
					console.warn(
						`[granola-mcp] Rate limit in MCP result.isError for ${toolName}`,
					);
					throw new Error('Rate limit exceeded');
				}
				throw new Error(`MCP tool error: ${errText}`);
			}

			return result;
		}

		throw new Error('No data event in MCP SSE response');
	}

	/**
	 * Low-level MCP tool call. Most consumers should use the
	 * high-level methods (listMeetings, getMeetings, getMeetingTranscript).
	 */
	async callMCP(
		accessToken: string,
		method: string,
		params: unknown,
	): Promise<MCPResult> {
		const sessionId = await this.initializeMCPSession(accessToken);
		const id = this.nextRequestId++;

		const toolName =
			typeof params === 'object' && params !== null && 'name' in params
				? String((params as { name: string }).name)
				: method;

		const startTime = Date.now();

		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			Accept: 'application/json, text/event-stream',
			Authorization: `Bearer ${accessToken}`,
			'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
		};
		if (sessionId) {
			headers['Mcp-Session-Id'] = sessionId;
		}

		const res = await fetch(MCP_URL, {
			method: 'POST',
			headers,
			body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
		});

		const durationMs = Date.now() - startTime;
		this.trackRequest(toolName, res.status, durationMs);

		if (res.status === 429) {
			throw new Error('Rate limit exceeded');
		}

		// If session expired/invalid, clear cache so next call re-initializes
		if (res.status === 404 || res.status === 410) {
			console.warn(
				`[granola-mcp] Session may have expired (${res.status}), clearing cache`,
			);
			this.sessionCache.delete(accessToken);
		}

		if (!res.ok) {
			throw new Error(
				`MCP request failed: ${res.status} ${res.statusText}`,
			);
		}

		const text = await res.text();
		return this.parseMCPResponse(text, toolName);
	}

	/**
	 * List recent meetings within a date range.
	 * Note: Granola may ignore the date range and return ~1 month of meetings.
	 */
	async listMeetings(
		accessToken: string,
		startDate: string,
		endDate: string,
	): Promise<string> {
		const result = await this.callMCP(accessToken, 'tools/call', {
			name: 'list_meetings',
			arguments: { start_date: startDate, end_date: endDate },
		});
		return result.content.map((c) => c.text).join('\n');
	}

	/**
	 * Get detailed meeting information by IDs.
	 */
	async getMeetings(
		accessToken: string,
		meetingIds: string[],
	): Promise<string> {
		const result = await this.callMCP(accessToken, 'tools/call', {
			name: 'get_meetings',
			arguments: { meeting_ids: meetingIds },
		});
		return result.content.map((c) => c.text).join('\n');
	}

	/**
	 * Get the full transcript for a meeting.
	 */
	async getMeetingTranscript(
		accessToken: string,
		meetingId: string,
	): Promise<string> {
		const result = await this.callMCP(accessToken, 'tools/call', {
			name: 'get_meeting_transcript',
			arguments: { meeting_id: meetingId },
		});
		return result.content.map((c) => c.text).join('\n');
	}
}
