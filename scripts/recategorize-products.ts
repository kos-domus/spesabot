#!/usr/bin/env npx tsx
/**
 * Recategorize products currently in 'altro' using Italian keyword rules.
 *
 * Sweeps `products WHERE category = 'altro'`, applies an ordered match
 * dictionary against the product name+brand+description, and updates both
 * `category` (legacy text) and `category_id` (FK to product_categories)
 * when a confident match is found. Products that no rule matches stay
 * in 'altro' — they'll be picked up by the LLM batch script after.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/recategorize-products.ts            # apply
 *   DATABASE_URL=... npx tsx scripts/recategorize-products.ts --dry-run  # preview only
 */

import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });

// Rules ordered from most-specific to most-generic.
// First matching rule wins. Each keyword is matched as a whole word
// (regex \b) on lowercased product.name + brand + description.
//
// Rationale per ordering:
//   - Specific Italian brands/products first (bresaola, parmigiano)
//   - Compound words before generic ones (carta-igienica before carta)
//   - Frozen-ambiguous (gelato → surgelati ONLY if also "industriale";
//     plain "gelato" stays in dolci-snack)
const RULES: { slug: string; keywords: string[] }[] = [
  // Caffè/Tè (specific, low ambiguity)
  { slug: 'caffe-te', keywords: [
    'caffè', 'caffe', 'tè', 'te ', 'tisana', 'infuso', 'camomilla', 'capsule',
    'nespresso', 'lavazza', 'illy', 'segafredo', 'kimbo',
  ]},

  // Salumi (specific, before generic "carne")
  { slug: 'salumi', keywords: [
    'prosciutto', 'salame', 'salami', 'mortadella', 'bresaola', 'salsiccia',
    'salsicce', 'wurstel', 'wurstell', 'speck', 'pancetta', 'guanciale',
    'coppa', 'capocollo', 'culatello', 'finocchiona', 'lonza', 'soppressa',
    'salume',
  ]},

  // Latticini (specific, before generic)
  { slug: 'latticini', keywords: [
    'latte ', 'yogurt', 'formaggio', 'formaggi', 'parmigiano', 'grana padano',
    'mozzarella', 'ricotta', 'burro', 'panna ', 'mascarpone', 'gorgonzola',
    'pecorino', 'stracchino', 'asiago', 'fontina', 'taleggio', 'caciotta',
    'crescenza', 'philadelphia', 'caprese', 'feta',
  ]},

  // Pesce
  { slug: 'pesce', keywords: [
    'tonno', 'salmone', 'branzino', 'gambero', 'gamberi', 'vongole',
    'baccalà', 'baccala', 'merluzzo', 'spigola', 'orata', 'trota', 'sgombro',
    'sardine', 'alici', 'acciughe', 'polpo', 'calamari', 'seppie', 'cozze',
    'pesce ', 'filetti di',
  ]},

  // Carne (after salumi/pesce so prosciutto cotto doesn't fall here)
  { slug: 'carne', keywords: [
    'pollo', 'manzo', 'vitello', 'maiale', 'hamburger', 'bistecca',
    'macinato', 'fettine', 'polpette', 'cotolette', 'arrosto', 'spezzatino',
    'tacchino', 'agnello', 'coniglio', 'carne',
  ]},

  // Pasta (specific)
  { slug: 'pasta', keywords: [
    'spaghetti', 'penne', 'fusilli', 'rigatoni', 'lasagne', 'lasagna',
    'ravioli', 'tortellini', 'gnocchi', 'fettuccine', 'tagliatelle',
    'maccheroni', 'linguine', 'farfalle', 'orecchiette', 'cannelloni',
    'pappardelle', 'pasta ', 'mezze maniche', 'ditalini',
  ]},

  // Riso e cereali
  { slug: 'riso-cereali', keywords: [
    'riso', 'orzo', 'farro', 'quinoa', 'cereali', 'muesli', 'fiocchi',
    'basmati', 'arborio', 'carnaroli', 'avena', 'crusca', 'farina',
    'polenta', 'mais',
  ]},

  // Panificati (specific, before generic "pane")
  { slug: 'panificati', keywords: [
    'pane ', 'focaccia', 'baguette', 'panini', 'tramezzini', 'ciabatta',
    'schiacciata', 'piadina', 'piadine', 'grissini', 'crackers', 'fette biscottate',
    'pancarrè', 'pan carrè', 'pizza ', 'pizze ', 'taralli', 'tarallucci',
    'pangoccioli', 'panettone', 'pandoro', 'colomba', 'brioche', 'cornetti',
  ]},

  // Surgelati (specific)
  { slug: 'surgelati', keywords: [
    'surgelat', 'congelat', 'frozen', 'pizza surgelata', 'minestrone surgelato',
    'verdure surgelate', 'spinaci surgelati',
  ]},

  // Frutta e verdura
  { slug: 'frutta-verdura', keywords: [
    'mela', 'mele ', 'banane', 'banana', 'pomodoro', 'pomodori', 'insalata',
    'carota', 'carote', 'patate', 'cipolla', 'cipolle', 'zucchina', 'zucchine',
    'melanzana', 'melanzane', 'peperone', 'peperoni', 'lattuga', 'spinaci',
    'broccoli', 'cavolo', 'cavolfiore', 'finocchi', 'sedano', 'rucola',
    'radicchio', 'arance', 'arancia', 'limoni', 'limone', 'pere', 'pera',
    'pesche', 'pesca ', 'uva ', 'kiwi', 'fragole', 'mirtilli', 'lamponi',
    'frutta', 'verdura', 'ortaggi', 'aglio', 'porro', 'porri', 'funghi',
    'asparagi', 'fagioli', 'piselli', 'ceci', 'lenticchie',
  ]},

  // Dolci e snack
  { slug: 'dolci-snack', keywords: [
    'cioccolato', 'cioccolata', 'biscotti', 'biscotto', 'merendine',
    'merendina', 'caramelle', 'gelato', 'gelati', 'snack', 'patatine',
    'taralli dolci', 'wafer', 'crackers dolci', 'crostatine', 'plumcake',
    'plum cake', 'kinder', 'nutella', 'crema spalmabile', 'marmellata',
    'confettura', 'dolce', 'dessert', 'budino', 'mou', 'caramella',
    'cioccolatini', 'tavoletta',
  ]},

  // Bevande alcoliche
  { slug: 'bevande-alcoliche', keywords: [
    'vino ', 'vini ', 'birra', 'birre', 'liquore', 'liquori', 'spumante',
    'prosecco', 'grappa', 'whisky', 'whiskey', 'vodka', 'rum ', 'gin',
    'amaro', 'amari', 'aperitivo', 'aperol', 'campari', 'martini',
    'champagne', 'bollicine', 'tequila', 'sambuca', 'limoncello',
  ]},

  // Bevande
  { slug: 'bevande', keywords: [
    'acqua', 'succo', 'succhi', 'bibita', 'bibite', 'cola', 'aranciata',
    'limonata', 'energy drink', 'red bull', 'gatorade', 'powerade',
    'gassosa', 'tonica', 'tonic water', 'chinotto', 'cedrata', 'estathè',
    'lipton', 'thè freddo', 'tè freddo', 'tè in lattina',
  ]},

  // Condimenti
  { slug: 'condimenti', keywords: [
    'olio ', 'olive', 'oliva', 'aceto', 'sale ', 'zucchero', 'salsa',
    'ketchup', 'maionese', 'pepe ', 'peperoncino', 'miele', 'origano',
    'basilico', 'spezie', 'erbe', 'curry', 'paprika', 'curcuma',
    'noce moscata', 'cannella', 'dado', 'brodo', 'capperi', 'tabasco',
    'senape', 'pesto', 'sughi pronti', 'salsa di',
  ]},

  // Cura casa
  { slug: 'cura-casa', keywords: [
    'detersivo', 'detersivi', 'ammorbidente', 'sgrassatore', 'spugna',
    'spugne', 'carta igienica', 'scottex', 'tovaglioli', 'fazzoletti',
    'guanti', 'sacchetti', 'cera', 'lucida', 'anti calcare', 'anticalcare',
    'candeggina', 'svelto', 'fairy', 'pulitore', 'mocio', 'vileda',
    'lavastoviglie', 'lavatrice', 'sapone marsiglia', 'sapone bucato',
  ]},

  // Cura persona
  { slug: 'cura-persona', keywords: [
    'shampoo', 'doccia ', 'dentifricio', 'deodorante', 'crema viso',
    'crema corpo', 'lozione', 'rasoio', 'rasoi', 'profumo', 'colonia',
    'balsamo', 'maschera viso', 'spazzolino', 'collutorio', 'filo interdentale',
    'assorbenti', 'pannolini', 'salviettine', 'baby', 'olio essenziale',
    'cosmetic', 'mascara', 'rossetto', 'fondotinta',
  ]},

  // Animali
  { slug: 'animali', keywords: [
    'cane', 'gatto', 'gattino', 'gattini', 'croccantini', 'pet ',
    'animali', 'whiskas', 'felix', 'cesar', 'pedigree', 'friskies',
    'sheba', 'gourmet ', 'purina', 'monge', 'bocconcini per',
  ]},
];

