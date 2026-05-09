console.log(`# minutesbot Cloudflare Worker
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_ENV=production
APP_BASE_URL=https://admin.minutes.bot
API_BASE_URL=https://api.minutes.bot
ATTENDEE_WEBHOOK_BASE_URL=https://admin.minutes.bot
ATTENDEE_API_BASE_URL=https://attendee.company.com
ATTENDEE_EXTERNAL_MEDIA_BUCKET_NAME=minutesbot-artifacts
DEFAULT_RECORDER_EMAIL=notetaker@minutes.bot
DEFAULT_SENDER_EMAIL=notetaker@minutes.bot
ENVIRONMENT=production
ATTENDEE_API_KEY=
ATTENDEE_WEBHOOK_SECRET=
OPENROUTER_API_KEY=
SESSION_SECRET=
CLOUDFLARE_ACCESS_AUD=13f67694a98579897f6175043bb595df17afdfd5129d44c33e8b937b5576ae71
CLOUDFLARE_ACCESS_JWKS_URL=https://esau.cloudflareaccess.com/cdn-cgi/access/certs
CLOUDFLARE_ACCESS_ISSUER=https://esau.cloudflareaccess.com

# Attendee Cloudflare Container router
DATABASE_URL=postgres://...
REDIS_URL=redis://...
DJANGO_SECRET_KEY=
CREDENTIALS_ENCRYPTION_KEY=
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_ENDPOINT_URL=https://<account-id>.r2.cloudflarestorage.com
R2_RECORDING_BUCKET_NAME=minutesbot-artifacts
DEEPGRAM_API_KEY=
ZOOM_CLIENT_ID=
ZOOM_CLIENT_SECRET=`);
