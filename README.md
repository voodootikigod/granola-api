# granola-api

TypeScript client for the [Granola](https://granola.ai) MCP API — OAuth, meeting data, and transcript access.

- Zero runtime dependencies (Node.js stdlib only)
- OAuth 2.0 with PKCE
- Automatic token refresh with pluggable storage
- MCP session management and rate-limit tracking
- Dual ESM/CommonJS builds

## Install

```bash
npm install granola-api
# or
pnpm add granola-api
```

## Quick Start

```ts
import {
  GranolaClient,
  registerClient,
  generatePKCE,
  generateState,
  buildAuthorizationUrl,
  exchangeCode,
} from 'granola-api';

// 1. Register an OAuth client
const { clientId } = await registerClient('My App', 'http://localhost:3000/callback');

// 2. Generate PKCE challenge and start OAuth flow
const { codeVerifier, codeChallenge } = await generatePKCE();
const state = generateState();
const authUrl = buildAuthorizationUrl(clientId, 'http://localhost:3000/callback', state, codeChallenge);
// Redirect user to authUrl...

// 3. Exchange the authorization code for tokens
const tokens = await exchangeCode(clientId, 'http://localhost:3000/callback', code, codeVerifier);

// 4. Use the client
const client = new GranolaClient();
const meetings = await client.listMeetings(tokens.accessToken, '2025-01-01', '2025-01-31');
```

## API

### `GranolaClient`

```ts
const client = new GranolaClient(options?: GranolaClientOptions);
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `clientName` | `string` | `'Granola API Client'` | Name sent during MCP initialization |
| `clientVersion` | `string` | `'1.0.0'` | Version sent during MCP initialization |
| `tokenStore` | `TokenStore` | — | Pluggable token persistence for automatic refresh |
| `requestTracker` | `RequestTracker` | — | Optional callback for request metrics |

#### Methods

**`listMeetings(accessToken, startDate, endDate)`** — List recent meetings within a date range.

**`getMeetings(accessToken, meetingIds)`** — Get detailed meeting information by IDs.

**`getMeetingTranscript(accessToken, meetingId)`** — Get the full transcript for a meeting.

**`getValidAccessToken(userId)`** — Get a valid access token, refreshing if needed. Requires a `TokenStore`.

**`getCurrentRPM()`** — Get the current in-process requests-per-minute count.

**`callMCP(accessToken, method, params)`** — Low-level MCP tool call for direct protocol access.

### OAuth Functions

| Function | Description |
|----------|-------------|
| `registerClient(name, redirectUri)` | Register a new OAuth client with Granola |
| `generatePKCE()` | Generate a PKCE code verifier and challenge |
| `generateState()` | Generate a random state token |
| `buildAuthorizationUrl(clientId, redirectUri, state, codeChallenge)` | Build the OAuth authorization URL |
| `exchangeCode(clientId, redirectUri, code, codeVerifier)` | Exchange an authorization code for tokens |
| `refreshAccessToken(clientId, refreshToken)` | Refresh an expired access token |

### Parsing Functions

| Function | Description |
|----------|-------------|
| `parseMeetingList(raw)` | Extract meeting IDs and titles from a list response |
| `parseMeetingListFull(raw)` | Full parsing with attendees, times, and notes |
| `parseMeetingDetails(raw)` | Parse meeting details including transcript |

### Types

```ts
interface GranolaTokens {
  accessToken: string;
  clientId: string;
  expiresAt: number;       // Unix timestamp (ms)
  refreshToken: string;
}

interface GranolaMeeting {
  id: string;
  title: string;
  startTime: string;
  endTime?: string;
  attendees?: GranolaAttendee[];
}

interface GranolaPayload {
  id: string;
  title: string;
  transcript: string;
  enhanced_notes: string;
  my_notes: string;
  attendees: GranolaAttendee[];
  creator_name: string;
  creator_email: string;
  calendar_event_ID: string;
  calendar_event_title: string;
  calendar_event_time: string;
  link: string;
}

interface TokenStore {
  getTokens(userId: string): Promise<GranolaTokens | null>;
  storeTokens(userId: string, tokens: GranolaTokens): Promise<void>;
}

interface RequestTracker {
  trackRequest(toolName: string, status: number, durationMs: number): void | Promise<void>;
}
```

## Token Storage

Implement the `TokenStore` interface to persist tokens in your backend:

```ts
import { GranolaClient, type TokenStore } from 'granola-api';

const store: TokenStore = {
  async getTokens(userId) {
    return db.granolaTokens.findUnique({ where: { userId } });
  },
  async storeTokens(userId, tokens) {
    await db.granolaTokens.upsert({ where: { userId }, create: { userId, ...tokens }, update: tokens });
  },
};

const client = new GranolaClient({ tokenStore: store });
const accessToken = await client.getValidAccessToken('user-123');
```

Tokens are refreshed automatically when they expire within 5 minutes.

## Development

```bash
pnpm install
pnpm dev          # Watch mode
pnpm build        # Production build
pnpm typecheck    # Type check without emitting
```

## License

[MIT](LICENSE)
