// Spesify Mini App — sidebar-driven controller.
//
// Rebuilt on 2026-04-23 to match the Apr 17 design (branded home + sidebar nav
// + full screen set). The previous sophisticated UI lived only in dist/webapp/
// and was never committed; a deploy mishap overwrote it. This file + index.html
// restore it and will be committed to git to prevent another loss.

const API = '/api';
const tg = window.Telegram?.WebApp;
const userId = tg?.initDataUnsafe?.user?.id || null;
let userPrefs = { preferred_chains: [], preferred_store_ids: [] };

// product_id → shopping_list_item_id. Populated after every
// /api/shopping-list fetch. Read by productCard() to render the +/✓
// toggle in its current state, and by the toggle click handler to
// decide whether to POST (add) or DELETE (remove).
const shoppingListMap = new Map();

function productToggleIcon(inList) {
  return inList
    ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
    : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
}

// Re-render all visible toggle buttons after the shopping-list map changes
// (e.g. user added/removed via the search panel or the list screen). Avoids
// a full re-render of the product grids — just flips the per-card state.
function refreshAllToggles() {
  document.querySelectorAll('.product-toggle').forEach(btn => {
    const productId = parseInt(btn.dataset.productId, 10);
    if (!productId) return;
    const inList = shoppingListMap.has(productId);
    btn.classList.toggle('is-in-list', inList);
    btn.dataset.inList = inList ? '1' : '0';
    btn.innerHTML = productToggleIcon(inList);
    btn.title = inList ? 'Rimuovi dalla mia lista' : 'Aggiungi alla mia lista';
    btn.setAttribute('aria-label', btn.title);
  });
}

// Topbar title per screen — used when opening the sidebar. The active item
// in #sidebar always matches #topbar-title text.
const SCREEN_TITLES = {
  home:         'spesify',
  search:       'Cerca',
  explore:      'Esplora',
  deals:        'Top Sconti',
  categories:   'Categorie',
  'chain-info': 'Info Catene',
  nearby:       'Vicino a me',
  expiring:     'In scadenza',
  watches:      'La mia spesa',
  'shopping-list': 'La mia spesa',
  stores:       'Negozi',
  cards:        'Carte Fedelta',
  profile:      'Profilo',
  analytics:    'Analytics',
  settings:     'Preferenze',
};

const CATEGORIES = {
  'senza-lattosio': { icon: '\u{1F95B}', label: 'Senza Lattosio' },
  'senza-glutine':  { icon: '\u{1F33E}', label: 'Senza Glutine' },
  'integrale':      { icon: '\u{1F33F}', label: 'Integrale' },
  'bio':            { icon: '\u{1F331}', label: 'Bio' },
  'vegano':         { icon: '\u{1F96C}', label: 'Vegano' },
  'prima-infanzia': { icon: '\u{1F476}', label: 'Baby' },
  'proteico':       { icon: '\u{1F4AA}', label: 'Proteico' },
  'surgelati':      { icon: '\u{1F9CA}', label: 'Surgelati' },
  'cura-casa':      { icon: '\u{1F3E0}', label: 'Casa' },
  'cura-persona':   { icon: '\u{1F9F4}', label: 'Persona' },
};

const CHAIN_ICONS = {
  famila: '\u{1F6D2}', eurospin: '\u{1F4B6}', lidl: '\u{1F3F7}',
  despar: '\u{1F3EA}', aldi: '\u{1F6D2}',   conad: '\u{1F3EA}',
  md: '\u{1F4B0}',     crai: '\u{1F6D2}',   dpiu: '\u{1F6D2}',
  esselunga: '\u{1F6D2}', migross: '\u{1F6D2}', rossetto: '\u{1F6D2}',
  pam: '\u{1F6D2}',    martinelli: '\u{1F6D2}',
  poli: '\u{1F6D2}',   orvea: '\u{1F6D2}',  regina: '\u{1F6D2}',
  amort: '\u{1F6D2}',
};

// Curated chain-info cards. Coverage badge is shown alongside each card name.
// These are stable facts, not scraped data — updated manually as chains evolve.
// Curated chain cards — each has a short paragraph + bullet tips + closing
// footer so the section reads like a real consumer guide, not a stub.
// Verified manually; update as chains change. Not scraped because chain
// identity/positioning is stable.
const CHAIN_INFO = [
  { slug: 'famila',   name: 'Famila',   coverage: 'Regionale',
    blurb: 'Insegna del gruppo Selex, molto forte in Veneto con due formati: Famila Superstore (medio) e Iperfamila (grande).',
    tips: [
      'Selex riunisce 30+ marche (Famila, A&O, Sole365...) con private label in comune: "Vivi", "Saper di Sapori", "Viva la Mamma".',
      'Volantino personalizzato per punto vendita: prezzi e prodotti variano tra Verona, Caldiero, Peschiera, Bovolone, ecc.',
      'Freschi (carne, ortofrutta) gestiti per singolo negozio — prezzi diversi nello stesso giorno sono normali.',
      'Carta Famila: sconti aggiuntivi, accumulo punti, buoni spesa ai traguardi.',
    ],
    footer: 'Ideale per la spesa grande settimanale con ampio assortimento.' },

  { slug: 'conad',    name: 'Conad',    coverage: 'Nazionale',
    blurb: 'Cooperativa italiana di dettaglianti, tra i più grandi gruppi GDO in Italia. Formati: Conad City, Spazio Conad, Conad Superstore, Ipermercato.',
    tips: [
      '"Bassi e Fissi" = ~700 prodotti con prezzo sempre basso tutto l\'anno, non scontato settimanalmente.',
      'Private label "Conad" (base) e "Verso Natura Conad" (bio) con qualità dignitosa a prezzi competitivi.',
      'Carta Insieme: punti, buoni, offerte personalizzate. Quasi sempre conviene farla (gratuita).',
      'In Veneto la cooperativa è CIA (Commercianti Indipendenti Associati): gestisce assortimento locale.',
      'Spazio Conad Bussolengo, Negrar, Dossobuono, Verona hanno volantini separati.',
    ],
    footer: 'Buon equilibrio marca/prezzo, senza rotture di stock tipiche dei discount.' },

  { slug: 'lidl',     name: 'Lidl',     coverage: 'Nazionale',
    blurb: 'Discount tedesco con oltre 700 negozi in Italia. Oltre il 70% dell\'assortimento è private label con qualità verificata da test indipendenti.',
    tips: [
      'App Lidl Plus: coupon esclusivi, ogni 5° acquisto = buono, gratta-e-vinci digitale alla cassa.',
      'Offerte "Bontà di Stagione" cambiano giovedì + lunedì (NON la settimana classica).',
      'Marche proprie note: Deluxe (premium), Freeway (bibite), Combino (pasta), Dulcesol (dolci).',
      'Parade (non-food): elettronica/utensili/tessile a rotazione settimanale, scorte limitate.',
      'Vini premiati al Vinitaly e Gambero Rosso sotto i 5€ — sezione "Cantina".',
    ],
    footer: 'Miglior rapporto qualità/prezzo su alimentare base e surgelati.' },

  { slug: 'eurospin', name: 'Eurospin', coverage: 'Nazionale',
    blurb: 'Discount italiano, capofila del settore. Assortimento ~3.000 referenze (vs ~15.000 di un super classico): pochi marchi per categoria, tutti a prezzo aggressivo.',
    tips: [
      '50+ private label: Land (ortofrutta), Tre Mulini (pane/pasta), Dolciando (dolci), Oro di Parma (conserve).',
      'Volantino MENSILE con prezzi bloccati, non settimanale.',
      'Freschi e surgelati con turnover veloce: poca scorta, ma sempre fresco.',
      'Sezione non-food settimanale: casalinghi, abbigliamento base, giardinaggio.',
    ],
    footer: 'Il più economico del Veneto sulla spesa base, se si conosce l\'assortimento.' },

  { slug: 'despar',   name: 'Despar',   coverage: 'Regionale',
    blurb: 'Gruppo olandese con forte radicamento Nord-Est italiano. Tre formati per dimensione: Despar (piccolo), Eurospar (medio), Interspar (grande).',
    tips: [
      'Linee premium: "Despar Premium" (alta qualità), "Vivi Verde Despar" (bio), "Passo dopo Passo" (solidale).',
      'Ampio assortimento — spesso la scelta per spesa mista completa.',
      'Carta Despar: sconti immediati su ~200 prodotti a settimana.',
      'Stesso gruppo in Austria/Germania, ma assortimento tarato sull\'Italia.',
    ],
    footer: 'Forte su marche famose, meno "best price" ma più comodo.' },

  { slug: 'md',       name: 'MD',       coverage: 'Nazionale',
    blurb: 'Discount italiano (gruppo MDM) con 800+ negozi. Volantino "Maxi Risparmio" esce ogni 2 settimane.',
    tips: [
      'Buona Spesa Card (gratuita): sconti riservati fino a -50% su specifici articoli — l\'app SpesaBot li marca con 🔑.',
      '"Sapori dalla Toscana": selezione carne/salumi a banco.',
      '"Sapori del Mare": sezione ittica più ampia di altri discount.',
      'Segmento bio sotto "Qui c\'è Natura".',
      'Prezzi spesso equivalenti a Eurospin, con più offerte a rotazione.',
    ],
    footer: 'Offerte più aggressive negli ultimi giorni di volantino (scorte da smaltire).' },

  { slug: 'aldi',     name: 'Aldi',     coverage: 'Nazionale',
    blurb: 'Discount tedesco (Aldi Süd), arrivato in Italia nel 2018. Layout essenziale, private label al 90%.',
    tips: [
      'Offerte cambiano 3 volte a settimana: lunedì, giovedì, domenica. Edizioni limitate spariscono in fretta.',
      'Private label principali: Mamia (alimentare), Gut Bio (biologico), Fior di Natura (dolci).',
      '"Regional Selection" con prodotti italiani (pasta Barilla, olio toscano, ecc.).',
      'Imbustaggio a cura del cliente alla cassa — meno costi operativi, prezzi più bassi.',
      'Reso gratuito entro 60 giorni anche senza scontrino (policy internazionale), raro tra i discount.',
    ],
    footer: 'Non-food "di mezzo" (elettronica, casa) spesso un affare.' },

  { slug: 'rossetto', name: 'Rossetto', coverage: 'Locale',
    blurb: 'Catena veronese-vicentina (Rossetto Group), 40+ negozi tra Verona, Vicenza, Mantova, Trento. Due formati: Supermercato e Iperstore.',
    tips: [
      '"Ultima Ora -30%": tutti i giorni tranne la domenica, freschi in scadenza scontati -30% automatico alla cassa.',
      'Forte su macelleria e pescheria al banco, ampia scelta di tagli.',
      'Linea "Rossetto" private label competitiva quotidianamente.',
      'Carta Fedeltà Rossetto: punti + buoni spesa ai traguardi.',
      'Alcuni store hanno "Bistrot" con cucina espressa per piatti pronti.',
    ],
    footer: 'Passaggio serale (19:30+) per massimizzare "Ultima Ora".' },

  { slug: 'migross',  name: 'Migross',  coverage: 'Regionale',
    blurb: 'Gruppo veronese con due formati: Migross Superstore (grandi) e Migross Market/Supermercati (medi). I volantini passano da un\'API pubblica: per noi = dati più puliti.',
    tips: [
      'Superstore = iper, Market = supermercato locale, entrambi con assortimento simile.',
      'Promozioni parallele: Superstore, Market, Grandi Marche, Catalogo Vini, Petstore Buddy.',
      'Carta MIA: sconti aggiuntivi + raccolta punti per buoni spesa.',
      '"Noi Amiamo lo Sport": raccolta buoni per attrezzature sportive da donare alle scuole.',
    ],
    footer: 'I nostri prezzi Migross sono i più affidabili (API ufficiale = 0% errori).' },

  { slug: 'crai',     name: 'CRAI',     coverage: 'Nazionale',
    blurb: 'Gruppo cooperativo italiano. Formati: CRAI (piccolo, di prossimità), Extracrai / Crai Gold (superstore).',
    tips: [
      'Forte presenza in comuni medio-piccoli — a volte l\'unico supermercato nei paesi.',
      'Linee proprie: CraiBio (biologico), EraOra (freschi in scadenza scontati).',
      'Spesso convenzionato con il Comune per sconti residenti.',
    ],
    footer: 'Scelta di prossimità, buona per spese veloci.' },

  { slug: 'dpiu',     name: 'DPiù',     coverage: 'Regionale',
    blurb: 'Discount emiliano (gruppo Dodecà). Focus su prodotti locali nord Italia, private label "DPiù" competitiva.',
    tips: [
      'Carta "Più Club" gratuita: punti + buoni benzina convenzionati.',
      'Volantino settimanale con 200-300 offerte, assortimento più snello dei concorrenti.',
      'Non-food ristretto: concentra sull\'alimentare.',
    ],
    footer: 'Valida alternativa a MD/Eurospin nella fascia discount.' },
];

function escHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
  }[c]));
}

function tmaAuthHeader() {
  const initData = tg?.initData;
  return initData ? { Authorization: `tma ${initData}` } : null;
}

function dbg(msg) { console.log('[Spesify]', msg); }
window.onerror = (m, s, l) => dbg(`ERROR: ${m} at ${s}:${l}`);
window.onunhandledrejection = (e) => dbg(`UNHANDLED: ${e.reason}`);

// ── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  tg?.ready();
  tg?.expand();

  // Sidebar open/close
  const menuBtn = document.getElementById('menu-btn');
  const overlay = document.getElementById('sidebar-overlay');
  if (menuBtn) menuBtn.addEventListener('click', openSidebar);
  if (overlay) overlay.addEventListener('click', closeSidebar);

  // Sidebar item → screen switch
  document.querySelectorAll('.sidebar-item').forEach(item => {
    item.addEventListener('click', () => {
      switchScreen(item.dataset.screen);
      closeSidebar();
    });
  });

  // Home quick-actions: respect optional data-explore-preset which seeds the
  // explore filter state BEFORE switching. Lets each home tile open Esplora
  // pre-configured for a JTBD ("vicino a me", "in scadenza", "categoria").
  document.querySelectorAll('.home-action').forEach(btn => {
    btn.addEventListener('click', () => {
      const preset = btn.dataset.explorePreset;
      switchScreen(btn.dataset.screen);
      if (preset && btn.dataset.screen === 'explore') {
        setExplorePreset(preset);
      }
    });
  });

  // La mia spesa — tab switcher (Prodotti / Parole chiave)
  document.querySelectorAll('[data-ms-tab]').forEach(t => {
    t.addEventListener('click', () => switchSpesaTab(t.dataset.msTab));
  });

  // Negozi & carte — tab switcher (Negozi / Carte / Info Catene)
  document.querySelectorAll('[data-nc-tab]').forEach(t => {
    t.addEventListener('click', () => switchNegoziCarteTab(t.dataset.ncTab));
  });

  // Profilo — tab switcher (Account / Preferenze)
  document.querySelectorAll('[data-pr-tab]').forEach(t => {
    t.addEventListener('click', () => switchProfileTab(t.dataset.prTab));
  });

  // Debounced search
  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    let t;
    searchInput.addEventListener('input', (e) => {
      clearTimeout(t);
      toggleSpinner(true);
      t = setTimeout(() => doSearch(e.target.value).finally(() => toggleSpinner(false)), 350);
    });
  }

  // Nearby: button triggers geolocation + load
  document.getElementById('nearby-locate-btn')?.addEventListener('click', loadNearby);
  document.getElementById('add-watch-btn')?.addEventListener('click', promptAddWatch);
  bindExpiringChips();

  // Owner-only Analytics visibility
  revealAnalyticsIfOwner();

  // Screen initial data (eager: only cheap/small endpoints; deals/search on demand)
  if (userId) loadUserPrefs().catch(e => dbg('prefs FAIL: ' + e));
  loadHomeStats().catch(e => dbg('home FAIL: ' + e));
  loadCategories().catch(e => dbg('categories FAIL: ' + e));
  loadStores().catch(e => dbg('stores FAIL: ' + e));
  loadLoyaltyCards().catch(e => dbg('cards FAIL: ' + e));
  loadChainInfo();
  loadDeals().catch(e => dbg('deals FAIL: ' + e));
  loadSettings().catch(e => dbg('settings FAIL: ' + e));
  loadProfile().catch(e => dbg('profile FAIL: ' + e));
  loadWatches().catch(e => dbg('watches FAIL: ' + e));
  loadShoppingList().catch(e => dbg('shopping-list FAIL: ' + e));
});

function openSidebar()  {
  document.getElementById('sidebar')?.classList.add('open');
  document.getElementById('sidebar-overlay')?.classList.add('open');
}
function closeSidebar() {
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('sidebar-overlay')?.classList.remove('open');
}

function switchScreen(name) {
  if (!name) return;
  // ── Legacy aliases after IA cleanup (12 → 5 drawer voices) ───────────────
  // Old data-screen names still resolve to the unified container they were
  // absorbed into. Preserves muscle memory + external deep-links.
  if (name === 'watches') {
    switchScreen('shopping-list');
    switchSpesaTab('watches');
    return;
  }
  if (name === 'cards') {
    switchScreen('stores');
    switchNegoziCarteTab('cards');
    return;
  }
  if (name === 'chain-info') {
    switchScreen('stores');
    switchNegoziCarteTab('chains');
    return;
  }
  if (name === 'settings') {
    switchScreen('profile');
    switchProfileTab('settings');
    return;
  }
  // Discovery screens absorbed by the universal /api/explore controller.
  if (name === 'search')      {
    switchScreen('explore');
    setExplorePreset('top');
    // User clicked "Cerca" → they want to type. Auto-focus the input after
    // the screen transition settles. Only when empty, so we don't disrupt an
    // ongoing query if they re-enter the same screen.
    requestAnimationFrame(() => {
      const input = document.getElementById('explore-input');
      if (input && !input.value) input.focus({ preventScroll: true });
    });
    return;
  }
  if (name === 'deals')       { switchScreen('explore'); setExplorePreset('top'); return; }
  if (name === 'expiring')    { switchScreen('explore'); setExplorePreset('expiring'); return; }
  if (name === 'nearby')      { switchScreen('explore'); setExplorePreset('nearby'); return; }
  if (name === 'categories')  { switchScreen('explore'); setExplorePreset('category'); return; }
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
  const screen = document.getElementById(`screen-${name}`);
  const item   = document.querySelector(`.sidebar-item[data-screen="${name}"]`);
  if (screen) screen.classList.add('active');
  if (item)   item.classList.add('active');
  const title = document.getElementById('topbar-title');
  if (title) title.textContent = SCREEN_TITLES[name] || 'spesify';
  window.scrollTo(0, 0);
  // Refresh data lazily for screens whose state can change while away
  if (name === 'shopping-list') {
    syncShoppingListViewToggle();
    loadShoppingList().catch(e => dbg('shopping-list reload FAIL: ' + e));
    loadWatches().catch(e => dbg('watches reload FAIL: ' + e));
  }
  if (name === 'explore') {
    bindExploreOnce();
    loadExplore().catch(e => dbg('explore reload FAIL: ' + e));
  }
}

// Per-tab-group scroll memory. Each group remembers the last scrollY for
// every tab the user has visited, so switching back to a tab restores the
// position instead of resetting to top. First visit to a tab → scroll 0.
const _tabScrollMemory = {
  ms: { active: null, byTab: Object.create(null) },
  nc: { active: null, byTab: Object.create(null) },
  pr: { active: null, byTab: Object.create(null) },
};

function switchTabWithScrollMemory(group, tabName, tabAttr, paneAttr) {
  const mem = _tabScrollMemory[group];
  if (mem.active && mem.active !== tabName) mem.byTab[mem.active] = window.scrollY;
  document.querySelectorAll(`[data-${tabAttr}]`).forEach(t => {
    const active = t.getAttribute(`data-${tabAttr}`) === tabName;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  document.querySelectorAll(`[data-${paneAttr}]`).forEach(p => {
    p.style.display = p.getAttribute(`data-${paneAttr}`) === tabName ? '' : 'none';
  });
  mem.active = tabName;
  const y = mem.byTab[tabName] ?? 0;
  // RAF so the pane swap repaints before the scroll, otherwise the browser
  // can clamp scrollY to a position that's invalid for the just-shown pane.
  requestAnimationFrame(() => window.scrollTo(0, y));
}

// La mia spesa — toggle between "products" pane and "watches" pane.
// Both are loaded eagerly on screen entry, so switching is purely visual.
function switchSpesaTab(tabName) {
  switchTabWithScrollMemory('ms', tabName, 'ms-tab', 'ms-pane');
}

// Negozi & carte — toggle between "stores" / "cards" / "chains" panes.
function switchNegoziCarteTab(tabName) {
  switchTabWithScrollMemory('nc', tabName, 'nc-tab', 'nc-pane');
}

// Profilo — toggle between "account" pane and "settings" pane.
function switchProfileTab(tabName) {
  switchTabWithScrollMemory('pr', tabName, 'pr-tab', 'pr-pane');
}

// Transient bottom-center notification. Auto-dismisses after `ms` (default 2400).
// type: 'success' (default, teal) | 'error' (coral). Stacks if called rapidly —
// new toast replaces the previous one to avoid overlap.
let _toastTimer = null;
function showToast(text, type, ms) {
  const duration = ms ?? 2400;
  let el = document.getElementById('app-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'app-toast';
    el.className = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  // Error toasts use assertive so screen readers interrupt; success polite so
  // they don't interrupt ongoing speech. aria-live must be set BEFORE updating
  // textContent for SR to pick up the announcement.
  el.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
  el.textContent = text;
  el.className = 'toast' + (type === 'error' ? ' error' : '');
  void el.offsetWidth;
  el.classList.add('visible');
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.classList.remove('visible'); }, duration);
}

function toggleSpinner(on) {
  // CSS exposes .search-spinner.active to switch from display:none to
  // display:block, so toggle the class — NOT inline style.visibility
  // (and never 'open', which isn't a valid CSS value, was the previous
  // bug that left the spinner permanently invisible).
  const el = document.getElementById('search-spinner');
  if (el) el.classList.toggle('active', !!on);
}

// ── Home ─────────────────────────────────────────────────────────────────────
async function loadHomeStats() {
  try {
    const [statusResp, chainsResp] = await Promise.all([
      fetch(`${API}/status`), fetch(`${API}/chains`),
    ]);
    const status = await statusResp.json();
    const chains = await chainsResp.json();
    const stats = status.database || {};
    // Cache for the explore "Altri filtri" picker — avoids a second /api/chains
    // round-trip when the user opens the chain selector.
    window._homeChainsCache = (chains.chains || [])
      .filter(c => parseInt(c.offerte_attive, 10) > 0);
    const chainsEl = document.getElementById('home-chains');
    if (chainsEl) {
      const active = window._homeChainsCache
        .slice(0, 8)
        .map(c => c.name);
      chainsEl.textContent = active.join(' · ') || '—';
    }
    const statsEl = document.getElementById('home-stats');
    if (statsEl) {
      const n = (x) => Number(x || 0).toLocaleString('it-IT');
      statsEl.innerHTML = `<span>\u{1F4CA} <b>${n(stats.total_offers)}</b> offerte attive · <b>${n(stats.chains_with_offers)}</b> catene · <b>${n(stats.total_skus)}</b> prodotti</span>`;
    }
  } catch {
    const statsEl = document.getElementById('home-stats');
    if (statsEl) statsEl.innerHTML = '<span>⚠️ Statistiche non disponibili</span>';
  }
}

async function loadUserPrefs() {
  const auth = tmaAuthHeader();
  if (!auth) return;
  const resp = await fetch(`${API}/preferences`, { headers: auth });
  if (resp.ok) userPrefs = await resp.json();
}

// ── UI primitives ────────────────────────────────────────────────────────────
function skeletonCards(n = 4) {
  return Array.from({ length: n }, () => `
    <div class="skeleton-card">
      <div class="skeleton-img skeleton-pulse"></div>
      <div class="skeleton-lines">
        <div class="skeleton-line skeleton-pulse"></div>
        <div class="skeleton-line skeleton-pulse"></div>
      </div>
    </div>`).join('');
}
function skeletonTiles(n = 8) {
  return Array.from({ length: n }, () => `<div class="skeleton-tile skeleton-pulse"></div>`).join('');
}
function emptyHTML(icon, text, hint) {
  return `<div class="empty-state">
    <div class="empty-icon">${icon}</div>
    <div class="empty-text">${escHtml(text)}</div>
    ${hint ? `<div class="empty-hint">${escHtml(hint)}</div>` : ''}
  </div>`;
}
function errorHTML(msg) {
  return `<div class="error-state">
    <div class="empty-icon">⚠️</div>
    <div class="empty-text">${escHtml(msg)}</div>
  </div>`;
}

// ── Search ───────────────────────────────────────────────────────────────────
async function doSearch(q) {
  const container = document.getElementById('search-results');
  if (!container) return;
  if (!q || q.length < 2) {
    container.innerHTML = emptyHTML('\u{1F50D}', 'Scrivi almeno 2 caratteri', 'Es: latte, yogurt, pasta');
    return;
  }
  container.innerHTML = skeletonCards(5);
  try {
    const chainsQuery = userPrefs.preferred_chains?.length
      ? `&chains=${userPrefs.preferred_chains.join(',')}` : '';
    const resp = await fetch(`${API}/search?q=${encodeURIComponent(q)}&limit=30${chainsQuery}`);
    const data = await resp.json();
    if (!data.results?.length) {
      container.innerHTML = emptyHTML('\u{1F937}', `Nessun risultato per "${q}"`, 'Prova un altro termine');
      return;
    }
    container.innerHTML = data.results.map(productCard).join('');
  } catch {
    container.innerHTML = errorHTML('Connessione persa. Riprova.');
  }
}

// ── Deals ────────────────────────────────────────────────────────────────────
async function loadDeals() {
  const container = document.getElementById('deals-results');
  if (!container) return;
  container.innerHTML = skeletonCards(6);
  try {
    const resp = await fetch(`${API}/deals/top?limit=20`);
    const data = await resp.json();
    if (!data.results?.length) {
      container.innerHTML = emptyHTML('\u{1F3F7}', 'Nessuna offerta attiva', 'Torna dopo il prossimo aggiornamento');
      return;
    }
    container.innerHTML = data.results.map(productCard).join('');
  } catch {
    container.innerHTML = errorHTML('Impossibile caricare le offerte');
  }
}

// ── Expiring deals ───────────────────────────────────────────────────────────
// Surface offers about to expire so users can decide whether to act now.
// `within_days` window is controlled by the chip group on the screen — clicks
// re-fetch with the new param. Default = 3 days (chosen as the sweet spot
// between "useful urgency" and "too few results"; user can widen to 14).
let expiringWindow = 3;
async function loadExpiring(withinDays = expiringWindow) {
  expiringWindow = withinDays;
  const container = document.getElementById('expiring-results');
  if (!container) return;
  container.innerHTML = skeletonCards(6);
  try {
    const resp = await fetch(`${API}/deals/expiring?within_days=${withinDays}&limit=50`);
    const data = await resp.json();
    if (!data.results?.length) {
      const noun = withinDays === 0 ? 'offerta in scadenza oggi' : `offerta in scadenza nei prossimi ${withinDays} giorni`;
      container.innerHTML = emptyHTML('\u{2705}', `Nessuna ${noun}`, 'Allarga la finestra dai filtri qui sopra');
      return;
    }
    container.innerHTML = data.results.map(productCard).join('');
  } catch {
    container.innerHTML = errorHTML('Impossibile caricare le offerte in scadenza');
  }
}

function bindExpiringChips() {
  const chips = document.querySelectorAll('#expiring-window-chips .window-chip');
  chips.forEach((chip) => {
    chip.addEventListener('click', () => {
      const days = parseInt(chip.getAttribute('data-days') || '3', 10);
      chips.forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      loadExpiring(days);
    });
  });
}

// ── Categories ───────────────────────────────────────────────────────────────
async function loadCategories() {
  const container = document.getElementById('category-tiles');
  if (!container) return;
  container.innerHTML = skeletonTiles(8);
  try {
    const resp = await fetch(`${API}/categorie`);
    const data = await resp.json();
    if (!(data.categorie || []).length) {
      container.innerHTML = emptyHTML('\u{1F4C2}', 'Nessuna categoria');
      return;
    }
    container.innerHTML = data.categorie.map(c => {
      const cat = CATEGORIES[c.tag] || { icon: '\u{1F4E6}', label: c.tag };
      return `<div class="category-tile" role="button" tabindex="0" data-category="${escHtml(c.tag)}" aria-label="Categoria ${escHtml(cat.label)}, ${c.prodotti} prodotti">
        <div class="category-icon" aria-hidden="true">${cat.icon}</div>
        <div class="category-label">${escHtml(cat.label)}</div>
        <div class="category-count">${c.prodotti} prodotti</div>
      </div>`;
    }).join('');
    container.querySelectorAll('.category-tile[data-category]').forEach(tile => {
      const activate = () => loadCategoryProducts(tile.dataset.category);
      tile.addEventListener('click', activate);
      tile.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
      });
    });
  } catch {
    container.innerHTML = errorHTML('Impossibile caricare le categorie');
  }
}
async function loadCategoryProducts(tag) {
  const tiles = document.getElementById('category-tiles');
  const results = document.getElementById('category-results');
  if (!tiles || !results) return;
  const cat = CATEGORIES[tag] || { icon: '\u{1F4E6}', label: tag };
  tiles.style.display = 'none';
  results.style.display = 'block';
  results.innerHTML = skeletonCards(5);
  try {
    const resp = await fetch(`${API}/categoria/${tag}?limit=40`);
    const data = await resp.json();
    const back = `<button class="back-btn" id="cat-back">← Indietro</button><h3>${cat.icon} ${escHtml(cat.label)}</h3>`;
    results.innerHTML = back + ((data.results || []).map(productCard).join('') || emptyHTML('\u{1F4E6}', 'Nessun prodotto'));
    document.getElementById('cat-back')?.addEventListener('click', closeCategoryProducts);
  } catch {
    results.innerHTML = errorHTML('Errore caricamento categoria');
  }
}
function closeCategoryProducts() {
  const tiles = document.getElementById('category-tiles');
  const results = document.getElementById('category-results');
  if (tiles) tiles.style.display = 'grid';
  if (results) results.style.display = 'none';
}

