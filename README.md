# Jace 3.0

A lifelong conversation. Phase 1: the core loop.

## Deploy (one-time setup, ~3 minutes)
1. In this folder: `npx vercel` → browser opens → log in → accept defaults.
2. In the Vercel dashboard → Project → Settings → Environment Variables, add:
   - `ANTHROPIC_API_KEY` (from console.anthropic.com) — Jace's brain
   - optional: `OPENAI_API_KEY`, `GLM_API_KEY` — fallback + Lab candidates
3. `npx vercel --prod`

Until a key is added, Jace runs on the honest mock brain — the app still works end to end.

## First run
Open the deployed URL → "First time? Create the account" → sign in. That account is yours;
everything is row-level-secured to it.

## The hidden Lab
`/lab` — run the same prompt through every configured model with the full Persona Pack,
side by side. This is how model migrations get decided.

## Development
`npm install` · `npm run dev` · `npm test` · `npm run build`

Model selection lives ONLY in `config/models.json`. The persona (persona/) never names a provider — a unit test enforces it.
