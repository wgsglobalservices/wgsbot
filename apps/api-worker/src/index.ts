import { Hono } from "hono";
import { toErrorResponse } from "@minutesbot/shared";
import type { Env } from "./env";
import { auditLogsRoute } from "./routes/auditLogs";
import { artifactsRoute } from "./routes/artifacts";
import { botWebhookRoute } from "./routes/botWebhook";
import { healthRoute } from "./routes/health";
import { meetingsRoute } from "./routes/meetings";
import { settingsRoute } from "./routes/settings";
import { testActionsRoute } from "./routes/testActions";
import { corsMiddleware } from "./middleware/cors";
import { errorMiddleware } from "./middleware/errors";
import { adminTokenAuthMiddleware, isPublicApiPath } from "./middleware/auth";
import { isCloudflareAccessConfigured, requireCloudflareAccess } from "./middleware/cloudflareAccess";
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
app.route("/api/webhooks/bot", botWebhookRoute);
app.route("/api/webhooks/bot/", botWebhookRoute);
app.route("/api/webhooks/attendee", botWebhookRoute);
app.route("/api/webhooks/attendee/", botWebhookRoute);

export default {
  async fetch(request, env, ctx) {
    return handleFetch(request, env, ctx);
  },
  email: emailWorker.email,
  async queue(batch, env) {
    await handleQueueBatch(batch, env);
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(cleanupOldArtifacts(env));
  }
} satisfies ExportedHandler<Env>;

export async function handleFetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/")) {
    if (!isPublicApiPath(url.pathname) && url.hostname !== new URL(env.APP_BASE_URL).hostname) {
      return new Response("Not Found", { status: 404, headers: { "content-type": "text/plain; charset=UTF-8" } });
    }
    return app.fetch(request, env, ctx);
  }

  if (url.hostname !== new URL(env.APP_BASE_URL).hostname) {
    return new Response("Not Found", { status: 404, headers: { "content-type": "text/plain; charset=UTF-8" } });
  }

  if (isCloudflareAccessConfigured(env)) {
    try {
      await requireCloudflareAccess(request, env);
    } catch (error) {
      const response = toErrorResponse(error);
      return Response.json(response.body, { status: response.status });
    }
  }

  return env.ASSETS ? env.ASSETS.fetch(request) : app.fetch(request, env, ctx);
}
