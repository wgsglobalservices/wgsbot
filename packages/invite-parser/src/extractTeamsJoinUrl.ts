import { normalizeTeamsJoinUrl } from "./normalizeTeamsJoinUrl";

const teamsUrlPattern = /https?:\/\/(?:teams\.microsoft\.com|teams\.live\.com|teams\.cloud\.microsoft)\/[^\s<>"')]+/gi;

// Defensive cleanup for URLs embedded in text that escaped earlier decoding:
// ICS escapes, HTML entities, and stray quoted-printable artifacts.
function decodeUrlArtifacts(input: string): string {
  return input
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/&amp;/g, "&")
    .replace(/=3D/g, "=")
    .replace(/=\r?\n/g, "");
}

export function extractTeamsJoinUrl(input: string): string | null {
  const decoded = decodeUrlArtifacts(input);
  const matches = decoded.matchAll(teamsUrlPattern);
  for (const match of matches) {
    const normalized = normalizeTeamsJoinUrl(match[0]);
    if (normalized) return normalized;
  }
  return null;
}
