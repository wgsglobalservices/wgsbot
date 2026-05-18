import { useEffect, useState } from "react";
import { defaultSampleRecapRecipient, type AppSettings } from "@minutesbot/shared";
import { RecapForm } from "../components/RecapForm";
import { ApiError, apiPost, getSettings, saveSettings } from "../lib/api";

type UploadedTranscriptRecapFormState = {
  recipient: string;
  subject: string;
  meetingStartTime: string;
  organizerEmail: string;
  organizerName: string;
  transcriptText: string;
};

type RecapProps = {
  initialSettings?: AppSettings;
  saveSettingsOverride?: (settings: AppSettings) => Promise<AppSettings>;
};

export function Recap(props: RecapProps = {}) {
  const { initialSettings, saveSettingsOverride } = props;
  const [settings, setSettings] = useState<AppSettings | null>(initialSettings ?? null);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [authNotConfigured, setAuthNotConfigured] = useState(false);

  useEffect(() => {
    if (initialSettings) return;
    getSettings()
      .then(setSettings)
      .catch((error) => {
        if (error instanceof ApiError && error.code === "AUTH_NOT_CONFIGURED") setAuthNotConfigured(true);
        setMessage(error instanceof Error ? error.message : "Failed to load recap settings.");
      });
  }, []);

  if (authNotConfigured) {
    return (
      <div className="page">
        <header>
          <h1>Recap blocked</h1>
          <p>Configure the admin session secret before using protected recap routes.</p>
        </header>
        <section className="noticePanel">
          <h2>SESSION_SECRET is missing</h2>
          <p>{message}</p>
          <pre>wrangler secret put SESSION_SECRET</pre>
        </section>
      </div>
    );
  }

  if (!settings) return <p>{message || "Loading recap settings..."}</p>;
  const handleSave = async () => {
    setSaving(true);
    setMessage("Saving...");
    const result = await saveRecapSettings(settings, saveSettingsOverride ?? saveSettings);
    setSettings(result.settings);
    setMessage(result.message);
    setSaving(false);
  };
  return (
    <div className="page">
      <header>
        <h1>Recap templates</h1>
        <p>Configure transcription, automatic meeting classification, AI recap prompts, and the layout of recap emails sent after meetings.</p>
      </header>
      <UploadedTranscriptRecapTest initialRecipient={settings.email.testRecipient || defaultSampleRecapRecipient} />
      <RecapForm value={settings.recap} onChange={(recap) => setSettings({ ...settings, recap })} onSave={handleSave} saving={saving} />
      {message && <span className="fieldHelp">{message}</span>}
    </div>
  );
}

export async function saveRecapSettings(
  settings: AppSettings,
  save: (settings: AppSettings) => Promise<AppSettings> = saveSettings
): Promise<{ settings: AppSettings; message: string }> {
  try {
    return { settings: await save(settings), message: "Saved" };
  } catch (error) {
    return {
      settings,
      message: error instanceof Error ? error.message : "Save failed"
    };
  }
}

export function buildUploadedTranscriptRecapPayload(input: UploadedTranscriptRecapFormState) {
  return {
    recipient: input.recipient.trim().toLowerCase(),
    subject: input.subject.trim(),
    meetingStartTime: toApiMeetingStartTime(input.meetingStartTime),
    organizerEmail: input.organizerEmail.trim().toLowerCase(),
    organizerName: input.organizerName.trim(),
    transcriptText: input.transcriptText.trim()
  };
}

export function toApiMeetingStartTime(value: string): string {
  const trimmed = value.trim();
  return trimmed ? new Date(trimmed).toISOString() : "";
}

export async function fileToTranscriptText(file: File): Promise<string> {
  return file.text();
}

function defaultMeetingStartTime(): string {
  const now = new Date();
  now.setSeconds(0, 0);
  const offsetMs = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offsetMs).toISOString().slice(0, 16);
}

function UploadedTranscriptRecapTest({ initialRecipient }: { initialRecipient: string }) {
  const [form, setForm] = useState<UploadedTranscriptRecapFormState>({
    recipient: initialRecipient,
    subject: "",
    meetingStartTime: defaultMeetingStartTime(),
    organizerEmail: "",
    organizerName: "",
    transcriptText: ""
  });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  const [meetingId, setMeetingId] = useState("");

  const update = <K extends keyof UploadedTranscriptRecapFormState>(key: K, value: UploadedTranscriptRecapFormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  return (
    <section className="recapCard uploadedTranscriptRecapTest">
      <div className="sectionHeader">
        <h2>Test recap from transcript</h2>
      </div>
      <div className="uploadedTranscriptGrid">
        <label className="setupField">
          <span>Recipient</span>
          <input type="email" value={form.recipient} onChange={(event) => update("recipient", event.target.value)} />
        </label>
        <label className="setupField">
          <span>Subject</span>
          <input value={form.subject} onChange={(event) => update("subject", event.target.value)} />
        </label>
        <label className="setupField">
          <span>Meeting start</span>
          <input type="datetime-local" value={form.meetingStartTime} onChange={(event) => update("meetingStartTime", event.target.value)} />
        </label>
        <label className="setupField">
          <span>Organizer email</span>
          <input type="email" value={form.organizerEmail} onChange={(event) => update("organizerEmail", event.target.value)} />
        </label>
        <label className="setupField">
          <span>Organizer name</span>
          <input value={form.organizerName} onChange={(event) => update("organizerName", event.target.value)} />
        </label>
        <label className="setupField">
          <span>Upload transcript</span>
          <input
            type="file"
            accept=".txt,.vtt,.srt,text/plain,text/vtt"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (file) update("transcriptText", await fileToTranscriptText(file));
            }}
          />
        </label>
      </div>
      <label className="setupField uploadedTranscriptText">
        <span>Paste transcript</span>
        <textarea rows={8} value={form.transcriptText} onChange={(event) => update("transcriptText", event.target.value)} />
      </label>
      <div className="actions">
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setMeetingId("");
            try {
              const response = await apiPost<{ meetingId?: string }>("/api/admin/test-uploaded-transcript-recap", buildUploadedTranscriptRecapPayload(form));
              setMeetingId(response.meetingId ?? "");
              setResult(JSON.stringify(response, null, 2));
            } catch (error) {
              setResult(error instanceof Error ? error.message : "Failed");
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Sending..." : "Send test recap"}
        </button>
        {meetingId ? <a href={`#/meeting/${encodeURIComponent(meetingId)}`}>Open test meeting</a> : null}
      </div>
      {result && <pre>{result}</pre>}
    </section>
  );
}
