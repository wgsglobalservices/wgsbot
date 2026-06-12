import { useEffect, useMemo, useState } from "react";
import type { AppSettings } from "@minutesbot/shared";
import { SettingsForm } from "../components/SettingsForm";
import { ApiError, getSettings, saveSettings, uploadBotImage } from "../lib/api";

export function Setup() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [savedSettings, setSavedSettings] = useState<AppSettings | null>(null);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [authNotConfigured, setAuthNotConfigured] = useState(false);
  useEffect(() => {
    getSettings()
      .then((loaded) => {
        setSettings(loaded);
        setSavedSettings(loaded);
      })
      .catch((error) => {
        if (error instanceof ApiError && error.code === "AUTH_NOT_CONFIGURED") {
          setAuthNotConfigured(true);
        }
        setMessage(error instanceof Error ? error.message : "Failed to load setup.");
      });
  }, []);

  const hasUnsavedChanges = useMemo(() => JSON.stringify(settings) !== JSON.stringify(savedSettings), [savedSettings, settings]);
  const saveCurrentSettings = async () => {
    if (!settings) return;
    setSaving(true);
    setMessage("Saving...");
    const result = await saveSetupSettings(settings);
    setSettings(result.settings);
    if (result.message === "Saved") setSavedSettings(result.settings);
    setMessage(result.message);
    setSaving(false);
  };

  if (authNotConfigured) {
    return (
      <div className="page">
        <header>
          <h1>Setup blocked</h1>
          <p>Configure the admin session secret before using protected setup routes.</p>
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

  if (!settings) return <p>{message || "Loading setup..."}</p>;

  return (
    <div className="page setupPage">
      <header className="setupHero">
        <div>
          <h1>Setup</h1>
          <p>Configure tenant, integrations, policy, and retention.</p>
        </div>
        <div className="setupHeaderActions">
          <span className={hasUnsavedChanges ? "setupStatusPill warning" : "setupStatusPill good"}>{hasUnsavedChanges ? "Unsaved changes" : "Saved"}</span>
          <span className="setupStatusPill neutral">{settings.primaryDomain}</span>
          <button className="primaryButton" type="button" disabled={saving || !hasUnsavedChanges} onClick={saveCurrentSettings}>
            {saving ? "Saving..." : "Save settings"}
          </button>
        </div>
      </header>
      <SettingsForm
        value={settings}
        onBotImageUpload={async (file) => {
          setMessage("Uploading bot image...");
          const uploaded = await uploadBotImage(await fileToBotImageUpload(file));
          setSettings(uploaded);
          setSavedSettings(uploaded);
          setMessage("Bot image uploaded");
        }}
        onChange={setSettings}
      />
      {message && <p className="setupMessage" role="status">{message}</p>}
      {hasUnsavedChanges && (
        <div className="stickySaveBar">
          <span>Unsaved changes</span>
          <div>
            <button className="secondaryButton" type="button" disabled={saving || !savedSettings} onClick={() => savedSettings && setSettings(savedSettings)}>
              Cancel
            </button>
            <button className="primaryButton" type="button" disabled={saving} onClick={saveCurrentSettings}>
              {saving ? "Saving..." : "Save settings"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

type BotImageUpload = { contentType: string; data: string; fileName: string };
type BotImageCompressor = (file: File) => Promise<File>;

const botBackgroundAspectRatio = 16 / 9;
const botBackgroundMaxWidth = 1920;
const botBackgroundMaxHeight = 1080;
const botBackgroundJpegQuality = 0.86;

export async function fileToBotImageUpload(file: File, compress: BotImageCompressor = compressBotBackgroundImage): Promise<BotImageUpload> {
  const optimized = await compress(file);
  const bytes = new Uint8Array(await optimized.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return {
    contentType: optimized.type,
    data: btoa(binary),
    fileName: optimized.name
  };
}

async function compressBotBackgroundImage(file: File): Promise<File> {
  const image = await createImageBitmap(file);
  const crop = coverCrop(image.width, image.height, botBackgroundAspectRatio);
  const target = targetBackgroundSize(crop.width, crop.height);
  const canvas = document.createElement("canvas");
  canvas.width = target.width;
  canvas.height = target.height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Image compression is not supported in this browser.");
  context.fillStyle = "#111827";
  context.fillRect(0, 0, target.width, target.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, target.width, target.height);
  image.close();
  const blob = await canvasToBlob(canvas, "image/jpeg", botBackgroundJpegQuality);
  return new File([blob], optimizedJpegName(file.name), { type: "image/jpeg" });
}

function coverCrop(width: number, height: number, targetAspectRatio: number): { x: number; y: number; width: number; height: number } {
  const sourceAspectRatio = width / height;
  if (sourceAspectRatio > targetAspectRatio) {
    const cropWidth = Math.round(height * targetAspectRatio);
    return { x: Math.round((width - cropWidth) / 2), y: 0, width: cropWidth, height };
  }
  const cropHeight = Math.round(width / targetAspectRatio);
  return { x: 0, y: Math.round((height - cropHeight) / 2), width, height: cropHeight };
}

function targetBackgroundSize(cropWidth: number, cropHeight: number): { width: number; height: number } {
  const scale = Math.min(1, botBackgroundMaxWidth / cropWidth, botBackgroundMaxHeight / cropHeight);
  return {
    width: Math.max(1, Math.round(cropWidth * scale)),
    height: Math.max(1, Math.round(cropHeight * scale))
  };
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
        return;
      }
      reject(new Error("Image compression failed."));
    }, type, quality);
  });
}

function optimizedJpegName(fileName: string): string {
  const baseName = fileName.replace(/\.[^.]+$/, "").trim() || "bot-background";
  return `${baseName}-optimized.jpg`;
}

export async function saveSetupSettings(
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
