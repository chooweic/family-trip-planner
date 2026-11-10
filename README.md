# Family Trip Planner

A mobile-first web app where a family suggests holiday ideas, votes with weighted votes, and gets a proposed day-by-day plan. See `PROJECT3-BRIEF.md` and `PROJECT3-BUILD-PLAN.md` in the parent folder for the why and the plan.

- Frontend: plain HTML/JS, built with Vite into `dist/`
- Hosting: one Cloudflare Worker (`wrangler.jsonc`), which serves `dist/` and `/api/*`
- Data and sign-in: Supabase. The schema and access rules (RLS) are in `supabase/migrations/`.

## Commands
- `npm run dev`: local page on Vite
- `npm run deploy`: build and deploy to Cloudflare
- `npm test`: unit and access tests. The access tests run every migration in an in-memory Postgres ([PGlite](https://pglite.dev)) with a small stand-in for Supabase auth (`test/db/supabase-shim.sql`), so they need no accounts, network or secrets.
- `npx supabase db push`: apply new migrations to the hosted project (asks for the database password)

No secrets live in this repo. Worker secrets are set with `npx wrangler secret put <NAME>`.

`fixtures/kl-ideas.json` is **sample data**, not a real family's.
