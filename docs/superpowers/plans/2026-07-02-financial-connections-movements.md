# Financial Connections — Movimientos (estado de cuenta) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que al hacer click en una cuenta de banco conectada (sección "Cuentas de banco" de Integraciones) el OWNER vea el desglose de
operaciones de esa cuenta: cuánto entró y cuánto salió (SPEI in/out, transferencias internas, dispersiones) más el estado de cuenta paginado
con filtro de fechas.

**Architecture:** Dos endpoints REST nuevos de solo lectura en avoqado-server (`GET /venues/:venueId/financial-accounts/:id/movements` y
`.../movements/stats`) que delegan al provider client vía el token cacheado/refrescado existente; el provider necesita el `idCuenta` de la
cuenta de dispersión (distinto del `idNegocio` que ya guardamos), que viene en el mismo payload de `/api/auth` que ya parseamos — se agrega
columna `externalCuentaId` con backfill perezoso para conexiones existentes. En el frontend, un Sheet de movimientos que se abre al hacer
click en la fila de la cuenta, con 4 tarjetas de totales y tabla paginada.

**Tech Stack:** avoqado-server (Node/Express/Prisma/axios/jest+nock) · avoqado-web-dashboard (React 18/TS/TanStack
Query/shadcn/react-i18next/vitest).

## Global Constraints

- **Repos y cwd por task:** Tasks 1-3 en `/Users/amieva/Documents/Programming/Avoqado/avoqado-server`; Tasks 4-6 en
  `/Users/amieva/Documents/Programming/Avoqado/avoqado-web-dashboard`; Task 7 ambos. Ambos repos comparten working tree con OTRA sesión
  activa: `git add` SIEMPRE con rutas explícitas (jamás `-A`/`.`), commitear INMEDIATAMENTE al verificar cada task (WIP retenido = barrido),
  y `prisma/schema.prisma` exige el protocolo quirúrgico (ver Task 1).
- **Contrato del provider (confirmado contra código en producción del dashboard Q-Pay, mismo API):**
  - `idCuenta` = `negocio.cuentaDispersion.idCuenta` dentro del response de `GET {base}/api/auth` (el mismo `fetchMe()` que ya usamos; ya
    leemos `cuentaDispersion.cuentaClabe/saldo/activo` de ahí).
  - Lista: `GET {base}/api/clients/movimientos/{idCuenta}` — query en notación punteada EXACTA: `Pagination.Page` (int, **0-based**),
    `Pagination.Size` (int), `FechaInicio`/`FechaFinal` (ISO date-time), opcional `IdEstatus` (int). Headers: los mismos
    `headers(accessToken)` del client (Bearer + mgPlatform). Response: `{ data: Movimiento[], total: number }`.
  - Campos de `Movimiento` (todos pueden venir null/ausentes; casing inconsistente → leer TODO con el helper `pick()` existente):
    `idOperacion, tipoOperacion, tipoMovimiento, concepto, fechaCreacion, monto (number), estatus, idEstatus (number), nombreBeneficiario, nombreOrdenante, referencia`.
  - Stats: `GET {base}/api/clients/movimientos/Estadisticas/{idCuenta}` — query `FechaInicio`/`FechaFinal`. Response (¡TODOS los numéricos
    llegan como **string**!):
    `nombre, cuentaClabe, montoTransaccionadoSpeiOut, comisionCobradaSpeiOut, numeroOperacionesSpeiOut, montoTransaccionadoSpeiIn, comisionCobradaSpeiIn, numeroOperacionesSpeiIn, montoTransaccionadoTransferenciaInterna, comisionCobradaTransferenciaInterna, numeroOperacionesTransferenciaInterna, montoTransaccionadoDispersion, comisionCobradaDispersion, numeroOperacionesDispersion`.
    Nota: transferencias internas y dispersiones NO vienen partidas en in/out — se presentan como categorías propias, sin inventar
    dirección.
- **Montos honestos:** un numérico ausente/no parseable es `null`, JAMÁS `0`. Parsear strings con un helper `toNum` (string→Number si
  finito, number passthrough, resto null). En UI, `null` → `—`.
- **Sin nombres de vendors** en código/campos: nuestra API expone nombres neutrales (`speiIn`, `speiOut`, `internalTransfers`,
  `dispersions`, `movements`).
- **Seguridad:** ambos endpoints van bajo `checkPermission('financialConnections:manage')` + `assertAccountBelongsToVenue` (404 en
  mismatch), igual que `/balance`. Solo lectura → sin rate limiter (paridad con balance). Sin auditoría de lecturas (paridad con balance).
  Validación de query: `size` cap a 50, `page ≥ 0`, fechas ISO válidas o 400.
- **Envelope:** `{ success: true, data }` como el resto del dominio.
- **i18n frontend:** CERO strings hardcodeados; agregar claves al namespace `financialConnections` en es/en/fr con paridad exacta de claves.
- **Dinero en UI:** `Currency()` de `@/utils/currency` + `tabular-nums`; fechas con `toLocaleString()` como ya hace la sección.
- **Query keys frontend:** `['financial-account-movements', accountId, filtros]` y `['financial-account-movement-stats', accountId, rango]`.
- **Verificación por task:** backend `npx jest tests/unit/services/financial-connections/ --silent` +
  `NODE_OPTIONS='--max-old-space-size=8192' npx tsc --noEmit`; frontend `npx vitest run <archivos>` + `npx tsc --noEmit`. Dev: backend ya
  corre en `localhost:3000` (tsx watch recarga solo al guardar); frontend `localhost:5173`. Cuenta viva conectada disponible para smoke
  (venue slug `avoqado-full`, owner@owner.com/owner).

---

### Task 1 (BE): Columna `externalCuentaId` + extracción del idCuenta

**Files:**

- Modify: `prisma/schema.prisma` (model FinancialAccount, ~línea 10354)
- Create: `prisma/migrations/<timestamp>_add_financial_account_external_cuenta_id/migration.sql`
- Modify: `src/services/financial-connections/types.ts` (ProviderAccount)
- Modify: `src/services/financial-connections/externalBank.client.ts` (normalizeAccounts)
- Modify: `src/services/financial-connections/financialConnection.service.ts` (persistAccounts)
- Test: `tests/unit/services/financial-connections/financialConnection.service.test.ts` (ajustar/agregar)

