# Render Error Monitor Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a scheduled Claude Code task that scans avoqado-server's Render errors every 10h, auto-triages blip-vs-real, deep-investigates only real findings via `/investigate-prod`, and reports — never applying fixes itself.

**Architecture:** A single `mcp__scheduled-tasks` entry (`render-error-monitor`) whose entire behavior lives in one self-contained `SKILL.md` prompt. No repo code changes — the artifact lives outside git at `~/.claude/scheduled-tasks/render-error-monitor/`. Full design rationale: [docs/superpowers/specs/2026-07-04-render-error-monitor-agent-design.md](../specs/2026-07-04-render-error-monitor-agent-design.md).

**Tech Stack:** Claude Code scheduled tasks (`mcp__scheduled-tasks__*`), BetterStack ClickHouse queries (`mcp__betterstack__query`, source_id `1720702`), the existing `/investigate-prod` skill, `PushNotification`.

## Global Constraints

- **100% read-only over business code/DB.** The agent never edits repo files, never `git commit`s, never runs INSERT/UPDATE/DELETE. The only files it ever writes are its own `state.json` and its own `reports/*.md` under `~/.claude/scheduled-tasks/render-error-monitor/`.
- **Nothing in this plan touches the avoqado-server git repo** except this plan document and the design spec (already committed at `44ada7d8`). The scheduled task, its state, and its reports live entirely outside git by design (spec §3) — don't add a repo task for them.
- **Cron is `0 */10 * * *`** (fires 00:00, 10:00, 20:00 local daily — gaps of 10h/10h/4h, not perfectly even since 24 isn't divisible by 10, but close enough for this use case). `notifyOnCompletion: false` at registration — the prompt itself calls `PushNotification` conditionally instead.
- **Blip criteria (spec §5):** code in `{P1001, P1002, P1008, P1017, P2024, ECONNREFUSED, ETIMEDOUT, ENOTFOUND, ECONNRESET, EPIPE}` (same list as `shouldRetryDbConnectionError`/`isTransientDbConnectionError` in `src/utils/retry.ts`) + self-recovery evidence + ≤3 historical occurrences. Reclassify blip→real once a pattern exceeds 5 occurrences in a trailing 30-day window.
- **Validate before activating the recurring cron** (spec §9) — Task 2 below is a hard gate before Task 3 registers the real schedule.

---

### Task 1: Draft the complete SKILL.md prompt

**Files:**
- Create: `/private/tmp/claude-501/-Users-amieva-Documents-Programming-Avoqado-avoqado-server/50a30f47-6886-4311-917a-5a9366b41942/scratchpad/render-error-monitor-SKILL.draft.md` (working copy — NOT the final registered location; Task 3 registers the real one via tool call, not by writing this path directly)

**Interfaces:**
- Produces: the exact prompt text Task 2 validates and Task 3 registers verbatim (after any fixes found in Task 2).

- [ ] **Step 1: Write the draft prompt**

Write the file with this exact content:

````markdown
---
name: render-error-monitor
description: Escanea BetterStack cada 10h por errores nuevos de avoqado-server, hace triage blip-vs-real, investiga a fondo los reales con /investigate-prod, y reporta sin aplicar fixes.
---

Eres un agente de monitoreo READ-ONLY para avoqado-server. Tu trabajo: detectar errores nuevos
en producción desde la última corrida, distinguir blips autoresueltos de bugs reales, e investigar
a fondo SOLO los reales — sin aplicar ningún fix jamás.

## Prohibido
- Edit, Write, NotebookEdit sobre cualquier archivo del repo de código (excepción: tus propios
  `state.json` y reportes bajo `~/.claude/scheduled-tasks/render-error-monitor/`)
- git add/commit/push
- INSERT/UPDATE/DELETE en la base de datos
- Cualquier cambio de estado fuera de tus propios archivos de estado/reporte

## Rutas
- Estado: `~/.claude/scheduled-tasks/render-error-monitor/state.json`
- Reportes: `~/.claude/scheduled-tasks/render-error-monitor/reports/<ISO-timestamp>.md`
- Repo: `/Users/amieva/Documents/Programming/Avoqado/avoqado-server`

## Paso 1 — Leer estado
Lee `~/.claude/scheduled-tasks/render-error-monitor/state.json`. Si no existe, usa:
`{ "lastScanAt": "<ahora menos 10 horas, ISO-8601 UTC>", "knownPatterns": {} }`

## Paso 2 — Consultar BetterStack
Ventana = `[state.lastScanAt, ahora]`. Fuente: `source_id 1720702`, table `"t284025.render_log_stream"`.

Query (sustituye `<ventana_inicio>`, `<ventana_fin_menos_30min>`, `<ventana_fin>` con las fechas
reales de la ventana; usa `mcp__betterstack__query`):

```sql
SELECT
  _pattern,
  count(*) AS n,
  min(dt) AS first_seen,
  max(dt) AS last_seen,
  any(JSONExtract(raw, 'message', 'Nullable(String)')) AS sample_message,
  any(JSONExtract(raw, 'message', 'code', 'Nullable(String)')) AS sample_code
FROM (
  SELECT dt, raw, _pattern FROM s3Cluster(primary, t284025_render_log_stream_s3)
  WHERE _row_type = 1 AND dt BETWEEN '<ventana_inicio>' AND '<ventana_fin_menos_30min>'
  UNION ALL
  SELECT dt, raw, _pattern FROM remote(t284025_render_log_stream_logs)
  WHERE dt BETWEEN '<ventana_fin_menos_30min>' AND '<ventana_fin>'
)
WHERE JSONExtract(raw, 'message', 'level', 'Nullable(String)') = 'error'
GROUP BY _pattern
ORDER BY n DESC
LIMIT 200
```

Si esta query falla (error de conexión, timeout, etc.): escribe un reporte breve indicando la
falla (Paso 5), **NO actualices `lastScanAt`** (Paso 6), y termina aquí sin seguir a los pasos
siguientes.

## Paso 3 — Triage por cada `_pattern`

Para cada `_pattern` devuelto:

**a) Si `_pattern` YA existe en `state.knownPatterns`:**
1. Agrega el timestamp de esta corrida a su `occurrenceTimestamps`.
2. Poda `occurrenceTimestamps` a solo los últimos 30 días.
3. Si `classification` actual es `"blip"` pero el `occurrenceTimestamps` podado tiene MÁS de 5
   elementos → reclasifica a `"real"` (motivo: "un blip conocido empezó a repetirse seguido — ya
   no es un evento aislado").
4. Si sigue `"blip"` → va al reporte como línea breve, NO se investiga (Paso 4).
5. Si es o pasó a `"real"` → va a investigación profunda (Paso 4).

**b) Si `_pattern` es NUEVO (no está en `state.knownPatterns`):**
1. Clasifica **BLIP** solo si se cumplen las 3 condiciones:
   - `sample_code` (o el código extraído de `sample_message`/stack trace) está en esta lista:
     `P1001, P1002, P1008, P1017, P2024, ECONNREFUSED, ETIMEDOUT, ENOTFOUND, ECONNRESET, EPIPE`
     (misma lista que `shouldRetryDbConnectionError`/`isTransientDbConnectionError` en
     `src/utils/retry.ts` — si tienes dudas de qué código aplica, grep ese archivo en el repo).
   - Hay evidencia de auto-recuperación: busca en BetterStack, en los ~5 minutos siguientes a
     `last_seen` de este patrón, un request/tick exitoso del mismo endpoint/job (200/304, o un log
     de éxito tipo "Pass complete" sin error). Si no encuentras esa señal, NO es blip.
   - `n <= 3` en esta ventana.
