# Tally Connector — API Console

A simple React + TypeScript + Vite single-page app that exercises every backend endpoint for end-to-end testing — Auth, Connections, Device Pairing, Tally Direct, and Extractions, each as its own tab. Mirrors the [Postman collection](../postman/) one-for-one; use whichever you prefer clicking through.

This is a testing/dev tool, not the polished Phase 8 product UI described in [`docs/architecture.md`](../docs/architecture.md) — it's deliberately unstyled-simple and calls the backend directly from the browser (no server-side rendering, no build-time API contract).

## Run it

```bash
cp .env.example .env   # only if your backend isn't at the default http://localhost:3000/api
npm install
npm run dev             # http://localhost:5173
```

Requires the backend already running (`npm run start:dev` in the repo root — see [`docs/connector-bridge-setup-guide.md`](../docs/connector-bridge-setup-guide.md)). CORS is already enabled on the backend for this.

## What's where

- `src/api.ts` — typed fetch client for every endpoint, one object per resource (`authApi`, `connectionsApi`, `deviceAuthApi`, `tallyApi`, `extractionsApi`).
- `src/AuthContext.tsx` — JWT held in memory + `localStorage`, injected into every subsequent API call.
- `src/components/*Panel.tsx` — one component per tab, each independent and self-contained.

## Smoke test

```bash
npx playwright install chromium   # once
npm run dev &                     # separate terminal, or leave it running
npm run e2e
```

`e2e-smoke.mjs` drives a real headless Chromium: registers a fresh throwaway account, logs in, clicks through all four tabs, and asserts there are no console/network errors. Screenshots land in `e2e-shots/` (gitignored). Self-contained — no real Tally company or paired connector needed, since it only exercises the auth + navigation + Connections-list paths that work against an empty new org.
