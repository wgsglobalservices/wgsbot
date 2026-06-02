export function cleanMeetingSubject(input: string): string {
  let subject = input.trim();

  while (/^(?:fw|fwd|re)\s*:/i.test(subject)) {
    subject = subject.replace(/^(?:fw|fwd|re)\s*:\s*/i, "").trim();
  }

  return subject;
}
