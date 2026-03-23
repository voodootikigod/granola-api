import type { GranolaPayload } from './types';

const UUID_PATTERN =
	/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const TITLE_PATTERN = /(?:title|name):\s*(.+)/i;
const XML_TITLE_PATTERN = /title="([^"]+)"/i;
const DETAILS_TITLE_PATTERN =
	/(?:^|\n)\s*(?:title|name|subject)\s*[:=]\s*(.+)/im;
const DETAILS_CREATOR_PATTERN =
	/(?:^|\n)\s*(?:creator|organizer|host)\s*[:=]\s*(.+)/im;

const MEETING_BLOCK_PATTERN =
	/<meeting\s+[^>]*?id="([^"]+)"[^>]*?title="([^"]*)"[^>]*?date="([^"]*)"[^>]*?>([\s\S]*?)(?:<\/meeting>|(?=<meeting\s))/gi;
const PARTICIPANTS_PATTERN =
	/<known_participants>\s*([\s\S]*?)\s*<\/known_participants>/i;
const SUMMARY_PATTERN = /<summary>\s*([\s\S]*?)\s*<\/summary>/i;
const CREATOR_MARKER = /\(note creator\)/i;

const EMAIL_ANGLE_BRACKET_PATTERN = /<([^>]+)>/;
const STRIP_ANGLE_BRACKET_PATTERN = /<[^>]+>/;
const STRIP_FROM_PATTERN = /\s*from\s+\S+.*/;
const STRIP_NOTE_CREATOR_PATTERN = /\(note creator\)/i;

/**
 * Parse meeting list response to extract meeting IDs and metadata.
 * Handles both JSON and structured text responses from the MCP API.
 */
export function parseMeetingList(
	responseText: string,
): Array<{ id: string; title: string }> {
	// Try JSON first
	try {
		const parsed = JSON.parse(responseText);
		if (Array.isArray(parsed)) {
			return parsed
				.filter((m) => m.id)
				.map((m) => ({
					id: m.id,
					title: m.title || m.name || m.subject || '',
				}));
		}
		if (parsed.meetings && Array.isArray(parsed.meetings)) {
			return parsed.meetings
				.filter((m: { id?: string }) => m.id)
				.map(
					(m: {
						id: string;
						title?: string;
						name?: string;
						subject?: string;
					}) => ({
						id: m.id,
						title: m.title || m.name || m.subject || '',
					}),
				);
		}
	} catch {
		// Not JSON — fall through to text extraction
	}

	// Fallback: extract UUID patterns and titles from text
	const meetings: Array<{ id: string; title: string }> = [];
	const lines = responseText.split('\n');

	for (const line of lines) {
		const uuidMatch = line.match(UUID_PATTERN);
		if (uuidMatch) {
			const xmlTitleMatch = line.match(XML_TITLE_PATTERN);
			const titleMatch = xmlTitleMatch || line.match(TITLE_PATTERN);
			meetings.push({
				id: uuidMatch[1],
				title: titleMatch ? titleMatch[1].trim() : '',
			});
		}
	}

	return meetings;
}

/**
 * Parse the full list response into GranolaPayload objects (minus transcript).
 * Extracts all meeting data from the XML-like list response.
 */
