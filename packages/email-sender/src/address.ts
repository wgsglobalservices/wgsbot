/**
 * Strips CR/LF/NUL from values destined for email headers so content derived
 * from untrusted input (e.g. an ICS SUMMARY with escaped newlines) cannot
 * inject additional headers.
 */
export function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n\0]+/g, " ").trim();
}

export function formatEmailAddress(displayName: string, email: string): string {
  const name = sanitizeHeaderValue(displayName);
  const address = sanitizeHeaderValue(email);
  if (!name) return address;
  // Quote display names containing RFC 5322 specials so they cannot alter
  // the address structure.
  if (/[()<>[\]:;@\\,."]/.test(name)) {
    return `"${name.replace(/(["\\])/g, "\\$1")}" <${address}>`;
  }
  return `${name} <${address}>`;
}
