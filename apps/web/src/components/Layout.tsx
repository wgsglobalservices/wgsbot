import type { ReactNode } from "react";
import type { RouteName } from "../App";

const nav: Array<{ route: RouteName; label: string; href: string }> = [
  { route: "setup", label: "Setup", href: "#/setup" },
  { route: "recap", label: "Recap", href: "#/recap" },
  { route: "attendee", label: "Attendee", href: "#/attendee" },
  { route: "meetings", label: "Meetings", href: "#/meetings" },
  { route: "logs", label: "Logs", href: "#/logs" }
];

export function Layout({ children, route }: { children: ReactNode; route: RouteName }) {
  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="brand" href="#/setup">
          <span className="brandMark" aria-hidden="true">
            <img src="/minutesbot-logo.svg" alt="" />
          </span>
          <span>minutes.bot</span>
        </a>
        <nav>
          {nav.map((item) => (
            <a key={item.route} className={route === item.route ? "active" : ""} href={item.href}>
              {item.label}
            </a>
          ))}
        </nav>
      </aside>
      <main className="content">{children}</main>
    </div>
  );
}
