export const BOT_WEBHOOK_TRIGGERS = [
  "bot.state_change",
  "transcript.update",
  "chat_messages.update",
  "participant_events.join_leave",
  "participant_events.speech_start_stop",
  "bot_logs.update"
] as const;
export const ATTENDEE_WEBHOOK_TRIGGERS = BOT_WEBHOOK_TRIGGERS;

export type BotWebhookTrigger = (typeof BOT_WEBHOOK_TRIGGERS)[number];

export type CreateBotInput = {
  meetingUrl: string;
  botName: string;
  recordingSettings?: {
    format: "mp3" | "mp4" | "webm";
  };
  botImage?: {
    type: "image/png" | "image/jpeg";
    data: string;
  };
  botChatMessage?: string;
  externalMediaStorageSettings?: {
    bucketName: string;
    recordingFileName?: string;
  };
  webhooks?: Array<{
    url: string;
    triggers: BotWebhookTrigger[];
  }>;
  metadata?: Record<string, unknown>;
  rawOverrides?: Record<string, unknown>;
};

export type BotRun = {
  id: string;
  meeting_url: string;
  state: string;
  transcription_state?: string;
  recording_state?: string;
};

export type BotRecording = {
  data: ArrayBuffer;
  contentType: string;
  sizeBytes?: number;
};

export type BotHealth = {
  ok: boolean;
  runtime?: string;
  missing?: string[];
};

export type BotTranscriptSegment = {
  speaker_name?: string;
  speaker_uuid?: string;
  speaker_user_uuid?: string;
  timestamp_ms?: number;
  duration_ms?: number;
  transcription: string | { transcript?: string; words?: unknown };
};

export type BotClientOptions = {
  baseUrl: string;
  internalToken?: string;
  fetcher?: typeof fetch;
};

export type AttendeeWebhookTrigger = BotWebhookTrigger;
export type CreateAttendeeBotInput = CreateBotInput;
export type AttendeeBot = BotRun;
export type AttendeeRecording = BotRecording;
export type AttendeeHealth = BotHealth;
export type AttendeeTranscriptSegment = BotTranscriptSegment;
export type AttendeeClientOptions = BotClientOptions;
