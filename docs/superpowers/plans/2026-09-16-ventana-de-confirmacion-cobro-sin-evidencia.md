# Ventana de confirmación para negativos sin evidencia (AngelPay / Nexgo) — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** cuando la terminal contesta un negativo SIN prueba del procesador (U100/U101/«Cancelled»/G505/N402…), la duda dura como máximo 30 s y se resuelve sola —webhook del banco, historial de AngelPay o un toque del cajero— y al vencer la ventana la VENTA y la ranura se liberan con evidencia propia, con vigilancia de 30 min y alarma si el banco aprueba tarde. Sin reinicio de la app, sin PIN para quien tiene permiso.

**Architecture:** el SERVIDOR es el único reloj: `closeRow` ya degrada esos negativos a `TIMED_OUT`; un temporizador de 30 s (respaldado por el watchdog de 30 s) los libera como `FAILED / NO_EVIDENCE_AFTER_WINDOW`, un código nuevo de la lista blanca (`CODIGOS_SIN_COBRO`) que la función `desenlaceCanonico` y el predicado SQL clasifican igual como NOT_CHARGED. Una aprobación tardía entra por el camino que ya existe (`closeRowFromPaymentTx`, CAS `paymentId: null`) y sólo añade alarma, correo y bitácora. La declaración del cajero es un endpoint que escribe `FAILED / OPERATOR_RECONCILED_NO_CHARGE` (código que YA existe en la lista blanca), autorizado por la sesión de la terminal con el permiso `payments:resolve-no-instrument` y, sólo si falta, por el PIN de alguien que lo tenga. La TPV no decide nada: consulta S6 hasta que el servidor conteste, ofrece el botón, y cierra su libreta con el veredicto. Los POS sólo cambian el texto según `outcomeEvidence`.

**Tech Stack:** TypeScript/Express/Prisma/Jest (servidor, `develop`) · Kotlin/Room/Retrofit/mockk/Robolectric (TPV, `main`) · Kotlin (Android POS, `main`) · Swift/XCTest (iOS, `main`) · `scripts/avq-verify.sh` para todo lo pesado · Codex `gpt-6-astra` acotado.

**Spec:** `/Users/amieva/Documents/Programming/Avoqado/docs/angelpay/2026-09-16-investigacion-u101-dobles-cobros-y-camino-de-salida.md` (§3–§7). Aprobado por el founder el 16-sep («Sí, adelante»). Contexto vigente que este plan asume: `avoqado-server/docs/superpowers/plans/2026-09-12-webhook-primer-confirmador.md` (checkpoints 1 y 2), `avoqado-tpv/.claude/rules/cobro-remoto-pos-a-tpv.md`.

## Global Constraints

- **Ramas:** servidor en `develop` (sin tocar `main`); TPV, Android e iOS en `main`. Nada se pushea ni se despliega sin GO del founder.
- **Git en árbol compartido:** nunca `reset --hard` / `checkout .` / `clean` / `stash` / cambio de rama. Commits sólo con `git commit -q -F - -- <rutas>` (archivos nuevos: `git add <ruta>` antes) y verificados con `git show --stat`. Servidor y root terminan con `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`; **la TPV no lleva Co-Authored-By**. Si un commit arrastra WIP ajeno, se declara, no se reescribe.
- **Dinero ⇒ TDD estricto:** cada tarea escribe primero la prueba, la ve en ROJO por el motivo correcto, luego el código. Los sabotajes van SIEMPRE en copia aislada (`~/.claude/jobs/b1e1a1b3/tmp/sab-server`, `…/sab-tpv`), nunca en el árbol compartido.
- **Bases de datos:** las pruebas de integración corren SÓLO contra la base desechable (`set -a; source ~/.claude/jobs/b1e1a1b3/tmp/db-desechable.env; set +a` ⇒ `TEST_DATABASE_URL=…avoqado_webhookcp1_test_1789323328`). Jamás `av-db-25` para nada destructivo. Nunca mis pruebas de DB a la vez que una certificación.
- **Verificación pesada por `avq-verify`** desde el root del workspace (typecheck, jest de más de un archivo, gradle, xcodebuild); `AVQ_KEEP=1`; leer el CUERPO (`errores TS: N`, `Tests:`), nunca el exit code. `forzar-dual` sigue plantado a propósito: no se quita. Nunca dos builds pesados míos a la vez. Nunca el `tsc` local de 8 GB a mano.
- **Codex:** un mecanismo NUEVO se revisa con Codex ANTES de codificar (Task 0) y el diff final se revisa acotado (Tasks 5 y 8). Se lee el cuerpo del veredicto (`agent_message`), no el exit code. Cada hallazgo se verifica contra el código antes de aceptarlo.
- **Contrato con las apps publicadas:** ningún campo se quita ni cambia de significado. `status` conserva sus valores; `outcomeEvidence` es aditivo. Las apps viejas leen `FAILED` como «no se cobró» — y con `NO_EVIDENCE_AFTER_WINDOW` eso es exactamente lo que queremos que hagan.
- **Ventana:** `UNPROVEN_NEGATIVE_WINDOW_MS = 30_000` (4× el máximo medido de 7 s del webhook). No es configurable por venue (YAGNI; se cambia con un deploy si la medición cambia).
- **Lo que NO se libera por ventana:** filas `UNKNOWN` (la terminal nunca contestó, o contestó `success` sin Payment acreditable, o el watchdog venció el plazo: su SDK puede seguir vivo / hubo una afirmación positiva) y `TIMED_OUT/AUTO_RELEASED` (regla del 12-sep, intacta). Sólo `TIMED_OUT` **con resultado de la terminal** (`resultJson.status = 'timeout'` **y** `resultJson.terminalResult` presente, `failureCode` nulo, sin `paymentId`). 🔴 Codex (Task 0, P1): HOY `resultToStatus('timeout')` escribe `UNKNOWN` (L856), así que la Task 2 cambia el escritor: un negativo sin evidencia o un `timeout` enviado por la TPV pasa a `TIMED_OUT`; el `success` degradado y el `catch` siguen en `UNKNOWN`.
- **Veto por evidencia bancaria conocida:** si existe un `ProviderEventLog` `send_transaction` APROBADO (`estadoBancarioSql`) de cualquier intento vinculado a la solicitud, la ventana NO libera aunque no exista Payment (el webhook llegó y el registrador falló o difirió el importe): la fila se marca `failureCode = 'BANK_APPROVED_AWAITING_PAYMENT'` (sigue UNRESOLVED: bloquea orden y ranura) y S4 la cierra al crear el Payment.
- **Riesgo aceptado por el founder (16-sep):** entre la liberación (30 s) y una aprobación tardía cabe un recobro sobre la misma orden (A liberada → B cobra a los 31 s → llega la aprobación de A). La ventana lo ACOTA y lo DETECTA (🚨 + bitácora + correo + conteo de cobros posteriores), no lo impide. La aprobación tardía por WEBHOOK sólo reabre intentos CON vínculo (checkpoint 2); un APK legacy sin vínculo sólo reabre por el registro REST.
- **Fuera de alcance, declarado:** PAX/Blumon (su clasificación no cambia; cuando su negativo llegue sin evidencia entra por la misma ventana del servidor sin tocar la TPV), reembolsos, kiosco, iOS del POS más allá del texto, conciliación general (B), y la exención de batería (Doze).
- **Prisma:** cualquier edición a `prisma/schema.prisma` regenera `docs/SCHEMA_MAP.md` (`npm run schema:map`) en el mismo commit. Migraciones a mano, aditivas, aplicadas a la base local y a la desechable.
- **MCP en lockstep:** la evidencia nueva se ve en `terminal_payment_requests` (Task 5).
- **Cierre de cada mensaje al founder:** 2–3 líneas en lenguaje llano.

---

## Mapa de archivos

**Servidor (`avoqado-server`, `develop`)**
- Modify `src/services/terminal-payment.service.ts` — tipo `TerminalOutcomeEvidence`, `CODIGOS_SIN_COBRO`, `closeRow` (conserva `terminalResult` + programa la ventana), `releaseUnprovenNegative`, `releaseUnprovenNegativesAfterWindow`, alarma de aprobación tardía en `closeRowFromPaymentTx`.
- Modify `src/jobs/terminal-payment-watchdog.job.ts` — llama `releaseUnprovenNegativesAfterWindow()` en cada pasada.
- Create `src/services/tpv/no-instrument-resolution.service.ts` — declaración del cajero (portada del worktree de Codex, un solo paso, autorización por sesión).
- Modify `src/controllers/tpv/terminal-payment.tpv.controller.ts` — `resolveNoInstrument`.
- Modify `src/routes/tpv.routes.ts` — `POST /venues/:venueId/terminal-payment/attempts/:attemptId/no-instrument-resolution`.
- Modify `src/lib/permissions.ts` — permiso `payments:resolve-no-instrument` (OWNER/ADMIN/MANAGER).
- Create `prisma/migrations/20260916193000_no_instrument_resolution/migration.sql` + Modify `prisma/schema.prisma` (`TerminalPaymentAttemptLink.operatorResolution Json?`) + `docs/SCHEMA_MAP.md`.
- Modify `src/mcp/tools/terminals.ts` — `terminal_payment_requests` expone `outcomeEvidence` y `releasedAfterWindow`.
- Tests: Modify `tests/unit/services/terminal-payment.service.test.ts`; Modify `tests/integration/payments/terminalPaymentRecovery.integration.test.ts`; Create `tests/integration/payments/terminalPaymentWindow.integration.test.ts`; Create `tests/unit/services/tpv/no-instrument-resolution.service.test.ts`; Create `tests/api-tests/tpv/no-instrument-resolution.api.test.ts`.
- Modify `CHANGELOG.md`.

**TPV (`avoqado-tpv`, `main`)**
- Modify `app/src/main/java/com/jaac/avoqado_tpv/features/payment/data/ledger/PaymentAttemptDao.kt` — `cerrarPorLiberacionDelServidor`.
- Modify `…/ledger/PaymentAttemptEntity.kt` — constante `SERVER_RELEASED_NO_EVIDENCE`, `SERVER_OPERATOR_NO_INSTRUMENT`.
- Modify `…/ledger/VeredictoDeIntento.kt` — `LiberacionDelServidor` leída del `request` de S6.
- Modify `…/ledger/PaymentAttemptLedger.kt` — `aplicarLiberacionDelServidor`, `leerIntento`.
- Modify `…/ledger/LedgerServerRecovery.kt` — aplica la liberación en N3.
- Modify `…/ledger/TerminalAttemptApiService.kt` — `resolveNoInstrument` (POST) + DTOs.
- Modify `…/presentation/angelpay/AngelPayPaymentViewModel.kt` — constructor (+`LedgerServerRecovery`, +`TerminalAttemptApiService`), `esperarVeredictoDelServidor`, `declararSinTarjeta`, `consultarDeNuevo`.
- Modify `…/presentation/angelpay/AngelPayPaymentState.kt` — `ResultadoIncierto` gana `segundosEsperando`, `puedeDeclarar`, `pidePin`.
- Modify `…/presentation/angelpay/AngelPayPaymentScreen.kt` — contador, botón «El cliente no presentó tarjeta», campo de PIN de respaldo, «Consultar de nuevo».
- Tests: Modify `app/src/test/java/com/jaac/avoqado_tpv/features/payment/data/ledger/VeredictoDelServidorRoomTest.kt`, `LedgerServerRecoveryRoomTest.kt`, `app/src/test/java/com/jaac/avoqado_tpv/features/payment/presentation/angelpay/AngelPayPaymentViewModelTest.kt`.
- Modify `CHANGELOG.md`.

**POS Android (`avoqado-android`, `main`)**: Modify `app/src/main/java/com/avoqado/pos/payment/domain/CardChargeOutcome.kt` + `app/src/test/java/com/avoqado/pos/payment/CardChargeDecisionTest.kt`.
**POS iOS (`avoqado-ios`, `main`)**: Modify `avoqado-ios/Payment/CardChargeOutcome.swift` + `avoqado-iosTests/CardChargeDecisionTests.swift`.

---

### Task 0: Revisión acotada de Codex del diseño (antes de escribir código)

**Files:**
- Create: `~/.claude/jobs/b1e1a1b3/tmp/prompt-codex-ventana-diseno.txt`
- Create: `~/.claude/jobs/b1e1a1b3/tmp/lanzar-codex-ventana-diseno.sh`

**Interfaces:** Consumes el spec §4 y este plan. Produces `~/.claude/jobs/b1e1a1b3/tmp/codex-ventana-diseno-veredicto.md`.

- [ ] **Step 1: Escribir el prompt (sólo lectura)**

```text
Revisión ACOTADA de diseño, sólo lectura, sobre avoqado-server (develop) y avoqado-tpv (main).
Lee primero: docs/angelpay/2026-09-16-investigacion-u101-dobles-cobros-y-camino-de-salida.md (§1, §3, §4)
y avoqado-server/docs/superpowers/plans/2026-09-16-ventana-de-confirmacion-cobro-sin-evidencia.md (cabecera, Global Constraints, Tasks 1–4).
Código que gobierna hoy: avoqado-server/src/services/terminal-payment.service.ts (desenlaceCanonico, CODIGOS_SIN_COBRO,
UNRESOLVED_FINANCIAL_OUTCOME, closeRow, closeRowFromPaymentTx, reconcileUnknownRequests) y
avoqado-tpv/app/src/main/java/com/jaac/avoqado_tpv/features/payment/presentation/angelpay/AngelPayPaymentViewModel.kt (verificarCobroIncierto, quedarSinVerificar).
Contesta SÓLO estas cinco preguntas, con archivo:línea:
1. ¿La elegibilidad «TIMED_OUT + failureCode NULL + paymentId NULL + resultJson.status = timeout» captura exactamente los negativos SIN evidencia
   de la terminal (y los `timeout` que la propia TPV emite) y NINGUNA fila UNKNOWN/AUTO_RELEASED/en vuelo? ¿Qué escritor de TIMED_OUT se me escapa?
2. ¿Liberar a FAILED/NO_EVIDENCE_AFTER_WINDOW puede pisar o esconder una aprobación que llegue después? Revisa el CAS de closeRowFromPaymentTx
   (`paymentId: null`) y el registrador del webhook: ¿reabre una FAILED con ese código a COMPLETED + lateResult? ¿Qué falta para que la alarma sea única?
3. ¿La ventana de 30 s desde updatedAt es medible con el dato (webhook p99 3.5 s, máx 7 s, n=927) y NO introduce un doble cobro nuevo cuando el POS
   reintenta a los 31 s sobre la MISMA orden? Enumera la secuencia exacta que cobraría doble, si existe.
4. Declaración del cajero por la SESIÓN de la terminal (authContext.userId = staff del PIN) con permiso efectivo, y PIN de elevación sólo si falta:
   ¿qué comprobación de identidad/pertenencia (venue, terminal, intento, link) hace falta para que un POS o una web no puedan acuñarla?
5. TPV: cerrar la fila INDETERMINADO como DESCARTADA con last_error = 'liberada_por_el_servidor:<evidencia>' SIN tocar host_approved:
   ¿rompe alguna invariante de la libreta (aviso F0, veredictosPendientesDeAplicar, SQL_CONTRADICCION, reserveTerminal)?
Formato: por pregunta, VEREDICTO (OK / CAMBIAR) + evidencia + cambio mínimo. Al final: «AUTORIZADO A CODIFICAR» o «NO AUTORIZADO» con la lista.
No propongas mecanismos nuevos fuera de estas cinco preguntas.
```

- [ ] **Step 2: Lanzar Codex (acotado, sólo lectura)**

```bash
J=~/.claude/jobs/b1e1a1b3/tmp
cat > "$J/lanzar-codex-ventana-diseno.sh" <<'SH'
#!/bin/bash
J=~/.claude/jobs/b1e1a1b3/tmp
cd /Users/amieva/Documents/Programming/Avoqado
codex exec --json --model gpt-6-astra -c model_reasoning_effort=xhigh --sandbox read-only \
  < "$J/prompt-codex-ventana-diseno.txt" > "$J/codex-ventana-diseno.jsonl" 2> "$J/codex-ventana-diseno.err"
python3 "$J/codex-parser.py" "$J/codex-ventana-diseno.jsonl" > "$J/codex-ventana-diseno-veredicto.md"
SH
chmod +x "$J/lanzar-codex-ventana-diseno.sh" && nohup "$J/lanzar-codex-ventana-diseno.sh" >/dev/null 2>&1 &
```

- [ ] **Step 3: Leer el veredicto y ajustar el plan**

Run: `cat ~/.claude/jobs/b1e1a1b3/tmp/codex-ventana-diseno-veredicto.md`
Expected: cinco veredictos. Cada «CAMBIAR» se verifica contra el código (archivo:línea) y, si es real, se edita la tarea correspondiente de este plan ANTES de codificar. No se codifica sin «AUTORIZADO A CODIFICAR».

---

### Task 1 (servidor): la evidencia `NO_EVIDENCE_AFTER_WINDOW` existe y se clasifica igual en JS y en SQL

**Files:**
- Modify: `src/services/terminal-payment.service.ts` (tipo `TerminalOutcomeEvidence` ~L652; `CODIGOS_SIN_COBRO` ~L332)
- Test: `tests/unit/services/terminal-payment.service.test.ts`
- Test: `tests/integration/payments/terminalPaymentRecovery.integration.test.ts` (lista `CODIGOS` de la prueba cartesiana ~L2207)

**Interfaces:**
- Produces: `TerminalOutcomeEvidence` incluye `'NO_EVIDENCE_AFTER_WINDOW'`; `desenlaceCanonico({ status: 'FAILED', failureCode: 'NO_EVIDENCE_AFTER_WINDOW' })` ⇒ `{ outcome: 'NOT_CHARGED', outcomeEvidence: 'NO_EVIDENCE_AFTER_WINDOW', evidenceClass: 'SERVER' }`; el predicado SQL lo deja fuera de `UNRESOLVED_FINANCIAL_OUTCOME` automáticamente (deriva de `Object.keys(CODIGOS_SIN_COBRO)`).

- [ ] **Step 1: Prueba unitaria en rojo**

Añadir en `tests/unit/services/terminal-payment.service.test.ts` un `describe('desenlaceCanonico — ventana de confirmación')` al final del archivo (hoy no hay ninguno: la cartesiana vive en integración). Importar la función junto a las que ya importa el archivo: `import { desenlaceCanonico, leerProcedencia, TERMINAL_ATTEMPT_LINK_VERSION, terminalPaymentService } from '@/services/terminal-payment.service'` y `import { TerminalPaymentRequestStatus } from '@prisma/client'` si no está:

```ts
  it('FAILED/NO_EVIDENCE_AFTER_WINDOW acredita «no se cobró» con clase SERVER (la ventana venció sin webhook, historial ni cajero)', () => {
    expect(desenlaceCanonico({ status: TerminalPaymentRequestStatus.FAILED, failureCode: 'NO_EVIDENCE_AFTER_WINDOW' })).toEqual({
      outcome: 'NOT_CHARGED',
      outcomeEvidence: 'NO_EVIDENCE_AFTER_WINDOW',
      evidenceClass: 'SERVER',
    })
  })

  it('un TIMED_OUT con resultado de la terminal pero sin código sigue UNRESOLVED: la ventana todavía no venció', () => {
    expect(
      desenlaceCanonico({ status: TerminalPaymentRequestStatus.TIMED_OUT, failureCode: null, resultJson: { status: 'timeout' } }).outcome,
    ).toBe('UNRESOLVED')
  })
```

- [ ] **Step 2: Verla fallar**

Run: `cd avoqado-server && npx jest tests/unit/services/terminal-payment.service.test.ts -t "NO_EVIDENCE_AFTER_WINDOW" --ci 2>&1 | tail -30`
Expected: FAIL — `outcome: 'UNRESOLVED'` en vez de `NOT_CHARGED` (el código no está en la lista blanca).

- [ ] **Step 3: Implementar (tipo + lista blanca)**

En `src/services/terminal-payment.service.ts`:

```ts
export type TerminalOutcomeEvidence =
  | 'PAYMENT_RECORDED'
  | 'PROCESSOR_DECLINED'
  | 'PRE_AUTHORIZATION'
  | 'CANCEL_ACCEPTED'
  | 'NEVER_DELIVERED'
  | 'REJECTED_AT_ADMISSION'
  | 'NOT_FOUND_CONTINUOUS_INBOX'
  | 'OPERATOR_RECONCILED'
  /** La ventana de confirmación venció sin webhook, sin historial y sin cajero: el SERVIDOR libera y vigila 30 min (plan 16-sep). */
  | 'NO_EVIDENCE_AFTER_WINDOW'
```

```ts
const CODIGOS_SIN_COBRO: Record<string, { evidencia: TerminalOutcomeEvidence; clase: TerminalEvidenceClass }> = {
  TPV_NEVER_RECEIVED: { evidencia: 'NEVER_DELIVERED', clase: 'SERVER' },
  TPV_INBOX_NOT_FOUND: { evidencia: 'NOT_FOUND_CONTINUOUS_INBOX', clase: 'TERMINAL' },
  OPERATOR_RECONCILED_NO_CHARGE: { evidencia: 'OPERATOR_RECONCILED', clase: 'OPERATOR' },
  // 🔴 Lo escribe SÓLO `releaseUnprovenNegative` (Task 2): una terminal que lo mande en su sobre se degrada igual que
  // cualquier negativo sin evidencia (`closeRow` sólo acredita PRE_AUTHORIZATION / PROCESSOR_DECLINED).
  NO_EVIDENCE_AFTER_WINDOW: { evidencia: 'NO_EVIDENCE_AFTER_WINDOW', clase: 'SERVER' },
}
```

- [ ] **Step 4: Verla pasar + la cartesiana**

Añadir `'NO_EVIDENCE_AFTER_WINDOW'` a la lista `CODIGOS` de `describe('el predicado de bloqueo y el desenlace canónico no pueden divergir'` en `tests/integration/payments/terminalPaymentRecovery.integration.test.ts`.

Run unitaria: `npx jest tests/unit/services/terminal-payment.service.test.ts -t "NO_EVIDENCE_AFTER_WINDOW" --ci 2>&1 | tail -8` → PASS.
Run integración (base desechable): `set -a; source ~/.claude/jobs/b1e1a1b3/tmp/db-desechable.env; set +a; npx jest --selectProjects integration tests/integration/payments/terminalPaymentRecovery.integration.test.ts -t "no pueden divergir" --ci 2>&1 | tail -12` → PASS (la tabla JS↔SQL incluye el código nuevo).

- [ ] **Step 5: Commit (por rutas)**

```bash
cd avoqado-server && git commit -q -F - -- src/services/terminal-payment.service.ts tests/unit/services/terminal-payment.service.test.ts tests/integration/payments/terminalPaymentRecovery.integration.test.ts <<'MSG'
feat(cobro remoto): evidencia NO_EVIDENCE_AFTER_WINDOW en la lista blanca — la clasifican igual la función y el SQL

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
git show --stat HEAD | head -12
```

---

### Task 2 (servidor): la ventana — un negativo sin evidencia se libera a los 30 s (temporizador + watchdog), y si aparece el pago exacto se concilia en vez de liberar

**Files:**
- Modify: `src/services/terminal-payment.service.ts` (`TerminalPaymentResult` ~L73; `closeRow` L2009–2100; nuevos métodos junto a `reconcileUnknownRequests` ~L2923)
- Modify: `src/jobs/terminal-payment-watchdog.job.ts` (`run()`)
- Modify: `src/services/tpv/angelpay-webhook.service.ts` (`ingresarEventoDelIntento`, fallback 55P03 ~L817–833: toca la solicitud vinculada)
- Test: `tests/integration/payments/terminalPaymentWindow.integration.test.ts` (nuevo)
- Test: `tests/integration/payments/webhookPrimerConfirmador.webhook.integration.test.ts` (la prueba del fallback ~L1660–1710 gana una afirmación)
- Test: `tests/integration/payments/terminalPaymentStrictFlag.integration.test.ts` (4 filas en la tabla JS↔SQL, inciso (h))

**Interfaces:**
- Consumes: `CODIGOS_SIN_COBRO.NO_EVIDENCE_AFTER_WINDOW` (Task 1), `findReconcilablePayment(row)`, `closeRowFromPaymentTx(tx, requestId, paymentId, venueId, undefined, 'REST')`, `pendingPayments`, `resultFromRow(row)`, `logAction`.
- Produces: `export const UNPROVEN_NEGATIVE_WINDOW_MS = 30_000`; `terminalPaymentService.releaseUnprovenNegative(requestId, venueId, origen: 'TIMER' | 'WATCHDOG', now?): Promise<'RELEASED' | 'RECONCILED' | 'HELD_BY_BANK_EVIDENCE' | 'NOT_ELIGIBLE'>`; `terminalPaymentService.releaseUnprovenNegativesAfterWindow(now?): Promise<{ released: number; reconciled: number; held: number }>`; `TerminalPaymentResult.terminalResult?` (sobre original conservado al degradar; también para el `timeout` que manda la TPV); `closeRow` escribe **`TIMED_OUT`** (no `UNKNOWN`) cuando `result.status === 'timeout'` y `result.terminalResult` existe; `failureCode = 'BANK_APPROVED_AWAITING_PAYMENT'` (TIMED_OUT, fuera de la lista blanca ⇒ UNRESOLVED); bitácoras `TERMINAL_PAYMENT_RELEASED_AFTER_WINDOW` y `TERMINAL_PAYMENT_WINDOW_HELD_BY_BANK_EVIDENCE`.

- [ ] **Step 1: Pruebas de integración en rojo** — crear `tests/integration/payments/terminalPaymentWindow.integration.test.ts` calcando el arnés de `terminalPaymentRecovery.integration.test.ts` (mismos mocks de `socketManager`/`terminalRegistry`, mismo `beforeAll` que exige base desechable, mismos `auditRequest`/`auditPayment`/`terminalDelFixture`; copiar esas funciones tal cual, con `fixture = 'ventana-' + randomUUID().slice(0, 8)`):

