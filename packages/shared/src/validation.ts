import { z } from "zod";

const legacySelfHostedAttendeeBaseUrls = new Set(["https://attendee.wgsglobal.app", "https://attendee.wgs.bot"]);
const defaultTimeZone = "UTC";

const domainSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^(?!-)[a-z0-9.-]+(?<!-)$/i, "Invalid domain")
  .transform((value) => value.toLowerCase());

const timeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => isValidTimeZone(value), "Invalid time zone");

export const recapSectionKeys = ["summary", "decisions", "actionItems", "openQuestions", "risks", "followUps"] as const;
export type RecapSectionKey = (typeof recapSectionKeys)[number];

const recapSectionLabels: Record<RecapSectionKey, string> = {
  summary: "Summary",
  decisions: "Decisions",
  actionItems: "Action items",
  openQuestions: "Open questions",
  risks: "Risks",
  followUps: "Follow-ups"
};

const recapSectionSchema = z.object({
  key: z.enum(recapSectionKeys),
  label: z.string().trim().min(1).max(80),
  enabled: z.boolean()
});

export const defaultRecapPrompt = [
  "You generate WGS meeting recaps from Microsoft Teams meeting titles and transcripts. Return strict JSON only.",
  "wgsbot automatically classifies meetings into Weekly SPQRC, Weekly Sales, Individual Plant Meeting, and General before generating the recap.",
  "Use the resolved meeting type supplied by the classifier and do not reclassify during recap generation.",
  "Do not invent facts, owners, due dates, decisions, risks, metrics, customer names, plant names, or follow-ups.",
  "If something is not mentioned, say \"Not specified\". If there are no items for a field, return an empty array."
].join("\n");

export const defaultRecapSections = recapSectionKeys.map((key) => ({
  key,
  label: recapSectionLabels[key],
  enabled: true
}));

export const appSettingsSchema = z.object({
  companyName: z.string().trim().min(1),
  primaryDomain: domainSchema,
  timeZone: timeZoneSchema.optional().default(defaultTimeZone),
  allowedDomains: z.array(domainSchema).min(1),
  recorderEmail: z.string().trim().email().transform((value) => value.toLowerCase()),
  attendee: z.object({
    baseUrl: z.string().trim().url(),
    apiKeyConfigured: z.boolean(),
    webhookSecretConfigured: z.boolean(),
    botName: z.string().trim().min(1),
    createBotMinutesBeforeStart: z.number().int().min(0).max(180),
    maxWaitingRoomMinutes: z.number().int().min(1).max(240),
    deleteAttendeeDataAfterTranscriptFetch: z.boolean(),
    botPayloadOverridesJson: z.string().optional()
  }),
  ai: z.object({
    provider: z.enum(["openai-compatible", "workers-ai"]),
    baseUrl: z.string().trim().url().optional().or(z.literal("")),
    model: z.string().trim().min(1),
    apiKeyConfigured: z.boolean()
  }),
  email: z.object({
    provider: z.enum(["cloudflare-email-service", "smtp", "mock"]),
    senderEmail: z.string().trim().email().transform((value) => value.toLowerCase()),
    testRecipient: z.string().trim().email().optional().or(z.literal(""))
  }),
  policy: z.object({
    sendToAllowedDomainsOnly: z.literal(true),
    allowSubdomains: z.boolean(),
    sendToExternalAttendees: z.literal(false),
    rejectExternalOrganizers: z.boolean(),
    requireAtLeastOneEligibleRecipient: z.boolean()
  }),
  retention: z.object({
    rawInviteDays: z.number().int().min(1).max(3650),
    transcriptDays: z.number().int().min(1).max(3650),
    summaryDays: z.number().int().min(1).max(3650),
    auditLogDays: z.number().int().min(1).max(3650),
    attendeeDeleteDataAfterDays: z.number().int().min(0).max(3650)
  }),
  recap: z
    .object({
      transcriptionModel: z.string().trim().min(1),
      language: z.string().trim().max(12).optional().or(z.literal("")),
      prompt: z.string().trim().min(20).max(8000),
      subjectPrefix: z.string().trim().min(1).max(80),
      introText: z.string().trim().max(1000).optional().or(z.literal("")),
      sections: z.array(recapSectionSchema).min(1)
    })
    .optional()
    .default({
      transcriptionModel: "openai/whisper-large-v3-turbo",
      language: "",
      prompt: defaultRecapPrompt,
      subjectPrefix: "Meeting recap",
      introText: "",
      sections: defaultRecapSections
    })
});

