import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { AppSettings } from "@minutesbot/shared";
import type { SettingsView } from "../lib/api";
import { TestActionButton } from "./TestActionButton";

export type SettingsSectionProps = {
  value: AppSettings;
  onChange: (settings: AppSettings) => void;
};

export function updateSettingsPath(value: AppSettings, path: string, next: unknown): AppSettings {
  const clone = structuredClone(value) as AppSettings;
  const parts = path.split(".");
  let target: Record<string, unknown> = clone as unknown as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) target = target[part] as Record<string, unknown>;
  target[parts.at(-1)!] = next;
  return clone;
}

export function SettingsForm({
  value,
  secrets,
  onBotImageUpload,
  onChange
}: SettingsSectionProps & {
  secrets?: SettingsView["secrets"];
  onBotImageUpload?: (file: File) => Promise<void>;
}) {
  return (
    <form className="setupForm">
      <CompanySection value={value} onChange={onChange} />
      <DomainsPolicySection value={value} onChange={onChange} />
      <BotSection value={value} onChange={onChange} onBotImageUpload={onBotImageUpload} />
      <TranscriptionSection value={value} onChange={onChange} />
      <RecapSection value={value} onChange={onChange} />
      <EmailSection value={value} onChange={onChange} />
      <SchedulingSection value={value} onChange={onChange} />
      <RetentionSection value={value} onChange={onChange} />
      {secrets && <SecretsSection secrets={secrets} />}
      <SettingsSection title="Diagnostics" description="Run connectivity checks against the saved configuration." secondary>
        <div className="diagnosticActions">
          <TestActionButton path="/api/admin/test-d1" label="Test D1" variant="tertiary" />
          <TestActionButton path="/api/admin/test-r2" label="Test R2" variant="tertiary" />
          <TestActionButton path="/api/admin/test-bot" label="Test bot runtime" variant="tertiary" />
          <TestActionButton path="/api/admin/run-maintenance" label="Run maintenance" variant="tertiary" />
        </div>
      </SettingsSection>
    </form>
  );
}

export function CompanySection({ value, onChange }: SettingsSectionProps) {
  const timeZoneOptions = useMemo(() => getTimeZoneOptions(value.timeZone), [value.timeZone]);
  const update = (path: string, next: unknown) => onChange(updateSettingsPath(value, path, next));
  const recorderAliasEmailsText = value.recorderAliasEmails.join("\n");
  return (
    <SettingsSection title="Organization" description="Tenant identity and the recorder mailbox that receives Teams invites.">
      <div className="setupFieldGrid twoColumn">
        <TextField label="Company name" value={value.companyName} width="wide" onChange={(v) => update("companyName", v)} />
        <TimeZoneField value={value.timeZone} options={timeZoneOptions} onChange={(v) => update("timeZone", v)} />
        <TextField label="Recorder email" value={value.recorderEmail} width="medium" onChange={(v) => update("recorderEmail", v)} />
      </div>
      <ListTextField
        label="Recorder aliases"
        help="Invite aliases that route to the recorder mailbox. One email per line, or comma-separated."
        emptyText="No aliases configured"
        items={value.recorderAliasEmails}
        text={recorderAliasEmailsText}
        onChange={(v) => update("recorderAliasEmails", parseEmailList(v))}
      />
    </SettingsSection>
  );
}

