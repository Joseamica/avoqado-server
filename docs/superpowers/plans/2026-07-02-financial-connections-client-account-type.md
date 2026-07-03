# Financial Connections — Tipo de cuenta Negocio/Personal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir conectar en Financial Connections una cuenta **Personal (cliente)** de Moneygiver además de la **Negocio (merchant)** actual, eligiendo el tipo en el wizard.

**Architecture:** Se agrega una dimensión `accountKind` (`MERCHANT` | `CLIENT`) a `FinancialConnection`. Ese valor ramifica 4 cosas en el client de provider: header `mgPlatform` (MERCHANT/PWA), endpoint de login (`/sign-in/merchant` vs `/sign-in`), listado de cuentas (`negocios[]` vs `get-wallet-clientAccounts`), y ruta de movimientos/saldo (idNegocio+query vs idCuenta directo). 2FA, dispositivo, refresh, cifrado del grant y toda la UI de detalle se reusan. Se persiste `externalClientId` (idMoneyGiver del cliente) para poder listar cuentas/saldo del cliente después.

**Tech Stack:** Node + Express + Prisma + TypeScript · axios · Jest + nock (backend). Vite + React + TanStack Query + i18next · Vitest (frontend).

## Global Constraints

- Repos: `avoqado-server` (backend) y `avoqado-web-dashboard` (frontend). Ambos en branch `develop`.
- **Git hygiene (crítico):** el working tree tiene WIP concurrente de otra sesión. SIEMPRE `git add` con paths explícitos del archivo tocado — nunca `git add -A`/`git add .`. Commit inmediato tras cada tarea.
- `mgPlatform` values exactos: `MERCHANT` (negocio) y `PWA` (cliente). Verificados en vivo contra `prod.moneygiver.xyz`.
- Login cliente: `POST /api/auth/sign-in` (genérico). Login merchant (existente): `POST /api/auth/sign-in/merchant`.
- Listado de cuentas cliente: `GET /api/clients/get-wallet-clientAccounts/v3r2.1?idMoneyGiver=<id>` → `{ cuentas: Cuenta[] }`. `Cuenta`: `idCuenta`(uuid), `nombre`, `cuentaClabe`, `saldo`(number), `activo`(bool), `idCuentaAlt`(int).
- Movimientos cliente: `GET /api/clients/movimientos/{idCuenta}` (idCuenta en la RUTA, sin idNegocio). Stats: `GET /api/clients/movimientos/Estadisticas/{idCuenta}` (igual que merchant).
- Dinero honesto: `null` → `—`, jamás `$0`. `toNum` devuelve null para basura.
- Regla de tests: N sitios cambiados → exactamente N tests nuevos; no agrupar cobertura ajena.
- Copy UI: "Cuenta de negocio" / "Cuenta personal" (i18n; paridad es/en/fr).
- Retrocompatibilidad: conexiones existentes son MERCHANT (default del schema). El endpoint de crear conexión trata `accountKind` ausente como `MERCHANT`.

## Interfaces compartidas (definidas aquí, usadas por varias tareas)

```ts
// types.ts
export type AccountKind = 'MERCHANT' | 'CLIENT'

export interface ConnectInput {
  email: string
  password: string
  deviceIdentifier: string
  accountKind: AccountKind        // NUEVO
}

export interface ConnectionContext {
  accessToken: string
  kind?: AccountKind              // NUEVO (default MERCHANT en headers)
  externalClientId?: string | null // NUEVO (idMoneyGiver del cliente; null en merchant)
}

// ConnectResult 'connected' gana externalClientId opcional:
// | { kind: 'connected'; grant: Grant; accounts: ProviderAccount[]; accessToken?: string; externalClientId?: string }
```

Enum Prisma: `FinancialConnectionAccountKind { MERCHANT CLIENT }`. El service mapea el enum Prisma ↔ la union string `AccountKind` (mismos literales).

---

### Task 1: Schema — `accountKind` + `externalClientId` en FinancialConnection

**Files:**
- Modify: `avoqado-server/prisma/schema.prisma` (model `FinancialConnection`, ~línea 10442)
- Create (generada): `avoqado-server/prisma/migrations/<timestamp>_financial_connection_account_kind/migration.sql`

**Interfaces:**
- Produces: enum `FinancialConnectionAccountKind`, campos `FinancialConnection.accountKind` (default MERCHANT) y `FinancialConnection.externalClientId` (String?).

- [ ] **Step 1: Agregar enum + campos al schema**

En `prisma/schema.prisma`, cerca de los otros enums de financial connections agregar:

