import { z } from "zod";

const domainSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^(?!-)[a-z0-9.-]+(?<!-)$/i, "Invalid domain")
  .transform((value) => value.toLowerCase());

export const appSettingsSchema = z.object({
  companyName: z.string().trim().min(1),
  primaryDomain: domainSchema,
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
  })
});

export type AppSettings = z.infer<typeof appSettingsSchema>;

export const defaultSettings: AppSettings = {
  companyName: "Minutesbot Demo",
  primaryDomain: "wgs.bot",
  allowedDomains: ["wgs.bot"],
  recorderEmail: "notetaker@wgs.bot",
  attendee: {
    baseUrl: "https://attendee.wgs.bot",
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
  }
};

export function parseSettings(input: unknown): AppSettings {
  const parsed = appSettingsSchema.parse(input);
  return {
    ...parsed,
    allowedDomains: Array.from(new Set(parsed.allowedDomains.map((domain) => domain.toLowerCase()))),
    primaryDomain: parsed.primaryDomain.toLowerCase(),
    recorderEmail: parsed.recorderEmail.toLowerCase(),
    email: {
      ...parsed.email,
      senderEmail: parsed.email.senderEmail.toLowerCase(),
      testRecipient: parsed.email.testRecipient ? parsed.email.testRecipient.toLowerCase() : undefined
    }
  };
}
