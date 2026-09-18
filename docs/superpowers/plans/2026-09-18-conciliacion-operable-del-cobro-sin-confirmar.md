# Conciliación operable del cobro sin confirmar — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que un cajero pueda declarar «ya revisé la terminal: no se cobró» y con eso se liberen de golpe la venta y la ranura de la terminal, sin volver a escribir SQL en producción.

**Architecture:** Un servicio nuevo, hermano de `resolveNoInstrument`, que **no toca** el camino que ya corre en producción. Reusa las piezas ya extraídas y probadas (`candadoDeSolicitud`, `sinEvidenciaPositivaSql`, `desenlaceCanonico`, `estadoBancarioSql`) y escribe el mismo desenlace que ya libera los dos candados: `FAILED` + `OPERATOR_RECONCILED_NO_CHARGE`. La declaración se persiste en **columna propia** de `TerminalPaymentRequest` (no en `resultJson`, que varios escritores reemplazan entero; no en `TerminalPaymentAttemptLink`, que exige un vínculo que las filas legacy no tienen).

**Tech Stack:** TypeScript · Express · Prisma/PostgreSQL · Jest (+ supertest) · Kotlin/Compose (Android) · SwiftUI (iOS)

**Spec:** `docs/superpowers/specs/2026-09-18-conciliacion-operable-del-cobro-sin-confirmar-design.md` (commit `9a92120`)

**Mockup aprobado:** https://claude.ai/artifact/Eqfzz5DvpuGeZafHYEQ2sf

---

## Global Constraints

- **Nada del camino de producción se modifica en la etapa 1.** `no-instrument-resolution.service.ts`, `closeRowFromPaymentTx`, la ventana de confirmación y el predicado `UNRESOLVED_FINANCIAL_OUTCOME` se leen y se reusan, **nunca se editan**. Si una tarea parece necesitar editarlos, se para y se reporta.
- **El desenlace que se escribe es exactamente** `status = 'FAILED'`, `failureCode = 'OPERATOR_RECONCILED_NO_CHARGE'`, `cancelDisposition = NULL`. Verificado contra los tres predicados: sale del bloqueo heredado (`terminal-payment.service.ts:549`), del estricto (el código **está** en `CODIGOS_SIN_COBRO`, `:428`) y del índice único parcial (que sólo cubre `PENDING/SENT/CANCEL_REQUESTED/UNKNOWN`).
- **Dinero en PESOS, 1:1** en toda respuesta de API y MCP. `amountCents / 100` sólo al proyectar.
- **TDD estricto:** la prueba se escribe primero y **se ve fallar** antes de implementar. Un paso «Run test to verify it fails» que pase es un defecto de la prueba, no un atajo.
- **Toda mutación escribe `ActivityLog`** dentro de la misma transacción (`tx.activityLog.create`, nunca `logAction` que abre su propia conexión).
- **Verificación pesada por `avq-verify`**, desde el root del workspace: `./scripts/avq-verify.sh avoqado-server <comando>`. Se lee el CUERPO de la salida (`errores TS:`, `Test Suites:`), nunca el código de salida del script.
- **Mensajes de Zod en español** (el middleware los muestra al usuario tal cual).
- **Android e iOS se cambian JUNTOS** (regla del workspace). La etapa 2 no se da por terminada con una sola.
- **`git commit -- <ruta>`** siempre, nunca `git add` + `git commit`: el índice es compartido con ~20 sesiones.

---

## File Structure

| Archivo | Responsabilidad |
|---|---|
| `prisma/schema.prisma` | + columna `operatorReconciliation Json?` en `TerminalPaymentRequest` |
| `prisma/migrations/<ts>_operator_reconciliation/migration.sql` | La migración aditiva |
| `src/lib/permissions.ts` | + permiso `payments:reconcile-uncharged`, que **sí** tiene CASHIER |
| `src/services/tpv/uncharged-reconciliation.service.ts` | **NUEVO.** El servicio: esquema, elegibilidad, veto, CAS, auditoría |
| `src/services/terminal-payment.service.ts` | Despacho de la variante + persistir la respuesta `ACTIVE` de la sonda + sellar `terminalReturnedAt` en los estados admitidos |
| `src/controllers/mobile/terminalPayment.mobile.controller.ts` | La variante en el controlador de `/release` |
| `src/routes/mobile.routes.ts` | El permiso de la variante |
| `src/mcp/tools/terminals.ts` | Despacho antes del filtro exclusivo de `UNKNOWN` |
| `tests/unit/services/tpv/unchargedReconciliation.test.ts` | **NUEVO.** El veto, la idempotencia, la elegibilidad |
| `tests/integration/tpv/unchargedReconciliation.integration.test.ts` | **NUEVO.** Contra Postgres real: el CAS y los dos candados liberados |

---

## Etapa 1 — servidor y MCP (riesgo cero: nadie en la calle lo llama)

### Task 1: La columna y el permiso

**Files:**
- Modify: `prisma/schema.prisma` (modelo `TerminalPaymentRequest`)
- Create: `prisma/migrations/<timestamp>_operator_reconciliation/migration.sql`
- Modify: `src/lib/permissions.ts`
- Test: `tests/unit/lib/permissions.reconcileUncharged.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: la columna `TerminalPaymentRequest.operatorReconciliation` (Json, nullable) y la constante de permiso `'payments:reconcile-uncharged'`.

- [ ] **Step 1: Escribir la prueba que falla — el cajero tiene el permiso, y el de gerencia NO cambió**

Crear `tests/unit/lib/permissions.reconcileUncharged.test.ts`:

```typescript
import { StaffRole } from '@prisma/client'
import { hasPermission, DEFAULT_PERMISSIONS } from '@/lib/permissions'

describe('payments:reconcile-uncharged', () => {
  it('lo tiene el CAJERO: es quien está frente a la terminal cuando pasa', () => {
    expect(hasPermission(StaffRole.CASHIER, null, 'payments:reconcile-uncharged')).toBe(true)
  })

  it('lo tienen también MANAGER, ADMIN y OWNER', () => {
    for (const rol of [StaffRole.MANAGER, StaffRole.ADMIN, StaffRole.OWNER]) {
      expect(hasPermission(rol, null, 'payments:reconcile-uncharged')).toBe(true)
    }
  })

  it('NO se lo concede a WAITER ni a VIEWER', () => {
    for (const rol of [StaffRole.WAITER, StaffRole.VIEWER]) {
      expect(hasPermission(rol, null, 'payments:reconcile-uncharged')).toBe(false)
    }
  })

  it('🔴 NO toca el permiso de gerencia que ya existe: el cajero sigue SIN poder declarar «no se presentó tarjeta»', () => {
    expect(hasPermission(StaffRole.CASHIER, null, 'payments:resolve-no-instrument')).toBe(false)
  })

  it('🔴 NO le concede tpv:update al cajero (liberar terminales sigue siendo de gerencia)', () => {
    expect(hasPermission(StaffRole.CASHIER, null, 'tpv:update')).toBe(false)
  })

  it('aparece en el catálogo individual para poder asignarse por rol personalizado', () => {
    const { INDIVIDUAL_PERMISSIONS_BY_RESOURCE } = require('@/lib/permissions')
    const dePagos = INDIVIDUAL_PERMISSIONS_BY_RESOURCE.payments ?? []
    expect(dePagos.some((p: any) => (typeof p === 'string' ? p : p.key) === 'payments:reconcile-uncharged')).toBe(true)
  })
})
```

- [ ] **Step 2: Correrla y verla fallar**

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npx jest --selectProjects unit --testPathPattern "permissions.reconcileUncharged" --ci
```

Esperado: **FAIL** — las primeras dos pruebas fallan porque el permiso no existe todavía.

- [ ] **Step 3: Agregar el permiso a `src/lib/permissions.ts`**

En `DEFAULT_PERMISSIONS`, bloque `[StaffRole.CASHIER]`, junto a los otros `payments:*` del cajero:

```typescript
    // 🔴 El cajero SÍ declara «revisé la terminal y no se cobró» — decisión del founder (18-sep): en un
    // mostrador a las 10 de la mañana puede no haber gerente, y esperar a uno es volver a estar parado.
    // NO es el mismo permiso que `payments:resolve-no-instrument` (gerencia): aquél afirma que nadie
    // presentó tarjeta; éste, que el cajero MIRÓ la pantalla del aparato y no hubo cobro.
    'payments:reconcile-uncharged',
```

En los bloques `[StaffRole.MANAGER]`, `[StaffRole.ADMIN]` y `[StaffRole.OWNER]`, junto a `payments:resolve-no-instrument`:

```typescript
    'payments:reconcile-uncharged', // el cajero también lo tiene; explícito para que la lista se lea sin expandir el comodín
```

Y en `INDIVIDUAL_PERMISSIONS_BY_RESOURCE`, recurso `payments`, siguiendo el formato exacto de las entradas vecinas del archivo (copiar la forma de `payments:resolve-no-instrument`).

- [ ] **Step 4: Correr y ver pasar**

```bash
npx jest --selectProjects unit --testPathPattern "permissions.reconcileUncharged" --ci
```

Esperado: **PASS**, 6/6.

- [ ] **Step 5: Agregar la columna al schema**

En `prisma/schema.prisma`, modelo `TerminalPaymentRequest`, justo después de `collisionEvidenceCursor`:

