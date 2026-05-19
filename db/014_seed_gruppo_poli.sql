-- Seed Gruppo Poli banners (Trentino-Alto Adige / Veneto).
--
-- The parent group (gruppopoli.it) runs four brands:
--   - Poli    — main supermarkets, Trentino + Alto Adige
--   - Orvea   — supermarkets, Trentino
--   - Regina  — large-format iperstore (ext-Veneto, hardware-heavy)
--   - Amort   — supermarkets, Alto Adige (German-speaking area)
--
-- Each banner is seeded as its own chain row so offers can be attributed
-- correctly. The shared website is used for all four because Gruppo Poli
-- publishes them under one corporate domain. Per-brand storefronts surface
-- via the /cambia-negozio picker on that site.
--
-- The scraping strategy for these chains is not yet implemented — flyers are
-- behind an ASPX form with ViewState-gated store selection, not accessible via
-- the Shopfully/doveconviene pipeline. The scraper slot should be added as a
-- per-chain parser later. Seeding now so foreign keys + cross-chain views
-- resolve cleanly as soon as the scraper lands.

INSERT INTO chains (slug, name, website, flyer_url) VALUES
  ('poli',   'Supermercati Poli',   'https://www.gruppopoli.it', 'https://www.gruppopoli.it/it/volantino/'),
  ('orvea',  'Supermercati Orvea',  'https://www.gruppopoli.it', 'https://www.gruppopoli.it/it/volantino/'),
  ('regina', 'Regina Iperstore',    'https://www.gruppopoli.it', 'https://www.gruppopoli.it/it/volantino/'),
  ('amort',  'Supermercati Amort',  'https://www.gruppopoli.it', 'https://www.gruppopoli.it/it/volantino/')
ON CONFLICT (slug) DO NOTHING;
