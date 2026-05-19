# SpesaBot Current Architecture

Last updated: 2026-04-16

This document describes the current architecture of SpesaBot as implemented in the repository today.

The detailed visual diagram lives in `docs/architecture-detailed.mmd`.

## Architecture At A Glance

SpesaBot is composed of four main runtime families:

1. user-facing services
2. shared core modules
3. batch extraction and matching jobs
4. a PostgreSQL-centered data layer

The most important architectural detail is this:

- the Telegram bot does **not** call the Fastify API
- the Mini App **does** call the Fastify API
- the ETL pipeline writes directly to PostgreSQL
- product matching runs as a separate batch flow after ingest

So the current system is not a strict layered API-only backend. It is a shared-database architecture with multiple entry points.

## 1. Channel Layer

### Telegram user surface

The user interacts with the system in two ways:

- by sending commands/messages to the Telegram bot
- by opening the Telegram Mini App

Relevant files:

- `src/bot/bot.ts`
- `src/webapp/index.html`
- `src/webapp/app.js`

### Operator / scheduled execution surface

The batch side of the system is triggered by shell scripts and systemd timers.

Relevant files:

- `scripts/run-pipeline.sh`
- `scripts/run-matching.sh`
- `scripts/install-systemd-timer.sh`

## 2. Edge And Delivery Layer

### Telegram Bot API

The bot runtime is a standalone grammY process that communicates with Telegram directly through the Bot API.

This path is separate from the Fastify API.

### Cloudflare Tunnel

The Mini App and HTTP API are exposed through a Cloudflare Tunnel / custom web origin.

### Fastify server

`src/api/server.ts` has two responsibilities:

- serve the Mini App static assets under `/webapp/*`
- expose the REST API used by the Mini App

The Fastify server also performs Telegram Mini App auth validation for protected preference endpoints.

## 3. UX And Application Service Layer

## 3.1 Telegram Bot

Main file:

- `src/bot/bot.ts`

Main responsibilities:

- free-text product search
- explicit search and comparison commands
- categories, active deals, chain listings, stores
- user preference management
- loyalty program information
- loyalty profile storage
- Conad card activation flow

Important design detail:

- the bot queries PostgreSQL directly through `src/db.ts`
- it does not route reads/writes through `src/api/server.ts`

The bot also uses:

- `src/crypto.ts` for profile encryption/decryption
- `src/loyalty/conad-signup.ts` for Playwright-based Conad registration

## 3.2 Mini App

Main files:

- `src/webapp/index.html`
- `src/webapp/app.js`
- `src/webapp/style.css`

Main screens:

- search
- top deals
- categories
- stores
- preferences

The Mini App is a client-side app loaded from Fastify static hosting and then calls REST endpoints under `/api/*`.

## 3.3 Fastify API

Main file:

- `src/api/server.ts`

The API contains three logical groups.

### A. Static delivery

- `/`
- `/webapp/*`

### B. Public query endpoints

- `/api/status`
- `/api/search`
- `/api/categoria/:tag`
- `/api/categorie`
- `/api/stores/:chain`
- `/api/deals/top`
- `/api/chain/:chain`
- `/api/compare`
- `/api/price-spread`
- `/api/product/:id/prices`
- `/api/negozi/:chain`
- `/api/stores`
- `/api/loyalty`
- `/api/chains`

### C. Protected user preference endpoints

- `GET /api/preferences`
- `POST /api/preferences`

Protection is implemented through Telegram `initData` validation inside the same file.

## 4. Shared Core Modules

These modules are reused across multiple runtimes.

### `src/db.ts`

Shared PostgreSQL pool used by:

- API
- bot
- ingest
- canonical matching
- LLM matching

### `src/store-registry.ts`

Loads `configs/stores.yaml` and turns chain configuration into scrape targets.

Supported generic strategies in the registry module:

- `url-list`
- `national`
- `aggregator`
- `pdf`

Note:

- `migross` is handled as a special case in `src/runner.ts`
- `despar` and `conad-flyer` also have special orchestration logic in `src/runner.ts`

