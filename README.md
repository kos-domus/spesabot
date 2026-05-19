# Spesabot — Spesify

Aggregatore di volantini supermercati italiani, servito agli utenti via Telegram Mini App.

Spesabot ingerisce i volantini settimanali di una dozzina di catene (Veneto-focused), normalizza i prodotti contro un dizionario canonico, indicizza geograficamente i punti vendita, e li serve agli utenti finali tramite una Mini App Telegram (`Spesify`) con ricerca, filtri, e alert prezzo.

Stato attuale: ~95% backend, ~14 catene attive, ~40k offerte settimanali. Primo utente è l'autore stesso, apertura graduale ad altri utenti in corso.

## Highlights tecnici

- **Pipeline ETL multi-source**: parser per catena (API REST, scraping HTML/PDF, Playwright per pagine dinamiche, Gemini Vision per cataloghi senza API)
- **Canonical matching**: layer rule-based inline + batch LLM (Z.AI / GPT / Gemini in cascata) per collassare SKU diversi su prodotti canonici
- **Geo search**: PostgreSQL + PostGIS, `ST_DWithin` per "vicino a me"
- **Telegram Mini App**: vanilla JS + Fastify, auth via Telegram HMAC, Cloudflare Tunnel
- **Watch list**: alert prezzo Telegram quando una soglia utente viene rotta, con dedup row-level (UNIQUE constraint + ON CONFLICT upsert)
- **WCAG 2.1 AA**: audit completo sulla Mini App, contrasti AA-compliant, keyboard nav, aria-live region

## Architettura

Quattro famiglie runtime:

1. **User-facing**: Fastify API (`src/api/`) + Telegram bot grammY (`src/bot/`)
2. **Shared core**: parsers (`src/parsers/`), canonical-match (`src/canonical-match.ts`), llm-match (`src/llm-match.ts`)
3. **Batch jobs**: ETL pipeline runner (`src/runner.ts`), matching service, notify jobs
4. **Data layer**: PostgreSQL 16 + PostGIS, schema gestito da `db/NNN_*.sql` migrations

Vedi `docs/ARCHITECTURE_CURRENT.md` per il dettaglio.

## Stack

- **Runtime**: Node.js 22, TypeScript
- **Web framework**: Fastify 5.x
- **Bot**: grammY
- **DB**: PostgreSQL 16 + PostGIS 3
- **Frontend**: vanilla JS + CSS (Mini App Telegram)
- **Scraping**: Playwright, sharp (image crop), Gemini 2.5 Flash (vision)
- **LLM matching**: Z.AI primario, GPT-5.4 + Gemini come fallback chain
- **Infra**: systemd (user-mode), Cloudflare Tunnel, 1Password CLI per secrets

## Catene supportate

API-based: Migross, Conad.
HTML/PDF: Aldi, Lidl, Rossetto, Eurospin, Despar.
Playwright: Famila, Conad-flyer.
Vision (Gemini): MD, CRAI, DPiù, Esselunga.

## Layout repo

```
src/
  api/server.ts          Fastify HTTP API (auth, search, explore, watches, shopping-list)
  bot/bot.ts             Telegram bot (grammY)
  parsers/<chain>.ts     Per-chain ingest
  canonical-match.ts     Rule-based product matching
  llm-match.ts           LLM fallback matching
  webapp/                Mini App static assets (HTML/CSS/JS)
db/
  NNN_<migration>.sql    Schema migrations, idempotent (IF NOT EXISTS guards)
scripts/                 Operational scripts (image fill, ETL ops, store seeding)
docs/                    Architecture + design notes
diagrams/                Excalidraw architecture
```

## Build & run

```bash
npm install
npm run build                          # tsc + copy src/webapp/ → dist/webapp/

# Run individual components (each needs DATABASE_URL + relevant API keys):
export DATABASE_URL="postgresql://user:pass@host:5432/spesabot"
node dist/api/server.js                # API on :3080
node dist/bot/bot.js                   # Telegram bot
node dist/runner.js                    # ETL pipeline (full run)
```

Apply migrations against an empty DB:

```bash
for f in db/*.sql; do psql "$DATABASE_URL" -f "$f"; done
```

## Environment

Required: `DATABASE_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBAPP_URL`.

Optional (LLM matching): `ZAI_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`.

Optional (parsers): `CLOUDFLARE_TUNNEL_TOKEN`, parser-specific keys when documented in the relevant `src/parsers/<chain>.ts`.

## License

MIT — see `LICENSE`.

Project owner: Alessandro Benedetti (@RakkiOtoko · github.com/kos-domus).