```ts
import { Prisma } from '@prisma/client'
import { UNPROVEN_NEGATIVE_WINDOW_MS, terminalPaymentService } from '@/services/terminal-payment.service'
import { candadoDeIntento } from '@/services/tpv/candadoDeIntento'
import { randomUUID } from 'crypto'

// A nivel de archivo: lo usan los describes de la Task 2, la Task 3 y la Task 4.
const negativoSinEvidencia = () => ({
  status: 'TIMED_OUT',
  failureCode: null,
  resultJson: {
    requestId: 'x', status: 'timeout', errorMessage: 'El resultado del cobro sigue pendiente de confirmar',
    terminalResult: { status: 'failed', errorMessage: 'User cancelled\n\nSDK U100: Operacion cancelada por el usuario', outcomeEvidence: null },
  },
})

describe('Ventana de confirmación: un negativo sin evidencia dura 30 s y se libera solo', () => {

  it('antes de los 30 s NO se libera: la orden y la ranura siguen bloqueadas', async () => {
    const row = await auditRequest({ ...negativoSinEvidencia(), updatedAt: new Date(Date.now() - 5_000) })
    expect(await terminalPaymentService.releaseUnprovenNegative(row.requestId, venueId, 'WATCHDOG')).toBe('NOT_ELIGIBLE')
    const fresca = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
    expect(fresca.status).toBe('TIMED_OUT')
    expect(await terminalPaymentService.hasChargeBlockingOrderCancel(venueId, orderId)).toBe(true)
  })

  it('a los 30 s se libera: FAILED/NO_EVIDENCE_AFTER_WINDOW, orden y ranura libres, bitácora escrita', async () => {
    const row = await auditRequest({ ...negativoSinEvidencia(), updatedAt: new Date(Date.now() - UNPROVEN_NEGATIVE_WINDOW_MS - 1_000) })
    expect(await terminalPaymentService.releaseUnprovenNegative(row.requestId, venueId, 'WATCHDOG')).toBe('RELEASED')
    const liberada = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
    expect(liberada).toMatchObject({ status: 'FAILED', failureCode: 'NO_EVIDENCE_AFTER_WINDOW', paymentId: null })
    expect((liberada.resultJson as any).releasedAfterWindow).toMatchObject({ windowMs: UNPROVEN_NEGATIVE_WINDOW_MS, origen: 'WATCHDOG' })
    expect((liberada.resultJson as any).terminalResult.errorMessage).toContain('SDK U100') // el sobre original no se pierde
    expect(await terminalPaymentService.hasChargeBlockingOrderCancel(venueId, orderId)).toBe(false)
    expect(await terminalPaymentService.isTerminalBusy(fixture, venueId)).toBe(false)
    const estado = await terminalPaymentService.getPaymentStatus(row.requestId, venueId)
    expect(estado).toMatchObject({ status: 'FAILED', outcome: 'NOT_CHARGED', outcomeEvidence: 'NO_EVIDENCE_AFTER_WINDOW', evidenceClass: 'SERVER' })
    const bitacora = await prisma.activityLog.findFirst({ where: { venueId, action: 'TERMINAL_PAYMENT_RELEASED_AFTER_WINDOW', entityId: row.id } })
    expect(bitacora).not.toBeNull()
  })

  it('si el pago EXACTO ya existe al vencer la ventana, se concilia a COMPLETED en vez de liberar', async () => {
    const row = await auditRequest({ ...negativoSinEvidencia(), updatedAt: new Date(Date.now() - UNPROVEN_NEGATIVE_WINDOW_MS - 1_000) })
    await auditPayment({ processorData: { terminalPaymentRequestId: row.requestId, deviceSerialNumber: fixture } })
    expect(await terminalPaymentService.releaseUnprovenNegative(row.requestId, venueId, 'WATCHDOG')).toBe('RECONCILED')
    const cerrada = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
    expect(cerrada.status).toBe('COMPLETED')
    expect(cerrada.paymentId).not.toBeNull()
    expect(cerrada.lateResult).toBe(true)
  })

  it('UNKNOWN (la terminal nunca contestó) y TIMED_OUT/AUTO_RELEASED NO entran en la ventana', async () => {
    const vencida = new Date(Date.now() - UNPROVEN_NEGATIVE_WINDOW_MS - 1_000)
    const unknown = await auditRequest({ status: 'UNKNOWN', updatedAt: vencida })
    const soltada = await auditRequest({ status: 'TIMED_OUT', failureCode: 'AUTO_RELEASED', updatedAt: vencida, terminalId: `${fixture}-b` })
    const resumen = await terminalPaymentService.releaseUnprovenNegativesAfterWindow(new Date())
    expect(resumen).toEqual({ released: 0, reconciled: 0, held: 0 })
    expect((await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: unknown.id } })).status).toBe('UNKNOWN')
    expect((await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: soltada.id } })).failureCode).toBe('AUTO_RELEASED')
  })

  it('el barrido libera sólo las vencidas y es idempotente', async () => {
    const vencida = new Date(Date.now() - UNPROVEN_NEGATIVE_WINDOW_MS - 1_000)
    await auditRequest({ ...negativoSinEvidencia(), updatedAt: vencida })
    await auditRequest({ ...negativoSinEvidencia(), updatedAt: new Date(), terminalId: `${fixture}-c` })
    expect(await terminalPaymentService.releaseUnprovenNegativesAfterWindow(new Date())).toEqual({ released: 1, reconciled: 0, held: 0 })
    expect(await terminalPaymentService.releaseUnprovenNegativesAfterWindow(new Date())).toEqual({ released: 0, reconciled: 0, held: 0 })
  })

  it('un `timeout` que manda la propia TPV también entra en la ventana (TIMED_OUT con terminalResult.status = timeout)', async () => {
    const row = await auditRequest({ status: 'SENT' })
    await terminalPaymentService.handlePaymentResultFromSocket(
      { requestId: row.requestId, status: 'timeout', errorMessage: 'La terminal no pudo confirmar el resultado del cobro. Confirmando con el banco.' },
      { socketId: 'fixture-socket', terminalId: fixture, venueId },
    )
    const fila = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
    expect(fila).toMatchObject({ status: 'TIMED_OUT', failureCode: null })
    expect((fila.resultJson as any).terminalResult).toMatchObject({ status: 'timeout' })
    await conUpdatedAt(fila, new Date(Date.now() - UNPROVEN_NEGATIVE_WINDOW_MS - 1_000))
    expect(await terminalPaymentService.releaseUnprovenNegative(row.requestId, venueId, 'WATCHDOG')).toBe('RELEASED')
  })

  it('un `success` cuyo Payment no se puede acreditar se degrada a UNKNOWN (hubo una afirmación positiva) y NUNCA entra en la ventana', async () => {
    const row = await auditRequest({ status: 'SENT' })
    await terminalPaymentService.handlePaymentResultFromSocket(
      { requestId: row.requestId, status: 'success', paymentId: 'pay-inexistente', authorizationCode: 'A1' } as any,
      { socketId: 'fixture-socket', terminalId: fixture, venueId },
    )
    const fila = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
    expect(fila.status).toBe('UNKNOWN')
    await conUpdatedAt(fila, new Date(Date.now() - UNPROVEN_NEGATIVE_WINDOW_MS - 1_000))
    expect(await terminalPaymentService.releaseUnprovenNegative(row.requestId, venueId, 'WATCHDOG')).toBe('NOT_ELIGIBLE')
  })

  it('un `success` cuya verificación REVIENTA sobre una fila TIMED_OUT elegible la deja UNKNOWN (fuera de la ventana): nunca se libera lo que alguien afirmó cobrar', async () => {
    const row = await auditRequest({ ...negativoSinEvidencia(), updatedAt: new Date(Date.now() - UNPROVEN_NEGATIVE_WINDOW_MS - 1_000) })
    const spy = jest.spyOn(prisma, '$transaction').mockRejectedValueOnce(new Error('db caída'))
    try {
      await terminalPaymentService.handlePaymentResultFromSocket(
        { requestId: row.requestId, status: 'success', paymentId: 'pay-x' } as any,
        { socketId: 'fixture-socket', terminalId: fixture, venueId },
      )
    } finally {
      spy.mockRestore()
    }
    const fila = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
    expect(fila.status).toBe('UNKNOWN')
    expect((fila.resultJson as any).terminalResult).toBeUndefined()
    expect(await terminalPaymentService.releaseUnprovenNegative(row.requestId, venueId, 'WATCHDOG')).toBe('NOT_ELIGIBLE')
  })

  it('con un webhook APROBADO del intento ya guardado (sin Payment) la ventana NO libera: marca BANK_APPROVED_AWAITING_PAYMENT y sigue bloqueando', async () => {
    const row = await auditRequest({ ...negativoSinEvidencia(), updatedAt: new Date(Date.now() - UNPROVEN_NEGATIVE_WINDOW_MS - 1_000) })
    const attemptId = `att-${randomUUID()}`
    await prisma.terminalPaymentAttemptLink.create({ data: { attemptId, requestId: row.requestId, venueId, terminalId: fixture } })
    await prisma.providerEventLog.create({
      data: {
        provider: 'PAYMENT_PROCESSOR', venueId, attemptId, type: 'send_transaction', status: 'PENDING',
        payload: { event: 'send_transaction', payload: { status: 'approved', amount: '10000', integratorReference: attemptId, transactionId: 'tx-1' } },
      },
    })
    expect(await terminalPaymentService.releaseUnprovenNegative(row.requestId, venueId, 'WATCHDOG')).toBe('HELD_BY_BANK_EVIDENCE')
    const fila = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
    expect(fila).toMatchObject({ status: 'TIMED_OUT', failureCode: 'BANK_APPROVED_AWAITING_PAYMENT', paymentId: null })
    expect(await terminalPaymentService.hasChargeBlockingOrderCancel(venueId, orderId)).toBe(true)
    expect(await terminalPaymentService.isTerminalBusy(fixture, venueId)).toBe(true)
    // Segunda pasada: ya no es elegible (failureCode puesto) y no vuelve a escribir bitácora.
    expect(await terminalPaymentService.releaseUnprovenNegative(row.requestId, venueId, 'WATCHDOG')).toBe('NOT_ELIGIBLE')
    expect(await prisma.activityLog.count({ where: { venueId, action: 'TERMINAL_PAYMENT_WINDOW_HELD_BY_BANK_EVIDENCE', entityId: row.id } })).toBe(1)
  })

  it('la decisión de la ventana espera al candado del intento: un webhook APROBADO que se persiste mientras la ventana decide la RETIENE (no la libera)', async () => {
    const row = await auditRequest({ ...negativoSinEvidencia(), updatedAt: new Date(Date.now() - UNPROVEN_NEGATIVE_WINDOW_MS - 1_000) })
    const attemptId = `att-${randomUUID()}`
    await prisma.terminalPaymentAttemptLink.create({ data: { attemptId, requestId: row.requestId, venueId, terminalId: fixture } })
    const esperar = async (cond: () => Promise<boolean>, ms = 5000) => {
      const hasta = Date.now() + ms
      while (Date.now() < hasta) { if (await cond()) return true; await new Promise(r => setTimeout(r, 40)) }
      return cond()
    }
    const esperandoCandado = async () =>
      ((await prisma.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory' AND query ILIKE '%hashtext%'`,
      ))[0].n)
    const base = await esperandoCandado()
    let soltar!: () => void
    const puerta = new Promise<void>(r => { soltar = r })
    let candadoTomado!: () => void
    const tomado = new Promise<void>(r => { candadoTomado = r })
    // El «ingreso del webhook»: toma el candado del intento, persiste el APROBADO (todavía invisible: sin commit) y se queda
    // dentro hasta que la prueba lo suelta.
    const ingreso = prisma.$transaction(async tx => {
      await candadoDeIntento(tx, attemptId)
      await tx.providerEventLog.create({
        data: {
          provider: 'PAYMENT_PROCESSOR', venueId, attemptId, type: 'send_transaction', status: 'PENDING',
          payload: { event: 'send_transaction', payload: { status: 'approved', amount: '10000', integratorReference: attemptId, transactionId: 'tx-race' } },
        },
      })
      candadoTomado()
      await puerta
    }, { timeout: 20_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted })
    await tomado
    const liberacion = terminalPaymentService.releaseUnprovenNegative(row.requestId, venueId, 'WATCHDOG')
    expect(await esperar(async () => (await esperandoCandado()) > base)).toBe(true) // la ventana ESPERA el candado, no decide a ciegas
    soltar()
    await ingreso
    expect(await liberacion).toBe('HELD_BY_BANK_EVIDENCE')
    const fila = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
    expect(fila).toMatchObject({ status: 'TIMED_OUT', failureCode: 'BANK_APPROVED_AWAITING_PAYMENT' })
  })

  it('el CAS de liberación exige el updatedAt leído: un resultado que renovó el reloj entre la lectura y la escritura anula la liberación', async () => {
    const row = await auditRequest({ ...negativoSinEvidencia(), updatedAt: new Date(Date.now() - UNPROVEN_NEGATIVE_WINDOW_MS - 1_000) })
    // Se simula la carrera renovando updatedAt justo antes de liberar: el where con el updatedAt leído no coincide.
    const spy = jest.spyOn(prisma.terminalPaymentRequest, 'updateMany')
    spy.mockImplementationOnce(async (args: any) => {
      await prisma.$executeRaw`UPDATE "TerminalPaymentRequest" SET "updatedAt" = NOW() WHERE id = ${row.id}`
      spy.mockRestore()
      return prisma.terminalPaymentRequest.updateMany(args)
    })
    expect(await terminalPaymentService.releaseUnprovenNegative(row.requestId, venueId, 'WATCHDOG')).toBe('NOT_ELIGIBLE')
    expect((await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('TIMED_OUT')
  })

  it('closeRow conserva el sobre original al degradar un failed sin evidencia, escribe TIMED_OUT y programa la ventana', async () => {
    // Sin fake timers aquí: Prisma/pg usan temporizadores internos. El temporizador en sí se prueba en la unitaria de abajo.
    const row = await auditRequest({ status: 'SENT' })
    await terminalPaymentService.handlePaymentResultFromSocket(
      { requestId: row.requestId, status: 'failed', errorMessage: 'User cancelled\n\nSDK U100: Operacion cancelada por el usuario' },
      { socketId: 'fixture-socket', terminalId: fixture, venueId },
    )
    const degradada = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
    expect(degradada).toMatchObject({ status: 'TIMED_OUT', failureCode: null, paymentId: null })
    expect((degradada.resultJson as any).status).toBe('timeout')
    expect((degradada.resultJson as any).terminalResult).toMatchObject({ status: 'failed' })
    expect((degradada.resultJson as any).terminalResult.errorMessage).toContain('SDK U100')
    const programadas = (terminalPaymentService as any).ventanasProgramadas as Map<string, NodeJS.Timeout>
    expect(programadas.has(row.requestId)).toBe(true)
    clearTimeout(programadas.get(row.requestId)!)
    programadas.delete(row.requestId)
  })
})
```

Y una unitaria (en `tests/unit/services/terminal-payment.service.test.ts`, con fake timers y SIN base) para el temporizador:

```ts
describe('programarLiberacionPorVentana', () => {
  it('a los 30 s llama a releaseUnprovenNegative con origen TIMER, una sola vez por solicitud, y no retiene el proceso', () => {
    jest.useFakeTimers()
    try {
      const spy = jest.spyOn(terminalPaymentService, 'releaseUnprovenNegative').mockResolvedValue('NOT_ELIGIBLE')
      const svc = terminalPaymentService as any
      svc.programarLiberacionPorVentana('req-t', 'venue-t')
      svc.programarLiberacionPorVentana('req-t', 'venue-t') // idempotente: un solo temporizador
      jest.advanceTimersByTime(UNPROVEN_NEGATIVE_WINDOW_MS - 1)
      expect(spy).not.toHaveBeenCalled()
      jest.advanceTimersByTime(2)
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy).toHaveBeenCalledWith('req-t', 'venue-t', 'TIMER')
      expect((svc.ventanasProgramadas as Map<string, unknown>).has('req-t')).toBe(false)
      spy.mockRestore()
    } finally {
      jest.useRealTimers()
    }
  })
})
```

Nota para `auditRequest`: Prisma no deja fijar `updatedAt` en `create` con `@updatedAt`; tras crear, ajustarlo con `prisma.$executeRaw\`UPDATE "TerminalPaymentRequest" SET "updatedAt" = ${fecha} WHERE id = ${row.id}\`` — añadir al helper del archivo nuevo un `conUpdatedAt(row, fecha)` que haga eso y devuelva la fila releída, y que `auditRequest` lo aplique cuando `overrides.updatedAt` venga. Copiar también `enviar`, `nuevaOrden`, `terminalDe` y `filasDe` de `terminalPaymentRecovery.integration.test.ts` (los usa la Task 3). 🔴 Pruebas EXISTENTES que fijan la semántica vieja «negativo sin evidencia ⇒ UNKNOWN» (en `terminalPaymentRecovery`, `terminalPaymentStrictFlag` y unitarias de `closeRow`) pasan a `TIMED_OUT` + `failureCode: null` + `resultJson.terminalResult` — se APRIETAN (afirmar también `terminalResult.status`), nunca se aflojan; el cambio es deliberado y está autorizado por Codex (Task 0, P1).

- [ ] **Step 2: Verlas fallar**

Run: `set -a; source ~/.claude/jobs/b1e1a1b3/tmp/db-desechable.env; set +a; cd avoqado-server && npx jest --selectProjects integration tests/integration/payments/terminalPaymentWindow.integration.test.ts --ci 2>&1 | tail -40`
Expected: FAIL — `releaseUnprovenNegative is not a function` / `UNPROVEN_NEGATIVE_WINDOW_MS` undefined.

- [ ] **Step 3: Implementar**

(a) Ampliar `TerminalPaymentResult` (junto a `outcomeEvidence`):

```ts
  /**
   * Lo que la TERMINAL contestó antes de que el servidor degradara el resultado a `timeout` por venir sin evidencia.
   * Se conserva sólo para diagnóstico y bitácora (qué código del SDK fue); NUNCA acredita nada.
   */
  terminalResult?: { status: 'failed' | 'cancelled' | 'timeout'; errorMessage: string | null; outcomeEvidence: string | null }
```

(b) En `closeRow`, sustituir la degradación (L2011–2015) por:

```ts
      // La TERMINAL contestó sin veredicto del procesador: un failed/cancelled sin evidencia acreditada, o su propio
      // `timeout` («no pude verificar»). Se conserva su sobre en `terminalResult` (diagnóstico) y la fila entra en la
      // VENTANA DE CONFIRMACIÓN (TIMED_OUT). Un `success` que no acredite Payment se degrada más abajo SIN terminalResult y
      // queda UNKNOWN: hubo una afirmación positiva y la ventana no lo toca (Codex, Task 0, P1).
      if (
        (result.status === 'failed' || result.status === 'cancelled') &&
        !(result.outcomeEvidence === 'PRE_AUTHORIZATION' || (result.status === 'failed' && result.outcomeEvidence === 'PROCESSOR_DECLINED'))
      ) {
        result = {
          requestId,
          status: 'timeout',
          errorMessage: 'El resultado del cobro sigue pendiente de confirmar',
          terminalResult: { status: result.status, errorMessage: result.errorMessage ?? null, outcomeEvidence: result.outcomeEvidence ?? null },
        }
      } else if (result.status === 'timeout' && !result.terminalResult) {
        result = { ...result, terminalResult: { status: 'timeout', errorMessage: result.errorMessage ?? null, outcomeEvidence: null } }
      }
```

y la línea `const newStatus = resultToStatus(result.status)` (L2059) pasa a:

```ts
    // TIMED_OUT = «la terminal contestó y no hay veredicto» (entra en la ventana); UNKNOWN = «nadie afirmó nada útil»
    // (success sin Payment acreditable, error verificando evidencia, plazo del watchdog). `resultToStatus` no cambia.
    const newStatus =
      result.status === 'timeout' && result.terminalResult ? TerminalPaymentRequestStatus.TIMED_OUT : resultToStatus(result.status)
```

(`terminalResult.status` admite `'failed' | 'cancelled' | 'timeout'`: ampliar el tipo de (a).)

Y el `catch` de la verificación del `success` (L2050–2057) deja de RETORNAR sin escribir: hoy devuelve `timeout` y no toca la fila, así que una fila que ya era `TIMED_OUT` elegible conservaría el negativo anterior aunque la terminal acabe de AFIRMAR un cobro (Codex, Task 0 R2, P1). Pasa a caer al cierre común como `UNKNOWN` sin `terminalResult`:

```ts
    } catch (err) {
      logger.error('[TerminalPayment] Cannot verify socket payment evidence', {
        requestId,
        venueId,
        error: err instanceof Error ? err.message : String(err),
      })
      // Hubo una AFIRMACIÓN positiva que no se pudo verificar: la fila pasa a UNKNOWN (sin terminalResult ⇒ fuera de la
      // ventana) aunque antes fuera un negativo elegible. Nunca se libera una fila sobre la que alguien dijo «cobré».
      result = { requestId, status: 'timeout', errorMessage: 'El resultado sigue pendiente de confirmar' }
    }
```

(el `newStatus` de abajo lo mapea a `UNKNOWN`; el camino `late` con `SIN_DESENLACE_ACREDITADO` alcanza la fila `TIMED_OUT` previa y la deja `UNKNOWN` + `lateResult`).

En los dos retornos exitosos de la escritura (`if (inFlight.count > 0) return result` y `if (late.count > 0) { … return result }`) anteponer:

```ts
      if (newStatus === TerminalPaymentRequestStatus.TIMED_OUT) this.programarLiberacionPorVentana(requestId, venueId)
```

(c) Constante exportada (junto a `UNKNOWN_AUTO_RELEASE_GRACE_MS`):

```ts
/**
 * Ventana de confirmación (plan 16-sep): un negativo de la terminal SIN evidencia del procesador (U100/U101/«Cancelled»/G505…)
 * se retiene este tiempo esperando al webhook (p99 3.5 s, máx 7 s medidos en 927 aprobaciones) y luego se libera con
 * evidencia `NO_EVIDENCE_AFTER_WINDOW`. Una aprobación posterior reabre la fila por `closeRowFromPaymentTx` y grita 🚨.
 * NO aplica a UNKNOWN (la terminal nunca contestó: su SDK puede seguir vivo) ni a AUTO_RELEASED (regla del 12-sep).
 */
export const UNPROVEN_NEGATIVE_WINDOW_MS = 30_000
```

(d) Métodos nuevos en la clase (junto a `reconcileUnknownRequests`):

```ts
  private ventanasProgramadas = new Map<string, NodeJS.Timeout>()

  /** El temporizador en proceso es la RAPIDEZ; el watchdog (cada 30 s) es la DURABILIDAD tras un reinicio. */
  private programarLiberacionPorVentana(requestId: string, venueId: string): void {
    if (this.ventanasProgramadas.has(requestId)) return
    const t = setTimeout(() => {
      this.ventanasProgramadas.delete(requestId)
      void this.releaseUnprovenNegative(requestId, venueId, 'TIMER').catch(err =>
        logger.error('[TerminalPayment] window release failed', { requestId, error: err instanceof Error ? err.message : String(err) }),
      )
    }, UNPROVEN_NEGATIVE_WINDOW_MS)
    t.unref?.()
    this.ventanasProgramadas.set(requestId, t)
  }

  /** ¿Es un negativo de la terminal sin evidencia, todavía sin liberar? (EXACTAMENTE la forma que escribe `closeRow`). */
  private esNegativoSinEvidencia(row: { status: TerminalPaymentRequestStatus; failureCode: string | null; paymentId: string | null; resultJson: Prisma.JsonValue | null }): boolean {
    if (row.status !== TerminalPaymentRequestStatus.TIMED_OUT || row.failureCode !== null || row.paymentId) return false
    const sobre = row.resultJson && typeof row.resultJson === 'object' && !Array.isArray(row.resultJson) ? (row.resultJson as Record<string, unknown>) : null
    return sobre?.status === 'timeout' && !!sobre.terminalResult && typeof sobre.terminalResult === 'object'
  }

  /**
   * Veto de la ventana (Codex, Task 0, P3): un webhook APROBADO de cualquier intento vinculado a la solicitud —aunque el
   * registrador no haya creado el Payment (falló, importe distinto, PENDING)— ya es EVIDENCIA de cobro, no ausencia de señal.
   * Misma clasificación bancaria que el receptor (`estadoBancarioSql`, R14-3). Se consulta con el cliente de la transacción
   * que YA tiene el candado de esos intentos (R2, P3): la consulta y la decisión son una sola fotografía frente al ingreso.
   */
  private async aprobacionBancariaConocida(
    db: Pick<Prisma.TransactionClient, '$queryRaw'>,
    venueId: string,
    attemptIds: string[],
  ): Promise<{ eventLogId: string } | null> {
    if (attemptIds.length === 0) return null
    const [fila] = await db.$queryRaw<{ id: string }[]>`
      SELECT e."id" FROM "ProviderEventLog" e
      WHERE e."provider" = 'PAYMENT_PROCESSOR' AND e."venueId" = ${venueId} AND e."type" = 'send_transaction'
        AND e."attemptId" IN (${Prisma.join(attemptIds)})
        AND ${estadoBancarioSql(Prisma.sql`e."payload"->'payload'->'status'`)} = 'APROBADO'
      ORDER BY e."createdAt" ASC, e."id" ASC
      LIMIT 1`
    return fila ? { eventLogId: fila.id } : null
  }

  async releaseUnprovenNegative(
    requestId: string,
    venueId: string,
    origen: 'TIMER' | 'WATCHDOG',
    now: Date = new Date(),
  ): Promise<'RELEASED' | 'RECONCILED' | 'HELD_BY_BANK_EVIDENCE' | 'NOT_ELIGIBLE'> {
    const row = await prisma.terminalPaymentRequest.findFirst({ where: { requestId, venueId } })
    if (!row || !this.esNegativoSinEvidencia(row)) return 'NOT_ELIGIBLE'
    if (row.updatedAt.getTime() > now.getTime() - UNPROVEN_NEGATIVE_WINDOW_MS) return 'NOT_ELIGIBLE'
    // El CAS de abajo exige el updatedAt LEÍDO: un resultado que renueve el reloj entre la lectura y la escritura anula la liberación.
    const cas = { id: row.id, status: TerminalPaymentRequestStatus.TIMED_OUT, failureCode: null, paymentId: null, updatedAt: row.updatedAt } as const

    // 1) El pago EXACTO de esta solicitud (misma regla que el barrido): si existe, se concilia — nunca se libera un cobro hecho.
    const payment = await this.findReconcilablePayment(row)
    if (payment) {
      const cierre = await prisma.$transaction(tx => this.closeRowFromPaymentTx(tx, requestId, payment.id, venueId, undefined, 'REST'))
      if (cierre.bound) {
        logger.warn('🕰️ [TerminalPayment] window found the exact payment — reconciled instead of released', { requestId, venueId, paymentId: payment.id })
        avisarAprobacionTardiaTrasVentana(cierre, { requestId, venueId, paymentId: payment.id, terminalId: row.terminalId, orderId: row.orderId })
        return 'RECONCILED'
      }
    }

    // 2+3) Bajo el candado de CADA intento vinculado (el ingreso del webhook toma el mismo, angelpay-webhook.service.ts:804):
    // la consulta del veto, el CAS y el asiento son UNA fotografía. Un APROBADO que se persista después espera a que
    // decidamos; uno que se persistió antes lo vemos (Codex, Task 0 R2, P3: insertar el evento no toca el updatedAt de la
    // solicitud, así que el CAS solo NO bastaba). Sin vínculos (APK legacy) no hay webhook que pueda adelantarse.
    const attemptIds = (await prisma.terminalPaymentAttemptLink.findMany({ where: { requestId, venueId }, select: { attemptId: true } }))
      .map(l => l.attemptId)
      .sort()
    const previo = row.resultJson && typeof row.resultJson === 'object' && !Array.isArray(row.resultJson) ? (row.resultJson as Prisma.JsonObject) : {}
    let decision: 'RELEASED' | 'HELD_BY_BANK_EVIDENCE' | 'NOT_ELIGIBLE'
    try {
      decision = await prisma.$transaction(async tx => {
        for (const attemptId of attemptIds) await candadoDeIntento(tx, attemptId)
        const aprobacion = await this.aprobacionBancariaConocida(tx, venueId, attemptIds)
        if (aprobacion) {
          // Evidencia bancaria conocida sin Payment: se RETIENE (sigue UNRESOLVED) y se marca UNA vez para no repetir el asiento.
          const held = await tx.terminalPaymentRequest.updateMany({ where: cas, data: { failureCode: 'BANK_APPROVED_AWAITING_PAYMENT' } })
          if (held.count === 0) return 'NOT_ELIGIBLE'
          await tx.activityLog.create({
            data: {
              action: 'TERMINAL_PAYMENT_WINDOW_HELD_BY_BANK_EVIDENCE', entity: 'TerminalPaymentRequest', entityId: row.id, venueId,
              data: { requestId, terminalId: row.terminalId, orderId: row.orderId, amountCents: row.amountCents, eventLogId: aprobacion.eventLogId, origen },
            },
          })
          logger.error('🚨 [TerminalPayment] Approved bank event without a Payment — the window will NOT release this request', {
            requestId, venueId, terminalId: row.terminalId, orderId: row.orderId, eventLogId: aprobacion.eventLogId, origen,
          })
          return 'HELD_BY_BANK_EVIDENCE'
        }
        // CAS: sólo si sigue siendo exactamente el negativo sin evidencia (un cajero pudo adelantarse).
        const r = await tx.terminalPaymentRequest.updateMany({
          where: cas,
          data: {
            status: TerminalPaymentRequestStatus.FAILED,
            failureCode: 'NO_EVIDENCE_AFTER_WINDOW',
            resultJson: {
              ...previo,
              requestId,
              status: 'failed',
              outcomeEvidence: 'NO_EVIDENCE_AFTER_WINDOW',
              errorMessage: 'No se confirmó el cobro en la ventana de 30 s. Se puede volver a cobrar.',
              releasedAfterWindow: { windowMs: UNPROVEN_NEGATIVE_WINDOW_MS, releasedAt: now.toISOString(), origen },
            } as Prisma.InputJsonObject,
          },
        })
        if (r.count === 0) return 'NOT_ELIGIBLE'
        await tx.activityLog.create({
          data: {
            action: 'TERMINAL_PAYMENT_RELEASED_AFTER_WINDOW', entity: 'TerminalPaymentRequest', entityId: row.id, venueId,
            data: {
              requestId, terminalId: row.terminalId, orderId: row.orderId, amountCents: row.amountCents, tipCents: row.tipCents,
              windowMs: UNPROVEN_NEGATIVE_WINDOW_MS, origen, terminalResult: (previo as Record<string, unknown>).terminalResult ?? null,
            },
          },
        })
        return 'RELEASED'
      }, OPCIONES_DE_TRANSACCION_DEL_INTENTO)
    } catch (err) {
      // 55P03 (lock_timeout): el ingreso del webhook tiene el candado de este intento — esta pasada no decide; la siguiente
      // (temporizador o watchdog a los 30 s) vuelve a intentar y verá el evento ya persistido.
      logger.warn('⏱️ [TerminalPayment] window release deferred — attempt lock busy or db error', { requestId, venueId, error: err instanceof Error ? err.message : String(err) })
      return 'NOT_ELIGIBLE'
    }
    if (decision !== 'RELEASED') return decision

    logger.warn('⏱️ [TerminalPayment] Unproven negative released after the confirmation window', {
      requestId, venueId, terminalId: row.terminalId, orderId: row.orderId, amountCents: row.amountCents, origen,
      terminalResult: (previo as Record<string, unknown>).terminalResult ?? null,
    })
    // Un POS que todavía espere en memoria recibe el desenlace ahora, no cuando venza su propio plazo.
    const pending = this.pendingPayments.get(requestId)
    if (pending) {
      clearTimeout(pending.timeout)
      this.pendingPayments.delete(requestId)
      const fresca = await prisma.terminalPaymentRequest.findFirst({ where: { requestId, venueId } })
      if (fresca) pending.resolve(resultFromRow(fresca))
    }
    return 'RELEASED'
  }

  /** Respaldo durable del temporizador (reinicios, instancia distinta). Cada pasada del watchdog. */
  async releaseUnprovenNegativesAfterWindow(now: Date = new Date()): Promise<{ released: number; reconciled: number; held: number }> {
    const cutoff = new Date(now.getTime() - UNPROVEN_NEGATIVE_WINDOW_MS)
    // SQL crudo a propósito: «existe `resultJson.terminalResult`» no se expresa con los filtros JSON de Prisma.
    const filas = await retry(
      () =>
        prisma.$queryRaw<{ requestId: string; venueId: string }[]>`
          SELECT "requestId", "venueId" FROM "TerminalPaymentRequest"
          WHERE "status" = 'TIMED_OUT' AND "failureCode" IS NULL AND "paymentId" IS NULL
            AND "resultJson"->>'status' = 'timeout' AND jsonb_typeof("resultJson"->'terminalResult') = 'object'
            AND "updatedAt" <= ${cutoff}
          ORDER BY "updatedAt" ASC
          LIMIT 200`,
      { retries: 3, shouldRetry: shouldRetryDbConnectionError, context: 'terminal-payment-watchdog:findUnprovenNegatives' },
    )
    let released = 0
    let reconciled = 0
    let held = 0
    for (const f of filas) {
      const r = await this.releaseUnprovenNegative(f.requestId, f.venueId, 'WATCHDOG', now)
      if (r === 'RELEASED') released += 1
      if (r === 'RECONCILED') reconciled += 1
      if (r === 'HELD_BY_BANK_EVIDENCE') held += 1
    }
    if (released + reconciled + held > 0) logger.info('⏱️ [Terminal-payment watchdog] confirmation window sweep', { released, reconciled, held })
    return { released, reconciled, held }
  }
```