**Interfaces:**

- Produces: `FinancialAccount.externalCuentaId: string | null` (DB); `ProviderAccount.cuentaId: string | null`; `persistAccounts` lo guarda.
  Task 3 depende de `externalCuentaId` para llamar movimientos.

- [ ] **Step 1: PROTOCOLO schema.prisma compartido.** Correr `git status --short prisma/schema.prisma && git diff prisma/schema.prisma`. Si
      hay diff ajeno sin commitear: respaldar (`cp prisma/schema.prisma /tmp/schema-wip-backup.prisma`), materializar HEAD
      (`git show HEAD:prisma/schema.prisma > prisma/schema.prisma`), aplicar SOLO el cambio de Step 2, commitear, restaurar el respaldo
      re-aplicando tu cambio encima. Si el diff está limpio: editar directo.

- [ ] **Step 2: Agregar la columna al modelo** — en `model FinancialAccount`, después de `externalId String`:

```prisma
  externalId       String
  /// idCuenta de la cuenta de dispersión del proveedor (viene en cuentaDispersion.idCuenta
  /// del payload de sesión). Requerido para consultar movimientos; null en filas creadas
  /// antes de esta columna — se backfillea perezosamente al primer uso (ver service).
  externalCuentaId String?
```

- [ ] **Step 3: Migración.** Intentar `npx prisma migrate dev --name add_financial_account_external_cuenta_id --create-only`, revisar el SQL
      generado (debe ser SOLO `ALTER TABLE "FinancialAccount" ADD COLUMN "externalCuentaId" TEXT;`) y aplicar con `npx prisma migrate dev`.
      Si truena por drift ajeno: NUNCA `migrate reset`; fallback ya probado en este repo:
      `npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script` → revisar que el script solo
      tenga NUESTRO cambio → aplicar solo nuestra sentencia vía `psql` → crear el dir de migración a mano con ese SQL →
      `npx prisma migrate resolve --applied <nombre>`. Luego `npx prisma generate`.

- [ ] **Step 4: `ProviderAccount.cuentaId`** en `src/services/financial-connections/types.ts`:

```ts
export interface ProviderAccount {
  externalId: string
  /** idCuenta de la cuenta de dispersión — necesario para movimientos. Null si el provider no lo reporta. */
  cuentaId: string | null
  label: string | null
  clabe: string | null
  active: boolean | null
  balance: number | null // saldo si viene en el listado; null si no
}
```

- [ ] **Step 5: Extraerlo en `normalizeAccounts`** (externalBank.client.ts) — dentro del objeto retornado, junto a `clabe`:

```ts
return {
  externalId,
  cuentaId: pick<string>(cuenta, 'idCuenta') ?? null,
  label: pick<string>(n, 'nombre') ?? null,
  clabe: pick<string>(cuenta, 'cuentaClabe') ?? null,
  active: typeof pick(cuenta, 'activo') === 'boolean' ? (pick<boolean>(cuenta, 'activo') as boolean) : null,
  balance: typeof saldo === 'number' ? (saldo as number) : null,
}
```

- [ ] **Step 6: Guardarlo en `persistAccounts`** (financialConnection.service.ts) — agregar al `data` del createMany:

```ts
      externalId: a.externalId,
      externalCuentaId: a.cuentaId ?? null,
```

- [ ] **Step 7: Test.** En el test del service, el caso `startConnection: single negocio → auto-selects, CONNECTED` ya mockea
      `clientMock.connect` con accounts — agregar `cuentaId: 'cta-1'` al account mockeado y asertar que `db.financialAccount.createMany`
      recibió `externalCuentaId: 'cta-1'`:

```ts
const args = db.financialAccount.createMany.mock.calls.at(-1)[0]
expect(args.data[0].externalCuentaId).toBe('cta-1')
```

(Nota: los demás mocks de accounts sin `cuentaId` seguirán compilando si el test usa objetos literales laxos; si tsc exige el campo, agregar
`cuentaId: null` donde falte.)

- [ ] **Step 8: Verificar** — `npx jest tests/unit/services/financial-connections/ --silent` → verde;
      `NODE_OPTIONS='--max-old-space-size=8192' npx tsc --noEmit` → exit 0.

- [ ] **Step 9: Commit** (rutas explícitas; incluir el dir de migración):

```bash
git add prisma/schema.prisma prisma/migrations/*add_financial_account_external_cuenta_id* src/services/financial-connections/types.ts src/services/financial-connections/externalBank.client.ts src/services/financial-connections/financialConnection.service.ts tests/unit/services/financial-connections/financialConnection.service.test.ts
git commit -m "feat(financial-connections): capture provider cuentaId per account (needed for movements)"
```

---

### Task 2 (BE): Métodos de movimientos en el provider client

**Files:**

- Modify: `src/services/financial-connections/types.ts` (tipos nuevos + interface)
- Modify: `src/services/financial-connections/externalBank.client.ts` (implementación)
- Test: `tests/unit/services/financial-connections/externalBank.client.test.ts` (nock, seguir el estilo existente del archivo)

**Interfaces:**

- Consumes: `headers()`, `base()`, `pick()` ya existentes en el client; `ConnectionContext { accessToken }`.
- Produces (Task 3 los consume con estos nombres EXACTOS):

```ts
export interface ProviderMovement {
  id: string | null
  type: string | null          // tipoMovimiento
  operationType: string | null // tipoOperacion
  concept: string | null
  date: string | null          // fechaCreacion (ISO del provider, passthrough)
  amount: number | null
  status: string | null
  statusId: number | null
  beneficiary: string | null
  originator: string | null
  reference: string | null
}
export interface MovementPage { movements: ProviderMovement[]; total: number }
export interface MovementCategoryStats { amount: number | null; fee: number | null; count: number | null }
export interface MovementStats {
  accountName: string | null
  clabe: string | null
  speiIn: MovementCategoryStats
  speiOut: MovementCategoryStats
  internalTransfers: MovementCategoryStats
  dispersions: MovementCategoryStats
}
export interface MovementQuery { page: number; size: number; from?: string; to?: string }
// en FinancialProviderClient:
listMovements(ctx: ConnectionContext, cuentaId: string, query: MovementQuery): Promise<MovementPage>
getMovementStats(ctx: ConnectionContext, cuentaId: string, range: { from?: string; to?: string }): Promise<MovementStats>
```

