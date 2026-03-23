import { createHash, randomBytes } from 'node:crypto';

const TOKEN_URL = 'https://mcp-auth.granola.ai/oauth2/token';
const REGISTER_URL = 'https://mcp-auth.granola.ai/oauth2/register';
const AUTHORIZE_URL = 'https://mcp-auth.granola.ai/oauth2/authorize';
const MCP_URL = 'https://mcp.granola.ai/mcp';

export function generatePKCE(): {
	codeVerifier: string;
	codeChallenge: string;
} {
	const codeVerifier = randomBytes(32).toString('base64url');
	const codeChallenge = createHash('sha256')
		.update(codeVerifier)
		.digest('base64url');
	return { codeVerifier, codeChallenge };
}

export function generateState(): string {
	return randomBytes(16).toString('hex');
}

export async function registerClient(
	redirectUri: string,
	clientName = 'Granola API Client',
): Promise<{ clientId: string }> {
	const res = await fetch(REGISTER_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			client_name: clientName,
			redirect_uris: [redirectUri],
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			token_endpoint_auth_method: 'none',
		}),
	});

	if (!res.ok) {
		const error = await res.text();
		throw new Error(`Client registration failed: ${error}`);
	}

	const data = (await res.json()) as { client_id: string };
	return { clientId: data.client_id };
}

export function buildAuthorizationUrl(params: {
	clientId: string;
	codeChallenge: string;
	redirectUri: string;
	state: string;
}): string {
	const searchParams = new URLSearchParams({
		response_type: 'code',
		client_id: params.clientId,
		code_challenge: params.codeChallenge,
		code_challenge_method: 'S256',
		redirect_uri: params.redirectUri,
		state: params.state,
		scope: 'email offline_access openid profile',
		prompt: 'consent',
		resource: MCP_URL,
	});
	return `${AUTHORIZE_URL}?${searchParams}`;
}

export async function exchangeCode(params: {
	clientId: string;
	code: string;
	redirectUri: string;
	codeVerifier: string;
}): Promise<{
	accessToken: string;
	refreshToken: string;
	expiresIn: number;
	idToken?: string;
	rawResponse: Record<string, unknown>;
}> {
	const res = await fetch(TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'authorization_code',
			client_id: params.clientId,
			code: params.code,
			redirect_uri: params.redirectUri,
			code_verifier: params.codeVerifier,
		}).toString(),
	});

	if (!res.ok) {
		const error = await res.text();
		throw new Error(`Token exchange failed: ${error}`);
	}

	const data = (await res.json()) as Record<string, unknown>;
	return {
		accessToken: data.access_token as string,
		refreshToken: data.refresh_token as string,
		expiresIn: data.expires_in as number,
		idToken: data.id_token as string | undefined,
		rawResponse: data,
	};
}

export async function refreshAccessToken(
	clientId: string,
	refreshToken: string,
): Promise<{
	accessToken: string;
	refreshToken: string;
	expiresIn: number;
}> {
	const res = await fetch(TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'refresh_token',
			client_id: clientId,
			refresh_token: refreshToken,
		}).toString(),
	});

	if (!res.ok) {
		const error = await res.text();
		throw new Error(`Token refresh failed: ${error}`);
	}

	const data = (await res.json()) as Record<string, unknown>;
	return {
		accessToken: data.access_token as string,
		refreshToken: (data.refresh_token as string) ?? refreshToken,
		expiresIn: data.expires_in as number,
	};
}
