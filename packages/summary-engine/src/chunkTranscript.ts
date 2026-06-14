export function chunkTranscript(transcriptText: string, maxChars = 40_000): string[] {
  if (transcriptText.length <= maxChars) return [transcriptText];
  const chunks: string[] = [];
  let remaining = transcriptText;
  while (remaining.length > maxChars) {
    // Prefer paragraph boundaries, fall back to line breaks, then a hard cut.
    const paragraphCut = remaining.lastIndexOf("\n\n", maxChars);
    const lineCut = remaining.lastIndexOf("\n", maxChars);
    const cut = paragraphCut > maxChars * 0.5 ? paragraphCut : lineCut;
    const end = cut > maxChars * 0.5 ? cut : maxChars;
    const chunk = remaining.slice(0, end).trim();
    // Whitespace-only slices would otherwise become pointless LLM calls.
    if (chunk) chunks.push(chunk);
    remaining = remaining.slice(end).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
