import { z } from "zod";

const defaultTimeZone = "UTC";
const defaultEmailSenderName = "minutesbot";

export const defaultTranscriptionModel = "whisper-1";
export const defaultRecapModel = "gpt-5.5";

// Requires at least two dot-separated labels: a bare TLD entry such as "com"
// combined with allowSubdomains would otherwise make every .com address an
// eligible recap recipient.
const domainSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i, "Invalid domain")
  .transform((value) => value.toLowerCase());

const headerSafeString = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[^\r\n]*$/, "Must not contain line breaks");

const timeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => isValidTimeZone(value), "Invalid time zone");

const botImageSchema = z.object({
  r2Key: z.string().trim().min(1),
  contentType: z.enum(["image/png", "image/jpeg"]),
  fileName: z.string().trim().min(1).max(255).optional(),
  uploadedAt: z.string().trim().datetime()
});

const httpsUrlSchema = z
  .string()
  .trim()
  .url()
  .refine((value) => value.startsWith("https://") || value.startsWith("http://localhost"), "Must be an https URL");

const defaultBotSettings = {
  displayName: "Notetaker (minutesbot)",
  joinLeadMinutes: 5,
  maxWaitingRoomMinutes: 15,
  maxMeetingDurationMinutes: 240,
  maxJoinAttempts: 2
};

const defaultSchedulingSettings = {
  recurrenceExpansionDays: 180,
  staleSessionMinutes: 10
};

export const defaultSampleRecapRecipient = "admin@company.com";

export const appSettingsSchema = z.object({
  companyName: z.string().trim().min(1),
  timeZone: timeZoneSchema.optional().default(defaultTimeZone),
  recorderEmail: z.string().trim().email().transform((value) => value.toLowerCase()),
  recorderAliasEmails: z
    .array(z.string().trim().email().transform((value) => value.toLowerCase()))
    .optional()
    .default([]),
  allowedDomains: z.array(domainSchema).min(1),
  bot: z
    .object({
      // The display name must make clear the participant is a recorder.
      displayName: headerSafeString(60).default(defaultBotSettings.displayName),
      joinLeadMinutes: z.number().int().min(0).max(60).default(defaultBotSettings.joinLeadMinutes),
      maxWaitingRoomMinutes: z.number().int().min(1).max(240).default(defaultBotSettings.maxWaitingRoomMinutes),
      maxMeetingDurationMinutes: z.number().int().min(15).max(720).default(defaultBotSettings.maxMeetingDurationMinutes),
      maxJoinAttempts: z.number().int().min(1).max(5).default(defaultBotSettings.maxJoinAttempts),
      image: botImageSchema.optional()
    })
    .default(defaultBotSettings),
  transcription: z
    .object({
      provider: z.enum(["openai-whisper", "whisper-compatible"]).default("openai-whisper"),
      baseUrl: httpsUrlSchema.optional().or(z.literal("")),
      model: z.string().trim().min(1).default(defaultTranscriptionModel),
      language: z.string().trim().max(12).optional().or(z.literal("")),
      apiKeyConfigured: z.boolean().default(false)
    })
    .default({ provider: "openai-whisper", model: defaultTranscriptionModel, apiKeyConfigured: false }),
  recap: z
    .object({
      provider: z.literal("openai-compatible").default("openai-compatible"),
      baseUrl: httpsUrlSchema.optional().or(z.literal("")),
      model: z.string().trim().min(1).default(defaultRecapModel),
      subjectPrefix: headerSafeString(80).default("Meeting recap"),
      introText: z.string().trim().max(1000).optional().or(z.literal("")),
      apiKeyConfigured: z.boolean().default(false)
    })
    .default({ provider: "openai-compatible", model: defaultRecapModel, subjectPrefix: "Meeting recap", apiKeyConfigured: false }),
  email: z.object({
    provider: z.enum(["cloudflare-email-service", "mock"]),
    senderName: headerSafeString(120).default(defaultEmailSenderName),
    senderEmail: z.string().trim().email().transform((value) => value.toLowerCase()),
    testRecipient: z.string().trim().email().optional().or(z.literal(""))
  }),
  policy: z.object({
    // Literal types: these two are product invariants, not toggles. The
    // schema rejects any payload that tries to widen recap delivery.
    sendToAllowedDomainsOnly: z.literal(true),
    sendToExternalAttendees: z.literal(false),
    allowSubdomains: z.boolean(),
    distribution: z.enum(["all_eligible", "organizer_only"]).optional().default("all_eligible"),
    rejectExternalOrganizers: z.boolean(),
    requireAtLeastOneEligibleRecipient: z.boolean(),
    // Reject inbound invites whose From domain fails SPF/DKIM/DMARC
    // verification (checked via the receiving MTA's Authentication-Results).
    requireAuthenticatedSender: z.boolean().optional().default(true)
  }),
  scheduling: z
    .object({
      recurrenceExpansionDays: z.number().int().min(7).max(365).default(defaultSchedulingSettings.recurrenceExpansionDays),
      staleSessionMinutes: z.number().int().min(2).max(120).default(defaultSchedulingSettings.staleSessionMinutes)
    })
    .default(defaultSchedulingSettings),
  retention: z.object({
    rawInviteDays: z.number().int().min(1).max(3650),
    recordingDays: z.number().int().min(1).max(3650).optional().default(30),
    transcriptDays: z.number().int().min(1).max(3650),
    summaryDays: z.number().int().min(1).max(3650),
    auditLogDays: z.number().int().min(1).max(3650),
    diagnosticsDays: z.number().int().min(1).max(3650).optional().default(30)
  })
});

