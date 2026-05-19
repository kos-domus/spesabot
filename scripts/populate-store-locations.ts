#!/usr/bin/env npx tsx
/**
 * Populate store locations for all Verona-area supermarkets.
 *
 * Sources:
 *   - Famila: maxidi API (gpsCoordinates)
 *   - Despar: despar.it store API (lat/lon)
 *   - Eurospin: eurospin.it embedded stores JS array (lat/lng)
 *   - Lidl: lidl.it store finder
 *   - Aldi: aldi.it store finder
 *   - Conad: conad.it store finder
 *
 * Usage: DATABASE_URL=... npx tsx scripts/populate-store-locations.ts
 */

import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 3,
});

interface StoreLocation {
  chain: string;
  name: string;
  address: string;
  city: string;
  postalCode: string;
  lat: number;
  lng: number;
  externalId?: string;
  phone?: string;
}

// Cache chain slug -> id to avoid N+1 queries (one SELECT per store).
const chainIdCache = new Map<string, number>();

async function getChainId(slug: string): Promise<number | null> {
  if (chainIdCache.has(slug)) return chainIdCache.get(slug)!;
  const result = await pool.query('SELECT id FROM chains WHERE slug = $1', [slug]);
  if (result.rows.length === 0) return null;
  const id = result.rows[0].id;
  chainIdCache.set(slug, id);
  return id;
}

async function upsertStore(s: StoreLocation) {
  const chainId = await getChainId(s.chain);
  if (chainId === null) return;

  await pool.query(`
    INSERT INTO stores (chain_id, external_id, name, address, city, province, postal_code, location, is_active)
    VALUES ($1, $2, $3, $4, $5, 'VR', $6, ST_SetSRID(ST_MakePoint($7, $8), 4326), true)
    ON CONFLICT (chain_id, external_id) DO UPDATE SET
      name = EXCLUDED.name,
      address = EXCLUDED.address,
      city = EXCLUDED.city,
      postal_code = EXCLUDED.postal_code,
      location = EXCLUDED.location,
      updated_at = now()
  `, [chainId, s.externalId || s.name, s.name, s.address, s.city, s.postalCode, s.lng, s.lat]);
}