(h) La RANURA en el régimen RELAJADO (Codex, Task 0 R2, P1): `BLOQUEO_HEREDADO` (L421) sólo retiene `SLOT_HELD` (PENDING/SENT/CANCEL_REQUESTED/UNKNOWN), así que una fila de la ventana (`TIMED_OUT`, código nulo) soltaría la ranura AL INSTANTE en los venues con el interruptor apagado, antes de que la ventana decida. Se retiene en los DOS regímenes mientras la ventana decide, sin tocar la excepción de `AUTO_RELEASED`:

```ts
/**
 * Filas de la VENTANA DE CONFIRMACIÓN (plan 16-sep): la terminal contestó sin veredicto, o el banco aprobó y el Payment aún no
 * existe. Retienen la ranura en los DOS regímenes hasta que la ventana decide (≤ 30 s) o hasta que S4 crea el Payment. Se
 * exige `terminalResult` para NO alcanzar filas TIMED_OUT históricas sin sobre (anteriores a este cambio).
 */
const VENTANA_RETIENE_LA_RANURA: Prisma.TerminalPaymentRequestWhereInput = {
  status: TerminalPaymentRequestStatus.TIMED_OUT,
  paymentId: null,
  OR: [
    { failureCode: 'BANK_APPROVED_AWAITING_PAYMENT' },
    { failureCode: null, resultJson: { path: ['terminalResult', 'status'], string_contains: '' } },
  ],
}
const BLOQUEO_HEREDADO: Prisma.TerminalPaymentRequestWhereInput = { OR: [{ status: { in: SLOT_HELD } }, VENTANA_RETIENE_LA_RANURA] }
```

y el espejo (`bloqueaLaRanura`, L512): tras `if (SLOT_HELD.includes(row.status)) return true` añadir `if (ventanaRetieneLaRanura(row)) return true` con

```ts
export function ventanaRetieneLaRanura(row: FilaDeDesenlace): boolean {
  if (row.status !== TerminalPaymentRequestStatus.TIMED_OUT || row.paymentId) return false
  if (row.failureCode === 'BANK_APPROVED_AWAITING_PAYMENT') return true
  if (row.failureCode !== null) return false
  const sobre = row.resultJson && typeof row.resultJson === 'object' && !Array.isArray(row.resultJson) ? (row.resultJson as Record<string, unknown>) : null
  const tr = sobre?.terminalResult
  return !!tr && typeof tr === 'object' && typeof (tr as Record<string, unknown>).status === 'string'
}
```

🔴 La prueba de tabla JS↔SQL de `terminalPaymentStrictFlag.integration.test.ts` (~L181–189, `predicadoDeBloqueo` contra `bloqueaLaRanura` sobre filas sembradas) gana CUATRO filas en los DOS regímenes: `TIMED_OUT/null` con `terminalResult` (retiene), `TIMED_OUT/null` SIN `terminalResult` (histórica: NO retiene en relajado), `TIMED_OUT/BANK_APPROVED_AWAITING_PAYMENT` (retiene) y `TIMED_OUT/AUTO_RELEASED` (no retiene). `SOLO_BLOQUEA_EN_ESTRICTO` (vista previa del interruptor) NO se toca: cuenta de más las filas de ventana durante ≤ 30 s — cosmético, declarado.

(i) Retención ACOTADA (mismo plazo que el destrabe de la ranura del 12-sep): una fila `TIMED_OUT/BANK_APPROVED_AWAITING_PAYMENT` cuyo Payment S4 no logra crear (importe distinto, registrador caído) suelta LA RANURA a los 20 min como `AUTO_RELEASED` — la VENTA sigue bloqueada (TIMED_OUT es UNRESOLVED) y el barrido de 30 min de `RELEASE_FAILURE_CODES` ya la concilia si el Payment aparece. En `releaseUnprovenNegativesAfterWindow`, tras el bucle:

```ts
    const retenidas = await prisma.$queryRaw<{ id: string; requestId: string; venueId: string; terminalId: string; orderId: string | null; amountCents: number }[]>`
      SELECT "id", "requestId", "venueId", "terminalId", "orderId", "amountCents" FROM "TerminalPaymentRequest"
      WHERE "status" = 'TIMED_OUT' AND "failureCode" = 'BANK_APPROVED_AWAITING_PAYMENT' AND "paymentId" IS NULL
        AND "updatedAt" <= ${new Date(now.getTime() - UNKNOWN_AUTO_RELEASE_GRACE_MS)}
      ORDER BY "updatedAt" ASC LIMIT 100`
    for (const r of retenidas) {
      const soltada = await prisma.terminalPaymentRequest.updateMany({
        where: { id: r.id, status: TerminalPaymentRequestStatus.TIMED_OUT, failureCode: 'BANK_APPROVED_AWAITING_PAYMENT', paymentId: null },
        data: { failureCode: 'AUTO_RELEASED' },
      })
      if (soltada.count === 0) continue
      logger.error('🚨 [Terminal-payment watchdog] Slot released after 20 min with an approved bank event and still no Payment — the ORDER stays blocked', {
        requestId: r.requestId, venueId: r.venueId, terminalId: r.terminalId, orderId: r.orderId,
      })
      await logAction({
        staffId: null, venueId: r.venueId, action: 'TERMINAL_PAYMENT_AUTO_RELEASED', entity: 'TerminalPaymentRequest', entityId: r.id,
        data: { requestId: r.requestId, terminalId: r.terminalId, orderId: r.orderId, amountCents: r.amountCents, reason: 'BANK_APPROVED_AWAITING_PAYMENT_20MIN' },
      })
      void sendOpsAlert({
        subject: `Terminal ${r.terminalId} liberada tras 20 min con aprobación bancaria sin Payment (${r.venueId})`,
        lines: [
          `El banco aprobó el cobro de $${(r.amountCents / 100).toFixed(2)} (requestId ${r.requestId}, orden ${r.orderId ?? 'sin orden'}) y el Payment no se pudo crear en 20 min.`,
          'El servidor liberó LA TERMINAL. La VENTA sigue protegida: revisar el evento del webhook (importe distinto o registrador) y conciliar a mano.',
        ],
      }).catch(() => undefined)
    }
```

con su prueba: fila `TIMED_OUT/BANK_APPROVED_AWAITING_PAYMENT` con `updatedAt` a −21 min ⇒ tras el barrido `failureCode === 'AUTO_RELEASED'`, `isTerminalBusy(fixture) === false`, `hasChargeBlockingOrderCancel(venueId, orderId) === true`; y una a −5 min sigue intacta.

(j) El ingreso SIN candado del webhook toca la solicitud (Codex, Task 0 R3, P3). `ingresarEventoDelIntento` (`src/services/tpv/angelpay-webhook.service.ts` ~L797–833) tiene un fallback R15-1: si la espera del candado vence (55P03) el evento se persiste SIN serializar. Ese camino se escapa del candado que la ventana toma, y como insertar el evento no toca la solicitud, el CAS de la ventana (que exige el `updatedAt` leído) no lo notaría. El fallback pasa a tocar la solicitud vinculada EN LA MISMA transacción que persiste el evento — así el CAS de la ventana falla y la siguiente pasada ve el evento:

```ts
    return (
      await prisma.$transaction(async tx => {
        const creado = await insertar(tx, { [MARCA_INGRESO_SIN_CANDADO]: { en: new Date().toISOString() } })
        // Ventana de confirmación (plan 16-sep, Codex R3-P3): un evento que entra SIN el candado del intento tiene que invalidar el
        // CAS de la ventana — que exige el `updatedAt` leído bajo ese candado —, así que se toca la solicitud vinculada aquí mismo.
        // `timestamp(3)` sin zona ⇒ `NOW() AT TIME ZONE 'UTC'` (regla del repo). Sin vínculo no hay solicitud que tocar.
        await tx.$executeRaw`
          UPDATE "TerminalPaymentRequest" r SET "updatedAt" = (NOW() AT TIME ZONE 'UTC')
          FROM "TerminalPaymentAttemptLink" l
          WHERE l."attemptId" = ${llaveDelIntento} AND r."requestId" = l."requestId" AND r."venueId" = l."venueId"`
        return creado
      })
    ).id
```

Se toca para CUALQUIER evento del fallback (aprobado o no): un rechazo también es información, y lo peor que produce es que la ventana espere otros 30 s. Dos pruebas: (1) en la suite del fallback que ya existe (`tests/integration/payments/webhookPrimerConfirmador.webhook.integration.test.ts` ~L1660–1710, la que fuerza 55P03 con `TERMINAL_ATTEMPT_LOCK_TIMEOUT_MS='300'` y comprueba `ingresoSinCandado`): afirmar además que el `updatedAt` de la solicitud vinculada AVANZÓ respecto al leído antes del ingreso; (2) en `terminalPaymentWindow.integration.test.ts`, la intercalación exacta que Codex pidió:

```ts
  it('un APROBADO que entra por el fallback SIN candado entre el veto y el CAS anula la liberación (NUNCA RELEASED) y la siguiente pasada la retiene', async () => {
    const row = await auditRequest({ ...negativoSinEvidencia(), updatedAt: new Date(Date.now() - UNPROVEN_NEGATIVE_WINDOW_MS - 1_000) })
    const attemptId = `att-${randomUUID()}`
    await prisma.terminalPaymentAttemptLink.create({ data: { attemptId, requestId: row.requestId, venueId, terminalId: fixture } })
    // Simula EXACTAMENTE lo que hace el fallback (evento + toque de la solicitud, fuera del candado) en el hueco entre la
    // consulta del veto y el CAS: el espía deja pasar la consulta real y, antes de contestar «sin aprobación», comete el fallback.
    const svc = terminalPaymentService as any
    const original = svc.aprobacionBancariaConocida.bind(svc)
    const spy = jest.spyOn(svc, 'aprobacionBancariaConocida').mockImplementationOnce(async (...args: unknown[]) => {
      const r = await original(...args)
      await prisma.$transaction(async tx => {
        await tx.providerEventLog.create({
          data: {
            provider: 'PAYMENT_PROCESSOR', venueId, attemptId, type: 'send_transaction', status: 'PENDING',
            payload: { event: 'send_transaction', payload: { status: 'approved', amount: '10000', integratorReference: attemptId, transactionId: 'tx-fb' }, _avoqado: { ingresoSinCandado: { en: new Date().toISOString() } } },
          },
        })
        await tx.$executeRaw`UPDATE "TerminalPaymentRequest" SET "updatedAt" = (NOW() AT TIME ZONE 'UTC') WHERE "requestId" = ${row.requestId} AND "venueId" = ${venueId}`
      })
      return r // «sin aprobación», como lo vio la consulta
    })
    try {
      expect(await terminalPaymentService.releaseUnprovenNegative(row.requestId, venueId, 'WATCHDOG')).toBe('NOT_ELIGIBLE')
    } finally {
      spy.mockRestore()
    }
    const fila = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
    expect(fila).toMatchObject({ status: 'TIMED_OUT', failureCode: null })
    await conUpdatedAt(fila, new Date(Date.now() - UNPROVEN_NEGATIVE_WINDOW_MS - 1_000))
    expect(await terminalPaymentService.releaseUnprovenNegative(row.requestId, venueId, 'WATCHDOG')).toBe('HELD_BY_BANK_EVIDENCE')
  })
```

(f) Imports nuevos en `terminal-payment.service.ts`: `import { estadoBancarioSql } from './tpv/estadoBancario'` y `import { candadoDeIntento, OPCIONES_DE_TRANSACCION_DEL_INTENTO } from './tpv/candadoDeIntento'` (módulos sin efectos; comprobar por lectura que ninguno importa este servicio — hoy sólo importan `@prisma/client` y utilidades). `avisarAprobacionTardiaTrasVentana` se define en la Task 3 (mismo archivo, función de módulo); en esta tarea se deja como `function avisarAprobacionTardiaTrasVentana(_c: CloseRowOutcome, _ctx: {...}): void {}` con la firma final y un comentario «la Task 3 la llena», para que la Task 2 compile sola.

(g) Cartesiana: añadir también `'BANK_APPROVED_AWAITING_PAYMENT'` a la lista `CODIGOS` de «no pueden divergir» (`terminalPaymentRecovery.integration.test.ts` ~L2207): no está en la lista blanca ⇒ `TIMED_OUT` con ese código es UNRESOLVED en JS y en SQL.

(e) En `src/jobs/terminal-payment-watchdog.job.ts`, dentro de `run()` después de `reconcileUnknownRequests()`:

```ts
      // Ventana de confirmación (plan 16-sep): un negativo de la terminal sin evidencia que lleve ≥ 30 s se libera
      // aquí si el temporizador en proceso no llegó (reinicio, otra instancia). Idempotente por CAS.
      await terminalPaymentService.releaseUnprovenNegativesAfterWindow()
```

- [ ] **Step 4: Verlas pasar + las suites vecinas**

Run: `set -a; source ~/.claude/jobs/b1e1a1b3/tmp/db-desechable.env; set +a; cd avoqado-server && npx jest --selectProjects integration tests/integration/payments/terminalPaymentWindow.integration.test.ts tests/integration/payments/terminalPaymentRecovery.integration.test.ts tests/integration/payments/terminalPaymentStrictFlag.integration.test.ts --ci 2>&1 | tail -15`
Expected: PASS todas (la cartesiana sigue verde; el auto-release de 20 min sigue verde).
Run unit (una sola suite, a pelo): `npx jest tests/unit/services/terminal-payment.service.test.ts --ci 2>&1 | tail -8` → PASS.

- [ ] **Step 5: Commit**

```bash
cd avoqado-server && git add tests/integration/payments/terminalPaymentWindow.integration.test.ts && git commit -q -F - -- src/services/terminal-payment.service.ts src/jobs/terminal-payment-watchdog.job.ts src/services/tpv/angelpay-webhook.service.ts tests/unit/services/terminal-payment.service.test.ts tests/integration/payments/terminalPaymentWindow.integration.test.ts tests/integration/payments/terminalPaymentRecovery.integration.test.ts tests/integration/payments/terminalPaymentStrictFlag.integration.test.ts tests/integration/payments/webhookPrimerConfirmador.webhook.integration.test.ts <<'MSG'
feat(cobro remoto): ventana de confirmación de 30 s — un negativo sin evidencia se libera solo (FAILED/NO_EVIDENCE_AFTER_WINDOW) o se concilia si el pago exacto ya existe

closeRow escribe TIMED_OUT (no UNKNOWN) cuando la terminal contestó sin veredicto y conserva su sobre en resultJson.terminalResult;
temporizador en proceso + respaldo en el watchdog; un webhook aprobado sin Payment RETIENE la fila (BANK_APPROVED_AWAITING_PAYMENT).
UNKNOWN (success degradado, plazo del watchdog) y AUTO_RELEASED quedan fuera a propósito (regla del 12-sep intacta).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
git show --stat HEAD | head -12
```

---

### Task 3 (servidor): una aprobación del banco que llega DESPUÉS de la ventana reabre la fila, grita, avisa por correo y detecta el doble cobro

**Files:**
- Modify: `src/services/terminal-payment.service.ts` (`closeRowFromPaymentTx`: `select` de `before` L2296; bloque `alarmed` L2474–2488)
- Test: `tests/integration/payments/terminalPaymentWindow.integration.test.ts`

**Interfaces:**
- Consumes: `closeRowFromPaymentTx` (ya reabre por CAS `paymentId: null` y marca `reopened`), `sendOpsAlert({ subject, lines })`, `CloseRowOutcome`, el barrido de 30 min de `reconcileUnknownRequests` (~L3098, `releasedRows`), los llamadores externos de `closeRowFromPaymentTx` (`payment.tpv.service.ts` L3473 y L5023 con su `s0.cierre` post-commit; `registroRepetido.ts` L330).
- Produces: `CloseRowOutcome` (rama `bound: true`) gana `lateAfterWindow?: { otherCardPaymentsOnOrderAfterRelease: number | null }` (sólo cuando `before.failureCode === 'NO_EVIDENCE_AFTER_WINDOW'`); bitácora `TERMINAL_PAYMENT_LATE_APPROVAL_AFTER_WINDOW` escrita DENTRO de la transacción, en la rama ganadora (`ganada.count === 1`, la misma que calcula `reopened`) — una sola vez por reapertura; 🚨 `[Terminal-payment late approval after window]`; función de módulo `avisarAprobacionTardiaTrasVentana(cierre: CloseRowOutcome | null, ctx: { requestId; venueId; paymentId; terminalId: string | null; orderId: string | null }): void` que manda el correo ops **DESPUÉS del commit** (best-effort, `void sendOpsAlert`), llamada desde CADA llamador de `closeRowFromPaymentTx` tras su commit; el barrido de 30 min cubre también `FAILED/NO_EVIDENCE_AFTER_WINDOW` y concilia por `closeRowFromPaymentTx` (no por su `updateMany` propio).

- [ ] **Step 1: Prueba en rojo** (misma suite de Task 2):

```ts
describe('Aprobación tardía tras la ventana', () => {
  it('el webhook que llega después de liberar reabre la fila a COMPLETED, deja bitácora y grita si hay otro cobro con tarjeta en la misma orden', async () => {
    const vencida = new Date(Date.now() - UNPROVEN_NEGATIVE_WINDOW_MS - 1_000)
    const row = await auditRequest({ ...negativoSinEvidencia(), updatedAt: vencida })
    expect(await terminalPaymentService.releaseUnprovenNegative(row.requestId, venueId, 'WATCHDOG')).toBe('RELEASED')
    // El cajero ya recobró la misma orden en otro intento (el caso de Testarudo del 16-sep 11:09):
    await auditPayment({ processorData: { terminalPaymentRequestId: 'otra-solicitud' } })
    // …y ahora llega la aprobación del PRIMER intento (misma llave/referencia que la solicitud liberada):
    const tardio = await auditPayment({ processorData: { terminalPaymentRequestId: row.requestId, deviceSerialNumber: fixture } })
    const cierre = await prisma.$transaction(tx =>
      terminalPaymentService.closeRowFromPaymentTx(tx, row.requestId, tardio.id, venueId, undefined, 'REST', undefined, 'webhook'),
    )
    expect(cierre).toMatchObject({ bound: true, reopened: true, alarmed: true, previousStatus: 'FAILED', lateAfterWindow: { otherCardPaymentsOnOrderAfterRelease: 1 } })
    const reabierta = await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })
    expect(reabierta).toMatchObject({ status: 'COMPLETED', paymentId: tardio.id, lateResult: true, closedVia: 'webhook' })
    const bitacora = await prisma.activityLog.findMany({ where: { venueId, action: 'TERMINAL_PAYMENT_LATE_APPROVAL_AFTER_WINDOW', entityId: row.id } })
    expect(bitacora).toHaveLength(1)
    expect((bitacora[0].data as any).otherCardPaymentsOnOrderAfterRelease).toBe(1)
    // Replay del mismo Payment sobre la fila ya reabierta: no gana, no escribe otro asiento.
    const replay = await prisma.$transaction(tx =>
      terminalPaymentService.closeRowFromPaymentTx(tx, row.requestId, tardio.id, venueId, undefined, 'REST', undefined, 'webhook'),
    )
    expect(replay.bound).toBe(false)
    expect(await prisma.activityLog.count({ where: { venueId, action: 'TERMINAL_PAYMENT_LATE_APPROVAL_AFTER_WINDOW', entityId: row.id } })).toBe(1)
  })

  it('un reembolso posterior en la orden NO cuenta como «otro cobro con tarjeta» (predicado NULL-seguro sobre Payment.type)', async () => {
    const row = await auditRequest({ ...negativoSinEvidencia(), updatedAt: new Date(Date.now() - UNPROVEN_NEGATIVE_WINDOW_MS - 1_000) })
    expect(await terminalPaymentService.releaseUnprovenNegative(row.requestId, venueId, 'WATCHDOG')).toBe('RELEASED')
    await auditPayment({ type: 'REFUND', processorData: { terminalPaymentRequestId: 'otra-solicitud' } })
    await auditPayment({ type: null, processorData: { terminalPaymentRequestId: 'otra-mas' } }) // legacy sin tipo: SÍ cuenta
    const tardio = await auditPayment({ processorData: { terminalPaymentRequestId: row.requestId, deviceSerialNumber: fixture } })
    const cierre = await prisma.$transaction(tx =>
      terminalPaymentService.closeRowFromPaymentTx(tx, row.requestId, tardio.id, venueId, undefined, 'REST'),
    )
    expect(cierre).toMatchObject({ bound: true, lateAfterWindow: { otherCardPaymentsOnOrderAfterRelease: 1 } })
  })

  it('el correo sale DESPUÉS del commit y sólo cuando el cierre ganó: sendOpsAlert se llama una vez con el conteo', async () => {
    const opsAlert = await import('@/services/alerts/opsAlert.service')
    const spy = jest.spyOn(opsAlert, 'sendOpsAlert').mockResolvedValue(true)
    try {
      const row = await auditRequest({ ...negativoSinEvidencia(), updatedAt: new Date(Date.now() - UNPROVEN_NEGATIVE_WINDOW_MS - 1_000) })
      expect(await terminalPaymentService.releaseUnprovenNegative(row.requestId, venueId, 'WATCHDOG')).toBe('RELEASED')
      await auditPayment({ processorData: { terminalPaymentRequestId: row.requestId, deviceSerialNumber: fixture } })
      // El barrido de 30 min encuentra el Payment de la fila liberada y concilia por el cierre común.
      await terminalPaymentService.reconcileUnknownRequests(new Date())
      expect((await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('COMPLETED')
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.mock.calls[0][0].subject).toContain('Cobro aprobado tarde tras la ventana')
      await terminalPaymentService.reconcileUnknownRequests(new Date())
      expect(spy).toHaveBeenCalledTimes(1) // ya está COMPLETED: no se repite
    } finally {
      spy.mockRestore()
    }
  })

  it('tras liberar por ventana, la MISMA orden vuelve a ser cobrable (la admisión acepta un cobro nuevo)', async () => {
    const orden = await nuevaOrden({})
    const row = await auditRequest({ ...negativoSinEvidencia(), orderId: orden.id, updatedAt: new Date(Date.now() - UNPROVEN_NEGATIVE_WINDOW_MS - 1_000) })
    expect(await terminalPaymentService.releaseUnprovenNegative(row.requestId, venueId, 'WATCHDOG')).toBe('RELEASED')
    const b = await enviar({ requestId: nextRequest(), venueId, terminalId: terminalDe('b'), orderId: orden.id, amountCents: 10000, requestedBy: fixture })
    expect(b).not.toBeInstanceOf(Error)
    expect(directEmit).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Verla fallar**

Run: `set -a; source ~/.claude/jobs/b1e1a1b3/tmp/db-desechable.env; set +a; cd avoqado-server && npx jest --selectProjects integration tests/integration/payments/terminalPaymentWindow.integration.test.ts -t "tardía" --ci 2>&1 | tail -30`
Expected: FAIL en `lateAfterWindow`/la bitácora — la reapertura sí ocurre (CAS existente); lo que falta es el rastro específico. Si `bound` saliera `false`, es un hallazgo real: anotar el `reason` y arreglar el cierre (prioridad sobre la bitácora).

- [ ] **Step 3: Implementar**

(a) `CloseRowOutcome` (L1117, rama `bound: true`) gana `lateAfterWindow?: { otherCardPaymentsOnOrderAfterRelease: number | null }`.

(b) En `closeRowFromPaymentTx`: añadir `failureCode: true, updatedAt: true, id: true` al `select` de `before` (L2296). **Dentro de la rama ganadora** — la que ya sabe `ganada.count === 1` y calcula `reopened`/`alarmed` (L2474–2488) — después del `if (alarmed) { logger.error(…) }`:

```ts
      let lateAfterWindow: { otherCardPaymentsOnOrderAfterRelease: number | null } | undefined
      if (before.failureCode === 'NO_EVIDENCE_AFTER_WINDOW') {
        // La ventana liberó esta venta y el banco la aprobó DESPUÉS: el caso que la ventana acota pero no elimina.
        // Cuenta los cobros con tarjeta que la orden recibió DESDE la liberación (`before.updatedAt`, leído bajo el candado
        // ANTES de reabrir) hasta ahora: es «otros cobros registrados hasta este momento», no una prueba de doble cobro —
        // puede haber abonos parciales legítimos; quien lo revisa decide. Reembolsos fuera, NULL-seguro (`Payment.type`
        // es nullable: `type <> 'REFUND'` a secas excluiría las filas legacy — mismo predicado que `SIN_REEMBOLSOS` en
        // payment.tpv.service.ts:31, repetido aquí porque importarlo cerraría un ciclo).
        const otros = before.orderId
          ? await tx.payment.count({
              where: {
                venueId,
                orderId: before.orderId,
                id: { not: paymentId },
                status: TransactionStatus.COMPLETED,
                method: { in: [PaymentMethod.CREDIT_CARD, PaymentMethod.DEBIT_CARD] },
                createdAt: { gt: before.updatedAt },
                OR: [{ type: null }, { type: { not: 'REFUND' } }],
              },
            })
          : null
        lateAfterWindow = { otherCardPaymentsOnOrderAfterRelease: otros }
        logger.error('🚨 [Terminal-payment late approval after window] The bank approved a charge the window had released', {
          requestId, paymentId, venueId, orderId: before.orderId, terminalId: before.terminalId, otherCardPaymentsOnOrderAfterRelease: otros, closedVia,
        })
        // Asiento DENTRO de la transacción y sólo en la rama ganadora: una reapertura = un asiento (replays y callbacks
        // concurrentes pierden el CAS y no llegan aquí). `tx.activityLog.create` directo: `logAction` abre su propia conexión.
        await tx.activityLog.create({
          data: {
            action: 'TERMINAL_PAYMENT_LATE_APPROVAL_AFTER_WINDOW',
            entity: 'TerminalPaymentRequest',
            entityId: before.id,
            venueId,
            data: { requestId, paymentId, orderId: before.orderId, terminalId: before.terminalId, otherCardPaymentsOnOrderAfterRelease: otros, closedVia },
          },
        })
      }
