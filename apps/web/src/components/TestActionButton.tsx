import { useState } from "react";
import { apiPost } from "../lib/api";

export function TestActionButton({ label, path, variant = "secondary" }: { label: string; path: string; variant?: "secondary" | "tertiary" }) {
  const [result, setResult] = useState<string>("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="testAction">
      <button
        className={variant === "tertiary" ? "tertiaryButton" : "secondaryButton"}
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const response = await apiPost<unknown>(path);
            setResult(JSON.stringify(response, null, 2));
          } catch (error) {
            setResult(error instanceof Error ? error.message : "Failed");
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Running..." : label}
      </button>
      {result && <pre>{result}</pre>}
    </div>
  );
}
