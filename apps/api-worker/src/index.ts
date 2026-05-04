import { Hono } from "hono";
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

export { MeetingWorkflow } from "../../workflow-worker/src/meetingWorkflow";

export const app = new Hono<{ Bindings: Env }>();

app.use("*", errorMiddleware);
app.use("*", corsMiddleware);
app.options("*", (c) => c.body(null, 204));

app.route("/api/health", healthRoute);
app.route("/api/settings", settingsRoute);
app.route("/api/admin", testActionsRoute);
app.route("/api/admin/audit-logs", auditLogsRoute);
app.route("/api/meetings", meetingsRoute);
app.route("/api/artifacts", artifactsRoute);
app.route("/api/webhooks/attendee", attendeeWebhookRoute);

export default app;
