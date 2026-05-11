import { normalizeTeamsJoinUrl } from "./normalizeTeamsJoinUrl";

const teamsUrlPattern = /https?:\/\/(?:teams\.microsoft\.com|teams\.live\.com|teams\.cloud\.microsoft)\/[^\s<>"')]+/gi;

function decodeIcsText(input: string): string {
  return input
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/&amp;/g, "&")
    .replace(/=3D/g, "=")
    .replace(/=\r?\n/g, "");
}

export function extractTeamsJoinUrl(input: string): string | null {
  const decoded = decodeIcsText(input);
  const matches = decoded.matchAll(teamsUrlPattern);
  for (const match of matches) {
    const normalized = normalizeTeamsJoinUrl(match[0]);
    if (normalized) return normalized;
  }
  return null;
}
