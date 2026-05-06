import { Hono } from "hono";
import { toErrorResponse } from "@minutesbot/shared";
import type { Env } from "./env";
import { auditLogsRoute } from "./routes/auditLogs";
import { artifactsRoute } from "./routes/artifacts";
import { attendeeWebhookRoute } from "./routes/attendeeWebhook";
import { healthRoute } from "./routes/health";
import { meetingsRoute } from "./routes/meetings";
import { settingsRoute } from "./routes/settings";
import { testActionsRoute } from "./routes/testActions";
import { corsMiddleware } from "./middleware/cors";
import { errorMiddleware } from "./middleware/errors";
import { adminTokenAuthMiddleware } from "./middleware/auth";
import { cleanupOldArtifacts, handleQueueBatch } from "../../workflow-worker/src/queueConsumers";
import emailWorker from "../../email-worker/src/index";

export { CleanupWorkflow } from "../../workflow-worker/src/cleanupWorkflow";
export { MeetingWorkflow } from "../../workflow-worker/src/meetingWorkflow";
export { SummaryWorkflow } from "../../workflow-worker/src/summaryWorkflow";
export { TranscriptWorkflow } from "../../workflow-worker/src/transcriptWorkflow";

export const app = new Hono<{ Bindings: Env }>();

app.onError((error, c) => {
  const response = toErrorResponse(error);
  return c.json(response.body, response.status as 400);
});

app.use("*", errorMiddleware);
app.use("*", corsMiddleware);
app.use("/api/*", adminTokenAuthMiddleware);
app.options("*", (c) => c.body(null, 204));

app.route("/api/health", healthRoute);
app.route("/api/settings", settingsRoute);
app.route("/api/admin", testActionsRoute);
app.route("/api/admin/audit-logs", auditLogsRoute);
app.route("/api/meetings", meetingsRoute);
app.route("/api/artifacts", artifactsRoute);
app.route("/api/webhooks/attendee", attendeeWebhookRoute);

export default {
  fetch: app.fetch,
  email: emailWorker.email,
  async queue(batch, env) {
    await handleQueueBatch(batch, env);
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(cleanupOldArtifacts(env));
  }
} satisfies ExportedHandler<Env>;