```prisma
enum FinancialConnectionAccountKind {
  MERCHANT
  CLIENT
}
```

Y dentro de `model FinancialConnection { ... }`, después de `mode` agregar:

```prisma
  accountKind        FinancialConnectionAccountKind @default(MERCHANT)
  externalClientId   String? // idMoneyGiver del cliente (accountKind CLIENT). null en MERCHANT.
```

- [ ] **Step 2: Crear la migración (sin aplicar a prod)**

Run: `cd avoqado-server && npx prisma migrate dev --name financial_connection_account_kind`
Expected: crea `migration.sql` con `CREATE TYPE ... FinancialConnectionAccountKind`, `ALTER TABLE "FinancialConnection" ADD COLUMN "accountKind" ... DEFAULT 'MERCHANT'` y `ADD COLUMN "externalClientId"`. Genera el client.

- [ ] **Step 3: Verificar que compila y el client tipa**

Run: `cd avoqado-server && NODE_OPTIONS='--max-old-space-size=8192' npx tsc --noEmit`
Expected: 0 errores. El tipo `FinancialConnectionAccountKind` existe en `@prisma/client`.

- [ ] **Step 4: Commit**

```bash
cd avoqado-server
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(financial-connections): schema accountKind + externalClientId"
```

---

### Task 2: Env + threading de `mgPlatform`/`kind` por el client

**Files:**
- Modify: `avoqado-server/src/config/env.ts:90` (agregar var)
- Modify: `avoqado-server/src/services/financial-connections/types.ts` (AccountKind, ConnectInput, ConnectionContext, ConnectResult)
- Modify: `avoqado-server/src/services/financial-connections/externalBank.client.ts` (headers, platformForKind, signIn)
- Test: `avoqado-server/tests/unit/services/financial-connections/externalBank.client.test.ts`

**Interfaces:**
- Consumes: `AccountKind` (Task-local, definido aquí en types.ts).
- Produces: `platformForKind(kind)`, `headers(token?, kind?)`, `signIn(email,password,deviceIdentifier,kind)` branch por endpoint+platform.

- [ ] **Step 1: Env var para el platform del cliente**

En `src/config/env.ts`, junto a `EXTERNAL_BANK_MG_PLATFORM` (línea 90) agregar:

```ts
  EXTERNAL_BANK_MG_PLATFORM_CLIENT: z.string().optional().default('PWA'),
```

- [ ] **Step 2: Tipos en types.ts**

Agregar `export type AccountKind = 'MERCHANT' | 'CLIENT'`. Agregar `accountKind: AccountKind` a `ConnectInput`. Cambiar `ConnectionContext` a:

```ts
export interface ConnectionContext {
  accessToken: string
  kind?: AccountKind
  externalClientId?: string | null
}
```

En el miembro `'connected'` de `ConnectResult` agregar `externalClientId?: string`.

- [ ] **Step 3: Test que falla — login cliente usa /sign-in + mgPlatform PWA**

En `externalBank.client.test.ts`, agregar (nock ya está configurado en el archivo, `BASE` y `DEVICE` existen):

```ts
it('connect(CLIENT): usa /sign-in genérico + mgPlatform PWA; 2FA challenge', async () => {
  let seenPlatform: string | undefined
  nock(BASE)
    .post('/api/auth/sign-in')
    .reply(function () {
      seenPlatform = this.req.headers['mgplatform']
      return [200, { signedIn: true, token: 'tmp-2fa', refreshToken: null, needTwoFactorAuth: true, needDeviceValidation: false }]
    })
  const client = await loadClient()
  const r = await client.connect({ email: 'a@b.co', password: 'p', deviceIdentifier: DEVICE, accountKind: 'CLIENT' })
  expect(seenPlatform).toBe('PWA')
  expect(r.kind).toBe('need_two_factor_auth')
})
```

Nota: `setEnv()` en el archivo debe además setear `process.env.EXTERNAL_BANK_MG_PLATFORM_CLIENT = 'PWA'`. Agregarlo en `setEnv()`.

- [ ] **Step 4: Run — falla**

Run: `cd avoqado-server && npx jest externalBank.client -t 'connect\(CLIENT\)'`
Expected: FAIL (hoy `signIn` siempre pega a `/sign-in/merchant` con MERCHANT).

- [ ] **Step 5: Implementar platformForKind + headers + signIn branch**

En `externalBank.client.ts`, reemplazar `headers` y `signIn`:

