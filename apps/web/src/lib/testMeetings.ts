const uploadedTranscriptTestPrefix = "test-recap-upload:";

export function isUploadedTranscriptTestMeeting(meeting: { calendar_uid?: unknown }): boolean {
  return typeof meeting.calendar_uid === "string" && meeting.calendar_uid.startsWith(uploadedTranscriptTestPrefix);
}
