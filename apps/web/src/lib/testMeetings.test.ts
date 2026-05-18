import { describe, expect, it } from "vitest";
import { isUploadedTranscriptTestMeeting } from "./testMeetings";

describe("test meeting helpers", () => {
  it("detects uploaded transcript recap synthetic meetings from the calendar UID", () => {
    expect(isUploadedTranscriptTestMeeting({ calendar_uid: "test-recap-upload:abc" })).toBe(true);
    expect(isUploadedTranscriptTestMeeting({ calendar_uid: "real-calendar-event" })).toBe(false);
    expect(isUploadedTranscriptTestMeeting({ calendar_uid: null })).toBe(false);
  });
});