- [ ] **Step 1: Tests nock que fallan.** En `externalBank.client.test.ts`, siguiendo el patrón de mocks nock del archivo (mismo base URL de
      test):

```ts
it('listMovements: pagina con notación punteada y normaliza el movimiento', async () => {
  nock(BASE)
    .get('/api/clients/movimientos/cta-1')
    .query({ 'Pagination.Page': '0', 'Pagination.Size': '10', FechaInicio: '2026-07-01T00:00:00.000Z' })
    .reply(200, {
      total: 1,
      data: [
        {
          idOperacion: 'op1',
          tipoMovimiento: 'SPEI IN',
          tipoOperacion: 'Abono',
          concepto: 'Pago',
          fechaCreacion: '2026-07-01T10:00:00Z',
          monto: 150.5,
          estatus: 'Liquidado',
          idEstatus: 3,
          nombreOrdenante: 'ACME',
          referencia: '777',
        },
      ],
    })
  const r = await externalBankClient.listMovements({ accessToken: 't' }, 'cta-1', { page: 0, size: 10, from: '2026-07-01T00:00:00.000Z' })
  expect(r.total).toBe(1)
  expect(r.movements[0]).toMatchObject({ id: 'op1', type: 'SPEI IN', amount: 150.5, originator: 'ACME', beneficiary: null })
})

it('getMovementStats: parsea los montos-string a número y preserva null en no-parseables', async () => {
  nock(BASE).get('/api/clients/movimientos/Estadisticas/cta-1').query(true).reply(200, {
    nombre: 'AV-X',
    cuentaClabe: '7381',
    montoTransaccionadoSpeiIn: '1500.75',
    numeroOperacionesSpeiIn: '3',
    comisionCobradaSpeiIn: '12.5',
    montoTransaccionadoSpeiOut: 'garbage',
    numeroOperacionesSpeiOut: '1',
    comisionCobradaSpeiOut: '0',
    montoTransaccionadoTransferenciaInterna: '0',
    numeroOperacionesTransferenciaInterna: '0',
    comisionCobradaTransferenciaInterna: '0',
    montoTransaccionadoDispersion: '200',
    numeroOperacionesDispersion: '2',
    comisionCobradaDispersion: '1',
  })
  const s = await externalBankClient.getMovementStats({ accessToken: 't' }, 'cta-1', { from: '2026-07-01T00:00:00.000Z' })
  expect(s.speiIn).toEqual({ amount: 1500.75, count: 3, fee: 12.5 })
  expect(s.speiOut.amount).toBeNull() // 'garbage' NO se convierte en 0
  expect(s.dispersions.amount).toBe(200)
})
```

- [ ] **Step 2: Correr → FAIL** (`listMovements` no existe):
      `npx jest tests/unit/services/financial-connections/externalBank.client.test.ts --silent`.

- [ ] **Step 3: Tipos + interface** en types.ts (bloque de "Produces" arriba, literal) y **implementación** en externalBank.client.ts:

```ts
/** Números del provider que llegan como string ("1500.75") — u honestamente null. */
function toNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function normalizeMovement(m: unknown): ProviderMovement {
  return {
    id: pick<string>(m, 'idOperacion') ?? null,
    type: pick<string>(m, 'tipoMovimiento') ?? null,
    operationType: pick<string>(m, 'tipoOperacion') ?? null,
    concept: pick<string>(m, 'concepto') ?? null,
    date: pick<string>(m, 'fechaCreacion') ?? null,
    amount: toNum(pick(m, 'monto')),
    status: pick<string>(m, 'estatus') ?? null,
    statusId: toNum(pick(m, 'idEstatus')),
    beneficiary: pick<string>(m, 'nombreBeneficiario') ?? null,
    originator: pick<string>(m, 'nombreOrdenante') ?? null,
    reference: pick<string>(m, 'referencia') ?? null,
  }
}
```

Y en el objeto `externalBankClient`:

```ts
  async listMovements(ctx: ConnectionContext, cuentaId: string, query: MovementQuery): Promise<MovementPage> {
    const params: Record<string, unknown> = { 'Pagination.Page': query.page, 'Pagination.Size': query.size }
    if (query.from) params.FechaInicio = query.from
    if (query.to) params.FechaFinal = query.to
    const { data } = await axios.get(`${base()}/api/clients/movimientos/${cuentaId}`, {
      headers: headers(ctx.accessToken),
      params,
      timeout: 20_000,
    })
    const raw = pick<unknown[]>(data, 'data')
    return {
      movements: Array.isArray(raw) ? raw.map(normalizeMovement) : [],
      total: toNum(pick(data, 'total')) ?? 0,
    }
  },

  async getMovementStats(ctx: ConnectionContext, cuentaId: string, range: { from?: string; to?: string }): Promise<MovementStats> {
    const params: Record<string, unknown> = {}
    if (range.from) params.FechaInicio = range.from
    if (range.to) params.FechaFinal = range.to
    const { data } = await axios.get(`${base()}/api/clients/movimientos/Estadisticas/${cuentaId}`, {
      headers: headers(ctx.accessToken),
      params,
      timeout: 20_000,
    })
    const cat = (suffix: string): MovementCategoryStats => ({
      amount: toNum(pick(data, `montoTransaccionado${suffix}`)),
      fee: toNum(pick(data, `comisionCobrada${suffix}`)),
      count: toNum(pick(data, `numeroOperaciones${suffix}`)),
    })
    return {
      accountName: pick<string>(data, 'nombre') ?? null,
      clabe: pick<string>(data, 'cuentaClabe') ?? null,
      speiIn: cat('SpeiIn'),
      speiOut: cat('SpeiOut'),
      internalTransfers: cat('TransferenciaInterna'),
      dispersions: cat('Dispersion'),
    }
  },
```