```

y el `return { bound: true, reopened, contractMismatch, previousStatus, alarmed }` de esa rama pasa a `{ …, ...(lateAfterWindow ? { lateAfterWindow } : {}) }`.

(c) Función de módulo (llena la firma que la Task 2 dejó vacía), junto a `resultFromRow`:

```ts
/**
 * Correo ops de la aprobación tardía tras la ventana. Corre DESPUÉS del commit y sin `await` encadenado: dentro de la
 * transacción podría salir y luego revertirse, y repetirse al reintentar (Codex, Task 0, P2). El asiento durable y único es
 * el `ActivityLog` de `closeRowFromPaymentTx`; el correo es best-effort y NO se promete «exactamente una vez».
 */
function avisarAprobacionTardiaTrasVentana(
  cierre: CloseRowOutcome | null,
  ctx: { requestId: string; venueId: string; paymentId: string; terminalId: string | null; orderId: string | null },
): void {
  if (!cierre?.bound || !cierre.lateAfterWindow) return
  const otros = cierre.lateAfterWindow.otherCardPaymentsOnOrderAfterRelease
  void sendOpsAlert({
    subject: `Cobro aprobado tarde tras la ventana — ${ctx.terminalId ?? 'terminal desconocida'}`,
    lines: [
      `El banco aprobó un cobro (${ctx.paymentId}) de la solicitud ${ctx.requestId} después de que la ventana de 30 s la liberara.`,
      otros
        ? `🔴 La orden ${ctx.orderId} tiene ${otros} cobro(s) con tarjeta registrados después de liberarla: revisar si hay que devolver uno.`
        : 'La orden no muestra otro cobro con tarjeta posterior: sólo confirmar que quedó registrado.',
    ],
  }).catch(() => undefined)
}
export { avisarAprobacionTardiaTrasVentana }
```

(d) Llamarla **después del commit** en cada llamador de `closeRowFromPaymentTx` (`grep -rn "closeRowFromPaymentTx(" src`): en `payment.tpv.service.ts` junto a las dos llamadas a `registrarConfirmacionAnomalaPorWebhook(s0.cierre, …)` (L3770 y L5159) pero SIN la condición `registradoVia === 'webhook'` — el REST también puede reabrir; en `registroRepetido.ts` L330 tras su transacción; en la Task 2 (`RECONCILED`, ya escrito) y en el barrido de (e).

(e) Barrido de 30 min (`reconcileUnknownRequests`, ~L3098): junto a `releasedRows`, un segundo `findMany` — `{ status: FAILED, failureCode: 'NO_EVIDENCE_AFTER_WINDOW', updatedAt: { gte: new Date(now.getTime() - RELEASED_LATE_RECONCILE_WINDOW_MS) } }`, `take: 200` — y por cada fila: `const payment = await this.findReconcilablePayment(row); if (!payment) continue; const cierre = await prisma.$transaction(tx => this.closeRowFromPaymentTx(tx, row.requestId, payment.id, row.venueId, undefined, 'REST')); if (cierre.bound) { lateReconciled += 1; avisarAprobacionTardiaTrasVentana(cierre, { requestId: row.requestId, venueId: row.venueId, paymentId: payment.id, terminalId: row.terminalId, orderId: row.orderId }) }`. El bucle existente de `RELEASE_FAILURE_CODES` NO se toca.

- [ ] **Step 4: Verla pasar** — mismo comando del Step 2 → PASS; y la suite de Task 2 completa sigue verde.

- [ ] **Step 5: Commit**

```bash
cd avoqado-server && git commit -q -F - -- src/services/terminal-payment.service.ts src/services/tpv/payment.tpv.service.ts src/services/tpv/registroRepetido.ts tests/integration/payments/terminalPaymentWindow.integration.test.ts <<'MSG'
feat(cobro remoto): una aprobación que llega tras la ventana reabre la fila, deja UN asiento dentro de la transacción, avisa a ops después del commit y cuenta los cobros posteriores de la orden (sin reembolsos)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 4 (servidor): la declaración del cajero «no se presentó tarjeta» — un paso, sin PIN para quien tiene permiso

**Files:**
- Create: `src/services/tpv/no-instrument-resolution.service.ts` (portado de `/Users/amieva/.codex/worktrees/no-card-recovery-20260916/avoqado-server/src/services/tpv/no-instrument-resolution.service.ts`, simplificado)
- Modify: `src/controllers/tpv/terminal-payment.tpv.controller.ts` (`resolveNoInstrument`)
- Modify: `src/routes/tpv.routes.ts`
- Modify: `src/lib/permissions.ts` (`payments:resolve-no-instrument` en el catálogo y en OWNER/ADMIN/MANAGER)
- Modify: `prisma/schema.prisma` (`TerminalPaymentAttemptLink.operatorResolution Json?`), Create `prisma/migrations/20260916193000_no_instrument_resolution/migration.sql` (copiar la de Codex tal cual: columna + trigger de inmutabilidad), regenerar `docs/SCHEMA_MAP.md`
- Test: Create `tests/unit/services/tpv/no-instrument-resolution.service.test.ts`, Create `tests/api-tests/tpv/no-instrument-resolution.api.test.ts`, y un caso más en `tests/integration/payments/terminalPaymentWindow.integration.test.ts`

**Interfaces:**
- Consumes: `evaluatePermissionList` y `hasPermission` de `src/lib/permissions.ts` (la MISMA regla que `checkPermission.middleware.ts:360-389`); `desenlaceCanonico`; `pinOverrideRateLimiter` (`src/middlewares/pin-login-rate-limit.middleware.ts:212`, es un ARREGLO de dos middlewares: se hace spread en la ruta); `logAction` (`src/services/dashboard/activity-log.service.ts:35`).
- Produces: `POST /tpv/venues/:venueId/terminal-payment/attempts/:attemptId/no-instrument-resolution` con body `{ requestId, resolutionId (uuid), statement: 'NO_INSTRUMENT_PRESENTED', statementVersion: 1, supervisorPin?: string }` → `200 { success: true, ...TerminalAttemptStatus, resolution: { id, acceptedAt, by: 'SESSION' | 'SUPERVISOR_PIN' } }`; `403 { code: 'SUPERVISOR_AUTHORIZATION_REQUIRED' | 'SESSION_NOT_IN_VENUE' | 'TERMINAL_IDENTITY_REQUIRED' }`; `409 { code: 'ATTEMPT_NOT_ELIGIBLE' | 'POSITIVE_EVIDENCE_EXISTS' | 'RESOLUTION_CONFLICT' | 'OTHER_ATTEMPT_UNRESOLVED' }`; `404 { code: 'ATTEMPT_NOT_FOUND' }`; `503 { code: 'RESOLUTION_UNAVAILABLE' }`. La transacción abre con `OPCIONES_DE_TRANSACCION_DEL_INTENTO` y toma `candadoDeIntento` → `Order FOR UPDATE` → `TerminalPaymentRequest FOR UPDATE` (mismo orden que el registrador). Efecto: fila → `FAILED / OPERATOR_RECONCILED_NO_CHARGE`, `resultJson.outcomeEvidence = 'OPERATOR_RECONCILED'`, `link.operatorResolution` escrito una vez, bitácora `TERMINAL_PAYMENT_NO_INSTRUMENT_RESOLVED` con el `staffId` que declaró.

- [ ] **Step 1: Pruebas unitarias en rojo** (`tests/unit/services/tpv/no-instrument-resolution.service.test.ts`; mockear `@/utils/prismaClient` con `jest-mock-extended` como hacen las suites vecinas de `tests/unit/services/tpv/`). Casos, cada uno con su `it`:

```ts
// 1. la sesión (authContext.userId) con permiso efectivo declara SIN PIN → FAILED/OPERATOR_RECONCILED_NO_CHARGE, by: 'SESSION', staffId = el de la sesión
// 2. otra persona con permiso, también sin PIN (no es sólo OWNER: el permiso decide)
// 3. sesión SIN permiso y sin supervisorPin → 403 SUPERVISOR_AUTHORIZATION_REQUIRED, nada escrito
// 4. sesión SIN permiso + PIN de alguien CON permiso → declara, by: 'SUPERVISOR_PIN', staffId = el del PIN, bitácora con ambos (sessionStaffId y staffId)
// 5. permiso negado explícitamente en VenueRolePermission.deniedPermissions → 403 aunque el rol lo traiga
// 5b. la sesión tiene un permissionSet asignado que NO trae el permiso aunque su rol sí → 403 (el conjunto REEMPLAZA al rol); y al revés, conjunto que lo trae con rol que no → declara
// 6. sesión INVÁLIDA para este venue (staff inactivo / staffVenue inactivo / de otro venue / sin StaffVenue) → 403 SESSION_NOT_IN_VENUE **sin** elevación posible: un supervisorPin válido NO la rescata (la elevación cubre sólo «miembro válido sin permiso»)
// 7. el body trae staffId/role: se IGNORAN (la identidad sale de authContext, nunca del cuerpo; el esquema Zod es .strict() ⇒ llaves extra = 400/ATTEMPT_NOT_ELIGIBLE, y aun sin strict no se leerían)
// 8. el link del intento no es de esta terminal (terminalSerial del JWT ≠ link.terminalId) → 404 ATTEMPT_NOT_FOUND; 8b. el link existe pero apunta a OTRA solicitud (link.requestId ≠ body.requestId) → 404; 8c. la solicitud existe pero es de otra terminal del MISMO venue → 404
// 9. replay con el mismo resolutionId y mismo body → 200 idéntico, sin segunda bitácora; distinto body → 409 RESOLUTION_CONFLICT
// 9b. la solicitud tiene DOS links (dos intentos) → 409 OTHER_ATTEMPT_UNRESOLVED
// 10. hay Payment con la llave del intento / paymentId en la fila / resultJson con señal positiva (status success, approved, paymentId/authorizationCode/transactionId/reference/readMode no vacíos) / ProviderEventLog del intento APROBADO o con contradicción de procedencia → 409 POSITIVE_EVIDENCE_EXISTS
// 11. la fila ya está acreditada (FAILED/PROCESSOR_DECLINED) o en PENDING → 409 ATTEMPT_NOT_ELIGIBLE
// 12. una fila ya liberada por la ventana (FAILED/NO_EVIDENCE_AFTER_WINDOW) o retenida por evidencia bancaria (TIMED_OUT/BANK_APPROVED_AWAITING_PAYMENT) → 409 ATTEMPT_NOT_ELIGIBLE / POSITIVE_EVIDENCE_EXISTS (no se pisa la evidencia)
// 13. la orden de la fila no pertenece al venue → 409 ATTEMPT_NOT_ELIGIBLE
```

Fragmento de referencia para el caso 1 (los demás siguen la misma forma):

```ts
import { resolveNoInstrument, NO_INSTRUMENT_PERMISSION } from '@/services/tpv/no-instrument-resolution.service'

it('la sesión con permiso efectivo declara sin PIN y la fila queda acreditada por OPERADOR', async () => {
  prismaMock.terminalPaymentRequest.findFirst.mockResolvedValue(filaTimedOutSinEvidencia)
  prismaMock.terminalPaymentAttemptLink.findUnique.mockResolvedValue(linkDeEstaTerminal)
  prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv1', staffId: 'staff-owner', role: 'OWNER', active: true, permissionSetId: null, permissionSet: null, staff: { active: true } } as any)
  prismaMock.venueRolePermission.findUnique.mockResolvedValue(null)
  prismaMock.payment.findFirst.mockResolvedValue(null)
  prismaMock.terminalPaymentAttemptLink.count.mockResolvedValue(1)
  prismaMock.terminalPaymentRequest.updateMany.mockResolvedValue({ count: 1 })
  const r = await resolveNoInstrument(
    { venueId: 'v1', terminalSerial: 'AVQD-N860W173397', attemptId: 'att-1', actorStaffId: 'staff-owner' },
    { requestId: 'req-1', resolutionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', statement: 'NO_INSTRUMENT_PRESENTED', statementVersion: 1 },
  )
  expect(r.resolution).toMatchObject({ by: 'SESSION' })
  expect(prismaMock.terminalPaymentRequest.updateMany).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({ status: 'FAILED', failureCode: 'OPERATOR_RECONCILED_NO_CHARGE' }),
  }))
  expect(prismaMock.activityLog.create).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({ action: 'TERMINAL_PAYMENT_NO_INSTRUMENT_RESOLVED', staffId: 'staff-owner' }),
  }))
})
```

- [ ] **Step 2: Verlas fallar** — `npx jest tests/unit/services/tpv/no-instrument-resolution.service.test.ts --ci 2>&1 | tail -20` → FAIL (`Cannot find module`).

- [ ] **Step 3: Implementar el servicio** (portar de Codex y simplificar). Esqueleto completo con las decisiones cerradas:

```ts
// src/services/tpv/no-instrument-resolution.service.ts
import { createHash } from 'crypto'
import { z } from 'zod'
import { Prisma, TerminalPaymentRequestStatus } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { normalizeTerminalId } from '../../communication/sockets/terminal-registry'
import { evaluatePermissionList, hasPermission } from '../../lib/permissions'
import { candadoDeIntento, OPCIONES_DE_TRANSACCION_DEL_INTENTO } from './candadoDeIntento'
import { estadoBancarioSql } from './estadoBancario'
import { PATRON_SQL_TRIM_COMO_JS } from '../../utils/terminalSerial'

export const NO_INSTRUMENT_PERMISSION = 'payments:resolve-no-instrument'

const schema = z
  .object({
    requestId: z.string().min(1),
    resolutionId: z.string().uuid(),
    statement: z.literal('NO_INSTRUMENT_PRESENTED'),
    statementVersion: z.literal(1),
    supervisorPin: z.string().min(4).max(8).optional(),
  })
  .strict()

export class NoInstrumentResolutionError extends Error {
  constructor(readonly code: string, readonly statusCode = 409) {
    super(
      code === 'SUPERVISOR_AUTHORIZATION_REQUIRED'
        ? 'Se requiere el código de alguien con permiso para confirmar que no se presentó tarjeta.'
        : code === 'SESSION_NOT_IN_VENUE'
          ? 'La sesión de esta terminal no pertenece a este negocio. Vuelve a iniciar sesión.'
          : 'No se pudo cerrar este intento. Conserva el cobro pendiente y consulta su resultado.',
    )
  }
}

export type OperatorResolution = {
  id: string
  kind: 'NO_INSTRUMENT_PRESENTED'
  acceptedAt: string
  bodyHash: string
  staffId: string
  staffVenueId: string
  by: 'SESSION' | 'SUPERVISOR_PIN'
  statementVersion: number
  previousRequest: { status: string; failureCode: string | null }
}

export function readOperatorResolution(value: unknown): OperatorResolution | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const r = value as OperatorResolution
  return r.kind === 'NO_INSTRUMENT_PRESENTED' && typeof r.id === 'string' ? r : null
}

/**
 * ¿Esta persona, en este local, tiene el permiso EFECTIVO? EXACTAMENTE la regla de `checkPermission.middleware.ts:360-389`:
 * con conjunto de permisos asignado se evalúa ESA lista (reemplaza al rol); si no, rol + extras del venue − negados.
 * Devuelve TRES cosas distintas (Codex, Task 0, P4): no es miembro válido del venue (`null`) ≠ miembro sin permiso
 * (`{ …, permitido: false }`) ≠ miembro con permiso. Sólo el segundo puede elevarse con el PIN de otra persona.
 */
async function miembroDelVenue(
  tx: Prisma.TransactionClient,
  venueId: string,
  staffId: string,
): Promise<{ id: string; staffId: string; permitido: boolean } | null> {
  const sv = await tx.staffVenue.findFirst({
    where: { venueId, staffId, active: true, staff: { active: true } },
    select: { id: true, staffId: true, role: true, permissionSetId: true, permissionSet: true },
  })
  if (!sv) return null
  let permitido: boolean
  if (sv.permissionSetId && sv.permissionSet) {
    permitido = evaluatePermissionList(sv.permissionSet.permissions, NO_INSTRUMENT_PERMISSION)
  } else {
    const custom = await tx.venueRolePermission.findUnique({
      where: { venueId_role: { venueId, role: sv.role } },
      select: { permissions: true, deniedPermissions: true },
    })
    permitido = hasPermission(sv.role, custom?.permissions ?? null, NO_INSTRUMENT_PERMISSION, (custom?.deniedPermissions as string[] | null) ?? null)
  }
  return { id: sv.id, staffId: sv.staffId, permitido }
}

/**
 * Evidencia que VETA la declaración (portado tal cual del worktree de Codex): un evento del intento de OTRO venue, con
 * contradicción de vínculo, con un serial de terminal que no es éste, o APROBADO por el banco (aunque no exista Payment).
 * Consulta acotada al intento exacto. Misma clasificación bancaria que el receptor (`estadoBancarioSql`).
 */
async function evidenciaQueVetaLaDeclaracion(tx: Prisma.TransactionClient, attemptId: string, venueId: string, terminalId: string) {
  return tx.$queryRaw<{ id: string }[]>`
    SELECT e."id" FROM "ProviderEventLog" e
    WHERE e."attemptId" = ${attemptId} AND e."provider" = 'PAYMENT_PROCESSOR'
      AND (e."venueId" IS DISTINCT FROM ${venueId}
        OR e."errorReason" IN ('LINK_TERMINAL_MISMATCH', 'LINK_VENUE_MISMATCH')
        OR (nullif(regexp_replace(coalesce(e."payload"->'payload'->>'terminalSerial', ''), ${PATRON_SQL_TRIM_COMO_JS}, '', 'g'), '') IS NOT NULL
          AND lower(regexp_replace(regexp_replace(e."payload"->'payload'->>'terminalSerial', ${PATRON_SQL_TRIM_COMO_JS}, '', 'g'), '^AVQD-', '', 'i')) <> ${terminalId})
        OR ${estadoBancarioSql(Prisma.sql`coalesce(e."payload"->'payload'->'status', e."payload"->'status')`)} = 'APROBADO')
    LIMIT 1`
}

export async function resolveNoInstrument(
  identity: { venueId: string; terminalSerial: string; attemptId: string; actorStaffId: string | null },
  raw: unknown,
) {
  const parsed = schema.safeParse(raw)
  if (!parsed.success) throw new NoInstrumentResolutionError('ATTEMPT_NOT_ELIGIBLE')
  const { supervisorPin, ...declaration } = parsed.data
  const bodyHash = createHash('sha256').update(JSON.stringify(declaration)).digest('hex')
  const terminalId = normalizeTerminalId(identity.terminalSerial)

  const resolution = await prisma.$transaction(async tx => {
    // MISMO orden de candados que el registrador y la referencia de Codex: intento → orden → solicitud.
    await candadoDeIntento(tx, identity.attemptId)
    const inicial = await tx.terminalPaymentRequest.findFirst({ where: { requestId: declaration.requestId, venueId: identity.venueId, terminalId } })
    if (!inicial) throw new NoInstrumentResolutionError('ATTEMPT_NOT_FOUND', 404)
    if (inicial.orderId) await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${inicial.orderId} FOR UPDATE`
    await tx.$queryRaw`SELECT "id" FROM "TerminalPaymentRequest" WHERE "requestId" = ${declaration.requestId} AND "venueId" = ${identity.venueId} FOR UPDATE`
    const row = await tx.terminalPaymentRequest.findFirst({ where: { requestId: declaration.requestId, venueId: identity.venueId, terminalId } })
    const link = await tx.terminalPaymentAttemptLink.findUnique({ where: { attemptId: identity.attemptId } })
    if (!row || !link || link.requestId !== declaration.requestId || link.venueId !== identity.venueId || normalizeTerminalId(link.terminalId) !== terminalId)
      throw new NoInstrumentResolutionError('ATTEMPT_NOT_FOUND', 404)
    if (row.orderId && !(await tx.order.findFirst({ where: { id: row.orderId, venueId: identity.venueId }, select: { id: true } })))
      throw new NoInstrumentResolutionError('ATTEMPT_NOT_ELIGIBLE')

    const existing = readOperatorResolution(link.operatorResolution)
    if (existing) {
      if (existing.id !== declaration.resolutionId || existing.bodyHash !== bodyHash) throw new NoInstrumentResolutionError('RESOLUTION_CONFLICT')
      return existing // replay idempotente: nada se reescribe
    }

    // AUTORIZACIÓN: la persona de la SESIÓN (el PIN con el que entró a la terminal) tiene que ser miembro VÁLIDO de este venue —
    // si no lo es, nadie la rescata con un PIN—; y si lo es pero no tiene el permiso, el PIN de otra persona que sí lo tenga.
    const sesion = identity.actorStaffId ? await miembroDelVenue(tx, identity.venueId, identity.actorStaffId) : null
    if (!sesion) throw new NoInstrumentResolutionError('SESSION_NOT_IN_VENUE', 403)
    let actor: { id: string; staffId: string } = sesion
    let by: OperatorResolution['by'] = 'SESSION'
    if (!sesion.permitido) {
      if (!supervisorPin) throw new NoInstrumentResolutionError('SUPERVISOR_AUTHORIZATION_REQUIRED', 403)
      const porPin = await tx.staffVenue.findFirst({ where: { venueId: identity.venueId, pin: supervisorPin, active: true, staff: { active: true } }, select: { staffId: true } })
      const supervisor = porPin ? await miembroDelVenue(tx, identity.venueId, porPin.staffId) : null
      if (!supervisor?.permitido) throw new NoInstrumentResolutionError('SUPERVISOR_AUTHORIZATION_REQUIRED', 403)
      actor = supervisor
      by = 'SUPERVISOR_PIN'
    }

    // ELEGIBILIDAD (la de Codex, sin la valla): un solo intento por solicitud; sin Payment por ninguna de las tres identidades;
    // sin señal positiva en el sobre; sin evidencia bancaria/de procedencia que vete; desenlace no acreditado y no PENDING.
    if ((await tx.terminalPaymentAttemptLink.count({ where: { requestId: declaration.requestId } })) !== 1)
      throw new NoInstrumentResolutionError('OTHER_ATTEMPT_UNRESOLVED')
    const positivo = await tx.payment.findFirst({
      where: { OR: [{ idempotencyKey: identity.attemptId }, { terminalPaymentRequestId: declaration.requestId }, ...(row.paymentId ? [{ id: row.paymentId }] : [])] },
      select: { id: true },
    })
    const sobre = row.resultJson && typeof row.resultJson === 'object' && !Array.isArray(row.resultJson) ? (row.resultJson as Record<string, unknown>) : {}
    const senalPositiva =
      sobre.status === 'success' ||
      sobre.approved === true ||
      ['paymentId', 'authorizationCode', 'transactionId', 'reference', 'readMode'].some(f => typeof sobre[f] === 'string' && sobre[f] !== '')
    if (positivo || row.paymentId || senalPositiva || (await evidenciaQueVetaLaDeclaracion(tx, identity.attemptId, identity.venueId, terminalId)).length)
      throw new NoInstrumentResolutionError('POSITIVE_EVIDENCE_EXISTS')
    const { desenlaceCanonico } = await import('../terminal-payment.service')
    if (desenlaceCanonico(row).outcome !== 'UNRESOLVED' || row.status === TerminalPaymentRequestStatus.PENDING || row.failureCode === 'BANK_APPROVED_AWAITING_PAYMENT')
      throw new NoInstrumentResolutionError(row.failureCode === 'BANK_APPROVED_AWAITING_PAYMENT' ? 'POSITIVE_EVIDENCE_EXISTS' : 'ATTEMPT_NOT_ELIGIBLE')

    const saved: OperatorResolution = {
      id: declaration.resolutionId, kind: 'NO_INSTRUMENT_PRESENTED', acceptedAt: new Date().toISOString(), bodyHash,
      staffId: actor.staffId, staffVenueId: actor.id, by, statementVersion: declaration.statementVersion,
      previousRequest: { status: row.status, failureCode: row.failureCode },
    }
    const cas = await tx.terminalPaymentRequest.updateMany({
      where: { id: row.id, status: row.status, paymentId: null },
      data: {
        status: TerminalPaymentRequestStatus.FAILED,
        failureCode: 'OPERATOR_RECONCILED_NO_CHARGE',
        cancelDisposition: null,
        resultJson: { ...sobre, requestId: declaration.requestId, status: 'failed', outcomeEvidence: 'OPERATOR_RECONCILED',
          errorMessage: 'La terminal confirmó que no se presentó tarjeta. Se puede volver a cobrar.', operatorResolution: saved } as Prisma.InputJsonObject,
      },
    })
    if (cas.count !== 1) throw new NoInstrumentResolutionError('ATTEMPT_NOT_ELIGIBLE')
    await tx.terminalPaymentAttemptLink.update({ where: { attemptId: identity.attemptId }, data: { operatorResolution: saved as unknown as Prisma.InputJsonValue } })
    await tx.activityLog.create({
      data: {
        action: 'TERMINAL_PAYMENT_NO_INSTRUMENT_RESOLVED', entity: 'TerminalPaymentRequest', entityId: row.id, venueId: identity.venueId,
        staffId: actor.staffId,
        data: { requestId: declaration.requestId, attemptId: identity.attemptId, terminalId, by, sessionStaffId: identity.actorStaffId, resolutionId: saved.id },
      },
    })
    return saved
  }, OPCIONES_DE_TRANSACCION_DEL_INTENTO)

  const { terminalPaymentService } = await import('../terminal-payment.service')
  const current = await terminalPaymentService.consultarIntentoDeTerminal({ attemptId: identity.attemptId, venueId: identity.venueId, terminalSerial: identity.terminalSerial })
  if (!current) throw new NoInstrumentResolutionError('RESOLUTION_UNAVAILABLE', 503)
  return { ...current, resolution: { id: resolution.id, acceptedAt: resolution.acceptedAt, by: resolution.by } }
}
```

Controlador (`terminal-payment.tpv.controller.ts`):

```ts
export const resolveNoInstrument = async (req: Request, res: Response) => {
  const terminalSerial = req.authContext?.terminalSerialNumber
  if (!terminalSerial) return res.status(403).json({ success: false, code: 'TERMINAL_IDENTITY_REQUIRED' })
  const service = await import('../../services/tpv/no-instrument-resolution.service')
  try {
    const result = await service.resolveNoInstrument(
      { venueId: req.params.venueId, attemptId: req.params.attemptId, terminalSerial, actorStaffId: req.authContext?.userId ?? null },
      req.body,
    )
    return res.status(200).json({ success: true, ...result })
  } catch (error) {
    if (error instanceof service.NoInstrumentResolutionError) {
      if (error.statusCode === 403) {
        void logAction({ staffId: req.authContext?.userId ?? null, venueId: req.params.venueId, action: 'TERMINAL_PAYMENT_NO_INSTRUMENT_AUTH_DENIED',
          entity: 'TerminalPaymentAttemptLink', entityId: req.params.attemptId, data: { attemptId: req.params.attemptId, terminalSerial } })
      }
      return res.status(error.statusCode).json({ success: false, code: error.code, message: error.message })
    }
    // Nunca serializar un error de Prisma aquí: podría llevar el PIN.
    logger.error('No-instrument resolution unavailable', { venueId: req.params.venueId, attemptId: req.params.attemptId })
    return res.status(503).json({ success: false, code: 'RESOLUTION_UNAVAILABLE', message: 'No se pudo confirmar el cierre. Conserva el intento pendiente.' })
  }
}
```

Ruta (`tpv.routes.ts`, junto al GET de S6, con su bloque OpenAPI igual que el vecino):

```ts
router.post(
  '/venues/:venueId/terminal-payment/attempts/:attemptId/no-instrument-resolution',
  authenticateTokenMiddleware,
  validateVenueAccess,
  ...pinOverrideRateLimiter,
  terminalPaymentTpvController.resolveNoInstrument,
)
```

Permiso (`src/lib/permissions.ts`): añadir `'payments:resolve-no-instrument'` al catálogo (bloque `payments`) y a los roles OWNER, ADMIN y MANAGER (no a CASHIER/WAITER: quien confirma «no hubo tarjeta» libera una venta para recobrarla — es la misma clase de decisión que un reembolso). Regenerar el espejo del dashboard con `npm run permissions:deps` y confirmar `npm run audit:permissions` exit 0.

Schema + migración: en `prisma/schema.prisma`, modelo `TerminalPaymentAttemptLink`: `operatorResolution Json?`. Migración `20260916193000_no_instrument_resolution/migration.sql` = COPIA BYTE A BYTE de `/Users/amieva/.codex/worktrees/no-card-recovery-20260916/avoqado-server/prisma/migrations/20260916193000_no_instrument_resolution/migration.sql` (columna JSONB + función + trigger `preserve_no_instrument_resolution`; su tolerancia a `acknowledgedAt` se conserva aunque el `/ack` no se porte: es inocua y no se inventa una segunda versión del trigger). El permiso en `permissions.ts`: OWNER (L1263) y ADMIN (L1126) tienen listas EXPLÍCITAS, sin comodín (sólo SUPERADMIN trae `*:*`), así que `'payments:resolve-no-instrument'` se añade a las TRES listas — MANAGER (L957), ADMIN y OWNER — y al catálogo `INDIVIDUAL_PERMISSIONS_BY_RESOURCE.payments` (~L1877). 🔴 El worktree de Codex sólo lo puso en MANAGER: un OWNER habría recibido 403 en su propia terminal. Aplicar: `npx prisma migrate deploy` contra la base local (`av-db-25`, es aditiva) y contra la desechable (`DATABASE_URL="$TEST_DATABASE_URL" npx prisma migrate deploy`). `npm run schema:map`.

- [ ] **Step 4: API test con 403 reales** — `tests/api-tests/tpv/no-instrument-resolution.api.test.ts` calcando `tests/api-tests/tpv/` vecinos (Express real + `authenticateToken` + `validateVenueAccess`): (a) token de terminal con sesión OWNER → 200; (b) token de terminal con sesión CASHIER sin PIN → 403 `SUPERVISOR_AUTHORIZATION_REQUIRED`; (c) mismo con `supervisorPin` del OWNER → 200 `by: 'SUPERVISOR_PIN'`; (d) token de DASHBOARD y token MÓVIL/POS (sin `terminalSerialNumber`) → 403 `TERMINAL_IDENTITY_REQUIRED`; (e) token de otro venue → 403 de `validateVenueAccess`; (f) token de terminal cuyo `sub` ya no es miembro activo del venue + `supervisorPin` del OWNER → 403 `SESSION_NOT_IN_VENUE` (el PIN no rescata una sesión inválida).

Run: `set -a; source ~/.claude/jobs/b1e1a1b3/tmp/db-desechable.env; set +a; npx jest --selectProjects api tests/api-tests/tpv/no-instrument-resolution.api.test.ts --ci 2>&1 | tail -12` → PASS.

- [ ] **Step 5: Integración de punta a punta** (añadir a `terminalPaymentWindow.integration.test.ts`, un `describe('Declaración del cajero')`): (a) fila TIMED_OUT sin evidencia a los 10 s (dentro de la ventana) + link del intento + staffVenue OWNER → `resolveNoInstrument` → fila `FAILED/OPERATOR_RECONCILED_NO_CHARGE`, `getPaymentStatus` ⇒ `NOT_CHARGED / OPERATOR_RECONCILED / OPERATOR`, orden y ranura libres, `releaseUnprovenNegative` después ⇒ `NOT_ELIGIBLE` (no pisa la evidencia del operador); (b) **carrera declaración/aprobación**: tras (a), llega el Payment del intento por `closeRowFromPaymentTx` ⇒ la fila se reabre a `COMPLETED` con `reopened: true`/`alarmed: true` (el dinero manda sobre la palabra del cajero), `link.operatorResolution` se CONSERVA (trigger) y un segundo `resolveNoInstrument` con el mismo `resolutionId` devuelve el replay (200) sin escribir; (c) con un `ProviderEventLog` APROBADO del intento y sin Payment ⇒ 409 `POSITIVE_EVIDENCE_EXISTS` y la fila intacta.

- [ ] **Step 6: Commit**

```bash
cd avoqado-server && npm run schema:map && git add src/services/tpv/no-instrument-resolution.service.ts prisma/migrations/20260916193000_no_instrument_resolution tests/unit/services/tpv/no-instrument-resolution.service.test.ts tests/api-tests/tpv/no-instrument-resolution.api.test.ts && git commit -q -F - -- src/services/tpv/no-instrument-resolution.service.ts src/controllers/tpv/terminal-payment.tpv.controller.ts src/routes/tpv.routes.ts src/lib/permissions.ts prisma/schema.prisma prisma/migrations/20260916193000_no_instrument_resolution docs/SCHEMA_MAP.md tests/unit/services/tpv/no-instrument-resolution.service.test.ts tests/api-tests/tpv/no-instrument-resolution.api.test.ts tests/integration/payments/terminalPaymentWindow.integration.test.ts <<'MSG'
feat(cobro remoto): el cajero confirma «no se presentó tarjeta» en un paso — sin PIN para quien tiene el permiso, con PIN de elevación si no

