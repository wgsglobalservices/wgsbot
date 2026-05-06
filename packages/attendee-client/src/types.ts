export const ATTENDEE_WEBHOOK_TRIGGERS = [
  "bot.state_change",
  "transcript.update",
  "chat_messages.update",
  "participant_events.join_leave",
  "participant_events.speech_start_stop",
  "bot_logs.update"
] as const;

export type AttendeeWebhookTrigger = (typeof ATTENDEE_WEBHOOK_TRIGGERS)[number];

export type CreateAttendeeBotInput = {
  meetingUrl: string;
  botName: string;
  recordingSettings?: {
    format: "mp3" | "mp4" | "webm";
  };
  externalMediaStorageSettings?: {
    bucketName: string;
    recordingFileName?: string;
  };
  webhooks?: Array<{
    url: string;
    triggers: AttendeeWebhookTrigger[];
  }>;
  metadata?: Record<string, unknown>;
  rawOverrides?: Record<string, unknown>;
};

export type AttendeeBot = {
  id: string;
  meeting_url: string;
  state: string;
  transcription_state?: string;
  recording_state?: string;
};

export type AttendeeRecording = {
  data: ArrayBuffer;
  contentType: string;
  sizeBytes?: number;
};

export type AttendeeHealth = {
  ok: boolean;
  runtime?: string;
  missing?: string[];
};

export type AttendeeTranscriptSegment = {
  speaker_name?: string;
  speaker_uuid?: string;
  speaker_user_uuid?: string;
  timestamp_ms?: number;
  duration_ms?: number;
  transcription: string | { transcript?: string; words?: unknown };
};

export type AttendeeClientOptions = {
  baseUrl: string;
  apiKey: string;
  fetcher?: typeof fetch;
};