```ts
function platformForKind(kind: AccountKind = 'MERCHANT'): string {
  return kind === 'CLIENT' ? env.EXTERNAL_BANK_MG_PLATFORM_CLIENT : env.EXTERNAL_BANK_MG_PLATFORM
}
const headers = (token?: string, kind: AccountKind = 'MERCHANT') => ({
  'Content-Type': 'application/json',
  mgPlatform: platformForKind(kind),
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
})

async function signIn(email: string, password: string, deviceIdentifier: string, kind: AccountKind): Promise<unknown> {
  const path = kind === 'CLIENT' ? '/api/auth/sign-in' : '/api/auth/sign-in/merchant'
  try {
    const { data } = await axios.post(
      `${base()}${path}`,
      { email, user: email, password, dispositivo: dispositivo(deviceIdentifier) },
      { headers: { ...headers(undefined, kind), twoFactorEnabled: 'true' }, timeout: 20_000 },
    )
    return data
  } catch (e) {
    if (axios.isAxiosError(e))
      throw new BadRequestError(pick<string>(e.response?.data, 'message') || `sign-in falló (status ${e.response?.status})`)
    throw e
  }
}
```

Importar `AccountKind` desde `./types`. En `connect`, pasar el kind: `const data = await signIn(email, password, deviceIdentifier, accountKind)` (destructurar `accountKind` del `ConnectInput`). En `validateDevice`, el re-login interno también recibe el kind — ver Task 3 (por ahora, para que compile, agregar `accountKind` al destructuring de `connect` y default `'MERCHANT'` en validateDevice/validateTwoFactorCode hasta Task 3).

- [ ] **Step 6: Run — pasa**

Run: `cd avoqado-server && npx jest externalBank.client`
Expected: PASS (incluyendo los tests merchant existentes — el default MERCHANT los deja intactos).

- [ ] **Step 7: Commit**

```bash
cd avoqado-server
git add src/config/env.ts src/services/financial-connections/types.ts src/services/financial-connections/externalBank.client.ts tests/unit/services/financial-connections/externalBank.client.test.ts
git commit -m "feat(financial-connections): threadea mgPlatform/kind y branch de login cliente (PWA)"
```

---

### Task 3: Listado de cuentas del cliente (`get-wallet-clientAccounts`)

**Files:**
- Modify: `avoqado-server/src/services/financial-connections/externalBank.client.ts`
- Test: `avoqado-server/tests/unit/services/financial-connections/externalBank.client.test.ts`

**Interfaces:**
- Consumes: `AccountKind`, `signIn(...,kind)`, `headers(token,kind)` (Task 2).
- Produces: `normalizeClientAccounts(payload)`, `getClientAccounts(accessToken,kind,idMoneyGiver)`, `idMoneyGiverOf(data)`. `connect`/`validateTwoFactorCode`/`validateDevice` devuelven cuentas del cliente + `externalClientId` cuando `accountKind==='CLIENT'`.

- [ ] **Step 1: Test — normalizeClientAccounts mapea Cuenta → ProviderAccount**

```ts
it('connect(CLIENT) sin 2FA: normaliza get-wallet-clientAccounts a ProviderAccount[]', async () => {
  nock(BASE).post('/api/auth/sign-in').reply(200, {
    signedIn: true, token: 'acc-c', refreshToken: 'ref-c',
    expiresIn: new Date(Date.now() + 3600e3).toISOString(),
    userData: { idMoneyGiver: 'mg-1' },
  })
  nock(BASE).get('/api/clients/get-wallet-clientAccounts/v3r2.1').query({ idMoneyGiver: 'mg-1' }).reply(200, {
    cuentas: [
      { idCuenta: 'cta-1', nombre: 'Mi cuenta', cuentaClabe: '646...', saldo: 1234.5, activo: true, idCuentaAlt: 77 },
      { idCuenta: 'cta-2', nombre: 'Otra', cuentaClabe: '646...', saldo: 0, activo: false, idCuentaAlt: 78 },
    ],
  })
  const client = await loadClient()
  const r = await client.connect({ email: 'a@b.co', password: 'p', deviceIdentifier: DEVICE, accountKind: 'CLIENT' })
  expect(r.kind).toBe('connected')
  if (r.kind === 'connected') {
    expect(r.externalClientId).toBe('mg-1')
    expect(r.accounts.map(a => a.externalId)).toEqual(['cta-1', 'cta-2'])
    expect(r.accounts[0]).toMatchObject({ cuentaId: 'cta-1', label: 'Mi cuenta', balance: 1234.5, active: true, altId: 77 })
  }
})
```

- [ ] **Step 2: Run — falla**

Run: `cd avoqado-server && npx jest externalBank.client -t 'get-wallet-clientAccounts'`
Expected: FAIL.