// ── Chain info ───────────────────────────────────────────────────────────────
function loadChainInfo() {
  const container = document.getElementById('chain-info-list');
  if (!container) return;
  container.innerHTML = CHAIN_INFO.map(c => {
    const icon = CHAIN_ICONS[c.slug] || '\u{1F6D2}';
    return `<div class="chain-info-card">
      <div class="card-header">
        <div class="card-name">${icon} ${escHtml(c.name)}</div>
        <div class="card-chain">${escHtml(c.coverage)}</div>
      </div>
      ${c.blurb ? `<p class="hint" style="margin:4px 0 10px">${escHtml(c.blurb)}</p>` : ''}
      <ul>
        ${c.tips.map(t => `<li>${escHtml(t)}</li>`).join('')}
      </ul>
      ${c.footer ? `<p class="hint" style="font-style:italic;margin-top:8px">\u{1F4A1} ${escHtml(c.footer)}</p>` : ''}
    </div>`;
  }).join('');
}

// ── Nearby ───────────────────────────────────────────────────────────────────
async function loadNearby() {
  const container = document.getElementById('nearby-results');
  if (!container) return;
  if (!navigator.geolocation) {
    container.innerHTML = errorHTML('Geolocalizzazione non disponibile');
    return;
  }
  container.innerHTML = '<p class="hint">\u{1F4CD} Localizzando…</p>';
  const timeout = setTimeout(() => {
    if (container.innerHTML.includes('Localizzando')) {
      container.innerHTML = errorHTML('Timeout. Riprova o autorizza la posizione.');
    }
  }, 15000);
  navigator.geolocation.getCurrentPosition(async (pos) => {
    clearTimeout(timeout);
    try {
      const resp = await fetch(`${API}/offers/nearby?lat=${pos.coords.latitude}&lng=${pos.coords.longitude}&radius_km=15&limit=60`);
      const data = await resp.json();
      if (!data.results?.length) {
        container.innerHTML = emptyHTML('\u{1F6D2}', 'Nessuna offerta entro 15 km');
        return;
      }
      container.innerHTML = data.results.map(productCard).join('');
    } catch {
      container.innerHTML = errorHTML('Errore di rete');
    }
  }, (err) => {
    clearTimeout(timeout);
    container.innerHTML = errorHTML(err.code === 1 ? 'Permesso posizione negato' : 'Posizione non disponibile');
  }, { timeout: 15000, maximumAge: 60000 });
}

// ── Watches (notification alerts) ────────────────────────────────────────────
async function loadWatches() {
  const container = document.getElementById('watches-list');
  if (!container) return;
  const auth = tmaAuthHeader();
  if (!auth) {
    container.innerHTML = emptyHTML('\u{1F514}', 'Accedi da Telegram per usare gli avvisi');
    return;
  }
  try {
    const resp = await fetch(`${API}/watches`, { headers: auth });
    const data = await resp.json();
    if (!data.watches?.length) {
      container.innerHTML = emptyHTML('\u{1F514}', 'Nessun avviso attivo', 'Premi "Aggiungi avviso" per crearne uno');
      return;
    }
    container.innerHTML = data.watches.map(w => `
      <div class="store-card">
        <div class="store-info">
          <h4>${escHtml(w.query)}</h4>
          <p>${w.max_price ? 'max €' + Number(w.max_price).toFixed(2) + ' · ' : ''}${escHtml(w.watch_type)}</p>
        </div>
        <button class="store-map-link" data-watch-id="${w.id}" aria-label="Elimina">\u{1F5D1}</button>
      </div>
    `).join('');
    container.querySelectorAll('[data-watch-id]').forEach(b => {
      b.addEventListener('click', () => deleteWatch(parseInt(b.dataset.watchId)));
    });
  } catch {
    container.innerHTML = errorHTML('Impossibile caricare gli avvisi');
  }
}
function promptAddWatch() {
  // Inline form instead of window.prompt — Telegram Mini Apps frequently
  // block native prompts, and we couldn't capture a numeric max_price with
  // a text prompt anyway. The form lives inside #watches-list and disappears
  // on save / cancel.
  const container = document.getElementById('watches-list');
  if (!container) return;
  // Guard against double-click on the "+ Aggiungi avviso" button: if a
  // form is already open, just refocus its first input instead of stacking
  // a duplicate one (which would also break getElementById on shared IDs).
  const existing = document.getElementById('watch-form');
  if (existing) {
    document.getElementById('watch-query')?.focus();
    existing.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }
  const formHtml = `
    <div class="register-form" id="watch-form" style="margin-bottom:16px">
      <h3>Nuovo avviso</h3>
      <div class="form-group">
        <label for="watch-query">Prodotto o parola chiave</label>
        <input id="watch-query" type="text" placeholder="Es. latte senza lattosio" maxlength="100" autocomplete="off">
      </div>
      <div class="form-group">
        <label for="watch-max">Prezzo massimo (€, opzionale)</label>
        <input id="watch-max" type="number" inputmode="decimal" step="0.01" min="0" placeholder="Es. 1.50">
      </div>
      <div class="form-error" id="watch-error"></div>
      <div style="display:flex; gap:8px">
        <button class="register-btn" id="watch-submit" style="flex:1">Crea avviso</button>
        <button class="register-btn" id="watch-cancel" style="flex:0 0 auto; background:transparent; color:var(--teal); border:1px solid var(--teal)">Annulla</button>
      </div>
    </div>`;
  // Prepend the form so it's visible at the top, keeping existing watches below.
  container.insertAdjacentHTML('afterbegin', formHtml);
  document.getElementById('watch-query')?.focus();
  document.getElementById('watch-cancel')?.addEventListener('click', () => {
    document.getElementById('watch-form')?.remove();
  });
  document.getElementById('watch-submit')?.addEventListener('click', async () => {
    const q = document.getElementById('watch-query')?.value.trim();
    const maxStr = document.getElementById('watch-max')?.value.trim();
    const err = document.getElementById('watch-error');
    if (!q || q.length < 2) {
      if (err) { err.textContent = 'Scrivi almeno 2 caratteri'; err.classList.add('visible'); }
      return;
    }
    let max = null;
    if (maxStr) {
      const parsed = parseFloat(maxStr.replace(',', '.'));
      if (!Number.isFinite(parsed) || parsed <= 0) {
        if (err) { err.textContent = 'Prezzo non valido'; err.classList.add('visible'); }
        return;
      }
      max = parsed;
    }
    const btn = document.getElementById('watch-submit');
    if (btn) { btn.disabled = true; btn.textContent = 'Creazione…'; }
    try {
      const { created } = await addWatch(q, max);
      document.getElementById('watch-form')?.remove();
      showToast(created ? '✓ Avviso creato' : '✓ Avviso aggiornato');
    } catch (e) {
      if (err) { err.textContent = 'Errore, riprova'; err.classList.add('visible'); }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Crea avviso'; }
    }
  });
}
async function addWatch(q, maxPrice) {
  const auth = tmaAuthHeader();
  if (!auth) {
    tg?.showAlert?.('Richiede accesso da Telegram');
    throw new Error('no auth');
  }
  const resp = await fetch(`${API}/watches`, {
    method: 'POST',
    headers: { 'Content-Type':'application/json', ...auth },
    body: JSON.stringify({ watch_type: 'keyword', query: q, max_price: maxPrice ?? undefined }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json().catch(() => ({}));
  await loadWatches();
  // `created` is set by the upsert (migration 023): true = new row, false =
  // existing watch had its max_price refreshed. Default to true if missing
  // so older API builds don't break the UX flow.
  return { created: data.created !== false };
}
async function deleteWatch(id) {
  const auth = tmaAuthHeader();
  if (!auth) return;
  try {
    await fetch(`${API}/watches/${id}`, { method: 'DELETE', headers: auth });
    loadWatches();
    showToast('Avviso eliminato');
  } catch { /* ignore */ }
}

// ── Universal Explore ────────────────────────────────────────────────────────
//
// Single screen replacing Cerca + Offerte + In scadenza + Vicino a me +
// Categorie. Filters compose: text query AND chains AND store_ids AND
// expiring_within_days AND nearby AND category. Backend at /api/explore
// returns the productCard()-compatible shape, so rendering reuses existing.

const exploreState = {
  q: '',
  preset: 'top',          // top | expiring | nearby | category | search
  categories: [],         // multi-select, OR semantics ("bio OR vegano")
  chains: [],
  storeIds: [],
  expiringDays: null,
  geo: null,              // { lat, lng, radius_km }
};

const EXPLORE_CATEGORIES = [
  ['senza-lattosio', '\u{1F95B} Senza lattosio'],
  ['senza-glutine',  '\u{1F33E} Senza glutine'],
  ['integrale',      '\u{1F33F} Integrale'],
  ['bio',            '\u{1F331} Bio'],
  ['vegano',         '\u{1F955} Vegano'],
  ['prima-infanzia', '\u{1F37C} Prima infanzia'],
  ['proteico',       '\u{1F4AA} Proteico'],
  ['surgelati',      '\u{1F9CA} Surgelati'],
  ['cura-casa',      '\u{1F9F4} Cura casa'],
  ['cura-persona',   '\u{1F9F4} Cura persona'],
];

let exploreFetchSeq = 0;

async function loadExplore() {
  const container = document.getElementById('explore-results');
  const spinner = document.getElementById('explore-spinner');
  if (!container) return;
  spinner?.classList.add('active');

  const params = new URLSearchParams();
  if (exploreState.q) params.set('q', exploreState.q);
  if (exploreState.chains.length) params.set('chains', exploreState.chains.join(','));
  if (exploreState.storeIds.length) params.set('store_ids', exploreState.storeIds.join(','));
  if (exploreState.expiringDays !== null) params.set('expiring_within_days', String(exploreState.expiringDays));
  if (exploreState.categories.length) params.set('category', exploreState.categories.join(','));
  if (exploreState.geo) {
    params.set('lat', String(exploreState.geo.lat));
    params.set('lng', String(exploreState.geo.lng));
    params.set('radius_km', String(exploreState.geo.radius_km));
  }
  // Sort hint follows the active preset; relevance is auto when q is set.
  if (exploreState.q && exploreState.preset === 'top') params.set('sort', 'relevance');
  else if (exploreState.preset === 'expiring') params.set('sort', 'expiring');
  else params.set('sort', 'discount');
  params.set('limit', '50');

  const seq = ++exploreFetchSeq;
  try {
    const resp = await fetchWithTimeout(`${API}/explore?${params}`, {}, 12000);
    const data = await resp.json().catch(() => ({}));
    if (seq !== exploreFetchSeq) return; // stale response, a newer fetch is in flight
    if (!resp.ok) {
      container.innerHTML = errorHTML(data?.error || `Errore (HTTP ${resp.status})`);
      return;
    }
    const results = data.results || [];
    container.innerHTML = results.length
      ? results.map(productCard).join('')
      : emptyHTML('\u{1F50D}', 'Nessun risultato', 'Prova a rimuovere qualche filtro');
  } catch (e) {
    if (seq !== exploreFetchSeq) return;
    container.innerHTML = errorHTML(e?.name === 'AbortError' ? 'Timeout: il server non risponde' : (e?.message || String(e)));
  } finally {
    if (seq === exploreFetchSeq) spinner?.classList.remove('active');
  }
}

function renderExploreActiveFilters() {
  const host = document.getElementById('explore-active-filters');
  if (!host) return;
  const chips = [];
  if (exploreState.chains.length) {
    exploreState.chains.forEach(c => chips.push({ key: `chain:${c}`, label: `\u{1F6D2} ${c}` }));
  }
  if (exploreState.expiringDays !== null) {
    chips.push({ key: 'expiringDays', label: `\u{23F1} entro ${exploreState.expiringDays}gg` });
  }
  if (exploreState.geo) {
    chips.push({ key: 'geo', label: `\u{1F4CD} ${exploreState.geo.radius_km}km` });
  }
  // One chip per selected category — clicking the X removes only that one.
  exploreState.categories.forEach(cat => {
    const found = EXPLORE_CATEGORIES.find(([k]) => k === cat);
    chips.push({ key: `category:${cat}`, label: found ? found[1] : cat });
  });
  host.innerHTML = chips.map(ch =>
    `<button class="ex-active-chip" data-remove="${escHtml(ch.key)}" type="button">${escHtml(ch.label)} <span class="ex-x">\u{00D7}</span></button>`
  ).join('');
}

function renderExploreCategoryPicker(open) {
  const host = document.getElementById('explore-category-picker');
  if (!host) return;
  if (!open) { host.hidden = true; host.innerHTML = ''; return; }
  host.hidden = false;
  host.innerHTML = EXPLORE_CATEGORIES.map(([k, label]) =>
    `<button class="ex-cat-pill ${exploreState.categories.includes(k) ? 'active' : ''}" data-cat="${escHtml(k)}" type="button">${escHtml(label)}</button>`
  ).join('') + `<button class="ex-cat-pill ex-cat-clear" data-cat="" type="button">\u{2715} Nessuna</button>`;
}

function renderExploreMorePicker(open) {
  const host = document.getElementById('explore-more-picker');
  if (!host) return;
  if (!open) { host.hidden = true; host.innerHTML = ''; return; }
  host.hidden = false;
  // Days input reuses the existing expiring-window-chips look.
  host.innerHTML = `
    <div class="ex-more-block">
      <label class="ex-more-label">Scadenza (entro giorni)</label>
      <div class="ex-more-chips">
        ${[1, 3, 7, 14, 30].map(d =>
          `<button class="ex-more-chip ${exploreState.expiringDays === d ? 'active' : ''}" data-days="${d}" type="button">${d}gg</button>`
        ).join('')}
        <button class="ex-more-chip ${exploreState.expiringDays === null ? 'active' : ''}" data-days="" type="button">qualsiasi</button>
      </div>
    </div>
    <div class="ex-more-block">
      <label class="ex-more-label">Catene</label>
      <div class="ex-more-chips" id="ex-chains-host">${(window._homeChainsCache || []).map(c =>
        `<button class="ex-more-chip ${exploreState.chains.includes(c.slug) ? 'active' : ''}" data-chain="${escHtml(c.slug)}" type="button">${escHtml(c.name || c.slug)}</button>`
      ).join('') || '<span class="hint" style="font-size:11px">Catene non ancora caricate</span>'}</div>
    </div>`;
}

function setExplorePreset(name) {
  // Toggle visual active state on the preset row regardless of side-effects.
  document.querySelectorAll('.ex-preset').forEach(b => {
    const active = b.dataset.preset === name;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', active ? 'true' : 'false');
    // Reflect the active category in the "Categoria" preset label so the user
    // always sees which category is filtering (e.g. "🏷️ Bio" instead of the
    // generic "🏷️ Categoria"). Resets to the generic label when no category.
    if (b.dataset.preset === 'category') {
      // Multi-select: when 1 cat selected, show its name; when N>1, show count.
      // When none, generic "🏷️ Categoria".
      const cats = exploreState.categories;
      if (cats.length === 1) {
        const found = EXPLORE_CATEGORIES.find(([k]) => k === cats[0]);
        b.textContent = found ? found[1] : '\u{1F3F7}\u{FE0F} ' + cats[0];
      } else if (cats.length > 1) {
        b.textContent = `\u{1F3F7}\u{FE0F} Categorie (${cats.length})`;
      } else {
        b.textContent = '\u{1F3F7}\u{FE0F} Categoria';
      }
    }
  });

  // 'category' and 'more' open sub-pickers without changing the result query.
  if (name === 'category') {
    renderExploreCategoryPicker(true);
    renderExploreMorePicker(false);
    return;
  }
  if (name === 'more') {
    renderExploreMorePicker(true);
    renderExploreCategoryPicker(false);
    return;
  }
  renderExploreCategoryPicker(false);
  renderExploreMorePicker(false);

  exploreState.preset = name;
  if (name === 'top') {
    exploreState.expiringDays = null;
    exploreState.geo = null;
  } else if (name === 'expiring') {
    exploreState.expiringDays = exploreState.expiringDays ?? 7;
    exploreState.geo = null;
  } else if (name === 'nearby') {
    exploreState.expiringDays = null;
    requestExploreGeo().catch(e => dbg('explore geo FAIL: ' + e));
    return; // geo will reload after permission resolves
  }
  renderExploreActiveFilters();
  loadExplore();
}

async function requestExploreGeo() {
  if (!navigator.geolocation) {
    showToast('Geolocalizzazione non disponibile', 'error');
    return;
  }
  const pos = await new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 8000, maximumAge: 60_000 });
  }).catch(err => {
    showToast('Permesso posizione negato', 'error');
    throw err;
  });
  exploreState.geo = {
    lat: +pos.coords.latitude.toFixed(5),
    lng: +pos.coords.longitude.toFixed(5),
    radius_km: 20,
  };
  renderExploreActiveFilters();
  loadExplore();
}