Portado del worktree de Codex (no-card-recovery-20260916) sin la valla ni el reinicio: la fila queda FAILED/OPERATOR_RECONCILED_NO_CHARGE,
la declaración es inmutable (trigger) y la autoridad la valida el servidor con la identidad de la sesión, nunca con el cuerpo.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 5 (servidor): MCP, CHANGELOG, certificación, Codex acotado sobre el diff

**Files:**
- Modify: `src/mcp/tools/terminals.ts` (portar las 23 líneas de Codex: `terminal_payment_requests` devuelve `outcomeEvidence`, `evidenceClass`, `releasedAfterWindow`, `operatorResolution.by/staffId/acceptedAt`)
- Modify: `CHANGELOG.md` (`[Unreleased]`)

- [ ] **Step 1: MCP** — editar el tool y su prueba vecina (`tests/unit/mcp/…terminals…`) para que la proyección incluya los tres campos; `npx jest tests/unit/mcp -t terminal_payment --ci` → PASS.
- [ ] **Step 2: CHANGELOG** — entrada bajo `[Unreleased]`: «Ventana de confirmación de 30 s para negativos sin evidencia (`NO_EVIDENCE_AFTER_WINDOW`), aprobación tardía con alarma y correo, declaración del cajero sin PIN con permiso (`payments:resolve-no-instrument`)».
- [ ] **Step 3: Certificación pesada (avq-verify, desde el root)**

```bash
cd /Users/amieva/Documents/Programming/Avoqado
AVQ_KEEP=1 ./scripts/avq-verify.sh avoqado-server npx tsc -p tsconfig.typecheck.json
AVQ_KEEP=1 ./scripts/avq-verify.sh avoqado-server npx jest --selectProjects unit --testPathPattern "terminal-payment|no-instrument|mcp/tools/terminals" --ci
AVQ_KEEP=1 ./scripts/avq-verify.sh avoqado-server npm run lint
```
Expected en el CUERPO: `errores TS: 0` COINCIDEN; `Tests:` sin fallos; lint 0. Integración (aquí, base desechable): `npx jest --selectProjects integration --testPathPattern "terminalPayment|payments/" --ci` → todo verde.

- [ ] **Step 4: Sabotajes en copia aislada** (`$J/sab-server`, `git worktree` desechable sobre `develop` + `rsync` del diff): S1 quitar `NO_EVIDENCE_AFTER_WINDOW` de `CODIGOS_SIN_COBRO` → cae la cartesiana y «a los 30 s se libera»; S2 poner la ventana en 0 → cae «antes de los 30 s NO se libera»; S3 quitar el `findReconcilablePayment` de la liberación → cae «se concilia en vez de liberar»; S4 quitar `failureCode: null` del CAS → cae «AUTO_RELEASED no entra»; S5 aceptar `staffId` del body en la declaración → cae el caso 7; S6 quitar la negación explícita → cae el caso 5; S7 quitar el trigger de inmutabilidad → cae el caso 9 (409); S8 quitar `candadoDeIntento` de la liberación → cae «espera al candado del intento»; S9 devolver en el `catch` de closeRow sin escribir → cae «verificación que REVIENTA … UNKNOWN»; S10 quitar `VENTANA_RETIENE_LA_RANURA` de `BLOQUEO_HEREDADO` → cae la tabla JS↔SQL en régimen relajado; S11 quitar el `updatedAt` del CAS → cae «exige el updatedAt leído». Cada sabotaje: control verde antes, N caídas exactas, revertido.
- [ ] **Step 5: Codex acotado sobre el diff** — `git diff <base>..HEAD -- src tests prisma > $J/ventana-server.diff`; prompt: «revisa SÓLO este diff contra las cinco preguntas de la Task 0 y las Global Constraints; veredicto AUTORIZADO A COMMITEAR / NO AUTORIZADO con P1». Cada P1 → TDD → repetir Steps 3–4 sólo en lo afectado.
- [ ] **Step 6: Commit final del servidor** (MCP + CHANGELOG) y comprobar `git show --stat`. **No push** hasta el GO (aviso al founder).

---

### Task 6 (TPV): la libreta acepta la liberación del servidor y la reaplica al reconectar

**Files:**
- Modify: `app/src/main/java/com/jaac/avoqado_tpv/features/payment/data/ledger/PaymentAttemptEntity.kt` (constantes, companion ~L140)
- Modify: `…/ledger/PaymentAttemptDao.kt` (`cerrarPorLiberacionDelServidor` junto a `aplicarVeredictoDelServidor` L549; `candidatasDeConsultaAlServidor` L495 admite los dos outcomes nuevos; `guardarVeredictoDelServidor` L450 re-fecha `server_verdict_at` al sustituir una liberación)
- Modify: `…/ledger/VeredictoDeIntento.kt` (`LiberacionDelServidor` con `desdeConsultaS6`)
- Modify: `…/ledger/PaymentAttemptLedger.kt` (`aplicarLiberacionDelServidor`, `leerIntento`)
- Modify: `…/ledger/LedgerServerRecovery.kt` (`recover` y `recoverOne` aplican la liberación; `Resultado.liberadas`)
- Test: `app/src/test/java/com/jaac/avoqado_tpv/features/payment/data/ledger/VeredictoDelServidorRoomTest.kt`, `LedgerServerRecoveryRoomTest.kt`

**Interfaces:**
- Consumes: `PaymentAttemptDao.getById(attemptId)`, `findUnresolvedOrder(venueId, orderJsonFragment)`, `observeUnresolvedCount(venueId)`, `aplicarVeredictoDelServidor(v, now): ResultadoDelVeredicto` (campos `decision`, `transiciono`, `contradiccion`, `bandejaResueltaJson`); `TerminalAttemptStatusResponse.request: JsonObject?`; `LedgerServerRecovery.recoverOne(venueId, attemptId, now): String?` (devuelve el JSON de bandeja resuelta; NO cambia de firma).
- Produces:
  - `PaymentAttemptEntity.SERVER_RELEASED_NO_EVIDENCE = "RELEASED_NO_EVIDENCE"`, `SERVER_OPERATOR_NO_INSTRUMENT = "OPERATOR_NO_INSTRUMENT"`, `LAST_ERROR_LIBERADA_PREFIX = "liberada_por_el_servidor:"`.
  - `data class LiberacionDelServidor(val venueId: String, val attemptId: String, val evidencia: String)` (en `VeredictoDeIntento.kt`) con `companion fun desdeConsultaS6(venueId, attemptId, respuesta: TerminalAttemptStatusResponse): LiberacionDelServidor?` — algo sólo si `respuesta.request?.get("outcome")?.asString == "NOT_CHARGED"` y `outcomeEvidence ∈ {NO_EVIDENCE_AFTER_WINDOW, OPERATOR_RECONCILED}`; nunca si `respuesta.attempt?.outcome` es `RECORDED`/`SECOND_CAPTURE_EVIDENCE` (el dinero manda).
  - `PaymentAttemptDao.cerrarPorLiberacionDelServidor(attemptId, venueId, serverOutcome, motivo, now): Int` — `UPDATE payment_attempts SET state = 'DESCARTADA', last_error = :motivo, server_outcome = :serverOutcome, server_verdict_at = :now, updated_at = :now, state_version = state_version + 1 WHERE attempt_id = :attemptId AND venue_id = :venueId AND legacy_shadow = 0 AND processor = 'ANGELPAY' AND kind = 'SALE' AND state = 'INDETERMINADO' AND host_approved IS NOT 1 AND server_outcome IS NULL` (🔴 **no toca `host_approved`**: el host nunca contestó; un RECORDED tardío entra como contradicción «RECORDED sobre DESCARTADA» y el aviso lo grita).
  - `PaymentAttemptLedger.aplicarLiberacionDelServidor(l: LiberacionDelServidor, now: Long = System.currentTimeMillis()): Result<Boolean>` (true si transicionó) y `PaymentAttemptLedger.leerIntento(attemptId): PaymentAttemptEntity?` (= `runCatching { dao.getById(attemptId) }.getOrNull()`; la pantalla lee la fila, no adivina).
  - `LedgerServerRecovery.Resultado.liberadas: Int = 0`.
  - `candidatasDeConsultaAlServidor`: `server_outcome IS NULL OR server_outcome IN ('REFERENCE_COLLISION_EVIDENCE','PENDING_EVIDENCE','RELEASED_NO_EVIDENCE','OPERATOR_NO_INSTRUMENT')` — una fila liberada SIGUE consultándose por S6 (con el espaciado exponencial existente): si se perdió el S5, N3 descubre la aprobación tardía (Codex, Task 0, P5).
  - `guardarVeredictoDelServidor`: `server_verdict_at = CASE WHEN server_outcome IN ('RELEASED_NO_EVIDENCE','OPERATOR_NO_INSTRUMENT') THEN :now ELSE COALESCE(server_verdict_at, :now) END` — cuando el dinero sustituye a una liberación, el aviso F0 de contradicción cuenta sus 72 h desde la EVIDENCIA nueva, no desde la liberación (Codex, Task 0, P5).

- [ ] **Step 1: Pruebas Room en rojo** (`VeredictoDelServidorRoomTest.kt`, mismo arnés: `fila(...)`, `bandeja(...)`, `s6(...)`, `dao`, `ledger`, `now`, `venue`):

```kotlin
    private fun respuestaS6ConRequest(attemptId: String, requestJson: String, attemptOutcome: String? = null) =
        TerminalAttemptStatusResponse(
            success = true, attemptId = attemptId, requestId = "req-1",
            attempt = attemptOutcome?.let { TerminalAttemptResultDto(attemptId = attemptId, outcome = it, paymentId = "pay-1") },
            request = com.google.gson.JsonParser.parseString(requestJson).asJsonObject,
        )

    @Test fun `la liberacion del servidor cierra la fila INDETERMINADO como DESCARTADA sin tocar host_approved y destraba la venta`() = runTest {
        fila("a1", "INDETERMINADO", hostApproved = null)
        val n = dao.cerrarPorLiberacionDelServidor("a1", venue, PaymentAttemptEntity.SERVER_RELEASED_NO_EVIDENCE,
            PaymentAttemptEntity.LAST_ERROR_LIBERADA_PREFIX + "NO_EVIDENCE_AFTER_WINDOW", now)
        assertThat(n).isEqualTo(1)
        val tras = dao.getById("a1")!!
        assertThat(tras.state).isEqualTo(PaymentAttemptEntity.STATE_DESCARTADA)
        assertThat(tras.hostApproved).isNull()
        assertThat(tras.serverOutcome).isEqualTo("RELEASED_NO_EVIDENCE")
        assertThat(tras.serverVerdictAt).isEqualTo(now)
        assertThat(dao.findUnresolvedOrder(venue, "\"orderId\":\"o1\"")).isNull()
        assertThat(dao.observeUnresolvedCount(venue).first()).isEqualTo(0)
        assertThat(dao.cerrarPorLiberacionDelServidor("a1", venue, "RELEASED_NO_EVIDENCE", "liberada_por_el_servidor:NO_EVIDENCE_AFTER_WINDOW", now + 1)).isEqualTo(0) // idempotente
    }

    @Test fun `una fila con host_approved o con veredicto guardado NO se libera: el dinero manda`() = runTest {
        fila("a2", "INDETERMINADO", hostApproved = true)
        fila("a3", "INDETERMINADO", hostApproved = null); dao.aplicarVeredictoDelServidor(s6("a3", "RECORDED"), now)
        assertThat(dao.cerrarPorLiberacionDelServidor("a2", venue, "RELEASED_NO_EVIDENCE", "liberada_por_el_servidor:NO_EVIDENCE_AFTER_WINDOW", now)).isEqualTo(0)
        assertThat(dao.cerrarPorLiberacionDelServidor("a3", venue, "RELEASED_NO_EVIDENCE", "liberada_por_el_servidor:NO_EVIDENCE_AFTER_WINDOW", now)).isEqualTo(0)
    }

    @Test fun `una fila AUTORIZANDO (SDK dentro) o legacy o de otro venue NO se libera`() = runTest {
        fila("a4", "AUTORIZANDO", hostApproved = null)
        fila("a5", "INDETERMINADO", hostApproved = null, legacy = true)
        fila("a6", "INDETERMINADO", hostApproved = null, venueId = "otro-venue")
        for (id in listOf("a4", "a5")) assertThat(dao.cerrarPorLiberacionDelServidor(id, venue, "RELEASED_NO_EVIDENCE", "x", now)).isEqualTo(0)
        assertThat(dao.cerrarPorLiberacionDelServidor("a6", venue, "RELEASED_NO_EVIDENCE", "x", now)).isEqualTo(0)
    }

    @Test fun `un RECORDED que llega despues de la liberacion queda como contradiccion visible`() = runTest {
        fila("a7", "INDETERMINADO", hostApproved = null); bandeja()
        dao.cerrarPorLiberacionDelServidor("a7", venue, "RELEASED_NO_EVIDENCE", "liberada_por_el_servidor:NO_EVIDENCE_AFTER_WINDOW", now)
        val r = dao.aplicarVeredictoDelServidor(s6("a7", "RECORDED"), now + 1)
        assertThat(r.contradiccion).isTrue()
    }

    @Test fun `LiberacionDelServidor se lee del request de S6 y solo con las dos evidencias del servidor`() {
        val ventana = respuestaS6ConRequest("a8", """{"status":"FAILED","outcome":"NOT_CHARGED","outcomeEvidence":"NO_EVIDENCE_AFTER_WINDOW","evidenceClass":"SERVER"}""")
        assertThat(LiberacionDelServidor.desdeConsultaS6(venue, "a8", ventana)?.evidencia).isEqualTo("NO_EVIDENCE_AFTER_WINDOW")
        val cajero = respuestaS6ConRequest("a8", """{"status":"FAILED","outcome":"NOT_CHARGED","outcomeEvidence":"OPERATOR_RECONCILED","evidenceClass":"OPERATOR"}""")
        assertThat(LiberacionDelServidor.desdeConsultaS6(venue, "a8", cajero)?.evidencia).isEqualTo("OPERATOR_RECONCILED")
        val declinado = respuestaS6ConRequest("a8", """{"status":"FAILED","outcome":"NOT_CHARGED","outcomeEvidence":"PROCESSOR_DECLINED"}""")
        assertThat(LiberacionDelServidor.desdeConsultaS6(venue, "a8", declinado)).isNull() // eso ya lo decide la propia terminal
        val sinDesenlace = respuestaS6ConRequest("a8", """{"status":"TIMED_OUT","outcome":"UNRESOLVED"}""")
        assertThat(LiberacionDelServidor.desdeConsultaS6(venue, "a8", sinDesenlace)).isNull()
        val conDinero = respuestaS6ConRequest("a8", """{"status":"FAILED","outcome":"NOT_CHARGED","outcomeEvidence":"NO_EVIDENCE_AFTER_WINDOW"}""", attemptOutcome = "RECORDED")
        assertThat(LiberacionDelServidor.desdeConsultaS6(venue, "a8", conDinero)).isNull() // contradicción: gana el intento con dinero
        assertThat(LiberacionDelServidor.desdeConsultaS6(venue, "a8", TerminalAttemptStatusResponse(success = true, request = null))).isNull()
    }
```

Y en `LedgerServerRecoveryRoomTest.kt` (mismo arnés que sus pruebas de N3, con `api` mockeada):

```kotlin
    @Test fun `una fila INDETERMINADO cuya S6 dice NOT_CHARGED por ventana se cierra en la pasada N3 y cuenta como liberada`() = runTest {
        fila("b1", "INDETERMINADO", hostApproved = null)   // creada hace ≥ 120 s: candidata de consulta
        coEvery { api.getAttemptStatus(venue, "b1") } returns Response.success(
            TerminalAttemptStatusResponse(success = true, attemptId = "b1", requestId = "req-1",
                attempt = TerminalAttemptResultDto(attemptId = "b1", outcome = "NOT_RECORDED"),
                request = com.google.gson.JsonParser.parseString("""{"status":"FAILED","outcome":"NOT_CHARGED","outcomeEvidence":"NO_EVIDENCE_AFTER_WINDOW"}""").asJsonObject),
        )
        val r = recovery.recover(venue, now)
        assertThat(r.liberadas).isEqualTo(1)
        assertThat(dao.getById("b1")!!.state).isEqualTo("DESCARTADA")
        assertThat(dao.getById("b1")!!.lastError).isEqualTo("liberada_por_el_servidor:NO_EVIDENCE_AFTER_WINDOW")
    }

    @Test fun `una fila liberada sigue siendo candidata de consulta S6: si el servidor dice RECORDED despues, queda contradiccion fechada desde el dinero`() = runTest {
        fila("b3", "INDETERMINADO", hostApproved = null)
        dao.cerrarPorLiberacionDelServidor("b3", venue, "RELEASED_NO_EVIDENCE", "liberada_por_el_servidor:NO_EVIDENCE_AFTER_WINDOW", now)
        assertThat(dao.candidatasDeConsultaAlServidor(venue, now - 120_000, now + 1, 600_000, 86_400_000).map { it.attemptId }).contains("b3")
        coEvery { api.getAttemptStatus(venue, "b3") } returns Response.success(
            TerminalAttemptStatusResponse(success = true, attemptId = "b3", requestId = "req-1",
                attempt = TerminalAttemptResultDto(attemptId = "b3", outcome = "RECORDED", paymentId = "pay-3", paymentStatus = "COMPLETED", recordedVia = "webhook", amountCents = 10000, tipCents = 500, isWinner = true, winnerPaymentId = "pay-3")),
        )
        recovery.recover(venue, now + 5_000)
        val tras = dao.getById("b3")!!
        assertThat(tras.state).isEqualTo("DESCARTADA")             // la liberación local no se «des-hace»: queda como contradicción
        assertThat(tras.serverOutcome).isEqualTo("RECORDED")
        assertThat(tras.serverVerdictAt).isEqualTo(now + 5_000)      // fechada desde el DINERO, no desde la liberación
        assertThat(dao.esContradiccion("b3")).isTrue()
    }

    @Test fun `recoverOne aplica la liberacion y la fila queda legible para la pantalla`() = runTest {
        fila("b2", "INDETERMINADO", hostApproved = null)
        coEvery { api.getAttemptStatus(venue, "b2") } returns Response.success(
            TerminalAttemptStatusResponse(success = true, attemptId = "b2", requestId = "req-1",
                attempt = TerminalAttemptResultDto(attemptId = "b2", outcome = "NOT_RECORDED"),
                request = com.google.gson.JsonParser.parseString("""{"status":"FAILED","outcome":"NOT_CHARGED","outcomeEvidence":"OPERATOR_RECONCILED"}""").asJsonObject),
        )
        assertThat(recovery.recoverOne(venue, "b2", now)).isNull()   // no hay bandeja resuelta que emitir
        assertThat(ledger.leerIntento("b2")!!.serverOutcome).isEqualTo("OPERATOR_NO_INSTRUMENT")
    }
```