- [ ] **Step 3: Implementar normalizeClientAccounts + getClientAccounts + idMoneyGiverOf**

En `externalBank.client.ts` (junto a `normalizeAccounts`):

```ts
function idMoneyGiverOf(data: unknown): string | null {
  const ud = pick(data, 'userData')
  return pick<string>(ud, 'idMoneyGiver') ?? pick<string>(data, 'idMoneyGiver') ?? null
}
function normalizeClientAccounts(payload: unknown): ProviderAccount[] {
  const cuentas = pick<unknown[]>(payload, 'cuentas')
  if (!Array.isArray(cuentas)) return []
  return cuentas
    .map((c): ProviderAccount | null => {
      const idCuenta = pick<string>(c, 'idCuenta')
      if (!idCuenta) return null
      const saldo = pick(c, 'saldo')
      const altIdRaw = pick(c, 'idCuentaAlt')
      return {
        externalId: idCuenta,
        cuentaId: idCuenta,
        altId: typeof altIdRaw === 'number' ? altIdRaw : null,
        label: pick<string>(c, 'nombre') ?? null,
        clabe: pick<string>(c, 'cuentaClabe') ?? null,
        active: typeof pick(c, 'activo') === 'boolean' ? (pick<boolean>(c, 'activo') as boolean) : null,
        balance: typeof saldo === 'number' ? (saldo as number) : null,
      }
    })
    .filter((a): a is ProviderAccount => a !== null)
}
async function getClientAccounts(accessToken: string, idMoneyGiver: string): Promise<ProviderAccount[]> {
  const { data } = await axios.get(`${base()}/api/clients/get-wallet-clientAccounts/v3r2.1`, {
    headers: headers(accessToken, 'CLIENT'),
    params: { idMoneyGiver },
    timeout: 20_000,
  })
  return normalizeClientAccounts(data)
}
```

- [ ] **Step 4: Branch en connect/validateTwoFactorCode/validateDevice**

Extraer un helper para el "post-auth" que ramifica por kind. Reemplazar el bloque final `const accounts = normalizeAccounts(await fetchMe(at))` en los 3 métodos por una llamada a:

```ts
async function accountsForKind(accessToken: string, kind: AccountKind, data: unknown): Promise<{ accounts: ProviderAccount[]; externalClientId?: string }> {
  if (kind === 'CLIENT') {
    const idMg = idMoneyGiverOf(data)
    if (!idMg) throw new BadRequestError('El proveedor no devolvió idMoneyGiver del cliente.')
    return { accounts: await getClientAccounts(accessToken, idMg), externalClientId: idMg }
  }
  return { accounts: normalizeAccounts(await fetchMe(accessToken)) }
}
```

En `connect`: al final,
```ts
const at = accessTokenOf(data)
const grant = toGrant(data)
const { accounts, externalClientId } = await accountsForKind(at, accountKind, data)
return { kind: 'connected', grant, accounts, accessToken: at, externalClientId }
```
`accountKind` viene del `ConnectInput` destructurado. Para 2FA/device, propagar `accountKind` al challenge/re-login: guardar el kind en el challenge cifrado (Task 5 lo persiste) y pasarlo. Para `validateTwoFactorCode` y `validateDevice`, agregar `accountKind` a su input (ver types del interface `FinancialProviderClient` — agregar `accountKind: AccountKind` a los inputs de `validateDevice`/`validateTwoFactorCode`) y usar `accountsForKind(at, accountKind, data|v)`.

Actualizar el interface `FinancialProviderClient` en `types.ts`: `validateDevice` y `validateTwoFactorCode` reciben `accountKind: AccountKind` en su objeto input. `signIn` interno también recibe kind (ya en Task 2).

- [ ] **Step 5: Run — pasa**

Run: `cd avoqado-server && npx jest externalBank.client`
Expected: PASS (todos: merchant existentes + client nuevos).

- [ ] **Step 6: Commit**

```bash
cd avoqado-server
git add src/services/financial-connections/externalBank.client.ts src/services/financial-connections/types.ts tests/unit/services/financial-connections/externalBank.client.test.ts
git commit -m "feat(financial-connections): listado de cuentas del cliente (get-wallet-clientAccounts)"
```

---

### Task 4: Movimientos/saldo del cliente (ruta idCuenta directa)

**Files:**
- Modify: `avoqado-server/src/services/financial-connections/externalBank.client.ts` (`listMovements`, `getBalance`, `listAccounts`)
- Test: `avoqado-server/tests/unit/services/financial-connections/externalBank.client.test.ts`