```prisma
  /// La declaración del cajero «revisé la terminal y NO se cobró» (18-sep). Columna PROPIA y no una llave de
  /// `resultJson` por la misma razón que `collisionEvidenceCursor`: ese sobre se devuelve entero al POS y varios
  /// escritores lo reemplazan completo. Y no vive en `TerminalPaymentAttemptLink` porque ese vínculo EXIGE un intento
  /// ligado, y las filas legacy —las que hay que limpiar hoy— no lo tienen. Inmutable: se escribe una vez; un replay
  /// con el mismo `resolutionId` y el mismo cuerpo devuelve la guardada sin reescribir nada.
  operatorReconciliation Json?
```

- [ ] **Step 6: Generar la migración**

```bash
npx prisma migrate dev --name operator_reconciliation
```

Verificar que el SQL generado es **sólo** `ALTER TABLE "TerminalPaymentRequest" ADD COLUMN "operatorReconciliation" JSONB;` — aditivo, sin `NOT NULL`, sin default, sin tocar datos. Si la migración trae cualquier otra sentencia, **parar**: significa que el schema local tiene deriva de otra sesión.

- [ ] **Step 7: Regenerar el mapa del schema (obligatorio en el MISMO cambio)**

```bash
npm run schema:map
```

- [ ] **Step 8: Commit**

```bash
git commit -- prisma/schema.prisma prisma/migrations docs/SCHEMA_MAP.md src/lib/permissions.ts tests/unit/lib/permissions.reconcileUncharged.test.ts
git show --stat HEAD
```

Mensaje:
```
feat(cobro): permiso del cajero y columna para la conciliacion declarada

El cajero declara «revise la terminal y no se cobro» con permiso propio
(payments:reconcile-uncharged), que NO es el de gerencia y NO concede
tpv:update. La declaracion se guarda en columna propia, no en resultJson
(varios escritores lo reemplazan entero) ni en el vinculo del intento
(las filas legacy no tienen intento ligado).

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
```

🔴 Verificar con `git show --stat` que entraron **sólo** esos archivos: el índice es compartido.

---

### Task 2: La sonda deja constancia durable de `ACTIVE`

**Por qué va antes del servicio:** el spec veta la declaración si la terminal reporta que el cobro **sigue corriendo**. Hoy esa respuesta sólo se escribe en el log y la función retorna (`terminal-payment.service.ts:6321`): no queda ningún dato que la declaración pueda consultar. Sin esta tarea el veto del spec es una promesa vacía.

**Files:**
- Modify: `src/services/terminal-payment.service.ts` (el manejador de la respuesta de la sonda, alrededor de `:6321`)
- Test: `tests/unit/services/tpv/sondaActiva.test.ts`

**Interfaces:**
- Consumes: la columna `operatorReconciliation` de la Task 1 **no**; esta tarea escribe en `resultJson.probeActiveAt` (el sobre ya se conserva y esta llave es aditiva).
- Produces: `resultJson.probeActiveAt` (ISO string) en la fila cuya sonda contestó `ACTIVE`, y el helper exportado `sondaReportoActiva(row, ahora, ventanaMs): boolean`.

- [ ] **Step 1: Escribir la prueba que falla**

Crear `tests/unit/services/tpv/sondaActiva.test.ts`:

```typescript
import { sondaReportoActiva, VENTANA_SONDA_ACTIVA_MS } from '@/services/terminal-payment.service'

const ahora = new Date('2026-09-18T16:30:00.000Z')

describe('sondaReportoActiva', () => {
  it('una sonda ACTIVE reciente veta: el cobro sigue corriendo en la terminal', () => {
    const row = { resultJson: { probeActiveAt: '2026-09-18T16:29:30.000Z' } }
    expect(sondaReportoActiva(row, ahora, VENTANA_SONDA_ACTIVA_MS)).toBe(true)
  })

  it('una sonda ACTIVE VIEJA ya no veta: si siguiera corriendo, la sonda lo habría vuelto a decir', () => {
    const row = { resultJson: { probeActiveAt: '2026-09-18T15:00:00.000Z' } }
    expect(sondaReportoActiva(row, ahora, VENTANA_SONDA_ACTIVA_MS)).toBe(false)
  })

  it('sin sonda no veta (la mayoría de las filas legacy)', () => {
    expect(sondaReportoActiva({ resultJson: {} }, ahora, VENTANA_SONDA_ACTIVA_MS)).toBe(false)
    expect(sondaReportoActiva({ resultJson: null }, ahora, VENTANA_SONDA_ACTIVA_MS)).toBe(false)
  })

  it('🔴 una fecha basura NO se lee como «no veta»: falla CERRADO', () => {
    expect(sondaReportoActiva({ resultJson: { probeActiveAt: 'ayer' } }, ahora, VENTANA_SONDA_ACTIVA_MS)).toBe(true)
    expect(sondaReportoActiva({ resultJson: { probeActiveAt: 12345 } }, ahora, VENTANA_SONDA_ACTIVA_MS)).toBe(true)
  })

  it('un resultJson que no es objeto no revienta', () => {
    expect(sondaReportoActiva({ resultJson: ['x'] as any }, ahora, VENTANA_SONDA_ACTIVA_MS)).toBe(false)
  })
})
```

- [ ] **Step 2: Correrla y verla fallar**

```bash
npx jest --selectProjects unit --testPathPattern "sondaActiva" --ci
```

Esperado: **FAIL** con `sondaReportoActiva is not a function`.

- [ ] **Step 3: Implementar el helper y la escritura**

En `src/services/terminal-payment.service.ts`, junto a los demás helpers exportados del módulo:

```typescript
/** 15 min: si el cobro siguiera corriendo, la sonda —que se manda al conectar y en cada barrido— lo habría repetido. */
export const VENTANA_SONDA_ACTIVA_MS = 15 * 60 * 1000

/**
 * ¿La propia terminal dijo hace poco que ESTE cobro sigue ejecutándose? Es el único veto que no viene del dinero
 * sino de la ejecución. 🔴 Falla CERRADO: una marca ilegible se trata como «sigue activo», porque la alternativa
 * —dejar declarar encima de un cobro en curso— es la que produce el cobro doble.
 */
export function sondaReportoActiva(
  row: { resultJson?: unknown },
  ahora: Date,
  ventanaMs: number = VENTANA_SONDA_ACTIVA_MS,
): boolean {
  const sobre = row.resultJson && typeof row.resultJson === 'object' && !Array.isArray(row.resultJson)
    ? (row.resultJson as Record<string, unknown>)
    : null
  if (!sobre) return false
  const marca = sobre.probeActiveAt
  if (marca === undefined || marca === null) return false
  if (typeof marca !== 'string') return true
  const t = Date.parse(marca)
  if (Number.isNaN(t)) return true
  return ahora.getTime() - t < ventanaMs
}
```

Y en el manejador de la respuesta de la sonda (donde hoy se registra `ACTIVE` y la función retorna, `:6321`), **antes** del `return`, sellar la marca sin tocar el estado ni `updatedAt`:

```typescript
      // La respuesta ACTIVE deja constancia DURABLE: es lo que la declaración del cajero consulta para no
      // escribir encima de un cobro que sigue corriendo. Sin estado ni `updatedAt`: es contabilidad, no desenlace.
      await prisma.$executeRaw`
        UPDATE "TerminalPaymentRequest"
        SET "resultJson" = coalesce("resultJson", '{}'::jsonb) || jsonb_build_object('probeActiveAt', ${new Date().toISOString()})
        WHERE "requestId" = ${requestId} AND "venueId" = ${venueId}`
```

⚠️ Antes de escribir el `UPDATE`, **leer las 30 líneas alrededor de `:6321`** y usar los nombres de variable que ya existen en ese scope (`requestId`/`venueId` pueden llamarse distinto). No inventar nombres.

- [ ] **Step 4: Correr y ver pasar**

```bash
npx jest --selectProjects unit --testPathPattern "sondaActiva" --ci
```

Esperado: **PASS**, 5/5.

- [ ] **Step 5: Sabotaje — romperlo a propósito**

Cambiar `if (Number.isNaN(t)) return true` por `return false` y correr la suite: **debe caer** la prueba «falla CERRADO». Revertir el sabotaje.

- [ ] **Step 6: Commit**

```bash
git commit -- src/services/terminal-payment.service.ts tests/unit/services/tpv/sondaActiva.test.ts
git show --stat HEAD
```

---

### Task 3: El servicio de conciliación declarada

**Files:**
- Create: `src/services/tpv/uncharged-reconciliation.service.ts`
- Test: `tests/unit/services/tpv/unchargedReconciliation.test.ts`

**Interfaces:**
- Consumes: `candadoDeSolicitud` y `OPCIONES_DE_TRANSACCION_DEL_INTENTO` de `./candadoDeIntento`; `sinEvidenciaPositivaSql`, `hayEvidenciaDeConciliacionSql` y `porQueHayEvidenciaPositiva` de `./evidenciaPositivaSql`; `desenlaceCanonico` y `sondaReportoActiva` de `../terminal-payment.service` (import dinámico, como hace el precedente, para no cerrar un ciclo).
- Produces:
  - `export const RECONCILE_UNCHARGED_PERMISSION = 'payments:reconcile-uncharged'`
  - `export type UnchargedReconciliation = { id: string; kind: 'UNCHARGED_VERIFIED'; acceptedAt: string; bodyHash: string; staffId: string; staffVenueId: string; statementVersion: number; previousRequest: { status: string; failureCode: string | null } }`
  - `export function readUnchargedReconciliation(value: unknown): UnchargedReconciliation | null`
  - `export class UnchargedReconciliationError extends Error { code: string; statusCode: number }`
  - `export async function reconcileUncharged(identity: { venueId: string; requestId: string; actorStaffId: string }, raw: unknown): Promise<UnchargedReconciliation>`

