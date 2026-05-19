# Design — Resumable Matching for Spesabot

**Status**: design (non implementato).
**Data**: 2026-05-05.
**Trigger di implementazione**: il fail del 5/5/2026 alle 05:41 (batch 50/56 killato per `TimeoutStartSec=2400`) ha mostrato che il matching service è oltre il 89% del tempo limite. Il fix tattico (timeout 2400→7200 in `cc47bff`) compra margine, ma se il candidate set cresce ancora (es. con cliente B2B + più offerte da nuovi catene) il problema tornerà. Resumable matching è il fix strutturale.

## Problema

Il job `spesabot-matching.service` è un `Type=oneshot` systemd unit che processa **N batch sequenziali di matching LLM** (Z.AI primario, Gemini fallback). Se il job viene killato (timeout systemd, OOM, manual kill, host reboot), tutti i batch già processati sono persi: alla riesecuzione si riparte da batch 1.

Il fix attuale è "aumenta il timeout a 7200s (120 min)". Ma:
1. Non scala: se il candidate set raddoppia (futuro), serve riaumentare. Non è una soluzione asintotica.
2. Spreco di compute: i batch già completati vengono ri-eseguiti — costo Z.AI/Gemini tokens raddoppiato.
3. SLA fragility: 1 outage di rete a metà run = restart from scratch.

## Soluzione

Salvare lo stato di avanzamento in **DB**, in modo che alla riesecuzione il job riparta dal batch successivo all'ultimo completato con successo.

## Schema

Nuova tabella `matching_progress` (Postgres):

```sql
CREATE TABLE matching_progress (
  id            BIGSERIAL    PRIMARY KEY,
  run_id        UUID         NOT NULL,                    -- generato all'inizio di ogni run
  started_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMPTZ  NULL,                        -- NULL finché run in corso
  total_batches INT          NOT NULL,                    -- noto all'inizio (= ceil(candidate_pairs / batch_size))
  last_batch    INT          NOT NULL DEFAULT 0,          -- ultimo batch completato con successo (0 = non iniziato)
  candidate_set_hash TEXT    NOT NULL,                    -- SHA-256 del set di candidate pairs (per validare resume)
  matches_inserted INT       NOT NULL DEFAULT 0,          -- contatore cumulativo per la run
  status        TEXT         NOT NULL DEFAULT 'running',  -- 'running', 'completed', 'aborted', 'stale'
  killed_reason TEXT         NULL,                        -- popolato se interrotto (es. 'systemd_timeout', 'host_reboot')
  notes         JSONB        NULL                         -- metadata libera (es. ultimo errore Z.AI, fallback rate)
);

CREATE INDEX idx_matching_progress_status ON matching_progress (status) WHERE status = 'running';
CREATE INDEX idx_matching_progress_started ON matching_progress (started_at DESC);
```

## Algoritmo

### Avvio del job

```python
# Pseudo-code

candidates = build_candidate_pairs()           # come oggi
candidate_hash = sha256(serialize(candidates))
total_batches = ceil(len(candidates) / BATCH_SIZE)

# Cerca run incompleta compatibile
prev = SELECT * FROM matching_progress
       WHERE candidate_set_hash = $candidate_hash
         AND status = 'running'
         AND started_at > NOW() - INTERVAL '24 hours'
       ORDER BY started_at DESC LIMIT 1;

if prev is not None:
    # Resume
    run_id = prev.run_id
    start_from = prev.last_batch + 1
    matches_so_far = prev.matches_inserted
    log(f"[matching] resuming run_id={run_id} from batch {start_from}/{total_batches}")
else:
    # Fresh start
    run_id = uuid4()
    start_from = 1
    matches_so_far = 0
    INSERT INTO matching_progress (run_id, total_batches, last_batch, candidate_set_hash)
        VALUES ($run_id, $total_batches, 0, $candidate_hash);
    log(f"[matching] starting fresh run_id={run_id} ({total_batches} batches)")
```

### Loop dei batch

```python
for i in range(start_from, total_batches + 1):
    batch = candidates[(i-1) * BATCH_SIZE : i * BATCH_SIZE]
    matches = process_batch_llm(batch)            # come oggi
    
    insert_matches_to_db(matches)
    matches_so_far += len(matches)
    
    UPDATE matching_progress
       SET last_batch = $i,
           matches_inserted = $matches_so_far,
           notes = jsonb_set(coalesce(notes,'{}'::jsonb), '{last_batch_pace_ms}', to_jsonb($pace_ms))
     WHERE run_id = $run_id;
    
    log(f"[matching] batch {i}/{total_batches} done ({len(matches)} matches)")
```