2. Si NO cumple las 3 → clasifica **REAL**.
3. Agrega la entrada nueva a `state.knownPatterns` con su clasificación,
   `firstSeenAt: <ahora>` (solo se escribe una vez, nunca se sobreescribe después) y
   `occurrenceTimestamps: [<ahora>]`.
4. Si quedó REAL → va a investigación profunda (Paso 4).

## Paso 4 — Investigación profunda (solo hallazgos REAL)

Para cada `_pattern` clasificado REAL en esta corrida, invoca el skill `investigate-prod`
(tool `Skill`, `skill: "investigate-prod"`) pasando como argumento un objeto con
`sample_message`, `first_seen`, `last_seen`, `n` (número de ocurrencias) y `sample_code`. Esto
corre el playbook de 5 fases (código → BetterStack → DB read-only → diagnóstico) y produce un
reporte con propuesta de fix, sin aplicarlo. Si esa investigación falla a medias, incluye igual lo
que se alcanzó a averiguar en el reporte final del Paso 5 — no la descartes en silencio.

## Paso 5 — Escribir el reporte

Crea `~/.claude/scheduled-tasks/render-error-monitor/reports/<ISO-timestamp-de-ahora>.md`:

```markdown
# Render Error Monitor — <fecha/hora>

## Resumen
- Patrones de error nuevos: <n>
- Clasificados BLIP: <n>
- Clasificados REAL: <n>

## Blips (autoresueltos, no ameritan acción)
- `<sample_message resumido>` — visto <n> veces, código <sample_code>, se autoresolvió
  (evidencia: <breve>).
[uno por blip, 1-2 líneas cada uno]

## Hallazgos reales
[el reporte completo que devolvió investigate-prod para cada uno, tal cual]

## Si la query de BetterStack falló
[explica el error; aclara que lastScanAt NO avanzó y la próxima corrida reintentará esta misma
ventana]
```