### `src/normalize.ts`

Normalizes:

- prices
- quantities
- offer mechanics
- unit prices

This module is the main shared normalization step inside the ingest path.

### `src/crypto.ts`

Encrypts/decrypts profile fields stored in `user_profiles`.

Used primarily by the Telegram bot profile and loyalty flows.

### `src/alerts.ts`

Sends pipeline and failure notifications to the admin Telegram chat.

## 5. ETL And Extraction Layer

The ETL pipeline is orchestrated by `src/runner.ts` and writes directly to PostgreSQL through `src/ingest.ts`.

## 5.1 Orchestration

Main files:

- `scripts/run-pipeline.sh`
- `src/runner.ts`

Runner responsibilities:

1. load active chains
2. choose the right extraction strategy per chain
3. call discovery/fetch/parser flows
4. synthesize job results when needed
5. pass results to ingest
6. send a final pipeline summary

`src/runner.ts` also imports an external deep-research runtime from `DEEP_RESEARCH_DIR`.

## 5.2 Source Registry

Main config:

- `configs/stores.yaml`

This file contains:

- chain definitions
- scrape strategy
- source type
- parser hints
- store-specific URLs where applicable

Current configured chain families visible from the repo:

- `famila`
- `despar`
- `eurospin`
- `lidl`
- `aldi`
- `conad`
- `rossetto`
- `migross`
- `conad-flyer`

## 5.3 Source Adapters And Chain Strategies

The current architecture mixes multiple extraction patterns.

| Chain / family | Strategy in practice | Main modules |
| --- | --- | --- |
| Migross | direct API fetch | `src/runner.ts`, `src/parsers/migross.ts` |
| Eurospin | PDF + API image enrichment | `src/parsers/eurospin.ts`, `src/parsers/eurospin-url-discovery.ts` |
| Despar | flyer URL discovery + iPaper text extraction | `src/parsers/despar-flyer-fetch.ts`, `src/parsers/despar.ts` |
| Conad flyer | store discovery + PDF discovery + flyer parser | `src/parsers/conad-flyer-discovery.ts`, `src/parsers/conad-flyer.ts` |
| Famila | custom Playwright pagination fetcher + parser | `src/parsers/famila-fetch.ts`, `src/parsers/famila.ts` |
| Rossetto | direct HTTP fetch + HTML parser | `src/parsers/rossetto.ts` |
| Lidl / Aldi / Conad | deep-research fetch + chain-specific parser | `src/runner.ts`, `src/parsers/lidl*.ts`, `src/parsers/aldi*.ts`, `src/parsers/conad.ts` |

So the ETL layer is hybrid:

- some chains are fetched through dedicated adapters
- some through deep-research
- some through PDF workflows
- some through discovery + parser combinations

## 5.4 Ingest Pipeline

Main file:

- `src/ingest.ts`

Current ingest steps:

1. read a `JobResult` JSON file
2. map the chain to its DB chain id
3. optionally resolve store context for `url-list` chains
4. choose a chain-specific parser when available
5. otherwise fall back to extracted data already present in the job result
6. enrich products with image URLs when available
7. derive campaign validity dates
8. upsert `flyer_campaigns`
9. clean previous offers only for that campaign
10. upsert `product_skus`
11. insert `offers`
12. aggregate `price_history`
13. refresh search/tag metadata

Important current characteristic:

- `product_skus.product_id` may remain `NULL`
- canonical matching happens later in a separate batch flow

## 6. Product Matching Layer

Product matching is decoupled from ingest.

Main files:

- `scripts/run-matching.sh`
- `src/canonical-match.ts`
- `src/llm-match.ts`

### Step 1: Rule-based canonical linking

`src/canonical-match.ts`:

- builds normalized match keys
- groups similar SKUs
- creates canonical `products`
- writes `product_skus.product_id`

### Step 2: LLM-assisted fuzzy linking

`src/llm-match.ts`:

- finds remaining candidate pairs
- calls external LLMs
- confirms fuzzy matches across chains