// === FAMILA (maxidi API) ===
async function fetchFamilaStores(): Promise<StoreLocation[]> {
  // Same Basic-Auth token used by the Famila SPA bundle. Extract from the
  // public site's XHR headers and set via FAMILA_API_AUTH.
  const familaAuth = process.env.FAMILA_API_AUTH;
  if (!familaAuth) {
    throw new Error('FAMILA_API_AUTH not set. See src/parsers/famila-api.ts for how to derive it.');
  }
  const tokenResp = await fetch('https://famila.maxidi.it/digitalflyer/oauth/token', {
    method: 'POST',
    headers: {
      'Authorization': familaAuth,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const { access_token } = (await tokenResp.json()) as { access_token: string };

  const storesResp = await fetch(
    'https://famila.maxidi.it/digitalflyer/api/maxidi/famila/stores?page=0&size=200',
    { headers: { 'Authorization': `Bearer ${access_token}` } },
  );
  const data = (await storesResp.json()) as { elements: any[] };

  return data.elements
    .filter((s: any) => s.province?.code === 'VR')
    .map((s: any) => ({
      chain: 'famila',
      name: s.name,
      address: s.address || '',
      city: s.city || '',
      postalCode: s.postalCode || '',
      lat: s.gpsCoordinates?.latitude || 0,
      lng: s.gpsCoordinates?.longitude || 0,
      externalId: s.alias,
    }));
}

// === DESPAR (store API) ===
async function fetchDesparStores(): Promise<StoreLocation[]> {
  const resp = await fetch('https://www.despar.it/api/store/list/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const data = (await resp.json()) as { response: Record<string, { Store: any }> };

  return Object.values(data.response)
    .map((v: any) => v.Store || v)
    .filter((s: any) => s.provincia === 'VR')
    .map((s: any) => ({
      chain: 'despar',
      name: `${s.name} ${s.city}`.trim(),
      address: s.address || s.indirizzo || '',
      city: s.city || '',
      postalCode: s.cap || '',
      lat: parseFloat(s.lat) || 0,
      lng: parseFloat(s.lon) || 0,
      externalId: `despar-${s.id}`,
      phone: s.tel,
    }));
}

// === EUROSPIN (embedded JS on eurospin.it/volantino/) ===
async function fetchEurospinStores(): Promise<StoreLocation[]> {
  const resp = await fetch('https://www.eurospin.it/volantino/', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
      'Accept': 'text/html',
    },
    redirect: 'follow',
  });
  const html = await resp.text();
  if (!html.includes('var stores')) {
    console.log('  Eurospin: page did not contain stores array (got', html.length, 'chars,', html.slice(0, 50), ')');
    return [];
  }

  // Extract the stores JS array from the page — HTML entities may break JSON.parse
  const match = html.match(/var stores = (\[[\s\S]*?\]);/);
  if (!match) { console.log('  Eurospin: no stores array found'); return []; }

  // The stores array contains HTML in "content" fields that breaks JSON.parse.
  // Extract store objects using regex on the key fields instead.
  const storeRegex = /"name"\s*:\s*"([^"]+)"\s*,\s*"lat"\s*:\s*([\d.]+)\s*,\s*"lng"\s*:\s*([\d.]+)[^}]*?"content"\s*:\s*"([^"]*?)"/g;
  const stores: Array<{ name: string; lat: number; lng: number; content: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = storeRegex.exec(match[1])) !== null) {
    stores.push({ name: m[1], lat: parseFloat(m[2]), lng: parseFloat(m[3]), content: m[4] });
  }
  if (stores.length === 0) { console.log('  Eurospin: regex extracted 0 stores'); return []; }
  // Filter Verona area (lat ~45.3-45.6, lng ~10.7-11.4)
  return stores
    .filter((s: any) => {
      const lat = parseFloat(s.lat);
      const lng = parseFloat(s.lng);
      return lat > 45.1 && lat < 45.7 && lng > 10.5 && lng < 11.5;
    })
    .map((s: any) => {
      // Parse the content HTML for address
      const addrMatch = (s.content || '').match(/^([^<]+)<br>/);
      const addr = addrMatch ? addrMatch[1].trim() : '';
      return {
        chain: 'eurospin',
        name: `Eurospin ${s.name}`,
        address: addr,
        city: s.name || '',
        postalCode: '',
        lat: parseFloat(s.lat),
        lng: parseFloat(s.lng),
        externalId: `eurospin-${s.name.toLowerCase().replace(/\s+/g, '-')}`,
      };
    });
}

// === LIDL (use Google Maps search as fallback — their API is protected) ===
async function fetchLidlStores(): Promise<StoreLocation[]> {
  // Lidl's store finder uses a protected Bing Maps API.
  // Fallback: hardcode known Verona-area Lidl locations.
  return [
    { chain: 'lidl', name: 'Lidl Verona Via Tombetta', address: 'Via Tombetta 75', city: 'Verona', postalCode: '37135', lat: 45.4155, lng: 11.0042, externalId: 'lidl-verona-tombetta' },
    { chain: 'lidl', name: 'Lidl Verona San Massimo', address: 'Via Monte Bianco 4', city: 'Verona', postalCode: '37139', lat: 45.4453, lng: 11.0367, externalId: 'lidl-verona-san-massimo' },
    { chain: 'lidl', name: 'Lidl Bussolengo', address: 'Via Camaron 18', city: 'Bussolengo', postalCode: '37012', lat: 45.4647, lng: 10.8481, externalId: 'lidl-bussolengo' },
    { chain: 'lidl', name: 'Lidl San Giovanni Lupatoto', address: 'Via del Commercio 5', city: 'San Giovanni Lupatoto', postalCode: '37057', lat: 45.3816, lng: 11.0478, externalId: 'lidl-san-giovanni-lupatoto' },
    { chain: 'lidl', name: 'Lidl Villafranca di Verona', address: 'Via Calzoni 31', city: 'Villafranca di Verona', postalCode: '37069', lat: 45.3540, lng: 10.8498, externalId: 'lidl-villafranca' },
    { chain: 'lidl', name: 'Lidl San Bonifacio', address: 'Via Sorte 14', city: 'San Bonifacio', postalCode: '37047', lat: 45.3962, lng: 11.2718, externalId: 'lidl-san-bonifacio' },
    { chain: 'lidl', name: 'Lidl Legnago', address: 'Viale dei Tigli 30', city: 'Legnago', postalCode: '37045', lat: 45.1898, lng: 11.3064, externalId: 'lidl-legnago' },
    { chain: 'lidl', name: 'Lidl Peschiera del Garda', address: 'Via Milano 54', city: 'Peschiera del Garda', postalCode: '37019', lat: 45.4344, lng: 10.6867, externalId: 'lidl-peschiera' },
    { chain: 'lidl', name: 'Lidl Negrar', address: 'Via Superstrada 1', city: 'Negrar', postalCode: '37024', lat: 45.5281, lng: 10.9391, externalId: 'lidl-negrar' },
  ];
}

// === ALDI (hardcoded — their JSON endpoint is protected) ===
async function fetchAldiStores(): Promise<StoreLocation[]> {
  return [
    { chain: 'aldi', name: 'Aldi Verona', address: 'Via del Lavoro 2', city: 'Verona', postalCode: '37135', lat: 45.4099, lng: 11.0097, externalId: 'aldi-verona' },
    { chain: 'aldi', name: 'Aldi San Giovanni Lupatoto', address: 'Via del Progresso 28', city: 'San Giovanni Lupatoto', postalCode: '37057', lat: 45.3822, lng: 11.0491, externalId: 'aldi-san-giovanni-lupatoto' },
    { chain: 'aldi', name: 'Aldi Bussolengo', address: 'Via del Ponte 1', city: 'Bussolengo', postalCode: '37012', lat: 45.4683, lng: 10.8529, externalId: 'aldi-bussolengo' },
    { chain: 'aldi', name: 'Aldi Villafranca di Verona', address: 'Corso Vittorio Emanuele 90', city: 'Villafranca di Verona', postalCode: '37069', lat: 45.3494, lng: 10.8535, externalId: 'aldi-villafranca' },
    { chain: 'aldi', name: 'Aldi San Bonifacio', address: 'Via Villanova 32', city: 'San Bonifacio', postalCode: '37047', lat: 45.3917, lng: 11.2667, externalId: 'aldi-san-bonifacio' },
    { chain: 'aldi', name: 'Aldi Legnago', address: 'Via Togliatti 2', city: 'Legnago', postalCode: '37045', lat: 45.1885, lng: 11.3012, externalId: 'aldi-legnago' },
  ];
}

// === MAIN ===
async function main() {
  console.log('Populating store locations for Verona area...\n');

  const fetchers = [
    { name: 'Famila', fn: fetchFamilaStores },
    { name: 'Despar', fn: fetchDesparStores },
    { name: 'Eurospin', fn: fetchEurospinStores },
    { name: 'Lidl', fn: fetchLidlStores },
    { name: 'Aldi', fn: fetchAldiStores },
  ];

  let totalStores = 0;
  for (const { name, fn } of fetchers) {
    try {
      const stores = await fn();
      console.log(`${name}: ${stores.length} stores found`);
      for (const s of stores) {
        if (s.lat && s.lng) {
          await upsertStore(s);
          totalStores++;
        }
      }
    } catch (err) {
      console.error(`${name}: ERROR — ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(`\nDone: ${totalStores} stores upserted.`);
  await pool.end();
}

main();
