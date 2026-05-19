/**
 * Quick validation: run the Conad flyer parser against sample text
 * from the Bussolengo Spazio Conad flyer (17-29 April 2026).
 *
 * Run: npx tsx src/parsers/conad-flyer.test.ts
 */

import { parseConadFlyerText } from './conad-flyer.js';

// Simulated pdftotext -raw output from the Bussolengo flyer (pages 1-4)
const sampleText = `DA VENERDÌ 17 A MERCOLEDÌ 29 APRILE 2026
FIN
O
AL
FIN
O
AL
per gli orari di apertura
consultare il sito conad.it
BUSSOLENGO
S.S. 11 - Loc. Ferlina 1
PER PRENDERTI CURA DI TE.
DAL 23 APRILE AL 17 MAGGIO 2026 È arrivato il nuovo catalogo
Scelte di Benessere.
Ritira la tua copia in negozio
CAFFÈ
CREMA E GUSTO
LAVAZZA
classico,
250 g x 4
10,90€
-35%
€ 16,99
NUTELLA
FERRERO
950 g
anziché €/kg 7,89 4,99€
€/kg 5,26
-33%
€ 7,49
DETERSIVO
STOVIGLIE
CLEAN ACTIVE
TECHNOLOGY
SVELTO
limone,
980 ml x4
anziché €/l 2,04 3,99€
€/l 1,02
-50%
€ 7,98
Le migliori marche a prezzi scontati.
2
FIN
O
AL OAL
BEVANDA
100% VEGETALE
SENZA ZUCCHERI
ALPRO
classica,
mandorla tostata,
avena, cocco,
1 litro
1,99€
-33%
€ 2,99
RICOTTINE
SENZA LATTOSIO
CONAD
ALIMENTUM
100 g x 2
LATTE
ITALIANO
1,19 €
€/kg 5,95
FORMAGGIO
SPALMABILE
SENZA LATTOSIO
CONAD ALIMENTUM
175 g
LATTE
ITALIANO
1,69 €
€/kg 9,66
LATTE
INTERO
MICROFILTRATO
PASTORIZZATO
PRODOTTO
DI MONTAGNA
SAPORI&DINTORNI
CONAD
1 litro
1,59 €
GORGONZOLA
DOP
DOLCE
CONAD
200 g
anziché €/kg 12,45 1,99€
€/kg 9,95
-20%
€ 2,49
ACTIMEL
DANONE
gusti assortiti,
100 g x6
anziché €/kg 5,49 2,49€
€/kg 4,15
-24%
€ 3,29
YOGURT CON
BIFIDOBACTERIUM
BB-12
PIACERSI
CONAD
gusti assortiti,
125 g x 2
LATTE
ITALIANO
0,69 €
€/kg 2,76
KEFIR
PIACERSI
CONAD
bianco,
fragola,
avena e noci,
150 g
0,69 €
€/kg 4,60
LO YOGURT ITALIANO
YOMO
gusti assortiti,
formato convenienza,
125 g x 8
2,49€
-50%
€ 4,99
PRIMO SALE
CONAD
ALIMENTUM
senza lattosio,
200 g
LATTE
ITALIANO
1,99 €
€/kg 9,95
YOGURT COLATO
TOTAL
FAGE
0% grassi,
5% grassi,
450 g
2,49€
anziché €/kg 7,32
-24%
€ 3,29
€/kg 5,54
BURRO
DI CENTRIFUGA
LA MONTANARA
VAL DI NON
DALLA TORRE
da latte fresco,
250 g
3,39€
anziché €/kg 19,96
-32%
€ 4,99
€/kg 13,56
LATTE
PARZIALMENTE
SCREMATO UHT
BONTÀ E LINEA
PARMALAT
con vitamina D,
1 litro x4
3,59€
anziché €/l 1,25
-28%
€ 4,99
€/l 0,90
MOZZARELLA
DI BUFALA
CAMPANA DOP
SAPORI&DINTORNI
CONAD
100 g x3
3,69€
anziché €/kg 15,64
-21%
€ 4,69
€/kg 12,30
DESSERT
CONAD
profiteroles, tiramisù,
90 g x 2,
-PANNA COTTA
al caramello,
120 g x 2
1,69€
-22%
€ 2,19
1,49 €
-31%
OFFERTA VALIDA DA VENERDÌ 17 A MERCOLEDÌ 29 APRILE 2026
3
SALAME
GALBANETTO
"IL TRADIZIONALE"
GALBANI
puro suino,
180 g circa
15,90€
al kg
-33%
€ 23,90
FORMAGGIO
MINI
BABYBEL
rosso,
5 pezzi, 100 g
1,89€
€/kg 18,90
CHICCHE
DI PATATE
FRESCHE
SAPORI&IDEE
CONAD
500 g
anziché €/kg 3,58 1,19€
€/kg 2,38
-33%
€ 1,79
BROCCOLI
CONAD
PERCORSO QUALITA'
600 g
anziché €/kg 4,15 1,99€
€/kg 3,32
BROCCOLI
ITALIANI
-20%
€ 2,49
PIATTO VEGANO
GARDEN GOURMET
nuggets,
polpette,
200 g
anziché €/kg 14,95 1,99€
€/kg 9,95
-33%
€ 2,99
FORMAGGIO
A FETTE SOTTILI
CONAD
di montagna,
provolone dolce,
scamorza affumicata,
pecorino,
al peperoncino,
take away, 130 g
20
SCONTO %
AFFETTATI
TAKE AWAY
SAPORI&DINTORNI
CONAD
coppa stagionata 110 g,
pancetta 110 g,
tagliere toscano 120 g
15
SCONTO %
PASTA FRESCA
RIPIENA
SAPORI&DINTORNI
CONAD
linea assortita,
250 g
2,49 €
€/kg 9,96
WURSTEL
SAPORI&DINTORNI
CONAD
wiener,
bratwurst,
2 pezzi, 180 g
1,39 €
€/kg 7,73
L'ABC
DELLA MERENDA
TENERONI
GRAN TERRE
prodotti assortiti
1,39€
-30%
€ 1,99
TRAMEZZINI
FARCITI
INTRAPAN
gusti assortiti,
2 pezzi, 150 g
anziché €/kg 16,60 1,69€
€/kg 11,27
-32%
€ 2,49
PESTO FRESCO
GIOVANNI RANA
alla genovese,
senz'aglio, noci,
pomodori secchi
e pecorino romano,
140 g
anziché €/kg 20,65 1,44€
€/kg 10,29
-50%
€ 2,89
MASCARPONE
SANTA LUCIA
GALBANI
500 g
3,49€
anziché €/kg 10,38
-32%
€ 5,19
€/kg 6,98
STRACCHINO
CREMOSO
GRANAROLO
170 g
1,79€
anziché €/kg 14,65
-28%
€ 2,49
€/kg 10,53
PARMIGIANO
REGGIANO
PARMAREGGIO
GRAN TERRE
stagionato 30 mesi,
grattugiato, 60 g
1,59€
anziché €/kg 33,17
-20%
€ 1,99
€/kg 26,50
PASTA FRESCA RIPIENA
SFOGLIAGREZZA
GIOVANNI RANA
ricotta e spinaci,
carne, vitello,
prosciutto crudo,
250 g
2,29€
anziché €/kg 15,56
-41%
€ 3,89
€/kg 9,16
Le migliori marche a prezzi scontati.
4
FIN
O
AL OAL
CODE
DI MAZZANCOLLE
TROPICALI
CONAD
400 g
anziché €/kg 19,75 4,99€
€/kg 12,48
-36%
€ 7,90
CROCCOLE
CON MERLUZZO
FINDUS
5 pezzi, 540 g
anziché €/kg 17,58 4,74€
€/kg 8,78
-50%
€ 9,49
GELATO
NUII
gusti assortiti,
4 stecchi
3,79€
-39%
€ 6,29
BURGER
CONAD
di merluzzo,
di salmone,
2 pezzi, 170 g
anziché €/kg 21,12 2,49€
€/kg 14,65
-30%
€ 3,59
BURGER
VEGETARIANO
BONTÀ E SALUTE
VALSOIA
2 pezzi, 150 g
-COTOLETTE
2 pezzi, 200 g
1,99€
VIENNETTA
CLASSIC
ALGIDA
vaniglia,
320 g
2,99€
anziché €/kg 14,04
-33%
€ 4,49
€/kg 9,35
GELATO
CARTE D'OR
crema, panna, tartufo,
cioccolato fondente,
nocciola, tiramisù,
500 g
2,70€
anziché €/kg 8,38
-35%
€ 4,19
€/kg 5,40
CUORI DI FILETTO
DI MERLUZZO
CONAD
pescato nell'Oceano
Atlantico,
400 g
anziché €/kg 12,48 3,99€
€/kg 9,98
-20%
€ 4,99
GELATO
SAPORI&IDEE CONAD
al fiordilatte,
alla nocciola,
al pistacchio,
sorbetto al limone,
300 g
2,19€
anziché €/kg 9,97
-26%
€ 2,99
€/kg 7,30
BISTECCA
DI MERLUZZO
GRIGLIATA
FROSTA
olio extra vergine
di oliva e rucola,
250 g
2,99€
anziché €/kg 19,96
-40%
€ 4,99
€/kg 11,96
PISELLINI
PRIMAVERA
FINDUS
700 g
anziché €/kg 6,42 3,49€
€/kg 4,99
-22%
€ 4,49
MINI PIZZE
MARGHERITA
CONAD
4 pizze, 360 g
anziché €/kg 6,92 1,79€
€/kg 4,98
-28%
€ 2,49
Buongustaio
MORTADELLA
BOLOGNA IGP
CONAD
 con o senza pistacchi
10,90 €
al kg
PROSCIUTTO
COTTO DI
ALTA QUALITÀ
ARROSTO
CONAD
18,90 €
al kg
RICOTTA
VACCINA
CONAD
5,90 €
al kg
PROSCIUTTO
DI PARMA DOP
SAPORI&DINTORNI
CONAD
27,90 €
al kg
MONTASIO DOP
SAPORI&DINTORNI
CONAD
11,90 €
al kg
GRANA
PADANO DOP
RISERVA
SAPORI&DINTORNI
CONAD
13,90 €
al kg
SPIANATA
PICCANTE
SAN VINCENZO
17,90 €
al kg
SALAME
GRAN MAGRO
CASA MODENA
20,90 €
al kg
EMMENTALER
SVIZZERO
DOP
15,50 €
al kg
SCAMORZA
BIANCA
O AFFUMICATA
SABELLI
12,90 €
al kg
OFFERTA VALIDA DA VENERDÌ 17 A MERCOLEDÌ 29 APRILE 2026 5
CEREALI INTEGRALI
NESQUIK
NESTLÈ
gusto cioccolatoso,
formato convenienza,
625 g
anziché €/kg 7,19
2,99€
€/kg 4,79
-33%
€ 4,49
LE FRESCHE
BISCOTTATE
INTEGRALI
GRISSIN BON
860 g
anziché €/kg 4,64
2,99€
€/kg 3,48
-25%
€ 3,99
BISCOTTI
GRAN SARACENO
SENZA GLUTINE
GALBUSERA
con golose gocce
di cioccolato,
6 monoporzioni,
260 g
anziché €/kg 11,50
2,49€
€/kg 9,58
-16%
€ 2,99
PANCAKES
CONAD
8 pezzi, 280 g
1,99 €
€/kg 7,11
FROLLINI
AL CACAO
EXTRA CROCCANTI
CONAD
con maxi pepite
di cioccolato,
250 g
anziché €/kg 9,96
1,99€
€/kg 7,96
-20%
€ 2,49
L'ORIGINALE
GRISBÌ
cioccolato,
nocciola,
limone,
9 pezzi, 135 g
anziché €/kg 16,23
1,49€
€/kg 11,04
-31%
€ 2,19
GINSENG
NESCAFÉ
da zuccherare,
10 buste, 60 g
2,90 €
€/kg 48,34
MIELE
MILLEFIORI
CONAD
500 g
5,19 €
€/kg 10,38
PRODOTTO
ITALIANO
LATTE DI CRESCITA
1-3 ANNI
NUTRI MUNE
PLASMON
classico,
con biscotto,
1 litro x6
anziché €/l 2,49
11,90€
€/l 1,99
-20%
€ 14,90
IL BISCOTTO
DEI BAMBINI
PLASMON
720 g
anziché €/kg 9,59
4,29€
€/kg 5,96
-37%
€ 6,90
OMOGENEIZZATO
DI CARNE
PLASMON
gusti assortiti,
80 g x3
anziché €/kg 12,46
2,49€
€/kg 10,38
-16%
€ 2,99
OMOGENEIZZATO
DI FRUTTA
PLASMON
mela, pera,
prugna,
80 g x3
anziché €/kg 7,05
1,39€
€/kg 5,80
-17%
€ 1,69
CAFFE' ESPRESSO BAR
MOTTA
compatibili con macchine
Nescafé Dolcegusto,
40 capsule, 300 g,
compatibili con macchine
Lavazza A Modo Mio,
50 capsule, 350 g
8,49€
-15%
€ 9,99
TISANA
PIACERSI
CONAD
equilibrio, energia,
difese immunitarie,
20 filtri, 50 g
1,49 €
€/kg 29,80
Le migliori marche a prezzi scontati.
6
CHIPS DI PANE
SOTTILE
E CROCCANTE
BAKE ROLLS
TUC
gusti assortiti,
150 g
anziché €/kg 10,60 0,99€
€/kg 6,60
-37%
€ 1,59
PINSA
CONAD
230 g
anziché €/kg 8,66 1,49€
€/kg 6,48
-25%
€ 1,99
CROUTONS
BIOLOGICI
E' BIO
MONVISO
con farina integrale,
con olio extravergine
di oliva, 70 g
anziché €/kg 18,43 0,99€
€/kg 14,15
-23%
€ 1,29
CRACKER
CON FARINA SOSTENIBILE
MULINO BIANCO
salati,
salati senza granelli
di sale in superficie,
20 porzioni, 500 g
anziché €/kg 4,58 1,49€
€/kg 2,98
-34%
€ 2,29
NOODLES SAIKEBON
STAR
manzo, pollo, gamberetti,
verdure, curry,
hot & spicy,
60 g
0,95€
anziché €/kg 19,84
-20%
€ 1,19
€/kg 15,84
PASTA DI SEMOLA
DI GRANO DURO
GAROFALO
formati assortiti,
500 g
0,79€
anziché €/kg 2,40
-34%
€ 1,20
€/kg 1,58
STRA PASTA
GAROFALO
spaghetti, penne ziti rigate,
mezze maniche rigate,
casarecce,
500 g
anziché €/kg 3,98
1,49€
€/kg 2,98
-25%
€ 1,99
PATATINE
LAY'S
classiche 145 g,
max double crunch
gusto barbecue
110 g
1,15€
-31%
€ 1,69
PATATINE
PAI
palline gusto formaggio,
anellini gusto pizza,
cornetti
gusto formaggio,
125 g
anziché €/kg 7,92 0,49€
€/kg 3,92
-50%
€ 0,99
CONFETTURA
I FRUTTETI DI OSWALD
ZUEGG
albicocche,
fragole, pesche,
320 g
anziché €/kg 6,22 1,79€
€/kg 5,60
-10%
€ 1,99
CIOCCOLATO
NOVI
linea assortita,
100 g
25
SCONTO %
DOLCIUMI
CONAD
ciucciotti frizzanti,
mix caramelle
gommose,
rotelle alla liquirizia,
175 g
0,99 €
€/kg 5,66
KIT KAT
NESTLÈ
classico,
white, dark,
3 pezzi, 124,5 g
anziché €/kg 24,02 2,29€
€/kg 18,40
-23%
€ 2,99
OFFERTA VALIDA DA VENERDÌ 17 A MERCOLEDÌ 29 APRILE 2026
7
TONNO
ALL'OLIO D'OLIVA
MAREBLU
formato speciale,
60 g x 12
7,99€
anziché €/kg 15,98
-30%
€ 11,50
€/kg 11,10
MAIONESE
CLASSICA
CALVÈ
150 ml x2
anziché €/l 8,34 1,25€
€/l 4,17
-50%
€ 2,50
OLIO
EXTRA VERGINE DI OLIVA
BIOLOGICO
IL CASOLARE
FARCHIONI
grezzo naturale, 75 cl
anziché €/l 15,87 8,90€
€/l 11,87
-25%
€ 11,90
OLIO
EXTRA VERGINE
DI OLIVA
DESANTIS
1 litro
4,99€
-15%
€ 5,90
RISO
FLORA
il classico,
1 kg
1,79€
-30%
€ 2,59
TOMATO
KETCHUP
HEINZ
460 g
anziché €/kg 5,85 1,89€
€/kg 4,11
-29%
€ 2,69
OLIO
EXTRA VERGINE
DI OLIVA
CARAPELLI
oro verde,
non filtrato,
il nobile,
1 litro
8,75€
-30%
€ 12,50
RAGÙ
CONAD
alla bolognese,
con salsiccia,
180 g x 2
1,99 €
€/kg 5,53
RISO
COTTO A VAPORE
SAPORI&IDEE
CONAD
basmati, nerone,
integrale e selvaggio,
250 g
anziché €/kg 7,56 0,94€
€/kg 3,76
-50%
€ 1,89
PESTO
BARILLA
linea assortita,
190 g o 200 g
2,00€
-19%
€ 2,49
TONNO
CONAD
all'olio di oliva,
100 g x3
3,99 €
€/kg 13,30
PASSATA
DI POMODORO
CLASSICA
CONAD
dolce e corposa,
700 g
0,85 €
€/kg 1,22
BRODO
GRANULARE
KNORR
linea assortita,
150 g
anziché €/kg 11,94
1,49€
€/kg 9,94
-16%
€ 1,79
FILETTI DI TONNO
ÀS DO MAR
all'olio di oliva,
all'olio extra vergine
di oliva biologico,
250 g
5,50€
anziché €/kg 31,60
-30%
€ 7,90
€/kg 22,00
OLIVOLÌ
SNOCCIOLATE
SACLÀ
290 g (sgocc. 120 g)
1,29€
anziché €/kg 14,09
-23%
€ 1,69
€/kg 10,75
BIRRA
BECK'S
60 cl
0,99€
anziché €/l 2,49
-33%
€ 1,49
€/l 1,65
FILETTI DI TONNO
ALL'OLIO DI OLIVA
RIO MARE
classici,
peperoncino,
lime e zenzero,
130 g
anziché €/kg 30,70 2,99€
€/kg 23,00
-25%
€ 3,99
THÈ AL LIMONE
O ALLA PESCA
SAN BENEDETTO
classico,
zero zuccheri,
1,5 litri
-VERDE 1,5 litri
anziché €/l 0,73 0,65€
€/l 0,44
-40%
€ 1,09
BIRRA
TUBORG
33 cl x 3
1,79€
anziché €/l 2,52
-28%
€ 2,49
€/l 1,81
I POLPOSISSIMI
SENZA ZUCCHERI
AGGIUNTI
CONAD
pesca e mela,
pera e mela,
200 ml x3
anziché €/l 3,32 1,29€
€/l 2,15
-35%
€ 1,99
ACQUA
MINERALE
EFFERVESCENTE
NATURALE
LETE
1,5 litri
anziché €/l 0,26 0,32€
€/l 0,22
-17%
€ 0,39
ACQUA
NATURALE
LEVISSIMA
1,5 litri
anziché €/l 0,33 0,33€
€/l 0,22
-32%
€ 0,49
COTTO AL VAPORE
MIX MAIS
BONDUELLE
mais, olive e peperoni,
mais e fagioli rossi,
mais e piselli,
170 g x3
1,90€
-23%
€ 2,49
BEVANDA
SENZA ZUCCHERI
AGGIUNTI
SKIPPER
ZUEGG
gusti assortiti,
1 litro
1,59€
-20%
€ 1,99
COCA-COLA
original taste,
senza caffeina,
zero zuccheri,
660 ml x4
anziché €/l 1,74
3,89€
€/l 1,48
-15%
€ 4,59
ENERGY DRINK
MONSTER
linea assortita,
50 cl
1,09€
anziché €/l 2,78
-21%
€ 1,39
€/l 2,19
BIBITE
ZERO ZUCCHERI
AGGIUNTI
SAN BENEDETTO
allegra, limone, ginger,
75 cl
anziché €/l 0,92 0,41€
€/l 0,55
-40%
€ 0,69
`;