export type AppSettings = z.infer<typeof appSettingsSchema>;

export const defaultSettings: AppSettings = {
  companyName: "Minutesbot",
  timeZone: defaultTimeZone,
  recorderEmail: "notetaker@example.com",
  recorderAliasEmails: [],
  allowedDomains: ["example.com"],
  bot: { ...defaultBotSettings },
  transcription: {
    provider: "openai-whisper",
    baseUrl: "https://api.openai.com/v1",
    model: defaultTranscriptionModel,
    language: "",
    apiKeyConfigured: false
  },
  recap: {
    provider: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    model: defaultRecapModel,
    subjectPrefix: "Meeting recap",
    introText: "",
    apiKeyConfigured: false
  },
  email: {
    provider: "mock",
    senderName: defaultEmailSenderName,
    senderEmail: "notetaker@example.com",
    testRecipient: defaultSampleRecapRecipient
  },
  policy: {
    sendToAllowedDomainsOnly: true,
    sendToExternalAttendees: false,
    allowSubdomains: false,
    distribution: "all_eligible",
    rejectExternalOrganizers: true,
    requireAtLeastOneEligibleRecipient: true,
    requireAuthenticatedSender: true
  },
  scheduling: { ...defaultSchedulingSettings },
  retention: {
    rawInviteDays: 30,
    recordingDays: 30,
    transcriptDays: 90,
    summaryDays: 365,
    auditLogDays: 365,
    diagnosticsDays: 30
  }
};

export function parseSettings(input: unknown): AppSettings {
  const parsed = appSettingsSchema.parse(input);
  return {
    ...parsed,
    allowedDomains: Array.from(new Set(parsed.allowedDomains.map((domain) => domain.toLowerCase()))),
    recorderEmail: parsed.recorderEmail.toLowerCase(),
    recorderAliasEmails: normalizeRecorderAliasEmails(parsed.recorderEmail, parsed.recorderAliasEmails),
    email: {
      ...parsed.email,
      senderEmail: parsed.email.senderEmail.toLowerCase(),
      testRecipient: parsed.email.testRecipient ? parsed.email.testRecipient.toLowerCase() : undefined
    }
  };
}

function normalizeRecorderAliasEmails(recorderEmail: string, aliases: string[]): string[] {
  const primary = recorderEmail.toLowerCase();
  return Array.from(new Set(aliases.map((email) => email.toLowerCase()))).filter((email) => email !== primary);
}

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}
