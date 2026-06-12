const allowedTeamsHosts = new Set(["teams.microsoft.com", "teams.live.com", "teams.cloud.microsoft"]);

export function normalizeTeamsJoinUrl(input: string): string | null {
  const candidate = trimUrlCandidate(input);
  const url = parseUrl(candidate);
  if (!url || !allowedTeamsHosts.has(url.hostname.toLowerCase())) return null;

  const fragmentUrl = normalizeMeetupFragment(url);
  if (fragmentUrl) return fragmentUrl;

  const launcherUrl = normalizeLauncherUrl(url);
  if (launcherUrl) return launcherUrl;

  if (isMeetupPath(url.pathname)) return serializeUrl(url);
  if (isShortMeetPath(url)) return serializeUrl(url);
  if (isLightMeetingsPath(url.pathname)) return normalizeLightMeetingsUrl(url);

  return null;
}

function normalizeMeetupFragment(url: URL): string | null {
  if (!url.hash) return null;
  const fragment = url.hash.replace(/^#/, "");
  const meetupIndex = fragment.toLowerCase().indexOf("/l/meetup-join/");
  if (meetupIndex === -1) return null;
  return normalizeMeetupPath(fragment.slice(meetupIndex), url.origin);
}

function normalizeLauncherUrl(url: URL): string | null {
  if (!url.pathname.toLowerCase().endsWith("/dl/launcher/launcher.html")) return null;
  const nested = url.searchParams.get("url");
  if (!nested) return null;
  const meetupIndex = nested.toLowerCase().indexOf("/l/meetup-join/");
  if (meetupIndex === -1) return null;
  return normalizeMeetupPath(nested.slice(meetupIndex), url.origin);
}

function normalizeMeetupPath(pathAndQuery: string, origin: string): string | null {
  const url = parseUrl(pathAndQuery, origin);
  if (!url || !isMeetupPath(url.pathname)) return null;
  return serializeUrl(url);
}

function normalizeLightMeetingsUrl(url: URL): string | null {
  if (!isLightMeetingsPath(url.pathname)) return null;
  const coords = decodeCoords(url.searchParams.get("coords"));
  if (!coords) return null;
  const conversationId = stringField(coords, "conversationId");
  const tenantId = stringField(coords, "tenantId");
  const organizerId = stringField(coords, "organizerId");
  const messageId = stringField(coords, "messageId") ?? "0";
  if (!conversationId || !tenantId || !organizerId) return null;

  const context = encodeURIComponent(JSON.stringify({ Tid: tenantId, Oid: organizerId }));
  return `https://teams.microsoft.com/l/meetup-join/${encodeURIComponent(conversationId)}/${encodeURIComponent(messageId)}?context=${context}`;
}

function decodeCoords(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const decoded = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(decoded) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  return typeof field === "string" && field.trim() ? field.trim() : null;
}

function isMeetupPath(pathname: string): boolean {
  return pathname.toLowerCase().startsWith("/l/meetup-join/");
}

function isLightMeetingsPath(pathname: string): boolean {
  return pathname.toLowerCase() === "/light-meetings/launch";
}

function isShortMeetPath(url: URL): boolean {
  return /^\/meet\/[^/?#]+$/i.test(url.pathname) && Boolean(url.searchParams.get("p"));
}

function parseUrl(value: string, base?: string): URL | null {
  try {
    return base ? new URL(value, base) : new URL(value);
  } catch {
    return null;
  }
}

function serializeUrl(url: URL): string {
  url.hash = "";
  return trimUrlCandidate(url.toString());
}

function trimUrlCandidate(input: string): string {
  return input.trim().replace(/[\\,;.)]+$/g, "");
}