(Nota: si `pick()` no soporta claves compuestas dinámicas con template string, usar la variante que el helper permita — leerlo antes; en el
peor caso, indexar case-insensitive igual que hace pick internamente.)

- [ ] **Step 4: Correr → PASS** ambos tests nuevos + los existentes del archivo.

- [ ] **Step 5: Verificar** tsc exit 0 y **commit**:

```bash
git add src/services/financial-connections/types.ts src/services/financial-connections/externalBank.client.ts tests/unit/services/financial-connections/externalBank.client.test.ts
git commit -m "feat(financial-connections): provider client movements list + in/out stats (string-number safe)"
```

---

### Task 3 (BE): Service + endpoints REST de movimientos

**Files:**

- Modify: `src/services/financial-connections/financialConnection.service.ts`
- Modify: `src/controllers/dashboard/financialConnection.controller.ts`
- Modify: `src/routes/dashboard/financialConnection.routes.ts`
- Test: `tests/unit/services/financial-connections/financialConnection.service.test.ts`

**Interfaces:**

- Consumes: `accessTokenFor(conn)` (interno, ya existe — cache + refresh bajo lock), `getFinancialProviderClient`, tipos de Task 2,
  `externalCuentaId` de Task 1.
- Produces: `getMovementsForAccount(financialAccountId, q: MovementQuery): Promise<MovementPage>` y
  `getMovementStatsForAccount(financialAccountId, range): Promise<MovementStats>`; REST
  `GET /api/v1/dashboard/venues/:venueId/financial-accounts/:id/movements` (query `page`, `size`, `from`, `to`) y `GET .../movements/stats`
  (query `from`, `to`) → `{ success: true, data }`.

- [ ] **Step 1: Tests que fallan** (mock db + clientMock como el resto del archivo):

```ts
it('getMovementsForAccount: usa externalCuentaId y delega al client', async () => {
  db.financialAccount.findUniqueOrThrow.mockResolvedValue({
    id: 'fa1',
    externalId: 'neg-1',
    externalCuentaId: 'cta-1',
    connection: {
      id: 'c1',
      mode: 'SELF_CONNECT',
      grantEnc: encFixture(),
      tokenVersion: 0,
      deviceIdentifier: 'dev',
      status: 'CONNECTED',
      provider: { code: 'EXTERNAL_BANK' },
    },
  })
  db.financialConnection.findUniqueOrThrow.mockResolvedValue({ id: 'c1', grantEnc: encFixture(), tokenVersion: 0, status: 'CONNECTED' })
  clientMock.refresh.mockResolvedValue({ grant: { refreshToken: 'r2' }, ctx: { accessToken: 'acc' } })
  clientMock.listMovements.mockResolvedValue({ movements: [], total: 0 })
  const r = await svc.getMovementsForAccount('fa1', { page: 0, size: 10 })
  expect(clientMock.listMovements).toHaveBeenCalledWith(expect.objectContaining({ accessToken: expect.any(String) }), 'cta-1', {
    page: 0,
    size: 10,
  })
  expect(r.total).toBe(0)
})

it('getMovementsForAccount: backfillea externalCuentaId perezosamente cuando es null (fila pre-columna)', async () => {
  db.financialAccount.findUniqueOrThrow.mockResolvedValue({
    id: 'fa2',
    externalId: 'neg-1',
    externalCuentaId: null,
    connection: {
      id: 'c2',
      mode: 'SELF_CONNECT',
      grantEnc: encFixture(),
      tokenVersion: 0,
      deviceIdentifier: 'dev',
      status: 'CONNECTED',
      provider: { code: 'EXTERNAL_BANK' },
    },
  })
  db.financialConnection.findUniqueOrThrow.mockResolvedValue({ id: 'c2', grantEnc: encFixture(), tokenVersion: 0, status: 'CONNECTED' })
  clientMock.refresh.mockResolvedValue({ grant: { refreshToken: 'r2' }, ctx: { accessToken: 'acc' } })
  clientMock.listAccounts.mockResolvedValue([
    { externalId: 'neg-1', cuentaId: 'cta-9', label: null, clabe: null, active: null, balance: null },
  ])
  clientMock.listMovements.mockResolvedValue({ movements: [], total: 0 })
  await svc.getMovementsForAccount('fa2', { page: 0, size: 10 })
  expect(db.financialAccount.update).toHaveBeenCalledWith({ where: { id: 'fa2' }, data: { externalCuentaId: 'cta-9' } })
  expect(clientMock.listMovements).toHaveBeenCalledWith(expect.anything(), 'cta-9', expect.anything())
})

it('getMovementsForAccount: si el provider no reporta cuentaId → BadRequest, no 500', async () => {
  db.financialAccount.findUniqueOrThrow.mockResolvedValue({
    id: 'fa3',
    externalId: 'neg-x',
    externalCuentaId: null,
    connection: {
      id: 'c3',
      mode: 'SELF_CONNECT',
      grantEnc: encFixture(),
      tokenVersion: 0,
      deviceIdentifier: 'dev',
      status: 'CONNECTED',
      provider: { code: 'EXTERNAL_BANK' },
    },
  })
  db.financialConnection.findUniqueOrThrow.mockResolvedValue({ id: 'c3', grantEnc: encFixture(), tokenVersion: 0, status: 'CONNECTED' })
  clientMock.refresh.mockResolvedValue({ grant: { refreshToken: 'r2' }, ctx: { accessToken: 'acc' } })
  clientMock.listAccounts.mockResolvedValue([])
  await expect(svc.getMovementsForAccount('fa3', { page: 0, size: 10 })).rejects.toThrow()
})
```

(Ojo tokenCache del módulo: usar ids de conexión NUEVOS — c1/c2/c3 pueden chocar con tests previos del archivo; si chocan, usar
`cm-1`/`cm-2`/`cm-3`.)

- [ ] **Step 2: Correr → FAIL.**

- [ ] **Step 3: Implementar en el service:**

