import { fileURLToPath } from "node:url";
import { errorMessage, runWrangler, type RunCommand } from "./ensure-cloudflare-resources";

/**
 * Development settings seeded into the local D1 database. This object must
 * stay compatible with parseSettings in packages/shared/src/validation.ts
 * (scripts/seed-dev.test.ts enforces that); it is duplicated here because
 * tsx scripts cannot import workspace packages without a build step.
 */
export const seedSettings = {
  companyName: "Example Co (dev)",
  timeZone: "UTC",
  recorderEmail: "notetaker@example.com",
  recorderAliasEmails: [],
  allowedDomains: ["example.com"],
  bot: {
    displayName: "Notetaker (minutesbot)",
    joinLeadMinutes: 5,
    maxWaitingRoomMinutes: 15,
    maxMeetingDurationMinutes: 240,
    maxJoinAttempts: 2
  },
  transcription: {
    provider: "openai-whisper",
    baseUrl: "https://api.openai.com/v1",
    model: "whisper-1",
    language: "",
    apiKeyConfigured: false
  },
  recap: {
    provider: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5.5",
    subjectPrefix: "Meeting recap",
    introText: "",
    apiKeyConfigured: false
  },
  email: {
    // The mock provider logs instead of sending, so local runs cannot email anyone.
    provider: "mock",
    senderName: "minutesbot",
    senderEmail: "notetaker@example.com",
    testRecipient: "admin@example.com"
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
  scheduling: {
    recurrenceExpansionDays: 180,
    staleSessionMinutes: 10
  },
  retention: {
    rawInviteDays: 30,
    recordingDays: 30,
    transcriptDays: 90,
    summaryDays: 365,
    auditLogDays: 365,
    diagnosticsDays: 30
  }
};

/**
 * Builds the SQL that saveSettings would produce: the settings row plus the
 * mirrored allowed_domains rows used by the send boundary.
 */
export function buildSeedSql(now: () => string = () => new Date().toISOString()): string {
  const timestamp = now();
  const value = sqlString(JSON.stringify(seedSettings));
  const statements = [
    `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('app', ${value}, '${timestamp}');`,
    "DELETE FROM allowed_domains;",
    ...seedSettings.allowedDomains.map(
      (domain, index) =>
        `INSERT INTO allowed_domains (id, domain, allow_subdomains, enabled, created_at) VALUES ('dom-seed-${index}', '${domain}', ${seedSettings.policy.allowSubdomains ? 1 : 0}, 1, '${timestamp}');`
    )
  ];
  return statements.join("\n");
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

type SeedDevOptions = {
  args?: string[];
  runCommand?: RunCommand;
  log?: (message: string) => void;
};

export async function seedDev(options: SeedDevOptions = {}): Promise<void> {
  const args = options.args ?? process.argv.slice(2);
  const runCommand = options.runCommand ?? runWrangler;
  const log = options.log ?? console.log;
  const sql = buildSeedSql();

  if (args.includes("--print")) {
    log(sql);
    return;
  }

  log("Seeding local D1 database minutesbot with development settings (mock email provider)...");
  await runCommand("wrangler", ["d1", "execute", "minutesbot", "--local", "--command", sql]);
  log("Done. Adjust settings in the admin UI (Settings page) or rerun with --print to inspect the SQL.");
  log("Run `pnpm db:migrate:local` first if the settings table does not exist yet.");
}

const isCli = process.argv[1] === fileURLToPath(import.meta.url);

if (isCli) {
  seedDev().catch((error: unknown) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