export function DomainsPolicySection({ value, onChange }: SettingsSectionProps) {
  const update = (path: string, next: unknown) => onChange(updateSettingsPath(value, path, next));
  const allowedDomainsText = value.allowedDomains.join("\n");
  return (
    <SettingsSection title="Domains & Policy" description="Defines who can trigger notes and receive recaps.">
      <ListTextField
        label="Allowed domains"
        help="Enter one domain per line, or separate domains with commas."
        emptyText="No domains parsed"
        items={value.allowedDomains}
        text={allowedDomainsText}
        onChange={(v) => update("allowedDomains", parseAllowedDomains(v))}
      />
      <div className="toggleList">
        <FixedPolicyRow
          label="Send recaps to allowed domains only"
          description="Recaps never leave the allowed domain list. This is a product invariant."
          state="Always on"
        />
        <FixedPolicyRow
          label="Send recaps to external attendees"
          description="External attendees never receive recap emails. This is a product invariant."
          state="Always off"
        />
        <ToggleRow
          checked={value.policy.allowSubdomains}
          description="Allow addresses like user@team.company.com under allowed domains."
          label="Allow subdomains"
          onChange={(v) => update("policy.allowSubdomains", v)}
        />
        <ToggleRow
          checked={value.policy.rejectExternalOrganizers}
          description="Ignore meetings created by organizers outside allowed domains."
          label="Block external organizers"
          onChange={(v) => update("policy.rejectExternalOrganizers", v)}
        />
        <ToggleRow
          checked={value.policy.requireAtLeastOneEligibleRecipient}
          description="Skip meetings with no recipient who matches policy."
          label="Require eligible recipient"
          onChange={(v) => update("policy.requireAtLeastOneEligibleRecipient", v)}
        />
        <ToggleRow
          checked={value.policy.requireAuthenticatedSender}
          description="Reject inbound invites whose sender fails SPF, DKIM, or DMARC verification."
          label="Require authenticated sender (SPF/DKIM/DMARC)"
          onChange={(v) => update("policy.requireAuthenticatedSender", v)}
        />
      </div>
      <SelectField
        label="Recap distribution"
        value={value.policy.distribution}
        options={["all_eligible", "organizer_only"]}
        width="medium"
        onChange={(v) => update("policy.distribution", v)}
      />
    </SettingsSection>
  );
}

export function BotSection({
  value,
  onChange,
  onBotImageUpload
}: SettingsSectionProps & { onBotImageUpload?: (file: File) => Promise<void> }) {
  const update = (path: string, next: unknown) => onChange(updateSettingsPath(value, path, next));
  return (
    <SettingsSection title="Meeting Bot" description="Controls how the notetaker appears and joins Teams meetings.">
      <div className="setupFieldGrid twoColumn">
        <TextField label="Bot display name" value={value.bot.displayName} width="medium" onChange={(v) => update("bot.displayName", v)} />
        <BotImageField value={value} onUpload={onBotImageUpload} />
      </div>
      <div className="compactSettingRows">
        <NumberWithUnit label="Join meeting early" unit="minutes" min={0} max={60} value={value.bot.joinLeadMinutes} onChange={(v) => update("bot.joinLeadMinutes", v)} />
        <NumberWithUnit label="Waiting room timeout" unit="minutes" min={1} max={240} value={value.bot.maxWaitingRoomMinutes} onChange={(v) => update("bot.maxWaitingRoomMinutes", v)} />
        <NumberWithUnit label="Max meeting duration" unit="minutes" min={15} max={720} value={value.bot.maxMeetingDurationMinutes} onChange={(v) => update("bot.maxMeetingDurationMinutes", v)} />
        <NumberWithUnit label="Max join attempts" unit="attempts" min={1} max={5} value={value.bot.maxJoinAttempts} onChange={(v) => update("bot.maxJoinAttempts", v)} />
      </div>
    </SettingsSection>
  );
}

export function TranscriptionSection({ value, onChange }: SettingsSectionProps) {
  const update = (path: string, next: unknown) => onChange(updateSettingsPath(value, path, next));
  return (
    <SettingsSection
      title="Transcription"
      description="Speech-to-text provider used after recordings upload."
      status={<StatusPill tone={configuredTone(value.transcription.apiKeyConfigured)}>{keyConfiguredLabel(value.transcription.apiKeyConfigured)}</StatusPill>}
    >
      <div className="setupFieldGrid twoColumn">
        <SelectField label="Provider" value={value.transcription.provider} options={["openai-whisper", "whisper-compatible"]} width="medium" onChange={(v) => update("transcription.provider", v)} />
        <TextField label="Model" value={value.transcription.model} width="medium" onChange={(v) => update("transcription.model", v)} />
        <TextField label="Base URL" value={value.transcription.baseUrl ?? ""} width="url" onChange={(v) => update("transcription.baseUrl", v)} />
        <TextField label="Language (optional)" value={value.transcription.language ?? ""} width="medium" placeholder="auto-detect" onChange={(v) => update("transcription.language", v)} />
      </div>
      <span className="fieldHelp">API key is supplied via <code>wrangler secret put TRANSCRIPTION_API_KEY</code> (falls back to OPENAI_API_KEY).</span>
    </SettingsSection>
  );
}

