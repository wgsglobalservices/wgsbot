import { useEffect, useMemo, useState } from "react";
import type { AppSettings } from "@minutesbot/shared";

export function SettingsForm({ value, onChange }: { value: AppSettings; onChange: (settings: AppSettings) => void }) {
  const timeZoneOptions = useMemo(() => getTimeZoneOptions(value.timeZone), [value.timeZone]);
  const update = (path: string, next: unknown) => {
    const clone = structuredClone(value) as AppSettings;
    const parts = path.split(".");
    let target: Record<string, unknown> = clone as unknown as Record<string, unknown>;
    for (const part of parts.slice(0, -1)) target = target[part] as Record<string, unknown>;
    target[parts.at(-1)!] = next;
    onChange(clone);
  };

  return (
    <form className="formGrid">
      <Field label="Company name" value={value.companyName} onChange={(v) => update("companyName", v)} />
      <Field label="Primary domain" value={value.primaryDomain} onChange={(v) => update("primaryDomain", v)} />
      <TimeZoneField value={value.timeZone} options={timeZoneOptions} onChange={(v) => update("timeZone", v)} />
      <TextAreaField
        className="allowedDomainsField"
        help="Enter one domain per line, or separate domains with commas."
        label="Allowed domains"
        value={value.allowedDomains.join("\n")}
        onChange={(v) => update("allowedDomains", parseAllowedDomains(v))}
      />
      <Field label="Recorder email" value={value.recorderEmail} onChange={(v) => update("recorderEmail", v)} />
      <Field label="Attendee base URL" value={value.attendee.baseUrl} onChange={(v) => update("attendee.baseUrl", v)} />
      <ReadOnly label="Attendee API key" value={value.attendee.apiKeyConfigured ? "Configured" : "Missing"} />
      <ReadOnly label="Attendee webhook secret" value={value.attendee.webhookSecretConfigured ? "Configured" : "Missing"} />
      <Field label="Bot display name" value={value.attendee.botName} onChange={(v) => update("attendee.botName", v)} />
      <NumberField label="Create bot minutes before start" value={value.attendee.createBotMinutesBeforeStart} onChange={(v) => update("attendee.createBotMinutesBeforeStart", v)} />
      <NumberField label="Max waiting room minutes" value={value.attendee.maxWaitingRoomMinutes} onChange={(v) => update("attendee.maxWaitingRoomMinutes", v)} />
      <Checkbox label="Delete Attendee data after transcript fetch" checked={value.attendee.deleteAttendeeDataAfterTranscriptFetch} onChange={(v) => update("attendee.deleteAttendeeDataAfterTranscriptFetch", v)} />
      <Select label="AI provider" value={value.ai.provider} options={["openai-compatible", "workers-ai"]} onChange={(v) => update("ai.provider", v)} />
      <Field label="AI base URL" value={value.ai.baseUrl ?? ""} onChange={(v) => update("ai.baseUrl", v)} />
      <Field label="AI model" value={value.ai.model} onChange={(v) => update("ai.model", v)} />
      <Select label="Email provider" value={value.email.provider} options={["mock", "cloudflare-email-service", "smtp"]} onChange={(v) => update("email.provider", v)} />
      <Field label="Sender email" value={value.email.senderEmail} onChange={(v) => update("email.senderEmail", v)} />
      <Checkbox label="Allow subdomains" checked={value.policy.allowSubdomains} onChange={(v) => update("policy.allowSubdomains", v)} />
      <Checkbox label="Reject external organizers" checked={value.policy.rejectExternalOrganizers} onChange={(v) => update("policy.rejectExternalOrganizers", v)} />
      <Checkbox label="Require eligible recipient" checked={value.policy.requireAtLeastOneEligibleRecipient} onChange={(v) => update("policy.requireAtLeastOneEligibleRecipient", v)} />
      <NumberField label="Raw invite retention days" value={value.retention.rawInviteDays} onChange={(v) => update("retention.rawInviteDays", v)} />
      <NumberField label="Transcript retention days" value={value.retention.transcriptDays} onChange={(v) => update("retention.transcriptDays", v)} />
      <NumberField label="Summary retention days" value={value.retention.summaryDays} onChange={(v) => update("retention.summaryDays", v)} />
      <NumberField label="Audit log retention days" value={value.retention.auditLogDays} onChange={(v) => update("retention.auditLogDays", v)} />
    </form>
  );
}

export function parseAllowedDomains(value: string): string[] {
  return value
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function getTimeZoneOptions(currentTimeZone: string): string[] {
  const supportedValuesOf = (Intl as typeof Intl & { supportedValuesOf?: (key: "timeZone") => string[] }).supportedValuesOf;
  const options = supportedValuesOf ? supportedValuesOf("timeZone") : fallbackTimeZones;
  return Array.from(new Set(["UTC", currentTimeZone, ...options])).sort((a, b) => a.localeCompare(b));
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label>
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
    <label className="timeZoneField">
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

function TextAreaField({
  className,
  help,
  label,
  value,
  onChange
}: {
  className?: string;
  help?: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className={className}>
      <span>{label}</span>
      <textarea rows={4} value={value} onChange={(event) => onChange(event.target.value)} />
      {help && <span className="fieldHelp">{help}</span>}
    </label>
  );
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <label>
      <span>{label}</span>
      <input type="number" value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

function Checkbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function ReadOnly({ label, value }: { label: string; value: string }) {
  return (
    <label>
      <span>{label}</span>
      <input value={value} readOnly />
    </label>
  );
}

function Select({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (value: string) => void }) {
  return (
    <label>
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
