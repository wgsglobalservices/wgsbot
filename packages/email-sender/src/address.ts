export function formatEmailAddress(displayName: string, email: string): string {
  const name = displayName.trim();
  const address = email.trim();
  if (!name) return address;
  return `${name} <${address}>`;
}
