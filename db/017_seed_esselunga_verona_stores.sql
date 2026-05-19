-- 017_seed_esselunga_verona_stores.sql
-- Seed Esselunga store rows for the 3 Verona locations. Required for the
-- per-publication store-bound ingest (runner.ts ESSELUNGA_PUBLICATIONS map):
-- different pubids carry partly-overlapping flyers (e.g. "alla Fiera" lists
-- pet food on page 15, "Corso Milano + Fincato" lists flowers there) so
-- offers must be linked to specific stores rather than chain-wide.
--
-- Coordinates verified via Nominatim (OpenStreetMap) on 2026-04-30.
-- external_id mirrors the doveconviene store anchor id, kept for future
-- reverse-lookup if the discovery pipeline ever scrapes per-store pages.

INSERT INTO stores (chain_id, external_id, name, address, city, province, postal_code, location)
SELECT
  c.id,
  v.external_id,
  v.name,
  v.address,
  v.city,
  v.province,
  v.postal_code,
  ST_SetSRID(ST_MakePoint(v.lon, v.lat), 4326)
FROM chains c
CROSS JOIN (VALUES
  ('1020871', 'Esselunga alla Fiera',           'Viale del Lavoro, 15',           'Verona', 'VR', '37135', 10.9811471, 45.4136067),
  ('1216011', 'Esselunga Corso Milano',         'Corso Milano, 100',              'Verona', 'VR', '37138', 10.9572325, 45.4462090),
  ('560805',  'Esselunga via Fincato',          'Via Colonnello Fincato, 296',    'Verona', 'VR', '37131', 11.0195696, 45.4578662)
) AS v(external_id, name, address, city, province, postal_code, lon, lat)
WHERE c.slug = 'esselunga'
ON CONFLICT (chain_id, external_id) DO UPDATE
  SET name        = EXCLUDED.name,
      address     = EXCLUDED.address,
      city        = EXCLUDED.city,
      province    = EXCLUDED.province,
      postal_code = EXCLUDED.postal_code,
      location    = EXCLUDED.location,
      updated_at  = now();