export type AppSettings = z.infer<typeof appSettingsSchema>;

export const defaultSettings: AppSettings = {
  companyName: "Minutesbot Demo",
  primaryDomain: "wgs.bot",
  timeZone: defaultTimeZone,
  allowedDomains: ["wgs.bot"],
  recorderEmail: "notetaker@wgs.bot",
  attendee: {
    baseUrl: "https://app.attendee.dev",
    apiKeyConfigured: false,
    webhookSecretConfigured: false,
    botName: "minutesbot",
    createBotMinutesBeforeStart: 5,
    maxWaitingRoomMinutes: 15,
    deleteAttendeeDataAfterTranscriptFetch: false
  },
  ai: {
    provider: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
    apiKeyConfigured: false
  },
  email: {
    provider: "mock",
    senderEmail: "notetaker@wgs.bot"
  },
  policy: {
    sendToAllowedDomainsOnly: true,
    allowSubdomains: false,
    sendToExternalAttendees: false,
    rejectExternalOrganizers: true,
    requireAtLeastOneEligibleRecipient: true
  },
  retention: {
    rawInviteDays: 30,
    transcriptDays: 30,
    summaryDays: 365,
    auditLogDays: 365,
    attendeeDeleteDataAfterDays: 0
  },
  recap: {
    transcriptionModel: "openai/whisper-large-v3-turbo",
    language: "",
    prompt: defaultRecapPrompt,
    subjectPrefix: "Meeting recap",
    introText: "",
    sections: defaultRecapSections
  }
};

export function parseSettings(input: unknown): AppSettings {
  const parsed = appSettingsSchema.parse(input);
  return {
    ...parsed,
    allowedDomains: Array.from(new Set(parsed.allowedDomains.map((domain) => domain.toLowerCase()))),
    primaryDomain: parsed.primaryDomain.toLowerCase(),
    timeZone: parsed.timeZone,
    recorderEmail: parsed.recorderEmail.toLowerCase(),
    email: {
      ...parsed.email,
      senderEmail: parsed.email.senderEmail.toLowerCase(),
      testRecipient: parsed.email.testRecipient ? parsed.email.testRecipient.toLowerCase() : undefined
    },
    recap: normalizeRecapSettings(parsed.recap)
  };
}

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function normalizeRecapSettings(recap: AppSettings["recap"]): AppSettings["recap"] {
  const provided = new Map(recap.sections.map((section) => [section.key, section]));
  const ordered = recap.sections.map((section) => section.key);
  for (const key of recapSectionKeys) {
    if (!ordered.includes(key)) ordered.push(key);
  }
  return {
    ...recap,
    language: recap.language ?? "",
    introText: recap.introText ?? "",
    sections: ordered.map((key) => {
      const section = provided.get(key);
      return section ?? { key, label: recapSectionLabels[key], enabled: true };
    })
  };
}

export function resolveAttendeeBaseUrl(settingsBaseUrl: string, envBaseUrl?: string): string {
  if (legacySelfHostedAttendeeBaseUrls.has(settingsBaseUrl.replace(/\/+$/, "")) && envBaseUrl) return envBaseUrl;
  return settingsBaseUrl || envBaseUrl || defaultSettings.attendee.baseUrl;
}