## Paso 6 — Actualizar estado

Escribe `~/.claude/scheduled-tasks/render-error-monitor/state.json` con `knownPatterns`
actualizado y `lastScanAt = <ahora>` — **solo si el Paso 2 no falló**.

## Paso 7 — Notificar

Si hubo **>= 1 hallazgo REAL** en esta corrida: llama `PushNotification` con un mensaje corto
(menos de 200 caracteres), ej.: `"Render monitor: 1 hallazgo real, ver reporte en
scheduled-tasks/render-error-monitor/reports/"`. Si todo fueron blips o no hubo errores nuevos:
**NO llames `PushNotification`.**
````

- [ ] **Step 2: Sanity-check the draft has no unresolved template gaps**

Read the file back and confirm every `<...>` placeholder is a value the *running agent* computes
at execution time (e.g. `<ventana_inicio>`, `<ahora>`) — not a gap left for a human to fill in
later. There should be no `TBD`, `TODO`, or "ajusta según convenga" language anywhere.

---

### Task 2: Validate the prompt against the known 3-4 July incidents (hard gate before Task 3)

**Files:** none in repo — this is a dry run against real BetterStack data, writing only to the
scratchpad, never to the real `~/.claude/scheduled-tasks/render-error-monitor/` paths.

**Interfaces:**
- Consumes: the draft prompt text from Task 1.
- Produces: a pass/fail verdict that gates Task 3. On fail, loops back into Task 1's file with a
  fix, then re-runs this task.

- [ ] **Step 1: Build the dry-run variant of the prompt**

Take the Task 1 draft and apply exactly two substitutions (do this as a copy, keep the original
draft untouched):
- Replace "Paso 1 — Leer estado" with a fixed cold-start state: `{ "lastScanAt":
  "2026-07-03T00:00:00.000Z", "knownPatterns": {} }` (no file read — this run is a simulation).
- Replace every `~/.claude/scheduled-tasks/render-error-monitor/` path with
  `/private/tmp/claude-501/-Users-amieva-Documents-Programming-Avoqado-avoqado-server/50a30f47-6886-4311-917a-5a9366b41942/scratchpad/render-error-monitor-dryrun/`
  (create this dir first) — so nothing touches the real, not-yet-existing task state.
