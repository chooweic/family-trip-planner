# Family Trip Planner

A mobile-first web app where a family suggests holiday ideas, votes with weighted votes, and gets a proposed day-by-day plan. See `PROJECT3-BRIEF.md` and `PROJECT3-BUILD-PLAN.md` in the parent folder for the why and the plan.

- Frontend: plain HTML/JS, built with Vite into `dist/`
- Hosting: one Cloudflare Worker (`wrangler.jsonc`), which serves `dist/` and `/api/*`
- Data and sign-in: Supabase (added in step 2)

## Commands
- `npm run dev`: local page on Vite
- `npm run deploy`: build and deploy to Cloudflare
- `npm test`: unit tests

No secrets live in this repo. Worker secrets are set with `npx wrangler secret put <NAME>`.

`fixtures/kl-ideas.json` is **sample data**, not a real family's.
