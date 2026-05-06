console.log(`# minutesbot Cloudflare Worker
APP_BASE_URL=https://admin.wgs.bot
API_BASE_URL=https://minutesbot.wgsglobal.app
ATTENDEE_WEBHOOK_BASE_URL=https://minutesbot-webhook.wgsglobal.app
ATTENDEE_API_BASE_URL=https://app.attendee.dev
ATTENDEE_EXTERNAL_MEDIA_BUCKET_NAME=minutesbot-artifacts
DEFAULT_RECORDER_EMAIL=notetaker@wgs.bot
DEFAULT_SENDER_EMAIL=notetaker@wgs.bot
ENVIRONMENT=production
ATTENDEE_API_KEY=
ATTENDEE_WEBHOOK_SECRET=
AI_API_KEY=replace-with-ai-api-key
SESSION_SECRET=

# Attendee Cloudflare Container router
DATABASE_URL=postgres://...
REDIS_URL=redis://...
DJANGO_SECRET_KEY=
CREDENTIALS_ENCRYPTION_KEY=
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_RECORDING_STORAGE_BUCKET_NAME=
AWS_ENDPOINT_URL=
DEEPGRAM_API_KEY=
ZOOM_CLIENT_ID=
ZOOM_CLIENT_SECRET=`);
