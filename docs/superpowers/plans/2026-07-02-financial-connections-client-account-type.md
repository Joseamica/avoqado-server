# Financial Connections — Tipo de cuenta Negocio/Personal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir conectar en Financial Connections una cuenta **Personal (cliente)** de Moneygiver además de la **Negocio (merchant)**
actual, eligiendo el tipo en el wizard.

**Architecture:** Se agrega una dimensión `accountKind` (`MERCHANT` | `CLIENT`) a `FinancialConnection`. Ese valor ramifica 4 cosas en el
client de provider: header `mgPlatform` (MERCHANT/PWA), endpoint de login (`/sign-in/merchant` vs `/sign-in`), listado de cuentas
(`negocios[]` vs `get-wallet-clientAccounts`), y ruta de movimientos/saldo (idNegocio+query vs idCuenta directo). 2FA, dispositivo, refresh,
cifrado del grant y toda la UI de detalle se reusan. Se persiste `externalClientId` (idMoneyGiver del cliente) para poder listar
cuentas/saldo del cliente después.

**Tech Stack:** Node + Express + Prisma + TypeScript · axios · Jest + nock (backend). Vite + React + TanStack Query + i18next · Vitest
(frontend).

```
wizard (toggle) ──► POST /financial-connections {accountKind}
                        │
                startConnection ── persiste accountKind en la fila (Task 5)
                        │
                client.connect({...accountKind})
                        │
          ┌─── MERCHANT ─┴─── CLIENT ───┐
          │                             │
   /sign-in/merchant             /sign-in  (mgPlatform: PWA)
          │                             │
     ¿2FA/device? ── challenge cifrado {accessToken, externalClientId?} + PENDING_*
          │                             │
   fetchMe→negocios[]      idMoneyGiver→get-wallet-clientAccounts→cuentas[]
          │                             │        (0 cuentas → BadRequest honesto)
          └────── finishConnected (+externalClientId) ──────┘
                        │
        lecturas: ctxFor(conn) = {accessToken, kind, externalClientId}
        transfers: SOLO MERCHANT (guard backend + UI oculta botón)
```

## Global Constraints

- Repos: `avoqado-server` (backend) y `avoqado-web-dashboard` (frontend). Ambos en branch `develop`.
- **Git hygiene (crítico):** el working tree tiene WIP concurrente de otra sesión. SIEMPRE `git add` con paths explícitos del archivo tocado
  — nunca `git add -A`/`git add .`. Commit inmediato tras cada tarea.
- `mgPlatform` values exactos: `MERCHANT` (negocio) y `PWA` (cliente). Verificados en vivo contra `prod.moneygiver.xyz`.
- Login cliente: `POST /api/auth/sign-in` (genérico). Login merchant (existente): `POST /api/auth/sign-in/merchant`.
- Listado de cuentas cliente: `GET /api/clients/get-wallet-clientAccounts/v3r2.1?idMoneyGiver=<id>` → `{ cuentas: Cuenta[] }`. `Cuenta`:
  `idCuenta`(uuid), `nombre`, `cuentaClabe`, `saldo`(number), `activo`(bool), `idCuentaAlt`(int).
- Movimientos cliente: `GET /api/clients/movimientos/{idCuenta}` (idCuenta en la RUTA, sin idNegocio). Stats:
  `GET /api/clients/movimientos/Estadisticas/{idCuenta}` (igual que merchant).
- Dinero honesto: `null` → `—`, jamás `$0`. `toNum` devuelve null para basura.
- Regla de tests: N sitios cambiados → exactamente N tests nuevos; no agrupar cobertura ajena.
- Copy UI: "Cuenta de negocio" / "Cuenta personal" (i18n; paridad es/en/fr).
- Retrocompatibilidad: conexiones existentes son MERCHANT (default del schema). El endpoint de crear conexión trata `accountKind` ausente
  como `MERCHANT`; cualquier otro valor distinto de `MERCHANT`/`CLIENT` → 400 (nunca coerción silenciosa).
- **Tier (decidido en eng review D19):** hereda el gating actual de Financial Connections (`financialConnections:manage`, OWNER). Sin
  FeatureGate nuevo.
- **Transferencias: SOLO conexiones MERCHANT.** El backend rechaza transfer/resolve-destination sobre conexiones CLIENT y la UI oculta el
  botón (Tasks 5 y 7). El "fuera de alcance" del spec se hace cumplir con código, no con esperanza.
- **Comentarios load-bearing:** al editar `listMovements`/`types.ts` se CONSERVAN y actualizan los comentarios existentes (pool global
  ~5.1M, SortByFecha, scoping por ruta). Los snippets de este plan ya los incluyen — no borrarlos al copiar.
- **🔴 ORDEN DE DEPLOY (del review final 2026-07-03):** server primero — deploy de Task 1 (migración aditiva, segura en cualquier momento) +
  Tasks 2-5 a develop/prod; SOLO DESPUÉS pushear los cambios del dashboard. Pushear el dashboard a `develop` antes auto-deploya demo+staging
  donde la opción "Cuenta personal" fallaría con un error opaco del proveedor (el backend viejo ignora `accountKind` y intenta login
  merchant). Si el dashboard tuviera que mergear primero: deshabilitar el botón CLIENT con badge "Muy pronto" y quitarlo cuando Tasks 2-5
  estén desplegadas.