export function parseMeetingListFull(
	responseText: string,
): Omit<GranolaPayload, 'transcript'>[] {
	const results: Omit<GranolaPayload, 'transcript'>[] = [];

	// Reset lastIndex — the regex is module-scoped with the `g` flag
	MEETING_BLOCK_PATTERN.lastIndex = 0;

	let match: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: regex exec loop
	while ((match = MEETING_BLOCK_PATTERN.exec(responseText)) !== null) {
		const [, id, title, date, body] = match;

		// Parse participants
		const participantsMatch = body.match(PARTICIPANTS_PATTERN);
		const participantsText = participantsMatch?.[1] ?? '';
		const attendees: GranolaPayload['attendees'] = [];
		let creatorName = '';
		let creatorEmail = '';

		for (const part of participantsText.split(',')) {
			const trimmed = part.trim();
			if (!trimmed) {
				continue;
			}

			const emailMatch = trimmed.match(EMAIL_ANGLE_BRACKET_PATTERN);
			const email = emailMatch?.[1] ?? '';
			const name = trimmed
				.replace(STRIP_ANGLE_BRACKET_PATTERN, '')
				.replace(STRIP_FROM_PATTERN, '')
				.replace(STRIP_NOTE_CREATOR_PATTERN, '')
				.trim();

			attendees.push({ name, email });

			if (CREATOR_MARKER.test(trimmed)) {
				creatorName = name;
				creatorEmail = email;
			}
		}

		// Parse summary/notes
		const summaryMatch = body.match(SUMMARY_PATTERN);
		const enhancedNotes = summaryMatch?.[1] ?? '';

		results.push({
			id,
			title: title || 'Untitled Meeting',
			creator_name: creatorName,
			creator_email: creatorEmail,
			attendees,
			calendar_event_ID: '',
			calendar_event_title: title || '',
			calendar_event_time: date || new Date().toISOString(),
			my_notes: '',
			enhanced_notes: enhancedNotes,
			link: `https://app.granola.ai/meetings/${id}`,
		});
	}

	return results;
}

/**
 * Deep-search for a title field in a parsed JSON object.
 */
function findTitleInObject(obj: Record<string, unknown>): string | null {
	for (const key of [
		'title',
		'name',
		'subject',
		'displayName',
		'meeting_title',
		'calendar_event_title',
	]) {
		if (typeof obj[key] === 'string' && obj[key]) {
			return obj[key] as string;
		}
	}
	if (obj.meeting && typeof obj.meeting === 'object') {
		const nested = findTitleInObject(
			obj.meeting as Record<string, unknown>,
		);
		if (nested) {
			return nested;
		}
	}
	if (obj.data && typeof obj.data === 'object') {
		const nested = findTitleInObject(obj.data as Record<string, unknown>);
		if (nested) {
			return nested;
		}
	}
	return null;
}

/**
 * Parse meeting details + transcript into a full GranolaPayload.
 */
export function parseMeetingDetails(
	detailsText: string,
	transcriptText: string,
	meetingId: string,
	listTitle?: string,
): GranolaPayload {
	let details: Record<string, unknown> = {};
	let foundTitle: string | null = null;

	try {
		const parsed = JSON.parse(detailsText);
		details = Array.isArray(parsed) ? parsed[0] : parsed;
		if (details.meetings && Array.isArray(details.meetings)) {
			details = (details.meetings as Record<string, unknown>[])[0];
		}
		foundTitle = findTitleInObject(details);
	} catch {
		// Not JSON — try regex extraction
		const xmlTitleMatch = detailsText.match(XML_TITLE_PATTERN);
		if (xmlTitleMatch) {
			foundTitle = xmlTitleMatch[1].trim();
		} else {
			const titleMatch = detailsText.match(DETAILS_TITLE_PATTERN);
			if (titleMatch) {
				foundTitle = titleMatch[1].trim();
			}
		}
		const creatorMatch = detailsText.match(DETAILS_CREATOR_PATTERN);
		if (creatorMatch) {
			details.creator_name = creatorMatch[1].trim();
		}
	}

	const resolvedTitle =
		foundTitle ||
		(details.title as string) ||
		listTitle ||
		'Untitled Meeting';

	return {
		id: (details.id as string) || meetingId,
		title: resolvedTitle,
		creator_name: (details.creator_name as string) || '',
		creator_email: (details.creator_email as string) || '',
		attendees:
			(details.attendees as GranolaPayload['attendees']) || [],
		calendar_event_ID:
			(details.calendar_event_id as string) ||
			(details.calendar_event_ID as string) ||
			'',
		calendar_event_title:
			(details.calendar_event_title as string) ||
			(details.title as string) ||
			'',
		calendar_event_time:
			(details.start_time as string) ||
			(details.calendar_event_time as string) ||
			new Date().toISOString(),
		my_notes:
			(details.my_notes as string) ||
			(details.private_notes as string) ||
			'',
		enhanced_notes:
			(details.enhanced_notes as string) ||
			(details.ai_notes as string) ||
			(details.notes as string) ||
			'',
		transcript: transcriptText || '',
		link:
			(details.link as string) ||
			(details.url as string) ||
			`https://app.granola.ai/meetings/${meetingId}`,
	};
}
