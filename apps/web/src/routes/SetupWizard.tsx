import { useEffect, useState } from "react";
import type { AppSettings } from "@minutesbot/shared";
import {
  BotSection,
  CompanySection,
  DomainsPolicySection,
  EmailSection,
  RecapSection,
  TranscriptionSection
} from "../components/SettingsForm";
import { getSettings, uploadBotImage, type SettingsView } from "../lib/api";
import { apiPost } from "../lib/api";
import { fileToBotImageUpload } from "../lib/botImage";
import { saveSettingsDraft } from "./Settings";
import { StatusBadge } from "../components/StatusBadge";

export const wizardSteps = [
  { key: "company", label: "Company & recorder" },
  { key: "domains", label: "Domains & policy" },
  { key: "bot", label: "Meeting bot" },
  { key: "providers", label: "AI providers" },
  { key: "email", label: "Email & tests" }
] as const;

export type WizardStepKey = (typeof wizardSteps)[number]["key"];

export function SetupWizard() {
  const [view, setView] = useState<SettingsView | null>(null);
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getSettings()
      .then((loaded) => {
        setView(loaded);
        setDraft(loaded.settings);
      })
      .catch((error) => setMessage(error instanceof Error ? error.message : "Failed to load settings."));
  }, []);

  if (!draft || !view) return <p>{message || "Loading setup..."}</p>;

  const step = wizardSteps[stepIndex];
  const isLastStep = stepIndex === wizardSteps.length - 1;

  const saveAndAdvance = async () => {
    setSaving(true);
    setMessage("Saving...");
    const result = await saveSettingsDraft(draft);
    if (result.view) {
      setView(result.view);
      setDraft(result.view.settings);
      setMessage("Saved");
      if (isLastStep) {
        window.location.hash = "/";
      } else {
        setStepIndex(stepIndex + 1);
      }
    } else {
      setMessage(result.message);
    }
    setSaving(false);
  };

  return (
    <div className="page setupPage">
      <header className="setupHero">
        <div>
          <h1>Setup wizard</h1>
          <p>Step {stepIndex + 1} of {wizardSteps.length}: {step.label}</p>
        </div>
      </header>
      <div className="wizardSteps" role="tablist" aria-label="Setup steps">
        {wizardSteps.map((item, index) => (
          <button
            key={item.key}
            type="button"
            className={index === stepIndex ? "current" : ""}
            onClick={() => setStepIndex(index)}
          >
            {index + 1}. {item.label}
          </button>
        ))}
      </div>
      <form className="setupForm">
        {step.key === "company" && <CompanySection value={draft} onChange={setDraft} />}
        {step.key === "domains" && <DomainsPolicySection value={draft} onChange={setDraft} />}
        {step.key === "bot" && (
          <BotSection
            value={draft}
            onChange={setDraft}
            onBotImageUpload={async (file) => {
              setMessage("Uploading bot image...");
              const uploaded = await uploadBotImage(await fileToBotImageUpload(file));
              setView(uploaded);
              setDraft(uploaded.settings);
              setMessage("Bot image uploaded");
            }}
          />
        )}
        {step.key === "providers" && (
          <>
            <TranscriptionSection value={draft} onChange={setDraft} />
            <RecapSection value={draft} onChange={setDraft} />
          </>
        )}
        {step.key === "email" && (
          <>
            <EmailSection value={draft} onChange={setDraft} />
            <ConnectivityTests />
          </>
        )}
      </form>
      {message && <p className="setupMessage" role="status">{message}</p>}
      <div className="wizardActions">
        <button className="secondaryButton" type="button" disabled={saving || stepIndex === 0} onClick={() => setStepIndex(stepIndex - 1)}>
          Back
        </button>
        <button className="primaryButton" type="button" disabled={saving} onClick={saveAndAdvance}>
          {saving ? "Saving..." : isLastStep ? "Save & finish" : "Save & continue"}
        </button>
      </div>
    </div>
  );
}

const connectivityTests = [
  { label: "D1 database", path: "/api/admin/test-d1" },
  { label: "R2 storage", path: "/api/admin/test-r2" },
  { label: "Bot runtime", path: "/api/admin/test-bot" },
  { label: "AI provider", path: "/api/admin/test-ai" },
  { label: "Outbound email", path: "/api/admin/test-email" }
] as const;

type TestState = { status: "idle" | "running" | "pass" | "fail"; message: string };

function ConnectivityTests() {
  const [states, setStates] = useState<Record<string, TestState>>({});

  const runTest = async (path: string) => {
    setStates((current) => ({ ...current, [path]: { status: "running", message: "" } }));
    try {
      const result = await apiPost<{ ok?: boolean }>(path);
      setStates((current) => ({
        ...current,
        [path]: { status: result.ok === false ? "fail" : "pass", message: "" }
      }));
    } catch (error) {
      setStates((current) => ({
        ...current,
        [path]: { status: "fail", message: error instanceof Error ? error.message : "Failed" }
      }));
    }
  };

  return (
    <section className="setupPanel">
      <div className="setupPanelHeader">
        <div>
          <h2>Connectivity tests</h2>
          <p>Verify each integration against the saved configuration.</p>
        </div>
        <button
          type="button"
          className="secondaryButton"
          onClick={() => connectivityTests.forEach((test) => void runTest(test.path))}
        >
          Run all
        </button>
      </div>
      <div className="connectivityList">
        {connectivityTests.map((test) => {
          const state = states[test.path] ?? { status: "idle", message: "" };
          return (
            <div className="connectivityRow" key={test.path}>
              <span className="connectivityLabel">{test.label}</span>
              <button type="button" className="tertiaryButton" disabled={state.status === "running"} onClick={() => runTest(test.path)}>
                {state.status === "running" ? "Running..." : "Run"}
              </button>
              {state.status === "pass" && <StatusBadge value="pass" />}
              {state.status === "fail" && <StatusBadge value="fail" />}
              {state.message && <span className="connectivityMessage">{state.message}</span>}
            </div>
          );
        })}
      </div>
    </section>
  );
}