interface ProductRow {
  id: number;
  name: string;
  brand: string | null;
  description: string | null;
}

function classify(row: ProductRow): string | null {
  const haystack = `${row.name} ${row.brand || ''} ${row.description || ''}`.toLowerCase();
  for (const rule of RULES) {
    for (const kw of rule.keywords) {
      // Whole-word match using a simple boundary regex
      const re = new RegExp(`\\b${kw.replace(/[-\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i');
      if (re.test(haystack)) return rule.slug;
    }
  }
  return null;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  console.log(`[recategorize] mode=${dryRun ? 'DRY-RUN' : 'APPLY'}`);

  // Load category_id map
  const catRes = await pool.query<{ id: number; slug: string }>(
    `SELECT id, slug FROM product_categories`,
  );
  const slugToId = new Map(catRes.rows.map(r => [r.slug, r.id]));

  // Fetch products currently 'altro'
  const productsRes = await pool.query<ProductRow>(
    `SELECT id, name, brand, description FROM products WHERE category = 'altro' ORDER BY id`,
  );
  console.log(`[recategorize] scanning ${productsRes.rows.length} products in 'altro'`);

  // Classify in-memory
  const buckets = new Map<string, number[]>();
  let unmatched = 0;
  for (const row of productsRes.rows) {
    const slug = classify(row);
    if (!slug) { unmatched++; continue; }
    if (!buckets.has(slug)) buckets.set(slug, []);
    buckets.get(slug)!.push(row.id);
  }

  console.log(`\n[recategorize] classification summary:`);
  const sortedBuckets = [...buckets.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [slug, ids] of sortedBuckets) {
    console.log(`  ${slug.padEnd(20)} ${ids.length.toString().padStart(5)} products`);
  }
  console.log(`  ${'(no match)'.padEnd(20)} ${unmatched.toString().padStart(5)} products → stay in 'altro' (LLM fallback)`);
  console.log(`  ${'TOTAL'.padEnd(20)} ${productsRes.rows.length.toString().padStart(5)} products scanned`);

  if (dryRun) {
    console.log(`\n[recategorize] DRY RUN — no DB writes.`);
    return;
  }

  // Apply updates in a single transaction, one batch per category
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [slug, ids] of sortedBuckets) {
      const catId = slugToId.get(slug);
      if (!catId) { console.warn(`  skip ${slug}: no category_id`); continue; }
      const res = await client.query(
        `UPDATE products SET category = $1, category_id = $2, updated_at = NOW()
          WHERE id = ANY($3::int[]) AND category = 'altro'`,
        [slug, catId, ids],
      );
      console.log(`  UPDATE ${slug.padEnd(20)} → ${res.rowCount} rows`);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  console.log(`\n[recategorize] applied. Remaining 'altro' = ${unmatched} (LLM fallback target).`);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => pool.end());
