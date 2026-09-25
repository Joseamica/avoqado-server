# IVA por producto — Plan 2: el contrato de precio de cada venta — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que cada venta nueva guarde, desde que nace, si su precio ya traía el IVA incluido (`IVA_INCLUIDO`), si el IVA se sumó aparte (`IVA_APARTE`) o si no se sabe (`DESCONOCIDO`); que ninguna transformación lo pierda o lo falsee; y que una venta vieja se pueda confirmar una por una, con rastro. Nada visible cambia.

**Architecture:** Una columna `Order.contratoDePrecio` (enum, `DEFAULT 'DESCONOCIDO'`, sin backfill). Cada uno de los 24 sitios de código que crean una `Order` la declara explícitamente; una prueba de arquitectura hace imposible agregar un escritor nuevo sin declararla, y prohíbe reescribirla en un `update` fuera de los dos lugares autorizados (fusión y confirmación). Separar cuentas copia el contrato; fusionar lo combina (distintos ⇒ `DESCONOCIDO`). Un servicio + una herramienta del MCP en dos pasos confirman `IVA_INCLUIDO` en ventas viejas, con candado optimista sobre `Order.version` y `ActivityLog` en la misma transacción. En este plan nadie LEE el contrato: lo lee el plan 3 (emisores de CFDI).

**Tech Stack:** TypeScript, Express, Prisma 6.19, PostgreSQL, Jest (proyectos `unit` / `integration`), MCP (`src/mcp/tools`).

**Spec:** workspace `docs/superpowers/plans/2026-09-24-iva-por-producto.md` — sección «v5» punto 1 (contrato persistido), «v6» y «Ronda 6: Codex AUTORIZA» (condición 6: confirmación ligada a la revisión). Auditorías: workspace `docs/auditorias/2026-09-24-auditoria-codex-iva-por-producto-ronda5.md` (P2-1, tabla de escritores) y `-ronda6.md`. Plan 1 (base, ya en esta rama) e índice de los 7 planes: workspace `docs/superpowers/plans/2026-09-24-iva-por-producto-plan-1-base.md`. Matriz de escritores medida el 25-sep: `/Users/amieva/.claude-avoqado/jobs/e6e79658/tmp/iva-plan2-matriz-escritores.md` (copiarla a la carpeta de la bitácora al arrancar: el directorio del job puede desaparecer).

**Rama/worktree:** encima del plan 1, en la rama `iva-por-producto` (worktree `avoqado-server/.claude/worktrees/iva-por-producto`). Decisión del founder del 25-sep: dejar la rama sin push ni merge y seguir el plan 2 encima.

## Global Constraints

- Valores: `IVA_INCLUIDO` (el precio ya incluye el IVA; la norma en México) · `IVA_APARTE` (el IVA se sumó encima) · `DESCONOCIDO` (default; ventas existentes y casos ambiguos).
- **Sin backfill.** Todas las órdenes existentes quedan `DESCONOCIDO` (spec v5 §1). Sólo cambian por la confirmación explícita de la Tarea 6.
- **Ningún `update` reescribe el contrato.** Los únicos que lo cambian después de crear: `mergeOrders` (combinar) y `confirmarContratoIvaIncluido`.
- Separar y separar-por-asiento COPIAN el contrato del origen, en la misma transacción. Fusionar COMBINA: iguales ⇒ el mismo; distintos ⇒ `DESCONOCIDO`. **La fusión nunca se bloquea por esto**: un dato fiscal no frena una operación de venta.
- Agregar renglones a una orden existente (ADD_ITEMS, promociones, vales, descuentos) NO toca el contrato.
- La confirmación histórica sólo hace `DESCONOCIDO → IVA_INCLUIDO`, ligada a la `Order.version` que se mostró, con `ActivityLog` atómico (antes, después, motivo, actor). Nunca confirma una orden con `taxAmount ≠ 0`, de pos-sync (`source = 'POS'`) ni convertida de cotización (`Estimate.convertedOrderId`).
- Mensajes al usuario en español. El MCP reporta pesos (Decimal → `Number`), no centavos.
- Migración a mano con `SET LOCAL lock_timeout = '5s'`; `ADD COLUMN … NOT NULL DEFAULT <constante>` (metadata-only en PG11+: no reescribe la tabla caliente `Order`). Toda edición de `schema.prisma` regenera `docs/SCHEMA_MAP.md` en el mismo commit (`npm run schema:map`).
- Base de pruebas: `av_db_25_iva_test` (NUNCA `av-db-25`). Integración completa en una base desechable `avoqado_h1a_test_20260808` creada en el servidor del puerto 5433 y borrada al terminar (las suites de catálogo exigen ese nombre).
- Pruebas por ruta exacta (`--runTestsByPath`). **Nunca un `--testPathPattern` que contenga «product»**: el nombre del worktree contiene «producto» y selecciona todo.
- Commits con `git commit -m … -- <rutas>` y `git show --stat HEAD` después; typecheck del CI (`npm run typecheck`, incluye `tests/`) por `./scripts/avq-verify.sh` con `AVQ_TREE=<worktree>` desde el root del workspace.
- Este plan no toca ningún lector de dinero ni fiscal. Si una prueba existente de dinero cambia de resultado, es un defecto de la tarea, no algo que se ajuste.

## Review Focus