- [ ] **Step 1: Escribir las pruebas que fallan**

Crear `tests/unit/services/tpv/unchargedReconciliation.test.ts`. Cubre exactamente lo que el spec exige vetar. Usar el patrón de mocks de `tests/unit/services/tpv/` que ya exista en el repo para `prisma` (leer una suite vecina antes de escribir, y copiar su forma de mockear; no inventar un doble nuevo):

```typescript
import {
  readUnchargedReconciliation,
  UnchargedReconciliationError,
} from '@/services/tpv/uncharged-reconciliation.service'

describe('readUnchargedReconciliation', () => {
  it('reconoce una declaración guardada', () => {
    const guardada = { id: 'a1', kind: 'UNCHARGED_VERIFIED', acceptedAt: '2026-09-18T16:46:00.000Z' }
    expect(readUnchargedReconciliation(guardada)?.id).toBe('a1')
  })

  it('🔴 NO confunde la declaración de gerencia «no se presentó tarjeta» con ésta', () => {
    expect(readUnchargedReconciliation({ id: 'a1', kind: 'NO_INSTRUMENT_PRESENTED' })).toBeNull()
  })

  it('un valor que no es objeto es null, nunca una excepción', () => {
    for (const v of [null, undefined, 'x', 3, ['a']]) expect(readUnchargedReconciliation(v)).toBeNull()
  })
})

describe('UnchargedReconciliationError', () => {
  it('cada código lleva un mensaje que el cajero puede leer, en español', () => {
    const e = new UnchargedReconciliationError('POSITIVE_EVIDENCE_EXISTS')
    expect(e.statusCode).toBe(409)
    expect(e.message).toMatch(/cobro/i)
    expect(e.message).not.toMatch(/[A-Z_]{6,}/) // nunca el código crudo en la cara del cajero
  })
})
```

Y las pruebas de elegibilidad. 🔴 **El montaje se copia de la suite hermana `tests/unit/services/tpv/no-instrument-resolution.service.test.ts`** — mismo `prismaMock` global de `tests/__helpers__/setup.ts`, mismos helpers. Preámbulo:

```typescript
import prisma from '@/utils/prismaClient'
import {
  RECONCILE_UNCHARGED_PERMISSION,
  UnchargedReconciliationError,
  reconcileUncharged,
} from '@/services/tpv/uncharged-reconciliation.service'

const prismaMock = prisma as any

const venueId = 'v1'
const requestId = 'req-1'
const resolutionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const identidad = { venueId, requestId, actorStaffId: 'staff-cashier' }
const declaracion = () => ({ requestId, resolutionId, statement: 'UNCHARGED_VERIFIED', statementVersion: 1 })

/** La fila del incidente: UNKNOWN, la terminal ya volvió, sin Payment y sin evidencia. */
function filaDelIncidente(over: Record<string, unknown> = {}) {
  const ahora = new Date()
  return {
    id: 'row-1',
    requestId,
    venueId,
    terminalId: 'n860w173397',
    orderId: 'order-1',
    amountCents: 6500,
    tipCents: 975,
    status: 'UNKNOWN',
    failureCode: null,
    cancelDisposition: null,
    paymentId: null,
    closedVia: null,
    lateResult: false,
    terminalReturnedAt: ahora,
    operatorReconciliation: null,
    resultJson: { requestId, status: 'timeout' },
    createdAt: ahora,
    updatedAt: ahora,
    ...over,
  }
}

/** Camino feliz por defecto: sin veto, el CAS aplica y devuelve 1. */
beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.$transaction.mockImplementation((fn: any) => fn(prismaMock))
  prismaMock.$queryRaw.mockResolvedValue([])
  prismaMock.$executeRaw.mockResolvedValue(1)
  prismaMock.$executeRawUnsafe.mockResolvedValue(0)
  prismaMock.terminalPaymentRequest.findFirst.mockResolvedValue(filaDelIncidente())
  prismaMock.payment.findFirst.mockResolvedValue(null)
  prismaMock.activityLog.create.mockResolvedValue({})
  prismaMock.staffVenue.findFirst.mockResolvedValue({
    id: 'sv-cashier', staffId: 'staff-cashier', role: 'CASHIER', permissionSetId: null, permissionSet: null,
  })
  prismaMock.venueRolePermission.findUnique.mockResolvedValue(null)
})
```

Las pruebas, cada una con su aserción concreta:

```typescript
describe('reconcileUncharged — camino feliz', () => {
  it('acepta, escribe el desenlace que libera y deja UN asiento de auditoría', async () => {
    const r = await reconcileUncharged(identidad, declaracion())
    expect(r.kind).toBe('UNCHARGED_VERIFIED')
    expect(r.id).toBe(resolutionId)
    expect(r.staffId).toBe('staff-cashier')
    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(1)
    expect(prismaMock.activityLog.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.activityLog.create.mock.calls[0][0].data.action)
      .toBe('TERMINAL_PAYMENT_OPERATOR_RECONCILED_UNCHARGED')
  })

  it('🔴 el CAS escribe EXACTAMENTE el desenlace que sale de los dos candados', async () => {
    await reconcileUncharged(identidad, declaracion())
    const sql = JSON.stringify(prismaMock.$executeRaw.mock.calls[0])
    expect(sql).toContain('FAILED')
    expect(sql).toContain('OPERATOR_RECONCILED_NO_CHARGE')
    expect(sql).toContain('cancelDisposition')
  })

  it('toma el candado POR SOLICITUD (no por intento): una fila legacy sin vínculo es elegible', async () => {
    await reconcileUncharged(identidad, declaracion())
    expect(prismaMock.$executeRawUnsafe).toHaveBeenCalled() // SET LOCAL lock_timeout del candado
    expect(prismaMock.terminalPaymentAttemptLink?.findUnique ?? jest.fn()).not.toHaveBeenCalled()
  })
})

describe('reconcileUncharged — lo que VETA la declaración', () => {
  it('rechaza si hay un Payment ligado a la solicitud', async () => {
    prismaMock.payment.findFirst.mockResolvedValue({ id: 'pay-1' })
    await expect(reconcileUncharged(identidad, declaracion())).rejects.toMatchObject({ code: 'POSITIVE_EVIDENCE_EXISTS' })
    expect(prismaMock.$executeRaw).not.toHaveBeenCalled()
  })

  it('rechaza si la fila ya tiene paymentId', async () => {
    prismaMock.terminalPaymentRequest.findFirst.mockResolvedValue(filaDelIncidente({ paymentId: 'pay-9' }))
    await expect(reconcileUncharged(identidad, declaracion())).rejects.toMatchObject({ code: 'POSITIVE_EVIDENCE_EXISTS' })
  })

  it('🔴 rechaza si la SONDA dijo hace poco que el cobro sigue corriendo', async () => {
    prismaMock.terminalPaymentRequest.findFirst.mockResolvedValue(
      filaDelIncidente({ resultJson: { requestId, probeActiveAt: new Date().toISOString() } }),
    )
    await expect(reconcileUncharged(identidad, declaracion())).rejects.toMatchObject({ code: 'EXECUTION_STILL_ACTIVE' })
    expect(prismaMock.$executeRaw).not.toHaveBeenCalled()
  })

  it('🔴 rechaza si la terminal TODAVÍA no ha vuelto', async () => {
    prismaMock.terminalPaymentRequest.findFirst.mockResolvedValue(filaDelIncidente({ terminalReturnedAt: null }))
    await expect(reconcileUncharged(identidad, declaracion())).rejects.toMatchObject({ code: 'TERMINAL_NOT_BACK' })
  })

  it('🔴 rechaza una fila RETENIDA por el banco', async () => {
    prismaMock.terminalPaymentRequest.findFirst.mockResolvedValue(
      filaDelIncidente({ status: 'TIMED_OUT', failureCode: 'BANK_APPROVED_AWAITING_PAYMENT' }),
    )
    await expect(reconcileUncharged(identidad, declaracion())).rejects.toMatchObject({ code: 'POSITIVE_EVIDENCE_EXISTS' })
  })

  it('🔴 rechaza una fila con desenlace YA acreditado', async () => {
    prismaMock.terminalPaymentRequest.findFirst.mockResolvedValue(
      filaDelIncidente({ status: 'COMPLETED', paymentId: null, failureCode: null }),
    )
    await expect(reconcileUncharged(identidad, declaracion())).rejects.toMatchObject({ code: 'ATTEMPT_NOT_ELIGIBLE' })
  })

  it('🔴 rechaza una fila PENDING (el cobro ni siquiera salió)', async () => {
    prismaMock.terminalPaymentRequest.findFirst.mockResolvedValue(filaDelIncidente({ status: 'PENDING' }))
    await expect(reconcileUncharged(identidad, declaracion())).rejects.toMatchObject({ code: 'ATTEMPT_NOT_ELIGIBLE' })
  })

  it('🔴 un CAS que devuelve 0 (apareció evidencia entre el veto y la escritura) NO declara nada', async () => {
    prismaMock.$executeRaw.mockResolvedValue(0)
    await expect(reconcileUncharged(identidad, declaracion())).rejects.toThrow(UnchargedReconciliationError)
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
  })

  it('🔴 una solicitud de OTRO venue no existe para este cajero', async () => {
    prismaMock.terminalPaymentRequest.findFirst.mockResolvedValue(null)
    await expect(reconcileUncharged(identidad, declaracion())).rejects.toMatchObject({ code: 'ATTEMPT_NOT_FOUND', statusCode: 404 })
  })

  it('🔴 sin el permiso efectivo no se acepta, aunque el cuerpo venga perfecto', async () => {
    prismaMock.staffVenue.findFirst.mockResolvedValue({
      id: 'sv-waiter', staffId: 'staff-waiter', role: 'WAITER', permissionSetId: null, permissionSet: null,
    })
    await expect(
      reconcileUncharged({ ...identidad, actorStaffId: 'staff-waiter' }, declaracion()),
    ).rejects.toMatchObject({ statusCode: 403 })
    expect(prismaMock.$executeRaw).not.toHaveBeenCalled()
  })

  it('🔴 quien no es miembro ACTIVO del venue no declara', async () => {
    prismaMock.staffVenue.findFirst.mockResolvedValue(null)
    await expect(reconcileUncharged(identidad, declaracion())).rejects.toMatchObject({ statusCode: 403 })
  })
})

describe('reconcileUncharged — idempotencia', () => {
  it('🔴 el replay con el MISMO resolutionId y el mismo cuerpo devuelve la guardada SIN reescribir', async () => {
    const primera = await reconcileUncharged(identidad, declaracion())
    jest.clearAllMocks()
    prismaMock.$transaction.mockImplementation((fn: any) => fn(prismaMock))
    prismaMock.$queryRaw.mockResolvedValue([])
    prismaMock.$executeRawUnsafe.mockResolvedValue(0)
    prismaMock.terminalPaymentRequest.findFirst.mockResolvedValue(
      filaDelIncidente({ status: 'FAILED', failureCode: 'OPERATOR_RECONCILED_NO_CHARGE', operatorReconciliation: primera }),
    )
    const segunda = await reconcileUncharged(identidad, declaracion())
    expect(segunda.id).toBe(primera.id)
    expect(segunda.acceptedAt).toBe(primera.acceptedAt)
    expect(prismaMock.$executeRaw).not.toHaveBeenCalled()
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
  })

  it('🔴 OTRO cuerpo bajo el mismo resolutionId es RESOLUTION_CONFLICT', async () => {
    const primera = await reconcileUncharged(identidad, declaracion())
    prismaMock.terminalPaymentRequest.findFirst.mockResolvedValue(
      filaDelIncidente({ status: 'FAILED', operatorReconciliation: { ...primera, bodyHash: 'otro-hash' } }),
    )
    await expect(reconcileUncharged(identidad, declaracion())).rejects.toMatchObject({ code: 'RESOLUTION_CONFLICT' })
  })
})

describe('REGRESIÓN — la identidad nunca sale del cuerpo', () => {
  it('🔴 un staffId en el cuerpo NO se obedece: el actor es el de la sesión', async () => {
    await expect(
      reconcileUncharged(identidad, { ...declaracion(), staffId: 'staff-owner' } as unknown),
    ).rejects.toThrow(UnchargedReconciliationError)
  })

  it('🔴 `reason` y `confirm` NO son una declaración', async () => {
    await expect(
      reconcileUncharged(identidad, { requestId, reason: 'la PAX se reinició', confirm: true } as unknown),
    ).rejects.toThrow(UnchargedReconciliationError)
  })
})
```

