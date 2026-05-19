-- Seed data: Verona province supermarket chains
INSERT INTO chains (slug, name, website, flyer_url) VALUES
  ('martinelli', 'Supermercati Martinelli', 'https://www.martinelli.it', 'https://www.doveconviene.it/volantino/martinelli'),
  ('lidl', 'Lidl Italia', 'https://www.lidl.it', 'https://www.doveconviene.it/volantino/lidl'),
  ('eurospin', 'Eurospin', 'https://www.eurospin.it', 'https://www.doveconviene.it/volantino/eurospin'),
  ('famila', 'Famila', 'https://www.famila.it', 'https://www.doveconviene.it/volantino/famila'),
  ('conad', 'Conad', 'https://www.conad.it', 'https://www.doveconviene.it/volantino/conad'),
  ('pam', 'Pam Panorama', 'https://www.pampanorama.it', 'https://www.doveconviene.it/volantino/pam'),
  ('despar', 'Despar', 'https://www.despar.it', 'https://www.doveconviene.it/volantino/despar'),
  ('aldi', 'Aldi', 'https://www.aldi.it', 'https://www.doveconviene.it/volantino/aldi'),
  ('rossetto', 'Supermercati Rossetto', 'https://rossettogroup.it', 'https://www.doveconviene.it/volantino/rossetto')
ON CONFLICT (slug) DO NOTHING;
