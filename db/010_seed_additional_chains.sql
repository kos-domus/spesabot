-- Seed the Shopfully-based chains (MD, CRAI, DPiù, Esselunga) that were added
-- to the registry (stores.yaml) after migration 002 but never backfilled into
-- the chains table. A fresh DB built from migrations alone would fail ingest
-- for any of these with "Chain not found". Idempotent — safe to re-run.

INSERT INTO chains (slug, name, website, flyer_url) VALUES
  ('md',        'MD',        'https://www.mdspa.it',   'https://www.doveconviene.it/volantino/md'),
  ('crai',      'CRAI',      'https://www.crai.it',    'https://www.doveconviene.it/volantino/crai'),
  ('dpiu',      'DPiù',      'https://www.dpiu.com',   'https://www.doveconviene.it/volantino/dpiu'),
  ('esselunga', 'Esselunga', 'https://www.esselunga.it', 'https://www.doveconviene.it/volantino/esselunga')
ON CONFLICT (slug) DO NOTHING;