```ts
import type { Grant, ProviderAccount, MovementPage, MovementQuery, MovementStats } from './types'

/** Resuelve el idCuenta del provider para una FinancialAccount, backfilleando filas pre-columna. */
async function resolveCuentaId(
  fa: { id: string; externalId: string; externalCuentaId: string | null },
  conn: Parameters<typeof accessTokenFor>[0],
): Promise<{ cuentaId: string; accessToken: string }> {
  const accessToken = await accessTokenFor(conn)
  if (fa.externalCuentaId) return { cuentaId: fa.externalCuentaId, accessToken }
  // Fila creada antes de la columna: pedir las cuentas al provider y backfillear.
  const client = clientFor(conn.provider.code)
  const accounts = await client.listAccounts({ accessToken })
  const match = accounts.find(a => a.externalId === fa.externalId)
  if (!match?.cuentaId) throw new BadRequestError('El proveedor no reporta cuenta de movimientos para este negocio.')
  await prisma.financialAccount.update({ where: { id: fa.id }, data: { externalCuentaId: match.cuentaId } })
  return { cuentaId: match.cuentaId, accessToken }
}

export async function getMovementsForAccount(financialAccountId: string, q: MovementQuery): Promise<MovementPage> {
  const fa = await prisma.financialAccount.findUniqueOrThrow({
    where: { id: financialAccountId },
    include: { connection: { include: { provider: true } } },
  })
  const { cuentaId, accessToken } = await resolveCuentaId(fa, fa.connection)
  return clientFor(fa.connection.provider.code).listMovements({ accessToken }, cuentaId, q)
}

export async function getMovementStatsForAccount(
  financialAccountId: string,
  range: { from?: string; to?: string },
): Promise<MovementStats> {
  const fa = await prisma.financialAccount.findUniqueOrThrow({
    where: { id: financialAccountId },
    include: { connection: { include: { provider: true } } },
  })
  const { cuentaId, accessToken } = await resolveCuentaId(fa, fa.connection)
  return clientFor(fa.connection.provider.code).getMovementStats({ accessToken }, cuentaId, range)
}
```

Verificar que `externalBankClient.listAccounts` exista implementado (la interface lo declara); si falta, implementarlo:
`async listAccounts(ctx) { return normalizeAccounts(await fetchMe(ctx.accessToken)) }`.

- [ ] **Step 4: Controller + routes.** En el controller:

```ts
const MAX_MOVEMENTS_PAGE_SIZE = 50

function parseIsoDateParam(v: unknown, name: string): string | undefined {
  if (v == null || v === '') return undefined
  const d = new Date(String(v))
  if (Number.isNaN(d.getTime())) throw new BadRequestError(`${name} debe ser fecha ISO válida.`)
  return d.toISOString()
}

export async function getMovements(req: Request, res: Response, next: NextFunction) {
  try {
    await assertAccountBelongsToVenue(req.params.id, req.params.venueId)
    const page = Math.max(0, Number(req.query.page ?? 0) || 0)
    const size = Math.min(MAX_MOVEMENTS_PAGE_SIZE, Math.max(1, Number(req.query.size ?? 10) || 10))
    const from = parseIsoDateParam(req.query.from, 'from')
    const to = parseIsoDateParam(req.query.to, 'to')
    res.json({ success: true, data: await svc.getMovementsForAccount(req.params.id, { page, size, from, to }) })
  } catch (e) {
    next(e)
  }
}

export async function getMovementStats(req: Request, res: Response, next: NextFunction) {
  try {
    await assertAccountBelongsToVenue(req.params.id, req.params.venueId)
    const from = parseIsoDateParam(req.query.from, 'from')
    const to = parseIsoDateParam(req.query.to, 'to')
    res.json({ success: true, data: await svc.getMovementStatsForAccount(req.params.id, { from, to }) })
  } catch (e) {
    next(e)
  }
}
```

En routes (junto a `/:id/balance`; el orden importa: registrar `/movements/stats` ANTES de `/movements` no es necesario — son paths
distintos — pero sí antes de cualquier catch-all):

```ts
venueFinancialAccountRoutes.get('/:id/movements', checkPermission('financialConnections:manage'), ctrl.getMovements)
venueFinancialAccountRoutes.get('/:id/movements/stats', checkPermission('financialConnections:manage'), ctrl.getMovementStats)
```

- [ ] **Step 5: Correr → PASS** todos; tsc exit 0.

- [ ] **Step 6: Smoke curl en vivo** (hay una conexión CONNECTED con token cacheado): login `owner@owner.com`/`owner` con cookie jar,
      obtener el accountId de `GET /api/v1/dashboard/venues/<venueId>/financial-connections`, luego
      `GET .../financial-accounts/<id>/movements?page=0&size=5` → 200 con `{movements, total}` reales y
      `GET .../movements/stats?from=<hace 30 días ISO>` → 200 con montos numéricos. Pegar los dos responses (truncados) en el reporte. Si la
      conexión degradó a NEEDS_REAUTH (token expirado), documentarlo y validar solo forma del error (400 honesto) — NO pedir códigos 2FA.

- [ ] **Step 7: Commit:**

```bash
git add src/services/financial-connections/financialConnection.service.ts src/controllers/dashboard/financialConnection.controller.ts src/routes/dashboard/financialConnection.routes.ts tests/unit/services/financial-connections/financialConnection.service.test.ts src/services/financial-connections/externalBank.client.ts
git commit -m "feat(financial-connections): venue-scoped movements + stats endpoints with lazy cuentaId backfill"
```

---

### Task 4 (FE): Service frontend de movimientos

**Files:**

- Modify: `src/services/financialConnection.service.ts`
- Test: `src/services/__tests__/financialConnection.service.test.ts`

**Interfaces:**

- Produces (Task 6 los usa con estos nombres):

```ts
export interface AccountMovement {
  id: string | null
  type: string | null
  operationType: string | null
  concept: string | null
  date: string | null
  amount: number | null
  status: string | null
  statusId: number | null
  beneficiary: string | null
  originator: string | null
  reference: string | null
}
export interface MovementsPage { movements: AccountMovement[]; total: number }
export interface MovementCategoryStats { amount: number | null; fee: number | null; count: number | null }
export interface AccountMovementStats {
  accountName: string | null
  clabe: string | null
  speiIn: MovementCategoryStats
  speiOut: MovementCategoryStats
  internalTransfers: MovementCategoryStats
  dispersions: MovementCategoryStats
}
// en financialConnectionAPI:
getMovements(venueId, financialAccountId, opts: { page: number; size: number; from?: string; to?: string }): Promise<MovementsPage>
getMovementStats(venueId, financialAccountId, range: { from?: string; to?: string }): Promise<AccountMovementStats>
```