export function RecapSection({ value, onChange }: SettingsSectionProps) {
  const update = (path: string, next: unknown) => onChange(updateSettingsPath(value, path, next));
  return (
    <SettingsSection
      title="Recap Generation"
      description="LLM provider settings for recap summaries and the recap email framing."
      status={<StatusPill tone={configuredTone(value.recap.apiKeyConfigured)}>{keyConfiguredLabel(value.recap.apiKeyConfigured)}</StatusPill>}
    >
      <div className="setupFieldGrid twoColumn">
        <TextField label="Model" value={value.recap.model} width="medium" onChange={(v) => update("recap.model", v)} />
        <TextField label="Base URL" value={value.recap.baseUrl ?? ""} width="url" onChange={(v) => update("recap.baseUrl", v)} />
        <TextField label="Subject prefix" value={value.recap.subjectPrefix} width="medium" onChange={(v) => update("recap.subjectPrefix", v)} />
      </div>
      <label className="setupField fieldWidth-wide">
        <span>Intro text (optional)</span>
        <textarea rows={3} value={value.recap.introText ?? ""} onChange={(event) => update("recap.introText", event.target.value)} />
      </label>
      <div className="inlineActions">
        <TestActionButton path="/api/admin/test-ai" label="Test AI connection" variant="secondary" />
      </div>
    </SettingsSection>
  );
}

export function EmailSection({ value, onChange }: SettingsSectionProps) {
  const update = (path: string, next: unknown) => onChange(updateSettingsPath(value, path, next));
  return (
    <SettingsSection title="Email Delivery" description="Outbound recap delivery provider and sender identity.">
      <div className="setupFieldGrid twoColumn">
        <SelectField label="Provider" value={value.email.provider} options={["cloudflare-email-service", "mock"]} width="medium" onChange={(v) => update("email.provider", v)} />
        <TextField label="Sender display name" value={value.email.senderName} width="medium" onChange={(v) => update("email.senderName", v)} />
        <TextField label="Sender email" value={value.email.senderEmail} width="medium" onChange={(v) => update("email.senderEmail", v)} />
        <TextField label="Test recipient" value={value.email.testRecipient ?? ""} width="medium" onChange={(v) => update("email.testRecipient", v)} />
      </div>
      <span className="fieldHelp">Save settings before sending a test — the test uses the saved test recipient.</span>
      <div className="inlineActions">
        <TestActionButton path="/api/admin/test-email" label="Send test email" variant="secondary" />
      </div>
    </SettingsSection>
  );
}

export function SchedulingSection({ value, onChange }: SettingsSectionProps) {
  const update = (path: string, next: unknown) => onChange(updateSettingsPath(value, path, next));
  return (
    <SettingsSection title="Scheduling" description="Recurrence expansion window and stale-session recovery.">
      <div className="compactSettingRows">
        <NumberWithUnit label="Recurrence expansion window" unit="days" min={7} max={365} value={value.scheduling.recurrenceExpansionDays} onChange={(v) => update("scheduling.recurrenceExpansionDays", v)} />
        <NumberWithUnit label="Stale session threshold" unit="minutes" min={2} max={120} value={value.scheduling.staleSessionMinutes} onChange={(v) => update("scheduling.staleSessionMinutes", v)} />
      </div>
    </SettingsSection>
  );
}

export function RetentionSection({ value, onChange }: SettingsSectionProps) {
  const update = (path: string, next: unknown) => onChange(updateSettingsPath(value, path, next));
  return (
    <SettingsSection title="Retention" description="How long each data type is stored before cleanup.">
      <div className="retentionTable" role="group" aria-label="Retention settings">
        <div className="retentionHeader">
          <span>Data type</span>
          <span>Retain for</span>
        </div>
        <NumberWithUnit label="Raw invites" unit="days" min={1} max={3650} value={value.retention.rawInviteDays} onChange={(v) => update("retention.rawInviteDays", v)} />
        <NumberWithUnit label="Recordings" unit="days" min={1} max={3650} value={value.retention.recordingDays} onChange={(v) => update("retention.recordingDays", v)} />
        <NumberWithUnit label="Transcripts" unit="days" min={1} max={3650} value={value.retention.transcriptDays} onChange={(v) => update("retention.transcriptDays", v)} />
        <NumberWithUnit label="Summaries" unit="days" min={1} max={3650} value={value.retention.summaryDays} onChange={(v) => update("retention.summaryDays", v)} />
        <NumberWithUnit label="Audit logs" unit="days" min={1} max={3650} value={value.retention.auditLogDays} onChange={(v) => update("retention.auditLogDays", v)} />
        <NumberWithUnit label="Diagnostics" unit="days" min={1} max={3650} value={value.retention.diagnosticsDays} onChange={(v) => update("retention.diagnosticsDays", v)} />
      </div>
    </SettingsSection>
  );
}

