import { useEffect, useMemo, useState } from "react";
import type { AppSettings } from "@minutesbot/shared";
import { SettingsForm } from "../components/SettingsForm";
import { ApiError, getSettings, saveSettings, uploadBotImage, type SettingsView } from "../lib/api";
import { fileToBotImageUpload } from "../lib/botImage";

export async function saveSettingsDraft(
  settings: AppSettings,
  save: (settings: AppSettings) => Promise<SettingsView> = saveSettings
): Promise<{ view: SettingsView | null; message: string }> {
  try {
    return { view: await save(settings), message: "Saved" };
  } catch (error) {
    return { view: null, message: error instanceof Error ? error.message : "Save failed" };
  }
}

export function Settings() {
  const [view, setView] = useState<SettingsView | null>(null);
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [authNotConfigured, setAuthNotConfigured] = useState(false);

  useEffect(() => {
    getSettings()
      .then((loaded) => {
        setView(loaded);
        setDraft(loaded.settings);
      })
      .catch((error) => {
        if (error instanceof ApiError && error.code === "AUTH_NOT_CONFIGURED") {
          setAuthNotConfigured(true);
        }
        setMessage(error instanceof Error ? error.message : "Failed to load settings.");
      });
  }, []);

  const hasUnsavedChanges = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(view?.settings ?? null),
    [draft, view]
  );

  const saveDraft = async () => {
    if (!draft) return;
    setSaving(true);
    setMessage("Saving...");
    const result = await saveSettingsDraft(draft);
    if (result.view) {
      setView(result.view);
      setDraft(result.view.settings);
    }
    setMessage(result.message);
    setSaving(false);
  };

  if (authNotConfigured) {
    return (
      <div className="page">
        <header>
          <h1>Settings blocked</h1>
          <p>Configure the admin session secret before using protected routes.</p>
        </header>
        <section className="noticePanel">
          <h2>SESSION_SECRET is missing</h2>
          <p>{message}</p>
          <pre>wrangler secret put SESSION_SECRET</pre>
          <p>After setting the secret, deploy or restart the Worker and sign in with the same value as the admin token.</p>
        </section>
      </div>
    );
  }

  if (!draft || !view) return <p>{message || "Loading settings..."}</p>;

  return (
    <div className="page setupPage">
      <header className="setupHero">
        <div>
          <h1>Settings</h1>
          <p>Configure tenant, bot, providers, policy, scheduling, and retention.</p>
        </div>
        <div className="setupHeaderActions">
          <span className={hasUnsavedChanges ? "setupStatusPill warning" : "setupStatusPill good"}>{hasUnsavedChanges ? "Unsaved changes" : "Saved"}</span>
          <a className="setupStatusPill neutral" href="#/setup">Run setup wizard</a>
          <button className="primaryButton" type="button" disabled={saving || !hasUnsavedChanges} onClick={saveDraft}>
            {saving ? "Saving..." : "Save settings"}
          </button>
        </div>
      </header>
      <SettingsForm
        value={draft}
        secrets={view.secrets}
        onBotImageUpload={async (file) => {
          setMessage("Uploading bot image...");
          const uploaded = await uploadBotImage(await fileToBotImageUpload(file));
          setView(uploaded);
          setDraft(uploaded.settings);
          setMessage("Bot image uploaded");
        }}
        onChange={setDraft}
      />
      {message && <p className="setupMessage" role="status">{message}</p>}
      {hasUnsavedChanges && (
        <div className="stickySaveBar">
          <span>Unsaved changes</span>
          <div>
            <button className="secondaryButton" type="button" disabled={saving} onClick={() => setDraft(view.settings)}>
              Cancel
            </button>
            <button className="primaryButton" type="button" disabled={saving} onClick={saveDraft}>
              {saving ? "Saving..." : "Save settings"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
