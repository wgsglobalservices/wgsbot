import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { defaultSampleRecapRecipient, type AppSettings } from "@minutesbot/shared";
import { apiPost } from "../lib/api";
import { TestActionButton } from "./TestActionButton";

export function SettingsForm({
  value,
  onBotImageUpload,
  onChange
}: {
  value: AppSettings;
  onBotImageUpload?: (file: File) => Promise<void>;
  onChange: (settings: AppSettings) => void;
}) {
  const timeZoneOptions = useMemo(() => getTimeZoneOptions(value.timeZone), [value.timeZone]);
  const update = (path: string, next: unknown) => {
    const clone = structuredClone(value) as AppSettings;
    const parts = path.split(".");
    let target: Record<string, unknown> = clone as unknown as Record<string, unknown>;
    for (const part of parts.slice(0, -1)) target = target[part] as Record<string, unknown>;
    target[parts.at(-1)!] = next;
    onChange(clone);
  };

  const allowedDomainsText = value.allowedDomains.join("\n");
  const recorderAliasEmailsText = value.recorderAliasEmails.join("\n");

  return (
    <form className="setupForm">
      <SettingsSection title="Organization" description="Basic tenant identity and allowed recipient domains.">
        <div className="setupFieldGrid twoColumn">
          <TextField label="Company name" value={value.companyName} width="wide" onChange={(v) => update("companyName", v)} />
          <TextField label="Primary domain" value={value.primaryDomain} width="medium" onChange={(v) => update("primaryDomain", v)} />
          <TimeZoneField value={value.timeZone} options={timeZoneOptions} onChange={(v) => update("timeZone", v)} />
        </div>
        <AllowedDomainsField value={allowedDomainsText} domains={value.allowedDomains} onChange={(v) => update("allowedDomains", parseAllowedDomains(v))} />
      </SettingsSection>

      <SettingsSection title="Meeting Bot" description="Controls how the notetaker appears and joins meetings.">
        <div className="setupFieldGrid twoColumn">
          <TextField label="Notetaker email" value={value.recorderEmail} width="medium" onChange={(v) => update("recorderEmail", v)} />
          <TextField label="Bot display name" value={value.attendee.botName} width="medium" onChange={(v) => update("attendee.botName", v)} />
          <BotImageField value={value} onUpload={onBotImageUpload} />
        </div>
        <EmailAliasesField value={recorderAliasEmailsText} emails={value.recorderAliasEmails} onChange={(v) => update("recorderAliasEmails", parseEmailList(v))} />
        <div className="compactSettingRows">
          <NumberWithUnit label="Join meeting early" unit="minutes" value={value.attendee.createBotMinutesBeforeStart} onChange={(v) => update("attendee.createBotMinutesBeforeStart", v)} />
          <NumberWithUnit label="Waiting room timeout" unit="minutes" value={value.attendee.maxWaitingRoomMinutes} onChange={(v) => update("attendee.maxWaitingRoomMinutes", v)} />
        </div>
      </SettingsSection>

      <SettingsSection
        title="Meeting Bot Runtime"
        description="The first-party Teams recording runtime is deployed with minutesbot."
        status={<StatusPill tone="good">Built in</StatusPill>}
      >
        <div className="runtimeStatusRow">
          <span>Runtime URL</span>
          <code>{value.attendee.baseUrl}</code>
          <StatusPill tone="neutral">Managed</StatusPill>
        </div>
        <ToggleRow
          checked={value.attendee.deleteAttendeeDataAfterTranscriptFetch}
          description="Remove meeting bot runtime data after minutesbot imports the transcript."
          label="Delete bot runtime data after transcript import"
          onChange={(v) => update("attendee.deleteAttendeeDataAfterTranscriptFetch", v)}
        />
        <div className="inlineActions">
          <TestActionButton path="/api/admin/test-bot" label="Test meeting bot connection" variant="secondary" />
        </div>
      </SettingsSection>

      <SettingsSection
        title="AI Provider"
        description="Controls transcript and recap generation provider settings."
        status={<StatusPill tone={configuredTone(value.ai.apiKeyConfigured)}>{configuredLabel(value.ai.apiKeyConfigured)}</StatusPill>}
      >
        <div className="setupFieldGrid aiProviderGrid">
          <SelectField label="Provider" value={value.ai.provider} options={["openai-compatible", "workers-ai"]} width="medium" onChange={(v) => update("ai.provider", v)} />
          <TextField label="Model" value={value.ai.model} width="medium" onChange={(v) => update("ai.model", v)} />
          <TextField label="Base URL" value={value.ai.baseUrl ?? ""} width="url" onChange={(v) => update("ai.baseUrl", v)} />
        </div>
        <div className="inlineActions">
          <TestActionButton path="/api/admin/test-ai" label="Test AI connection" variant="secondary" />
        </div>
      </SettingsSection>

      <SettingsSection title="Email Provider" description="Controls outbound recap delivery and test email actions.">
        <div className="setupFieldGrid twoColumn">
          <SelectField label="Provider" value={value.email.provider} options={["mock", "cloudflare-email-service", "smtp"]} width="medium" onChange={(v) => update("email.provider", v)} />
          <TextField label="Sender display name" value={value.email.senderName} width="medium" onChange={(v) => update("email.senderName", v)} />
          <TextField label="Sender email" value={value.email.senderEmail} width="medium" onChange={(v) => update("email.senderEmail", v)} />
        </div>
        <div className="inlineActions">
          <TestActionButton path="/api/admin/test-email" label="Test outbound email" variant="secondary" />
          <SendSampleRecapEmail initialRecipient={resolveSampleRecapRecipient(value.email.testRecipient)} />
        </div>
      </SettingsSection>

      <SettingsSection title="Eligibility & Policy" description="Defines who can trigger notes and receive summaries.">
        <div className="toggleList">
          <ToggleRow
            checked={value.policy.requireAtLeastOneEligibleRecipient}
            description="Only process meetings with at least one recipient who matches policy."
            label="Require eligible recipient"
            onChange={(v) => update("policy.requireAtLeastOneEligibleRecipient", v)}
          />
          <ToggleRow
            checked={value.policy.rejectExternalOrganizers}
            description="Ignore meetings created by organizers outside allowed domains."
            label="Block external organizers"
            onChange={(v) => update("policy.rejectExternalOrganizers", v)}
          />
          <ToggleRow
            checked={value.policy.allowSubdomains}
            description="Allow addresses like user@team.company.com."
            label="Allow subdomains"
            onChange={(v) => update("policy.allowSubdomains", v)}
          />
        </div>
      </SettingsSection>

      <SettingsSection title="Retention" description="How long different data types are stored.">
        <div className="retentionTable" role="group" aria-label="Retention settings">
          <div className="retentionHeader">
            <span>Data type</span>
            <span>Retain for</span>
          </div>
          <NumberWithUnit label="Raw invites" unit="days" value={value.retention.rawInviteDays} onChange={(v) => update("retention.rawInviteDays", v)} />
          <NumberWithUnit label="Transcripts" unit="days" value={value.retention.transcriptDays} onChange={(v) => update("retention.transcriptDays", v)} />
          <NumberWithUnit label="Summaries" unit="days" value={value.retention.summaryDays} onChange={(v) => update("retention.summaryDays", v)} />
          <NumberWithUnit label="Audit logs" unit="days" value={value.retention.auditLogDays} onChange={(v) => update("retention.auditLogDays", v)} />
          <NumberWithUnit label="Transcript link expiration" unit="hours" value={value.recap.transcriptDownloadExpirationHours} onChange={(v) => update("recap.transcriptDownloadExpirationHours", v)} />
        </div>
      </SettingsSection>

      <SettingsSection title="Diagnostics" description="Run secondary checks against the current saved configuration." secondary>
        <div className="diagnosticActions">
          <TestActionButton path="/api/admin/test-d1" label="Test D1" variant="tertiary" />
          <TestActionButton path="/api/admin/test-r2" label="Test R2" variant="tertiary" />
          <TestActionButton path="/api/admin/parse-sample-invite" label="Parse sample invite" variant="tertiary" />
        </div>
      </SettingsSection>
    </form>
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

export function configuredLabel(configured: boolean): "Configured" | "Missing" {
  return configured ? "Configured" : "Missing";
}

export function resolveSampleRecapRecipient(value: string | undefined): string {
  return value ?? defaultSampleRecapRecipient;
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
  value,
  width = "medium",
  onChange
}: {
  label: string;
  value: string;
  width?: "medium" | "wide" | "url";
  onChange: (value: string) => void;
}) {
  return (
    <label className={`setupField fieldWidth-${width}`}>
      <span>{label}</span>
      <input value={value} onChange={(event) => onChange(event.target.value)} />
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

function AllowedDomainsField({
  domains,
  value,
  onChange
}: {
  domains: string[];
  value: string;
  onChange: (value: string) => void;
}) {
  const [draftValue, setDraftValue] = useState(value);
  const displayValue = resolveListTextDraft(value, draftValue, domains);

  useEffect(() => {
    setDraftValue((current) => resolveListTextDraft(value, current, domains));
  }, [domains, value]);

  return (
    <div className="allowedDomainsControl">
      <label className="setupField fieldWidth-domains">
        <span>Allowed domains</span>
        <textarea
          rows={3}
          value={displayValue}
          onBlur={() => setDraftValue(value)}
          onChange={(event) => {
            setDraftValue(event.target.value);
            onChange(event.target.value);
          }}
        />
      </label>
      <span className="fieldHelp">Enter one domain per line, or separate domains with commas.</span>
      <div className="domainChips" aria-label="Parsed allowed domains">
        {domains.length > 0 ? domains.map((domain) => <span key={domain}>{domain}</span>) : <span className="emptyChip">No domains parsed</span>}
      </div>
    </div>
  );
}

function EmailAliasesField({
  emails,
  value,
  onChange
}: {
  emails: string[];
  value: string;
  onChange: (value: string) => void;
}) {
  const [draftValue, setDraftValue] = useState(value);
  const displayValue = resolveListTextDraft(value, draftValue, emails);

  useEffect(() => {
    setDraftValue((current) => resolveListTextDraft(value, current, emails));
  }, [emails, value]);

  return (
    <div className="allowedDomainsControl">
      <label className="setupField fieldWidth-domains">
        <span>Notetaker aliases</span>
        <textarea
          rows={3}
          value={displayValue}
          onBlur={() => setDraftValue(value)}
          onChange={(event) => {
            setDraftValue(event.target.value);
            onChange(event.target.value);
          }}
        />
      </label>
      <span className="fieldHelp">Invite aliases that route to the notetaker mailbox. Enter one email per line, or separate emails with commas.</span>
      <div className="domainChips" aria-label="Parsed notetaker aliases">
        {emails.length > 0 ? emails.map((email) => <span key={email}>{email}</span>) : <span className="emptyChip">No aliases configured</span>}
      </div>
    </div>
  );
}

function NumberWithUnit({ label, unit, value, onChange }: { label: string; unit: string; value: number; onChange: (value: number) => void }) {
  return (
    <label className="numberUnitRow">
      <span>{label}</span>
      <span className="numberUnitControl">
        <input type="number" value={value} onChange={(event) => onChange(Number(event.target.value))} />
        <span>{unit}</span>
      </span>
    </label>
  );
}

function SendSampleRecapEmail({ initialRecipient }: { initialRecipient: string }) {
  const [recipient, setRecipient] = useState(initialRecipient);
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setRecipient(initialRecipient);
  }, [initialRecipient]);

  return (
    <div className="testAction sampleRecapEmailAction">
      <label className="setupField fieldWidth-medium">
        <span>Sample recap recipient</span>
        <input type="email" value={recipient} onChange={(event) => setRecipient(event.target.value)} />
      </label>
      <button
        className="secondaryButton"
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const response = await apiPost<unknown>("/api/admin/send-test-summary-email", { to: recipient });
            setResult(JSON.stringify(response, null, 2));
          } catch (error) {
            setResult(error instanceof Error ? error.message : "Failed");
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Sending..." : "Send sample recap"}
      </button>
      {result && <pre>{result}</pre>}
    </div>
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

function BotImageField({ value, onUpload }: { value: AppSettings; onUpload?: (file: File) => Promise<void> }) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const botImage = value.attendee.botImage;

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
