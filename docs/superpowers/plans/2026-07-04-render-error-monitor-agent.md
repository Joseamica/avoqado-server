# Render Error Monitor Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a scheduled Claude Code task that scans avoqado-server's Render errors every 10h, auto-triages blip vs.
needs-investigation, deep-investigates everything non-blip via `/investigate-prod` (landing each in "sin acción" or "requiere atención" by
that investigation's own verdict), and reports — never applying fixes itself.

**Architecture:** A single `mcp__scheduled-tasks` entry (`render-error-monitor`) whose entire behavior lives in one self-contained
`SKILL.md` prompt. No repo code changes — the artifact lives outside git at `~/.claude/scheduled-tasks/render-error-monitor/`. Full design
rationale:
[docs/superpowers/specs/2026-07-04-render-error-monitor-agent-design.md](../specs/2026-07-04-render-error-monitor-agent-design.md).

**Tech Stack:** Claude Code scheduled tasks (`mcp__scheduled-tasks__*`), BetterStack ClickHouse queries (`mcp__betterstack__query`,
source_id `1720702`), the existing `/investigate-prod` skill, `PushNotification`.

## Global Constraints

- **100% read-only over business code/DB.** The agent never edits repo files, never `git commit`s, never runs INSERT/UPDATE/DELETE. The only
  files it ever writes are its own `state.json` and its own `reports/*.md` under `~/.claude/scheduled-tasks/render-error-monitor/`.
- **Nothing in this plan touches the avoqado-server git repo** except this plan document and the design spec (already committed at
  `44ada7d8`). The scheduled task, its state, and its reports live entirely outside git by design (spec §3) — don't add a repo task for
  them.
- **Cron is `0 */10 * * *`** (fires 00:00, 10:00, 20:00 local daily — gaps of 10h/10h/4h, not perfectly even since 24 isn't divisible by 10,
  but close enough for this use case). `notifyOnCompletion: false` at registration — the prompt itself calls `PushNotification`
  conditionally instead.
- **Blip criteria (spec §5, revised after Task 2's first validation run):** code in
  `{P1001, P1002, P1008, P1017, ECONNREFUSED, ETIMEDOUT, ENOTFOUND, ECONNRESET, EPIPE}` (same list as `shouldRetryDbConnectionError` in
  `src/utils/retry.ts`) + self-recovery evidence + ≤3 historical occurrences. **`P2024` is explicitly excluded from blip eligibility — it
  always routes to investigation**, regardless of recovery evidence or occurrence count (pool exhaustion is a structural-fragility signal,
  not a random network blip). A blip loses its auto-discard status once it exceeds 5 occurrences in a trailing 30-day window and routes to
  investigation on its next occurrence. Everything that routes to investigation lands in `investigado_sin_accion` or `requiere_atencion` per
  `investigate-prod`'s own "¿Requiere fix?" verdict — never a pre-guessed exclusion list. `PushNotification` fires only for
  `requiere_atencion`.
- **Validate before activating the recurring cron** (spec §9) — Task 2 below is a hard gate before Task 3 registers the real schedule.

---

### Task 1: Draft the complete SKILL.md prompt

**Files:**

- Create:
  `/private/tmp/claude-501/-Users-amieva-Documents-Programming-Avoqado-avoqado-server/50a30f47-6886-4311-917a-5a9366b41942/scratchpad/render-error-monitor-SKILL.draft.md`
  (working copy — NOT the final registered location; Task 3 registers the real one via tool call, not by writing this path directly)

**Interfaces:**

- Produces: the exact prompt text Task 2 validates and Task 3 registers verbatim (after any fixes found in Task 2).

- [ ] **Step 1: Write the draft prompt**

Write the file with this exact content:

````markdown
---
name: render-error-monitor
description:
  Escanea BetterStack cada 10h por errores nuevos de avoqado-server, hace triage blip vs. investigar, investiga a fondo todo lo no-blip con
  /investigate-prod, y reporta sin aplicar fixes.
---

Eres un agente de monitoreo READ-ONLY para avoqado-server. Tu trabajo: detectar errores nuevos en producción desde la última corrida,
distinguir blips autoresueltos de todo lo demás, e investigar a fondo todo lo que no sea blip — sin aplicar ningún fix jamás. El veredicto
de esa investigación decide si el hallazgo queda como "sin acción" o "requiere atención".

## Prohibido

- Edit, Write, NotebookEdit sobre cualquier archivo del repo de código (excepción: tus propios `state.json` y reportes bajo
  `~/.claude/scheduled-tasks/render-error-monitor/`)
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

Query (sustituye `<ventana_inicio>`, `<ventana_fin_menos_30min>`, `<ventana_fin>` con las fechas reales de la ventana; usa
`mcp__betterstack__query`):

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

Si esta query falla (error de conexión, timeout, etc.): escribe un reporte breve indicando la falla (Paso 5), **NO actualices `lastScanAt`**
(Paso 6), y termina aquí sin seguir a los pasos siguientes.

## Paso 3 — Triage por cada `_pattern`

Para cada `_pattern` devuelto:

**a) Si `_pattern` YA existe en `state.knownPatterns`:**

1. Agrega el timestamp de esta corrida a su `occurrenceTimestamps`.
2. Poda `occurrenceTimestamps` a solo los últimos 30 días.
3. Si `classification` actual es `"blip"` pero el `occurrenceTimestamps` podado tiene MÁS de 5 elementos → deja de auto-descartarse (motivo:
   "un blip conocido empezó a repetirse seguido — ya no es un evento aislado") → pasa a investigación profunda (Paso 4) como cualquier
   no-blip.
4. Si sigue `"blip"` (sin reclasificar) → va al reporte como línea breve, NO se investiga.
5. Si `classification` actual es `"investigado_sin_accion"` o `"requiere_atencion"` → SIEMPRE pasa a investigación profunda de nuevo (Paso
   4), aunque ya se haya investigado antes — es la única forma de detectar si algo antes benigno cambió de comportamiento. Intencional, no
   ineficiencia: estos patrones son raros en la práctica (~1/semana visto hoy).

**b) Si `_pattern` es NUEVO (no está en `state.knownPatterns`):**