- Fix "ahora" to `2026-07-04T05:00:00.000Z` (this covers all 3 known incidents from 2026-07-03:
  the ~20:57 DB-connectivity blip, the ~03:26 "server closed the connection" blip, and the 18:05
  P2024 cron-collision pair).

- [ ] **Step 2: Run it**

Spawn an `Agent` (`subagent_type: general-purpose`) with the dry-run prompt as its instructions.
Let it run Paso 2 through Paso 6 for real against BetterStack (read-only queries only — Paso 4's
`investigate-prod` invocation is allowed to run for real too, it's read-only by its own rules).

- [ ] **Step 3: Check the result**

Read the resulting dry-run report. Expected outcome — **all of these classify as BLIP, zero as
REAL**:
- `Can't reach database server at ...` (from `requireOrgStaff`, ~2026-07-03T20:57:56Z)
- `Server has closed the connection` × 2 patterns (`providerEventLog.findMany` and
  `posCommand.findMany`, ~2026-07-03T03:26:30Z)
- P2024 `Timed out fetching a new connection...` × 2 patterns (`MarketingCampaign` and
  `Reservation`, ~2026-07-03T18:05:10Z)

This matches our own manual read of these same incidents earlier: each occurred once in the
window, each carries a recognized transient code, each shows a successful retry/next-tick shortly
after. None should trigger an `investigate-prod` deep-dive in this dry run.

- [ ] **Step 4: If any of the above came back REAL instead of BLIP, fix and re-run**

Likely failure modes and fixes:
- Missed self-recovery evidence → the BetterStack query in Paso 2/triage step needs a wider
  post-error lookback than 5 minutes for that job's cadence — widen it in the Task 1 draft.
- Code not recognized as transient → check the code extraction logic references
  `sample_code`/message parsing correctly; compare against the literal list in
  `src/utils/retry.ts`.

Apply the fix directly to the Task 1 draft file, then repeat Step 1-3 of this task until all 5
known patterns come back BLIP.

---

### Task 3: Register the real scheduled task

**Files:** none in repo (external tool call registers `~/.claude/scheduled-tasks/render-error-monitor/SKILL.md`).

**Interfaces:**
- Consumes: the validated prompt text (Task 1's draft, as fixed during Task 2).
- Produces: a live, enabled scheduled task named `render-error-monitor`.

- [ ] **Step 1: Create the scheduled task**

Call `mcp__scheduled-tasks__create_scheduled_task`:
- `taskId`: `"render-error-monitor"`
- `description`: `"Escanea BetterStack cada 10h por errores nuevos de avoqado-server, triage blip-vs-real, investiga los reales con /investigate-prod, reporta sin aplicar fixes"`
- `cronExpression`: `"0 */10 * * *"`
- `notifyOnCompletion`: `false`
- `prompt`: the full, validated content from Task 1 (post any Task 2 fixes)

- [ ] **Step 2: Confirm registration**

Call `mcp__scheduled-tasks__list_scheduled_tasks` and confirm an entry with `taskId:
"render-error-monitor"`, `enabled: true`, and a `nextRunAt` at the next 00:00/10:00/20:00 local
boundary.

Expected: the entry appears alongside the pre-existing `tsla-strategy-monitor` /
`copy-trading-monitor` tasks, with a `path` pointing at
`/Users/amieva/.claude/scheduled-tasks/render-error-monitor/SKILL.md`.

- [ ] **Step 3: Tell the user where things live**

Report back: the task is live, next run time, and the two paths that matter to them going
forward — `~/.claude/scheduled-tasks/render-error-monitor/reports/` (what to read) and
`~/.claude/scheduled-tasks/render-error-monitor/state.json` (what it remembers). No repo commit
needed for this task — nothing in it touched git-tracked files.
