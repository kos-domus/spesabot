/**
 * Price and quantity normalization for Italian supermarket offers.
 */

export interface ParsedQuantity {
  value: number;
  unit: string;
  baseUnit: 'kg' | 'L' | 'unit';
  baseValue: number;
  confidence: number;
}

const UNIT_MAP: Record<string, { baseUnit: 'kg' | 'L' | 'unit'; multiplier: number }> = {
  kg: { baseUnit: 'kg', multiplier: 1 },
  kilo: { baseUnit: 'kg', multiplier: 1 },
  g: { baseUnit: 'kg', multiplier: 0.001 },
  gr: { baseUnit: 'kg', multiplier: 0.001 },
  grammi: { baseUnit: 'kg', multiplier: 0.001 },
  hg: { baseUnit: 'kg', multiplier: 0.1 },
  etto: { baseUnit: 'kg', multiplier: 0.1 },
  etti: { baseUnit: 'kg', multiplier: 0.1 },
  l: { baseUnit: 'L', multiplier: 1 },
  lt: { baseUnit: 'L', multiplier: 1 },
  litri: { baseUnit: 'L', multiplier: 1 },
  litro: { baseUnit: 'L', multiplier: 1 },
  ml: { baseUnit: 'L', multiplier: 0.001 },
  cl: { baseUnit: 'L', multiplier: 0.01 },
  dl: { baseUnit: 'L', multiplier: 0.1 },
  pz: { baseUnit: 'unit', multiplier: 1 },
  pezzi: { baseUnit: 'unit', multiplier: 1 },
  pezzo: { baseUnit: 'unit', multiplier: 1 },
  rotoli: { baseUnit: 'unit', multiplier: 1 },
  rotolo: { baseUnit: 'unit', multiplier: 1 },
  conf: { baseUnit: 'unit', multiplier: 1 },
  confezione: { baseUnit: 'unit', multiplier: 1 },
  bustine: { baseUnit: 'unit', multiplier: 1 },
  fette: { baseUnit: 'unit', multiplier: 1 },
};

const QUANTITY_PATTERNS: Array<{ regex: RegExp; kind: string }> = [
  // "3x150 g", "12x85 g", "6x1 L"
  { regex: /(\d+)\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*(kg|g|gr|hg|l|lt|ml|cl|dl)\b/i, kind: 'multipack' },
  // "70 g x 8", "400 g x 3", "90 g x3", "200 g x 5 pz" — reverse-order multipack.
  // Must come BEFORE the plain `unit` pattern, otherwise that pattern would
  // greedily match the first `<value><unit>` and drop the multiplier.
  { regex: /(\d+(?:[.,]\d+)?)\s*(kg|g|gr|hg|l|lt|ml|cl|dl)\s*[x×]\s*(\d+)\b/i, kind: 'multipack_reverse' },
  { regex: /(\d+(?:[.,]\d+)?)\s*(kg|g|gr|hg|etto|etti|l|lt|litri|litro|ml|cl|dl)\b/i, kind: 'unit' },
  { regex: /(\d+)\s*(pz|pezzi|pezzo|rotoli|rotolo|bustine|fette)\b/i, kind: 'count' },
  { regex: /conf(?:ezione)?\.?\s+da\s+(\d+)/i, kind: 'conf' },
];

export function parseQuantity(raw: string | null | undefined): ParsedQuantity | null {
  if (!raw) return null;
  const text = raw.toLowerCase().trim();

  for (const { regex, kind } of QUANTITY_PATTERNS) {
    const m = text.match(regex);
    if (!m) continue;

    if (kind === 'multipack') {
      const count = parseInt(m[1]);
      const itemValue = parseFloat(m[2].replace(',', '.'));
      const unitInfo = UNIT_MAP[m[3].toLowerCase()];
      if (!unitInfo) continue;
      const total = count * itemValue;
      return {
        value: total,
        unit: m[3].toLowerCase(),
        baseUnit: unitInfo.baseUnit,
        baseValue: total * unitInfo.multiplier,
        confidence: 0.9,
      };
    }

    if (kind === 'multipack_reverse') {
      const itemValue = parseFloat(m[1].replace(',', '.'));
      const unitInfo = UNIT_MAP[m[2].toLowerCase()];
      const count = parseInt(m[3]);
      if (!unitInfo) continue;
      const total = count * itemValue;
      return {
        value: total,
        unit: m[2].toLowerCase(),
        baseUnit: unitInfo.baseUnit,
        baseValue: total * unitInfo.multiplier,
        confidence: 0.9,
      };
    }

    if (kind === 'unit') {
      const value = parseFloat(m[1].replace(',', '.'));
      const unitInfo = UNIT_MAP[m[2].toLowerCase()];
      if (!unitInfo) continue;
      return {
        value,
        unit: m[2].toLowerCase(),
        baseUnit: unitInfo.baseUnit,
        baseValue: value * unitInfo.multiplier,
        confidence: 0.95,
      };
    }

    if (kind === 'count') {
      const count = parseInt(m[1]);
      return { value: count, unit: 'unit', baseUnit: 'unit', baseValue: count, confidence: 0.9 };
    }

    if (kind === 'conf') {
      const count = parseInt(m[1]);
      return { value: count, unit: 'unit', baseUnit: 'unit', baseValue: count, confidence: 0.8 };
    }
  }

  return null;
}