1. Si `sample_code` (o el código extraído de `sample_message`/stack trace) es exactamente `P2024`: NUNCA clasifica BLIP, sin importar
   auto-recuperación u ocurrencias — pasa directo a investigación profunda (Paso 4). Pool de conexiones agotado es señal de fragilidad
   estructural (el cron-collision del 3 de julio es exactamente este caso), a diferencia de un blip de red al azar. La mayoría de las veces
   la investigación va a concluir que no requiere fix — pero se mira siempre, nunca se entierra en silencio.
2. Si NO es `P2024`, clasifica **BLIP** solo si se cumplen las 3 condiciones:
   - `sample_code` está en esta lista: `P1001, P1002, P1008, P1017, ECONNREFUSED, ETIMEDOUT, ENOTFOUND, ECONNRESET, EPIPE` (misma lista que
     `shouldRetryDbConnectionError` en `src/utils/retry.ts` — **`P2024` queda fuera de esta lista a propósito**, ver punto 1 arriba. Si
     tienes dudas de qué código aplica, grep ese archivo en el repo).
   - Hay evidencia de auto-recuperación: busca en BetterStack, en los ~5 minutos siguientes a `last_seen` de este patrón, un request/tick
     exitoso del mismo endpoint/job (200/304, o un log de éxito tipo "Pass complete" sin error). Si no encuentras esa señal, NO es blip.
   - `n <= 3` en esta ventana.
3. Si no cumple las 3 condiciones (o es `P2024`) → pasa a investigación profunda (Paso 4). NO adivines de antemano si el mensaje "suena
   benigno" (ej. un JWT expirado) — investígalo siempre; el veredicto real de la investigación decide la categoría final, nunca una lista de
   exclusión armada de antemano (arriesgaría esconder algo que sí importaba).
4. Agrega la entrada nueva a `state.knownPatterns` con `firstSeenAt: <ahora>` (solo se escribe una vez, nunca se sobreescribe después) y
   `occurrenceTimestamps: [<ahora>]`. Si clasificó BLIP, `classification: "blip"` ahora mismo. Si pasó a investigación, su `classification`
   final (`"investigado_sin_accion"` o `"requiere_atencion"`) se decide en el Paso 4 — no la asignes todavía.

## Paso 4 — Investigación profunda (todo lo que no calificó como blip)

Para cada `_pattern` que pasó a investigación en el Paso 3 (nuevo-no-blip, conocido no-blip re-investigado, o blip reclasificado), invoca el
skill `investigate-prod` (tool `Skill`, `skill: "investigate-prod"`) pasando como argumento un objeto con `sample_message`, `first_seen`,
`last_seen`, `n` (número de ocurrencias) y `sample_code`. Esto corre el playbook de 5 fases (código → BetterStack → DB read-only →
diagnóstico) y produce un reporte que termina en un veredicto "¿Requiere fix?" (Sí/No) + propuesta de fix cuando aplique, sin aplicarlo
nunca.

Lee ese veredicto final:

- "Requiere fix? No" → `classification: "investigado_sin_accion"` para este `_pattern` en `state.knownPatterns` (Paso 6).
- "Requiere fix? Sí" → `classification: "requiere_atencion"`.
- Si la investigación falla a medias y no llegas a un veredicto claro → `classification: "requiere_atencion"` por defecto (fail-safe: más
  vale un falso positivo ocasional que esconder algo por una investigación incompleta) — incluye igual en el reporte (Paso 5) lo que se
  alcanzó a averiguar, no lo descartes en silencio.