- [ ] **Step 2: Correrlas y verlas fallar**

```bash
npx jest --selectProjects unit --testPathPattern "unchargedReconciliation" --ci
```

Esperado: **FAIL** — el módulo no existe.

- [ ] **Step 3: Implementar el servicio**

Crear `src/services/tpv/uncharged-reconciliation.service.ts`. **Leer primero `src/services/tpv/no-instrument-resolution.service.ts` completo** y seguir su estructura literalmente, con estas seis diferencias, que son el encargo:

1. **Se identifica por SOLICITUD, no por intento.** Candado `candadoDeSolicitud(tx, requestId)` (no `candadoDeIntento`), y ninguna lectura de `TerminalPaymentAttemptLink` es obligatoria: una solicitud legacy sin vínculo es elegible.
2. **La declaración se guarda en `TerminalPaymentRequest.operatorReconciliation`**, no en el vínculo.
3. **El actor es el POS**, no la terminal: `identity.actorStaffId` viene del `authContext` de la ruta móvil y el permiso es `RECONCILE_UNCHARGED_PERMISSION`. La autorización reusa la MISMA regla efectiva que `miembroDelVenue` del precedente — **copiar esa función**, cambiando sólo la constante del permiso (es una regla de permisos, no una abstracción que valga la pena compartir entre dos archivos que evolucionan aparte).
4. **Estados admitidos:** `UNKNOWN` y `TIMED_OUT`. La elegibilidad exige `desenlaceCanonico(row).outcome === 'UNRESOLVED'`, `row.status !== 'PENDING'`, y que el `failureCode` **no** sea `BANK_APPROVED_AWAITING_PAYMENT` ni `PAYMENT_UNBOUND_AWAITING_REVIEW`.
5. **Exige que la terminal haya vuelto:** `row.terminalReturnedAt !== null`. (La Task 4 hace que eso también se selle en `TIMED_OUT`; hasta entonces, una fila `TIMED_OUT` legacy responde `TERMINAL_SIN_REGRESAR`, que es el comportamiento correcto y seguro.)
6. **Veta también por `sondaReportoActiva(row, new Date())`** y por `hayEvidenciaDeConciliacionSql(requestId, venueId)`, además del veto compartido `sinEvidenciaPositivaSql` en el CAS.

El CAS final, calcado del precedente:

```typescript
    const sobreDeclarado = {
      ...sobre,
      requestId,
      status: 'failed',
      outcomeEvidence: 'OPERATOR_RECONCILED',
      // 🔴 Mensaje PROPIO: el de gerencia dice «no se presentó tarjeta», que aquí sería falso — el cliente
      // sí presentó la tarjeta; lo que no hubo fue cobro. Los POS pintan ESTE texto, no uno hardcodeado.
      errorMessage: 'El cajero revisó la terminal y confirmó que este cobro no pasó. Se puede volver a cobrar.',
      operatorReconciliation: saved,
    }
    const cas = await tx.$executeRaw`
      UPDATE "TerminalPaymentRequest"
      SET "status" = 'FAILED', "failureCode" = 'OPERATOR_RECONCILED_NO_CHARGE', "cancelDisposition" = NULL,
          "resultJson" = ${JSON.stringify(sobreDeclarado)}::jsonb,
          "operatorReconciliation" = ${JSON.stringify(saved)}::jsonb,
          "updatedAt" = (NOW() AT TIME ZONE 'UTC')
      WHERE "id" = ${row.id} AND "status" = ${row.status}::"TerminalPaymentRequestStatus" AND "paymentId" IS NULL
        AND ${sinEvidenciaPositivaSql(requestId, identity.venueId)}
        AND NOT ${hayEvidenciaDeConciliacionSql(requestId, identity.venueId)}`
    if (cas !== 1) {
      const motivo = await porQueHayEvidenciaPositiva(tx, requestId, identity.venueId)
      throw new UnchargedReconciliationError(motivo === 'NINGUNA' ? 'ATTEMPT_NOT_ELIGIBLE' : 'POSITIVE_EVIDENCE_EXISTS')
    }
```

Y el asiento de auditoría, **dentro** de la transacción:

```typescript
    await tx.activityLog.create({
      data: {
        action: 'TERMINAL_PAYMENT_OPERATOR_RECONCILED_UNCHARGED',
        entity: 'TerminalPaymentRequest',
        entityId: row.id,
        venueId: identity.venueId,
        staffId: actor.staffId,
        data: { requestId, terminalId: row.terminalId, orderId: row.orderId, resolutionId: saved.id, source },
      },
    })
```

- [ ] **Step 4: Correr y ver pasar**

```bash
npx jest --selectProjects unit --testPathPattern "unchargedReconciliation" --ci
```

Esperado: **PASS**, todas.

- [ ] **Step 5: Tres sabotajes, cada uno cazado por su prueba**

| Sabotaje | Prueba que DEBE caer |
|---|---|
| Quitar `AND NOT ${hayEvidenciaDeConciliacionSql(...)}` del CAS | «evidencia de conciliación» |
| Quitar la comprobación de `terminalReturnedAt` | «la terminal todavía no ha vuelto» |
| Devolver la declaración guardada sin comparar `bodyHash` | «otro cuerpo bajo el mismo resolutionId» |

Aplicar uno, correr, comprobar que cae **exactamente** ésa, revertir. Si un sabotaje **no** tumba ninguna prueba, la prueba está pasando por el motivo equivocado: arreglarla antes de seguir.