- **Typecheck del dashboard (lección del review final):** `npx tsc --noEmit` de raíz NO chequea nada (tsconfig raíz con `files: []` +
  project references). Usar `npx tsc -p tsconfig.app.json --noEmit` (o `tsc -b`). Los pasos de verificación FE de este plan deben leerse
  así.

## Interfaces compartidas (definidas aquí, usadas por varias tareas)

```ts
// types.ts
export type AccountKind = 'MERCHANT' | 'CLIENT'

export interface ConnectInput {
  email: string
  password: string
  deviceIdentifier: string
  accountKind?: AccountKind // NUEVO — OPCIONAL (default 'MERCHANT'): boundary retrocompatible
  // y las tareas compilan/commitean solas (C3, commit-safe)
}

export interface ConnectionContext {
  accessToken: string
  kind: AccountKind // NUEVO — REQUERIDO: un call site interno sin kind NO compila.
  // Así el compilador impide fugas silenciosas a MERCHANT (C2/C3).
  externalClientId?: string | null // NUEVO (idMoneyGiver del cliente; null en merchant)
}

// ConnectResult: el miembro 'connected' gana externalClientId opcional, y los CHALLENGES ganan
// externalClientId como FALLBACK (el sign-in inicial del cliente SÍ trae idMoneyGiver; la
// respuesta del 2FA quizá no — decisión 1A):
// | { kind: 'connected'; grant: Grant; accounts: ProviderAccount[]; accessToken?: string; externalClientId?: string }
// | { kind: 'need_two_factor_auth'; challenge: { accessToken: string; externalClientId?: string | null } }
// | { kind: 'need_device_validation'; challenge: { accessToken: string; processId: string; externalClientId?: string | null } }
```

Enum Prisma: `FinancialConnectionAccountKind { MERCHANT CLIENT }`. El service mapea el enum Prisma ↔ la union string `AccountKind` (mismos
literales).

---

### Task 1: Schema — `accountKind` + `externalClientId` en FinancialConnection

**Files:**

- Modify: `avoqado-server/prisma/schema.prisma` (model `FinancialConnection`, ~línea 10442)
- Create (generada): `avoqado-server/prisma/migrations/<timestamp>_financial_connection_account_kind/migration.sql`

**Interfaces:**

- Produces: enum `FinancialConnectionAccountKind`, campos `FinancialConnection.accountKind` (default MERCHANT) y
  `FinancialConnection.externalClientId` (String?).

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

Run: `cd avoqado-server && npx prisma migrate dev --name financial_connection_account_kind` Expected: crea `migration.sql` con
`CREATE TYPE ... FinancialConnectionAccountKind`, `ALTER TABLE "FinancialConnection" ADD COLUMN "accountKind" ... DEFAULT 'MERCHANT'` y
`ADD COLUMN "externalClientId"`. Genera el client.

- [ ] **Step 3: Verificar que compila y el client tipa**

Run: `cd avoqado-server && NODE_OPTIONS='--max-old-space-size=8192' npx tsc --noEmit` Expected: 0 errores. El tipo
`FinancialConnectionAccountKind` existe en `@prisma/client`.

- [ ] **Step 4: Commit**

```bash
cd avoqado-server
# Path EXPLÍCITO de la migración creada — jamás el directorio completo (el tree tiene WIP ajeno).
git add prisma/schema.prisma "prisma/migrations/$(ls -t prisma/migrations | head -1)"
git commit -m "feat(financial-connections): schema accountKind + externalClientId"
```

---

### Task 1.5: Probe en vivo — resolver los unknowns ANTES de implementar (decisión C6)

**Files:**

- Create (temporal): `avoqado-server/scripts/temp-probe-client-account.ts` — **DELETE antes de commit** (regla de temp files).

Requiere a Jose presente (~15 min): él teclea las credenciales de `devgerruiz` y el TOTP; el implementer solo lee las respuestas. Sin esto,
los normalizers de Tasks 3-4 se escriben contra supuestos.

- [ ] **Step 1: Script de sondeo** — contra `prod.moneygiver.xyz` (read-only): (a) `POST /api/auth/sign-in` con `mgPlatform: PWA` → capturar
      el shape completo de la respuesta (¿`userData.idMoneyGiver`? ¿viene también cuando `needTwoFactorAuth: true`?); (b) completar 2FA →
      capturar shape post-2FA (¿repite `idMoneyGiver`?); (c) `GET /api/clients/get-wallet-clientAccounts/v3r2.1?idMoneyGiver=` → shape real
      de `Cuenta` (nombres exactos: `idCuenta`, `cuentaClabe`, `saldo`, `nombre`, `activo`, `idCuentaAlt`); (d)
      `GET /api/clients/movimientos/{idCuenta}` → confirmar que devuelve SOLO esa cuenta (no pool global); (e)
      `POST /api/auth/refresh-token` con el refreshToken obtenido y `mgPlatform: PWA` → confirmar 200 (el refresh silencioso del cliente,
      quisquilloso en merchant).
- [ ] **Step 2: Registrar hallazgos en este plan** — si algún shape difiere, corregir los snippets de Tasks 3-4 AHORA (líneas de plan, no
      código ya escrito).
- [ ] **Step 3: Borrar el script** — `rm scripts/temp-probe-client-account.ts`. Nada que commitear en esta tarea.

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