## Paso 5 — Escribir el reporte

Crea `~/.claude/scheduled-tasks/render-error-monitor/reports/<ISO-timestamp-de-ahora>.md`:

```markdown
# Render Error Monitor — <fecha/hora>

## Resumen

- Patrones de error nuevos: <n>
- Clasificados BLIP: <n>
- Investigados, sin acción requerida: <n>
- Requieren atención: <n>

## Blips (autoresueltos, no ameritan acción)

- `<sample_message resumido>` — visto <n> veces, código <sample_code>, se autoresolvió (evidencia: <breve>). [uno por blip, 1-2 líneas cada
  uno]

## Investigado, sin acción requerida

[el reporte completo que devolvió investigate-prod para cada uno, tal cual — termina en "Requiere fix? No"]

## Requiere atención

[el reporte completo que devolvió investigate-prod para cada uno, tal cual — termina en "Requiere fix? Sí", o quedó incompleto y se catalogó
aquí por defecto]

## Si la query de BetterStack falló

[explica el error; aclara que lastScanAt NO avanzó y la próxima corrida reintentará esta misma ventana]
```

**Nota aceptada (no es un bug):** un mismo incidente puede generar más de un `_pattern` distinto — por ejemplo, la excepción real (con su
código) y el log de acceso genérico `Request End: ... - 5xx` del mismo request (sin código propio). Ambos se evalúan por separado; el
segundo normalmente pasa a investigación aunque el primero ya se haya descartado como blip, apareciendo como un hallazgo aparentemente
redundante. Esto se acepta a propósito — es más simple que correlacionar ambos logs como "el mismo evento", y el costo es solo ruido
ocasional en el reporte, no una acción equivocada. No intentes filtrar esto.

## Paso 6 — Actualizar estado

Escribe `~/.claude/scheduled-tasks/render-error-monitor/state.json` con `knownPatterns` actualizado y `lastScanAt = <ahora>` — **solo si el
Paso 2 no falló**.

## Paso 7 — Notificar

Si hubo **>= 1 hallazgo clasificado `requiere_atencion`** en esta corrida: llama `PushNotification` con un mensaje corto (menos de 200
caracteres), ej.: `"Render monitor: 1 hallazgo requiere atención, ver reporte en scheduled-tasks/render-error-monitor/reports/"`. Si todo
fue blip o `investigado_sin_accion` (o no hubo errores nuevos): **NO llames `PushNotification`** — evita avisos por cosas como `P2024`s que
la propia investigación concluyó que son inofensivas.
````

- [ ] **Step 2: Sanity-check the draft has no unresolved template gaps**

Read the file back and confirm every `<...>` placeholder is a value the _running agent_ computes at execution time (e.g. `<ventana_inicio>`,
`<ahora>`) — not a gap left for a human to fill in later. There should be no `TBD`, `TODO`, or "ajusta según convenga" language anywhere.

---

### Task 2: Validate the prompt against the known 3-4 July incidents (hard gate before Task 3)

**Files:** none in repo — this is a dry run against real BetterStack data, writing only to the scratchpad, never to the real
`~/.claude/scheduled-tasks/render-error-monitor/` paths.

**Interfaces:**

- Consumes: the draft prompt text from Task 1.
- Produces: a pass/fail verdict that gates Task 3. On fail, loops back into Task 1's file with a fix, then re-runs this task.

- [ ] **Step 1: Build the dry-run variant of the prompt**

Take the Task 1 draft and apply exactly two substitutions (do this as a copy, keep the original draft untouched):

- Replace "Paso 1 — Leer estado" with a fixed cold-start state: `{ "lastScanAt": "2026-07-03T00:00:00.000Z", "knownPatterns": {} }` (no file
  read — this run is a simulation).
- Replace every `~/.claude/scheduled-tasks/render-error-monitor/` path with
  `/private/tmp/claude-501/-Users-amieva-Documents-Programming-Avoqado-avoqado-server/50a30f47-6886-4311-917a-5a9366b41942/scratchpad/render-error-monitor-dryrun/`
  (create this dir first) — so nothing touches the real, not-yet-existing task state.
- Fix "ahora" to `2026-07-04T05:00:00.000Z` (this covers all 3 known incidents from 2026-07-03: the ~20:57 DB-connectivity blip, the ~03:26
  "server closed the connection" blip, and the 18:05 P2024 cron-collision pair).

- [ ] **Step 2: Run it**

Spawn an `Agent` (`subagent_type: general-purpose`) with the dry-run prompt as its instructions. Let it run Paso 2 through Paso 6 for real
against BetterStack (read-only queries only — Paso 4's `investigate-prod` invocation is allowed to run for real too, it's read-only by its
own rules).

- [ ] **Step 3: Check the result**