- [ ] **Step 6: Commit**

```bash
git commit -- src/services/tpv/uncharged-reconciliation.service.ts tests/unit/services/tpv/unchargedReconciliation.test.ts
git show --stat HEAD
```

---

### Task 4: `terminalReturnedAt` también en los estados admitidos

**Por qué:** hoy sólo se sella sobre filas `UNKNOWN` (`terminal-payment.service.ts:5189`). Una `TIMED_OUT` todavía incierta quedaría **inelegible para siempre** aunque la terminal esté conectada — y ésas son justo las filas legacy que hay que poder limpiar.

**Files:**
- Modify: `src/services/terminal-payment.service.ts` (alrededor de `:5189`)
- Test: `tests/integration/tpv/terminalReturnedAt.integration.test.ts`

**Interfaces:**
- Consumes: nada nuevo.
- Produces: `terminalReturnedAt` sellado también en filas `TIMED_OUT` cuyo desenlace siga `UNRESOLVED`.

- [ ] **Step 1: Escribir la prueba de integración que falla**

Contra Postgres real (necesita `TEST_DATABASE_URL`). Sembrar dos filas de la misma terminal —una `UNKNOWN`, una `TIMED_OUT` sin desenlace acreditado— simular un latido posterior a `expiresAt`, y afirmar que **las dos** quedan con `terminalReturnedAt`. Añadir una tercera fila `COMPLETED` y afirmar que **no** se toca.

- [ ] **Step 2: Correrla y verla fallar**

```bash
npx jest --selectProjects integration --testPathPattern "terminalReturnedAt" --ci
```

Esperado: **FAIL** — la fila `TIMED_OUT` queda con `terminalReturnedAt` en null.

- [ ] **Step 3: Ampliar el sellado**

Leer las 40 líneas alrededor de `:5189` y ampliar el `where` del `updateMany` para incluir `TIMED_OUT`, conservando **intactas** las demás condiciones (terminal, `expiresAt`, `terminalReturnedAt: null`). Comentario obligatorio:

```typescript
      // 18-sep: también TIMED_OUT. La marca es diagnóstica —acredita CONECTIVIDAD, nunca que la ejecución
      // terminó— y es el requisito de elegibilidad de la declaración del cajero. Sin esto, una fila TIMED_OUT
      // legacy sería ineligible para siempre, que son justo las que hay que poder limpiar.
```

- [ ] **Step 4: Correr y ver pasar**

```bash
npx jest --selectProjects integration --testPathPattern "terminalReturnedAt" --ci
```

- [ ] **Step 5: Commit**

```bash
git commit -- src/services/terminal-payment.service.ts tests/integration/tpv/terminalReturnedAt.integration.test.ts
```

---

### Task 5: El despacho — ruta móvil y `releaseUnknownRequest`

**Files:**
- Modify: `src/services/terminal-payment.service.ts` (`releaseUnknownRequest`, `:5396`)
- Modify: `src/controllers/mobile/terminalPayment.mobile.controller.ts`
- Modify: `src/routes/mobile.routes.ts:1704`
- Test: `tests/integration/tpv/unchargedReconciliation.integration.test.ts`

**Interfaces:**
- Consumes: `reconcileUncharged` de la Task 3.
- Produces: el contrato HTTP de la variante — `POST /mobile/venues/:venueId/terminal-payment/:requestId/release` con cuerpo `{ statement: 'UNCHARGED_VERIFIED', statementVersion: 1, resolutionId: <uuid> }` responde `{ requestId, released: true, status: 'FAILED', outcome: 'NOT_CHARGED', outcomeEvidence: 'OPERATOR_RECONCILED', resolution: { id, acceptedAt } }`.

- [ ] **Step 1: Escribir la prueba de integración que falla**

Contra Postgres real y con Express real (supertest), el escenario del incidente entero:

```typescript
it('🔴 el escenario de Testarudo: una fila UNKNOWN con la terminal de vuelta se declara y LIBERA LOS DOS CANDADOS', async () => {
  const fila = await sembrarSolicitud({
    status: 'UNKNOWN',
    terminalReturnedAt: new Date(),
    amountCents: 6500,
    tipCents: 975,
    orderId: orden.id,
  })

  const res = await request(app)
    .post(`/api/v1/mobile/venues/${venueId}/terminal-payment/${fila.requestId}/release`)
    .set('Authorization', `Bearer ${tokenDelCajero}`)
    .send({ statement: 'UNCHARGED_VERIFIED', statementVersion: 1, resolutionId: crypto.randomUUID() })

  expect(res.status).toBe(200)
  expect(res.body).toMatchObject({ released: true, status: 'FAILED' })
  expect(res.body.resolution?.id).toBeTruthy()

  const despues = await prisma.terminalPaymentRequest.findUnique({ where: { requestId: fila.requestId } })
  expect(despues).toMatchObject({
    status: 'FAILED',
    failureCode: 'OPERATOR_RECONCILED_NO_CHARGE',
    cancelDisposition: null,
  })
  expect(despues?.operatorReconciliation).toMatchObject({ kind: 'UNCHARGED_VERIFIED' })

  // 🔴 El candado de la RANURA: el índice único parcial ya no la retiene, así que una solicitud nueva
  // en la MISMA terminal se crea sin chocar. Esto es la mitad del incidente.
  await expect(
    prisma.terminalPaymentRequest.create({
      data: { ...datosDeSolicitudNueva(), terminalId: fila.terminalId, venueId, status: 'PENDING' },
    }),
  ).resolves.toBeTruthy()

  // 🔴 El candado de la VENTA: la orden ya no tiene desenlace pendiente que la aparte.
  const bloqueadores = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM "TerminalPaymentRequest"
    WHERE "orderId" = ${orden.id} AND "status" IN ('PENDING','SENT','CANCEL_REQUESTED','UNKNOWN')
      AND "requestId" = ${fila.requestId}`
  expect(Number(bloqueadores[0].n)).toBe(0)

  const asientos = await prisma.activityLog.findMany({
    where: { action: 'TERMINAL_PAYMENT_OPERATOR_RECONCILED_UNCHARGED', entityId: fila.id },
  })
  expect(asientos).toHaveLength(1)
  expect(asientos[0].staffId).toBe(cajero.id)
})

it('🔴 con un Payment ligado NO libera: el dinero manda sobre la palabra del cajero', async () => {
  const fila = await sembrarSolicitud({ status: 'UNKNOWN', terminalReturnedAt: new Date() })
  await sembrarPaymentLigado(fila.requestId)

  const res = await request(app)
    .post(`/api/v1/mobile/venues/${venueId}/terminal-payment/${fila.requestId}/release`)
    .set('Authorization', `Bearer ${tokenDelCajero}`)
    .send({ statement: 'UNCHARGED_VERIFIED', statementVersion: 1, resolutionId: crypto.randomUUID() })

  expect(res.status).toBe(409)
  const despues = await prisma.terminalPaymentRequest.findUnique({ where: { requestId: fila.requestId } })
  expect(despues?.failureCode).not.toBe('OPERATOR_RECONCILED_NO_CHARGE')
})

it('🔴 las llamadas ANTIGUAS de /release, sin declaración, se comportan EXACTAMENTE igual que antes', async () => {
  const fila = await sembrarSolicitud({ status: 'UNKNOWN', terminalReturnedAt: new Date() })
  const res = await request(app)
    .post(`/api/v1/mobile/venues/${venueId}/terminal-payment/${fila.requestId}/release`)
    .set('Authorization', `Bearer ${tokenDelGerente}`)
    .send({ reason: 'la PAX se reinició' })

  expect(res.status).toBe(200)
  expect(res.body).toMatchObject({ released: false, status: 'UNKNOWN' })
  const despues = await prisma.terminalPaymentRequest.findUnique({ where: { requestId: fila.requestId } })
  expect(despues?.status).toBe('UNKNOWN')
  expect(despues?.operatorReconciliation).toBeNull()
})

it('🔴 `reason` y `confirm:true` NO se leen como declaración implícita', async () => {
  const fila = await sembrarSolicitud({ status: 'UNKNOWN', terminalReturnedAt: new Date() })
  const res = await request(app)
    .post(`/api/v1/mobile/venues/${venueId}/terminal-payment/${fila.requestId}/release`)
    .set('Authorization', `Bearer ${tokenDelGerente}`)
    .send({ reason: 'ya revisé, no se cobró', confirm: true })

  expect(res.body.released).toBe(false)
  const despues = await prisma.terminalPaymentRequest.findUnique({ where: { requestId: fila.requestId } })
  expect(despues?.operatorReconciliation).toBeNull()
})

it('un WAITER no puede declarar (403)', async () => {
  const fila = await sembrarSolicitud({ status: 'UNKNOWN', terminalReturnedAt: new Date() })
  const res = await request(app)
    .post(`/api/v1/mobile/venues/${venueId}/terminal-payment/${fila.requestId}/release`)
    .set('Authorization', `Bearer ${tokenDelMesero}`)
    .send({ statement: 'UNCHARGED_VERIFIED', statementVersion: 1, resolutionId: crypto.randomUUID() })

  expect(res.status).toBe(403)
})

