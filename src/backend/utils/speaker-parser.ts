/**
 * Auto-extracts speaker turns from Indian earnings call transcript text.
 *
 * Handles common BSE/NSE PDF formats:
 *   "Speaker Name: content..."
 *   "Speaker Name (CFO, Company): content..."
 *   "Speaker Name - Chief Financial Officer\ncontent..."
 */

export type SpeakerRole = 'CEO' | 'CFO' | 'Analyst' | 'Moderator' | 'Other';

export interface ParsedTurn {
  speaker: string;
  role: SpeakerRole;
  topic: string;
  content: string;
}

const ROLE_PATTERNS: Array<{ pattern: RegExp; role: SpeakerRole }> = [
  { pattern: /chief financial officer|cfo|\bfinance director\b/i, role: 'CFO' },
  { pattern: /chief executive officer|ceo|managing director|\bmd &/i, role: 'CEO' },
  { pattern: /analyst|research|fund manager|portfolio manager/i, role: 'Analyst' },
  { pattern: /moderator|operator|facilitator|host/i, role: 'Moderator' },
];

function detectRole(speakerLine: string): SpeakerRole {
  for (const { pattern, role } of ROLE_PATTERNS) {
    if (pattern.test(speakerLine)) return role;
  }
  return 'Other';
}

export function roleToTopic(role: SpeakerRole): string {
  switch (role) {
    case 'CFO': return 'financials';
    case 'CEO': return 'strategy';
    case 'Analyst': return 'qa';
    default: return 'general';
  }
}

// Matches "Firstname Lastname (optional title/co):" at line start
// Allows up to 5 words in name, avoids matching all-caps section headers
const SPEAKER_LINE = /^([A-Z][a-z]+(?:\s+[A-Z][a-zA-Z\-']+){0,4})(?:\s*[\(\-–][^:\n]{0,80})?:\s*/gm;

export function parseSpeakers(transcript: string): ParsedTurn[] {
  const positions: Array<{ index: number; matchLen: number; speaker: string; roleHint: string }> = [];

  let match: RegExpExecArray | null;
  SPEAKER_LINE.lastIndex = 0;

  while ((match = SPEAKER_LINE.exec(transcript)) !== null) {
    const speaker = match[1].trim();
    // Skip very common false positives (page headers, etc.)
    if (speaker.split(' ').length < 2 && !/(moderator|operator)/i.test(speaker)) continue;
    positions.push({
      index: match.index,
      matchLen: match[0].length,
      speaker,
      roleHint: match[0], // full matched line including title hint
    });
  }

  if (positions.length === 0) {
    // Transcript has no detected speakers — return as single unsegmented block
    return [{
      speaker: 'Unknown',
      role: 'Other',
      topic: 'general',
      content: transcript.trim(),
    }];
  }

  const turns: ParsedTurn[] = [];

  for (let i = 0; i < positions.length; i++) {
    const { index, matchLen, speaker, roleHint } = positions[i];
    const contentStart = index + matchLen;
    const contentEnd = i + 1 < positions.length ? positions[i + 1].index : transcript.length;
    const content = transcript.slice(contentStart, contentEnd).trim();

    if (content.length < 40) continue; // skip near-empty turns

    const role = detectRole(roleHint);

    turns.push({
      speaker,
      role,
      topic: roleToTopic(role),
      content,
    });
  }

  return turns;
}
