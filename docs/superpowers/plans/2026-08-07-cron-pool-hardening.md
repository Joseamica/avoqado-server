# Cron Pool Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evitar que los trabajos de 30 segundos y los monitores POS/TPV pidan conexiones exactamente al mismo tiempo, sin cambiar
frecuencia ni la política P2024.

**Architecture:** Los patrones cron se centralizan y se prueban como calendario conjunto. Los jobs que hoy admiten auto-solapamiento reciben
una guarda `isRunning/finally`; POS usa `node-cron` con `noOverlap: true`.

**Tech Stack:** TypeScript, cron 4.3, node-cron 4.2, Jest.

**Spec:** `docs/superpowers/specs/2026-08-07-cron-pool-hardening-design.md`

## Global Constraints

- Sin worktree, branch change, commits ni staging.
- Otro LLM trabaja en el mismo server; verificar targets antes de cada parche y preservar cambios ajenos.
- TDD: observar rojo antes de producción.
- No cambiar pool, cadencias, lotes, lógica de negocio ni `shouldRetryDbConnectionError`.
- Patrones: terminal `8,38`; Blumon `11,41`; TPV `14 */2`; POS `17 1-59/5`; inbox `23,53`; outbox `26,56`.

---

### Task 1: Política de schedules sin colisiones

**Files:**

- Create: `src/jobs/jobSchedules.ts`
- Test: `tests/unit/jobs/jobSchedules.test.ts`

**Interfaces:**

- Produce `JOB_SCHEDULES` con los seis patrones exactos.

- [ ] **Step 1: Escribir test rojo que expande diez minutos con `CronTime`**

```ts
it('keeps cadence and gives every database job a unique start instant', () => {
  const occurrences = expandSchedules(JOB_SCHEDULES, start, end)
  expect(countFor('terminalPaymentWatchdog')).toBe(20)
  expect(countFor('blumonWebhookReconciliation')).toBe(20)
  expect(countFor('gcalInboxSweeper')).toBe(20)
  expect(countFor('gcalOutboxSweeper')).toBe(20)
  expect(countFor('tpvHealthMonitor')).toBe(5)
  expect(countFor('posConnectionMonitor')).toBe(2)
  expect(maxStartsAtSameInstant(occurrences)).toBe(1)
})
```

- [ ] **Step 2: Correr y confirmar FAIL por módulo ausente**

```bash
npx jest --runInBand --runTestsByPath tests/unit/jobs/jobSchedules.test.ts
```

- [ ] **Step 3: Crear constantes y correr verde**

```ts
export const JOB_SCHEDULES = {
  terminalPaymentWatchdog: '8,38 * * * * *',
  blumonWebhookReconciliation: '11,41 * * * * *',
  tpvHealthMonitor: '14 */2 * * * *',
  posConnectionMonitor: '17 1-59/5 * * * *',
  gcalInboxSweeper: '23,53 * * * * *',
  gcalOutboxSweeper: '26,56 * * * * *',
} as const
```

---

### Task 2: Guardas de no-solapamiento

**Files:**

- Modify: `src/jobs/terminal-payment-watchdog.job.ts`
- Modify: `src/jobs/blumon-webhook-reconciliation.job.ts`
- Modify: `src/jobs/tpv-health-monitor.job.ts`
- Modify: `src/jobs/monitorPosConnections.ts`
- Test: `tests/unit/jobs/terminal-payment-watchdog.job.test.ts`
- Test: `tests/unit/jobs/blumon-webhook-reconciliation.job.test.ts`
- Test: `tests/unit/jobs/tpv-health-monitor.job.test.ts`
- Test: `tests/unit/jobs/monitorPosConnections.test.ts`

- [ ] **Step 1: Escribir tests rojos con promesa diferida**

```ts
const first = job.runNow()
await job.runNow()
expect(underlyingOperation).toHaveBeenCalledTimes(1)
resolveFirst()
await first
await job.runNow()
expect(underlyingOperation).toHaveBeenCalledTimes(2)
```

Para POS, mockear `cron.schedule` y exigir `{ noOverlap: true }`.

- [ ] **Step 2: Correr rojo**

```bash
npx jest --runInBand --runTestsByPath tests/unit/jobs/terminal-payment-watchdog.job.test.ts tests/unit/jobs/blumon-webhook-reconciliation.job.test.ts tests/unit/jobs/tpv-health-monitor.job.test.ts tests/unit/jobs/monitorPosConnections.test.ts
```

- [ ] **Step 3: Implementar en cada `CronJob`**

```ts
if (this.isRunning) {
  logger.warn('[job] tick skipped — previous run still in progress')
  return
}
this.isRunning = true
try {
  await operation()
} finally {
  this.isRunning = false
}
```

- [ ] **Step 4: Correr verde y comprobar que un error también libera la guarda**

---

### Task 3: Cablear los seis schedules

**Files:**

- Modify: los seis jobs de Task 1.
- Test: `tests/unit/jobs/jobSchedules.test.ts`
- Test: `tests/unit/jobs/gcal-outbox-sweeper.test.ts`

- [ ] **Step 1: Sustituir literales por `JOB_SCHEDULES.<name>`**
- [ ] **Step 2: Actualizar mensajes y `getJobStatus().cronPattern`**
- [ ] **Step 3: Ejecutar tests de jobs**

```bash
npx jest --runInBand --runTestsByPath tests/unit/jobs/jobSchedules.test.ts tests/unit/jobs/terminal-payment-watchdog.job.test.ts tests/unit/jobs/blumon-webhook-reconciliation.job.test.ts tests/unit/jobs/gcal-outbox-sweeper.test.ts tests/unit/jobs/tpv-health-monitor.job.test.ts tests/unit/jobs/monitorPosConnections.test.ts
```

---

### Task 4: Verificación de retry y concurrencia

- [ ] Ejecutar tests de retry para confirmar P2024 sin retry y P1001 con retry.
- [ ] Ejecutar typecheck completo.
- [ ] Ejecutar `git diff --check` y revisar diffs de targets.
- [ ] Confirmar que cambios ajenos siguen intactos y no están staged.

```bash
npx jest --runInBand --runTestsByPath tests/unit/utils/retry.test.ts
npm run typecheck
git diff --check
git status --short
```