function bindExploreOnce() {
  // Idempotent — DOMContentLoaded calls this once at boot.
  const input = document.getElementById('explore-input');
  if (input && !input.dataset.bound) {
    input.dataset.bound = '1';
    let t;
    input.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        exploreState.q = input.value.trim();
        loadExplore();
      }, 300);
    });
  }
  document.querySelectorAll('.ex-preset').forEach(b => {
    if (b.dataset.bound) return;
    b.dataset.bound = '1';
    b.addEventListener('click', () => setExplorePreset(b.dataset.preset));
  });
}

// Delegated handlers for active-filter removal + sub-picker selection.
document.addEventListener('click', (e) => {
  const removeBtn = e.target.closest('.ex-active-chip');
  if (removeBtn) {
    const key = removeBtn.dataset.remove || '';
    let categoryRemoved = false;
    if (key.startsWith('chain:')) {
      const slug = key.slice(6);
      exploreState.chains = exploreState.chains.filter(c => c !== slug);
    } else if (key === 'expiringDays') exploreState.expiringDays = null;
    else if (key === 'geo')           exploreState.geo = null;
    else if (key.startsWith('category:')) {
      const cat = key.slice('category:'.length);
      exploreState.categories = exploreState.categories.filter(c => c !== cat);
      categoryRemoved = true;
    }
    renderExploreActiveFilters();
    // Refresh preset row to reflect current category count (label + highlight).
    if (categoryRemoved) {
      setExplorePreset(exploreState.categories.length > 0 ? 'category' : 'top');
    }
    loadExplore();
    return;
  }
  const catPill = e.target.closest('.ex-cat-pill');
  if (catPill) {
    const cat = catPill.dataset.cat || '';
    if (cat === '') {
      // "✕ Nessuna" clears all
      exploreState.categories = [];
      renderExploreCategoryPicker(false);
    } else {
      // Toggle add/remove. Keep picker OPEN so the user can pick more.
      const idx = exploreState.categories.indexOf(cat);
      if (idx >= 0) exploreState.categories.splice(idx, 1);
      else exploreState.categories.push(cat);
      // Re-render picker to update active state on the pills (no close)
      renderExploreCategoryPicker(true);
    }
    setExplorePreset(exploreState.categories.length > 0 ? 'category' : 'top');
    renderExploreActiveFilters();
    loadExplore();
    return;
  }
  const moreChip = e.target.closest('.ex-more-chip');
  if (moreChip) {
    if (moreChip.dataset.days !== undefined) {
      const d = moreChip.dataset.days;
      exploreState.expiringDays = d === '' ? null : parseInt(d, 10);
    } else if (moreChip.dataset.chain) {
      const slug = moreChip.dataset.chain;
      if (exploreState.chains.includes(slug)) {
        exploreState.chains = exploreState.chains.filter(c => c !== slug);
      } else {
        exploreState.chains.push(slug);
      }
    }
    renderExploreMorePicker(true);  // re-render to flip active state
    renderExploreActiveFilters();
    loadExplore();
    return;
  }
});

// ── Stores ───────────────────────────────────────────────────────────────────
async function loadStores() {
  const container = document.getElementById('stores-list');
  if (!container) return;
  container.innerHTML = skeletonCards(6);
  try {
    const resp = await fetch(`${API}/stores`);
    const data = await resp.json();
    if (!data.stores?.length) {
      container.innerHTML = emptyHTML('\u{1F3EA}', 'Nessun negozio trovato');
      return;
    }
    const byChain = {};
    data.stores.forEach(s => { (byChain[s.chain_name] ||= []).push(s); });
    let html = '';
    for (const [chain, stores] of Object.entries(byChain)) {
      const realCount = stores.filter(s => !s.is_national).length;
      const nationalCount = stores.length - realCount;
      const countLabel = realCount > 0
        ? `(${realCount}${nationalCount ? ' + nazionale' : ''})`
        : '(rete nazionale)';
      html += `<h3>${escHtml(chain)} ${countLabel}</h3>`;
      html += stores.map(s => {
        if (s.is_national) {
          return `<div class="store-card store-card-national">
            <div class="store-info">
              <h4>\u{1F310} ${escHtml(s.name)}</h4>
              <p>Offerte valide in tutti i punti vendita</p>
            </div>
          </div>`;
        }
        const mapsUrl = s.lat && s.lng
          ? `https://www.google.com/maps/search/?api=1&query=${s.lat},${s.lng}` : '#';
        return `<div class="store-card">
          <div class="store-info">
            <h4>${escHtml(s.name)}</h4>
            <p>${escHtml(s.address || '')}${s.address ? ', ' : ''}${escHtml(s.city)}${s.postal_code ? ' ' + escHtml(s.postal_code) : ''}</p>
          </div>
          <a href="${mapsUrl}" target="_blank" rel="noopener" class="store-map-link">\u{1F4CD}</a>
        </div>`;
      }).join('');
    }
    container.innerHTML = html;
  } catch {
    container.innerHTML = errorHTML('Impossibile caricare i negozi');
  }
}

// ── Loyalty cards ────────────────────────────────────────────────────────────
async function loadLoyaltyCards() {
  const container = document.getElementById('loyalty-cards');
  if (!container) return;
  container.innerHTML = skeletonCards(4);
  try {
    const resp = await fetch(`${API}/loyalty`);
    const data = await resp.json();
    const programs = data.programs || [];
    if (!programs.length) {
      container.innerHTML = emptyHTML('\u{1F4B3}', 'Nessun programma fedelta configurato');
      return;
    }
    container.innerHTML = programs.map(p => {
      const icon = CHAIN_ICONS[p.slug] || '\u{1F4B3}';
      const appBtn = p.loyalty_app_url
        ? `<a href="${escHtml(p.loyalty_app_url)}" target="_blank" rel="noopener" class="card-app-btn">App</a>` : '';
      const signupBtn = p.loyalty_signup_url
        ? `<a href="${escHtml(p.loyalty_signup_url)}" target="_blank" rel="noopener" class="card-signup-btn">Iscriviti</a>` : '';
      return `<div class="loyalty-card">
        <div class="card-header">
          <div class="card-name">${icon} ${escHtml(p.name)}</div>
          <div class="card-chain">${escHtml(p.loyalty_card_name || 'Carta fedelta')}</div>
        </div>
        <div class="card-offers">${p.offerte_carta || 0} offerte esclusive</div>
        <div class="card-actions">${appBtn}${signupBtn}</div>
      </div>`;
    }).join('');
  } catch {
    container.innerHTML = errorHTML('Impossibile caricare le carte fedelta');
  }
}

// ── Profile ──────────────────────────────────────────────────────────────────
async function loadProfile() {
  const container = document.getElementById('profile-content');
  if (!container) return;
  container.innerHTML = skeletonCards(2);
  try {
    // Send auth if we have it — the endpoint returns {authenticated: false}
    // instead of 401 when absent, so we still get a renderable response.
    const auth = tmaAuthHeader() || {};
    const resp = await fetch(`${API}/profile`, { headers: auth });
    const data = await resp.json().catch(() => ({}));
    if (data.authenticated && data.registered && data.profile) {
      container.innerHTML = renderProfileCard(data.profile);
      return;
    }
    if (data.authenticated === false) {
      // User has no valid Telegram initData — show register form anyway
      // (submit will 401 if still unauthenticated, with a clear message).
      container.innerHTML = `
        <div class="hint" style="margin-bottom:12px">
          \u{26A0}\u{FE0F} Apri l'app dal bot Telegram per creare/modificare il tuo profilo.
        </div>` + renderRegisterForm();
      bindRegisterForm();
      return;
    }
    // Authenticated but not registered → pure register form.
    container.innerHTML = renderRegisterForm();
    bindRegisterForm();
  } catch (e) {
    container.innerHTML = errorHTML('Impossibile caricare il profilo — riprova');
  }
}
function renderRegisterForm() {
  return `
    <div class="register-form">
      <h3>Crea il tuo profilo</h3>
      <p class="hint">Imposta username ed email per salvare le preferenze e ricevere avvisi.</p>
      <div class="form-group">
        <label for="reg-display">Nome visualizzato</label>
        <input id="reg-display" type="text" placeholder="Mario Rossi" maxlength="50">
      </div>
      <div class="form-group">
        <label for="reg-username">Username</label>
        <input id="reg-username" type="text" placeholder="mario_r" minlength="3" maxlength="30">
      </div>
      <div class="form-group">
        <label for="reg-email">Email</label>
        <input id="reg-email" type="email" placeholder="mario@example.com">
      </div>
      <div class="form-error" id="reg-error"></div>
      <button class="register-btn" id="reg-submit">Registrati</button>
    </div>`;
}
function bindRegisterForm() {
  const btn = document.getElementById('reg-submit');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const username = document.getElementById('reg-username')?.value.trim();
    const email = document.getElementById('reg-email')?.value.trim();
    const display = document.getElementById('reg-display')?.value.trim();
    const err = document.getElementById('reg-error');
    const setErr = (msg) => { if (err) { err.textContent = msg; err.classList.add('visible'); } };
    if (err) err.classList.remove('visible');
    if (!username || !email) { setErr('Username ed email obbligatori'); return; }
    btn.disabled = true; btn.textContent = 'Registrazione…';
    const auth = tmaAuthHeader();
    try {
      const resp = await fetch(`${API}/profile/register`, {
        method: 'POST',
        headers: { 'Content-Type':'application/json', ...(auth || {}) },
        body: JSON.stringify({ username, email, display_name: display || undefined }),
      });
      if (!resp.ok) {
        const j = await resp.json().catch(() => ({}));
        setErr(j.error || (resp.status === 401
          ? 'Apri l\'app dal bot Telegram per registrarti'
          : 'Errore registrazione'));
        return;
      }
      loadProfile();
    } catch {
      setErr('Errore di rete');
    } finally {
      btn.disabled = false; btn.textContent = 'Registrati';
    }
  });
}
function renderProfileCard(p) {
  const initial = (p.display_name || p.username || '?').charAt(0).toUpperCase();
  const prefChains = (p.preferred_chains || []).length || 'tutti';
  const prefStores = (p.preferred_store_ids || []).length || 'tutti';
  return `
    <div class="profile-card">
      <div class="profile-avatar">${escHtml(initial)}</div>
      <div class="profile-name">${escHtml(p.display_name || p.username)}</div>
      ${p.username ? `<div class="profile-username">@${escHtml(p.username)}</div>` : ''}
      ${p.email    ? `<div class="profile-email">${escHtml(p.email)}</div>` : ''}
      <div class="profile-stat-row">
        <div class="profile-stat">
          <div class="profile-stat-value">${prefChains}</div>
          <div class="profile-stat-label">Catene</div>
        </div>
        <div class="profile-stat">
          <div class="profile-stat-value">${prefStores}</div>
          <div class="profile-stat-label">Negozi</div>
        </div>
      </div>
      <div class="profile-actions">
        <button class="profile-edit-btn" onclick="switchScreen('settings')">Modifica preferenze</button>
      </div>
    </div>`;
}
window.switchScreen = switchScreen; // expose for inline handlers