export function SecretsSection({ secrets }: { secrets: SettingsView["secrets"] }) {
  const rows: Array<{ label: string; secretName: string; configured: boolean }> = [
    { label: "AI API key", secretName: "OPENAI_API_KEY", configured: secrets.aiKeyConfigured },
    { label: "Transcription API key", secretName: "TRANSCRIPTION_API_KEY", configured: secrets.transcriptionKeyConfigured },
    { label: "Bot internal token", secretName: "BOT_INTERNAL_TOKEN", configured: secrets.botInternalTokenConfigured },
    { label: "Session secret", secretName: "SESSION_SECRET", configured: secrets.sessionSecretConfigured }
  ];
  return (
    <SettingsSection title="Secrets" description="Secret values never leave the worker — only presence is reported. Set them with wrangler." secondary>
      <div className="secretRows">
        {rows.map((row) => (
          <div className="secretStatusRow" key={row.secretName}>
            <span>{row.label}</span>
            <code>wrangler secret put {row.secretName}</code>
            <StatusPill tone={configuredTone(row.configured)}>{keyConfiguredLabel(row.configured)}</StatusPill>
          </div>
        ))}
      </div>
    </SettingsSection>
  );
}

export function parseAllowedDomains(value: string): string[] {
  return parseDelimitedList(value);
}

export function parseEmailList(value: string): string[] {
  return parseDelimitedList(value);
}

export function resolveListTextDraft(formattedValue: string, draftValue: string, parsedValues: string[]): string {
  return listsMatch(parseDelimitedList(draftValue), parsedValues) ? draftValue : formattedValue;
}