it('🔴 una solicitud de OTRO negocio responde 404, nunca la toca', async () => {
  const ajena = await sembrarSolicitudEnOtroVenue()
  const res = await request(app)
    .post(`/api/v1/mobile/venues/${venueId}/terminal-payment/${ajena.requestId}/release`)
    .set('Authorization', `Bearer ${tokenDelCajero}`)
    .send({ statement: 'UNCHARGED_VERIFIED', statementVersion: 1, resolutionId: crypto.randomUUID() })

  expect(res.status).toBe(404)
  const despues = await prisma.terminalPaymentRequest.findUnique({ where: { requestId: ajena.requestId } })
  expect(despues?.status).toBe('UNKNOWN')
})
```

⚠️ Los helpers `sembrarSolicitud`, `sembrarPaymentLigado`, `datosDeSolicitudNueva` y los tokens por rol se copian de la suite de integración de terminal-payment que ya exista en `tests/integration/tpv/` — **leerla primero**; no inventar un montaje nuevo.

- [ ] **Step 2: Correrlas y verlas fallar**

```bash
npx jest --selectProjects integration --testPathPattern "unchargedReconciliation" --ci
```

- [ ] **Step 3: Despachar en `releaseUnknownRequest`**

En `src/services/terminal-payment.service.ts`, dentro de `releaseUnknownRequest`, **después** de `const row = await prisma.terminalPaymentRequest.findFirst(...)` y su `if (!row)`, y **antes** del filtro `if (row.status !== TerminalPaymentRequestStatus.UNKNOWN)`:

```typescript
    // 🔴 La variante declarada va ANTES del filtro exclusivo de UNKNOWN: una fila TIMED_OUT todavía incierta
    // también aparta la terminal, y es la que más abunda entre las legacy. Sin declaración, todo sigue igual.
    if (input.declaration) {
      const { reconcileUncharged } = await import('./tpv/uncharged-reconciliation.service')
      const resolution = await reconcileUncharged(
        { venueId, requestId, actorStaffId: actor.staffId ?? '' },
        input.declaration,
      )
      const fresh = await prisma.terminalPaymentRequest.findFirst({ where: { requestId, venueId } })
      return {
        requestId,
        released: true,
        status: fresh?.status ?? TerminalPaymentRequestStatus.FAILED,
        resolution: { id: resolution.id, acceptedAt: resolution.acceptedAt },
      }
    }
```

y ampliar la firma de `input` con `declaration?: unknown` y el tipo de retorno con `resolution?: { id: string; acceptedAt: string }`.

- [ ] **Step 4: Pasar la declaración desde el controlador y la ruta**

En el controlador, leer el cuerpo y pasarlo **sólo** si trae `statement`; nunca derivarlo de `reason` ni de `confirm`. En `mobile.routes.ts:1704`, sustituir el `checkPermission('tpv:update')` fijo por un middleware que elija el permiso según el cuerpo, con el patrón que la propia `permissions-policy.md` del repo prescribe para endpoints con sub-acciones:

```typescript
/**
 * 🔴 Dos acciones por una ruta: liberar a secas sigue siendo de gerencia (`tpv:update`); DECLARAR que no
 * se cobró es del cajero (`payments:reconcile-uncharged`). Se elige por el cuerpo YA VALIDADO, nunca por
 * un campo libre — es exactamente el patrón de `checkCommandTypePermission` de la política de permisos.
 */
const permisoDeLiberacion = (req: Request, res: Response, next: NextFunction) => {
  const declara = (req.body as { statement?: unknown } | undefined)?.statement === 'UNCHARGED_VERIFIED'
  return checkPermission(declara ? 'payments:reconcile-uncharged' : 'tpv:update')(req, res, next)
}
```

- [ ] **Step 5: Correr y ver pasar**

```bash
npx jest --selectProjects integration --testPathPattern "unchargedReconciliation" --ci
```

- [ ] **Step 6: Verificación pesada**

Desde el root del workspace:

```bash
cd /Users/amieva/Documents/Programming/Avoqado
./scripts/avq-verify.sh avoqado-server npm run typecheck
AVQ_KEEP=1 ./scripts/avq-verify.sh avoqado-server npx jest --selectProjects unit --testPathPattern "terminal-payment|unchargedReconciliation|sondaActiva" --ci
```

Leer el CUERPO: `errores TS: 0` y los totales `Test Suites:` / `Tests:`. Un `exit=0` con salida vacía **no es verde**.

- [ ] **Step 7: Commit**

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
git commit -- src/services/terminal-payment.service.ts src/controllers/mobile/terminalPayment.mobile.controller.ts src/routes/mobile.routes.ts tests/integration/tpv/unchargedReconciliation.integration.test.ts
git show --stat HEAD
```

---

### Task 6: El tool del MCP

**Files:**
- Modify: `src/mcp/tools/terminals.ts` (`release_terminal_payment`, `:482`–`:540`)
- Test: `tests/unit/mcp-customer/releaseTerminalPayment.test.ts`

**Interfaces:**
- Consumes: `reconcileUncharged` de la Task 3.
- Produces: el parámetro `verifiedUncharged?: boolean` en el tool, en dos pasos como el resto.

- [ ] **Step 1: Escribir la prueba que falla**

```typescript
it('🔴 con verifiedUncharged SIN confirm devuelve vista previa y NO escribe', async () => {
  const r = await invocarTool('release_terminal_payment', { venueId, requestId, verifiedUncharged: true })
  const cuerpo = JSON.parse(r.content[0].text)
  expect(cuerpo).toMatchObject({ ok: false, requiresConfirmation: true })
  expect(cuerpo.amount).toBe(74.75) // PESOS, nunca centavos
  expect(prismaMock.$executeRaw).not.toHaveBeenCalled()
})

it('con verifiedUncharged + confirm declara y libera', async () => {
  const r = await invocarTool('release_terminal_payment', {
    venueId, requestId, verifiedUncharged: true, confirm: true, reason: 'revisé la N86 y no cobró',
  })
  const cuerpo = JSON.parse(r.content[0].text)
  expect(cuerpo).toMatchObject({ ok: true, released: true, status: 'FAILED' })
})

it('🔴 una fila TIMED_OUT ya NO rebota con «sólo se libera un cobro en UNKNOWN» cuando se declara', async () => {
  prismaMock.terminalPaymentRequest.findFirst.mockResolvedValue(filaMcp({ status: 'TIMED_OUT' }))
  const r = await invocarTool('release_terminal_payment', { venueId, requestId, verifiedUncharged: true, confirm: true })
  const cuerpo = JSON.parse(r.content[0].text)
  expect(cuerpo.error ?? '').not.toMatch(/sólo se libera un cobro en UNKNOWN/i)
})

it('sin verifiedUncharged, una fila TIMED_OUT sigue rebotando EXACTAMENTE igual que hoy', async () => {
  prismaMock.terminalPaymentRequest.findFirst.mockResolvedValue(filaMcp({ status: 'TIMED_OUT' }))
  const r = await invocarTool('release_terminal_payment', { venueId, requestId, confirm: true })
  const cuerpo = JSON.parse(r.content[0].text)
  expect(cuerpo.ok).toBe(false)
  expect(cuerpo.error).toMatch(/UNKNOWN/)
})

it('🔴 un token de SÓLO LECTURA no puede declarar', async () => {
  await expect(
    invocarToolConScope(scopeDeSoloLectura, 'release_terminal_payment', {
      venueId, requestId, verifiedUncharged: true, confirm: true,
    }),
  ).rejects.toThrow()
})

it('🔴 sin el permiso del cajero la declaración no pasa por el MCP', async () => {
  await expect(
    invocarToolConScope(scopeSinPermisos, 'release_terminal_payment', {
      venueId, requestId, verifiedUncharged: true, confirm: true,
    }),
  ).rejects.toThrow()
})
```

⚠️ `invocarTool`, `invocarToolConScope` y los scopes se copian de la suite de tools del MCP que ya exista en `tests/unit/mcp-customer/` — **leerla primero**.

- [ ] **Step 2: Correrlas y verlas fallar**

```bash
npx jest --selectProjects unit --testPathPattern "releaseTerminalPayment" --ci
```

- [ ] **Step 3: Implementar**

Añadir el parámetro al esquema del tool:

```typescript
      verifiedUncharged: z
        .boolean()
        .optional()
        .describe('Una PERSONA miró la pantalla de la terminal y confirma que no hubo cobro. Es testimonio, no evidencia del procesador.'),
```

Y **antes** del `if (row.status !== TerminalPaymentRequestStatus.UNKNOWN)` de `:521`, despachar la variante, conservando la vista previa y la confirmación humana. Mantener `requireWriteScopeAlways` y `guard.requirePermission` — para la variante, el permiso pedido es `payments:reconcile-uncharged`.

- [ ] **Step 4: Correr y ver pasar**

```bash
npx jest --selectProjects unit --testPathPattern "releaseTerminalPayment" --ci
```

- [ ] **Step 5: Commit**

```bash
git commit -- src/mcp/tools/terminals.ts tests/unit/mcp-customer/releaseTerminalPayment.test.ts
```

- [ ] **Step 6: Auditoría de Codex ANTES de cerrar la etapa 1**

