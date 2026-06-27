# Deploy AgentOps to Vercel

AgentOps is a full-stack app (React dashboard + Express API + PostgreSQL). Vercel hosts the static frontend and runs the Express API as a serverless function at `/api/*`.

## Prerequisites

1. A [Vercel account](https://vercel.com) linked to GitHub
2. A PostgreSQL database (recommended: [Vercel Postgres](https://vercel.com/docs/storage/vercel-postgres) or [Neon](https://neon.tech) with a **pooled** connection string for serverless)
3. Optional: Datadog LLM Observability credentials for the Traces page

## 1. Connect the GitHub repo

1. Go to [vercel.com/new](https://vercel.com/new)
2. Import `icohangar-ops/agent-observability`
3. Vercel reads `vercel.json` automatically — no manual build settings needed

## 2. Set environment variables

In the Vercel project → **Settings → Environment Variables**:

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | Yes | Postgres connection string (use a pooled URL for serverless) |
| `DATADOG_SITE` | For traces | e.g. `us5.datadoghq.com` |
| `DATADOG_API_KEY` | For traces | Datadog API key |
| `DATADOG_APP_KEY` | For traces | Datadog app key with LLM Observability read scope |
| `LOG_LEVEL` | No | Defaults to `info` |

## 3. Initialize the database

After the first deploy, run schema push and seed from your machine (or a one-off Vercel CLI session):

```bash
pnpm install
export DATABASE_URL="your-pooled-postgres-url"
pnpm --filter @workspace/db run push
pnpm --filter @workspace/scripts run seed
```

For Datadog sample traces:

```bash
pnpm --filter @workspace/scripts run seed:traces
```

## 4. Deploy

Push to `main` — Vercel deploys automatically on each push.

For a manual preview deploy:

```bash
npx vercel
```

## Troubleshooting

### API returns 500 / dashboard shows no data

Check Vercel function logs:

```bash
vercel logs agent-observability-bay.vercel.app
```

The most common cause is a missing database connection. Confirm env vars exist:

```bash
vercel env ls
```

You should see `DATABASE_URL` (or `POSTGRES_URL` from the Neon integration). If empty, provision Postgres:

```bash
# Accept Neon terms in browser first:
# https://vercel.com/<team>/~/integrations/accept-terms/neon?source=cli
vercel integration add neon --name agent-observability-db --plan free_v3 -e production -e preview
vercel env pull .env.local --yes
pnpm run db:push
pnpm run db:seed
vercel deploy --prod
```

### Frontend loads but all API calls fail

The static UI deploys independently of the API. A working homepage with empty charts means the Express serverless function is failing — almost always due to missing `DATABASE_URL`.

## Architecture on Vercel

- **Frontend**: Vite build → `artifacts/agent-observability/dist/public`
- **API**: Express app bundled to `artifacts/api-server/dist/app.mjs`, served via `api/index.mjs`
- **Routing**: `/api/*` → serverless function; everything else → SPA `index.html`

The dashboard calls relative `/api/...` paths, so no separate API URL is needed.

## Notes

- Use a **pooled** Postgres connection string — serverless functions open many short-lived connections.
- Datadog credentials are server-side only; the browser never sees them.
- The app was originally built for Replit; the Vercel config is an additional deployment target and does not replace Replit workflows.
