export function attendeeWebhookUrl(env: { API_BASE_URL: string; ATTENDEE_WEBHOOK_BASE_URL?: string }): string {
  return `${(env.ATTENDEE_WEBHOOK_BASE_URL || env.API_BASE_URL).replace(/\/+$/, "")}/api/webhooks/attendee`;
}