// ── Analytics (owner only) ───────────────────────────────────────────────────
async function revealAnalyticsIfOwner() {
  // Owner id comes from the API's /api/analytics/summary — if we get a non-error
  // response, surface the nav item and prefetch the dashboard.
  const auth = tmaAuthHeader();
  if (!auth) return;
  try {
    const resp = await fetch(`${API}/analytics/summary?days=1`, { headers: auth });
    const data = await resp.json();
    if (data && !data.error) {
      document.getElementById('analytics-nav')?.style.setProperty('display', '');
      loadAnalytics().catch(e => dbg('analytics FAIL: ' + e));
    }
  } catch { /* ignore */ }
}
async function loadAnalytics() {
  const container = document.getElementById('analytics-content');
  if (!container) return;
  container.innerHTML = skeletonCards(3);
  const auth = tmaAuthHeader();
  try {
    const resp = await fetch(`${API}/analytics/summary?days=7`, { headers: auth || {} });
    const data = await resp.json();
    if (data.error) { container.innerHTML = errorHTML('Accesso riservato'); return; }
    container.innerHTML = renderAnalytics(data);
  } catch {
    container.innerHTML = errorHTML('Errore caricamento analytics');
  }
}

// Event-type → display label + brand-palette colour. Order matters: it controls
// stack order in the chart and row order in the breakdown.
const ANALYTICS_EVENT_META = {
  screen_view: { label: 'Schermate',   color: '#2d6b6b' },
  search:      { label: 'Ricerche',    color: '#e8735a' },
  app_open:    { label: 'Aperture',    color: '#2d8b5a' },
  bot_start:   { label: 'Bot start',   color: '#b5d8d8' },
  test:        { label: 'Test',        color: '#cbd5d5' },
};
function eventMeta(type) {
  return ANALYTICS_EVENT_META[type] || { label: type, color: '#9aaaaa' };
}

function formatItDay(iso) {
  // iso = 'YYYY-MM-DD' from Postgres ::text. Avoid Date() — it may shift TZ.
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  return `${m[3]}/${m[2]}`;
}
function formatItRange(firstIso, lastIso) {
  const months = ['gennaio','febbraio','marzo','aprile','maggio','giugno','luglio','agosto','settembre','ottobre','novembre','dicembre'];
  const a = String(firstIso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const b = String(lastIso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!a || !b) return '';
  const aMon = months[parseInt(a[2], 10) - 1];
  const bMon = months[parseInt(b[2], 10) - 1];
  if (a[2] === b[2]) return `${parseInt(a[3],10)} – ${parseInt(b[3],10)} ${bMon}`;
  return `${parseInt(a[3],10)} ${aMon} – ${parseInt(b[3],10)} ${bMon}`;
}

// Italian day-of-week abbreviation (lun, mar, mer, gio, ven, sab, dom).
function formatItDow(iso) {
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  const dow = new Date(`${iso}T12:00:00Z`).getUTCDay();
  return ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'][dow] || '';
}

// One row per day: weekday + dd/MM · fill bar (width % of dayMax) · count.
// Same shape as event-breakdown rows so it renders reliably on every webview.
function renderDailyChart(byDay, days) {
  const today = new Date();
  const dayKeys = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    dayKeys.push(d.toISOString().slice(0, 10));
  }
  const byDayMap = new Map();
  for (const r of byDay) {
    const cur = byDayMap.get(r.day) || {};
    // Postgres BIGINT comes back as a string; coerce or `+` becomes string concat.
    cur[r.event_type] = (cur[r.event_type] || 0) + (Number(r.events) || 0);
    byDayMap.set(r.day, cur);
  }
  const dayTotals = dayKeys.map(k => ({
    day: k,
    total: Object.values(byDayMap.get(k) || {}).reduce((a, b) => a + b, 0),
    types: byDayMap.get(k) || {},
  }));
  const dayMax = Math.max(1, ...dayTotals.map(d => d.total));
  const isToday = iso => iso === today.toISOString().slice(0, 10);

  const rows = dayTotals.map(d => {
    const widthPct = (d.total / dayMax) * 100;
    const empty = d.total === 0;
    return `<div class="day-bar-row${isToday(d.day) ? ' day-bar-today' : ''}">
      <span class="day-bar-label">
        <span class="day-bar-dow">${formatItDow(d.day)}</span>
        <span class="day-bar-date">${formatItDay(d.day)}</span>
      </span>
      <div class="day-bar-track">
        <div class="day-bar-fill ${empty ? 'is-empty' : ''}" style="width:${widthPct.toFixed(2)}%"></div>
      </div>
      <span class="day-bar-count ${empty ? 'is-empty' : ''}">${d.total}</span>
    </div>`;
  }).join('');

  return `<div class="chart-card">${rows}</div>`;
}

function renderEventBreakdown(byDay) {
  const totals = {};
  for (const r of byDay) totals[r.event_type] = (totals[r.event_type] || 0) + (Number(r.events) || 0);
  const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return '';
  const max = entries[0][1];
  const grand = entries.reduce((acc, [, v]) => acc + v, 0);
  const rows = entries.map(([type, n]) => {
    const { label, color } = eventMeta(type);
    const pct = grand ? Math.round((n / grand) * 100) : 0;
    const widthPct = max ? (n / max) * 100 : 0;
    return `<div class="bar-row">
      <div class="bar-row-head">
        <span class="bar-row-label"><span class="legend-dot" style="background:${color}"></span>${escHtml(label)}</span>
        <span class="bar-row-meta"><b>${n}</b><span class="bar-row-pct">${pct}%</span></span>
      </div>
      <div class="bar-track"><div class="bar-fill" style="width:${widthPct.toFixed(1)}%;background:${color}"></div></div>
    </div>`;
  }).join('');
  return `<div class="analytics-section"><h3 class="analytics-h3">Tipi di evento</h3>${rows}</div>`;
}

function renderTopSearches(topSearches) {
  if (!topSearches.length) return '';
  const max = topSearches[0].count || 1;
  const rows = topSearches.map((s, i) => {
    const widthPct = (s.count / max) * 100;
    return `<div class="rank-row">
      <span class="rank-num">${i + 1}</span>
      <div class="rank-body">
        <div class="rank-head">
          <span class="rank-q">${escHtml(s.query || '—')}</span>
          <span class="rank-n">${s.count}</span>
        </div>
        <div class="bar-track"><div class="bar-fill" style="width:${widthPct.toFixed(1)}%;background:var(--coral)"></div></div>
      </div>
    </div>`;
  }).join('');
  return `<div class="analytics-section"><h3 class="analytics-h3">Ricerche più frequenti</h3>${rows}</div>`;
}

function renderAnalytics(data) {
  const t = data.totals || {};
  const days = data.days || 7;
  const byDay = data.by_day || [];
  const topSearches = data.top_searches || [];

  // Build period label "21 – 27 aprile" from the day window.
  const today = new Date();
  const last = today.toISOString().slice(0, 10);
  const firstD = new Date(today); firstD.setDate(firstD.getDate() - (days - 1));
  const first = firstD.toISOString().slice(0, 10);

  const header = `
    <div class="analytics-header">
      <div class="analytics-period">Ultimi ${days} giorni</div>
      <div class="analytics-range">${formatItRange(first, last)}</div>
    </div>`;

  const kpis = `
    <div class="analytics-kpis">
      <div class="kpi-card kpi-hero">
        <div class="kpi-value">${(t.total_events ?? 0).toLocaleString('it-IT')}</div>
        <div class="kpi-label">Eventi totali</div>
      </div>
      <div class="kpi-card"><div class="kpi-value">${t.total_sessions ?? 0}</div><div class="kpi-label">Sessioni</div></div>
      <div class="kpi-card"><div class="kpi-value">${t.total_users ?? 0}</div><div class="kpi-label">Utenti</div></div>
      <div class="kpi-card"><div class="kpi-value">${t.total_ips ?? 0}</div><div class="kpi-label">IP unici</div></div>
    </div>`;

  const chartBlock = byDay.length
    ? `<div class="analytics-section"><h3 class="analytics-h3">Andamento giornaliero</h3>${renderDailyChart(byDay, days)}</div>`
    : '';

  return header + kpis + chartBlock + renderEventBreakdown(byDay) + renderTopSearches(topSearches);
}

// ── Settings ─────────────────────────────────────────────────────────────────
async function loadSettings() {
  try {
    const chainsResp = await fetch(`${API}/chains`);
    const chainsData = await chainsResp.json();
    const chainToggles = document.getElementById('chain-toggles');
    if (chainToggles) {
      chainToggles.innerHTML = (chainsData.chains || []).map(c => {
        const active = !userPrefs.preferred_chains?.length || userPrefs.preferred_chains.includes(c.slug);
        return `<div class="toggle-row ${active ? 'active' : ''}" data-chain-slug="${escHtml(c.slug)}">
          <div>
            <span class="toggle-label">${escHtml(c.name)}</span>
            <span class="toggle-count">${c.offerte_attive} offerte</span>
          </div>
          <div class="toggle-check">${active ? '✓' : ''}</div>
        </div>`;
      }).join('');
      chainToggles.querySelectorAll('.toggle-row[data-chain-slug]').forEach(row => {
        row.addEventListener('click', () => toggleChain(row.dataset.chainSlug, row));
      });
    }

    const storesResp = await fetch(`${API}/stores`);
    const storesData = await storesResp.json();
    const storeToggles = document.getElementById('store-toggles');
    if (!storeToggles) return;
    const byChain = {};
    (storesData.stores || []).forEach(s => { (byChain[s.chain] ||= []).push(s); });
    let html = '';
    for (const [chain, stores] of Object.entries(byChain)) {
      html += `<h4 style="margin:12px 0 4px;font-size:13px;color:var(--hint)">${escHtml(stores[0]?.chain_name || chain)}</h4>`;
      html += stores.map(s => {
        if (s.is_national) {
          return `<div class="toggle-row toggle-row-national">
            <div>
              <span class="toggle-label">\u{1F310} ${escHtml(s.name)}</span>
              <span class="toggle-count">valido in tutti i punti vendita</span>
            </div>
          </div>`;
        }
        const active = !userPrefs.preferred_store_ids?.length || userPrefs.preferred_store_ids.includes(s.id);
        return `<div class="toggle-row ${active ? 'active' : ''}" data-store-id="${s.id}">
          <div>
            <span class="toggle-label">${escHtml(s.name)}</span>
            <span class="toggle-count">${escHtml(s.city)}</span>
          </div>
          <div class="toggle-check">${active ? '✓' : ''}</div>
        </div>`;
      }).join('');
    }
    storeToggles.innerHTML = html;
    storeToggles.querySelectorAll('.toggle-row[data-store-id]').forEach(row => {
      row.addEventListener('click', () => toggleStore(parseInt(row.dataset.storeId), row));
    });
  } catch {
    const el = document.getElementById('chain-toggles');
    if (el) el.innerHTML = errorHTML('Impossibile caricare le preferenze');
  }
}

async function toggleChain(slug, row) {
  row.classList.toggle('active');
  const check = row.querySelector('.toggle-check');
  if (check) check.textContent = row.classList.contains('active') ? '✓' : '';
  const active = Array.from(document.querySelectorAll('#chain-toggles .toggle-row.active'))
    .map(r => r.dataset.chainSlug).filter(Boolean);
  const total = document.querySelectorAll('#chain-toggles .toggle-row[data-chain-slug]').length;
  userPrefs.preferred_chains = active.length === total ? [] : active;
  await savePreferences();
  loadDeals().catch(() => {});
}

async function toggleStore(id, row) {
  row.classList.toggle('active');
  const check = row.querySelector('.toggle-check');
  if (check) check.textContent = row.classList.contains('active') ? '✓' : '';
  const active = Array.from(document.querySelectorAll('#store-toggles .toggle-row.active'))
    .map(r => parseInt(r.dataset.storeId)).filter(Number.isFinite);
  const total = document.querySelectorAll('#store-toggles .toggle-row[data-store-id]').length;
  userPrefs.preferred_store_ids = active.length === total ? [] : active;
  await savePreferences();
}