This layer improves cross-chain comparison views after the raw ETL has already completed.

## 7. Persistence Layer

The persistence model is PostgreSQL-centric.

Main schema files:

- `db/001_schema.sql`
- `db/003_schema_fixes.sql`
- `db/004_add_image_url.sql`
- `db/006_price_comparison_views.sql`

### 7.1 Retail graph

- `chains`
- `stores`

This is the store network and retailer master data.

### 7.2 Catalog graph

- `products`
- `product_skus`

`products` is the canonical layer.

`product_skus` is the chain-specific offer identity layer.

### 7.3 Promotional data

- `flyer_campaigns`
- `offers`
- `price_history`

This is the main runtime dataset used by bot and API search/compare flows.

### 7.4 User data

- `user_profiles`
- `user_loyalty_cards`

This layer is used by:

- bot preferences
- bot profile storage
- loyalty registration flows
- Mini App preference APIs

### 7.5 Search helpers and analytical views

The current repo also uses:

- `normalized_name`
- `search_vector`
- `tags`
- `price_spread`
- `cross_chain_prices`
- `best_prices`
- `category_price_leaders`

These support:

- search ranking
- category browsing
- cross-chain comparison

### 7.6 Schema note

The schema still contains some broader product-platform ideas such as:

- `users`
- `shopping_lists`
- `shopping_list_items`

These exist in the SQL model but are not a central active part of the current runtime architecture shown in API/bot flows.

## 8. External Integrations

The current architecture depends on several external systems.

### Retail sources

- retailer websites
- digital flyer APIs
- store discovery endpoints
- PDFs
- iPaper-like flyer viewers

### Telegram

- Telegram Bot API
- Telegram Mini App / WebView auth data

### LLM providers

Used only by the matching flow:

- Z.AI
- OpenAI
- Gemini

### Google Maps

Maps links are generated for store and offer context.

## 9. Main Runtime Flows

## 9.1 User -> Bot -> Database

1. user sends a command or free-text message in Telegram
2. `src/bot/bot.ts` handles it
3. bot queries PostgreSQL through `src/db.ts`
4. bot formats and returns the result directly in Telegram

There is no Fastify API in this path.

## 9.2 User -> Mini App -> Fastify -> Database

1. user opens the Mini App from Telegram
2. Telegram WebView loads the web app through Cloudflare Tunnel
3. Fastify serves static assets
4. `src/webapp/app.js` calls `/api/*`
5. Fastify queries PostgreSQL and returns JSON
6. Mini App renders results client-side

## 9.3 Timer -> Runner -> Sources -> Ingest -> Database

1. systemd or operator launches `scripts/run-pipeline.sh`
2. runner selects active chains
3. each chain is fetched through its configured strategy
4. parsers/adapters produce structured products or raw text
5. `src/ingest.ts` writes campaigns, SKUs, offers, and history
6. admin summary is sent through Telegram

## 9.4 Timer -> Matching -> Database

1. `scripts/run-matching.sh` starts
2. `src/canonical-match.ts` links obvious SKUs to canonical products
3. `src/llm-match.ts` resolves fuzzy cross-chain matches
4. updated canonical links improve price comparison features

## 10. Architectural Notes

These are the most important characteristics of the current design.

### Shared database architecture

The bot, API, ingest pipeline, and matching jobs all share the same PostgreSQL database directly.

### Fastify is not the single backend gateway

Fastify is the HTTP backend for the Mini App, but not for the bot or ETL.

### ETL is hybrid, not uniform

There is no single extraction path for all chains. The project combines:

- deep-research
- chain-specific parsers
- PDF extraction
- dedicated fetchers
- discovery modules

### Matching is asynchronous

Canonical product linking is not part of the synchronous API or ingest request path. It is a later batch refinement layer.

### Static web hosting and API live in one process

The Fastify server currently acts as both:

- static file host for the Mini App
- REST API for query/preference data

If you want, the next natural step is to turn this into:

1. an exported PNG/SVG diagram
2. a simplified "executive" version for presentations
3. a second document focused only on the ETL/data pipeline