### Completion

```python
UPDATE matching_progress
   SET status = 'completed',
       finished_at = NOW()
 WHERE run_id = $run_id;

log(f"[matching] run {run_id} completed, total matches: {matches_so_far}")
```

### Abort handling (al riavvio del processo)

Quando un nuovo job parte e trova una run `running` ma con `started_at > 24h fa`, la marca come `stale`:

```sql
UPDATE matching_progress
   SET status = 'stale', killed_reason = 'started_24h_ago_no_completion'
 WHERE status = 'running' AND started_at < NOW() - INTERVAL '24 hours';
```

Questo evita resume-loop infiniti su run zombie (es. process killato senza UPDATE finale).

## Edge cases gestiti

| Caso | Comportamento |
|---|---|
| **systemd timeout durante batch 50/56** | UPDATE in DB con `last_batch=50`. Prossima invocazione (giovedì 05:00) fa resume da batch 51 |
| **Candidate set cambiato tra run-1 e run-2** | `candidate_set_hash` diverso → resume non possibile, parte fresh |
| **Stesso candidate set, 2 esecuzioni in parallelo** | INSERT con `status='running'` può coesistere ma SELECT FOR UPDATE protegge il read; il secondo trova la prima in stato `running` e... abort? Lo vediamo sotto |
| **Run zombie (>24h vecchia, status='running')** | Marcata `stale` automaticamente, nuova run parte fresh |
| **Crash a metà UPDATE matching_progress** | Worst case: doppio insert dello stesso batch nelle tabelle finali (es. `product_matches`) — mitigation: INSERT ON CONFLICT DO NOTHING su tutte le tabelle target |
| **Il candidate set è enorme (es. 200 batch)** | Stesso flow, l'overhead di UPDATE per batch è trascurabile (pg insert ~1ms su tabella indicizzata) |

## Soluzione del conflict tra esecuzioni

Per evitare 2 run paralleli sullo stesso candidate_set_hash, **acquisire un advisory lock** Postgres:

```python
LOCK_KEY = hash('spesabot.matching') % 2**31

with conn.cursor() as cur:
    cur.execute("SELECT pg_try_advisory_lock(%s)", [LOCK_KEY])
    got_lock = cur.fetchone()[0]
    if not got_lock:
        log("[matching] another instance is running — exit silently")
        sys.exit(0)
```

L'advisory lock è automaticamente rilasciato a fine connessione (anche su crash).

## Migration plan

```
W1 (1-2 giornate dev):
  - Aggiungere CREATE TABLE matching_progress nello script schema
  - Refactor src/canonical-match-llm.ts (o equivalente) per il flow resumable
  - Test E2E:
    1. Run completa 56 batches → verify completed
    2. Kill a batch 30/56 → re-run → verify resume from 31
    3. Kill a batch 30 + manomettere candidate_set → re-run → verify fresh start
    4. Stale run >24h → verify auto-marked stale + fresh start
  - Smoke notturno per 1 settimana monitorato

W2 (deploy):
  - Aggiornare scripts/run-matching.sh (nessun cambiamento di interfaccia)
  - Restart timer
  - Log audit: matching_progress in dashboard / metric
```

## Decisione: implementare ora o aspettare?

**NO, non oggi.** Il fix tattico `TimeoutStartSec=7200` compra ~3 mesi di margine (assumendo crescita candidate set 2-3% mese-su-mese, che è il pattern attuale).

**Trigger di implementazione**:
- Se 2 run consecutive falliscono per timeout dopo l'aumento → urgent fix
- O quando si parte con un secondo cliente B2B retail (più catene, più offerte, più candidate pairs)
- O al setup della migrazione cloud (Neon DB) — quel momento è naturale per refactor del matching service

**Effort stimato**: 4-8h dev (incluso test E2E) + 1 settimana smoke notturno.

## Note di osservabilità

Dopo deploy, esporre a Rakki una query semplice:

```sql
SELECT
  TO_CHAR(started_at, 'YYYY-MM-DD HH24:MI') as run,
  total_batches,
  last_batch,
  ROUND(100.0 * last_batch / total_batches, 1) as pct,
  matches_inserted,
  status,
  EXTRACT(EPOCH FROM (COALESCE(finished_at, NOW()) - started_at))::int as elapsed_s,
  killed_reason
FROM matching_progress
ORDER BY started_at DESC
LIMIT 10;
```

(Eventualmente dashboard Spesify / endpoint admin futuri.)

---

*Design pronto per implementazione quando il trigger scatta. File di riferimento per la conversazione futura — non eseguire build/deploy fino a confirma esplicita di Rakki.*