- [ ] **Step 1: Tests que fallan** (mismo patrón vi.mock('@/api') del archivo):

```ts
it('getMovements: GET con query params y desenvuelve data', async () => {
  mocked.get.mockResolvedValue({ data: { success: true, data: { movements: [{ id: 'op1', amount: 10 }], total: 1 } } })
  const r = await financialConnectionAPI.getMovements('v1', 'fa1', { page: 0, size: 10, from: '2026-07-01T00:00:00.000Z' })
  expect(mocked.get).toHaveBeenCalledWith('/api/v1/dashboard/venues/v1/financial-accounts/fa1/movements', {
    params: { page: 0, size: 10, from: '2026-07-01T00:00:00.000Z' },
  })
  expect(r.total).toBe(1)
})

it('getMovementStats: GET stats, amounts null se preservan', async () => {
  mocked.get.mockResolvedValue({
    data: {
      success: true,
      data: {
        accountName: 'X',
        clabe: '7381',
        speiIn: { amount: null, fee: null, count: 0 },
        speiOut: { amount: 5, fee: 0, count: 1 },
        internalTransfers: { amount: 0, fee: 0, count: 0 },
        dispersions: { amount: 0, fee: 0, count: 0 },
      },
    },
  })
  const s = await financialConnectionAPI.getMovementStats('v1', 'fa1', {})
  expect(mocked.get).toHaveBeenCalledWith('/api/v1/dashboard/venues/v1/financial-accounts/fa1/movements/stats', { params: {} })
  expect(s.speiIn.amount).toBeNull()
})
```

- [ ] **Step 2: FAIL → implementar:**

```ts
  async getMovements(
    venueId: string,
    financialAccountId: string,
    opts: { page: number; size: number; from?: string; to?: string },
  ): Promise<MovementsPage> {
    const params: Record<string, unknown> = { page: opts.page, size: opts.size }
    if (opts.from) params.from = opts.from
    if (opts.to) params.to = opts.to
    const { data } = await api.get(`${BASE}/venues/${venueId}/financial-accounts/${financialAccountId}/movements`, { params })
    return data.data
  },

  async getMovementStats(
    venueId: string,
    financialAccountId: string,
    range: { from?: string; to?: string },
  ): Promise<AccountMovementStats> {
    const params: Record<string, unknown> = {}
    if (range.from) params.from = range.from
    if (range.to) params.to = range.to
    const { data } = await api.get(`${BASE}/venues/${venueId}/financial-accounts/${financialAccountId}/movements/stats`, { params })
    return data.data
  },
```

- [ ] **Step 3: PASS + tsc exit 0 + commit:**

```bash
git add src/services/financialConnection.service.ts src/services/__tests__/financialConnection.service.test.ts
git commit -m "feat(financial-connections): movements + stats API client methods"
```

---

### Task 5 (FE): i18n de movimientos (es/en/fr, paridad exacta)

**Files:**

- Modify: `src/locales/es/financialConnections.json`, `src/locales/en/financialConnections.json`, `src/locales/fr/financialConnections.json`

- [ ] **Step 1:** Agregar a los 3 archivos un bloque top-level `"movements"` (mismas claves en los 3). ES:

```json
"movements": {
  "title": "Movimientos",
  "subtitle": "Estado de cuenta de {{label}}",
  "range": { "7": "Últimos 7 días", "30": "Últimos 30 días", "90": "Últimos 90 días" },
  "stats": {
    "speiIn": "SPEI recibido",
    "speiOut": "SPEI enviado",
    "internalTransfers": "Transferencias internas",
    "dispersions": "Dispersiones",
    "operations": "{{count}} operaciones"
  },
  "table": {
    "date": "Fecha",
    "concept": "Concepto",
    "type": "Tipo",
    "counterparty": "Contraparte",
    "reference": "Referencia",
    "status": "Estatus",
    "amount": "Monto",
    "empty": "Sin movimientos en este periodo.",
    "loadError": "No se pudieron cargar los movimientos.",
    "previous": "Anterior",
    "next": "Siguiente",
    "pageOf": "Página {{page}} de {{pages}}"
  },
  "openAria": "Ver movimientos de la cuenta"
}
```

EN:

```json
"movements": {
  "title": "Movements",
  "subtitle": "Account statement for {{label}}",
  "range": { "7": "Last 7 days", "30": "Last 30 days", "90": "Last 90 days" },
  "stats": {
    "speiIn": "SPEI received",
    "speiOut": "SPEI sent",
    "internalTransfers": "Internal transfers",
    "dispersions": "Disbursements",
    "operations": "{{count}} operations"
  },
  "table": {
    "date": "Date",
    "concept": "Concept",
    "type": "Type",
    "counterparty": "Counterparty",
    "reference": "Reference",
    "status": "Status",
    "amount": "Amount",
    "empty": "No movements in this period.",
    "loadError": "Movements could not be loaded.",
    "previous": "Previous",
    "next": "Next",
    "pageOf": "Page {{page}} of {{pages}}"
  },
  "openAria": "View account movements"
}
```

FR:

```json
"movements": {
  "title": "Mouvements",
  "subtitle": "Relevé du compte {{label}}",
  "range": { "7": "7 derniers jours", "30": "30 derniers jours", "90": "90 derniers jours" },
  "stats": {
    "speiIn": "SPEI reçu",
    "speiOut": "SPEI envoyé",
    "internalTransfers": "Virements internes",
    "dispersions": "Déboursements",
    "operations": "{{count}} opérations"
  },
  "table": {
    "date": "Date",
    "concept": "Concept",
    "type": "Type",
    "counterparty": "Contrepartie",
    "reference": "Référence",
    "status": "Statut",
    "amount": "Montant",
    "empty": "Aucun mouvement sur cette période.",
    "loadError": "Impossible de charger les mouvements.",
    "previous": "Précédent",
    "next": "Suivant",
    "pageOf": "Page {{page}} sur {{pages}}"
  },
  "openAria": "Voir les mouvements du compte"
}
```