```bash
codex exec --json --sandbox read-only "Audita el diff completo de la conciliación declarada del cobro sin confirmar contra su spec en docs/superpowers/specs/2026-09-18-conciliacion-operable-del-cobro-sin-confirmar-design.md. Busca en particular: caminos por los que la declaración pueda escribirse encima de dinero, carreras entre el veto y el CAS, y cualquier regresión en el comportamiento de /release sin declaración." -m gpt-6-astra -c model_reasoning_effort=xhigh
```

🔴 Leer el CUERPO de la salida: `codex exec` sale 0 con el error dentro. Cerrar cada P1 antes de pasar a la etapa 2.

---

### Task 7: El aviso al cajero cuando el cobro aparece TARDE

**Por qué:** el spec lo exige y **el mockup aprobado lo dibuja** (tercer artboard), pero hoy no existe: el tratamiento de la aprobación tardía manda `sendOpsAlert`, que es **correo a operaciones**, no un aviso en el aparato (`terminal-payment.service.ts:1448`). Sin esta tarea, el cajero declara, cobra otra vez y **nadie le dice** que el dinero apareció.

**Files:**
- Modify: `src/services/terminal-payment.service.ts` (`avisarAprobacionTardiaTrasVentana`, alrededor de `:1448`)
- Test: `tests/unit/services/tpv/avisoDeAprobacionTardia.test.ts`

**Interfaces:**
- Consumes: la columna `operatorReconciliation` de la Task 1 — sólo se avisa si **hubo** declaración.
- Produces: una `Notification` durable para el venue, tipo `PAYMENT_LATE_AFTER_RECONCILIATION`, con `entityId = TerminalPaymentRequest.id`.

- [ ] **Step 1: Escribir la prueba que falla**

```typescript
import prisma from '@/utils/prismaClient'
import { avisarCobroTardioTrasDeclaracion } from '@/services/terminal-payment.service'

const prismaMock = prisma as any

describe('avisarCobroTardioTrasDeclaracion', () => {
  beforeEach(() => { jest.clearAllMocks(); prismaMock.notification.create.mockResolvedValue({}) })

  it('🔴 avisa en el aparato cuando el dinero aparece SOBRE una declaración del cajero', async () => {
    await avisarCobroTardioTrasDeclaracion({
      requestId: 'req-1', venueId: 'v1', paymentId: 'pay-1', rowId: 'row-1',
      amountCents: 7475, terminalId: 'n86', orderId: 'order-1',
      reconciliation: { id: 'r1', kind: 'UNCHARGED_VERIFIED', staffId: 'staff-cashier' } as any,
    })
    expect(prismaMock.notification.create).toHaveBeenCalledTimes(1)
    const data = prismaMock.notification.create.mock.calls[0][0].data
    expect(data.venueId).toBe('v1')
    expect(data.entityId).toBe('row-1')
    expect(data.message).toMatch(/74\.75/)       // PESOS, no centavos
    expect(data.message).toMatch(/no lo cobres otra vez/i)
  })

  it('NO avisa cuando no hubo declaración: es el camino de siempre, y ése ya tiene su correo a operaciones', async () => {
    await avisarCobroTardioTrasDeclaracion({
      requestId: 'req-1', venueId: 'v1', paymentId: 'pay-1', rowId: 'row-1',
      amountCents: 7475, terminalId: 'n86', orderId: 'order-1', reconciliation: null,
    })
    expect(prismaMock.notification.create).not.toHaveBeenCalled()
  })

  it('🔴 un fallo del aviso NO tumba el registro del dinero', async () => {
    prismaMock.notification.create.mockRejectedValue(new Error('db caída'))
    await expect(
      avisarCobroTardioTrasDeclaracion({
        requestId: 'req-1', venueId: 'v1', paymentId: 'pay-1', rowId: 'row-1',
        amountCents: 7475, terminalId: 'n86', orderId: 'order-1',
        reconciliation: { id: 'r1', kind: 'UNCHARGED_VERIFIED', staffId: 'x' } as any,
      }),
    ).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Correrla y verla fallar**

```bash
npx jest --selectProjects unit --testPathPattern "avisoDeAprobacionTardia" --ci
```

- [ ] **Step 3: Implementar**

Leer primero `avisarAprobacionTardiaTrasVentana` (`:1448`) y **no tocarla**: la función nueva es hermana y se llama desde el mismo punto, después de aquélla. El texto del aviso es el del mockup:

```typescript
      message: `El banco aprobó $${(amountCents / 100).toFixed(2)} de una venta que se había dado por no cobrada. Avoqado ya lo registró: no lo cobres otra vez.`,
```

🔴 Fire-and-forget, fuera de cualquier `$transaction`, con `catch` que sólo registra: un aviso que falla **nunca** puede deshacer el registro del dinero.

- [ ] **Step 4: Correr y ver pasar**

```bash
npx jest --selectProjects unit --testPathPattern "avisoDeAprobacionTardia" --ci
```

- [ ] **Step 5: Commit**

```bash
git commit -- src/services/terminal-payment.service.ts tests/unit/services/tpv/avisoDeAprobacionTardia.test.ts
```

---

## Etapa 2 — el botón en el POS (viaja con el siguiente APK)

🔴 **Regla del workspace: Android e iOS se cambian JUNTOS.** La etapa no se cierra con una sola. Los textos se comparan cadena por cadena entre las dos apps antes de commitear: la divergencia `Atendio/Atendió` del ticket nació exactamente así.

**Los cuatro textos, idénticos en las dos apps** (del mockup aprobado):

| Elemento | Texto exacto |
|---|---|
| Botón | `Ya revisé la terminal: no se cobró` |
| Título del diálogo | `Confirma que no se cobró` |
| Cuerpo del diálogo | `Estás declarando que miraste la pantalla de la terminal y el cobro de $X no pasó. Tu nombre queda en el registro.` |
| Botón de confirmar | `Sí, no se cobró` |
| Botón de cancelar | `Mejor no` |
| Éxito | `Listo, puedes cobrar` |

### Task 8: Android

**Files:**
- Modify: `app/src/main/java/com/avoqado/pos/.../PaymentResultScreen.kt` (`PaymentUndeterminedView`, `:654`)
- Modify: `app/src/main/java/com/avoqado/pos/.../PaymentFlowViewModel.kt`
- Test: la suite del flujo de cobro que ya exista junto al ViewModel (`*PaymentFlowViewModel*Test`)

**Interfaces:**
- Consumes: el contrato HTTP de la Task 5.
- Produces: el parámetro `onDeclararNoCobrado: (() -> Unit)? = null` en `PaymentUndeterminedView` (null = no se ofrece el botón) y `fun declararNoCobrado()` en el ViewModel.

- [ ] **Step 1: Escribir las pruebas que fallan**

```kotlin
@Test
fun `P1 declarar no cobrado libera la venta y permite cobrar otra vez`() = runTest {
    val vm = crearViewModelConCobroSinConfirmar(requestId = "req-1", montoCentavos = 7475)
    coEvery { terminalPaymentRepository.declararNoCobrado(any(), any(), any()) } returns
        Result.success(DeclaracionAceptada(resolutionId = "r1"))

    vm.declararNoCobrado()
    advanceUntilIdle()

    coVerify(exactly = 1) { terminalPaymentRepository.declararNoCobrado("req-1", any(), any()) }
    assertNull(vm.state.value.cobroSinConfirmar)
    assertTrue(vm.state.value.puedeCobrar)
}

@Test
fun `P1 sin conexion la declaracion NO se encola: se pide de nuevo`() = runTest {
    val vm = crearViewModelConCobroSinConfirmar(requestId = "req-1", montoCentavos = 7475)
    coEvery { terminalPaymentRepository.declararNoCobrado(any(), any(), any()) } returns
        Result.failure(java.io.IOException("sin red"))

    vm.declararNoCobrado()
    advanceUntilIdle()

    // 🔴 El cobro sin confirmar SIGUE ahí: una declaración reproducida tarde podría caer sobre una venta que
    // entretanto sí se cobró. Es online-only A PROPÓSITO.
    assertNotNull(vm.state.value.cobroSinConfirmar)
    assertEquals("Necesitas conexión para confirmar esta declaración.", vm.state.value.mensaje)
    coVerify(exactly = 0) { outbox.encolar(any()) }
}

@Test
fun `P1 un rechazo por evidencia positiva NO libera y muestra el mensaje del SERVIDOR`() = runTest {
    val vm = crearViewModelConCobroSinConfirmar(requestId = "req-1", montoCentavos = 7475)
    coEvery { terminalPaymentRepository.declararNoCobrado(any(), any(), any()) } returns
        Result.failure(BackendHttpException(409, "Ese cobro sí tiene evidencia de haber pasado.", "POSITIVE_EVIDENCE_EXISTS"))

    vm.declararNoCobrado()
    advanceUntilIdle()

    assertNotNull(vm.state.value.cobroSinConfirmar)
    // 🔴 El texto viene del servidor: el hardcodeado «no se presentó tarjeta» MIENTE para esta declaración.
    assertEquals("Ese cobro sí tiene evidencia de haber pasado.", vm.state.value.mensaje)
}

@Test
fun `P1 la salida existente SIGUE ahi: quitarla empeora el caso sin red`() {
    // La pantalla conserva «Salir (queda pendiente)». «Un solo botón» describe la CONCILIACIÓN, no la pantalla.
    val salidas = capturarBotonesDe(PaymentUndeterminedView_paraPrueba())
    assertTrue(salidas.contains("Salir (queda pendiente)"))
}