export function parsePrice(raw: string | number | null | undefined): number | null {
  if (raw == null) return null;
  let text = String(raw).trim();
  text = text.replace(/[€$£]/g, '').trim();

  // "da X,XX" → take minimum
  const daMatch = text.match(/da\s+(\d+[.,]\d+)/i);
  if (daMatch) return parseFloat(daMatch[1].replace(',', '.'));

  // Strip thousand separator (1.299,00 → 1299.00)
  text = text.replace(/(\d)\.(\d{3})([,\s])/g, '$1$2$3');
  text = text.replace(',', '.');

  const m = text.match(/\d+(?:\.\d+)?/);
  if (m) {
    const val = parseFloat(m[0]);
    if (!isNaN(val) && val > 0 && val < 10000) return val;
  }

  return null;
}

export type MechanicType =
  | 'price_cut' | 'percentage_off' | 'sottocosto' | 'three_for_two'
  | 'two_for_price_of_one' | 'second_half_price' | 'loyalty_price'
  | 'n_for_price' | 'multi_buy' | 'unknown';

export interface ParsedMechanic {
  type: MechanicType;
  detail: Record<string, unknown>;
  discountPct: number | null;
  confidence: number;
}

const MECHANIC_PATTERNS: Array<{
  regex: RegExp;
  build: (m: RegExpMatchArray) => ParsedMechanic;
}> = [
  {
    regex: /\b3\s*[x×]\s*2\b|prendi\s+3\s+paghi\s+2/i,
    build: () => ({ type: 'three_for_two', detail: { required: 3, payFor: 2 }, discountPct: 33.3, confidence: 0.98 }),
  },
  {
    regex: /\b2\s*[x×]\s*1\b|prendi\s+2\s+paghi\s+1/i,
    build: () => ({ type: 'two_for_price_of_one', detail: { required: 2, payFor: 1 }, discountPct: 50, confidence: 0.98 }),
  },
  {
    regex: /50\s*%\s+sul\s+secondo|secondo\s+(?:pezzo\s+)?(?:al\s+)?50\s*%/i,
    build: () => ({ type: 'second_half_price', detail: { secondUnitPct: 50 }, discountPct: 25, confidence: 0.95 }),
  },
  {
    regex: /\bcon\s+carta\b|carta\s+fedelt[àa]/i,
    build: () => ({ type: 'loyalty_price', detail: {}, discountPct: null, confidence: 0.95 }),
  },
  {
    regex: /\bsottocosto\b/i,
    build: () => ({ type: 'sottocosto', detail: {}, discountPct: null, confidence: 0.99 }),
  },
  {
    regex: /-\s*(\d+)\s*%|sconto\s+(?:del\s+)?(\d+)\s*%/i,
    build: (m) => {
      const pct = parseInt(m[1] ?? m[2]);
      return { type: 'percentage_off', detail: { pct }, discountPct: pct, confidence: 0.95 };
    },
  },
];

export function parseMechanic(rawText: string | null | undefined, rawDiscount: string | null | undefined): ParsedMechanic {
  const combined = [rawText, rawDiscount].filter(Boolean).join(' ').toLowerCase().trim();
  if (!combined) return { type: 'price_cut', detail: {}, discountPct: null, confidence: 0.7 };

  for (const { regex, build } of MECHANIC_PATTERNS) {
    const m = combined.match(regex);
    if (m) return build(m);
  }

  // Try to parse a bare percentage from rawDiscount
  if (rawDiscount) {
    const m = rawDiscount.match(/(\d+)\s*%/);
    if (m) {
      const pct = parseInt(m[1]);
      return { type: 'percentage_off', detail: { pct }, discountPct: pct, confidence: 0.8 };
    }
  }

  return { type: 'price_cut', detail: {}, discountPct: null, confidence: 0.7 };
}

export function computeUnitPrice(price: number, quantity: ParsedQuantity): number | null {
  if (quantity.baseValue <= 0) return null;
  return Math.round((price / quantity.baseValue) * 10000) / 10000;
}