function parseDelimitedList(value: string): string[] {
  return value
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function listsMatch(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

export function getTimeZoneOptions(currentTimeZone: string): string[] {
  const supportedValuesOf = (Intl as typeof Intl & { supportedValuesOf?: (key: "timeZone") => string[] }).supportedValuesOf;
  const options = supportedValuesOf ? supportedValuesOf("timeZone") : fallbackTimeZones;
  return Array.from(new Set(["UTC", currentTimeZone, ...options])).sort((a, b) => a.localeCompare(b));
}

export function keyConfiguredLabel(configured: boolean): "Configured" | "Missing" {
  return configured ? "Configured" : "Missing";
}

function configuredTone(configured: boolean): "good" | "bad" {
  return configured ? "good" : "bad";
}

function SettingsSection({
  children,
  description,
  secondary = false,
  status,
  title
}: {
  children: ReactNode;
  description: string;
  secondary?: boolean;
  status?: ReactNode;
  title: string;
}) {
  return (
    <section className={secondary ? "setupPanel setupPanelSecondary" : "setupPanel"}>
      <div className="setupPanelHeader">
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        {status}
      </div>
      <div className="setupPanelBody">{children}</div>
    </section>
  );
}

function TextField({
  label,
  placeholder,
  value,
  width = "medium",
  onChange
}: {
  label: string;
  placeholder?: string;
  value: string;
  width?: "medium" | "wide" | "url";
  onChange: (value: string) => void;
}) {
  return (
    <label className={`setupField fieldWidth-${width}`}>
      <span>{label}</span>
      <input placeholder={placeholder} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function TimeZoneField({
  value,
  options,
  onChange
}: {
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const interval = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  return (
    <label className="setupField timeZoneField fieldWidth-medium">
      <span>Time zone</span>
      <div className="timeZoneControl">
        <select value={value} onChange={(event) => onChange(event.target.value)}>
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        <span className="currentTime" aria-live="polite">
          {formatCurrentTime(now, value)}
        </span>
      </div>
    </label>
  );
}

function ListTextField({
  label,
  help,
  emptyText,
  items,
  text,
  onChange
}: {
  label: string;
  help: string;
  emptyText: string;
  items: string[];
  text: string;
  onChange: (value: string) => void;
}) {
  const [draftValue, setDraftValue] = useState(text);
  const displayValue = resolveListTextDraft(text, draftValue, items);

  useEffect(() => {
    setDraftValue((current) => resolveListTextDraft(text, current, items));
  }, [items, text]);

  return (
    <div className="allowedDomainsControl">
      <label className="setupField fieldWidth-domains">
        <span>{label}</span>
        <textarea
          rows={3}
          value={displayValue}
          onBlur={() => setDraftValue(text)}
          onChange={(event) => {
            setDraftValue(event.target.value);
            onChange(event.target.value);
          }}
        />
      </label>
      <span className="fieldHelp">{help}</span>
      <div className="domainChips" aria-label={`Parsed ${label.toLowerCase()}`}>
        {items.length > 0 ? items.map((item) => <span key={item}>{item}</span>) : <span className="emptyChip">{emptyText}</span>}
      </div>
    </div>
  );
}

function NumberWithUnit({ label, max, min, unit, value, onChange }: { label: string; max: number; min: number; unit: string; value: number; onChange: (value: number) => void }) {
  return (
    <label className="numberUnitRow">
      <span>{label}</span>
      <span className="numberUnitControl">
        <input
          type="number"
          min={min}
          max={max}
          step={1}
          value={value}
          onChange={(event) => {
            const next = Number(event.target.value);
            onChange(Number.isNaN(next) ? value : next);
          }}
        />
        <span>{unit}</span>
      </span>
    </label>
  );
}

function ToggleRow({
  checked,
  description,
  label,
  onChange
}: {
  checked: boolean;
  description: string;
  label: string;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="toggleRow">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className="toggleSwitch" aria-hidden="true" />
      <span className="toggleText">
        <strong>{label}</strong>
        <span>{description}</span>
      </span>
    </label>
  );
}

/** Product invariants render as locked rows instead of toggles. */
function FixedPolicyRow({ label, description, state }: { label: string; description: string; state: "Always on" | "Always off" }) {
  return (
    <label className="toggleRow" aria-disabled="true">
      <input type="checkbox" checked={state === "Always on"} disabled readOnly />
      <span className="toggleSwitch" aria-hidden="true" />
      <span className="toggleText">
        <strong>{label} <span className="badge neutral">{state}</span></strong>
        <span>{description}</span>
      </span>
    </label>
  );
}

function BotImageField({ value, onUpload }: { value: AppSettings; onUpload?: (file: File) => Promise<void> }) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const botImage = value.bot.image;

  return (
    <label className="setupField fieldWidth-wide">
      <span>Bot background image</span>
      <input
        accept="image/*"
        disabled={!onUpload || uploading}
        type="file"
        onChange={async (event) => {
          const file = event.target.files?.[0];
          if (!file || !onUpload) return;
          setUploading(true);
          setError("");
          try {
            await onUpload(file);
            event.target.value = "";
          } catch (uploadError) {
            setError(uploadError instanceof Error ? uploadError.message : "Upload failed");
          } finally {
            setUploading(false);
          }
        }}
      />
      <span className="fieldHelp">
        {uploading ? "Optimizing..." : botImage ? `${botImage.fileName ?? "Uploaded image"} will be sent with new Teams bots.` : "Upload an image file. It will be optimized as a crisp 16:9 video background."}
      </span>
      {error && <span className="fieldError">{error}</span>}
    </label>
  );
}

function SelectField({
  label,
  value,
  options,
  width = "medium",
  onChange
}: {
  label: string;
  value: string;
  options: string[];
  width?: "medium" | "wide";
  onChange: (value: string) => void;
}) {
  return (
    <label className={`setupField fieldWidth-${width}`}>
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

function StatusPill({ children, tone }: { children: ReactNode; tone: "good" | "bad" | "neutral" | "warning" }) {
  return <span className={`setupStatusPill ${tone}`}>{children}</span>;
}

function formatCurrentTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZone,
    timeZoneName: "short"
  }).format(date);
}

const fallbackTimeZones = [
  "UTC",
  "America/Detroit",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Phoenix",
  "America/Anchorage",
  "Pacific/Honolulu",
  "Europe/London",
  "Europe/Paris",
  "Asia/Tokyo",
  "Australia/Sydney"
];
