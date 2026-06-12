export function chunkTranscript(transcriptText: string, maxChars = 12_000): string[] {
  if (transcriptText.length <= maxChars) return [transcriptText];
  const chunks: string[] = [];
  let remaining = transcriptText;
  while (remaining.length > maxChars) {
    const cut = remaining.lastIndexOf("\n", maxChars);
    const end = cut > maxChars * 0.6 ? cut : maxChars;
    const chunk = remaining.slice(0, end).trim();
    // Whitespace-only slices would otherwise become pointless LLM calls.
    if (chunk) chunks.push(chunk);
    remaining = remaining.slice(end).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