- [ ] **Step 2: Verlas fallar** (compilación en rojo por el símbolo nuevo). Run (avq-verify, dos clases):

```bash
cd /Users/amieva/Documents/Programming/Avoqado
AVQ_KEEP=1 ./scripts/avq-verify.sh avoqado-tpv ./gradlew :app:testSandboxDebugUnitTest --max-workers=1 -Pkotlin.daemon.jvmargs=-Xmx4g --tests "*VeredictoDelServidorRoomTest" --tests "*LedgerServerRecoveryRoomTest"
```
Expected: compile error `Unresolved reference: cerrarPorLiberacionDelServidor` / `LiberacionDelServidor`.

- [ ] **Step 3: Implementar**

Entidad (companion, junto a `SERVER_PENDING_EVIDENCE`):

```kotlin
        /** El SERVIDOR liberó la solicitud (ventana de 30 s sin evidencia). La fila queda DESCARTADA con `last_error` = prefijo + evidencia. */
        const val SERVER_RELEASED_NO_EVIDENCE = "RELEASED_NO_EVIDENCE"
        /** El cajero declaró «no se presentó tarjeta» y el servidor lo acreditó (OPERATOR_RECONCILED). */
        const val SERVER_OPERATOR_NO_INSTRUMENT = "OPERATOR_NO_INSTRUMENT"
        const val LAST_ERROR_LIBERADA_PREFIX = "liberada_por_el_servidor:"
```

DAO (junto a `aplicarVeredictoDelServidor`):

```kotlin
    /**
     * Liberación del SERVIDOR (ventana de confirmación / declaración del cajero): sólo una fila INDETERMINADO sin veredicto y sin
     * `host_approved` — el host nunca contestó — pasa a DESCARTADA. NO toca `host_approved`: un RECORDED posterior entra por
     * `aplicarVeredictoDelServidor` como contradicción («RECORDED sobre DESCARTADA») y el aviso lo grita.
     */
    @Query(
        """UPDATE payment_attempts SET state = 'DESCARTADA', last_error = :motivo, server_outcome = :serverOutcome,
           server_verdict_at = :now, updated_at = :now, state_version = state_version + 1
           WHERE attempt_id = :attemptId AND venue_id = :venueId AND legacy_shadow = 0 AND processor = 'ANGELPAY' AND kind = 'SALE'
             AND state = 'INDETERMINADO' AND host_approved IS NOT 1 AND server_outcome IS NULL""",
    )
    suspend fun cerrarPorLiberacionDelServidor(attemptId: String, venueId: String, serverOutcome: String, motivo: String, now: Long): Int
```

`VeredictoDeIntento.kt` (al final del archivo):

```kotlin
/** La SOLICITUD (no el intento) quedó NOT_CHARGED por evidencia del SERVIDOR: ventana vencida o declaración del cajero. */
data class LiberacionDelServidor(val venueId: String, val attemptId: String, val evidencia: String) {
    companion object {
        val EVIDENCIAS = setOf("NO_EVIDENCE_AFTER_WINDOW", "OPERATOR_RECONCILED")
        fun desdeConsultaS6(venueId: String, attemptId: String, respuesta: TerminalAttemptStatusResponse): LiberacionDelServidor? {
            val intento = respuesta.attempt?.outcome
            if (intento == "RECORDED" || intento == "SECOND_CAPTURE_EVIDENCE") return null // el dinero manda
            val request = respuesta.request ?: return null
            val outcome = runCatching { request.get("outcome")?.asString }.getOrNull()
            val evidencia = runCatching { request.get("outcomeEvidence")?.asString }.getOrNull()
            if (outcome != "NOT_CHARGED" || evidencia !in EVIDENCIAS) return null
            return LiberacionDelServidor(venueId, attemptId, evidencia!!)
        }
    }
}
```

`PaymentAttemptLedger.kt`:

```kotlin
    suspend fun aplicarLiberacionDelServidor(l: LiberacionDelServidor, now: Long = System.currentTimeMillis()): Result<Boolean> = runCatching {
        val outcome = if (l.evidencia == "OPERATOR_RECONCILED") PaymentAttemptEntity.SERVER_OPERATOR_NO_INSTRUMENT else PaymentAttemptEntity.SERVER_RELEASED_NO_EVIDENCE
        val n = dao.cerrarPorLiberacionDelServidor(l.attemptId, l.venueId, outcome, PaymentAttemptEntity.LAST_ERROR_LIBERADA_PREFIX + l.evidencia, now)
        if (n == 1) Timber.w("📒 [Ledger] %s liberada por el servidor (%s): la venta queda destrabada", l.attemptId, l.evidencia)
        n == 1
    }

    /** La fila tal cual está: la pantalla decide leyendo, nunca adivinando. Nunca lanza. */
    suspend fun leerIntento(attemptId: String): PaymentAttemptEntity? = runCatching { dao.getById(attemptId) }.getOrNull()
```

`LedgerServerRecovery.kt`: `Resultado` gana `val liberadas: Int = 0`; en `recover`, donde hoy `veredicto == null` ⇒ `dao.estamparConsultaAlServidor(...)`, ANTES de estampar:

```kotlin
                    val liberacion = if (respuesta.isSuccessful) respuesta.body()?.let { LiberacionDelServidor.desdeConsultaS6(venueId, fila.attemptId, it) } else null
                    if (liberacion != null && ledger.aplicarLiberacionDelServidor(liberacion, now).getOrDefault(false)) { liberadas++; continue }
```

y en `recoverOne`, en la rama `veredicto == null`:

```kotlin
                val liberacion = respuesta.body()?.let { LiberacionDelServidor.desdeConsultaS6(venueId, attemptId, it) }
                if (liberacion == null || !ledger.aplicarLiberacionDelServidor(liberacion, now).getOrDefault(false)) dao.estamparConsultaAlServidor(attemptId, now)
                null
```

DAO, dos `@Query` existentes cambian UNA línea cada una: en `candidatasDeConsultaAlServidor` (L495) el filtro `AND (server_outcome IS NULL OR server_outcome IN ('REFERENCE_COLLISION_EVIDENCE','PENDING_EVIDENCE'))` gana `'RELEASED_NO_EVIDENCE','OPERATOR_NO_INSTRUMENT'`; en `guardarVeredictoDelServidor` (L450) `server_verdict_at = COALESCE(server_verdict_at, :now)` pasa a `server_verdict_at = CASE WHEN server_outcome IN ('RELEASED_NO_EVIDENCE','OPERATOR_NO_INSTRUMENT') THEN :now ELSE COALESCE(server_verdict_at, :now) END`. 🔴 `veredictosPendientesDeAplicar` NO cambia: una liberación no es una aprobación que promover a REGISTRADO, y un RECORDED posterior sobre DESCARTADA queda como contradicción (`SQL_CONTRADICCION`: `server_outcome = 'RECORDED' AND state = 'DESCARTADA'`), fuera de la poda y dentro del aviso F0.

- [ ] **Step 4: Verlas pasar** — mismo comando del Step 2 → `Tests:` sin fallos en las dos clases.

- [ ] **Step 5: Commit (TPV, sin Co-Authored-By)**

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-tpv && L=app/src/main/java/com/jaac/avoqado_tpv/features/payment/data/ledger && T=app/src/test/java/com/jaac/avoqado_tpv/features/payment/data/ledger && git commit -q -F - -- $L/PaymentAttemptEntity.kt $L/PaymentAttemptDao.kt $L/VeredictoDeIntento.kt $L/PaymentAttemptLedger.kt $L/LedgerServerRecovery.kt $T/VeredictoDelServidorRoomTest.kt $T/LedgerServerRecoveryRoomTest.kt <<'MSG'
feat(libreta): la liberación del servidor (ventana / declaración del cajero) cierra la fila INDETERMINADO como DESCARTADA y destraba la venta; un RECORDED tardío queda como contradicción
MSG
git show --stat HEAD | head -12
```

---

### Task 7 (TPV): la pantalla espera al servidor, ofrece «El cliente no presentó tarjeta» y nunca ofrece Reintentar

**Files:**
- Modify: `…/ledger/TerminalAttemptApiService.kt` (`resolveNoInstrument` POST + `NoInstrumentResolutionRequest`)
- Modify: `…/presentation/angelpay/AngelPayPaymentState.kt` (`ResultadoIncierto`)
- Modify: `…/presentation/angelpay/AngelPayPaymentViewModel.kt` (constructor + `quedarSinVerificar` → `esperarVeredictoDelServidor`, `declararSinTarjeta(pin)`, `consultarDeNuevo()`, `mostrarLiberada`, `mostrarCobroConfirmadoPorS6`)
- Modify: `…/presentation/angelpay/AngelPayPaymentScreen.kt` (`ResultadoInciertoContent`)
- Test: `app/src/test/java/com/jaac/avoqado_tpv/features/payment/presentation/angelpay/AngelPayPaymentViewModelTest.kt` (`createViewModel` gana `ledgerServerRecovery` y `attemptApi`)

**Interfaces:**
- Consumes: `LedgerServerRecovery.recoverOne(venueId, attemptId, now): String?` (Task 6: aplica RECORDED o liberación), `PaymentAttemptLedger.leerIntento(attemptId)` y `aplicarLiberacionDelServidor(...)` (Task 6), `emitSocketResultIfSocketSourced(status = "timeout", errorMessage = …)` (se sigue emitiendo AL INSTANTE, como hoy: el reloj es del servidor), `authRepository.getVenueId()`, `currentPaymentAttemptId`, `_socketRequestId`, `pendingAmount`/`pendingTip`/`pendingOrderId`/`pendingOrderNumber`, `clearChargingOnTerminal()`, `cancelarCierrePorAbandono()`, `resetPayment()`, la construcción de `Success` de `manejarConfirmacionDelServidor` (L2960–2980).
- Produces:
  - `AngelPayPaymentState.ResultadoIncierto(message: String, verificando: Boolean, esperandoAlServidor: Boolean = false, segundos: Int = 0, puedeDeclarar: Boolean = false, pidePin: Boolean = false, error: String? = null)` — campos nuevos con default: ningún constructor existente cambia.
  - `TerminalAttemptApiService.resolveNoInstrument(venueId, attemptId, body: NoInstrumentResolutionRequest): Response<TerminalAttemptStatusResponse>` + `data class NoInstrumentResolutionRequest(requestId, resolutionId, statement = "NO_INSTRUMENT_PRESENTED", statementVersion = 1, supervisorPin: String? = null)`.
  - VM: `fun declararSinTarjeta(pin: String? = null)` (single-flight por `declaracionJob`; veto de dinero por intento `vetoDeDineroDelIntento` encendido ANTES de suspender para guardar una evidencia de dinero, respetado por `aplicarLoQueDigaLaLibreta`, `mostrarLiberada` y el propio `declararSinTarjeta`), `fun consultarDeNuevo()`; constantes `MS_ESPERA_AL_SERVIDOR = 45_000L`, `MS_ENTRE_CONSULTAS_S6 = 5_000L`, `MS_MOSTRAR_LIBERADA = 4_000L` (`@VisibleForTesting internal var` como `msAbandonoAvisoEmv`, para que las pruebas los bajen).
  - Comportamiento: al entrar en INCIERTO sin hallazgo del historial → emitir `timeout` al POS (igual que hoy) → `ResultadoIncierto(esperandoAlServidor = true, puedeDeclarar = true)` → cada 5 s `recoverOne` + `leerIntento`, y la fila se lee con **el dinero primero** (Codex, Task 0, P5): (1) `state == REGISTRADO` ⇒ `Success` (misma forma que S5, `serverRecordedVia = "s6"`, `paymentId = fila.serverPaymentId`); (2) `serverOutcome == RECORDED` con otro estado (contradicción: el servidor tiene el dinero y la libreta no pudo promover) ⇒ `Error(message = "Avoqado registró dinero de este cobro. NO lo vuelvas a cobrar: Avoqado lo concilia.", canRetry = false)` sin reset automático; (3) `serverOutcome ∈ {RELEASED_NO_EVIDENCE, OPERATOR_NO_INSTRUMENT}` (NO por el prefijo de `lastError`, que sobrevive a la contradicción) ⇒ `Error(message = …, canRetry = false)` y a los 4 s `resetPayment()`; (4) nada ⇒ sigue esperando; a los 45 s sin nada ⇒ `ResultadoIncierto(esperandoAlServidor = false)` con «Consultar de nuevo» (servidor caído: el watchdog liberará y N3 lo aplicará al reconectar). `declararSinTarjeta(pin)` → POST; `403 SUPERVISOR_AUTHORIZATION_REQUIRED` ⇒ `pidePin = true`; `403 SESSION_NOT_IN_VENUE` ⇒ `error` y NO pide PIN; `2xx` ⇒ `aplicarLiberacionDelServidor(OPERATOR_RECONCILED)` y **después** `aplicarLoQueDigaLaLibreta` (si el CAS local no transicionó porque ya había RECORDED, gana el dinero; nunca se muestra «liberada» incondicionalmente tras el POST); si el cuerpo del 2xx trae evidencia de dinero (`VeredictoDeIntento.desdeConsultaS6(venueId, attemptId, body)` ≠ null) la liberación NI SE INTENTA: se guarda el veredicto con `aplicarVeredictoDelServidor` (sin red) y sólo `Result.success` + fila `REGISTRADO` enseña `Success`; cualquier otra cosa (guardado fallido, fila sin promover, liberación vieja) ⇒ `mostrarContradiccion()` («evidencia de cobro… NO lo vuelvas a cobrar»); sin evidencia en el cuerpo, la liberación local y luego la fila decide, y si no se puede leer NUNCA «liberada»: `error` + `consultarDeNuevo()`; `409`/otro ⇒ `error` con el `code` y `consultarDeNuevo()`; sin respuesta ⇒ `error = "Sin conexión. Se sigue esperando al servidor."`.

- [ ] **Step 1: Pruebas del ViewModel en rojo** (mockk, `runTest(testDispatcher)`, helpers reales `vmConCobroDelPos(requestId)`, `sdkInciertoResult()`, `vm.onAngelPaySdkResult(...)`; `chargeVerifier.verificar` tiene CINCO parámetros; añadir a la clase `private val ledgerServerRecovery: LedgerServerRecovery = mockk(relaxed = true)` y `private val attemptApi: TerminalAttemptApiService = mockk()` y pasarlos en `createViewModel`):

```kotlin
    private fun filaLiberada(attemptId: String, evidencia: String) = mockk<PaymentAttemptEntity>(relaxed = true).also {
        every { it.attemptId } returns attemptId
        every { it.state } returns PaymentAttemptEntity.STATE_DESCARTADA
        every { it.lastError } returns PaymentAttemptEntity.LAST_ERROR_LIBERADA_PREFIX + evidencia
        every { it.serverOutcome } returns if (evidencia == "OPERATOR_RECONCILED") PaymentAttemptEntity.SERVER_OPERATOR_NO_INSTRUMENT else PaymentAttemptEntity.SERVER_RELEASED_NO_EVIDENCE
        every { it.serverPaymentId } returns null
    }
    private fun filaRegistrada(attemptId: String) = mockk<PaymentAttemptEntity>(relaxed = true).also {
        every { it.attemptId } returns attemptId
        every { it.state } returns PaymentAttemptEntity.STATE_REGISTRADO
        every { it.serverOutcome } returns PaymentAttemptEntity.SERVER_RECORDED
        every { it.serverPaymentId } returns "pay-s6"
    }
    /** Contradicción: el servidor registró dinero, pero la libreta ya estaba DESCARTADA (liberada) y no pudo promover. */
    private fun filaContradictoria(attemptId: String) = mockk<PaymentAttemptEntity>(relaxed = true).also {
        every { it.attemptId } returns attemptId
        every { it.state } returns PaymentAttemptEntity.STATE_DESCARTADA
        every { it.lastError } returns PaymentAttemptEntity.LAST_ERROR_LIBERADA_PREFIX + "NO_EVIDENCE_AFTER_WINDOW"
        every { it.serverOutcome } returns PaymentAttemptEntity.SERVER_RECORDED
        every { it.serverPaymentId } returns "pay-tardio"
    }
    private fun respuestaDeclaracionOk() = Response.success(TerminalAttemptStatusResponse(success = true))
    private fun respuesta403() = Response.error<TerminalAttemptStatusResponse>(403, """{"success":false,"code":"SUPERVISOR_AUTHORIZATION_REQUIRED"}""".toResponseBody("application/json".toMediaType()))
    private fun respuesta409() = Response.error<TerminalAttemptStatusResponse>(409, """{"success":false,"code":"POSITIVE_EVIDENCE_EXISTS"}""".toResponseBody("application/json".toMediaType()))

    @Test fun `INCIERTO sin hallazgo en historial emite timeout al POS y se queda esperando al servidor con el boton de declarar`() = runTest(testDispatcher) {
        coEvery { chargeVerifier.verificar(any(), any(), any(), any(), any()) } returns VerificacionDelCobro.NoSePudoVerificar("historial vacío")
        coEvery { ledgerServerRecovery.recoverOne(any(), any(), any()) } returns null
        coEvery { paymentAttemptLedger.leerIntento(any()) } returns null
        val vm = vmConCobroDelPos("REQ-W1")
        try {
            vm.onAngelPaySdkResult(sdkInciertoResult()); runCurrent()
            verify(exactly = 1) { socketManager.emitTerminalPaymentResult("REQ-W1", "timeout", any(), any(), any(), any(), any(), any(), outcomeEvidence = any()) }
            val s = vm.state.value as AngelPayPaymentState.ResultadoIncierto
            assertThat(s.esperandoAlServidor).isTrue(); assertThat(s.puedeDeclarar).isTrue()
            assertThat(paymentStateHolder.isChargeAttemptActive()).isTrue()   // ESTA pantalla sigue ocupada mientras espera
        } finally { vm.viewModelScope.cancel() }
    }

    @Test fun `si S6 trae la liberacion por ventana, la pantalla dice que se puede volver a cobrar, sin Reintentar, y vuelve a Idle`() = runTest(testDispatcher) {
        coEvery { chargeVerifier.verificar(any(), any(), any(), any(), any()) } returns VerificacionDelCobro.NoSePudoVerificar("x")
        coEvery { ledgerServerRecovery.recoverOne(any(), any(), any()) } returns null
        coEvery { paymentAttemptLedger.leerIntento(any()) } returns filaLiberada("att", "NO_EVIDENCE_AFTER_WINDOW")
        val vm = vmConCobroDelPos("REQ-W2")
        try {
            vm.onAngelPaySdkResult(sdkInciertoResult()); runCurrent()
            advanceTimeBy(vm.msEntreConsultasS6 + 100); runCurrent()
            val s = vm.state.value as AngelPayPaymentState.Error
            assertThat(s.canRetry).isFalse(); assertThat(s.message).contains("volver a cobrar")
            advanceTimeBy(vm.msMostrarLiberada + 100); runCurrent()
            assertThat(vm.state.value).isEqualTo(AngelPayPaymentState.Idle)
            verify(exactly = 0) { socketManager.emitTerminalPaymentResult(any(), "failed", any(), any(), any(), any(), any(), any(), outcomeEvidence = any()) }
        } finally { vm.viewModelScope.cancel() }
    }

    @Test fun `si S6 trae RECORDED durante la espera, gana el dinero: Success con el paymentId de la libreta`() = runTest(testDispatcher) {
        coEvery { chargeVerifier.verificar(any(), any(), any(), any(), any()) } returns VerificacionDelCobro.NoSePudoVerificar("x")
        coEvery { ledgerServerRecovery.recoverOne(any(), any(), any()) } returns null
        coEvery { paymentAttemptLedger.leerIntento(any()) } returns filaRegistrada("att")
        val vm = vmConCobroDelPos("REQ-W3")
        try {
            vm.onAngelPaySdkResult(sdkInciertoResult()); runCurrent()
            advanceTimeBy(vm.msEntreConsultasS6 + 100); runCurrent()
            val s = vm.state.value as AngelPayPaymentState.Success
            assertThat(s.receipt?.paymentId).isEqualTo("pay-s6"); assertThat(s.receipt?.serverRecordedVia).isEqualTo("s6")
        } finally { vm.viewModelScope.cancel() }
    }

    @Test fun `una fila DESCARTADA con RECORDED encima es contradiccion: la pantalla dice que Avoqado registro dinero y NUNCA que se puede volver a cobrar`() = runTest(testDispatcher) {
        coEvery { chargeVerifier.verificar(any(), any(), any(), any(), any()) } returns VerificacionDelCobro.NoSePudoVerificar("x")
        coEvery { ledgerServerRecovery.recoverOne(any(), any(), any()) } returns null
        coEvery { paymentAttemptLedger.leerIntento(any()) } returns filaContradictoria("att")
        val vm = vmConCobroDelPos("REQ-W8")
        try {
            vm.onAngelPaySdkResult(sdkInciertoResult()); runCurrent()
            advanceTimeBy(vm.msEntreConsultasS6 + 100); runCurrent()
            val s = vm.state.value as AngelPayPaymentState.Error
            assertThat(s.canRetry).isFalse(); assertThat(s.message).contains("evidencia de cobro"); assertThat(s.message).doesNotContain("volver a cobrar")
            advanceTimeBy(vm.msMostrarLiberada + 100); runCurrent()
            assertThat(vm.state.value).isInstanceOf(AngelPayPaymentState.Error::class.java)   // sin reset automático: el cajero sale con Salir
        } finally { vm.viewModelScope.cancel() }
    }

    @Test fun `un 2xx cuyo cuerpo trae RECORDED aplica el veredicto del CUERPO (sin otro viaje de red) y termina en Success aunque S6 falle`() = runTest(testDispatcher) {
        coEvery { chargeVerifier.verificar(any(), any(), any(), any(), any()) } returns VerificacionDelCobro.NoSePudoVerificar("x")
        coEvery { ledgerServerRecovery.recoverOne(any(), any(), any()) } returns null   // S6 «sin red»
        val cuerpo = TerminalAttemptStatusResponse(success = true, attemptId = "att", requestId = "REQ-W10",
            attempt = TerminalAttemptResultDto(attemptId = "att", outcome = "RECORDED", paymentId = "pay-body", paymentStatus = "COMPLETED", recordedVia = "webhook", amountCents = 10000, tipCents = 0, isWinner = true, winnerPaymentId = "pay-body"))
        coEvery { attemptApi.resolveNoInstrument(any(), any(), any()) } returns Response.success(cuerpo)
        coEvery { paymentAttemptLedger.aplicarVeredictoDelServidor(any()) } returns Result.success(mockk(relaxed = true))
        coEvery { paymentAttemptLedger.leerIntento(any()) } returns null andThen filaRegistrada("att")   // null durante la espera; REGISTRADO tras guardar el cuerpo
        val vm = vmConCobroDelPos("REQ-W10")
        try {
            vm.onAngelPaySdkResult(sdkInciertoResult()); runCurrent()
            vm.declararSinTarjeta(); runCurrent()
            coVerify(exactly = 1) { paymentAttemptLedger.aplicarVeredictoDelServidor(match { it.attemptId == "att" && it.outcome.name == "RECORDED" }) }
            coVerify(exactly = 0) { paymentAttemptLedger.aplicarLiberacionDelServidor(any(), any()) }   // con dinero en el cuerpo la liberación NI SE INTENTA
            assertThat(vm.state.value).isInstanceOf(AngelPayPaymentState.Success::class.java)
            verify(exactly = 0) { socketManager.emitTerminalPaymentResult(any(), "failed", any(), any(), any(), any(), any(), any(), outcomeEvidence = any()) }
        } finally { vm.viewModelScope.cancel() }
    }

    @Test fun `un 2xx con RECORDED cuyo guardado FALLA prohibe recobrar aunque la fila conserve una liberacion vieja`() = runTest(testDispatcher) {
        coEvery { chargeVerifier.verificar(any(), any(), any(), any(), any()) } returns VerificacionDelCobro.NoSePudoVerificar("x")
        coEvery { ledgerServerRecovery.recoverOne(any(), any(), any()) } returns null
        val cuerpo = TerminalAttemptStatusResponse(success = true, attemptId = "att", requestId = "REQ-W12",
            attempt = TerminalAttemptResultDto(attemptId = "att", outcome = "RECORDED", paymentId = "pay-body", paymentStatus = "COMPLETED", recordedVia = "webhook", amountCents = 10000, tipCents = 0, isWinner = true, winnerPaymentId = "pay-body"))
        coEvery { attemptApi.resolveNoInstrument(any(), any(), any()) } returns Response.success(cuerpo)
        coEvery { paymentAttemptLedger.aplicarVeredictoDelServidor(any()) } returns Result.failure(IllegalStateException("room caída"))
        coEvery { paymentAttemptLedger.leerIntento(any()) } returns null andThen filaLiberada("att", "NO_EVIDENCE_AFTER_WINDOW") // liberación VIEJA en la fila
        val vm = vmConCobroDelPos("REQ-W12")
        try {
            vm.onAngelPaySdkResult(sdkInciertoResult()); runCurrent()
            vm.declararSinTarjeta(); runCurrent()
            coVerify(exactly = 0) { paymentAttemptLedger.aplicarLiberacionDelServidor(any(), any()) }   // con dinero en el cuerpo la liberación NI SE INTENTA
            val s = vm.state.value as AngelPayPaymentState.Error
            assertThat(s.canRetry).isFalse(); assertThat(s.message).contains("evidencia de cobro"); assertThat(s.message).doesNotContain("volver a cobrar")
            advanceTimeBy(vm.msMostrarLiberada + 100); runCurrent()
            assertThat(vm.state.value).isInstanceOf(AngelPayPaymentState.Error::class.java)   // sin reset automático
        } finally { vm.viewModelScope.cancel() }
    }

    @Test fun `un 2xx con RECORDED guardado pero con la fila sin promover (GUARDADO_SIN_LIBERAR) prohibe recobrar`() = runTest(testDispatcher) {
        coEvery { chargeVerifier.verificar(any(), any(), any(), any(), any()) } returns VerificacionDelCobro.NoSePudoVerificar("x")
        coEvery { ledgerServerRecovery.recoverOne(any(), any(), any()) } returns null
        val cuerpo = TerminalAttemptStatusResponse(success = true, attemptId = "att", requestId = "REQ-W13",
            attempt = TerminalAttemptResultDto(attemptId = "att", outcome = "SECOND_CAPTURE_EVIDENCE", paymentId = "pay-2", paymentStatus = "COMPLETED", recordedVia = "webhook", amountCents = 10000, tipCents = 0, isWinner = false, winnerPaymentId = "pay-1"))
        coEvery { attemptApi.resolveNoInstrument(any(), any(), any()) } returns Response.success(cuerpo)
        coEvery { paymentAttemptLedger.aplicarVeredictoDelServidor(any()) } returns Result.success(mockk(relaxed = true))
        coEvery { paymentAttemptLedger.leerIntento(any()) } returns null andThen filaContradictoria("att")
        val vm = vmConCobroDelPos("REQ-W13")
        try {
            vm.onAngelPaySdkResult(sdkInciertoResult()); runCurrent()
            vm.declararSinTarjeta(); runCurrent()
            coVerify(exactly = 0) { paymentAttemptLedger.aplicarLiberacionDelServidor(any(), any()) }
            assertThat((vm.state.value as AngelPayPaymentState.Error).message).contains("evidencia de cobro")
        } finally { vm.viewModelScope.cancel() }
    }

    @Test fun `dos toques abren UN solo POST; con el guardado del dinero SUSPENDIDO el sondeo lee una liberacion vieja y NO la anuncia (el veto se enciende antes de suspender)`() = runTest(testDispatcher) {
        coEvery { chargeVerifier.verificar(any(), any(), any(), any(), any()) } returns VerificacionDelCobro.NoSePudoVerificar("x")
        coEvery { ledgerServerRecovery.recoverOne(any(), any(), any()) } returns null
        val puertaPost = kotlinx.coroutines.CompletableDeferred<Unit>()
        val puertaGuardado = kotlinx.coroutines.CompletableDeferred<Unit>()
        val cuerpoConDinero = TerminalAttemptStatusResponse(success = true, attemptId = "att", requestId = "REQ-W14",
            attempt = TerminalAttemptResultDto(attemptId = "att", outcome = "RECORDED", paymentId = "pay-body", paymentStatus = "COMPLETED", recordedVia = "webhook", amountCents = 10000, tipCents = 0, isWinner = true, winnerPaymentId = "pay-body"))
        coEvery { attemptApi.resolveNoInstrument(any(), any(), any()) } coAnswers { puertaPost.await(); Response.success(cuerpoConDinero) }
        // El guardado del dinero se queda SUSPENDIDO hasta que la prueba lo suelta, y al final FALLA.
        coEvery { paymentAttemptLedger.aplicarVeredictoDelServidor(any()) } coAnswers { puertaGuardado.await(); Result.failure(IllegalStateException("room caída")) }
        coEvery { paymentAttemptLedger.leerIntento(any()) } returns filaLiberada("att", "NO_EVIDENCE_AFTER_WINDOW")   // liberación VIEJA en la fila
        val vm = vmConCobroDelPos("REQ-W14")
        try {
            vm.onAngelPaySdkResult(sdkInciertoResult()); runCurrent()
            vm.declararSinTarjeta(); runCurrent()
            vm.declararSinTarjeta(); runCurrent()   // doble toque
            coVerify(exactly = 1) { attemptApi.resolveNoInstrument(any(), any(), any()) }
            puertaPost.complete(Unit); runCurrent()   // el POST contestó CON dinero: el veto ya está encendido, el guardado sigue suspendido
            advanceTimeBy(vm.msEntreConsultasS6 + 100); runCurrent()   // el sondeo lee la liberación vieja mientras el guardado está suspendido
            assertThat(vm.state.value).isNotInstanceOf(AngelPayPaymentState.Idle::class.java)
            assertThat((vm.state.value as? AngelPayPaymentState.Error)?.message ?: "").doesNotContain("volver a cobrar")
            puertaGuardado.complete(Unit); runCurrent()   // el guardado FALLA
            val s = vm.state.value as AngelPayPaymentState.Error
            assertThat(s.message).contains("evidencia de cobro")
            vm.declararSinTarjeta(); runCurrent()   // con el veto encendido no se declara nada
            coVerify(exactly = 1) { attemptApi.resolveNoInstrument(any(), any(), any()) }
            coVerify(exactly = 0) { paymentAttemptLedger.aplicarLiberacionDelServidor(any(), any()) }
            advanceTimeBy(vm.msMostrarLiberada + 100); runCurrent()
            assertThat(vm.state.value).isInstanceOf(AngelPayPaymentState.Error::class.java)   // sin reset automático
        } finally { vm.viewModelScope.cancel() }
    }

    @Test fun `un POST sin dinero pendiente, llega S5 (registrado=false) y despues la respuesta: contradiccion, sin liberar`() = runTest(testDispatcher) {
        coEvery { chargeVerifier.verificar(any(), any(), any(), any(), any()) } returns VerificacionDelCobro.NoSePudoVerificar("x")
        coEvery { ledgerServerRecovery.recoverOne(any(), any(), any()) } returns null
        coEvery { paymentAttemptLedger.leerIntento(any()) } returns null
        val ids = mutableListOf<String>()
        coEvery { paymentAttemptLedger.markIndeterminate(capture(ids), any()) } returns Unit
        val puertaPost = kotlinx.coroutines.CompletableDeferred<Unit>()
        coEvery { attemptApi.resolveNoInstrument(any(), any(), any()) } coAnswers { puertaPost.await(); respuestaDeclaracionOk() }   // sin dinero
        val vm = vmConCobroDelPos("REQ-W16")
        try {
            vm.onAngelPaySdkResult(sdkInciertoResult()); runCurrent()
            val mio = ids.last()
            vm.declararSinTarjeta(); runCurrent()   // POST en vuelo
            vm.manejarConfirmacionDelServidor(SocketEvent.TerminalPaymentConfirmed("REQ-W16", mio, "pay-s5", 10000, 0, registrado = false)); runCurrent()
            assertThat((vm.state.value as AngelPayPaymentState.Error).message).contains("evidencia de cobro")
            puertaPost.complete(Unit); runCurrent()   // la respuesta SIN dinero llega con el veto encendido
            coVerify(exactly = 0) { paymentAttemptLedger.aplicarLiberacionDelServidor(any(), any()) }
            assertThat((vm.state.value as AngelPayPaymentState.Error).message).doesNotContain("volver a cobrar")
        } finally { vm.viewModelScope.cancel() }
    }

    @Test fun `S5 (registrado=false) sobre una liberacion YA mostrada la desmiente y apaga el reset automatico`() = runTest(testDispatcher) {
        coEvery { chargeVerifier.verificar(any(), any(), any(), any(), any()) } returns VerificacionDelCobro.NoSePudoVerificar("x")
        coEvery { ledgerServerRecovery.recoverOne(any(), any(), any()) } returns null
        coEvery { paymentAttemptLedger.leerIntento(any()) } returns filaLiberada("att", "NO_EVIDENCE_AFTER_WINDOW")
        val ids = mutableListOf<String>()
        coEvery { paymentAttemptLedger.markIndeterminate(capture(ids), any()) } returns Unit
        val vm = vmConCobroDelPos("REQ-W17")
        try {
            // `primeSdkLaunch()` NO enciende `authorizationWasLaunched`; el SDK real sí (`onIntentLaunched`). Sin esa precondición
            // la guarda de `resetPayment()` no aplica y la prueba no demostraría la retención (Codex, Task 0 R7).
            vm.onIntentLaunched(); runCurrent()
            vm.onAngelPaySdkResult(sdkInciertoResult()); runCurrent()
            val mio = ids.last()
            advanceTimeBy(vm.msEntreConsultasS6 + 100); runCurrent()
            assertThat((vm.state.value as AngelPayPaymentState.Error).message).contains("volver a cobrar")   // liberación mostrada
            vm.manejarConfirmacionDelServidor(SocketEvent.TerminalPaymentConfirmed("REQ-W17", mio, "pay-s5", 10000, 0, registrado = false)); runCurrent()
            val contradiccion = vm.state.value as AngelPayPaymentState.Error
            assertThat(contradiccion.message).contains("evidencia de cobro")
            advanceTimeBy(vm.msMostrarLiberada + 100); runCurrent()
            assertThat(vm.state.value).isSameInstanceAs(contradiccion)   // el reset de la liberación NO dispara
            // Un reset MANUAL (Salir / flecha) tampoco la borra: la contradicción revocó el «negativo confirmado» y la guarda retiene.
            vm.resetPayment(); runCurrent()
            assertThat(vm.state.value).isSameInstanceAs(contradiccion)
            vm.declararSinTarjeta(); runCurrent()
            coVerify(exactly = 0) { attemptApi.resolveNoInstrument(any(), any(), any()) }   // el veto sobrevivió al reset rechazado
        } finally { vm.viewModelScope.cancel() }
    }

    @Test fun `liberacion YA mostrada y luego el POST responde CON dinero: la liberacion se retira al instante, antes de guardar`() = runTest(testDispatcher) {
        coEvery { chargeVerifier.verificar(any(), any(), any(), any(), any()) } returns VerificacionDelCobro.NoSePudoVerificar("x")
        coEvery { ledgerServerRecovery.recoverOne(any(), any(), any()) } returns null
        coEvery { paymentAttemptLedger.leerIntento(any()) } returns filaLiberada("att", "NO_EVIDENCE_AFTER_WINDOW")
        val puertaPost = kotlinx.coroutines.CompletableDeferred<Unit>()
        val puertaGuardado = kotlinx.coroutines.CompletableDeferred<Unit>()
        val cuerpoConDinero = TerminalAttemptStatusResponse(success = true, attemptId = "att", requestId = "REQ-W18",
            attempt = TerminalAttemptResultDto(attemptId = "att", outcome = "RECORDED", paymentId = "pay-body", paymentStatus = "COMPLETED", recordedVia = "webhook", amountCents = 10000, tipCents = 0, isWinner = true, winnerPaymentId = "pay-body"))
        coEvery { attemptApi.resolveNoInstrument(any(), any(), any()) } coAnswers { puertaPost.await(); Response.success(cuerpoConDinero) }
        coEvery { paymentAttemptLedger.aplicarVeredictoDelServidor(any()) } coAnswers { puertaGuardado.await(); Result.failure(IllegalStateException("room caída")) }
        val vm = vmConCobroDelPos("REQ-W18")
        try {
            vm.onIntentLaunched(); runCurrent()
            vm.onAngelPaySdkResult(sdkInciertoResult()); runCurrent()
            vm.declararSinTarjeta(); runCurrent()   // POST en vuelo
            advanceTimeBy(vm.msEntreConsultasS6 + 100); runCurrent()   // el sondeo lee la fila liberada y la anuncia
            assertThat((vm.state.value as AngelPayPaymentState.Error).message).contains("volver a cobrar")
            puertaPost.complete(Unit); runCurrent()   // el POST responde CON dinero; el guardado queda suspendido
            assertThat((vm.state.value as AngelPayPaymentState.Error).message).contains("evidencia de cobro")   // retirada AL INSTANTE
            advanceTimeBy(vm.msMostrarLiberada + 100); runCurrent()
            assertThat(vm.state.value).isInstanceOf(AngelPayPaymentState.Error::class.java)
            assertThat((vm.state.value as AngelPayPaymentState.Error).message).doesNotContain("volver a cobrar")
            puertaGuardado.complete(Unit); runCurrent()
            assertThat((vm.state.value as AngelPayPaymentState.Error).message).contains("evidencia de cobro")
        } finally { vm.viewModelScope.cancel() }
    }

    @Test fun `un 2xx sin poder leer la fila despues NO muestra liberada: avisa y vuelve a consultar`() = runTest(testDispatcher) {
        coEvery { chargeVerifier.verificar(any(), any(), any(), any(), any()) } returns VerificacionDelCobro.NoSePudoVerificar("x")
        coEvery { ledgerServerRecovery.recoverOne(any(), any(), any()) } returns null
        coEvery { attemptApi.resolveNoInstrument(any(), any(), any()) } returns respuestaDeclaracionOk()
        coEvery { paymentAttemptLedger.aplicarLiberacionDelServidor(any(), any()) } returns Result.failure(IllegalStateException("room caída"))
        coEvery { paymentAttemptLedger.leerIntento(any()) } returns null
        val vm = vmConCobroDelPos("REQ-W11")
        try {
            vm.onAngelPaySdkResult(sdkInciertoResult()); runCurrent()
            vm.declararSinTarjeta(); runCurrent()
            val s = vm.state.value as AngelPayPaymentState.ResultadoIncierto
            assertThat(s.error).contains("No se pudo confirmar en este aparato")
            assertThat(s.esperandoAlServidor).isTrue()
        } finally { vm.viewModelScope.cancel() }
    }

    @Test fun `tras un 2xx de la declaracion, si la libreta ya tenia RECORDED gana el dinero y no se muestra liberada`() = runTest(testDispatcher) {
        coEvery { chargeVerifier.verificar(any(), any(), any(), any(), any()) } returns VerificacionDelCobro.NoSePudoVerificar("x")
        coEvery { ledgerServerRecovery.recoverOne(any(), any(), any()) } returns null
        coEvery { paymentAttemptLedger.leerIntento(any()) } returns null andThen filaRegistrada("att")
        coEvery { attemptApi.resolveNoInstrument(any(), any(), any()) } returns respuestaDeclaracionOk()
        coEvery { paymentAttemptLedger.aplicarLiberacionDelServidor(any(), any()) } returns Result.success(false)  // el CAS local no transicionó
        val vm = vmConCobroDelPos("REQ-W9")
        try {
            vm.onAngelPaySdkResult(sdkInciertoResult()); runCurrent()
            vm.declararSinTarjeta(); runCurrent()
            assertThat(vm.state.value).isInstanceOf(AngelPayPaymentState.Success::class.java)
        } finally { vm.viewModelScope.cancel() }
    }

    @Test fun `declarar sin tarjeta con sesion con permiso libera sin PIN`() = runTest(testDispatcher) {
        coEvery { chargeVerifier.verificar(any(), any(), any(), any(), any()) } returns VerificacionDelCobro.NoSePudoVerificar("x")
        coEvery { ledgerServerRecovery.recoverOne(any(), any(), any()) } returns null
        coEvery { paymentAttemptLedger.leerIntento(any()) } returns null
        coEvery { attemptApi.resolveNoInstrument(any(), any(), any()) } returns respuestaDeclaracionOk()
        coEvery { paymentAttemptLedger.aplicarLiberacionDelServidor(any(), any()) } returns Result.success(true)
        val vm = vmConCobroDelPos("REQ-W4")
        try {
            vm.onAngelPaySdkResult(sdkInciertoResult()); runCurrent()
            vm.declararSinTarjeta(); runCurrent()
            coVerify { attemptApi.resolveNoInstrument("v1", any(), match { it.supervisorPin == null && it.statement == "NO_INSTRUMENT_PRESENTED" && it.requestId == "REQ-W4" }) }
            coVerify { paymentAttemptLedger.aplicarLiberacionDelServidor(match { it.evidencia == "OPERATOR_RECONCILED" }, any()) }
            assertThat((vm.state.value as AngelPayPaymentState.Error).canRetry).isFalse()
        } finally { vm.viewModelScope.cancel() }
    }

    @Test fun `declarar sin permiso pide PIN y con el PIN vuelve a intentar con el MISMO resolutionId`() = runTest(testDispatcher) {
        coEvery { chargeVerifier.verificar(any(), any(), any(), any(), any()) } returns VerificacionDelCobro.NoSePudoVerificar("x")
        coEvery { ledgerServerRecovery.recoverOne(any(), any(), any()) } returns null
        coEvery { paymentAttemptLedger.leerIntento(any()) } returns null
        coEvery { attemptApi.resolveNoInstrument(any(), any(), match { it.supervisorPin == null }) } returns respuesta403()
        coEvery { attemptApi.resolveNoInstrument(any(), any(), match { it.supervisorPin == "1234" }) } returns respuestaDeclaracionOk()
        coEvery { paymentAttemptLedger.aplicarLiberacionDelServidor(any(), any()) } returns Result.success(true)
        val vm = vmConCobroDelPos("REQ-W5")
        try {
            vm.onAngelPaySdkResult(sdkInciertoResult()); runCurrent()
            vm.declararSinTarjeta(); runCurrent()
            assertThat((vm.state.value as AngelPayPaymentState.ResultadoIncierto).pidePin).isTrue()
            vm.declararSinTarjeta(pin = "1234"); runCurrent()
            assertThat(vm.state.value).isInstanceOf(AngelPayPaymentState.Error::class.java)
            val ids = mutableListOf<NoInstrumentResolutionRequest>()
            coVerify(exactly = 2) { attemptApi.resolveNoInstrument(any(), any(), capture(ids)) }
            assertThat(ids.map { it.resolutionId }.toSet()).hasSize(1)
        } finally { vm.viewModelScope.cancel() }
    }

    @Test fun `una declaracion rechazada con 409 no libera nada, muestra el codigo y vuelve a consultar`() = runTest(testDispatcher) {
        coEvery { chargeVerifier.verificar(any(), any(), any(), any(), any()) } returns VerificacionDelCobro.NoSePudoVerificar("x")
        coEvery { ledgerServerRecovery.recoverOne(any(), any(), any()) } returns null
        coEvery { paymentAttemptLedger.leerIntento(any()) } returns null
        coEvery { attemptApi.resolveNoInstrument(any(), any(), any()) } returns respuesta409()
        val vm = vmConCobroDelPos("REQ-W6")
        try {
            vm.onAngelPaySdkResult(sdkInciertoResult()); runCurrent()
            vm.declararSinTarjeta(); runCurrent()
            val s = vm.state.value as AngelPayPaymentState.ResultadoIncierto
            assertThat(s.error).contains("POSITIVE_EVIDENCE_EXISTS")
            coVerify(exactly = 0) { paymentAttemptLedger.aplicarLiberacionDelServidor(any(), any()) }
            advanceTimeBy(vm.msEntreConsultasS6 + 100); runCurrent()
            coVerify(atLeast = 1) { ledgerServerRecovery.recoverOne("v1", any(), any()) }
        } finally { vm.viewModelScope.cancel() }
    }

    @Test fun `a los 45 s sin veredicto la pantalla deja de esperar pero conserva el boton de declarar y Consultar de nuevo`() = runTest(testDispatcher) {
        coEvery { chargeVerifier.verificar(any(), any(), any(), any(), any()) } returns VerificacionDelCobro.NoSePudoVerificar("x")
        coEvery { ledgerServerRecovery.recoverOne(any(), any(), any()) } returns null
        coEvery { paymentAttemptLedger.leerIntento(any()) } returns null
        val vm = vmConCobroDelPos("REQ-W7")
        try {
            vm.onAngelPaySdkResult(sdkInciertoResult()); runCurrent()
            advanceTimeBy(vm.msEsperaAlServidor + vm.msEntreConsultasS6); runCurrent()
            val s = vm.state.value as AngelPayPaymentState.ResultadoIncierto
            assertThat(s.esperandoAlServidor).isFalse(); assertThat(s.puedeDeclarar).isTrue()
            vm.consultarDeNuevo(); runCurrent()
            assertThat((vm.state.value as AngelPayPaymentState.ResultadoIncierto).esperandoAlServidor).isTrue()
        } finally { vm.viewModelScope.cancel() }
    }
