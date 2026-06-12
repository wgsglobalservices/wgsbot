type DeliveryStatus = {
  label: string;
  badgeClass: "good" | "bad" | "neutral";
  title?: string;
};

export function RecipientEligibilityTable({
  attendees,
  emailDeliveries = []
}: {
  attendees: Array<Record<string, unknown>>;
  emailDeliveries?: Array<Record<string, unknown>>;
}) {
  return (
    <section>
      <h2>Attendees and eligibility</h2>
      <table>
        <thead><tr><th>Email</th><th>Name</th><th>Domain</th><th>Eligible</th><th>Recap email</th><th>Exclusion</th></tr></thead>
        <tbody>
          {attendees.map((attendee) => {
            const deliveryStatus = getRecapEmailDeliveryStatus(attendee, emailDeliveries);
            return (
              <tr key={String(attendee.id ?? attendee.email)}>
                <td>{String(attendee.email)}</td>
                <td>{String(attendee.name ?? "")}</td>
                <td>{String(attendee.domain ?? "")}</td>
                <td>{attendee.summary_eligible ? "Yes" : "No"}</td>
                <td>
                  <span className={`badge ${deliveryStatus.badgeClass}`} title={deliveryStatus.title}>{deliveryStatus.label}</span>
                </td>
                <td>{String(attendee.exclusion_reason ?? "")}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

export function getRecapEmailDeliveryStatus(
  attendee: Record<string, unknown>,
  emailDeliveries: Array<Record<string, unknown>>
): DeliveryStatus {
  const attendeeEmail = normalizeEmail(attendee.email);
  const latestDelivery = emailDeliveries
    .filter((delivery) => String(delivery.type ?? "") === "summary" && normalizeEmail(delivery.recipient_email) === attendeeEmail)
    .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))[0];

  if (!latestDelivery) return { label: "Not sent", badgeClass: "neutral" };
  const status = String(latestDelivery.status ?? "").toLowerCase();
  if (status === "sent") return { label: "Sent", badgeClass: "good" };
  if (status === "failed") {
    const failureReason = String(latestDelivery.failure_reason ?? "");
    return { label: "Failed", badgeClass: "bad", title: failureReason || undefined };
  }
  return { label: status ? status[0].toUpperCase() + status.slice(1) : "Unknown", badgeClass: "neutral" };
}

function normalizeEmail(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}