async function savePreferences() {
  const auth = tmaAuthHeader();
  if (!auth) return;
  try {
    await fetch(`${API}/preferences`, {
      method: 'POST',
      headers: { 'Content-Type':'application/json', ...auth },
      body: JSON.stringify({
        preferred_chains: userPrefs.preferred_chains,
        preferred_store_ids: userPrefs.preferred_store_ids,
      }),
    });
  } catch (e) { dbg('savePreferences failed: ' + e); }
}

// Bulk toggle used by inline onclick handlers in index.html
function bulkToggle(containerId, on) {
  document.querySelectorAll(`#${containerId} .toggle-row[data-chain-slug], #${containerId} .toggle-row[data-store-id]`).forEach(r => {
    r.classList.toggle('active', on);
    const check = r.querySelector('.toggle-check');
    if (check) check.textContent = on ? '✓' : '';
  });
  if (containerId === 'chain-toggles') {
    userPrefs.preferred_chains = on ? [] : ['_none_'];
  } else if (containerId === 'store-toggles') {
    userPrefs.preferred_store_ids = on ? [] : [-1];
  }
  savePreferences();
}
window.bulkToggle = bulkToggle;

function selectNearbyStores() {
  if (!navigator.geolocation) { tg?.showAlert?.('Geolocalizzazione non disponibile'); return; }
  const timeout = setTimeout(() => tg?.showAlert?.('Timeout. Riprova manualmente.'), 15000);
  navigator.geolocation.getCurrentPosition(async (pos) => {
    clearTimeout(timeout);
    try {
      // Ask for every store within 20 km, not just the closest one. The
      // API uses PostGIS ST_DWithin for a real radius query, so a user in
      // San Pietro in Cariano gets Famila San Pietro + all the other
      // chains' stores in a 20 km arc (Verona, Bussolengo, Negrar, etc.).
      const resp = await fetch(`${API}/stores/nearby?lat=${pos.coords.latitude}&lng=${pos.coords.longitude}&radius_km=20`);
      const data = await resp.json();
      const nearbyIds = new Set((data.stores || []).map(s => s.id));
      if (nearbyIds.size === 0) {
        tg?.showAlert?.('Nessun negozio entro 20 km');
        return;
      }
      document.querySelectorAll('#store-toggles .toggle-row[data-store-id]').forEach(r => {
        const id = parseInt(r.dataset.storeId, 10);
        const on = nearbyIds.has(id);
        r.classList.toggle('active', on);
        const check = r.querySelector('.toggle-check');
        if (check) check.textContent = on ? '✓' : '';
      });
      userPrefs.preferred_store_ids = Array.from(nearbyIds);
      savePreferences();
      // Short human message listing a couple of example cities so the user knows
      // the selection actually took into account their location.
      const sample = (data.stores || []).slice(0, 3).map(s => s.name).join(', ');
      tg?.showAlert?.(`${nearbyIds.size} negoz${nearbyIds.size === 1 ? 'io' : 'i'} selezionat${nearbyIds.size === 1 ? 'o' : 'i'} entro 20 km\n(es. ${sample})`);
    } catch {
      tg?.showAlert?.('Errore caricamento negozi vicini');
    }
  }, () => {
    clearTimeout(timeout);
    tg?.showAlert?.('Permesso posizione negato');
  }, { timeout: 15000, maximumAge: 60000 });
}
window.selectNearbyStores = selectNearbyStores;

async function resetAllPrefs() {
  userPrefs = { preferred_chains: [], preferred_store_ids: [] };
  await savePreferences();
  loadSettings();
  loadDeals().catch(() => {});
}
window.resetAllPrefs = resetAllPrefs;

// ── Product card ─────────────────────────────────────────────────────────────
// Build a "scade …" badge from a YYYY-MM-DD valid_to. The class drives
// color escalation in CSS: ≤0 days → red (today), 1 → orange (tomorrow),
// 2-7 → amber, >7 → neutral. Returns '' if no valid_to provided so the
// card stays clean for offers without expiry data.
function expiryBadge(validTo) {
  if (!validTo) return '';
  // valid_to may arrive as either "YYYY-MM-DD" (clean) or as an ISO timestamp
  // serialized from a Postgres `date` (e.g. "2026-04-29T22:00:00Z" — that's
  // CEST midnight UTC-shifted). Use Date parsing then read LOCAL components,
  // so "valid until end of Apr 29 in our DB tz" lines up with Apr 29 in the
  // user's wall-clock too.
  const raw = new Date(validTo);
  if (isNaN(raw.getTime())) return '';
  const exp = new Date(raw.getFullYear(), raw.getMonth(), raw.getDate());
  const today = new Date(); today.setHours(0,0,0,0);
  const days = Math.round((exp - today) / 86400000);
  let label, cls;
  if (days < 0)        return ''; // shouldn't happen — API filters expired offers
  else if (days === 0) { label = 'Scade oggi';                cls = 'expiry-today'; }
  else if (days === 1) { label = 'Scade domani';              cls = 'expiry-tomorrow'; }
  else if (days <= 7)  { label = `Scade tra ${days} giorni`;  cls = 'expiry-soon'; }
  else {
    const dd = String(exp.getDate()).padStart(2, '0');
    const mm = String(exp.getMonth() + 1).padStart(2, '0');
    label = `Scade ${dd}/${mm}`;
    cls = 'expiry-later';
  }
  return `<span class="expiry-badge ${cls}" title="Valido fino al ${exp.toLocaleDateString('it-IT')}">\u{23F1} ${label}</span>`;
}

function productCard(p) {
  const price = `€${Number(p.offer_price || p.prezzo_offerta || 0).toFixed(2)}`;
  const origPrice = p.original_price || p.prezzo_originale;
  const discount = p.discount_pct || p.sconto_percentuale;
  const name = p.prodotto || p.raw_name || '';
  const chain = p.catena || p.chain || '';
  const qty = p.quantita || p.raw_quantity || '';
  const unitPrice = p.unit_price;
  const icon = CHAIN_ICONS[p.chain_slug] || '\u{1F6D2}';
  const imageUrl = p.image_url || null;
  const expiry = expiryBadge(p.valid_to);

  const lower = name.toLowerCase();
  let emoji = '\u{1F6D2}';
  if (/latte|yogurt|formaggio|mozzarella|burro|panna/.test(lower)) emoji = '\u{1F95B}';
  else if (/pasta|spaghetti|penne|fusilli|riso/.test(lower)) emoji = '\u{1F35D}';
  else if (/pane|fette|cornetto|biscott|frollin/.test(lower)) emoji = '\u{1F35E}';
  else if (/birra|vino|coca|sprite|fanta|succo/.test(lower)) emoji = '\u{1F37A}';
  else if (/cioccolat|ovett|uovo/.test(lower)) emoji = '\u{1F36B}';
  else if (/pollo|carne|manzo|suino|hamburger/.test(lower)) emoji = '\u{1F356}';
  else if (/pesce|merluzzo|tonno|salmone|gamber/.test(lower)) emoji = '\u{1F41F}';
  else if (/frutta|mela|banana|fragol|kiwi|arancia/.test(lower)) emoji = '\u{1F34E}';
  else if (/verdur|insalat|spinac|zucchin|carota|pomodor/.test(lower)) emoji = '\u{1F966}';
  else if (/surgela|congela/.test(lower)) emoji = '\u{1F9CA}';
  else if (/detersivo|sapone|shampoo|doccia/.test(lower)) emoji = '\u{1F9F4}';
  else if (/caff|espresso|cappuccin/.test(lower)) emoji = '☕';

  // On image error, swap the <img> for an emoji wrapped in <span aria-label=name>
  // so screen readers still identify the product instead of reading the raw emoji.
  const imgFallback = `<span aria-label=&quot;${escHtml(name)}&quot; role=&quot;img&quot;>${emoji}</span>`;
  const imgHtml = imageUrl
    ? `<div class="product-img product-img-real"><img src="${escHtml(imageUrl)}" alt="${escHtml(name)}" loading="lazy" onerror="this.parentElement.innerHTML='${imgFallback}'"></div>`
    : `<div class="product-img"><span aria-label="${escHtml(name)}" role="img">${emoji}</span></div>`;

  // Coverage line: if the offer is national, say so; otherwise show the
  // best-priced specific store + an inline disclosure for the rest. Backend
  // sorts stores[] ascending by offer_price so stores[0] is the cheapest.
  // Frontend Specialist 2026-04-27 report: "le offerte devono mostrare lo
  // store specifico, altrimenti l'info è incompleta".
  const stores = Array.isArray(p.stores) ? p.stores : [];
  const storeCount = typeof p.store_count === 'number' ? p.store_count : stores.length;
  let coverage = '';
  let storesPanel = '';
  if (p.is_national === true) {
    coverage = ' · \u{1F310} Rete nazionale';
  } else if (stores.length > 0) {
    const first = stores[0];
    const firstLabel = first.name + (first.city ? ` (${first.city})` : '');
    coverage = ` · \u{1F4CD} ${escHtml(firstLabel)}`;
    if (storeCount > 1) {
      coverage += ` <button class="product-stores-more" data-card-key="${escHtml(p.sku_id || p.product_id || name)}" type="button" aria-expanded="false">+${storeCount - 1} altr${storeCount - 1 === 1 ? 'o' : 'i'}</button>`;
      const rows = stores.slice(0, 12).map(s => {
        const label = escHtml(s.name + (s.city ? ` (${s.city})` : ''));
        const sp = s.offer_price != null ? `€${Number(s.offer_price).toFixed(2)}` : '';
        return `<li><span>${label}</span><b>${sp}</b></li>`;
      }).join('');
      const more = stores.length > 12 ? `<li class="ps-more-hint">… +${stores.length - 12} altri</li>` : '';
      storesPanel = `<ul class="product-stores-panel" data-card-key="${escHtml(p.sku_id || p.product_id || name)}" hidden>${rows}${more}</ul>`;
    }
  } else if (storeCount > 0) {
    coverage = ` · \u{1F4CD} ${storeCount} negoz${storeCount === 1 ? 'io' : 'i'}`;
  }

  // Quick actions: "+/✓" toggles canonical product in shopping_list. Bell
  // opens an inline prompt that creates a watch_type='keyword' alert with
  // optional max_price (the user's request: "permettere all'utente di
  // aggiungere prodotti alla lista o alle proprie notifiche su prodotti
  // diretti"). Both render only when the card carries identifying fields.
  const skuId = p.sku_id ?? null;
  const productId = p.product_id ?? null;
  const inList = productId && shoppingListMap.has(productId);
  const actions = (skuId || productId || name)
    ? `<div class="product-actions">
        ${(skuId || productId)
          ? `<button class="product-toggle ${inList ? 'is-in-list' : ''}" data-sku-id="${skuId ?? ''}" data-product-id="${productId ?? ''}" data-in-list="${inList ? '1' : '0'}" title="${inList ? 'Rimuovi dalla mia lista' : 'Aggiungi alla mia lista'}" aria-label="${inList ? 'Rimuovi dalla lista' : 'Aggiungi alla lista'}">${productToggleIcon(inList)}</button>`
          : ''}
        <button class="product-alert-btn" data-product-name="${escHtml(name)}" title="Crea avviso prezzo" aria-label="Crea avviso prezzo">\u{1F514}</button>
      </div>`
    : '';

  return `<div class="product-card">
    ${imgHtml}
    ${actions}
    <div class="product-info">
      <div class="product-name">${escHtml(name)}</div>
      <div class="product-meta">${escHtml(qty)}${unitPrice ? ` · €${Number(unitPrice).toFixed(2)}/kg` : ''}</div>
      <div class="product-price">
        <span class="price-current">${price}</span>
        ${origPrice ? `<span class="price-original">€${Number(origPrice).toFixed(2)}</span>` : ''}
        ${discount ? `<span class="price-discount">-${Math.round(discount)}%</span>` : ''}
      </div>
      <div class="product-chain">${icon} ${escHtml(chain)}${coverage}</div>
      ${storesPanel}
      ${expiry}
    </div>
  </div>`;
}

// ── Shopping list ────────────────────────────────────────────────────────────
//
// Each authed user has one default list (auto-created server-side). The
// screen renders saved canonical products with their best current offer
// across all chains, plus per-item threshold controls (min discount %,
// max price). Notifications are sent by notify-grocery-list.ts after each
// pipeline run for any new offer that crosses the user's thresholds.

async function loadShoppingList() {
  const container = document.getElementById('shopping-list-items');
  const empty = document.getElementById('shopping-list-empty');
  if (!container) return;
  const auth = tmaAuthHeader();
  if (!auth) {
    container.innerHTML = emptyHTML('\u{1F512}', 'Accedi per usare la lista', 'Apri la Mini App da Telegram');
    return;
  }
  container.innerHTML = skeletonCards(3);
  try {
    const resp = await fetchWithTimeout(`${API}/shopping-list`, { headers: auth }, 10000);
    if (resp.status === 401) {
      container.innerHTML = emptyHTML('\u{1F464}', 'Devi creare un profilo', 'Vai su Profilo per registrarti');
      return;
    }
    if (!resp.ok) {
      container.innerHTML = errorHTML(`Errore caricamento lista (HTTP ${resp.status})`);
      return;
    }
    const data = await resp.json().catch(() => null);
    if (!data) {
      container.innerHTML = errorHTML('Risposta non valida dal server');
      return;
    }
    const items = data.items || [];
    // Refresh local product_id→item_id map and sync any visible toggle buttons
    shoppingListMap.clear();
    for (const it of items) shoppingListMap.set(it.product_id, it.id);
    refreshAllToggles();
    if (!items.length) {
      container.innerHTML = `<div class="empty-state sli-empty-onboard">
        <div class="empty-icon">\u{1F6D2}</div>
        <div class="empty-text">La tua lista è vuota</div>
        <div class="sli-empty-steps">
          <div class="sli-empty-step">
            <span class="sli-empty-num">1</span>
            <span><b>Vai su Esplora</b> e tocca <b>+</b> sui prodotti che vuoi seguire</span>
          </div>
          <div class="sli-empty-step">
            <span class="sli-empty-num">2</span>
            <span>Oppure usa <b>"➕ Aggiungi prodotto"</b> qui sopra per cercare nel catalogo</span>
          </div>
          <div class="sli-empty-step">
            <span class="sli-empty-num">3</span>
            <span>Imposta una <b>soglia</b> (sconto min o prezzo max) per ricevere notifiche solo se l'offerta è davvero conveniente</span>
          </div>
        </div>
      </div>`;
      if (empty) empty.style.display = 'none';
      // Hide V2 hint banner on empty list
      const banner = document.getElementById('sli-hint-v2');
      if (banner) banner.style.display = 'none';
      return;
    }
    // Render either grouped-by-category or flat, persisting the choice in
    // localStorage. Backend already orders items by category sort_order so
    // the grouped view requires only a simple sequential walk.
    container.innerHTML = shoppingListGroupingEnabled()
      ? renderShoppingListGrouped(items)
      : items.map(shoppingListItemCard).join('');
    if (empty) empty.style.display = 'none';
    // V2 hint banner: show once after list has at least 1 item, until dismissed
    const banner = document.getElementById('sli-hint-v2');
    if (banner) {
      const dismissed = (() => { try { return localStorage.getItem('spesify.sli.hintV2Dismissed') === '1'; } catch { return false; } })();
      banner.style.display = dismissed ? 'none' : '';
    }
  } catch (e) {
    console.error('[Spesify] loadShoppingList error', e);
    const msg = e?.name === 'AbortError'
      ? 'Timeout: il server non risponde'
      : (e?.message || String(e));
    container.innerHTML = errorHTML('Impossibile caricare la lista: ' + msg);
  }
}