Agregar `export type AccountKind = 'MERCHANT' | 'CLIENT'`. Agregar `accountKind?: AccountKind` (OPCIONAL) a `ConnectInput`. Cambiar
`ConnectionContext` a (ver "Interfaces compartidas" — `kind` REQUERIDO):

```ts
export interface ConnectionContext {
  accessToken: string
  kind: AccountKind // REQUERIDO — el compilador obliga a threadear en cada call site
  externalClientId?: string | null
}
```

En el miembro `'connected'` de `ConnectResult` agregar `externalClientId?: string`, y a los challenges de
`'need_two_factor_auth'`/`'need_device_validation'` agregar `externalClientId?: string | null`. Los call sites existentes del service que
construyen `{ accessToken }` NO compilarán hasta Task 5 — está bien: Tasks 2-4 solo corren `npx jest externalBank.client` (el archivo de
test construye sus ctx con `kind` explícito); el `tsc --noEmit` global se corre en Task 5 Step 7, cuando el threading ya está completo. Si
se prefiere verde total por task, el ctxFor de Task 5 puede adelantarse aquí — pero NO cambiar `kind` a opcional para "arreglar" la
compilación: ese opcional es exactamente el bug silencioso que C3 elimina.

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

Run: `cd avoqado-server && npx jest externalBank.client -t 'connect\(CLIENT\)'` Expected: FAIL (hoy `signIn` siempre pega a
`/sign-in/merchant` con MERCHANT).

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
  // El body merchant queda IDÉNTICO byte a byte al verificado en vivo (decisión 4A) — `user`
  // solo va en el login del cliente (no sabemos cuál de los dos campos lee ese endpoint).
  const body =
    kind === 'CLIENT'
      ? { email, user: email, password, dispositivo: dispositivo(deviceIdentifier) }
      : { email, password, dispositivo: dispositivo(deviceIdentifier) }
  try {
    const { data } = await axios.post(`${base()}${path}`, body, {
      headers: { ...headers(undefined, kind), twoFactorEnabled: 'true' },
      timeout: 20_000,
    })
    return data
  } catch (e) {
    if (axios.isAxiosError(e))
      throw new BadRequestError(pick<string>(e.response?.data, 'message') || `sign-in falló (status ${e.response?.status})`)
    throw e
  }
}
```

Importar `AccountKind` desde `./types`. En `connect`, destructurar con default
(`{ email, password, deviceIdentifier, accountKind = 'MERCHANT' }`) y pasar el kind:
`const data = await signIn(email, password, deviceIdentifier, accountKind)`. En `validateDevice`/`validateTwoFactorCode`, el kind llega como
input en Task 3; por ahora, para que este archivo compile, pasar `'MERCHANT'` literal en sus llamadas internas a `signIn` (se reemplaza en
Task 3).

- [ ] **Step 6: Run — pasa**

Run: `cd avoqado-server && npx jest externalBank.client` Expected: PASS (incluyendo los tests merchant existentes — el default MERCHANT los
deja intactos).

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
- Produces: `normalizeClientAccounts(payload)`, `getClientAccounts(accessToken,kind,idMoneyGiver)`, `idMoneyGiverOf(data)`.
  `connect`/`validateTwoFactorCode`/`validateDevice` devuelven cuentas del cliente + `externalClientId` cuando `accountKind==='CLIENT'`.

- [ ] **Step 1: Test — normalizeClientAccounts mapea Cuenta → ProviderAccount**

```ts
it('connect(CLIENT) sin 2FA: normaliza get-wallet-clientAccounts a ProviderAccount[]', async () => {
  nock(BASE)
    .post('/api/auth/sign-in')
    .reply(200, {
      signedIn: true,
      token: 'acc-c',
      refreshToken: 'ref-c',
      expiresIn: new Date(Date.now() + 3600e3).toISOString(),
      userData: { idMoneyGiver: 'mg-1' },
    })
  nock(BASE)
    .get('/api/clients/get-wallet-clientAccounts/v3r2.1')
    .query({ idMoneyGiver: 'mg-1' })
    .reply(200, {
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

Run: `cd avoqado-server && npx jest externalBank.client -t 'get-wallet-clientAccounts'` Expected: FAIL.

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

- [ ] **Step 4: Branch en connect/validateTwoFactorCode/validateDevice (con fallback 1A + guard C4 + headers C2)**

Extraer un helper para el "post-auth" que ramifica por kind. Reemplazar el bloque final
`const accounts = normalizeAccounts(await fetchMe(at))` en los 3 métodos por una llamada a:

```ts
async function accountsForKind(
  accessToken: string,
  kind: AccountKind,
  data: unknown,
  fallbackClientId?: string | null, // externalClientId capturado del sign-in inicial (viaja en el challenge)
): Promise<{ accounts: ProviderAccount[]; externalClientId?: string }> {
  if (kind === 'CLIENT') {
    // La respuesta del 2FA quizá no repite idMoneyGiver — el fallback viene del sign-in inicial (1A).
    const idMg = idMoneyGiverOf(data) ?? fallbackClientId ?? null
    if (!idMg) throw new BadRequestError('El proveedor no devolvió idMoneyGiver del cliente.')
    const accounts = await getClientAccounts(accessToken, idMg)
    // 0 cuentas → error honesto AHORA, no una conexión CONNECTED vacía (zombie) que confunde (C4).
    if (!accounts.length)
      throw new BadRequestError('El proveedor no devolvió cuentas para este usuario; verifica el tipo de cuenta elegido.')
    return { accounts, externalClientId: idMg }
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

`accountKind` viene del `ConnectInput` destructurado (default `'MERCHANT'`). En los retornos de challenge de `connect`, incluir el fallback:
`challenge: { accessToken, externalClientId: idMoneyGiverOf(data) }` (2FA) y
`challenge: { accessToken, processId, externalClientId: idMoneyGiverOf(data) }` (device). **El `accountKind` NO va en el challenge** — la
fuente de verdad es `conn.accountKind` en la fila, que Task 5 lee y pasa como input (decisión 3A).

**Headers de identity con kind (C2):** en el branch `need_device_validation` de `connect`, la llamada a `/api/identity/start/web` usa
`headers(accessToken, accountKind)`; en `validateDevice`, la llamada a `/api/identity/validate-otp-code/web` usa
`headers(challenge.accessToken, accountKind)`. Sin esto, esas 2 llamadas saldrían como MERCHANT dentro de una sesión PWA.

Para `validateTwoFactorCode` y `validateDevice`: agregar `accountKind: AccountKind` a su objeto input en el interface
`FinancialProviderClient` (`types.ts`), sus challenges ganan `externalClientId?: string | null`, y usar
`accountsForKind(at, accountKind, data|v, challenge.externalClientId)`. El re-login interno de `validateDevice` pasa `accountKind` a
`signIn` (reemplaza el `'MERCHANT'` literal de Task 2).

- [ ] **Step 4b: Test — validateTwoFactorCode(CLIENT) completo con fallback (decisión 6A; el flujo real más común)**

```ts
it('validateTwoFactorCode(CLIENT): respuesta 2FA SIN idMoneyGiver usa el fallback del challenge', async () => {
  nock(BASE)
    .post('/api/auth/validate-two-factor-code')
    .reply(200, {
      success: true,
      token: 'acc-2fa',
      refreshToken: 'ref-2fa',
      expiresIn: new Date(Date.now() + 3600e3).toISOString(),
      // deliberadamente SIN userData/idMoneyGiver — el fallback debe cubrirlo
    })
  nock(BASE)
    .get('/api/clients/get-wallet-clientAccounts/v3r2.1')
    .query({ idMoneyGiver: 'mg-1' })
    .reply(200, {
      cuentas: [{ idCuenta: 'cta-1', nombre: 'Mi cuenta', cuentaClabe: '646...', saldo: 50, activo: true, idCuentaAlt: 9 }],
    })
  const client = await loadClient()
  const r = await client.validateTwoFactorCode({
    email: 'a@b.co',
    deviceIdentifier: DEVICE,
    code: '123456',
    accountKind: 'CLIENT',
    challenge: { accessToken: 'tmp-2fa', externalClientId: 'mg-1' },
  })
  expect(r.kind).toBe('connected')
  if (r.kind === 'connected') expect(r.externalClientId).toBe('mg-1')
})
```

- [ ] **Step 4c: Tests — edges de normalización y guard (decisión 7A)**

Tres tests chicos junto a los anteriores: (1) `normalizeClientAccounts` filtra cuentas sin `idCuenta` y devuelve `[]` con payload sin
`cuentas[]`; (2) `connect(CLIENT)` cuya respuesta de login NO trae `idMoneyGiver` (y sin fallback) → rechaza con `BadRequestError` 'no
devolvió idMoneyGiver'; (3) `connect(CLIENT)` con `cuentas: []` → rechaza con 'no devolvió cuentas' (guard C4), y NO devuelve
`kind: 'connected'`.

- [ ] **Step 5: Run — pasa**

Run: `cd avoqado-server && npx jest externalBank.client` Expected: PASS (todos: merchant existentes + client nuevos).

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

Run: `cd avoqado-server && npx jest externalBank.client -t 'listMovements\(CLIENT\)'` Expected: FAIL (hoy siempre usa idNegocio en la ruta +
idCuenta query).

- [ ] **Step 3: Implementar branch en listMovements**

En `listMovements`, al inicio construir params y elegir URL por `ctx.kind`:

Los comentarios existentes del método documentan quirks verificados en vivo que costaron descubrimiento real — **se CONSERVAN, no se borran
al copiar este snippet** (decisión 5A):

```ts
async listMovements(ctx, idNegocio, cuentaId, query) {
  const isClient = ctx.kind === 'CLIENT'
  const params: Record<string, unknown> = { 'Pagination.Page': query.page, 'Pagination.Size': query.size }
  // MERCHANT — ruta = idNegocio, `idCuenta` como query param → acota a la cuenta real del negocio.
  // (Confirmado en vivo: con cuentaId en la ruta el proveedor ignora el filtro y devuelve
  //  un pool global de ~5.1M movimientos ajenos; con idNegocio+query idCuenta da los reales.)
  // CLIENT — ruta = idCuenta directo, SIN idCuenta query (scoping confirmado en Task 1.5).
  if (!isClient) params.idCuenta = cuentaId
  // Estado de cuenta = más reciente primero. Sin esto QPay devuelve su orden interno (NO por
  // fechaCreacion), lo que con paginación deja la página 1 barajada en vez de los 10 más nuevos.
  // El orden debe pedirse server-side: ordenar en el cliente solo reordenaría los 10 de la página
  // actual, no el conjunto. El valor de SortByFecha no está documentado; en el API .NET un valor
  // de query no reconocido se ignora (no truena), así que 'desc' es fix en el mejor caso y no-op
  // en el peor — a validar contra el estado de cuenta real.
  params.SortByFecha = 'desc'
  if (query.from) params.FechaInicio = query.from
  if (query.to) params.FechaFinal = query.to
  const path = isClient ? `/api/clients/movimientos/${cuentaId}` : `/api/clients/movimientos/${idNegocio}`
  const { data } = await axios.get(`${base()}${path}`, { headers: headers(ctx.accessToken, ctx.kind), params, timeout: 20_000 })
  const raw = pick<unknown[]>(data, 'data')
  return { movements: Array.isArray(raw) ? raw.map(normalizeMovement) : [], total: toNum(pick(data, 'total')) ?? 0 }
}
```

Además, actualizar el comentario del interface en `types.ts` (líneas ~127-129, arriba de `listMovements`) para que describa AMBAS rutas:
merchant = idNegocio en ruta + idCuenta query; cliente = idCuenta en la ruta. Un comentario stale ahí es peor que ninguno.

**⚠ Verificación en vivo requerida (Task 9):** confirmar que `/api/clients/movimientos/{idCuenta}` para cliente devuelve SOLO esa cuenta
(no pool global como la cuenta de dispersión del merchant). Si devuelve pool, replicar el patrón de filtro.

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

Actualizar todas las llamadas `headers(ctx.accessToken)` dentro de métodos con `ctx` para pasar `ctx.kind`:
`headers(ctx.accessToken, ctx.kind)` en `getMovementStats`, `resolveMgAlt`, `internalTransfer`, `revoke`. (En `refresh`, usar
`headers(undefined, ctx.kind)` no aplica porque refresh no tiene ctx todavía — ver Task 5.)

- [ ] **Step 4b: Tests — listAccounts/getBalance del cliente (decisión 7A)**

Dos tests junto al de listMovements: (1) `listAccounts({ accessToken: 't', kind: 'CLIENT', externalClientId: null })` → rechaza con
`BadRequestError` 'Falta externalClientId' (guard verificable, no un crash críptico); (2)
`getBalance({ accessToken: 't', kind: 'CLIENT', externalClientId: 'mg-1' }, 'cta-1')` con nock de `get-wallet-clientAccounts` → devuelve
`{ amount: <saldo de cta-1>, active, providerAccountLabel }` correctos.

- [ ] **Step 5: Run — pasa**

Run: `cd avoqado-server && npx jest externalBank.client` Expected: PASS.

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
- Modify: `avoqado-server/src/services/financial-connections/types.ts` (firma de `refresh` — Step 4)
- Modify: `avoqado-server/src/services/financial-connections/externalBank.client.ts` (impl de `refresh` — Step 4)
- Test: `avoqado-server/tests/unit/services/financial-connections/financialConnection.service.test.ts`
- Test: `avoqado-server/tests/unit/services/financial-connections/externalBank.client.test.ts` (test de refresh — Step 4)

**Interfaces:**

- Consumes: client con branch por kind (Tasks 2-4), schema `accountKind`/`externalClientId` (Task 1).
- Produces: `startConnection` recibe `accountKind`; ctx construido con `{ accessToken, kind, externalClientId }` en todos los call sites;
  `refresh` recibe kind.

- [ ] **Step 1: startConnection persiste accountKind y lo pasa al client**

`startConnection` input gana `accountKind?: AccountKind` (default 'MERCHANT'). Al crear la fila `financialConnection.create`, setear
`accountKind: input.accountKind ?? 'MERCHANT'`. Pasar `accountKind` a `client.connect({ ..., accountKind })`. En el challenge cifrado (2FA y
device) incluir SOLO `externalClientId` (el fallback de 1A que devuelve el client en `r.challenge.externalClientId`):
`encryptGrant({ ..., externalClientId: r.challenge.externalClientId ?? null })`. **El `accountKind` NO se duplica en el challenge**
(decisión 3A): en `validateDevice`/`validateTwoFactorAuth` se lee SIEMPRE de `conn.accountKind` (la fila ya existe antes de cualquier reto y
ambos métodos ya cargan `conn` con `findUniqueOrThrow`) y se pasa al client junto con
`challenge: { ..., externalClientId: ch.externalClientId ?? null }`.

- [ ] **Step 2: finishConnected persiste externalClientId**

`finishConnected(connectionId, deviceIdentifier, grant, accounts, accessToken?, externalClientId?)`. En el `financialConnection.update` de
connectedAt, setear `externalClientId: externalClientId ?? undefined`. Los 3 call sites (`startConnection`, `validateDevice`,
`validateTwoFactorAuth`) pasan `r.externalClientId`.

- [ ] **Step 3: ctx con kind+externalClientId en todos los call sites**

Cambiar cada construcción `{ accessToken }` que se pasa a métodos del client por:

```ts
function ctxFor(
  conn: { accountKind: FinancialConnectionAccountKind; externalClientId: string | null },
  accessToken: string,
): ConnectionContext {
  return { accessToken, kind: conn.accountKind, externalClientId: conn.externalClientId }
}
```

Aplicar en: `resolveCuentaId` (retorna también el kind/clientId via conn), `getMovementsForAccount`, `getMovementStatsForAccount`,
`getBalanceForConnectionAccount`, `resolveTransferDestination`, `sendInternalTransfer`, `disconnect`. Asegurar que las queries Prisma que
cargan `conn`/`fa.connection` incluyan `accountKind` y `externalClientId` en el `select`/`include`.

- [ ] **Step 4: refresh recibe kind**

`accessTokenFor` llama `client.refresh(grant, deviceIdentifier)`. Cambiar la firma del interface
`refresh(grant, deviceIdentifier, kind: AccountKind)` (requerido, consistente con C3) y en el client usar `headers(undefined, kind)` en la
llamada a `/api/auth/refresh-token`; el `ctx` que devuelve `refresh` también incluye `kind`. `accessTokenFor` pasa `conn.accountKind`.

Test (decisión 7A, va en `externalBank.client.test.ts`): `refresh(grant, DEVICE, 'CLIENT')` con nock que captura headers → assert
`mgplatform === 'PWA'` y que devuelve el grant rotado; los tests de refresh merchant existentes siguen en verde.

- [ ] **Step 5: Controller acepta accountKind**

En `financialConnection.controller.ts:23`:

```ts
const { providerId, email, password, accountKind } = req.body ?? {}
if (!providerId || !email || !password) throw new BadRequestError('providerId, email y password son requeridos.')
// Validación en el boundary (C5): ausente → MERCHANT (retrocompatible); basura → 400 visible
// donde ocurrió, jamás una conexión del tipo equivocado que falla críptica 3 pasos después.
if (accountKind != null && accountKind !== 'MERCHANT' && accountKind !== 'CLIENT') {
  throw new BadRequestError('accountKind debe ser MERCHANT o CLIENT.')
}
const kind = accountKind ?? 'MERCHANT'
const r = await svc.startConnection({ venueId: req.params.venueId, providerId, email, password, staffId, accountKind: kind })
```

- [ ] **Step 5b: accountKind en el listado + guard de transferencias (decisión C1)**

Dos cambios en el service:

1. `listConnectionsForVenue`: agregar `accountKind: true` al `select` — sin esto la UI no puede etiquetar conexiones personales ni ocultar
   el botón de transferir.
2. Guard de dinero: al inicio de `sendInternalTransfer` y `resolveTransferDestination` (después del `findUniqueOrThrow` de `fa`):

```ts
// Transferencias solo para cuentas de NEGOCIO. El flujo de transfer con sesión CLIENT (PWA)
// jamás se ha probado contra el proveedor — el spec lo declara fuera de alcance y este guard
// lo hace cumplir (el botón de la UI también se oculta, pero el backend es la fuente de verdad).
if (fa.connection.accountKind === 'CLIENT') {
  throw new BadRequestError('Las transferencias no están disponibles para cuentas personales.')
}
```

Test (misma regla N sitios → N tests): `sendInternalTransfer` sobre una conexión CLIENT → rechaza con ese mensaje ANTES de tocar el provider
(mock del client sin llamadas).

- [ ] **Step 6: Test del service — startConnection guarda accountKind y externalClientId**

En `financialConnection.service.test.ts`, mockear el registry/client para que `connect` devuelva
`{ kind:'connected', grant, accounts:[], accessToken:'t', externalClientId:'mg-1' }` con input `accountKind:'CLIENT'`; assert que
`prisma.financialConnection.create` recibió `accountKind:'CLIENT'` y que finishConnected hizo update con `externalClientId:'mg-1'`. (Seguir
el patrón de mocks existente en el archivo.)

- [ ] **Step 7: Run tests + typecheck**

Run: `cd avoqado-server && npx jest financial-connections && NODE_OPTIONS='--max-old-space-size=8192' npx tsc --noEmit` Expected: PASS + 0
errores.

- [ ] **Step 8: Commit**

```bash
cd avoqado-server
git add src/services/financial-connections/financialConnection.service.ts src/controllers/dashboard/financialConnection.controller.ts src/services/financial-connections/types.ts src/services/financial-connections/externalBank.client.ts tests/unit/services/financial-connections/financialConnection.service.test.ts tests/unit/services/financial-connections/externalBank.client.test.ts
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
  expect(mocked.post).toHaveBeenCalledWith('/api/v1/dashboard/venues/v1/financial-connections', {
    providerId: 'p1',
    email: 'a@b.co',
    password: 'x',
    accountKind: 'CLIENT',
  })
})
```

- [ ] **Step 2: Run — falla**

Run: `cd avoqado-web-dashboard && npx vitest run financialConnection.service` Expected: FAIL.

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

- [ ] **Step 3b: El tipo del listado de conexiones gana `accountKind`**

En el mismo `financialConnection.service.ts` del dashboard, el tipo de la conexión que devuelve `listConnections` (el shape que consume
`BankAccountsSection`) gana `accountKind: 'MERCHANT' | 'CLIENT'` — el backend ya lo expone desde Task 5 Step 5b. Lo consume Task 7 (badge +
ocultar transferir).

- [ ] **Step 4: Run — pasa**

Run: `cd avoqado-web-dashboard && npx vitest run financialConnection.service` Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd avoqado-web-dashboard
git add src/services/financialConnection.service.ts src/services/__tests__/financialConnection.service.test.ts
git commit -m "feat(financial-connections): createConnection acepta accountKind"
```

---

### Task 7: Frontend — toggle Negocio/Personal en el wizard + badge/gate en la card

**Files:**

- Modify: `avoqado-web-dashboard/src/pages/Venue/components/BankConnectWizard.tsx` (estado + paso `credentials` ~línea 159, mutación
  `connect` ~línea 74)
- Modify: `avoqado-web-dashboard/src/pages/Venue/Edit/components/BankAccountsSection.tsx` (badge Personal + ocultar transferir — decisión
  C1)
- Test: `avoqado-web-dashboard/src/pages/Venue/components/BankConnectWizard.test.tsx` (decisión 8A)

**Interfaces:**

- Consumes: `createConnection(..., { accountKind })` (Task 6), `accountKind` en el listado (Task 6 Step 3b).

- [ ] **Step 1: Estado del tipo**

Junto a los otros `useState` (~línea 50): `const [accountKind, setAccountKind] = useState<'MERCHANT' | 'CLIENT'>('MERCHANT')`.

- [ ] **Step 2: Pasar accountKind a la mutación**

En la mutación `connect` (~línea 74):
`mutationFn: () => financialConnectionAPI.createConnection(venueId, { providerId: provider!.id, email, password, accountKind })`.

- [ ] **Step 3: Segmented control arriba de email/password**

Dentro del `<form>` del paso `credentials`, antes del campo email, insertar un control de 2 opciones (usar el patrón de botones que ya usa
el wizard; clases Tailwind del proyecto). Cada botón setea `setAccountKind`. Ejemplo mínimo con estilos existentes:

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

Importar `cn` de `@/lib/utils` si no está. La descripción del paso (`wizard.step2.description`) puede quedar; opcionalmente mostrar ayuda
por tipo (Task 8 provee la key `wizard.step2.kind.hint`).

- [ ] **Step 3b: Badge "Personal" + ocultar transferir en la card (decisión C1)**

En `BankAccountsSection.tsx`: (a) si `connection.accountKind === 'CLIENT'`, mostrar un `<Badge variant="outline">` con
`t('wizard.step2.kind.badge')` junto al nombre del proveedor; (b) el `canTransfer` de `AccountRow` (~línea 153) pasa a
`connection.status === 'CONNECTED' && connection.accountKind !== 'CLIENT'` — el backend ya rechaza (Task 5 Step 5b), esto solo evita mostrar
un botón que va a fallar.

- [ ] **Step 3c: Test de componente — el toggle protege el contrato (decisión 8A)**

`BankConnectWizard.test.tsx` (patrón `.test.tsx` existente en el repo, ver `src/pages/Reports/MoneyLocationStrip.test.tsx`): mockear
`financialConnectionAPI`, render del wizard en el paso credentials. Dos asserts: (1) submit SIN tocar el toggle → `createConnection` recibe
`accountKind: 'MERCHANT'` (el default retrocompatible es el invariante más fácil de romper sin querer); (2) click en "Cuenta personal" +
submit → recibe `accountKind: 'CLIENT'`.

- [ ] **Step 4: Verificar que compila, renderiza y el test pasa**

Run: `cd avoqado-web-dashboard && npx tsc --noEmit && npx vitest run BankConnectWizard` Expected: 0 errores, test PASS. (Verificación visual
en Task 9 con el preview.)

- [ ] **Step 5: Commit**

```bash
cd avoqado-web-dashboard
git add src/pages/Venue/components/BankConnectWizard.tsx src/pages/Venue/components/BankConnectWizard.test.tsx src/pages/Venue/Edit/components/BankAccountsSection.tsx
git commit -m "feat(financial-connections): toggle Negocio/Personal en el wizard + badge/gate Personal"
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
"kind": { "business": "Cuenta de negocio", "personal": "Cuenta personal", "badge": "Personal", "hint": "Personal: la cuenta con la que entras a la app de tu banco. Negocio: tu panel de comercio." }
```

en:

```json
"kind": { "business": "Business account", "personal": "Personal account", "badge": "Personal", "hint": "Personal: the account you use to sign in to your bank app. Business: your merchant panel." }
```

fr:

```json
"kind": { "business": "Compte entreprise", "personal": "Compte personnel", "badge": "Personnel", "hint": "Personnel : le compte avec lequel vous vous connectez à l'app de votre banque. Entreprise : votre panneau marchand." }
```

(`badge` la consume la card de conexión — Task 7 Step 3b. Vive dentro de `kind` para que el check de paridad del Step 2 la cubra sin script
nuevo.)

- [ ] **Step 2: Verificar paridad de keys**

Run:
`cd avoqado-web-dashboard && node -e "const es=require('./src/locales/es/financialConnections.json'),en=require('./src/locales/en/financialConnections.json'),fr=require('./src/locales/fr/financialConnections.json');const c=o=>JSON.stringify(Object.keys(o).sort());console.log('step2.kind es==en==fr:', c(es.wizard.step2.kind)===c(en.wizard.step2.kind)&&c(es.wizard.step2.kind)===c(fr.wizard.step2.kind))"`
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

Run: `cd avoqado-server && NODE_OPTIONS='--max-old-space-size=8192' npx tsc --noEmit && npx jest financial-connections` Run:
`cd avoqado-web-dashboard && npx tsc --noEmit && npx vitest run financialConnection` Expected: 0 errores, tests PASS.

- [ ] **Step 2: Smoke en vivo con `devgerruiz` (cliente)**

Con el backend dev corriendo, en el wizard elegir **Cuenta personal**, conectar con las credenciales de `devgerruiz` (Jose las teclea; el
implementer NO usa credenciales ajenas), completar 2FA, y verificar en la UI: aparece la lista de cuentas del cliente, el saldo, y el
detalle de movimientos.

- [ ] **Step 3: Confirmar consistencia con el probe de Task 1.5**

Los unknowns del spec ya se resolvieron en vivo en Task 1.5 (shapes, scoping de movimientos, refresh PWA). Aquí solo confirmar que el
comportamiento integrado (por la UI) coincide con lo observado en el probe. Si algo difiere, corregir el código de la tarea
correspondiente + su test.

- [ ] **Step 3b: Forzar el refresh silencioso del cliente (decisión 2A)**

El token del login vive ~55 min en el cache en memoria, así que el smoke normal JAMÁS ejercita `/api/auth/refresh-token` con
`mgPlatform: PWA` — y ese endpoint ya demostró ser quisquilloso en merchant. Reiniciar el proceso dev del backend (vacía `tokenCache`) y
volver a leer el saldo de la cuenta personal conectada: debe responder el saldo (no `NEEDS_REAUTH`). Esto valida el refresh integrado
end-to-end además del probe de Task 1.5(e).

- [ ] **Step 4: Verificar que el merchant sigue intacto + gating de transfer**

Conectar una **Cuenta de negocio** (flujo actual) y verificar saldo/movimientos — no debe haber regresión. Verificar además que la card de
la cuenta **personal** muestra el badge "Personal" y NO muestra el botón de transferir, y que la cuenta de negocio sí lo conserva.

- [ ] **Step 5: Review final de rama**

Dispatch al code-reviewer (superpowers:requesting-code-review) sobre el diff completo de la rama. Arreglar Critical/Important.

---

## Self-Review (checklist del autor del plan)

- **Cobertura del spec:** ✅ 4 branch points → Tasks 2 (mgPlatform+login), 3 (listado cuentas), 4 (movimientos/saldo). accountKind
  persistido → Task 1+5. FE toggle → Tasks 6-8. Verificación en vivo (3 unknowns) → Task 9.
- **Placeholders:** los "⚠ verificación en vivo" son unknowns nombrados explícitamente con qué confirmar y qué hacer si difiere — no son
  TODO abiertos.
- **Consistencia de tipos:** `AccountKind` ('MERCHANT'|'CLIENT') consistente en types/client/service; `ConnectionContext` gana
  `kind`+`externalClientId` (Task 2) usados en Tasks 4-5; `ConnectResult.externalClientId` (Task 2) producido en Task 3, consumido en Task
  5; `platformForKind`/`headers(token,kind)` (Task 2) usados en 3-4.
- **YAGNI:** no auto-detección, no transferencias-desde-cliente (ahora ENFORCED con guard backend + UI — Task 5 Step 5b / Task 7 Step 3b),
  no modelo colaborador, no rollout prod (pendiente separado).

## GSTACK REVIEW REPORT

| Review        | Trigger               | Why                             | Runs | Status          | Findings                                                                    |
| ------------- | --------------------- | ------------------------------- | ---- | --------------- | --------------------------------------------------------------------------- |
| CEO Review    | `/plan-ceo-review`    | Scope & strategy                | 0    | —               | —                                                                           |
| Codex Review  | `/codex review`       | Independent 2nd opinion         | 1    | ISSUES ABSORBED | 8 tensiones sustantivas: 7 aceptadas (C1-C7), 1 rechazada (C8)              |
| Eng Review    | `/plan-eng-review`    | Architecture & tests (required) | 1    | CLEAR (PLAN)    | 8 issues (2 arq, 3 calidad, 3 tests), 0 critical gaps, todos folded al plan |
| Design Review | `/plan-design-review` | UI/UX gaps                      | 0    | —               | —                                                                           |
| DX Review     | `/plan-devex-review`  | Developer experience gaps       | 0    | —               | —                                                                           |

**CODEX:** halló 4 hoyos reales que el review principal no vio — transfers desde CLIENT sin gate (C1), headers de identity sin kind (C2),
secuencia no commit-safe (C3 parcial), zombie 0-cuentas (C4) — más higiene de plan (C7). Su ataque a la regla "N sitios → N tests" (C8) se
rechazó.

**CROSS-MODEL:** ambos modelos coincidieron en el riesgo del flujo CLIENT+2FA (fallback idMoneyGiver) y en verificar-en-vivo-antes (probe
Task 1.5). Divergencia única: la regla de cobertura del plan (C8) — se mantiene la convención del autor.

**VERDICT:** ENG CLEARED — ready to implement. Decisiones D2-D22 aplicadas al plan (tier: hereda gating actual; transfers solo MERCHANT;
probe en vivo primero; 3 TODOs registrados en TODOS.md).

NO UNRESOLVED DECISIONS