**Interfaces:**
- Consumes: `ConnectionContext.kind`, `ConnectionContext.externalClientId` (Task 2), `getClientAccounts` (Task 3).
- Produces: `listMovements`/`getBalance`/`listAccounts` ramifican por `ctx.kind`.

- [ ] **Step 1: Test — listMovements(CLIENT) pega a /movimientos/{idCuenta} (idCuenta en ruta)**

```ts
it('listMovements(CLIENT): idCuenta en la RUTA (no idNegocio)', async () => {
  nock(BASE)
    .get('/api/clients/movimientos/cta-1')
    .query(q => q['Pagination.Page'] === '0' && q.SortByFecha === 'desc' && q.idCuenta === undefined)
    .reply(200, { data: [{ idOperacion: 'op1', monto: '10.5', fechaCreacion: '2026-06-01' }], total: 1 })
  const client = await loadClient()
  const page = await client.listMovements({ accessToken: 't', kind: 'CLIENT' }, 'IGNORED', 'cta-1', { page: 0, size: 10 })
  expect(page.total).toBe(1)
  expect(page.movements[0]).toMatchObject({ id: 'op1', amount: 10.5 })
})
```

- [ ] **Step 2: Run — falla**

Run: `cd avoqado-server && npx jest externalBank.client -t 'listMovements\(CLIENT\)'`
Expected: FAIL (hoy siempre usa idNegocio en la ruta + idCuenta query).

- [ ] **Step 3: Implementar branch en listMovements**

En `listMovements`, al inicio construir params y elegir URL por `ctx.kind`:

```ts
async listMovements(ctx, idNegocio, cuentaId, query) {
  const isClient = ctx.kind === 'CLIENT'
  const params: Record<string, unknown> = { 'Pagination.Page': query.page, 'Pagination.Size': query.size, SortByFecha: 'desc' }
  if (!isClient) params.idCuenta = cuentaId // merchant: idNegocio en ruta + idCuenta query (evita pool global)
  if (query.from) params.FechaInicio = query.from
  if (query.to) params.FechaFinal = query.to
  const path = isClient ? `/api/clients/movimientos/${cuentaId}` : `/api/clients/movimientos/${idNegocio}`
  const { data } = await axios.get(`${base()}${path}`, { headers: headers(ctx.accessToken, ctx.kind), params, timeout: 20_000 })
  const raw = pick<unknown[]>(data, 'data')
  return { movements: Array.isArray(raw) ? raw.map(normalizeMovement) : [], total: toNum(pick(data, 'total')) ?? 0 }
}
```

**⚠ Verificación en vivo requerida (Task 9):** confirmar que `/api/clients/movimientos/{idCuenta}` para cliente devuelve SOLO esa cuenta (no pool global como la cuenta de dispersión del merchant). Si devuelve pool, replicar el patrón de filtro.

- [ ] **Step 4: getBalance + listAccounts branch por kind**

`getMovementStats` NO cambia (ya usa `Estadisticas/${cuentaId}`, común a ambos; solo pásale `headers(ctx.accessToken, ctx.kind)`).

`getBalance` y `listAccounts`:

```ts
async listAccounts(ctx) {
  if (ctx.kind === 'CLIENT') {
    if (!ctx.externalClientId) throw new BadRequestError('Falta externalClientId para listar cuentas del cliente.')
    return getClientAccounts(ctx.accessToken, ctx.externalClientId)
  }
  return normalizeAccounts(await fetchMe(ctx.accessToken))
}
async getBalance(ctx, externalId) {
  const acc = (await this.listAccounts(ctx)).find(a => a.externalId === externalId)
  if (!acc) throw new NotFoundError(`No se encontró la cuenta ${externalId}.`)
  return { amount: acc.balance, currency: 'MXN', active: acc.active, providerAccountLabel: acc.label }
}
```

Actualizar todas las llamadas `headers(ctx.accessToken)` dentro de métodos con `ctx` para pasar `ctx.kind`: `headers(ctx.accessToken, ctx.kind)` en `getMovementStats`, `resolveMgAlt`, `internalTransfer`, `revoke`. (En `refresh`, usar `headers(undefined, ctx.kind)` no aplica porque refresh no tiene ctx todavía — ver Task 5.)

- [ ] **Step 5: Run — pasa**

