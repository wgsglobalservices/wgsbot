import { useEffect, useState } from "react";
import type { AppSettings } from "@minutesbot/shared";
import { RecapForm } from "../components/RecapForm";
import { ApiError, getSettings, saveSettings } from "../lib/api";

export function Recap() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [authNotConfigured, setAuthNotConfigured] = useState(false);

  useEffect(() => {
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
    const result = await saveRecapSettings(settings);
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