```

- [ ] **Step 2: Verlas fallar** — `AVQ_KEEP=1 ./scripts/avq-verify.sh avoqado-tpv ./gradlew :app:testSandboxDebugUnitTest --max-workers=1 -Pkotlin.daemon.jvmargs=-Xmx4g --tests "*AngelPayPaymentViewModelTest"` → compile error (`esperandoAlServidor`, `declararSinTarjeta`, `resolveNoInstrument`, `leerIntento`).

- [ ] **Step 3: Implementar**

API (`TerminalAttemptApiService.kt`):

```kotlin
    /** Declaración del cajero: «no se presentó tarjeta». 200 ⇒ liberada por el servidor · 403 `SUPERVISOR_AUTHORIZATION_REQUIRED` ⇒ pedir PIN · 409 ⇒ no elegible (se consulta el veredicto). */
    @retrofit2.http.POST("tpv/venues/{venueId}/terminal-payment/attempts/{attemptId}/no-instrument-resolution")
    suspend fun resolveNoInstrument(
        @Path("venueId") venueId: String,
        @Path("attemptId") attemptId: String,
        @retrofit2.http.Body body: NoInstrumentResolutionRequest,
    ): Response<TerminalAttemptStatusResponse>

data class NoInstrumentResolutionRequest(
    @SerializedName("requestId") val requestId: String,
    @SerializedName("resolutionId") val resolutionId: String,
    @SerializedName("statement") val statement: String = "NO_INSTRUMENT_PRESENTED",
    @SerializedName("statementVersion") val statementVersion: Int = 1,
    @SerializedName("supervisorPin") val supervisorPin: String? = null,
)
```

Estado (`AngelPayPaymentState.kt`): `data class ResultadoIncierto(val message: String, val verificando: Boolean, val esperandoAlServidor: Boolean = false, val segundos: Int = 0, val puedeDeclarar: Boolean = false, val pidePin: Boolean = false, val error: String? = null)`.

ViewModel — constructor gana `private val ledgerServerRecovery: com.jaac.avoqado_tpv.features.payment.data.ledger.LedgerServerRecovery` y `private val attemptApi: com.jaac.avoqado_tpv.features.payment.data.ledger.TerminalAttemptApiService` (Hilt ya provee los dos: `@Singleton @Inject` y `PaymentModule.provideTerminalAttemptApiService`). Sustituir `quedarSinVerificar` por:

```kotlin
    private var esperaAlServidorJob: Job? = null
    private var declaracionJob: Job? = null     // single-flight: nunca dos POST de declaración en vuelo (Codex, Task 0 R4, P5)
    private var resolutionId: String? = null   // UNA vez por intento: el replay es idempotente en el servidor
    /**
     * Veto de dinero POR INTENTO (Codex, Task 0 R4, P5): se enciende ANTES de suspender para guardar una evidencia de dinero y
     * ya nunca se apaga en este cobro. Con él encendido no se intenta ni se muestra ninguna liberación aunque la fila conserve
     * una liberación vieja o llegue una respuesta atrasada sin dinero. Se limpia sólo en `resetPayment()`.
     */
    private var vetoDeDineroDelIntento: String? = null
    /** La pantalla anunció una liberación («se puede volver a cobrar») en este cobro; S5 lo usa para saber que tiene que desmentirla. */
    private var liberacionMostrada = false

    @VisibleForTesting internal var msEsperaAlServidor: Long = MS_ESPERA_AL_SERVIDOR
    @VisibleForTesting internal var msEntreConsultasS6: Long = MS_ENTRE_CONSULTAS_S6
    @VisibleForTesting internal var msMostrarLiberada: Long = MS_MOSTRAR_LIBERADA

    /**
     * No se pudo verificar por el historial: la duda se le pasa AL SERVIDOR (ventana de 30 s) y se espera su veredicto por S6.
     * Al POS se le manda `timeout` AL INSTANTE, como siempre: el reloj es del servidor, no de esta pantalla.
     */
    private fun esperarVeredictoDelServidor(motivo: String) {
        Timber.w("🔍 [AngelPay] Sin veredicto del historial (%s) — esperando al servidor", motivo)
        if (_state.value !is AngelPayPaymentState.ResultadoIncierto || (_state.value as AngelPayPaymentState.ResultadoIncierto).verificando) {
            emitSocketResultIfSocketSourced(status = "timeout", errorMessage = "La terminal no pudo confirmar el resultado del cobro. Confirmando con el banco.")
        }
        _state.value = AngelPayPaymentState.ResultadoIncierto(
            message = "Confirmando con el banco si el cobro pasó. Si el cliente NO acercó ninguna tarjeta, celular ni reloj, dilo aquí.",
            verificando = false, esperandoAlServidor = true, segundos = 0, puedeDeclarar = true,
        )
        val attemptId = currentPaymentAttemptId ?: return
        val venueId = authRepository.getVenueId() ?: secureStorage.getVenueId() ?: return
        esperaAlServidorJob?.cancel()
        esperaAlServidorJob = viewModelScope.launch {
            var transcurrido = 0L
            while (transcurrido < msEsperaAlServidor) {
                delay(msEntreConsultasS6); transcurrido += msEntreConsultasS6
                runCatching { ledgerServerRecovery.recoverOne(venueId, attemptId) }
                if (aplicarLoQueDigaLaLibreta(attemptId)) return@launch
                actualizarIncierto { it.copy(segundos = (transcurrido / 1000).toInt()) }
            }
            actualizarIncierto { it.copy(esperandoAlServidor = false, message = "El servidor todavía no confirma este cobro. Consulta de nuevo o, si no se presentó tarjeta, dilo aquí.") }
        }
    }

    /**
     * Lee la fila y mueve la pantalla, con EL DINERO PRIMERO (Codex, Task 0, P5): REGISTRADO ⇒ cobrado; RECORDED sin promover
     * (contradicción sobre una liberación) ⇒ «Avoqado registró dinero», nunca «se puede volver a cobrar»; liberación ⇒ se puede
     * volver a cobrar. La liberación se reconoce por `serverOutcome`, NO por el prefijo de `lastError`: ese texto sobrevive a la
     * contradicción. true si el desenlace ya quedó.
     */
    private suspend fun aplicarLoQueDigaLaLibreta(attemptId: String): Boolean {
        val fila = paymentAttemptLedger.leerIntento(attemptId) ?: return false
        return when {
            fila.state == PaymentAttemptEntity.STATE_REGISTRADO -> { mostrarCobroConfirmadoPorS6(fila); true }
            fila.serverOutcome == PaymentAttemptEntity.SERVER_RECORDED -> { mostrarContradiccion(); true }
            // Con el veto de dinero encendido, una liberación en la fila (vieja o nueva) NO se anuncia: gana la evidencia.
            vetoDeDineroDelIntento == attemptId -> { mostrarContradiccion(); true }
            fila.serverOutcome == PaymentAttemptEntity.SERVER_OPERATOR_NO_INSTRUMENT -> { mostrarLiberada("OPERATOR_RECONCILED"); true }
            fila.serverOutcome == PaymentAttemptEntity.SERVER_RELEASED_NO_EVIDENCE -> { mostrarLiberada("NO_EVIDENCE_AFTER_WINDOW"); true }
            else -> false
        }
    }

    /**
     * Evidencia de dinero en el servidor que la libreta no pudo (o no debe) promover: se prohíbe recobrar, sin reset automático.
     * Revoca el «desenlace negativo confirmado» que `mostrarLiberada` pudo haber fijado (Codex, Task 0 R6, P5.1): con él puesto,
     * la guarda de `resetPayment()` dejaría pasar un reset manual y se perdería el veto con dinero conocido.
     */
    private fun mostrarContradiccion() {
        esperaAlServidorJob?.cancel()
        clearChargingOnTerminal()
        confirmedNegativeOutcome = false
        confirmedNegativeEvidence = null
        _state.value = AngelPayPaymentState.Error(
            message = "Avoqado tiene evidencia de cobro de este intento. NO lo vuelvas a cobrar: Avoqado lo concilia.",
            canRetry = false,
        )
    }

    /** Misma forma que `manejarConfirmacionDelServidor` (S5): el dinero consta en el servidor, la pantalla lo dice. */
    private fun mostrarCobroConfirmadoPorS6(fila: PaymentAttemptEntity) {
        esperaAlServidorJob?.cancel()
        _socketResultEmitted = true
        cancelarCierrePorAbandono()
        clearChargingOnTerminal()
        _state.value = AngelPayPaymentState.Success(
            authCode = "", amount = pendingAmount.toPlainString(),
            tipAmount = if (pendingTip > BigDecimal.ZERO) pendingTip.toPlainString() else null,
            referenceNumber = null, orderId = pendingOrderId, orderNumber = pendingOrderNumber, isCash = false,
            receipt = PaymentReceipt(
                paymentId = fila.serverPaymentId ?: "", receiptUrl = "", accessKey = "",
                amount = pendingAmount, tipAmount = pendingTip, serverRecordedVia = "s6", solicitudLigada = _socketRequestId,
            ),
        )
    }

    private fun mostrarLiberada(evidencia: String) {
        if (vetoDeDineroDelIntento != null) { mostrarContradiccion(); return }   // defensa en profundidad: nunca «liberada» con veto
        esperaAlServidorJob?.cancel()
        clearChargingOnTerminal()
        // El SERVIDOR acreditó «no se cobró» (evidencia de servidor/operador): es un desenlace negativo confirmado, y sin esto
        // `resetPayment()` se negaría a limpiar (guarda «Error tras autorizar sin desenlace negativo»).
        confirmedNegativeOutcome = true
        confirmedNegativeEvidence = evidencia
        liberacionMostrada = true
        val mostrado = AngelPayPaymentState.Error(
            message = if (evidencia == "OPERATOR_RECONCILED") "Confirmado: no se presentó tarjeta. Se puede volver a cobrar."
                      else "No se confirmó el cobro en 30 s. Se puede volver a cobrar. Si el banco lo aprueba tarde, se registra solo y la terminal avisa.",
            canRetry = false,
        )
        _state.value = mostrado
        // El reset automático sólo si la pantalla sigue siendo ESTA liberación y nadie encendió el veto entre tanto (S5 puede
        // llegar en esos 4 s y convertirla en contradicción, que también es un `Error`: por eso se compara identidad).
        viewModelScope.launch { delay(msMostrarLiberada); if (_state.value === mostrado && vetoDeDineroDelIntento == null) resetPayment() }
    }

    fun consultarDeNuevo() { if (_state.value is AngelPayPaymentState.ResultadoIncierto) esperarVeredictoDelServidor("consulta manual") }

    fun declararSinTarjeta(pin: String? = null) {
        val attemptId = currentPaymentAttemptId ?: return
        val requestId = _socketRequestId ?: return
        val venueId = authRepository.getVenueId() ?: secureStorage.getVenueId() ?: return
        if (vetoDeDineroDelIntento == attemptId) { mostrarContradiccion(); return }   // ya hay evidencia de dinero: no se declara nada
        if (declaracionJob?.isActive == true) return                                  // single-flight: un doble toque no abre otro POST
        val id = resolutionId ?: java.util.UUID.randomUUID().toString().also { resolutionId = it }
        declaracionJob = viewModelScope.launch {
            val respuesta = runCatching { attemptApi.resolveNoInstrument(venueId, attemptId, NoInstrumentResolutionRequest(requestId, id, supervisorPin = pin)) }.getOrNull()
            when {
                respuesta == null -> actualizarIncierto { it.copy(error = "Sin conexión. Se sigue esperando al servidor.") }
                respuesta.isSuccessful -> {
                    // El cuerpo es un TerminalAttemptStatus. `desdeConsultaS6` devuelve algo SÓLO si el intento trae evidencia de
                    // dinero (RECORDED / SECOND_CAPTURE / REFERENCE_COLLISION / PENDING_EVIDENCE); NOT_RECORDED ⇒ null.
                    val veredicto = respuesta.body()?.let { VeredictoDeIntento.desdeConsultaS6(venueId, attemptId, it) }
                    if (veredicto != null) {
                        // 🔴 El veto se enciende ANTES de suspender para guardar (Codex, Task 0 R4, P5): cualquier respuesta atrasada,
                        // lectura de la fila o reset que llegue después lo respeta. Con evidencia de dinero la liberación NI SE
                        // INTENTA; se guarda el veredicto con el mismo normalizador que S6 y sin red; si guardarlo FALLA
                        // (`Result.failure`), la pantalla igual prohíbe recobrar (la libreta lo reaplicará por E2/N3). Una
                        // liberación VIEJA en la fila no cuenta: sólo REGISTRADO enseña Success.
                        vetoDeDineroDelIntento = attemptId
                        // Si la pantalla YA anunció una liberación (el sondeo la leyó mientras el POST volaba), se retira AHORA,
                        // antes de suspender para guardar: ni un segundo de «se puede volver a cobrar» con dinero conocido (R6, P5.2).
                        if (liberacionMostrada) mostrarContradiccion()
                        val guardado = paymentAttemptLedger.aplicarVeredictoDelServidor(veredicto).isSuccess
                        val fila = paymentAttemptLedger.leerIntento(attemptId)
                        if (guardado && fila?.state == PaymentAttemptEntity.STATE_REGISTRADO) mostrarCobroConfirmadoPorS6(fila) else mostrarContradiccion()
                    } else if (vetoDeDineroDelIntento == attemptId) {
                        mostrarContradiccion()   // una respuesta sin dinero que llegue con el veto ya encendido no libera nada
                    } else {
                        paymentAttemptLedger.aplicarLiberacionDelServidor(LiberacionDelServidor(venueId, attemptId, "OPERATOR_RECONCILED"))
                        if (!aplicarLoQueDigaLaLibreta(attemptId)) {
                            // La fila no se pudo leer o no cambió: NUNCA «se puede volver a cobrar» sin verla. Se consulta de nuevo.
                            actualizarIncierto { it.copy(error = "No se pudo confirmar en este aparato. Se consulta de nuevo.") }
                            consultarDeNuevo()
                        }
                    }
                }
                respuesta.code() == 403 && codigoDeError(respuesta) == "SESSION_NOT_IN_VENUE" ->
                    actualizarIncierto { it.copy(error = "La sesión de esta terminal no pertenece a este negocio. Vuelve a iniciar sesión.") }
                respuesta.code() == 403 -> actualizarIncierto { it.copy(pidePin = true, error = if (pin == null) null else "Ese código no tiene permiso para confirmarlo.") }
                else -> { actualizarIncierto { it.copy(error = "No se pudo confirmar (${codigoDeError(respuesta)}). Se consulta el veredicto.") }; consultarDeNuevo() }
            }
        }
    }

    private fun codigoDeError(r: retrofit2.Response<*>): String =
        runCatching { org.json.JSONObject(r.errorBody()?.string().orEmpty()).optString("code") }.getOrNull()?.takeIf { it.isNotBlank() } ?: r.code().toString()

    private inline fun actualizarIncierto(f: (AngelPayPaymentState.ResultadoIncierto) -> AngelPayPaymentState.ResultadoIncierto) {
        (_state.value as? AngelPayPaymentState.ResultadoIncierto)?.let { _state.value = f(it) }
    }
