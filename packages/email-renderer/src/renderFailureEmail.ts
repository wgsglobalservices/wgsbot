import type { RenderedEmail } from "./types";

export function renderFailureEmail(input: { subject: string }): RenderedEmail {
  const body = [
    "We could not generate notes because no transcript was available.",
    "",
    "Possible causes:",
    "- The bot was not admitted to the meeting.",
    "- The meeting had no speech.",
    "- Transcription did not complete.",
    "- The meeting bot reported a fatal error.",
    "",
    "This notice was sent only to the organizer."
  ].join("\n");
  return {
    subject: `Notes unavailable: ${input.subject}`,
    text: body,
    html: `<p>We could not generate notes because no transcript was available.</p><p>Possible causes:</p><ul><li>The bot was not admitted to the meeting.</li><li>The meeting had no speech.</li><li>Transcription did not complete.</li><li>The meeting bot reported a fatal error.</li></ul><p>This notice was sent only to the organizer.</p>`
  };
}