Run: `cd avoqado-server && npx jest externalBank.client`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd avoqado-server
git add src/services/financial-connections/externalBank.client.ts tests/unit/services/financial-connections/externalBank.client.test.ts
git commit -m "feat(financial-connections): movimientos/saldo del cliente por idCuenta directo"
```

---

### Task 5: Service + controller — persistir y threadear `accountKind`

**Files:**
- Modify: `avoqado-server/src/services/financial-connections/financialConnection.service.ts`
- Modify: `avoqado-server/src/controllers/dashboard/financialConnection.controller.ts:23-26`
- Test: `avoqado-server/tests/unit/services/financial-connections/financialConnection.service.test.ts`

**Interfaces:**
- Consumes: client con branch por kind (Tasks 2-4), schema `accountKind`/`externalClientId` (Task 1).
- Produces: `startConnection` recibe `accountKind`; ctx construido con `{ accessToken, kind, externalClientId }` en todos los call sites; `refresh` recibe kind.

- [ ] **Step 1: startConnection persiste accountKind y lo pasa al client**

`startConnection` input gana `accountKind?: AccountKind` (default 'MERCHANT'). Al crear la fila `financialConnection.create`, setear `accountKind: input.accountKind ?? 'MERCHANT'`. Pasar `accountKind` a `client.connect({ ..., accountKind })`. En el challenge cifrado (2FA y device) incluir `accountKind` para propagarlo a los siguientes pasos: `encryptGrant({ ..., accountKind })`. En `validateDevice`/`validateTwoFactorAuth`, leer `accountKind` del challenge descifrado (o de `conn.accountKind`) y pasarlo al client.

- [ ] **Step 2: finishConnected persiste externalClientId**

`finishConnected(connectionId, deviceIdentifier, grant, accounts, accessToken?, externalClientId?)`. En el `financialConnection.update` de connectedAt, setear `externalClientId: externalClientId ?? undefined`. Los 3 call sites (`startConnection`, `validateDevice`, `validateTwoFactorAuth`) pasan `r.externalClientId`.

- [ ] **Step 3: ctx con kind+externalClientId en todos los call sites**

Cambiar cada construcción `{ accessToken }` que se pasa a métodos del client por:

```ts
function ctxFor(conn: { accountKind: FinancialConnectionAccountKind; externalClientId: string | null }, accessToken: string): ConnectionContext {
  return { accessToken, kind: conn.accountKind, externalClientId: conn.externalClientId }
}
```

Aplicar en: `resolveCuentaId` (retorna también el kind/clientId via conn), `getMovementsForAccount`, `getMovementStatsForAccount`, `getBalanceForConnectionAccount`, `resolveTransferDestination`, `sendInternalTransfer`, `disconnect`. Asegurar que las queries Prisma que cargan `conn`/`fa.connection` incluyan `accountKind` y `externalClientId` en el `select`/`include`.

- [ ] **Step 4: refresh recibe kind**

`accessTokenFor` llama `client.refresh(grant, deviceIdentifier)`. Cambiar la firma del interface `refresh(grant, deviceIdentifier, kind?: AccountKind)` y en el client usar `headers(undefined, kind)` en la llamada a `/api/auth/refresh-token`. `accessTokenFor` pasa `conn.accountKind`.

- [ ] **Step 5: Controller acepta accountKind**

En `financialConnection.controller.ts:23`:

```ts
const { providerId, email, password, accountKind } = req.body ?? {}
if (!providerId || !email || !password) throw new BadRequestError('providerId, email y password son requeridos.')
const kind = accountKind === 'CLIENT' ? 'CLIENT' : 'MERCHANT'
const r = await svc.startConnection({ venueId: req.params.venueId, providerId, email, password, staffId, accountKind: kind })
```

- [ ] **Step 6: Test del service — startConnection guarda accountKind y externalClientId**

En `financialConnection.service.test.ts`, mockear el registry/client para que `connect` devuelva `{ kind:'connected', grant, accounts:[], accessToken:'t', externalClientId:'mg-1' }` con input `accountKind:'CLIENT'`; assert que `prisma.financialConnection.create` recibió `accountKind:'CLIENT'` y que finishConnected hizo update con `externalClientId:'mg-1'`. (Seguir el patrón de mocks existente en el archivo.)

- [ ] **Step 7: Run tests + typecheck**

Run: `cd avoqado-server && npx jest financial-connections && NODE_OPTIONS='--max-old-space-size=8192' npx tsc --noEmit`
Expected: PASS + 0 errores.

- [ ] **Step 8: Commit**

```bash
cd avoqado-server
git add src/services/financial-connections/financialConnection.service.ts src/controllers/dashboard/financialConnection.controller.ts tests/unit/services/financial-connections/financialConnection.service.test.ts
git commit -m "feat(financial-connections): service+controller persisten y threadean accountKind"
```

---

### Task 6: Frontend — service `createConnection` acepta `accountKind`

**Files:**
- Modify: `avoqado-web-dashboard/src/services/financialConnection.service.ts:130-136`
- Test: `avoqado-web-dashboard/src/services/__tests__/financialConnection.service.test.ts`

**Interfaces:**
- Produces: `createConnection(venueId, { providerId, email, password, accountKind })`.

- [ ] **Step 1: Test — createConnection manda accountKind en el body**

```ts
it('createConnection envía accountKind en el body', async () => {
  mocked.post.mockResolvedValue({ data: { data: { connectionId: 'c1', status: 'PENDING_TWO_FACTOR_AUTH' } } })
  await financialConnectionAPI.createConnection('v1', { providerId: 'p1', email: 'a@b.co', password: 'x', accountKind: 'CLIENT' })
  expect(mocked.post).toHaveBeenCalledWith('/api/v1/dashboard/venues/v1/financial-connections', { providerId: 'p1', email: 'a@b.co', password: 'x', accountKind: 'CLIENT' })
})
```

- [ ] **Step 2: Run — falla**

Run: `cd avoqado-web-dashboard && npx vitest run financialConnection.service`
Expected: FAIL.

- [ ] **Step 3: Implementar**

```ts
async createConnection(
  venueId: string,
  body: { providerId: string; email: string; password: string; accountKind: 'MERCHANT' | 'CLIENT' },
): Promise<ConnectionStepResult> {
  const { data } = await api.post(`${BASE}/venues/${venueId}/financial-connections`, body)
  return data.data
},
```

- [ ] **Step 4: Run — pasa**

Run: `cd avoqado-web-dashboard && npx vitest run financialConnection.service`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd avoqado-web-dashboard
git add src/services/financialConnection.service.ts src/services/__tests__/financialConnection.service.test.ts
git commit -m "feat(financial-connections): createConnection acepta accountKind"
```