A real dry run already ran once during design against this exact window (2026-07-03T00:00Z to 2026-07-04T05:00Z, cold start) and — beyond
the 5 patterns originally scoped for this check — also surfaced a few more real patterns present in that window: a `GET /promoters` 500
access-log line (the symptom of the same P1001 blip below, expected to land as its own non-blip finding — see the "nota aceptada" in Paso 5,
this is accepted redundancy, not a defect), 5 occurrences of a `liveDemoSession` P2025 (already fixed and deployed hours after these log
lines — expect `investigado_sin_accion` once `investigate-prod` checks `git log` and finds the fix predates these logs), and a JWT-expired
401 (expected auth flow — expect `investigado_sin_accion`). Don't be surprised if the corrected run reproduces this same broader set —
that's expected, not a regression from the original narrower scope.

Read the resulting dry-run report. Expected outcome for the 5 originally-scoped patterns:

- `Can't reach database server at ...` (from `requireOrgStaff`, ~2026-07-03T20:57:56Z) → **BLIP**
- `Server has closed the connection` × 2 patterns (`providerEventLog.findMany` and `posCommand.findMany`, ~2026-07-03T03:26:30Z) → **BLIP**
- P2024 `Timed out fetching a new connection...` × 2 patterns (`MarketingCampaign` and `Reservation`, ~2026-07-03T18:05:10Z) →
  **`investigado_sin_accion`** (never BLIP by design — see Paso 3b point 1 — but the investigation itself should conclude "Requiere fix?
  No": both jobs already wrap their read in `retry(shouldRetryDbConnectionError)` correctly, and the pool recovers on the next tick with no
  backlog)

**Nothing in this run should produce a `PushNotification`** — no pattern in this window should land in `requiere_atencion`. If the dry-run's
simulated notification step fires, that's a FAIL — something in this window is being over-classified.

- [ ] **Step 4: If the 3 BLIP patterns came back as something else, or a `PushNotification` fired unexpectedly, fix and re-run**

Likely failure modes and fixes:

- One of the 3 blip patterns didn't classify BLIP → missed self-recovery evidence (the BetterStack query in Paso 2/triage step needs a wider
  post-error lookback than 5 minutes for that job's cadence), or the code extraction logic didn't match `src/utils/retry.ts`'s
  `shouldRetryDbConnectionError` list — check `sample_code`/message parsing.
- A P2024 pattern classified BLIP instead of routing to investigation → the `P2024`-always-routes rule (Paso 3b point 1) isn't being applied
  before the general blip-code check; fix the ordering in the Task 1 draft.
- `PushNotification` fired → something landed in `requiere_atencion` that shouldn't have; read which pattern and whether
  `investigate-prod`'s own verdict was actually "Sí" (in which case the notification is correct and this isn't a failure) or whether the
  fail-safe default kicked in from an incomplete investigation (in which case check why the investigation didn't reach a clear verdict).

Apply the fix directly to the Task 1 draft file, then repeat Step 1-3 of this task until the 3 known patterns come back BLIP.

---

### Task 3: Register the real scheduled task

**Files:** none in repo (external tool call registers `~/.claude/scheduled-tasks/render-error-monitor/SKILL.md`).

**Interfaces:**

- Consumes: the validated prompt text (Task 1's draft, as fixed during Task 2).
- Produces: a live, enabled scheduled task named `render-error-monitor`.

- [ ] **Step 1: Create the scheduled task**

Call `mcp__scheduled-tasks__create_scheduled_task`:

- `taskId`: `"render-error-monitor"`
- `description`:
  `"Escanea BetterStack cada 10h por errores nuevos de avoqado-server, triage blip vs. investigar, investiga todo lo no-blip con /investigate-prod, reporta sin aplicar fixes"`
- `cronExpression`: `"0 */10 * * *"`
- `notifyOnCompletion`: `false`
- `prompt`: the full, validated content from Task 1 (post any Task 2 fixes)

- [ ] **Step 2: Confirm registration**

Call `mcp__scheduled-tasks__list_scheduled_tasks` and confirm an entry with `taskId: "render-error-monitor"`, `enabled: true`, and a
`nextRunAt` at the next 00:00/10:00/20:00 local boundary.

Expected: the entry appears alongside the pre-existing `tsla-strategy-monitor` / `copy-trading-monitor` tasks, with a `path` pointing at
`/Users/amieva/.claude/scheduled-tasks/render-error-monitor/SKILL.md`.

- [ ] **Step 3: Tell the user where things live**

Report back: the task is live, next run time, and the two paths that matter to them going forward —
`~/.claude/scheduled-tasks/render-error-monitor/reports/` (what to read) and `~/.claude/scheduled-tasks/render-error-monitor/state.json`
(what it remembers). No repo commit needed for this task — nothing in it touched git-tracked files.