- [ ] **Step 2: Verificar** paridad + JSON:
      `node -e "const ks=o=>Object.keys(o).flatMap(k=>typeof o[k]==='object'&&o[k]?ks(o[k]).map(s=>k+'.'+s):[k]); const [a,b,c]=['es','en','fr'].map(l=>ks(require('./src/locales/'+l+'/financialConnections.json'))); if(a.join()!==b.join()||a.join()!==c.join()) throw new Error('key mismatch'); console.log('parity OK', a.length, 'keys')"`
      → parity OK. `npx tsc --noEmit` → exit 0.

- [ ] **Step 3: Commit:**

```bash
git add src/locales/es/financialConnections.json src/locales/en/financialConnections.json src/locales/fr/financialConnections.json
git commit -m "feat(financial-connections): i18n for account movements (es/en/fr)"
```

---

### Task 6 (FE): Sheet de movimientos + fila clickeable

**Files:**

- Create: `src/pages/Venue/Edit/components/BankAccountMovementsSheet.tsx`
- Modify: `src/pages/Venue/Edit/components/BankAccountsSection.tsx` (AccountRow clickeable + montar el sheet)

**Interfaces:**

- Consumes: `financialConnectionAPI.getMovements/getMovementStats` + tipos (Task 4), i18n (Task 5), `Currency`, shadcn `Sheet` (leer las
  props reales en `src/components/ui/sheet.tsx` y el uso de `AggregatorDetailSheet.tsx` como referencia canónica), `Skeleton`, `Badge`,
  `Button`, `Select` (o botones de preset si Select no existe — seguir lo que haya en `src/components/ui/`).
- Produces: `<BankAccountMovementsSheet open onClose venueId account />` con `account: FinancialAccountSummary`.

- [ ] **Step 1: Componente completo:**

```tsx
// src/pages/Venue/Edit/components/BankAccountMovementsSheet.tsx
/**
 * BankAccountMovementsSheet — estado de cuenta de una cuenta bancaria conectada.
 * 4 tarjetas de totales por categoría (SPEI in/out, transferencias, dispersiones)
 * + tabla paginada de movimientos, con rango de fechas preseleccionable.
 * Solo lectura. Montos honestos: null → '—', jamás $0.
 */
import { useMemo, useState } from 'react'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ArrowDownLeft, ArrowUpRight, Landmark, Loader2, Repeat, Send } from 'lucide-react'

import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Currency } from '@/utils/currency'
import { financialConnectionAPI, type FinancialAccountSummary, type MovementCategoryStats } from '@/services/financialConnection.service'

const PAGE_SIZE = 10
const RANGE_PRESETS = [7, 30, 90] as const
type RangePreset = (typeof RANGE_PRESETS)[number]

function rangeToIso(days: RangePreset): { from: string; to: string } {
  const to = new Date()
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000)
  return { from: from.toISOString(), to: to.toISOString() }
}

function StatCard({ label, icon, stats }: { label: string; icon: React.ReactNode; stats: MovementCategoryStats | undefined }) {
  const { t } = useTranslation('financialConnections')
  return (
    <div className="flex flex-col gap-1 rounded-lg border p-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {icon}
        {label}
      </div>
      <span className="text-lg font-semibold tabular-nums">{stats?.amount != null ? Currency(stats.amount) : '—'}</span>
      <span className="text-xs text-muted-foreground">{t('movements.stats.operations', { count: stats?.count ?? 0 })}</span>
    </div>
  )
}

interface Props {
  open: boolean
  onClose: () => void
  venueId: string
  account: FinancialAccountSummary
}

export function BankAccountMovementsSheet({ open, onClose, venueId, account }: Props) {
  const { t } = useTranslation('financialConnections')
  const [rangeDays, setRangeDays] = useState<RangePreset>(30)
  const [page, setPage] = useState(0)
  const range = useMemo(() => rangeToIso(rangeDays), [rangeDays])

  const stats = useQuery({
    queryKey: ['financial-account-movement-stats', account.id, rangeDays],
    queryFn: () => financialConnectionAPI.getMovementStats(venueId, account.id, range),
    enabled: open,
  })

  const movs = useQuery({
    queryKey: ['financial-account-movements', account.id, rangeDays, page],
    queryFn: () => financialConnectionAPI.getMovements(venueId, account.id, { page, size: PAGE_SIZE, ...range }),
    enabled: open,
    placeholderData: keepPreviousData,
  })

  const totalPages = Math.max(1, Math.ceil((movs.data?.total ?? 0) / PAGE_SIZE))

  const selectRange = (d: RangePreset) => {
    setRangeDays(d)
    setPage(0)
  }

  return (
    <Sheet open={open} onOpenChange={o => !o && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Landmark className="h-5 w-5" aria-hidden />
            {t('movements.title')}
          </SheetTitle>
          <SheetDescription>
            {t('movements.subtitle', { label: account.label ?? account.externalId })}
            {account.clabe && <span className="ml-2 text-xs">CLABE {account.clabe}</span>}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 flex flex-col gap-4">
          <div className="flex gap-2">
            {RANGE_PRESETS.map(d => (
              <Button key={d} size="sm" variant={rangeDays === d ? 'default' : 'outline'} onClick={() => selectRange(d)}>
                {t(`movements.range.${d}`)}
              </Button>
            ))}
          </div>

          {stats.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatCard
                label={t('movements.stats.speiIn')}
                icon={<ArrowDownLeft className="h-4 w-4" aria-hidden />}
                stats={stats.data?.speiIn}
              />
              <StatCard
                label={t('movements.stats.speiOut')}
                icon={<ArrowUpRight className="h-4 w-4" aria-hidden />}
                stats={stats.data?.speiOut}
              />
              <StatCard
                label={t('movements.stats.internalTransfers')}
                icon={<Repeat className="h-4 w-4" aria-hidden />}
                stats={stats.data?.internalTransfers}
              />
              <StatCard
                label={t('movements.stats.dispersions')}
                icon={<Send className="h-4 w-4" aria-hidden />}
                stats={stats.data?.dispersions}
              />
            </div>
          )}

          {movs.isLoading && <Skeleton className="h-48 w-full" />}
          {movs.isError && <p className="text-sm text-destructive">{t('movements.table.loadError')}</p>}
          {movs.data && movs.data.movements.length === 0 && !movs.isLoading && (
            <p className="text-sm text-muted-foreground">{t('movements.table.empty')}</p>
          )}

          {movs.data && movs.data.movements.length > 0 && (
            <div className="flex flex-col gap-2">
              {movs.data.movements.map((m, i) => (
                <div key={m.id ?? i} className="flex items-start justify-between gap-3 rounded-lg border p-3">
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-medium">{m.concept ?? m.type ?? '—'}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {[m.type, m.beneficiary ?? m.originator, m.reference].filter(Boolean).join(' · ')}
                    </span>
                    <span className="text-xs text-muted-foreground">{m.date ? new Date(m.date).toLocaleString() : '—'}</span>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span className="font-semibold tabular-nums">{m.amount != null ? Currency(m.amount) : '—'}</span>
                    {m.status && <Badge variant="outline">{m.status}</Badge>}
                  </div>
                </div>
              ))}
              <div className="flex items-center justify-between pt-2">
                <Button size="sm" variant="outline" disabled={page === 0 || movs.isFetching} onClick={() => setPage(p => p - 1)}>
                  {t('movements.table.previous')}
                </Button>
                <span className="text-xs text-muted-foreground">
                  {movs.isFetching && <Loader2 className="mr-1 inline h-3 w-3 animate-spin" aria-hidden />}
                  {t('movements.table.pageOf', { page: page + 1, pages: totalPages })}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={page + 1 >= totalPages || movs.isFetching}
                  onClick={() => setPage(p => p + 1)}
                >
                  {t('movements.table.next')}
                </Button>
              </div>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
```