1. **Una mesa que nace vacía y luego recibe renglones** (TPV `assignTable`, que también atiende el intent offline `OPEN_TABLE`; `createOrder` de TPV sin renglones) ⇒ nace `IVA_INCLUIDO`, porque todos los caminos que después le agregan renglones usan precios con IVA incluido. Si naciera `DESCONOCIDO`, todo restaurante con mesas quedaría fuera del IVA mixto sin motivo. Prueba en la Tarea 3.
2. **Un reintento de pos-sync** (el puente re-manda la misma orden) ⇒ la rama `update:` del upsert NO toca el contrato. Prueba en la Tarea 4.
3. **Fusionar una cuenta vieja (`DESCONOCIDO`) con una nueva (`IVA_INCLUIDO`)** ⇒ el destino queda `DESCONOCIDO`, sin error, y la fusión ocurre. Prueba en la Tarea 5.
4. **Confirmar una venta que alguien modificó entre la vista previa y la confirmación** ⇒ «cambió desde que la revisaste», nada cambia. Prueba en la Tarea 6.
5. **Un escritor nuevo de `Order` agregado en el futuro sin declarar el contrato** (o un `update` que lo reescriba) ⇒ la prueba de arquitectura falla con archivo y línea. Prueba en la Tarea 3; el sabotaje la confirma.

---

### Task 1: Módulo puro `contratoDePrecio`

**Files:**
- Create: `src/services/fiscal/contratoDePrecio.ts`
- Test: `tests/unit/services/fiscal/contratoDePrecio.test.ts`

**Interfaces:**
- Produces: `type ContratoDePrecio = 'IVA_INCLUIDO' | 'IVA_APARTE' | 'DESCONOCIDO'` · `combinarContratos(a: ContratoDePrecio, b: ContratoDePrecio): ContratoDePrecio` · `contratoDePagoManual(taxAmount: unknown): ContratoDePrecio`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/services/fiscal/contratoDePrecio.test.ts
import { combinarContratos, contratoDePagoManual } from '@/services/fiscal/contratoDePrecio'

describe('combinarContratos (fusión de cuentas)', () => {
  it.each([
    ['IVA_INCLUIDO', 'IVA_INCLUIDO', 'IVA_INCLUIDO'],
    ['IVA_APARTE', 'IVA_APARTE', 'IVA_APARTE'],
    ['DESCONOCIDO', 'DESCONOCIDO', 'DESCONOCIDO'],
    ['IVA_INCLUIDO', 'IVA_APARTE', 'DESCONOCIDO'],
    ['IVA_APARTE', 'IVA_INCLUIDO', 'DESCONOCIDO'],
    ['IVA_INCLUIDO', 'DESCONOCIDO', 'DESCONOCIDO'],
    ['DESCONOCIDO', 'IVA_INCLUIDO', 'DESCONOCIDO'],
  ] as const)('%s + %s ⇒ %s', (a, b, esperado) => {
    expect(combinarContratos(a, b)).toBe(esperado)
  })
})