const products = parseConadFlyerText(sampleText);

console.log(`\n=== Conad Flyer Parser Results ===`);
console.log(`Total products extracted: ${products.length}\n`);

for (const p of products) {
  const discount = p.sconto_percentuale ? ` (-${p.sconto_percentuale}%)` : '';
  const original = p.prezzo_originale ? ` was €${p.prezzo_originale.toFixed(2)}` : '';
  const unit = p.prezzo_al_kg ? ` [€/${p.unita_prezzo} ${p.prezzo_al_kg.toFixed(2)}]` : '';
  const qty = p.quantita_peso ? ` (${p.quantita_peso})` : '';
  const brand = p.brand ? ` [${p.brand}]` : '';
  console.log(
    `  €${p.prezzo_offerta.toFixed(2)}${discount}${original} | ${p.prodotto}${brand}${qty}${unit}`
  );
}

console.log(`\nValidity: ${products[0]?.validita_inizio} → ${products[0]?.validita_fine}`);

// Quick sanity checks
const expectedProducts = [
  { name: /CAFFÈ.*CREMA.*GUSTO/i, price: 10.90, discount: 35 },
  { name: /NUTELLA/i, price: 4.99, discount: 33 },
  { name: /SVELTO/i, price: 3.99, discount: 50 },
  { name: /ALPRO/i, price: 1.99, discount: 33 },
  { name: /GORGONZOLA/i, price: 1.99, discount: 20 },
  { name: /YOMO/i, price: 2.49, discount: 50 },
  { name: /MASCARPONE/i, price: 3.49, discount: 32 },
  { name: /MORTADELLA/i, price: 10.90 },
  { name: /STRACCHINO/i, price: 1.79, discount: 28 },
  { name: /PARMIGIANO/i, price: 1.59, discount: 20 },
  { name: /PROSCIUTTO.*PARMA/i, price: 27.90 },
  { name: /BROCCOLI/i, price: 1.99, discount: 20 },
  { name: /CROCCOLE/i, price: 4.74, discount: 50 },
  { name: /FORMAGGIO.*FETTE/i, price: 0, discount: 20 }, // percentage-only
];

console.log(`\n=== Sanity Checks ===`);
let passed = 0;
for (const expected of expectedProducts) {
  // Check both prodotto and brand
  const found = products.find(p =>
    (expected.name.test(p.prodotto) || (p.brand && expected.name.test(p.brand))) &&
    Math.abs(p.prezzo_offerta - expected.price) < 0.01
  );
  if (found) {
    console.log(`  ✓ ${expected.name.source} @ €${expected.price}`);
    passed++;
  } else {
    console.log(`  ✗ MISSING: ${expected.name.source} @ €${expected.price}`);
  }
}
console.log(`\n${passed}/${expectedProducts.length} checks passed`);
