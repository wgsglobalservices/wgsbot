import type { AppSettings, RecapSectionKey } from "@minutesbot/shared";

type RecapSettings = AppSettings["recap"];

export function RecapForm({ value, onChange }: { value: RecapSettings; onChange: (recap: RecapSettings) => void }) {
  const update = <K extends keyof RecapSettings>(key: K, next: RecapSettings[K]) => onChange({ ...value, [key]: next });

  return (
    <form className="recapLayout">
      <section className="formGrid">
        <Field label="Whisper model" value={value.transcriptionModel} onChange={(next) => update("transcriptionModel", next)} />
        <Field label="Language" value={value.language ?? ""} placeholder="Auto-detect" onChange={(next) => update("language", next)} />
        <Field label="Subject prefix" value={value.subjectPrefix} onChange={(next) => update("subjectPrefix", next)} />
        <TextAreaField label="Intro text" value={value.introText ?? ""} rows={3} onChange={(next) => update("introText", next)} />
      </section>
      <section>
        <h2>Layout</h2>
        <div className="recapSections">
          {value.sections.map((section, index) => (
            <div className="recapSectionRow" key={section.key}>
              <label className="check compactCheck">
                <input
                  type="checkbox"
                  checked={section.enabled}
                  onChange={(event) => update("sections", updateSection(value.sections, section.key, { enabled: event.target.checked }))}
                />
                <span>{sectionLabel(section.key)}</span>
              </label>
              <input
                aria-label={`${sectionLabel(section.key)} label`}
                value={section.label}
                onChange={(event) => update("sections", updateSection(value.sections, section.key, { label: event.target.value }))}
              />
              <button type="button" disabled={index === 0} onClick={() => update("sections", moveSection(value.sections, index, -1))}>
                Up
              </button>
              <button type="button" disabled={index === value.sections.length - 1} onClick={() => update("sections", moveSection(value.sections, index, 1))}>
                Down
              </button>
            </div>
          ))}
        </div>
      </section>
      <TextAreaField className="promptField" label="AI recap prompt" value={value.prompt} rows={10} onChange={(next) => update("prompt", next)} />
    </form>
  );
}

export function updateSection(
  sections: RecapSettings["sections"],
  key: RecapSectionKey,
  patch: Partial<RecapSettings["sections"][number]>
): RecapSettings["sections"] {
  return sections.map((section) => (section.key === key ? { ...section, ...patch } : section));
}

export function moveSection(sections: RecapSettings["sections"], index: number, delta: -1 | 1): RecapSettings["sections"] {
  const nextIndex = index + delta;
  if (nextIndex < 0 || nextIndex >= sections.length) return sections;
  const copy = [...sections];
  const [item] = copy.splice(index, 1);
  copy.splice(nextIndex, 0, item);
  return copy;
}

function sectionLabel(key: RecapSectionKey): string {
  return {
    summary: "Summary",
    decisions: "Decisions",
    actionItems: "Action items",
    openQuestions: "Open questions",
    risks: "Risks",
    followUps: "Follow-ups"
  }[key];
}

function Field({
  label,
  placeholder,
  value,
  onChange
}: {
  label: string;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      <span>{label}</span>
      <input placeholder={placeholder} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function TextAreaField({
  className,
  label,
  rows,
  value,
  onChange
}: {
  className?: string;
  label: string;
  rows: number;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className={className}>
      <span>{label}</span>
      <textarea rows={rows} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}
