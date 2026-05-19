-- Add Migross chain
INSERT INTO chains (slug, name, website, flyer_url) VALUES
  ('migross', 'Migross', 'https://www.migross.it', 'https://www.migross.it/punti-vendita/nazionale/promozioni')
ON CONFLICT (slug) DO NOTHING;