```

S5 — `manejarConfirmacionDelServidor` (~L2960; Codex, Task 0 R5): S5 es evidencia de dinero del servidor, la libreta la haya promovido o no. Tras las dos guardas de identidad (`requestId`/`attemptId`) y ANTES del `if (!event.registrado)`:

```kotlin
        // Veto de dinero por intento: desde aquí ninguna liberación (vieja, nueva o atrasada) se anuncia en este cobro.
        vetoDeDineroDelIntento = event.attemptId
        esperaAlServidorJob?.cancel()
        if (!event.registrado) {
            // La libreta no lo dio por REGISTRADO (contradicción sobre una fila liberada, SDK dentro, montos…). Si la pantalla
            // está esperando el veredicto o YA anunció una liberación, tiene que dejar de decir «se puede volver a cobrar»;
            // en cualquier otro estado, como hoy: no afirma nada.
            if (_state.value is AngelPayPaymentState.ResultadoIncierto || liberacionMostrada) mostrarContradiccion()
            else Timber.w("📣 [AngelPay] payment_confirmed para %s sin transición en la libreta: la pantalla no cambia", event.attemptId)
            return
        }
```

y en la rama `registrado` que ya construye `Success` no cambia nada más (el `esperaAlServidorJob?.cancel()` de arriba ya cubre la espera nueva). 🔴 La prueba EXISTENTE «Sin transición en la libreta: la pantalla no afirma nada» (`AngelPayPaymentViewModelTest.kt` ~L3543, S5 `registrado = false` sobre `ResultadoIncierto` ⇒ sigue `ResultadoIncierto`) fijaba la semántica vieja: se APRIETA a «⇒ `Error(canRetry = false)` con «evidencia de cobro» y sin «volver a cobrar»» (con veto, un `declararSinTarjeta()` posterior no abre POST). Residuo declarado: si S5 llega DESPUÉS del reset automático (más de 4 s tras la liberación), `currentPaymentAttemptId` ya es null y el evento se ignora — ahí avisa el F0 (contradicción visible 72 h en las tres rutas), que es el mecanismo existente para el dinero tardío.

Una contradicción (`mostrarContradiccion`) se RETIENE como cualquier `Error` tras autorizar sin desenlace negativo — por eso revoca `confirmedNegativeOutcome`, que `mostrarLiberada` pudo haber puesto — (`resetPayment` la respeta; «Salir» navega sin limpiar); un cobro nuevo (remoto o `initPayment`) la sustituye — es la política existente para dinero sin resolver, declarada.

`companion object`: `const val MS_ESPERA_AL_SERVIDOR = 45_000L; const val MS_ENTRE_CONSULTAS_S6 = 5_000L; const val MS_MOSTRAR_LIBERADA = 4_000L`. `resetPayment()` añade —DESPUÉS de sus guardas de salida (L4167–4168) y junto a `currentPaymentAttemptId = null`, para que un reset rechazado conserve el veto— `esperaAlServidorJob?.cancel(); esperaAlServidorJob = null; declaracionJob?.cancel(); declaracionJob = null; resolutionId = null; vetoDeDineroDelIntento = null; liberacionMostrada = false`. La llamada `is VerificacionDelCobro.NoSePudoVerificar -> quedarSinVerificar(verificacion.motivo)` pasa a `esperarVeredictoDelServidor(verificacion.motivo)`; el `timeout` al POS se emite UNA vez (la guarda de arriba: sólo si veníamos de `verificando = true`, es decir, del historial; `consultarDeNuevo` no re-emite).

🔴 `isChargeAttemptActive`: `ResultadoIncierto` NO está en la lista de estados «resueltos» (Idle/Success/Queued/Error/Cancelled), así que mientras se espera **esta** pantalla sigue rechazando un segundo cobro remoto — correcto (F0 cerca la venta; la ranura del servidor ya está libre para OTRAS órdenes tras la ventana, pero la pantalla local no lo está hasta que llega el veredicto o el cajero sale). `Error(canRetry = false)` sí es «resuelto», y `resetPayment()` a los 4 s la deja libre.

Pantalla (`ResultadoInciertoContent`, `AngelPayPaymentScreen.kt` L853–905): con `esperandoAlServidor` un `CircularProgressIndicator` + «Confirmando con el banco… (${segundos} s)»; siempre que `puedeDeclarar`: `OutlinedButton("El cliente no presentó tarjeta") { viewModel.declararSinTarjeta() }`; si `pidePin`: `OutlinedTextField` numérico (4–8 dígitos, `PasswordVisualTransformation`, `KeyboardType.NumberPassword`) + `Button("Confirmar con código") { viewModel.declararSinTarjeta(pin) }`; si `!esperandoAlServidor`: `OutlinedButton("Consultar de nuevo") { viewModel.consultarDeNuevo() }` y el `TextButton("Salir")` que ya existe; `error` en `bodySmall` con `MaterialTheme.colorScheme.error`. Todo dentro del `Surface(color = MaterialTheme.colorScheme.background)` que ya envuelve la pantalla (contraste, I2 de Codex). **Nunca un botón «Reintentar» en este estado.**

- [ ] **Step 4: Verlas pasar** — mismo comando del Step 2 → `Tests:` sin fallos (las existentes + las nuevas; la única existente que cambia es la de S5 `registrado=false` sobre `ResultadoIncierto`, apretada).
- [ ] **Step 5: Commit (TPV, sin Co-Authored-By)** por rutas: `AngelPayPaymentViewModel.kt`, `AngelPayPaymentState.kt`, `AngelPayPaymentScreen.kt`, `TerminalAttemptApiService.kt`, `AngelPayPaymentViewModelTest.kt`; verificar con `git show --stat HEAD`.

---

### Task 8 (TPV): certificación, sabotajes, Codex acotado, CHANGELOG

- [ ] **Step 1: Suites y compiles por avq-verify** (una corrida pesada a la vez):

```bash
cd /Users/amieva/Documents/Programming/Avoqado
AVQ_KEEP=1 ./scripts/avq-verify.sh avoqado-tpv ./gradlew :app:testSandboxDebugUnitTest --max-workers=1 -Pkotlin.daemon.jvmargs=-Xmx4g --tests "*VeredictoDelServidorRoomTest" --tests "*LedgerServerRecoveryRoomTest" --tests "*LedgerServerRecoveryWorkerTest" --tests "*AngelPayPaymentViewModelTest" --tests "*SocketManagerTest" --tests "*RemotePaymentInboxRoomTest" --tests "*PaymentAttemptLedgerTest"
AVQ_KEEP=1 ./scripts/avq-verify.sh avoqado-tpv ./gradlew :app:compileNexgoDebugKotlin :app:compileProductionDebugKotlin --max-workers=1
```
Expected en el cuerpo: `Tests:` 0 fallos; ambos compiles exit 0.

- [ ] **Step 2: Sabotajes en `$J/sab-tpv`** con `$J/sab-tpv-cp2.py` (añadir mutantes S21–S25): S21 `cerrarPorLiberacionDelServidor` sin `host_approved IS NOT 1` → cae «RECORDED guardado NO se libera»; S22 `desdeConsultaS6` acepta `PROCESSOR_DECLINED` → cae la prueba de evidencias; S23 la espera emite `failed` → cae «nunca emite failed»; S24 `declararSinTarjeta` manda `pin` aunque sea null → cae el caso de sesión; S25 `Error(canRetry = true)` en `mostrarLiberada` → cae «sin Reintentar»; S26 quitar los dos outcomes nuevos de `candidatasDeConsultaAlServidor` → cae «sigue siendo candidata de consulta S6»; S27 en `aplicarLoQueDigaLaLibreta` mirar `lastError` en vez de `serverOutcome` → cae «contradicción: nunca se puede volver a cobrar»; S28 volver a poner `mostrarLiberada` como fallback tras el 2xx → cae «sin poder leer la fila NO muestra liberada»; S29 quitar `aplicarVeredictoDelServidor` del 2xx → cae «aplica el veredicto del CUERPO»; S30 ignorar `isSuccess` del guardado (tratar failure como success) → cae «guardado FALLA prohíbe recobrar»; S31 quitar el single-flight (`declaracionJob`) → cae «dos toques abren UN solo POST»; S32 encender el veto DESPUÉS de guardar (o no encenderlo) → cae «con el guardado SUSPENDIDO el sondeo… NO la anuncia»; S33 quitar el veto de S5 → caen «POST sin dinero pendiente + S5» y «S5 sobre una liberación YA mostrada»; S34 en el reset automático comparar `is Error` en vez de identidad → cae «apaga el reset automático»; S35 no revocar `confirmedNegativeOutcome` en `mostrarContradiccion` → cae «un reset MANUAL tampoco la borra»; S36 quitar el `if (liberacionMostrada) mostrarContradiccion()` previo al guardado → cae «la liberación se retira al instante». Control verde antes de cada uno.
- [ ] **Step 3: Codex acotado sobre el diff de la TPV** (mismo formato que Task 5). P1 → TDD → repetir sólo lo afectado.
- [ ] **Step 4: CHANGELOG `[Unreleased]`** de la TPV y commit por rutas (sin Co-Authored-By). **Sin bump de versión** (el bump y la firma van con `avoqado:release-production` tras el QA).

---

### Task 9 (POS Android + iOS, JUNTAS): el mensaje distingue «liberada por la ventana» y «el cajero confirmó que no hubo tarjeta»

**Files:**
- Modify: `avoqado-android/app/src/main/java/com/avoqado/pos/payment/domain/CardChargeOutcome.kt` (`CardChargeDecision.fromTerminalStatus` L273–282) + Test `app/src/test/java/com/avoqado/pos/payment/CardChargeDecisionTest.kt` (existente)
- Modify: `avoqado-ios/avoqado-ios/Payment/CardChargeOutcome.swift` (`fromTerminalStatus(status:paymentId:cancelDisposition:)` L372 gana `outcomeEvidence:`; su único llamador es L314, que ya tiene `outcomeEvidence` en el `case known`) + Test `avoqado-ios/avoqado-iosTests/CardChargeDecisionTests.swift` (existente)

- [ ] **Step 1: Pruebas en rojo** (Android):

```kotlin
@Test fun `FAILED con NO_EVIDENCE_AFTER_WINDOW es NotCharged y lo dice sin llamarlo rechazo`() {
    val r = CardChargeDecision.decide(ChargeStatusProbe.Known(status = "FAILED", inProgress = false, outcome = "NOT_CHARGED", outcomeEvidence = "NO_EVIDENCE_AFTER_WINDOW"), isFinalAttempt = true)
    val out = (r as ProbeDecision.Resolved).outcome as CardChargeOutcome.NotCharged
    assertThat(out.message).contains("No se confirmó el cobro en 30 s"); assertThat(out.message).doesNotContain("rechazado")
}
@Test fun `FAILED con OPERATOR_RECONCILED dice que la terminal confirmó que no hubo tarjeta`() {
    val r = CardChargeDecision.decide(ChargeStatusProbe.Known(status = "FAILED", inProgress = false, outcome = "NOT_CHARGED", outcomeEvidence = "OPERATOR_RECONCILED"), isFinalAttempt = true)
    val out = (r as ProbeDecision.Resolved).outcome as CardChargeOutcome.NotCharged
    assertThat(out.message).isEqualTo("La terminal confirmó que no se presentó tarjeta. Puedes volver a cobrar.")
}
@Test fun `FAILED sin evidencia sigue diciendo rechazado (contrato de siempre)`() {
    val r = CardChargeDecision.decide(ChargeStatusProbe.Known(status = "FAILED", inProgress = false), isFinalAttempt = true)
    assertThat(((r as ProbeDecision.Resolved).outcome as CardChargeOutcome.NotCharged).message).isEqualTo("El cobro fue rechazado. No se cobró la tarjeta.")
}
```
iOS: los mismos tres casos en `CardChargeDecisionTests.swift` (`CardChargeDecision.decide(probe: .known(status: "FAILED", inProgress: false, paymentId: nil, outcome: "NOT_CHARGED", outcomeEvidence: "NO_EVIDENCE_AFTER_WINDOW"), isFinalAttempt: true)` ⇒ `.resolved(.notCharged(message:))`).

- [ ] **Step 2: Verlas fallar** — Android: `AVQ_KEEP=1 ./scripts/avq-verify.sh avoqado-android ./gradlew :app:testDebugUnitTest --tests "*CardChargeDecisionTest" --max-workers=1`; iOS: `AVQ_KEEP=1 ./scripts/avq-verify.sh avoqado-ios xcodebuild test -scheme avoqado-ios -destination "platform=iOS Simulator,name=iPad Pro 11-inch (M4),OS=18.5" -only-testing:avoqado-iosTests/CardChargeDecisionTests`.

- [ ] **Step 3: Implementar** (Android):

```kotlin
    private fun fromTerminalStatus(probe: ChargeStatusProbe.Known): CardChargeOutcome =
        when {
            probe.cancelDisposition == "ACTIVE" -> CardChargeOutcome.Undetermined("El cobro sigue activo. Confirma en la terminal. No vuelvas a pasar la tarjeta.")
            probe.status == "COMPLETED" -> CardChargeOutcome.Undetermined(UNDETERMINED_MESSAGE)
            probe.status == "FAILED" && probe.outcomeEvidence == "NO_EVIDENCE_AFTER_WINDOW" ->
                CardChargeOutcome.NotCharged("No se confirmó el cobro en 30 s. Puedes volver a cobrar. Si el banco lo aprueba tarde, se registra solo y te avisamos.")
            probe.status == "FAILED" && probe.outcomeEvidence == "OPERATOR_RECONCILED" ->
                CardChargeOutcome.NotCharged("La terminal confirmó que no se presentó tarjeta. Puedes volver a cobrar.")
            probe.status == "FAILED" -> CardChargeOutcome.NotCharged("El cobro fue rechazado. No se cobró la tarjeta.")
            probe.status == "CANCELLED" && probe.cancelDisposition == "ACCEPTED" -> CardChargeOutcome.NotCharged("El cobro se canceló. No se cobró la tarjeta.")
            else -> CardChargeOutcome.Undetermined(UNDETERMINED_MESSAGE)
        }
```
iOS: espejo exacto, mismos tres textos —

```swift
    private static func fromTerminalStatus(status: String, paymentId: String?, cancelDisposition: String?, outcomeEvidence: String?) -> CardChargeOutcome {
        switch status {
        case "COMPLETED":
            return .undetermined(message: undeterminedMessage)
        case "FAILED" where outcomeEvidence == "NO_EVIDENCE_AFTER_WINDOW":
            return .notCharged(message: "No se confirmó el cobro en 30 s. Puedes volver a cobrar. Si el banco lo aprueba tarde, se registra solo y te avisamos.")
        case "FAILED" where outcomeEvidence == "OPERATOR_RECONCILED":
            return .notCharged(message: "La terminal confirmó que no se presentó tarjeta. Puedes volver a cobrar.")
        case "FAILED":
            return .notCharged(message: "El cobro fue rechazado. No se cobró la tarjeta.")
        case "CANCELLED" where cancelDisposition == "ACCEPTED":
            return .notCharged(message: "El cobro se canceló. No se cobró la tarjeta.")
        default:
            return .undetermined(message: undeterminedMessage)
        }
    }
```

y en L314 pasar `outcomeEvidence: outcomeEvidence` (ya está enlazado en el `case .known(...)`).

- [ ] **Step 4: Verlas pasar** (mismos comandos) y **Step 5: Commit** en cada repo por rutas (`[skip ci]` en Android, con Co-Authored-By).

---

### Task 10: QA en hardware (N86 + Sunmi, servidor local `develop`) — la regla `todo-funciona-sin-red.md`

**Prerrequisitos:** `npm run dev` del servidor **reiniciado** (tsx watch no recargó N0b el 16-sep); APK `nexgoDebug` construido desde `main` con Task 7 e instalado con `adb -s N86 install -r` (sin borrar datos); Sunmi con el POS `main` (Task 9) o el 2.18.3-dev existente (lee FAILED igual); proxy 8799 en `pass`; webhook de QA del comercio 107 re-registrado al id actual (`cmtxycvehaeqsol65qp0ix9xj`) **con OK del founder**.

- [ ] **Escenario A — cancelación sin tarjeta (el caso diario):** cobro de $1 desde la Sunmi → en la N86 tocar «Cancelar» sin acercar tarjeta → la N86 muestra «Confirmando con el banco… (N s)» → en `TerminalPaymentRequest` la fila pasa `TIMED_OUT` → `FAILED/NO_EVIDENCE_AFTER_WINDOW` entre 30 y 35 s (`releasedAfterWindow.origen = TIMER`) → la N86 dice «Se puede volver a cobrar» y vuelve a Idle; la Sunmi, al consultar, «No se confirmó el cobro en 30 s…» y suelta la llave; la libreta de la N86: fila `DESCARTADA` con `last_error = liberada_por_el_servidor:NO_EVIDENCE_AFTER_WINDOW`; `ActivityLog` con `TERMINAL_PAYMENT_RELEASED_AFTER_WINDOW`. Evidencia: `psql` (base local), logcat de la N86, captura de la Sunmi.
- [ ] **Escenario B — el cajero declara:** igual que A pero a los 5 s tocar «El cliente no presentó tarjeta» con la sesión OWNER → sin PIN → fila `FAILED/OPERATOR_RECONCILED_NO_CHARGE`, bitácora con el `staffId` del OWNER, la Sunmi «La terminal confirmó que no se presentó tarjeta».
- [ ] **Escenario C — sin permiso:** sesión CASHIER en la N86 → el botón pide código → con el PIN del OWNER libera (`by: SUPERVISOR_PIN`); con un PIN sin permiso, «Ese código no tiene permiso» y la fila intacta.
- [ ] **Escenario D — el banco aprueba (tarjeta de QA):** cobro real de $1 → la N86 muestra «Cobrado» por S5 (webhook primero) ANTES del registro REST; nada entra a la ventana. (Si el webhook de QA no dispara tras re-registrarlo, anotarlo: la ventana y el REST siguen funcionando, y es la pregunta 6 para AngelPay.)
- [ ] **Escenario E — sin red en la N86 a mitad de la espera:** `adb -s N86 shell svc wifi disable` durante «Confirmando…» → la pantalla lo dice («Sin conexión. Se sigue esperando…»), el servidor libera por su cuenta a los 30 s, y al volver la red (`svc wifi enable`) N3 aplica la liberación (`liberadas = 1` en logcat) y la venta se destraba sola. Matar la app (`am force-stop`) en medio → al reabrir, el aviso F0 muestra la pendiente y N3 la cierra al reconectar.
- [ ] **Escenario F — aprobación tardía simulada:** con la fila ya `FAILED/NO_EVIDENCE_AFTER_WINDOW`, mandar por `curl` al webhook local (`POST /api/v1/webhooks/angelpay/cmtxycvehaeqsol65qp0ix9xj`, firmado con el secret local) un `send_transaction approved` con la `integratorReference` del intento → fila `COMPLETED/lateResult`, bitácora `TERMINAL_PAYMENT_LATE_APPROVAL_AFTER_WINDOW`, 🚨 en el log, correo (o `warn` si `OPS_ALERT_EMAIL` no está), y en la N86 la contradicción visible («este cobro SÍ pasó»).
- [ ] Registrar los seis resultados (PASA/FALLA + evidencia) en `docs/angelpay/2026-09-16-investigacion-u101-dobles-cobros-y-camino-de-salida.md` §9 «QA», y cualquier defecto → TDD → repetir sólo la tarea afectada.

---

### Task 11: Documentación y lo que no es código

- [ ] `.claude/rules/proyectos-por-fases.md`: fila del 16-sep actualizada con el estado real (hashes, pruebas, QA).
- [ ] Memoria `dobles-cobros-testarudo-el-sdk-dijo-cancelado-y-el-banco-aprobo.md`: anexar «construido: …».
- [ ] `avoqado-tpv/.claude/rules/cobro-remoto-pos-a-tpv.md`: fila nueva en la matriz: «negativo sin evidencia ⇒ ventana 30 s ⇒ liberada / declarada / cobrada tarde».
- [ ] **Founder:** devolver los dos cobros dobles ($258.50 del 11-sep, $143 del 16-sep, Testarudo) o pedir el reverso a AngelPay; mandar el correo de §5 del doc; autorizar el re-registro del webhook de QA; GO para `develop → main` (el servidor sale primero y ya cubre a los APK viejos) y después el APK Nexgo 2.9.3.

---

## Self-review

- **Cobertura del spec (§4):** paso 1 (webhook gana) = checkpoint 1 + Task 2 (`RECONCILED`) + Task 10-D; paso 2 (historial) = existente + Task 7; paso 3 (un toque del cajero, sin reinicio ni PIN con permiso) = Tasks 4 y 7; paso 4 (liberar a los 30 s + vigilancia + alarma) = Tasks 2 y 3; paso 5 (APK legacy por el servidor) = Task 2 (`closeRow` degrada cualquier `failed`/`cancelled` sin evidencia, venga del APK que venga); POS = Task 9; QA = Task 10.
- **Placeholders:** ninguno; donde una prueba se resume en un comentario (`/* … */`) el implementador la escribe con la misma forma que la vecina inmediata del mismo bloque.
- **Consistencia de nombres:** `UNPROVEN_NEGATIVE_WINDOW_MS`, `releaseUnprovenNegative`, `releaseUnprovenNegativesAfterWindow`, `NO_EVIDENCE_AFTER_WINDOW`, `OPERATOR_RECONCILED_NO_CHARGE` / evidencia `OPERATOR_RECONCILED`, `resolveNoInstrument` (servidor y API TPV), `LiberacionDelServidor`, `cerrarPorLiberacionDelServidor`, `aplicarLiberacionDelServidor`, `leerIntento` (la pantalla lee la fila: `REGISTRADO` ⇒ Success, `DESCARTADA` + prefijo `liberada_por_el_servidor:` ⇒ liberada), `declararSinTarjeta(pin)`, `esperandoAlServidor/segundos/puedeDeclarar/pidePin/error` — usados con el mismo nombre en todas las tareas.