(Si las exports reales de `@/components/ui/sheet` difieren, ajustar al uso canónico de `AggregatorDetailSheet.tsx`. Si `keepPreviousData` no
existe en la versión de TanStack del repo, usar `placeholderData: (prev) => prev`.)

- [ ] **Step 2: Fila clickeable en `BankAccountsSection.tsx`.** En `AccountRow`: agregar prop `onOpen: () => void`; envolver el contenido
      izquierdo en un
      `<button type="button" onClick={onOpen} aria-label={t('movements.openAria')} className="flex min-w-0 flex-1 flex-col text-left cursor-pointer">`
      (el botón de refresh ya es un botón aparte a la derecha — verificar que quede FUERA del nuevo button para no anidar botones,
      restructurando el JSX si hace falta: contenedor flex con [button-izquierdo | montos+acciones-derecha]). En `ConnectionCard`: estado
      `const [movementsAccount, setMovementsAccount] = useState<FinancialAccountSummary | null>(null)`, pasar
      `onOpen={() => setMovementsAccount(a)}` a cada `AccountRow`, y montar al final:

```tsx
{
  movementsAccount && (
    <BankAccountMovementsSheet
      open={!!movementsAccount}
      onClose={() => setMovementsAccount(null)}
      venueId={venueId}
      account={movementsAccount}
    />
  )
}
```

Import: `import { BankAccountMovementsSheet } from './BankAccountMovementsSheet'`.

- [ ] **Step 3: Verificar** `npx tsc --noEmit` exit 0;
      `npx vitest run src/services/__tests__/financialConnection.service.test.ts src/pages/Venue/components/__tests__/bankConnectSteps.test.ts`
      verde; `npm run build` success.

- [ ] **Step 4: Commit:**

```bash
git add src/pages/Venue/Edit/components/BankAccountMovementsSheet.tsx src/pages/Venue/Edit/components/BankAccountsSection.tsx
git commit -m "feat(financial-connections): account movements sheet (in/out stats + paginated statement)"
```

---

### Task 7: Verificación integral (ambos repos) + smoke E2E

**Files:** ninguno nuevo (solo correcciones que surjan).

- [ ] **Step 1 (BE):** `npx jest tests/unit/services/financial-connections/ --silent` verde;
      `NODE_OPTIONS='--max-old-space-size=8192' npx tsc --noEmit` exit 0.
- [ ] **Step 2 (FE):** `npx vitest run` toda la suite verde; `npx tsc --noEmit` exit 0; `npm run build` success.
- [ ] **Step 3 (E2E, con la conexión viva):** en `localhost:5173` como owner → Integraciones → click en la fila de la cuenta conectada → el
      Sheet abre, las 4 tarjetas muestran montos (o `—` honesto), la tabla lista movimientos reales, paginación avanza/retrocede, cambiar
      rango 7/30/90 refetchea. Vía Playwright si está disponible; si la conexión degradó a NEEDS_REAUTH, documentar el estado honesto que
      muestra la UI y marcar el punto como "pendiente de reconexión humana" — NO pedir códigos 2FA.
- [ ] **Step 4:** Commit de correcciones si las hubo (rutas explícitas) y reporte final: resultados por paso + capturas.

---

## Self-Review (hecho al escribir el plan)

- **Cobertura:** in/out (stats cards, Task 2/6), desglose paginado (Tasks 2/3/6), click en la cuenta (Task 6), mapeo idNegocio→idCuenta con
  backfill para la conexión ya viva (Tasks 1/3), i18n ×3 (Task 5), guardas de seguridad (Task 3), verificación (Task 7).
- **Placeholders:** ninguno; los dos puntos de verificación contra el repo real (props de Sheet, firma de pick) señalan su referencia
  canónica.
- **Consistencia de tipos:** `MovementPage/MovementStats/MovementQuery/ProviderMovement` definidos en Task 2 y consumidos idénticos en Task
  3; espejo frontend (`MovementsPage/AccountMovementStats/AccountMovement`) definido en Task 4 y consumido en Task 6;
  `externalCuentaId`/`cuentaId` consistentes entre Tasks 1 y 3.