---

### Task 7: Frontend — toggle Negocio/Personal en el wizard

**Files:**
- Modify: `avoqado-web-dashboard/src/pages/Venue/components/BankConnectWizard.tsx` (estado + paso `credentials` ~línea 159, mutación `connect` ~línea 74)

**Interfaces:**
- Consumes: `createConnection(..., { accountKind })` (Task 6).

- [ ] **Step 1: Estado del tipo**

Junto a los otros `useState` (~línea 50): `const [accountKind, setAccountKind] = useState<'MERCHANT' | 'CLIENT'>('MERCHANT')`.

- [ ] **Step 2: Pasar accountKind a la mutación**

En la mutación `connect` (~línea 74): `mutationFn: () => financialConnectionAPI.createConnection(venueId, { providerId: provider!.id, email, password, accountKind })`.

- [ ] **Step 3: Segmented control arriba de email/password**

Dentro del `<form>` del paso `credentials`, antes del campo email, insertar un control de 2 opciones (usar el patrón de botones que ya usa el wizard; clases Tailwind del proyecto). Cada botón setea `setAccountKind`. Ejemplo mínimo con estilos existentes:

```tsx
<div className="grid grid-cols-2 gap-2">
  {(['MERCHANT', 'CLIENT'] as const).map(k => (
    <button
      key={k}
      type="button"
      onClick={() => setAccountKind(k)}
      className={cn(
        'rounded-lg border px-3 py-2 text-sm font-medium transition-colors',
        accountKind === k ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:bg-muted',
      )}
    >
      {t(`wizard.step2.kind.${k === 'MERCHANT' ? 'business' : 'personal'}`)}
    </button>
  ))}
</div>
```

Importar `cn` de `@/lib/utils` si no está. La descripción del paso (`wizard.step2.description`) puede quedar; opcionalmente mostrar ayuda por tipo (Task 8 provee la key `wizard.step2.kind.hint`).

- [ ] **Step 4: Verificar que compila y renderiza**

Run: `cd avoqado-web-dashboard && npx tsc --noEmit`
Expected: 0 errores. (Verificación visual en Task 9 con el preview.)

- [ ] **Step 5: Commit**

```bash
cd avoqado-web-dashboard
git add src/pages/Venue/components/BankConnectWizard.tsx
git commit -m "feat(financial-connections): toggle Negocio/Personal en el wizard"
```

---

### Task 8: Frontend — i18n del toggle (es/en/fr)

**Files:**
- Modify: `avoqado-web-dashboard/src/locales/es/financialConnections.json`
- Modify: `avoqado-web-dashboard/src/locales/en/financialConnections.json`
- Modify: `avoqado-web-dashboard/src/locales/fr/financialConnections.json`

