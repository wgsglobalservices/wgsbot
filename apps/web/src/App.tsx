import { useEffect, useState } from "react";
import { Layout } from "./components/Layout";
import { BotRuntime } from "./routes/BotRuntime";
import { Dashboard } from "./routes/Dashboard";
import { EventDetail } from "./routes/EventDetail";
import { Jobs } from "./routes/Jobs";
import { Logs } from "./routes/Logs";
import { Meetings } from "./routes/Meetings";
import { Settings } from "./routes/Settings";
import { SetupWizard } from "./routes/SetupWizard";
import { OccurrenceDetail } from "./routes/OccurrenceDetail";

export type RouteName = "dashboard" | "meetings" | "event" | "occurrence" | "jobs" | "bot" | "settings" | "setup" | "logs";

export type Route = { name: RouteName; id?: string };

export function App() {
  const [route, setRoute] = useState(() => parseHash());
  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  return (
    <Layout route={route.name}>
      {route.name === "dashboard" && <Dashboard />}
      {route.name === "meetings" && <Meetings />}
      {route.name === "event" && <EventDetail id={route.id ?? ""} />}
      {route.name === "occurrence" && <OccurrenceDetail id={route.id ?? ""} />}
      {route.name === "jobs" && <Jobs />}
      {route.name === "bot" && <BotRuntime />}
      {route.name === "settings" && <Settings />}
      {route.name === "setup" && <SetupWizard />}
      {route.name === "logs" && <Logs />}
    </Layout>
  );
}

export function parseHash(hashValue = window.location.hash): Route {
  const hash = hashValue.replace(/^#\/?/, "");
  const [name, rawId] = hash.split("/");
  const id = rawId ? decodeURIComponent(rawId) : undefined;
  if (name === "events" && id) return { name: "event", id };
  if (name === "occurrences" && id) return { name: "occurrence", id };
  if (name === "meetings" || name === "jobs" || name === "bot" || name === "settings" || name === "setup" || name === "logs") {
    return { name };
  }
  // Legacy hashes from the pre-occurrence UI.
  if (name === "meeting") return { name: "meetings" };
  if (name === "recap") return { name: "settings" };
  if (name === "attendee") return { name: "bot" };
  return { name: "dashboard" };
}
