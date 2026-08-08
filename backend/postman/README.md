# Postman collection

`Tally-Connector-Bridge-API.postman_collection.json` — the full API, wired for real end-to-end runs (responses auto-populate the next request's variables: register → token → pair/connect → extract → result). No separate environment file needed; everything's a collection variable with sane defaults.

## Import

Postman → **Import** → select `Tally-Connector-Bridge-API.postman_collection.json`.

## Before running

1. Backend up: `npm run start:dev` (see the main [setup guide](../docs/connector-bridge-setup-guide.md)).
2. Edit the collection variable **`tallyCompanyName`** (right-click the collection → Edit → Variables) to your own Tally company's exact name if you're not using the one already filled in.
3. For anything in folders **3–6**, you also need a real connector bridge running (`npm run start:agent`) — Postman can drive the pairing/extraction *API calls*, but it can't run the bridge process itself.

## Run order

Folders are numbered in the order they're meant to run — top to bottom, or via **Collection Runner** against folders 1–6 (skip 7, or run it separately; it deliberately exercises failure paths). Each folder's description explains what it needs from the ones before it. Full narrative version: [docs/connector-bridge-setup-guide.md](../docs/connector-bridge-setup-guide.md).

**First run:** use *Register*. **Every run after that:** use *Login* instead (same email) — Register always creates a brand-new org with no paired connectors, so re-running it defeats the point of reusing a bridge you already paired.