describe('contratoDePagoManual (dashboard, cobro sin orden)', () => {
  it('un IVA tecleado mayor a cero ⇒ IVA_APARTE', () => {
    expect(contratoDePagoManual('16.00')).toBe('IVA_APARTE')
    expect(contratoDePagoManual(0.01)).toBe('IVA_APARTE')
  })
  it('sin IVA tecleado, cero o basura ⇒ DESCONOCIDO (no se adivina «incluido»)', () => {
    for (const v of [undefined, null, 0, '0', '0.00', '', 'abc', -5]) {
      expect(contratoDePagoManual(v)).toBe('DESCONOCIDO')
    }
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest --selectProjects unit --runTestsByPath tests/unit/services/fiscal/contratoDePrecio.test.ts --ci`
Expected: FAIL — `Cannot find module '@/services/fiscal/contratoDePrecio'`.

- [ ] **Step 3: Implement**

```typescript
// src/services/fiscal/contratoDePrecio.ts
/**
 * Contrato de precio de una venta: ¿el precio cobrado YA traía el IVA (la norma en México), o el IVA se sumó
 * encima? Lo declara cada escritor de `Order` al crear (prueba de arquitectura `orderContratoDePrecioWriters`) y lo
 * lee la facturación (plan 3) para decidir si una venta con IVA mixto (0 %, exento) se puede facturar. Nunca se
 * infiere de `source` ni de `taxAmount`: una igualdad de totales no demuestra la naturaleza del precio (Codex r4).
 */
export type ContratoDePrecio = 'IVA_INCLUIDO' | 'IVA_APARTE' | 'DESCONOCIDO'

/** Fusión de dos cuentas: si no coinciden, ya no se sabe (spec v5). La fusión nunca se bloquea por esto. */
export function combinarContratos(a: ContratoDePrecio, b: ContratoDePrecio): ContratoDePrecio {
  return a === b ? a : 'DESCONOCIDO'
}

/** Cobro manual del dashboard sin orden: sólo un IVA tecleado > 0 demuestra «aparte»; lo demás no se adivina. */
export function contratoDePagoManual(taxAmount: unknown): ContratoDePrecio {
  const n = typeof taxAmount === 'number' ? taxAmount : typeof taxAmount === 'string' && taxAmount.trim() !== '' ? Number(taxAmount) : NaN
  return Number.isFinite(n) && n > 0 ? 'IVA_APARTE' : 'DESCONOCIDO'
}
```

- [ ] **Step 4: Run to verify it passes** (mismo comando). Expected: PASS, 9 pruebas.
- [ ] **Step 5: Commit**

```bash
git commit -m "feat(iva): módulo puro del contrato de precio de una venta" -- src/services/fiscal/contratoDePrecio.ts tests/unit/services/fiscal/contratoDePrecio.test.ts
git show --stat HEAD
```

---

### Task 2: Esquema — enum y columna con default, sin backfill

**Files:**
- Modify: `prisma/schema.prisma` (model `Order`, debajo de `source OrderSource @default(TPV)`; enum nuevo `ContratoDePrecio` junto a `enum OrderSource`)
- Create: `prisma/migrations/20260926000300_order_contrato_de_precio/migration.sql`
- Modify: `docs/SCHEMA_MAP.md` (regenerado)
- Test: `tests/integration/fiscal/orderContratoDePrecio.schema.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `Order.contratoDePrecio ContratoDePrecio @default(DESCONOCIDO)`; enum Prisma `ContratoDePrecio`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/integration/fiscal/orderContratoDePrecio.schema.test.ts
import prisma from '@/utils/prismaClient'

describe('Order.contratoDePrecio (esquema)', () => {
  afterAll(() => prisma.$disconnect())

  it('la columna existe, es NOT NULL y su default es DESCONOCIDO', async () => {
    const col = await prisma.$queryRawUnsafe<{ is_nullable: string; column_default: string | null }[]>(
      `SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'Order' AND column_name = 'contratoDePrecio'`,
    )
    expect(col).toHaveLength(1)
    expect(col[0].is_nullable).toBe('NO')
    expect(col[0].column_default).toContain('DESCONOCIDO')
  })

  it('el enum trae exactamente los tres valores', async () => {
    const vals = await prisma.$queryRawUnsafe<{ v: string }[]>(
      `SELECT unnest(enum_range(NULL::"ContratoDePrecio"))::text AS v`,
    )
    expect(vals.map(r => r.v).sort()).toEqual(['DESCONOCIDO', 'IVA_APARTE', 'IVA_INCLUIDO'])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `TEST_DATABASE_URL=postgresql://postgres:exitosoy777@localhost:5432/av_db_25_iva_test npx jest --selectProjects integration --runTestsByPath tests/integration/fiscal/orderContratoDePrecio.schema.test.ts --ci`
Expected: FAIL (0 filas / el tipo no existe).

- [ ] **Step 3: Schema + migración**

```prisma
// model Order, debajo de `source`:
  // ¿El precio cobrado ya traía el IVA? Lo declara cada escritor al crear (prueba de arquitectura
  // orderContratoDePrecioWriters). Ventas anteriores: DESCONOCIDO (sin backfill). Lo lee la facturación (plan 3).
  contratoDePrecio ContratoDePrecio @default(DESCONOCIDO)

// junto a enum OrderSource:
enum ContratoDePrecio {
  IVA_INCLUIDO
  IVA_APARTE
  DESCONOCIDO
}
```

```sql
-- prisma/migrations/20260926000300_order_contrato_de_precio/migration.sql
-- IVA por producto, plan 2: contrato de precio de cada venta. Aditiva y SIN backfill: todas las órdenes existentes
-- quedan DESCONOCIDO (spec v5 §1). ADD COLUMN con DEFAULT constante es metadata-only en PG11+ (no reescribe "Order").
SET LOCAL lock_timeout = '5s';

DO $$ BEGIN
  CREATE TYPE "ContratoDePrecio" AS ENUM ('IVA_INCLUIDO', 'IVA_APARTE', 'DESCONOCIDO');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "contratoDePrecio" "ContratoDePrecio" NOT NULL DEFAULT 'DESCONOCIDO';
```

Aplicar SÓLO a la base de pruebas (imprimir y leer la URL antes de correr):

```bash
echo postgresql://postgres:exitosoy777@localhost:5432/av_db_25_iva_test
DATABASE_URL=postgresql://postgres:exitosoy777@localhost:5432/av_db_25_iva_test npx prisma migrate deploy
npx prisma generate
npm run schema:map
```

Si `tests/unit/architecture/hotOrderIndexMigrationGuard.test.ts` u otra guarda de migraciones sobre `Order` se queja, lee su regla: esta migración no crea índices; si exige `lock_timeout` ya lo trae.

- [ ] **Step 4: Run to verify it passes** — la prueba del Step 2 ⇒ PASS; `npx jest --selectProjects unit --runTestsByPath tests/unit/architecture/hotOrderIndexMigrationGuard.test.ts --ci` ⇒ PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(iva): Order.contratoDePrecio (enum + columna con default, sin backfill)" -- prisma/schema.prisma prisma/migrations/20260926000300_order_contrato_de_precio docs/SCHEMA_MAP.md tests/integration/fiscal/orderContratoDePrecio.schema.test.ts` y `git show --stat HEAD`.

---

### Task 3: Prueba de arquitectura + los escritores `IVA_INCLUIDO`

**Files:**
- Create: `tests/unit/architecture/orderContratoDePrecioWriters.test.ts`
- Modify (añadir `contratoDePrecio: 'IVA_INCLUIDO'` al `data` del `create`, junto a `taxAmount`; líneas medidas el 25-sep, verificar al editar):
  - `src/services/tpv/table.tpv.service.ts:281` (`assignTable`; también lo usa el intent offline `OPEN_TABLE`) — nace vacía
  - `src/services/tpv/order.tpv.service.ts:427` (`createOrder`, nace vacía), `:1138` (Cobrar V1), `:3887` (venta serializada)
  - `src/services/tpv/payment.tpv.service.ts:4865` (venta rápida)
  - `src/services/b4bit/b4bit.service.ts:352`
  - `src/services/dashboard/venueCheckout.service.ts:560`
  - `src/services/mobile/order.mobile.service.ts:866` (crear orden)
  - `src/services/mobile/areaTicket.mobile.service.ts:498`, `src/services/mobile/areaTicketV7.mobile.service.ts:1546`
  - `src/services/dashboard/paymentLink.service.ts:1598`, `:2468`, `:3345`
  - `src/services/reservation/createOrderFromReservation.ts:217`
  - `src/services/delivery-channels/core/deliveryOrderIngestion.service.ts:229`
- Modify tests: las pruebas unitarias existentes de esos escritores que afirman el `data` EXACTO del `create` (con `toEqual` sobre el objeto completo) se ajustan para incluir el campo. Nunca se debilita lo que afirman (no cambiar `toEqual` por `objectContaining`).

**Interfaces:**
- Consumes: enum Prisma `ContratoDePrecio` (Tarea 2).
- Produces: la garantía estática de que todo `.order.create(` / `.order.upsert(` declara `contratoDePrecio`, y de que ningún `.order.update(` / `.order.updateMany(` lo escribe fuera de `mergeOrders` y `confirmarContratoIvaIncluido`.

**Por qué las mesas vacías nacen `IVA_INCLUIDO`:** todo renglón que entra después a una orden de TPV/móvil (addItems de TPV, `ADD_ITEMS` offline, vales, promociones) usa precios con IVA incluido (matriz §2). Si nacieran `DESCONOCIDO`, todo restaurante con mesas quedaría fuera del IVA mixto sin motivo.

- [ ] **Step 1: Write the failing architecture test**

```typescript
// tests/unit/architecture/orderContratoDePrecioWriters.test.ts
/**
 * IVA por producto, plan 2: TODO escritor de Order declara el contrato de precio al crear, y NADIE lo reescribe en
 * un update salvo la fusión de cuentas y la confirmación histórica. Un escritor nuevo sin declararlo tumba esta
 * prueba con su archivo y línea — así la facturación (plan 3) nunca lee un contrato que alguien olvidó escribir.
 */
import fs from 'fs'
import path from 'path'

const SRC = path.join(__dirname, '../../../src')

function archivosTs(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === '__tests__' ? [] : archivosTs(p)
    return e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') ? [p] : []
  })
}

const esComentario = (linea: string) => /^\s*(\/\/|\*|\/\*)/.test(linea)

/** Texto de la llamada: desde la línea del `(` hasta que cierran los paréntesis (tope 150 líneas). */
function llamada(lineas: string[], i: number): string {
  let prof = 0
  let abrio = false
  const out: string[] = []
  for (let j = i; j < Math.min(lineas.length, i + 150); j++) {
    out.push(lineas[j])
    for (const ch of lineas[j]) {
      if (ch === '(') {
        prof++
        abrio = true
      } else if (ch === ')') prof--
    }
    if (abrio && prof <= 0) break
  }
  return out.join('\n')
}

/** Nombre de la función de primer nivel que contiene la línea i (la declaración más cercana hacia arriba). */
function funcionQueContiene(lineas: string[], i: number): string | null {
  for (let j = i; j >= 0; j--) {
    const m = lineas[j].match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/) ?? lineas[j].match(/^(?:export\s+)?const\s+(\w+)\s*=\s*async/)
    if (m) return m[1]
  }
  return null
}

const CREA = /\.order\s*\.\s*(create|upsert)\s*\(/
const ACTUALIZA = /\.order\s*\.\s*(update|updateMany)\s*\(/

/** Pendientes: la Tarea 4 quita los archivos, la Tarea 5 quita las funciones de split. Esta lista sólo encoge. */
const PENDIENTES: Array<{ archivo: string; funcion?: string }> = [
  { archivo: 'services/mobile/estimate.mobile.service.ts' },
  { archivo: 'services/pos-sync/posSyncOrder.service.ts' },
  { archivo: 'services/dashboard/manualPayment.service.ts' },
  { archivo: 'services/dashboard/manualSale.service.ts' },
  { archivo: 'services/mobile/refund.mobile.service.ts' },
  { archivo: 'services/onboarding/demoSeed.service.ts' },
  { archivo: 'services/mobile/order.mobile.service.ts', funcion: 'splitOrderItems' },
  { archivo: 'services/mobile/order.mobile.service.ts', funcion: 'splitOrderBySeat' },
]

/** Únicos lugares autorizados a CAMBIAR el contrato después de crear. */
const REESCRITURA_AUTORIZADA = new Set(['mergeOrders', 'confirmarContratoIvaIncluido'])

type Sitio = { rel: string; linea: number; funcion: string | null; declara: boolean }

function escanear() {
  const creates: Sitio[] = []
  const reescrituras: Sitio[] = []
  for (const archivo of archivosTs(SRC)) {
    const rel = path.relative(SRC, archivo).split(path.sep).join('/')
    const lineas = fs.readFileSync(archivo, 'utf8').split('\n')
    lineas.forEach((linea, i) => {
      if (esComentario(linea)) return
      if (CREA.test(linea)) {
        creates.push({ rel, linea: i + 1, funcion: funcionQueContiene(lineas, i), declara: /contratoDePrecio\s*:/.test(llamada(lineas, i)) })
      }
      if (ACTUALIZA.test(linea) && /contratoDePrecio\s*:/.test(llamada(lineas, i))) {
        const funcion = funcionQueContiene(lineas, i)
        if (!funcion || !REESCRITURA_AUTORIZADA.has(funcion)) reescrituras.push({ rel, linea: i + 1, funcion, declara: true })
      }
    })
  }
  return { creates, reescrituras }
}

const esPendiente = (s: Sitio) => PENDIENTES.some(p => p.archivo === s.rel && (!p.funcion || p.funcion === s.funcion))

describe('Order.contratoDePrecio — escritores', () => {
  const { creates, reescrituras } = escanear()

  it('encuentra los escritores (si esto baja a 0, el escáner se rompió, no el código)', () => {
    expect(creates.length).toBeGreaterThanOrEqual(24)
  })

  it('todo create/upsert de Order declara contratoDePrecio', () => {
    const faltan = creates.filter(s => !s.declara && !esPendiente(s)).map(s => `${s.rel}:${s.linea} (${s.funcion})`)
    expect(faltan).toEqual([])
  })

  it('ningún update reescribe el contrato fuera de la fusión y la confirmación', () => {
    expect(reescrituras.map(s => `${s.rel}:${s.linea} (${s.funcion})`)).toEqual([])
  })

  it('cada pendiente sigue existiendo y sigue sin declarar (si ya declara, sácalo de la lista)', () => {
    for (const p of PENDIENTES) {
      const sitios = creates.filter(s => s.rel === p.archivo && (!p.funcion || s.funcion === p.funcion))
      expect(sitios.length).toBeGreaterThan(0)
      expect(sitios.every(s => !s.declara)).toBe(true)
    }
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest --selectProjects unit --runTestsByPath tests/unit/architecture/orderContratoDePrecioWriters.test.ts --ci`
Expected: FAIL en «todo create/upsert…», listando los 16 sitios de esta tarea (incluido `order.mobile.service.ts:866 (createOrder…)`, que NO es pendiente). Las otras tres pruebas pasan.

- [ ] **Step 3: Declarar el contrato** en los 16 sitios. Ejemplo (TPV, nace vacía):

```typescript
      contratoDePrecio: 'IVA_INCLUIDO', // nace vacía; todo renglón que entra después trae IVA incluido (plan 2)
```

En los que nacen con renglones basta `contratoDePrecio: 'IVA_INCLUIDO',` sin comentario.

- [ ] **Step 4: Pruebas de comportamiento** — en las suites unitarias existentes de estos escritores, añadir UNA aserción por escritor:

```typescript
expect(mockPrisma.order.create).toHaveBeenCalledWith(
  expect.objectContaining({ data: expect.objectContaining({ contratoDePrecio: 'IVA_INCLUIDO' }) }),
)
```

(usar el nombre real del mock de cada suite). Localizar las suites con `grep -rln "assignTable\|createOrderFromReservation\|ingestDeliveryOrder\|createFastPayment" tests/unit`. Si un escritor no tiene suite unitaria, lo cubre la prueba de arquitectura; declararlo en el reporte. **La mesa vacía (Review Focus 1)** lleva su aserción explícita en la suite de `table.tpv.service` (o de `order.tpv.service` si ahí vive `assignTable`).

- [ ] **Step 5: Sabotaje** — quitar temporalmente `contratoDePrecio` de `deliveryOrderIngestion.service.ts` ⇒ la prueba de arquitectura falla nombrando ese archivo; restaurar. Añadir temporalmente `contratoDePrecio: 'DESCONOCIDO'` a cualquier `tx.order.update` de `updateOrderDetails` ⇒ falla «ningún update reescribe…»; restaurar. Anotar ambos en el reporte.
- [ ] **Step 6: Verify** — arquitectura en verde; cada suite tocada en verde (por ruta); typecheck del CI por avq-verify:

```bash
# desde el root del workspace
AVQ_TREE=/Users/amieva/Documents/Programming/Avoqado/avoqado-server/.claude/worktrees/iva-por-producto ./scripts/avq-verify.sh avoqado-server npm run typecheck
```

Expected: `errores TS: 0`.
- [ ] **Step 7: Commit** con pathspec de todos los archivos tocados; `git show --stat HEAD`.

---

### Task 4: Escritores `IVA_APARTE` y `DESCONOCIDO`

**Files:**
- Modify:
  - `src/services/mobile/estimate.mobile.service.ts:335` (`convertToOrder`) ⇒ `'IVA_APARTE'` (la cotización suma 16 % encima, l.199-201).
  - `src/services/pos-sync/posSyncOrder.service.ts:336` ⇒ SÓLO la rama `create:` del upsert: `'IVA_APARTE'` (SoftRestaurant manda el impuesto aparte). La rama `update:` NO lo lleva.
  - `src/services/dashboard/manualPayment.service.ts:293` ⇒ `contratoDePrecio: contratoDePagoManual(input.taxAmount)` (Tarea 1).
  - `src/services/dashboard/manualSale.service.ts:198` ⇒ `'DESCONOCIDO'` (importación; no se sabe).
  - `src/services/mobile/refund.mobile.service.ts:85` ⇒ `'DESCONOCIDO'` (reembolso sin orden de origen).
  - `src/services/onboarding/demoSeed.service.ts:1303` ⇒ `'IVA_INCLUIDO'` (el demo usa precios con IVA incluido).
  - `tests/unit/architecture/orderContratoDePrecioWriters.test.ts` ⇒ quitar de `PENDIENTES` esas seis entradas de archivo (quedan sólo las dos de split).
- Test: aserciones en las suites unitarias de cada uno + `tests/integration/fiscal/orderContratoDePrecio.posSync.test.ts`.

**Interfaces:**
- Consumes: `contratoDePagoManual` (Tarea 1).

- [ ] **Step 1: Pruebas en rojo**
  - estimate `convertToOrder` ⇒ `create` con `contratoDePrecio: 'IVA_APARTE'`.
  - manualPayment con `taxAmount: '16.00'` ⇒ `'IVA_APARTE'`; sin `taxAmount` ⇒ `'DESCONOCIDO'`.
  - manualSale y refund ⇒ `'DESCONOCIDO'`; demoSeed ⇒ `'IVA_INCLUIDO'` (si su suite existe).
  - **Integración de pos-sync (Review Focus 2)**, contra `av_db_25_iva_test`: procesar un evento de orden nueva ⇒ la fila nace `IVA_APARTE`. Poner a mano `UPDATE "Order" SET "contratoDePrecio"='DESCONOCIDO' WHERE id=…`. Procesar el MISMO evento otra vez (rama `update:`) ⇒ la fila sigue `DESCONOCIDO` (prueba que el `update` no toca el contrato). Reusar la preparación de las pruebas de integración existentes de pos-sync (`grep -rln "posSyncOrder" tests/integration`); si no existe ninguna, sembrar el venue y la conexión mínima que exija la función pública de ese servicio y documentarlo en el reporte.
- [ ] **Step 2: Run** cada prueba por ruta ⇒ FAIL.
- [ ] **Step 3: Implementar** los seis sitios y actualizar `PENDIENTES`.
- [ ] **Step 4: Verify** — pruebas en verde; arquitectura en verde con sólo los dos pendientes de split; typecheck del CI por avq-verify `errores TS: 0`.
- [ ] **Step 5: Commit** con pathspec; `git show --stat HEAD`.

---

### Task 5: Separar copia, fusionar combina

**Files:**
- Modify: `src/services/mobile/order.mobile.service.ts` — `splitOrderItems` (create ~l.1627), `splitOrderBySeat` (create ~l.1757), `mergeOrders` (~l.1833-1975). Las rutas de TPV usan estas mismas funciones.
- Modify: `tests/unit/architecture/orderContratoDePrecioWriters.test.ts` — `PENDIENTES` queda vacío (`[]`); la prueba «cada pendiente sigue existiendo» pasa trivialmente y se conserva.
- Test: `tests/integration/fiscal/orderContratoDePrecio.transformaciones.test.ts`.

**Interfaces:**
- Consumes: `combinarContratos` (Tarea 1).

- [ ] **Step 1: Pruebas de integración (RED)** contra `av_db_25_iva_test`. Reusar la preparación de las suites de integración existentes de split/merge (`grep -rln "splitOrderItems\|mergeOrders\|splitOrderBySeat" tests/integration`); si no hay, sembrar venue, staff, un producto y órdenes con renglones (con `seat` para el caso por asiento) y documentarlo. Casos:
  1. separar una orden `IVA_APARTE` ⇒ la orden nueva es `IVA_APARTE`;
  2. separar por asiento una orden `IVA_INCLUIDO` con renglones en 2 asientos ⇒ cada orden nueva es `IVA_INCLUIDO`;
  3. fusionar `IVA_INCLUIDO` (destino) + `IVA_INCLUIDO` (origen) ⇒ destino `IVA_INCLUIDO`;
  4. **(Review Focus 3)** fusionar `DESCONOCIDO` (destino) + `IVA_INCLUIDO` (origen) ⇒ destino `DESCONOCIDO`, la fusión ocurre (renglones movidos al destino, origen en el estado final que ya asignaba `mergeOrders`), sin error;
  5. fusionar `IVA_INCLUIDO` + `IVA_APARTE` ⇒ destino `DESCONOCIDO`, sin error.
  El estado inicial del contrato se fija con `UPDATE "Order" SET "contratoDePrecio"=…` tras sembrar.
- [ ] **Step 2: Run** ⇒ FAIL en 1, 2, 4 y 5 (el 3 puede pasar por el default si se siembra con `IVA_INCLUIDO`; está para fijar el comportamiento).
- [ ] **Step 3: Implementar**
  - En los dos `create` de split: `contratoDePrecio: <origen>.contratoDePrecio` (añadir `contratoDePrecio: true` al `select` con que se lee el origen si viene con `select`).
  - En `mergeOrders`, dentro de la MISMA transacción que mueve los renglones, en el `update` del destino: `contratoDePrecio: combinarContratos(target.contratoDePrecio, source.contratoDePrecio)` (añadir el campo al `select` de ambas lecturas si aplica). Nada más cambia en esas funciones; si el `update` del destino no existe, créalo junto a la escritura de totales ya existente, no en una transacción aparte.
  - Vaciar `PENDIENTES`.
- [ ] **Step 4: Verify** — integración en verde; arquitectura en verde; suites unitarias de `order.mobile.service` y de split/merge de TPV en verde (por ruta); typecheck del CI `errores TS: 0`.
- [ ] **Step 5: Commit** con pathspec; `git show --stat HEAD`.

---

### Task 6: Confirmar el contrato de una venta vieja (servicio + herramienta del MCP)

**Files:**
- Create: `src/services/fiscal/confirmarContratoDePrecio.service.ts`
- Modify: `src/mcp/tools/cfdi.ts` (herramienta nueva `confirm_order_price_contract`, calcada del patrón de `emit_refund_credit_note`, l.~110-215)
- Test: `tests/integration/fiscal/confirmarContratoDePrecio.test.ts`, `tests/unit/mcp-customer/confirm-order-price-contract.test.ts`

**Interfaces:**
- Consumes: `writeLegacyActivityAuditTx` (`src/services/activityAudit.service.ts`), `auditMcpWrite` (`src/mcp/audit`), `venuesWithFeatureAccess` (`@/services/access/basePlan.service`).
- Produces:
  - `vistaPreviaContrato(venueId: string, orderId: string): Promise<VistaPreviaContrato | null>` con `VistaPreviaContrato = { orderId: string; orderNumber: string; createdAt: Date; totalMxn: number; taxAmountMxn: number; source: string; contratoActual: string; version: number; confirmable: boolean; motivo?: string }`.
  - `confirmarContratoIvaIncluido(p: { venueId: string; orderId: string; versionVista: number; staffId: string | null; motivo: string }): Promise<{ ok: true } | { ok: false; code: 'NO_ENCONTRADA' | 'NO_CONFIRMABLE' | 'CAMBIO_DESDE_LA_VISTA'; message: string }>`.

**Reglas:** sólo `DESCONOCIDO → IVA_INCLUIDO`; no confirmable si `taxAmount ≠ 0`, si `source = 'POS'` o si hay un `Estimate` con `convertedOrderId = orderId`; CAS sobre `version`; `ActivityLog` `ORDER_PRICE_CONTRACT_CONFIRMED` con `{ antes, despues, motivo, version }` en la MISMA transacción (si falla el log, no se confirma); no emite ni toca ningún CFDI.

- [ ] **Step 1: Pruebas de integración (RED)** contra `av_db_25_iva_test`, sembrando órdenes (venue propio del test):
  1. orden `DESCONOCIDO`, `taxAmount 0`, `source TPV` ⇒ vista previa `confirmable: true`; confirmar con su `version` ⇒ `{ok:true}`, la fila queda `IVA_INCLUIDO` con `version + 1`, y existe un `ActivityLog` `ORDER_PRICE_CONTRACT_CONFIRMED` con `entityId = orderId`, `data.motivo` y el `staffId`;
  2. **(Review Focus 4)** tras la vista previa, `UPDATE "Order" SET version = version + 1` ⇒ confirmar con la versión vieja ⇒ `CAMBIO_DESDE_LA_VISTA`, la fila sigue `DESCONOCIDO` y NO hay `ActivityLog`;
  3. orden con `taxAmount 16` ⇒ `NO_CONFIRMABLE`, mensaje en español;
  4. orden `source POS` ⇒ `NO_CONFIRMABLE`;
  5. orden de OTRO venue ⇒ `NO_ENCONTRADA` y la vista previa devuelve `null`;
  6. orden ya `IVA_INCLUIDO` ⇒ `NO_CONFIRMABLE` («ya tiene un contrato»).
- [ ] **Step 2: Run** ⇒ FAIL (módulo inexistente).
- [ ] **Step 3: Servicio**

```typescript
// src/services/fiscal/confirmarContratoDePrecio.service.ts
/**
 * IVA por producto, plan 2: confirmar que una venta VIEJA (contrato DESCONOCIDO) se cobró con IVA incluido. Es la
 * única salida para facturar con IVA mixto una venta anterior al plan (p. ej. los cafés en grano de Testarudo).
 * Ligada a la versión que la persona vio (condición 6 de Codex r6) y auditada en la misma transacción.
 */
import prisma from '@/utils/prismaClient'
import { writeLegacyActivityAuditTx } from '@/services/activityAudit.service'

const MOTIVOS = {
  yaConfirmada: 'Esta venta ya tiene un contrato de precio definido.',
  impuestoAparte: 'Esta venta separó el impuesto al cobrar; no se puede confirmar como «IVA incluido».',
  posSync: 'Esta venta llegó del puente de SoftRestaurant, que manda el impuesto aparte.',
  cotizacion: 'Esta venta salió de una cotización, que suma el IVA encima.',
} as const

type Cliente = Pick<typeof prisma, 'estimate'>

async function motivoNoConfirmable(
  db: Cliente,
  o: { id: string; taxAmount: unknown; source: string; contratoDePrecio: string },
): Promise<string | null> {
  if (o.contratoDePrecio !== 'DESCONOCIDO') return MOTIVOS.yaConfirmada
  if (Number(o.taxAmount) !== 0) return MOTIVOS.impuestoAparte
  if (o.source === 'POS') return MOTIVOS.posSync
  if ((await db.estimate.count({ where: { convertedOrderId: o.id } })) > 0) return MOTIVOS.cotizacion
  return null
}

const SELECT = { id: true, orderNumber: true, createdAt: true, total: true, taxAmount: true, source: true, contratoDePrecio: true, version: true } as const

export interface VistaPreviaContrato {
  orderId: string
  orderNumber: string
  createdAt: Date
  totalMxn: number
  taxAmountMxn: number
  source: string
  contratoActual: string
  version: number
  confirmable: boolean
  motivo?: string
}

export async function vistaPreviaContrato(venueId: string, orderId: string): Promise<VistaPreviaContrato | null> {
  const o = await prisma.order.findFirst({ where: { id: orderId, venueId }, select: SELECT })
  if (!o) return null
  const motivo = await motivoNoConfirmable(prisma, o)
  return {
    orderId: o.id,
    orderNumber: o.orderNumber,
    createdAt: o.createdAt,
    totalMxn: Number(o.total),
    taxAmountMxn: Number(o.taxAmount),
    source: o.source,
    contratoActual: o.contratoDePrecio,
    version: o.version,
    confirmable: motivo === null,
    ...(motivo ? { motivo } : {}),
  }
}

export async function confirmarContratoIvaIncluido(p: {
  venueId: string
  orderId: string
  versionVista: number
  staffId: string | null
  motivo: string
}): Promise<{ ok: true } | { ok: false; code: 'NO_ENCONTRADA' | 'NO_CONFIRMABLE' | 'CAMBIO_DESDE_LA_VISTA'; message: string }> {
  return prisma.$transaction(async tx => {
    const o = await tx.order.findFirst({ where: { id: p.orderId, venueId: p.venueId }, select: SELECT })
    if (!o) return { ok: false as const, code: 'NO_ENCONTRADA' as const, message: 'No encontré esa venta en este negocio.' }
    const motivo = await motivoNoConfirmable(tx, o)
    if (motivo) return { ok: false as const, code: 'NO_CONFIRMABLE' as const, message: motivo }
    // CAS: sólo si nadie tocó la venta desde la vista previa, y sólo desde DESCONOCIDO.
    const r = await tx.order.updateMany({
      where: { id: o.id, venueId: p.venueId, version: p.versionVista, contratoDePrecio: 'DESCONOCIDO' },
      data: { contratoDePrecio: 'IVA_INCLUIDO', version: { increment: 1 } },
    })
    if (r.count === 0) {
      return {
        ok: false as const,
        code: 'CAMBIO_DESDE_LA_VISTA' as const,
        message: 'La venta cambió desde que la revisaste. Vuelve a pedir la vista previa.',
      }
    }
    await writeLegacyActivityAuditTx(tx, {
      staffId: p.staffId,
      venueId: p.venueId,
      action: 'ORDER_PRICE_CONTRACT_CONFIRMED',
      entity: 'Order',
      entityId: o.id,
      data: { antes: 'DESCONOCIDO', despues: 'IVA_INCLUIDO', motivo: p.motivo, version: p.versionVista },
    })
    return { ok: true as const }
  })
}
```

Si el tipado de `tx` no encaja con `Cliente`, usar `Pick<Prisma.TransactionClient, 'estimate'>` y pasar `prisma` casteado en la vista previa; no usar `any`.

- [ ] **Step 4: Herramienta del MCP** en `src/mcp/tools/cfdi.ts`, justo después de `emit_refund_credit_note`, con su mismo orden de guardas: `guard.venueFilter(venueId)` → `guard.requirePermission('cfdi:issue', venueId)` → `venuesWithFeatureAccess([venueId], 'CFDI')` (sin plan ⇒ mensaje del paywall igual al de su vecina). Parámetros: `venueId`, `orderId`, `confirm?: boolean`, `version?: number`, `motivo?: string`.
  - Sin `confirm`: `vistaPreviaContrato`; `null` ⇒ `{ ok:false, message:'No encontré esa venta en este negocio.' }`; no confirmable ⇒ `{ ok:false, message: motivo }`; confirmable ⇒ `{ ok:false, requiresConfirmation:true, preview, message: 'Esto marcará la venta #<orderNumber> (cobrada $<totalMxn> el <fecha local>) como cobrada con IVA incluido. Con eso podrá facturarse con el IVA de cada producto. No emite ni cancela ninguna factura. Para confirmar, llama otra vez con confirm: true, version: <version> y un motivo.' }`.
  - Con `confirm: true`: exige `version` y `motivo` no vacío (si faltan ⇒ mensaje en español pidiéndolos); llama a `confirmarContratoIvaIncluido` con `staffId: scope.staffId`; al éxito `auditMcpWrite(scope, { action: 'ORDER_PRICE_CONTRACT_CONFIRMED', entity: 'Order', entityId: orderId, venueId, data: { motivo, version } })`.
  - Descripción de la herramienta en español, sin nombres de tablas, columnas ni Prisma.
- [ ] **Step 5: Prueba unitaria del MCP** calcada del arnés de `tests/unit/mcp-customer/write-confirm-gating.test.ts` (mocks de `@/mcp/guard`, `@/mcp/audit` y del servicio): (a) sin `confirm` ⇒ `requiresConfirmation: true`, el servicio de confirmar NO se llama y no hay auditoría; (b) `confirm:true` sin `version` ⇒ pide la versión, no confirma; (c) `confirm:true` completo ⇒ llama al servicio con `versionVista` y `motivo`, y audita; (d) sin la feature `CFDI` ⇒ no llama a nada.
- [ ] **Step 6: Verify** — integración (6 casos) y unitaria del MCP en verde; `tests/unit/mcp-customer/catalog-no-internals.test.ts`, `write-confirm-gating.test.ts` y `tools.test.ts` en verde (por ruta); typecheck del CI `errores TS: 0`.
- [ ] **Step 7: Sabotaje** — quitar `version: p.versionVista` del `where` del CAS ⇒ el caso 2 falla; restaurar. Mover `writeLegacyActivityAuditTx` fuera de la transacción ⇒ documentar qué prueba lo detecta (si ninguna, añadir una que fuerce el fallo del log con un `staffId` inexistente y verifique que el contrato NO cambió). Anotar en el reporte.
- [ ] **Step 8: Commit** con pathspec; `git show --stat HEAD`.

---

### Task 7: Cierre — verificación completa

- [ ] **Step 1:** typecheck del CI por avq-verify con `AVQ_TREE` ⇒ `errores TS: 0` en los dos lados.
- [ ] **Step 2:** unitaria completa en 4 partes por avq-verify (`npx jest --selectProjects unit --shard=N/4 --maxWorkers=2 --ci`, N = 1..4). Leer «Test Suites», no sólo «Tests». Cualquier fallo se compara contra `develop` (mismo archivo sin cambios + repetición exacta en DUAL) antes de clasificarlo como ajeno.
- [ ] **Step 3:** integración completa contra una base desechable `avoqado_h1a_test_20260808` en el servidor del puerto 5433 (crearla, `migrate deploy`, correr, borrarla). Imprimir y leer la URL antes de cada comando que migre.
- [ ] **Step 4:** en `av_db_25_iva_test`: `SELECT "contratoDePrecio", count(*) FROM "Order" GROUP BY 1` ⇒ ningún valor fuera de los tres; ningún `NULL`.
- [ ] **Step 5:** el controlador actualiza la fila del plan 2 en `.claude/rules/proyectos-por-fases.md` del workspace y la crónica `docs/proyectos/iva-por-producto--plan-2-contrato-de-precio.md`.

---

## Fuera de este plan, declarado (defectos PREEXISTENTES que la matriz destapó; no se tocan aquí)

- `discountEngine.service.ts` (aplicar ~l.820-842, quitar ~l.913-943) resta un 16 % estimado de `Order.taxAmount` aunque la orden no separe impuesto ⇒ `taxAmount` negativo persistido (ya documentado en `orderBalance.ts:213-231`). El plan 3 no usa `taxAmount` para decidir el contrato. Arreglo propuesto como tarea aparte: sólo tocar `taxAmount` si el contrato es `IVA_APARTE`.
- `estimate.mobile.service.ts` `convertToOrder`: `Order.total` bruto contra `OrderItem.total` neto. Con contrato `IVA_APARTE`, el plan 3 bloquea la rama mixta de esas ventas; el defecto de sumas es aparte.
- pos-sync: `PosSyncOrderItem` escribe `taxAmount` por renglón con default 0 (posible desajuste renglón/cabecera). Irrelevante hoy (0 negocios en el puente desde el 12-ago) y su contrato es `IVA_APARTE`.