**Interfaces:**
- Consumes: keys usadas en Task 7 (`wizard.step2.kind.business`, `.personal`, `.hint`).

- [ ] **Step 1: Agregar keys bajo `wizard.step2`**

Dentro del objeto `wizard.step2` de cada locale, agregar un objeto `kind`:

es:
```json
"kind": { "business": "Cuenta de negocio", "personal": "Cuenta personal", "hint": "Personal: la cuenta con la que entras a la app de tu banco. Negocio: tu panel de comercio." }
```
en:
```json
"kind": { "business": "Business account", "personal": "Personal account", "hint": "Personal: the account you use to sign in to your bank app. Business: your merchant panel." }
```
fr:
```json
"kind": { "business": "Compte entreprise", "personal": "Compte personnel", "hint": "Personnel : le compte avec lequel vous vous connectez à l'app de votre banque. Entreprise : votre panneau marchand." }
```

- [ ] **Step 2: Verificar paridad de keys**

Run: `cd avoqado-web-dashboard && node -e "const es=require('./src/locales/es/financialConnections.json'),en=require('./src/locales/en/financialConnections.json'),fr=require('./src/locales/fr/financialConnections.json');const c=o=>JSON.stringify(Object.keys(o).sort());console.log('step2.kind es==en==fr:', c(es.wizard.step2.kind)===c(en.wizard.step2.kind)&&c(es.wizard.step2.kind)===c(fr.wizard.step2.kind))"`
Expected: `step2.kind es==en==fr: true`

- [ ] **Step 3: Commit**

```bash
cd avoqado-web-dashboard
git add src/locales/es/financialConnections.json src/locales/en/financialConnections.json src/locales/fr/financialConnections.json
git commit -m "i18n(financial-connections): copy del toggle Negocio/Personal"
```

---

### Task 9: Verificación integral + smoke en vivo

**Files:** ninguno (verificación). Correcciones, si surgen, en los archivos de las tareas previas.

- [ ] **Step 1: Typecheck + tests de ambos repos**

Run: `cd avoqado-server && NODE_OPTIONS='--max-old-space-size=8192' npx tsc --noEmit && npx jest financial-connections`
Run: `cd avoqado-web-dashboard && npx tsc --noEmit && npx vitest run financialConnection`
Expected: 0 errores, tests PASS.

- [ ] **Step 2: Smoke en vivo con `devgerruiz` (cliente)**

Con el backend dev corriendo, en el wizard elegir **Cuenta personal**, conectar con las credenciales de `devgerruiz` (Jose las teclea; el implementer NO usa credenciales ajenas), completar 2FA, y verificar en la UI: aparece la lista de cuentas del cliente, el saldo, y el detalle de movimientos.

- [ ] **Step 3: Resolver los 3 unknowns del spec (verificación en vivo)**

Confirmar contra la respuesta viva: (a) `/api/clients/movimientos/{idCuenta}` del cliente devuelve solo esa cuenta (no pool global) — si no, ajustar `listMovements` branch; (b) campo `idMoneyGiver` correcto en el login del cliente; (c) nombres de campo de `Cuenta`. Registrar hallazgos; si algo difiere, corregir el código de la tarea correspondiente + su test.

- [ ] **Step 4: Verificar que el merchant sigue intacto**

Conectar una **Cuenta de negocio** (flujo actual) y verificar saldo/movimientos — no debe haber regresión.

- [ ] **Step 5: Review final de rama**

Dispatch al code-reviewer (superpowers:requesting-code-review) sobre el diff completo de la rama. Arreglar Critical/Important.

---

## Self-Review (checklist del autor del plan)

- **Cobertura del spec:** ✅ 4 branch points → Tasks 2 (mgPlatform+login), 3 (listado cuentas), 4 (movimientos/saldo). accountKind persistido → Task 1+5. FE toggle → Tasks 6-8. Verificación en vivo (3 unknowns) → Task 9.
- **Placeholders:** los "⚠ verificación en vivo" son unknowns nombrados explícitamente con qué confirmar y qué hacer si difiere — no son TODO abiertos.
- **Consistencia de tipos:** `AccountKind` ('MERCHANT'|'CLIENT') consistente en types/client/service; `ConnectionContext` gana `kind`+`externalClientId` (Task 2) usados en Tasks 4-5; `ConnectResult.externalClientId` (Task 2) producido en Task 3, consumido en Task 5; `platformForKind`/`headers(token,kind)` (Task 2) usados en 3-4.
- **YAGNI:** no auto-detección, no transferencias-desde-cliente, no modelo colaborador, no rollout prod (pendiente separado).