@Test
fun `P1 el boton no se ofrece cuando el servidor no lo soporta`() {
    // `onDeclararNoCobrado = null` ⇒ la pantalla es exactamente la de hoy (APK nuevo contra server viejo)
    val botones = capturarBotonesDe(PaymentUndeterminedView_paraPrueba(onDeclararNoCobrado = null))
    assertFalse(botones.any { it.contains("no se cobró") })
}
```

- [ ] **Step 2: Correrlas y verlas fallar**

```bash
cd /Users/amieva/Documents/Programming/Avoqado
./scripts/avq-verify.sh avoqado-android ./gradlew testDebugUnitTest --tests "*PaymentFlowViewModel*"
```

⚠️ Si Robolectric entra en juego, `JAVA_HOME` debe ser **17**, no 23 (memoria `robolectric-falla-con-jdk-23-usar-java-17`).

- [ ] **Step 3: Implementar**

En `PaymentUndeterminedView`, añadir el parámetro y el botón **debajo** de «Volver a consultar», con borde `Warning`:

```kotlin
    if (onDeclararNoCobrado != null) {
        Spacer(modifier = Modifier.height(AvoqadoTheme.spacing.md))
        OutlinedButton(
            onClick = { mostrarConfirmacion = true },
            enabled = !isChecking,
            border = BorderStroke(1.5.dp, Warning),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text("Ya revisé la terminal: no se cobró", color = Warning)
        }
    }
```

y el `AvoqadoDialog` de confirmación con los textos de la tabla de arriba. 🔴 **No se toca `chargeAgainDespiteUndetermined`** (sigue vacía a propósito) ni se quitan `onSalir` / `onCancelarVenta`.

- [ ] **Step 4: Correr y ver pasar**

```bash
./scripts/avq-verify.sh avoqado-android ./gradlew testDebugUnitTest --tests "*PaymentFlowViewModel*"
```

- [ ] **Step 5: Sabotaje**

Hacer que el camino sin red encole la declaración: **debe caer** la prueba «sin conexion … NO se encola». Revertir.

- [ ] **Step 6: Commit** — `git commit -- <rutas>`, con `[skip ci]` en el mensaje si no se quiere publicar nada todavía.

---

### Task 9: iOS — paridad texto por texto

**Files:**
- Modify: `Avoqado/.../PaymentResultViews.swift` (`:1417`)
- Modify: `Avoqado/.../PaymentFlowViewModel.swift`

**Interfaces:**
- Consumes: el contrato HTTP de la Task 5, idéntico al de Android.
- Produces: `onDeclararNoCobrado: (() -> Void)?` en la vista y `func declararNoCobrado() async` en el ViewModel.

- [ ] **Step 1: Escribir las pruebas que fallan** — las cinco de la Task 8, traducidas a XCTest. Escritas completas, no por referencia:

```swift
func testDeclararNoCobradoLiberaLaVenta() async throws {
    let vm = crearViewModelConCobroSinConfirmar(requestId: "req-1", montoCentavos: 7475)
    repo.resultadoDeclaracion = .success(DeclaracionAceptada(resolutionId: "r1"))

    await vm.declararNoCobrado()

    XCTAssertEqual(repo.llamadasDeclarar, 1)
    XCTAssertNil(vm.cobroSinConfirmar)
    XCTAssertTrue(vm.puedeCobrar)
}

func testSinConexionLaDeclaracionNoSeEncola() async throws {
    let vm = crearViewModelConCobroSinConfirmar(requestId: "req-1", montoCentavos: 7475)
    repo.resultadoDeclaracion = .failure(URLError(.notConnectedToInternet))

    await vm.declararNoCobrado()

    XCTAssertNotNil(vm.cobroSinConfirmar)
    XCTAssertEqual(vm.mensaje, "Necesitas conexión para confirmar esta declaración.")
    XCTAssertEqual(outbox.encolados.count, 0)
}

func testRechazoPorEvidenciaMuestraElMensajeDelServidor() async throws {
    let vm = crearViewModelConCobroSinConfirmar(requestId: "req-1", montoCentavos: 7475)
    repo.resultadoDeclaracion = .failure(
        BackendError(status: 409, message: "Ese cobro sí tiene evidencia de haber pasado.", code: "POSITIVE_EVIDENCE_EXISTS"))

    await vm.declararNoCobrado()

    XCTAssertNotNil(vm.cobroSinConfirmar)
    XCTAssertEqual(vm.mensaje, "Ese cobro sí tiene evidencia de haber pasado.")
}

func testLaSalidaExistenteSigueAhi() throws {
    let botones = capturarBotones(PaymentUndeterminedView(/* … */))
    XCTAssertTrue(botones.contains("Salir (queda pendiente)"))
}

func testSinSoporteDelServidorNoSeOfreceElBoton() throws {
    let botones = capturarBotones(PaymentUndeterminedView(onDeclararNoCobrado: nil /* … */))
    XCTAssertFalse(botones.contains { $0.contains("no se cobró") })
}
```

- [ ] **Step 2: Correrlas y verlas fallar**

```bash
cd /Users/amieva/Documents/Programming/Avoqado
./scripts/avq-verify.sh avoqado-ios xcodebuild test -scheme Avoqado -destination 'platform=iOS Simulator,name=iPad Air 11-inch (M3)' -only-testing:AvoqadoTests/PaymentFlowViewModelTests
```

- [ ] **Step 3: Implementar con los MISMOS textos**

Después de escribir, comparar literalmente:

```bash
cd /Users/amieva/Documents/Programming/Avoqado
diff <(grep -o '"[^"]*no se cobró[^"]*"' avoqado-android/app/src/main/java -r | sed 's/.*://' | sort -u)      <(grep -o '"[^"]*no se cobró[^"]*"' avoqado-ios -r | sed 's/.*://' | sort -u)
```

Cualquier diferencia se resuelve antes de commitear.

- [ ] **Step 4: Correr y ver pasar**
- [ ] **Step 5: Commit**

---

### Task 10: QA en hardware, con la red apagada de verdad

**Por qué:** la regla `todo-funciona-sin-red.md` del workspace. Los dos defectos de dinero de agosto pasaron los tests, las auditorías y el compilador; sólo salieron apagando el WiFi de un aparato real.

- [ ] **Step 1: Sembrar el escenario en una base desechable**

```bash
createdb av-db-25-conciliacion
```

🔴 **Imprimir y LEER la URL destino antes de correr nada** que pueda vaciar una base. Nunca contra `av-db-25`.

Sembrar una fila `UNKNOWN` con `terminalReturnedAt` puesto, sin `Payment`, con su orden.

- [ ] **Step 2: Declarar desde el aparato y verificar en TRES lados**

1. **Pantalla:** dice «Listo, puedes cobrar».
2. **Postgres:** `status='FAILED'`, `failureCode='OPERATOR_RECONCILED_NO_CHARGE'`, `cancelDisposition IS NULL`, `operatorReconciliation` con el `staffId` real, y **un** `ActivityLog`.
3. **logcat:** sin excepción, sin reintento.

- [ ] **Step 3: Cobrar en la MISMA terminal inmediatamente después**

Es la prueba de que la ranura quedó libre — la mitad del incidente que ninguna prueba unitaria puede demostrar.

- [ ] **Step 4: Repetir con el WiFi apagado**

```bash
adb -s <serial> shell svc wifi disable
# … tocar el botón y confirmar …
adb -s <serial> shell svc wifi enable
```

Esperado: la pantalla dice que necesita conexión, el cobro sin confirmar **sigue ahí**, y **no** se encoló nada. Verificar con `adb logcat` y con la base: cero filas nuevas.

⚠️ Con depuración **inalámbrica** esto no se puede (apagar el WiFi mata el propio adb): por cable, o con la secuencia `nohup sh -c` dentro del aparato que documenta la regla.

- [ ] **Step 5: Reportar las cuatro preguntas de la regla sin red, respondidas**

| Pregunta | Respuesta esperada |
|---|---|
| ¿Qué VE el cajero sin red? | «Necesitas conexión para confirmar esta declaración» — con todas sus letras, no un error genérico |
| ¿Qué se pierde si el proceso muere entre el toque y el POST? | Nada: el `resolutionId` se persiste ANTES del POST y al reconectar se consulta qué se aceptó |
| ¿En qué ORDEN se reproduce lo encolado? | No aplica: **no se encola nada**, es online-only a propósito |
| ¿Y si vuelve la red y el servidor ya cambió? | El servidor decide: si apareció dinero, la declaración se rechaza con `POSITIVE_EVIDENCE_EXISTS` y la pantalla lo dice |

**Clasificación de la capacidad:** 🟡 **online-only a propósito**, y la UI lo explica.

---

## Notas de mantenimiento

- Cuando la etapa 1 aterrice, **actualizar en el MISMO cambio** la tabla de `/.claude/rules/proyectos-por-fases.md`, en el proyecto «Fiabilidad del circuito de cobro Testarudo», con una fila nueva y el enlace a la crónica en `docs/proyectos/`.
- El caso de la **aprobación tardía** (la fila vuelve a `TIMED_OUT/BANK_APPROVED_AWAITING_PAYMENT` y bloquea de nuevo) es comportamiento correcto y ya está en el spec: no «arreglarlo».
