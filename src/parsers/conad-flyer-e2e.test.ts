/**
 * End-to-end test: download the real Conad flyer PDF and parse it.
 * Run: npx tsx src/parsers/conad-flyer-e2e.test.ts
 */
import { fetchConadFlyerText } from './conad-flyer-discovery.js';
import { parseConadFlyerText } from './conad-flyer.js';

const url = 'https://www.conad.it/assets/common/volantini/cia/vspazi/SPAZIO_BUSSOLENGO_2609A_SUPERMARCHE_17APR_29APR_WEB.pdf';

async function main() {
  console.log('Downloading PDF...');
  const text = await fetchConadFlyerText(url);
  console.log(`Extracted ${text.length} chars of text\n`);

  const products = parseConadFlyerText(text);
  console.log(`=== Parsed ${products.length} products ===`);
  console.log(`Validity: ${products[0]?.validita_inizio} → ${products[0]?.validita_fine}\n`);

  for (const p of products.slice(0, 25)) {
    const discount = p.sconto_percentuale ? ` (-${p.sconto_percentuale}%)` : '';
    const original = p.prezzo_originale ? ` was €${p.prezzo_originale.toFixed(2)}` : '';
    const brand = p.brand ? ` [${p.brand}]` : '';
    const qty = p.quantita_peso ? ` (${p.quantita_peso})` : '';
    console.log(`  €${p.prezzo_offerta.toFixed(2)}${discount}${original} | ${p.prodotto}${brand}${qty}`);
  }
  console.log('  ...');

  const discounted = products.filter(p => p.sconto_percentuale && p.prezzo_offerta > 0).length;
  const fixed = products.filter(p => !p.sconto_percentuale && p.prezzo_offerta > 0).length;
  const pctOnly = products.filter(p => p.prezzo_offerta === 0).length;
  console.log(`\nBreakdown: ${discounted} discounted, ${fixed} fixed-price, ${pctOnly} %-only`);
}

main().catch(e => { console.error(e); process.exit(1); });
