import type { AttendeeRow } from "../lib/types";
import type { BadgeTone } from "./StatusBadge";

export type EligibilityDisplay = { label: string; tone: BadgeTone; detail?: string };

/**
 * Recap recipient eligibility as the policy engine resolved it. Excluded
 * attendees show why (external domain, policy toggle, alias, ...).
 */
export function describeAttendeeEligibility(attendee: Pick<AttendeeRow, "recipient_eligible" | "is_external" | "exclusion_reason">): EligibilityDisplay {
  if (attendee.recipient_eligible) return { label: "Eligible", tone: "good" };
  return {
    label: attendee.exclusion_reason ? `Excluded: ${attendee.exclusion_reason}` : "Not eligible",
    tone: attendee.is_external ? "warning" : "neutral",
    detail: attendee.exclusion_reason ?? undefined
  };
}

export function AttendeeTable({ attendees }: { attendees: AttendeeRow[] }) {
  if (attendees.length === 0) return <p className="mutedText">No attendees recorded.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>Email</th>
          <th>Name</th>
          <th>Role</th>
          <th>Domain</th>
          <th>External</th>
          <th>Recap eligibility</th>
        </tr>
      </thead>
      <tbody>
        {attendees.map((attendee) => {
          const eligibility = describeAttendeeEligibility(attendee);
          return (
            <tr key={attendee.id}>
              <td>{attendee.email}</td>
              <td>{attendee.name ?? ""}</td>
              <td>{attendee.role ?? ""}</td>
              <td>{attendee.domain ?? ""}</td>
              <td>{attendee.is_external ? <span className="badge warning">external</span> : <span className="badge neutral">internal</span>}</td>
              <td>
                <span className={`badge ${eligibility.tone}`} title={eligibility.detail}>{eligibility.label}</span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