function shoppingListItemCard(item) {
  const productName = item.product_name || '(prodotto)';
  const brand = item.product_brand;
  const best = item.best_price ? `€${Number(item.best_price).toFixed(2)}` : null;
  const bestChain = item.best_chain_name;
  const chainCount = item.active_chain_count || 0;
  const discount = item.best_discount_pct;
  const minDisc = item.min_discount_pct ?? '';
  const maxPrice = item.max_price ? Number(item.max_price).toFixed(2) : '';
  const imgUrl = item.best_image_url;
  const triggers = [];
  if (item.min_discount_pct != null) triggers.push(`≥ ${item.min_discount_pct}%`);
  if (item.max_price != null) triggers.push(`≤ €${Number(item.max_price).toFixed(2)}`);
  const triggerLabel = triggers.length
    ? triggers.join(' e ')
    : 'qualsiasi offerta';

  const offerLine = best
    ? `<div class="sli-offer">In offerta a <b>${best}</b>${discount ? ` (-${Math.round(discount)}%)` : ''} su ${escHtml(bestChain || '?')}${chainCount > 1 ? ` · ${chainCount} catene` : ''}</div>`
    : `<div class="sli-offer sli-offer-none">Nessuna offerta attiva al momento</div>`;

  return `<div class="sli-card" data-item-id="${item.id}" data-product-id="${item.product_id}">
    <div class="sli-row">
      ${imgUrl ? `<img class="sli-img" src="${escHtml(imgUrl)}" alt="" loading="lazy" onerror="this.style.display='none'">` : '<div class="sli-img sli-img-placeholder">\u{1F6D2}</div>'}
      <div class="sli-main">
        <div class="sli-name">${brand ? `<b>${escHtml(brand)}</b> · ` : ''}${escHtml(productName)}</div>
        ${offerLine}
        <div class="sli-trigger">Notifica: ${escHtml(triggerLabel)}</div>
      </div>
      <div class="sli-controls">
        <button class="sli-move-up" data-item-id="${item.id}" title="Sposta su" aria-label="Sposta su">▲</button>
        <button class="product-toggle product-toggle-inline is-in-list" data-product-id="${item.product_id}" data-in-list="1" title="Rimuovi dalla mia lista" aria-label="Rimuovi dalla mia lista">${productToggleIcon(true)}</button>
        <button class="sli-move-down" data-item-id="${item.id}" title="Sposta giù" aria-label="Sposta giù">▼</button>
      </div>
    </div>
    <details class="sli-thresholds">
      <summary>Modifica soglie</summary>
      <div class="sli-thresholds-form">
        <label>Sconto minimo (%)
          <input type="number" min="0" max="100" data-field="min_discount_pct" data-item-id="${item.id}" value="${minDisc}" placeholder="es. 30">
        </label>
        <label>Prezzo massimo (€)
          <input type="number" min="0" max="9999" step="0.01" data-field="max_price" data-item-id="${item.id}" value="${maxPrice}" placeholder="es. 1.99">
        </label>
        <button class="sli-save" data-item-id="${item.id}">Salva</button>
      </div>
    </details>
  </div>`;
}

// ── Shopping list grouping (Feature B — categories) ─────────────────────
// View mode persists in localStorage so each user keeps their preference
// across sessions. Default = grouped (denser visual hierarchy).
const SLI_GROUPING_KEY = 'spesify.sli.grouping';

function shoppingListGroupingEnabled() {
  // Default true unless explicitly set to 'flat'
  try { return localStorage.getItem(SLI_GROUPING_KEY) !== 'flat'; }
  catch { return true; }
}

function setShoppingListGrouping(enabled) {
  try { localStorage.setItem(SLI_GROUPING_KEY, enabled ? 'grouped' : 'flat'); }
  catch {}
  syncShoppingListViewToggle();
  loadShoppingList();
}

function syncShoppingListViewToggle() {
  const btn = document.getElementById('sli-view-toggle');
  if (!btn) return;
  const grouped = shoppingListGroupingEnabled();
  btn.setAttribute('aria-pressed', grouped ? 'true' : 'false');
  btn.textContent = grouped ? '🗂️ Raggruppa' : '📋 Vista piatta';
}

// Render items split by category. Backend ordering guarantees items of the
// same category are contiguous (ORDER BY pc.sort_order, sli.sort_order...).
function renderShoppingListGrouped(items) {
  const groups = [];
  let current = null;
  for (const it of items) {
    const slug = it.category_slug || 'uncategorized';
    if (!current || current.slug !== slug) {
      current = {
        slug,
        emoji: it.category_emoji || '📦',
        name:  it.category_name  || 'Senza categoria',
        items: [],
      };
      groups.push(current);
    }
    current.items.push(it);
  }
  return groups.map(g => `
    <div class="sli-group" data-category="${escHtml(g.slug)}">
      <div class="sli-group-header">
        <span class="sli-group-emoji">${g.emoji}</span>
        <span class="sli-group-name">${escHtml(g.name)}</span>
        <span class="sli-group-count">${g.items.length}</span>
      </div>
      ${g.items.map(shoppingListItemCard).join('')}
    </div>
  `).join('');
}

// Wraps fetch with an explicit timeout via AbortController so the UI never
// stays "Aggiungo…" forever on a stuck network. WebKit's fetch() has no
// implicit timeout — without this the spinner could hang indefinitely.
async function fetchWithTimeout(url, opts, timeoutMs = 10000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function addToShoppingList(opts) {
  const auth = tmaAuthHeader();
  if (!auth) {
    showToast('Accedi tramite Telegram per usare la lista', 'error');
    return false;
  }
  try {
    const resp = await fetchWithTimeout(`${API}/shopping-list/items`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    }, 10000);
    if (resp.status === 401) {
      showToast('Devi prima registrare un profilo (sezione Profilo)', 'error');
      return false;
    }
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      showToast(data?.error || `Errore aggiunta lista (HTTP ${resp.status})`, 'error');
      return false;
    }
    showToast('✓ Aggiunto alla lista');
    return true;
  } catch (e) {
    console.error('[Spesify] addToShoppingList error', e);
    if (e?.name === 'AbortError') {
      showToast('Timeout: la richiesta non risponde, riprova', 'error');
    } else {
      showToast('Errore di rete: ' + (e?.message || e), 'error');
    }
    return false;
  }
}

async function deleteShoppingListItem(itemId) {
  const ok = await deleteShoppingListItemSilent(itemId);
  if (ok) {
    loadShoppingList();
    showToast('Rimosso dalla lista');
  }
}

// Same as deleteShoppingListItem but without the loadShoppingList side-effect
// or alert — used by the card toggle which handles its own UI updates.
async function deleteShoppingListItemSilent(itemId) {
  const auth = tmaAuthHeader();
  if (!auth) return false;
  try {
    const resp = await fetchWithTimeout(`${API}/shopping-list/items/${itemId}`, {
      method: 'DELETE',
      headers: auth,
    }, 10000);
    return resp.ok;
  } catch (e) {
    console.error('[Spesify] deleteShoppingListItem error', e);
    return false;
  }
}

