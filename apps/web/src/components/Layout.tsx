import type { ReactNode } from "react";
import type { RouteName } from "../App";
import { useAdminSession } from "../AuthGate";

const nav: Array<{ route: RouteName; label: string; href: string }> = [
  { route: "dashboard", label: "Dashboard", href: "#/" },
  { route: "meetings", label: "Meetings", href: "#/meetings" },
  { route: "jobs", label: "Jobs", href: "#/jobs" },
  { route: "bot", label: "Bot Runtime", href: "#/bot" },
  { route: "logs", label: "Logs", href: "#/logs" },
  { route: "settings", label: "Settings", href: "#/settings" },
  { route: "setup", label: "Setup", href: "#/setup" }
];

/** Detail routes highlight their parent list entry in the sidebar. */
const navRouteAliases: Partial<Record<RouteName, RouteName>> = {
  event: "meetings",
  occurrence: "meetings"
};

export function Layout({ children, route }: { children: ReactNode; route: RouteName }) {
  const { signOut } = useAdminSession();
  const activeRoute = navRouteAliases[route] ?? route;

  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="brand" href="#/">
          <span className="brandMark" aria-hidden="true">
            <img src="/minutesbot-logo.svg" alt="" />
          </span>
          <span>minutes.bot</span>
        </a>
        <nav>
          {nav.map((item) => (
            <a key={item.route} className={activeRoute === item.route ? "active" : ""} href={item.href}>
              {item.label}
            </a>
          ))}
        </nav>
        <div className="sidebarUserMenu">
          <button type="button" onClick={signOut}>
            Sign out
          </button>
        </div>
      </aside>
      <main className="content">{children}</main>
    </div>
  );
}