async function patchShoppingListItem(itemId, body) {
  const auth = tmaAuthHeader();
  if (!auth) return false;
  try {
    const resp = await fetchWithTimeout(`${API}/shopping-list/items/${itemId}`, {
      method: 'PATCH',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 10000);
    return resp.ok;
  } catch (e) {
    console.error('[Spesify] patchShoppingListItem error', e);
    return false;
  }
}

// Floating popover anchored to a product card's bell button. Replaces
// window.prompt() which is blocked in the Telegram Mini App webview.
// User input: optional max price (€), empty = notify on any active offer.
function openInlineAlertPrompt(anchorEl, productName) {
  // Close any existing popover first (single-instance)
  document.querySelectorAll('.alert-popover').forEach(p => p.remove());

  const popover = document.createElement('div');
  popover.className = 'alert-popover';
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-label', `Crea avviso per ${productName}`);
  popover.innerHTML = `
    <div class="alert-popover-title">\u{1F514} Crea avviso</div>
    <div class="alert-popover-name">${escHtml(productName)}</div>
    <label class="alert-popover-label" for="alert-popover-max">
      <span>Prezzo massimo (€)</span>
      <input id="alert-popover-max" type="number" min="0" max="9999" step="0.01"
             class="alert-popover-input" placeholder="vuoto = qualsiasi prezzo"
             inputmode="decimal">
    </label>
    <div class="alert-popover-buttons">
      <button type="button" class="alert-popover-cancel">Annulla</button>
      <button type="button" class="alert-popover-submit">Crea avviso</button>
    </div>
  `;

  // Inline styles so the popover renders correctly even without the matching
  // CSS rules deployed yet. Uses the brand palette CSS variables.
  Object.assign(popover.style, {
    position: 'fixed',
    background: 'var(--card-bg, #ffffff)',
    color: 'var(--text, #1e1e1e)',
    border: '2px solid var(--brand, #1d4e5b)',
    borderRadius: '12px',
    padding: '14px',
    boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
    zIndex: '1000',
    minWidth: '240px',
    maxWidth: '320px',
    fontSize: '14px',
  });

  document.body.appendChild(popover);

  // Position: below the anchor, right-aligned. Clamp so it doesn't overflow.
  const rect = anchorEl.getBoundingClientRect();
  const popW = popover.offsetWidth;
  const popH = popover.offsetHeight;
  let top = rect.bottom + 8;
  let left = Math.min(rect.right - popW, window.innerWidth - popW - 12);
  if (left < 12) left = 12;
  if (top + popH > window.innerHeight - 12) {
    // Not enough room below — place above
    top = Math.max(12, rect.top - popH - 8);
  }
  popover.style.top = `${top}px`;
  popover.style.left = `${left}px`;

  const titleEl = popover.querySelector('.alert-popover-title');
  const nameEl = popover.querySelector('.alert-popover-name');
  const labelEl = popover.querySelector('.alert-popover-label');
  const input = popover.querySelector('.alert-popover-input');
  const submit = popover.querySelector('.alert-popover-submit');
  const cancel = popover.querySelector('.alert-popover-cancel');

  Object.assign(titleEl.style, { fontWeight: '700', fontSize: '15px', marginBottom: '6px' });
  Object.assign(nameEl.style, { fontSize: '13px', color: 'var(--hint, #6b7280)', marginBottom: '10px', wordWrap: 'break-word' });
  Object.assign(labelEl.style, { display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '12px' });
  Object.assign(input.style, {
    padding: '10px 12px', border: '1px solid var(--hint, #6b7280)',
    borderRadius: '8px', fontSize: '14px', width: '100%', boxSizing: 'border-box',
  });
  const btnBase = {
    padding: '10px 14px', borderRadius: '8px', fontSize: '14px',
    fontWeight: '600', cursor: 'pointer', border: 'none', flex: '1',
  };
  Object.assign(popover.querySelector('.alert-popover-buttons').style,
                { display: 'flex', gap: '8px' });
  Object.assign(cancel.style, btnBase,
                { background: 'transparent', color: 'var(--text, #1e1e1e)',
                  border: '1px solid var(--hint, #6b7280)' });
  Object.assign(submit.style, btnBase,
                { background: 'var(--brand, #1d4e5b)', color: '#ffffff' });

  setTimeout(() => input.focus(), 50);

  const cleanup = () => {
    popover.remove();
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('click', onOutside, true);
  };

  const onKey = (e) => {
    if (e.key === 'Escape') { cleanup(); }
    else if (e.key === 'Enter' && document.activeElement === input) {
      e.preventDefault();
      submit.click();
    }
  };
  document.addEventListener('keydown', onKey);

  const onOutside = (e) => {
    if (!popover.contains(e.target) && e.target !== anchorEl && !anchorEl.contains(e.target)) {
      cleanup();
    }
  };
  // Delay so the click that opened the popover isn't caught
  setTimeout(() => document.addEventListener('click', onOutside, true), 100);

  cancel.addEventListener('click', cleanup);

  submit.addEventListener('click', async () => {
    const maxStr = input.value.trim();
    let maxPrice = null;
    if (maxStr) {
      const parsed = parseFloat(maxStr.replace(',', '.'));
      if (!Number.isFinite(parsed) || parsed <= 0) {
        showToast('Prezzo non valido', 'error');
        input.focus();
        return;
      }
      maxPrice = parsed;
    }
    submit.disabled = true;
    submit.textContent = 'Creazione\u{2026}';
    try {
      const { created } = await addWatch(productName, maxPrice);
      showToast(created ? '\u{1F514} Avviso creato' : '\u{1F514} Avviso aggiornato');
      cleanup();
    } catch {
      showToast('Errore creazione avviso', 'error');
      submit.disabled = false;
      submit.textContent = 'Crea avviso';
    }
  });
}

// Delegated click handlers — the shopping list and product grids are repainted
// often, so listening on document avoids re-binding after every render.
document.addEventListener('click', async (e) => {
  // Toggle on a product card → bidirectional add/remove from shopping list.
  // State lives in shoppingListMap (product_id → list_item_id); a click in
  // either direction calls the appropriate API and flips the local state.
  const toggle = e.target.closest('.product-toggle');
  if (toggle) {
    e.preventDefault();
    e.stopPropagation();
    if (toggle.disabled) return;
    const skuId = parseInt(toggle.dataset.skuId, 10);
    const productId = parseInt(toggle.dataset.productId, 10);
    const wasInList = toggle.dataset.inList === '1';
    toggle.disabled = true;
    toggle.classList.add('product-toggle-loading');

    if (wasInList) {
      // Remove: need the list-item id from the local map
      if (productId > 0 && shoppingListMap.has(productId)) {
        const itemId = shoppingListMap.get(productId);
        const ok = await deleteShoppingListItemSilent(itemId);
        if (ok) {
          shoppingListMap.delete(productId);
          // Sync all visible toggles for this product (multiple cards may match)
          document.querySelectorAll(`.product-toggle[data-product-id="${productId}"]`).forEach(b => {
            b.classList.remove('is-in-list');
            b.dataset.inList = '0';
            b.innerHTML = productToggleIcon(false);
            b.title = 'Aggiungi alla mia lista';
          });
          // Re-render list screen if it's open
          if (document.getElementById('screen-shopping-list')?.classList.contains('active')) {
            loadShoppingList();
          }
        }
      }
    } else {
      // Add
      const payload = {};
      if (productId > 0) payload.product_id = productId;
      else if (skuId > 0) payload.sku_id = skuId;
      else { toggle.disabled = false; toggle.classList.remove('product-toggle-loading'); return; }
      const ok = await addToShoppingList(payload);
      if (ok) {
        // Server returns the new item id, but we don't have it without an
        // extra round-trip. Fetch the list to get the canonical state.
        await loadShoppingList();  // updates shoppingListMap + refreshAllToggles
      }
    }
    toggle.classList.remove('product-toggle-loading');
    toggle.disabled = false;
    return;
  }

  // Expand/collapse the per-store list inside an offer card.
  const moreBtn = e.target.closest('.product-stores-more');
  if (moreBtn) {
    e.preventDefault();
    e.stopPropagation();
    const key = moreBtn.dataset.cardKey;
    const panel = moreBtn.closest('.product-card')?.querySelector(`.product-stores-panel[data-card-key="${CSS.escape(key || '')}"]`);
    if (panel) {
      const open = !panel.hasAttribute('hidden');
      if (open) panel.setAttribute('hidden', ''); else panel.removeAttribute('hidden');
      moreBtn.setAttribute('aria-expanded', open ? 'false' : 'true');
    }
    return;
  }

  // Bell on a card → inline popover that creates a watch_type='keyword' alert
  // for this product name with optional max_price. Reuses /api/watches.
  // NOTE: window.prompt() is blocked in the Telegram Mini App webview, so we
  // build a small floating popover instead. Same pattern as sli-thresholds.
  const alertBtn = e.target.closest('.product-alert-btn');
  if (alertBtn) {
    e.preventDefault();
    e.stopPropagation();
    const name = alertBtn.dataset.productName || '';
    if (!name) return;
    openInlineAlertPrompt(alertBtn, name);
    return;
  }

  // Save thresholds
  const saveBtn = e.target.closest('.sli-save');
  if (saveBtn) {
    const itemId = parseInt(saveBtn.dataset.itemId, 10);
    const card = document.querySelector(`.sli-card[data-item-id="${itemId}"]`);
    if (!card) return;
    const minInput = card.querySelector('input[data-field="min_discount_pct"]');
    const maxInput = card.querySelector('input[data-field="max_price"]');
    const body = {
      min_discount_pct: minInput.value === '' ? null : parseInt(minInput.value, 10),
      max_price:        maxInput.value === '' ? null : parseFloat(maxInput.value),
    };
    saveBtn.disabled = true;
    saveBtn.textContent = 'Salvo\u{2026}';
    const ok = await patchShoppingListItem(itemId, body);
    saveBtn.textContent = ok ? 'Salvato \u{2713}' : 'Errore';
    if (ok) setTimeout(loadShoppingList, 600);
    setTimeout(() => { saveBtn.disabled = false; saveBtn.textContent = 'Salva'; }, 1500);
    return;
  }

  // "+ Aggiungi prodotto" button → open inline product search
  if (e.target.id === 'add-list-product-btn') {
    openShoppingListSearch();
  }

  // Grouped/flat view toggle
  if (e.target.id === 'sli-view-toggle' || e.target.closest('#sli-view-toggle')) {
    const next = !shoppingListGroupingEnabled();
    setShoppingListGrouping(next);
  }

  // Dismiss V2 hint banner (persists in localStorage)
  if (e.target.closest('.sli-hint-dismiss')) {
    try { localStorage.setItem('spesify.sli.hintV2Dismissed', '1'); } catch {}
    const banner = document.getElementById('sli-hint-v2');
    if (banner) banner.style.display = 'none';
    return;
  }

  // ↑/↓ reorder buttons on shopping list cards.
  // Reads the current DOM order, swaps the target with its neighbor, then
  // POSTs the new full order. Server normalizes sort_order = idx*10.
  const moveUpBtn = e.target.closest('.sli-move-up');
  const moveDownBtn = e.target.closest('.sli-move-down');
  if (moveUpBtn || moveDownBtn) {
    e.preventDefault(); e.stopPropagation();
    const btn = moveUpBtn || moveDownBtn;
    const itemId = parseInt(btn.dataset.itemId, 10);
    const direction = moveUpBtn ? -1 : +1;
    await reorderShoppingListItem(itemId, direction);
  }
});

// ── Long-press → category override picker ──────────────────────────────
// 500ms hold on a non-button area of a .sli-card opens a bottom sheet
// listing all categories. Pointer events work in Telegram Mini App webview
// (no native long-press blocking like window.prompt).
let _lpTimer = null;
let _lpStartX = 0, _lpStartY = 0;
let _categoriesCache = null;

document.addEventListener('pointerdown', (e) => {
  const card = e.target.closest('.sli-card');
  if (!card) return;
  // Skip if the press starts on an interactive child — let the normal
  // click flow handle that (button, input, summary, controls column).
  if (e.target.closest('button, input, a, summary, .sli-thresholds, .sli-controls')) return;
  const itemId = parseInt(card.dataset.itemId, 10);
  if (!Number.isFinite(itemId)) return;
  _lpStartX = e.clientX; _lpStartY = e.clientY;
  clearTimeout(_lpTimer);
  _lpTimer = setTimeout(() => {
    _lpTimer = null;
    openCategoryPicker(itemId);
  }, 500);
});

document.addEventListener('pointermove', (e) => {
  if (!_lpTimer) return;
  const dx = Math.abs(e.clientX - _lpStartX);
  const dy = Math.abs(e.clientY - _lpStartY);
  if (dx > 10 || dy > 10) { clearTimeout(_lpTimer); _lpTimer = null; }
});
document.addEventListener('pointerup', () => { clearTimeout(_lpTimer); _lpTimer = null; });
document.addEventListener('pointercancel', () => { clearTimeout(_lpTimer); _lpTimer = null; });

async function openCategoryPicker(itemId) {
  // Lazy-load categories list (rarely changes, cache for the session)
  if (!_categoriesCache) {
    try {
      const resp = await fetchWithTimeout(`${API}/categories`, {}, 5000);
      if (resp.ok) {
        const data = await resp.json();
        _categoriesCache = data.categories || [];
      } else {
        showToast('Impossibile caricare le categorie', 'error');
        return;
      }
    } catch {
      showToast('Errore di rete', 'error');
      return;
    }
  }
  // Already open? Skip (avoid stack)
  if (document.getElementById('sli-cat-overlay')) return;

  const overlay = document.createElement('div');
  overlay.id = 'sli-cat-overlay';
  overlay.className = 'sli-cat-overlay';
  overlay.innerHTML = `
    <div class="sli-cat-sheet" role="dialog" aria-label="Scegli categoria">
      <div class="sli-cat-handle"></div>
      <div class="sli-cat-title">Sposta in categoria</div>
      <div class="sli-cat-list">
        ${_categoriesCache.map(c => `
          <button class="sli-cat-item" data-cat-id="${c.id}" data-item-id="${itemId}">
            <span class="sli-cat-emoji">${c.emoji || '\u{1F4E6}'}</span>
            <span class="sli-cat-name">${escHtml(c.name_it)}</span>
          </button>
        `).join('')}
        <button class="sli-cat-item sli-cat-reset" data-cat-id="" data-item-id="${itemId}">
          <span class="sli-cat-emoji">\u{21A9}\u{FE0F}</span>
          <span class="sli-cat-name">Categoria di default</span>
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  // Animate in next frame
  requestAnimationFrame(() => overlay.classList.add('open'));

  const close = () => {
    overlay.classList.remove('open');
    setTimeout(() => overlay.remove(), 200);
  };
  overlay.addEventListener('click', async (ev) => {
    if (ev.target === overlay) { close(); return; }
    const btn = ev.target.closest('.sli-cat-item');
    if (!btn) return;
    const catIdRaw = btn.dataset.catId;
    const catId = catIdRaw === '' ? null : parseInt(catIdRaw, 10);
    const id = parseInt(btn.dataset.itemId, 10);
    btn.disabled = true;
    const ok = await patchShoppingListItem(id, { category_override_id: catId });
    close();
    if (ok) {
      showToast(catId ? 'Categoria aggiornata' : 'Categoria ripristinata');
      loadShoppingList();
    } else {
      showToast('Errore aggiornamento categoria', 'error');
    }
  });
  // Esc closes (desktop / external keyboard)
  const onKey = (k) => {
    if (k.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
  };
  document.addEventListener('keydown', onKey);
}

// Move a shopping list item up (-1) or down (+1) in the global flat order.
// In grouped view the swap still happens across-categories — the user may
// reassign categories via the long-press picker if they want a different
// bucket.
async function reorderShoppingListItem(itemId, direction) {
  const cards = Array.from(document.querySelectorAll('#shopping-list-items .sli-card'));
  const ids = cards.map(c => parseInt(c.dataset.itemId, 10)).filter(Number.isFinite);
  const idx = ids.indexOf(itemId);
  if (idx < 0) return;
  const targetIdx = idx + direction;
  if (targetIdx < 0 || targetIdx >= ids.length) return;
  // Swap
  [ids[idx], ids[targetIdx]] = [ids[targetIdx], ids[idx]];
  const auth = tmaAuthHeader();
  if (!auth) return;
  try {
    const resp = await fetchWithTimeout(`${API}/shopping-list/reorder`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: ids }),
    }, 10000);
    if (resp.ok) {
      // Optimistic: reload list to pick up the new ordering (also re-runs
      // grouping if enabled). 200ms delay so the user sees feedback.
      await loadShoppingList();
    } else {
      const data = await resp.json().catch(() => ({}));
      showToast(data?.error || 'Errore riordino lista', 'error');
    }
  } catch (e) {
    console.error('[Spesify] reorderShoppingListItem error', e);
    showToast('Errore di rete', 'error');
  }
}

function openShoppingListSearch() {
  const container = document.getElementById('shopping-list-items');
  if (!container) return;
  const existing = document.getElementById('sli-search-panel');
  if (existing) { existing.remove(); return; }
  const panel = document.createElement('div');
  panel.id = 'sli-search-panel';
  panel.className = 'sli-search-panel';
  panel.innerHTML = `
    <input type="text" id="sli-search-input" placeholder="Cerca un prodotto da aggiungere\u{2026}" autocomplete="off">
    <div id="sli-search-results"></div>
  `;
  container.parentElement.insertBefore(panel, container);
  const input = document.getElementById('sli-search-input');
  input.focus();
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => doShoppingListProductSearch(input.value.trim()), 250);
  });
}

async function doShoppingListProductSearch(q) {
  const out = document.getElementById('sli-search-results');
  if (!out) return;
  if (!q || q.length < 2) { out.innerHTML = ''; return; }
  out.innerHTML = '<div class="sli-search-loading">Cerco\u{2026}</div>';
  try {
    const resp = await fetch(`${API}/products/search?q=${encodeURIComponent(q)}&limit=15`);
    const data = await resp.json();
    if (!data.results?.length) {
      out.innerHTML = `<div class="sli-search-empty">Nessun prodotto trovato per "${escHtml(q)}".</div>`;
      return;
    }
    out.innerHTML = data.results.map(r => {
      const offer = r.best_price
        ? `In offerta a €${Number(r.best_price).toFixed(2)}${r.active_chain_count > 1 ? ` (${r.active_chain_count} catene)` : ''}`
        : 'Non in offerta al momento';
      return `<div class="sli-search-result">
        <div class="sli-search-info">
          <div class="sli-search-name">${r.brand ? `<b>${escHtml(r.brand)}</b> · ` : ''}${escHtml(r.name)}</div>
          <div class="sli-search-offer">${escHtml(offer)}</div>
        </div>
        <button class="sli-search-add" data-product-id="${r.id}">\u{2795} Aggiungi</button>
      </div>`;
    }).join('');
    // Wire add buttons. Always reset the button after a delay even on error
    // so the user can retry without re-opening the panel.
    out.querySelectorAll('.sli-search-add').forEach(btn => {
      btn.addEventListener('click', async () => {
        const productId = parseInt(btn.dataset.productId, 10);
        const orig = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Aggiungo\u{2026}';
        let ok = false;
        try {
          ok = await addToShoppingList({ product_id: productId });
        } catch (err) {
          console.error('[Spesify] sli search add failed', err);
        }
        btn.textContent = ok ? 'Aggiunto \u{2713}' : 'Errore';
        if (ok) {
          setTimeout(() => {
            const panel = document.getElementById('sli-search-panel');
            if (panel) panel.remove();
            loadShoppingList();
          }, 600);
        } else {
          // Reset to original text after a short pause so the user can retry
          setTimeout(() => { btn.disabled = false; btn.textContent = orig; }, 1800);
        }
      });
    });
  } catch (e) {
    out.innerHTML = errorHTML('Errore ricerca: ' + (e?.message || e));
  }
}
