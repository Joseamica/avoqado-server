# Financial Connections (Backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Backend para que un cliente conecte su cuenta bancaria (Moneygiver/QPay hoy) desde Avoqado y consulte su saldo, sin re-login, con base extensible a otros bancos.

**Architecture:** Catálogo `FinancialProvider` (crece solo, sin enums de banco) → `FinancialConnection` (un login, dueño = sucursal, refreshToken cifrado) → `FinancialAccount` (cada negocio que ve el login, ligado a ≤1 merchant vía `MerchantAccount.financialAccountId`). Un cliente por provider en un registry hace connect/validateDevice/refresh/revoke/listAccounts/getBalance. El refresh (el token rota) se serializa con `pg_advisory_xact_lock`. Fuente: `docs/superpowers/specs/2026-06-30-conexiones-bancarias-saldo-design.md` (v2.2).

**Tech Stack:** TypeScript · Express · Prisma/PostgreSQL · axios · zod · Jest + nock. Cifrado: `src/lib/token-encryption.ts` (AES-256-GCM ya existente).

## Global Constraints

- **Sin nombres de vendor en identificadores.** El catálogo usa `code = "EXTERNAL_BANK"`, nunca "moneygiver"/"qpay" en nombres de clase/archivo/campo. (El `DEVICE_INFO.identificador` existente `'avoqado-server-moneygiver-balance-lookup'` NO se cambia — ya está registrado en prod.)
- **Llave dedicada:** `FINANCIAL_CONNECTION_KEY` (hex 32 bytes / 64 chars), AES-256-GCM vía `createTokenCipher`. **Sin fallback a llave default** (falla cerrada en uso si falta).
- **El secreto (refreshToken) nunca** sale en respuestas HTTP ni logs; se descifra solo en el borde de la llamada al proveedor.
- **Refresh serializado entre instancias** con `pg_advisory_xact_lock(hashtext(connectionId))`.
- **Saldo `OK` ⇒ `amount` y `syncedAt` no nulos.** Saldo nulo/malformado del proveedor ⇒ `ERROR`/`UNKNOWN`, nunca `OK` en blanco.
- **Invariante `venueId IS NULL ⇔ mode = SHARED_BROKER`.**
- **Authz:** endpoints bajo `/venues/:venueId/financial-connections` con `authenticateTokenMiddleware` + `checkOwnerAccess`.
- **API base del proveedor:** `env.EXTERNAL_BANK_API_BASE`; header `mgPlatform: env.EXTERNAL_BANK_MG_PLATFORM`.
- **NO correr `prisma migrate reset` nunca.** Si `migrate dev` detecta drift, usar el patrón `migrate diff --script` → `psql` → `migrate resolve --applied`.
- TDD estricto; `npm run typecheck`, `npm run lint`, `npm test` limpios al final.

---

### Task 1: Schema Prisma — catálogo, 2 tablas nuevas, FK en MerchantAccount, quitar campos viejos

**Files:**
- Modify: `prisma/schema.prisma` (modelo `BalanceProvider`, modelo `MerchantAccount`, agregar enums + 2 modelos)
- Create: `prisma/migrations/<timestamp>_financial_connections/migration.sql` (vía prisma)

**Interfaces:**
- Produces: modelos Prisma `FinancialProvider`, `FinancialConnection`, `FinancialAccount`; enums `FinancialConnectionType`, `FinancialConnectionMode`, `FinancialConnectionStatus`, `FinancialBalanceState`; campo `MerchantAccount.financialAccountId`. Los usan Tasks 3-7.

- [ ] **Step 1: Renombrar `BalanceProvider` → `FinancialProvider` y extenderlo**

En `prisma/schema.prisma`, localizar `model BalanceProvider { … }` y reemplazarlo por:

```prisma
enum FinancialConnectionType   { DIRECT_CREDENTIAL DIRECT_OAUTH AGGREGATOR }
enum FinancialConnectionMode   { SELF_CONNECT SHARED_BROKER }
enum FinancialConnectionStatus { PENDING_DEVICE_VALIDATION PENDING_ACCOUNT_SELECTION CONNECTED NEEDS_REAUTH REVOKED ERROR }
enum FinancialBalanceState     { OK ERROR UNKNOWN }

/// Catálogo de proveedores bancarios/fintech (lectura de saldo). Crece solo:
/// agregar un banco = una fila + un cliente en el registry. Sin enums de banco.
model FinancialProvider {
  id             String  @id @default(cuid())
  code           String  @unique            // "EXTERNAL_BANK", futuro "BBVA_DIRECT", "BELVO"
  name           String
  active         Boolean @default(true)
  connectionType FinancialConnectionType @default(DIRECT_CREDENTIAL)
  connections    FinancialConnection[]
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  @@index([active])
}
```

- [ ] **Step 2: Agregar `FinancialConnection` y `FinancialAccount`**

Justo después de `FinancialProvider`, agregar:

```prisma
/// Un login a un proveedor. Dueño = la sucursal (venueId null = broker de plataforma).
model FinancialConnection {
  id           String @id @default(cuid())
  venueId      String?
  venue        Venue?  @relation(fields: [venueId], references: [id], onDelete: Cascade)
  providerId   String
  provider     FinancialProvider @relation(fields: [providerId], references: [id])
  mode         FinancialConnectionMode   @default(SELF_CONNECT)
  status       FinancialConnectionStatus @default(PENDING_DEVICE_VALIDATION)
  grantEnc     String?   // refreshToken cifrado (AES-256-GCM). null en SHARED_BROKER
  tokenVersion Int      @default(0)
  expiresAt    DateTime?
  challengeEnc       String?   // reto OTP cifrado (accessToken temporal + processId)
  challengeExpiresAt DateTime?
  deviceIdentifier String?
  accounts         FinancialAccount[]
  createdByStaffId String?
  connectedAt      DateTime?
  revokedAt        DateTime?
  lastError        String?
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt
  @@index([venueId])
  @@index([providerId])
  @@index([status])
}

/// Una cuenta (negocio) que ve la conexión. Varios merchants pueden liquidar en ella.
model FinancialAccount {
  id           String @id @default(cuid())
  connectionId String
  connection   FinancialConnection @relation(fields: [connectionId], references: [id], onDelete: Cascade)
  externalId   String
  label        String?
  institution  String?
  clabe        String?
  currency     String  @default("MXN")
  active       Boolean?
  lastBalance  Decimal? @db.Decimal(18, 2)
  lastSyncedAt DateTime?
  balanceState FinancialBalanceState @default(UNKNOWN)
  lastError    String?
  merchantAccounts MerchantAccount[]
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  @@unique([connectionId, externalId])
  @@index([connectionId])
}
```

- [ ] **Step 3: En `MerchantAccount`, mover el FK y quitar los campos viejos**

En `model MerchantAccount`, borrar las líneas:
```prisma
  balanceProviderId        String?
  balanceProvider          BalanceProvider? @relation(fields: [balanceProviderId], references: [id])
  balanceProviderAccountId String?
```
y agregar en su lugar:
```prisma
  // Cuenta bancaria donde liquida ESTE merchant (muchos merchants → una cuenta).
  financialAccountId String?
  financialAccount   FinancialAccount? @relation(fields: [financialAccountId], references: [id], onDelete: SetNull)
```

- [ ] **Step 4: Agregar la relación inversa en `Venue`**

En `model Venue`, agregar entre sus relaciones:
```prisma
  financialConnections FinancialConnection[]
```

- [ ] **Step 5: Generar la migración**

Run: `npx prisma migrate dev --name financial_connections`
Expected: crea `prisma/migrations/<ts>_financial_connections/` y aplica; `npx prisma generate` corre solo.
**Si reporta drift y ofrece reset:** NO aceptar. Cancelar, y usar:
`npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script > /tmp/fc.sql`, revisar, aplicar con `psql "$DATABASE_URL" -f /tmp/fc.sql`, crear la carpeta de migración con ese SQL, y `npx prisma migrate resolve --applied <ts>_financial_connections`.

- [ ] **Step 6: Verificar que el cliente Prisma compila**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i "balanceProvider" || echo "sin refs a balanceProvider en tipos"`
Expected: aparecerán errores de compilación en los archivos que aún usan `balanceProvider*` (se arreglan en Task 7). Confirmar que los NUEVOS modelos existen: `node -e "const {PrismaClient}=require('@prisma/client'); new PrismaClient().financialConnection; console.log('ok')"` → `ok`.

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(financial-connections): schema — provider catalog, connection+account tables, MerchantAccount.financialAccountId"
```

---

### Task 2: Env var + wrapper de cifrado del grant

**Files:**
- Modify: `src/config/env.ts` (agregar `FINANCIAL_CONNECTION_KEY`)
- Modify: `.env.example` (documentar la nueva key)
- Create: `src/services/financial-connections/crypto.ts`
- Test: `tests/unit/services/financial-connections/crypto.test.ts`

**Interfaces:**
- Produces: `encryptGrant(grant: unknown): string`, `decryptGrant<T=any>(enc: string): T`. Los usa Task 5.

- [ ] **Step 1: Declarar la env var**

En `src/config/env.ts`, dentro de `envSchema.z.object({…})`, cerca del bloque `EXTERNAL_BANK_*`, agregar:
```typescript
  // Llave dedicada (hex 32 bytes) para cifrar el refreshToken de conexiones bancarias (AES-256-GCM).
  FINANCIAL_CONNECTION_KEY: z.string().length(64, 'FINANCIAL_CONNECTION_KEY debe ser hex de 32 bytes (64 chars)').optional(),
```
En `.env.example`, bajo la sección de EXTERNAL BANK, agregar:
```
# Cifrado de refreshTokens bancarios (AES-256-GCM). Generar: openssl rand -hex 32
FINANCIAL_CONNECTION_KEY=
```

- [ ] **Step 2: Escribir el test (falla)**

`tests/unit/services/financial-connections/crypto.test.ts`:
```typescript
describe('financial-connections crypto', () => {
  const KEY = 'a'.repeat(64) // 32 bytes en hex

  afterEach(() => {
    jest.resetModules()
    delete process.env.FINANCIAL_CONNECTION_KEY
  })

  it('roundtrips a grant object', async () => {
    process.env.FINANCIAL_CONNECTION_KEY = KEY
    const { encryptGrant, decryptGrant } = await import('@/services/financial-connections/crypto')
    const grant = { refreshToken: 'r-123', expiresAt: '2026-07-01T00:00:00Z' }
    const enc = encryptGrant(grant)
    expect(typeof enc).toBe('string')
    expect(enc).not.toContain('r-123') // cifrado, no texto plano
    expect(decryptGrant(enc)).toEqual(grant)
  })

  it('fails closed when the key is missing (no default fallback)', async () => {
    // sin FINANCIAL_CONNECTION_KEY
    const { encryptGrant } = await import('@/services/financial-connections/crypto')
    expect(() => encryptGrant({ refreshToken: 'x' })).toThrow()
  })
})
```

- [ ] **Step 3: Correr el test → falla**

Run: `npx jest tests/unit/services/financial-connections/crypto.test.ts`
Expected: FAIL (módulo no existe).

- [ ] **Step 4: Implementar**

`src/services/financial-connections/crypto.ts`:
```typescript
import { createTokenCipher, type TokenCipher } from '@/lib/token-encryption'

// Lazy: no cifra al boot; falla cerrada la PRIMERA vez que se use sin la llave.
let _cipher: TokenCipher | null = null
function cipher(): TokenCipher {
  return (_cipher ??= createTokenCipher('FINANCIAL_CONNECTION_KEY'))
}

/** Cifra un grant (p.ej. { refreshToken, expiresAt }) a base64 AES-256-GCM. */
export function encryptGrant(grant: unknown): string {
  return cipher().encryptToBase64(JSON.stringify(grant))
}

/** Descifra un grant. Lanza si la llave/formato no cuadran. */
export function decryptGrant<T = any>(enc: string): T {
  return JSON.parse(cipher().decryptFromBase64(enc)) as T
}
```
> Nota: `createTokenCipher(envVar)` (en `src/lib/token-encryption.ts`) lee la llave en hex de esa env var y lanza si falta/es inválida. Verificar que expone `encryptToBase64`/`decryptFromBase64`; si no, usar `encrypt`/`decrypt` (Buffer) y `.toString('base64')`.

- [ ] **Step 5: Correr el test → pasa; commit**

Run: `npx jest tests/unit/services/financial-connections/crypto.test.ts` → PASS
```bash
git add src/config/env.ts .env.example src/services/financial-connections/crypto.ts tests/unit/services/financial-connections/crypto.test.ts
git commit -m "feat(financial-connections): dedicated AES-256-GCM grant crypto (fail-closed)"
```

---

### Task 3: Contrato del cliente de provider + registry

**Files:**
- Create: `src/services/financial-connections/types.ts`
- Create: `src/services/financial-connections/registry.ts`
- Test: `tests/unit/services/financial-connections/registry.test.ts`

**Interfaces:**
- Produces: `FinancialProviderClient` (interfaz), tipos `Grant`, `ConnectResult`, `ProviderAccount`, `BalanceSnapshot`, `ConnectionContext`; `getFinancialProviderClient(code): FinancialProviderClient | undefined`. Los usan Tasks 4 y 5.

- [ ] **Step 1: Definir los tipos**

`src/services/financial-connections/types.ts`:
```typescript
/** Secreto persistible de una conexión (se cifra antes de guardar). */
export interface Grant {
  refreshToken: string
  expiresAt?: string | null
}

/** Cuenta tal como la reporta el proveedor (negocio). */
export interface ProviderAccount {
  externalId: string
  label: string | null
  clabe: string | null
  active: boolean | null
  balance: number | null   // saldo si viene en el listado; null si no
}

/** Snapshot de saldo de UNA cuenta. */
export interface BalanceSnapshot {
  amount: number | null
  currency: string
  active: boolean | null
  providerAccountLabel: string | null
}

/** Resultado de connect/validateDevice. */
export type ConnectResult =
  | { kind: 'connected'; grant: Grant; accounts: ProviderAccount[] }
  | { kind: 'need_device_validation'; challenge: { accessToken: string; processId: string } }

/** Lo que el cliente necesita para operar ya autenticado. */
export interface ConnectionContext {
  accessToken: string
}

export interface ConnectInput {
  email: string
  password: string
  deviceIdentifier: string
}

export interface FinancialProviderClient {
  connect(input: ConnectInput): Promise<ConnectResult>
  validateDevice(input: {
    email: string; password: string; deviceIdentifier: string
    challenge: { accessToken: string; processId: string }; code: string
  }): Promise<ConnectResult>
  refresh(grant: Grant, deviceIdentifier: string): Promise<{ grant: Grant; ctx: ConnectionContext }>
  revoke(ctx: ConnectionContext): Promise<void>
  listAccounts(ctx: ConnectionContext): Promise<ProviderAccount[]>
  getBalance(ctx: ConnectionContext, externalId: string): Promise<BalanceSnapshot>
}
```

- [ ] **Step 2: Test del registry (falla)**

`tests/unit/services/financial-connections/registry.test.ts`:
```typescript
import { getFinancialProviderClient } from '@/services/financial-connections/registry'

describe('financial provider registry', () => {
  it('resolves EXTERNAL_BANK to a client with the full interface', () => {
    const c = getFinancialProviderClient('EXTERNAL_BANK')
    expect(c).toBeDefined()
    for (const m of ['connect', 'validateDevice', 'refresh', 'revoke', 'listAccounts', 'getBalance']) {
      expect(typeof (c as any)[m]).toBe('function')
    }
  })
  it('returns undefined for unknown codes', () => {
    expect(getFinancialProviderClient('NOPE')).toBeUndefined()
  })
})
```

- [ ] **Step 3: Correr → falla** (`registry`/`externalBank.client` no existen aún). Expected: FAIL.

- [ ] **Step 4: Implementar el registry** (el cliente concreto llega en Task 4; import adelantado)

`src/services/financial-connections/registry.ts`:
```typescript
import type { FinancialProviderClient } from './types'
import { externalBankClient } from './externalBank.client'

export const FINANCIAL_PROVIDER_CLIENTS: Record<string, FinancialProviderClient> = {
  EXTERNAL_BANK: externalBankClient,
}

export function getFinancialProviderClient(code: string): FinancialProviderClient | undefined {
  return FINANCIAL_PROVIDER_CLIENTS[code]
}
```
(El test pasará al terminar Task 4. Dejar el test escrito; correrlo al final de Task 4.)

- [ ] **Step 5: Commit**

```bash
git add src/services/financial-connections/types.ts src/services/financial-connections/registry.ts tests/unit/services/financial-connections/registry.test.ts
git commit -m "feat(financial-connections): provider client contract + registry"
```

---

### Task 4: Cliente externalBank (implementa el contrato contra QPay)

**Files:**
- Create: `src/services/financial-connections/externalBank.client.ts`
- Test: `tests/unit/services/financial-connections/externalBank.client.test.ts`
- Reference: `src/services/externalBank/pick.ts` (reusar `pick`), `src/config/env.ts` (`EXTERNAL_BANK_API_BASE`, `EXTERNAL_BANK_MG_PLATFORM`)

**Interfaces:**
- Consumes: `FinancialProviderClient`, `Grant`, `ConnectResult`, `ProviderAccount`, `BalanceSnapshot`, `ConnectInput` (Task 3); `pick` (existente).
- Produces: `externalBankClient: FinancialProviderClient`. Lo usa el registry (Task 3) y el servicio (Task 5).

Contrato del proveedor (validado en prod):
- `POST /api/auth/sign-in/merchant` body `{ email, password, dispositivo }`, header `twoFactorEnabled:'true'` → `{ signedIn, token, refreshToken, expiresIn, needDeviceValidation? }`.
- `POST /api/identity/start/web` `{ identificadorDispositivo }` (Bearer) → `{ proccessId, needValidateOtp }`.
- `POST /api/identity/validate-otp-code/web` `{ proccessId, code }` (Bearer) → `{ isValid }`.
- `POST /api/auth/sign-in/token` `{ refreshToken, dispositivo }` → `{ signedIn, token, refreshToken, expiresIn }` (silent re-login).
- `GET /api/auth` (Bearer) → `{ negocios: [{ idNegocio, nombre, cuentaDispersion: { cuentaClabe, saldo, activo } }] }`.

- [ ] **Step 1: Escribir los tests (fallan)**

`tests/unit/services/financial-connections/externalBank.client.test.ts`:
```typescript
import nock from 'nock'

const BASE = 'https://external-bank-test.example.com'
const DEVICE = 'avoqado-conn-test-1'

function setEnv() {
  process.env.EXTERNAL_BANK_API_BASE = BASE
  process.env.EXTERNAL_BANK_MG_PLATFORM = 'MERCHANT'
}
async function loadClient() {
  jest.resetModules()
  setEnv()
  return (await import('@/services/financial-connections/externalBank.client')).externalBankClient
}

beforeAll(() => nock.disableNetConnect())
afterAll(() => { nock.cleanAll(); nock.enableNetConnect() })
afterEach(() => nock.cleanAll())

const NEGOCIOS = {
  negocios: [
    { idNegocio: 'neg-1', nombre: 'Sucursal Centro', cuentaDispersion: { cuentaClabe: '0123', saldo: 1500.5, activo: true } },
    { idNegocio: 'neg-2', nombre: 'Sucursal Norte', cuentaDispersion: { cuentaClabe: '0987', saldo: 0, activo: false } },
  ],
}

it('connect: device already trusted → returns grant + accounts', async () => {
  nock(BASE).post('/api/auth/sign-in/merchant').reply(200, {
    signedIn: true, token: 'acc-1', refreshToken: 'ref-1',
    expiresIn: new Date(Date.now() + 3600e3).toISOString(),
  })
  nock(BASE).get('/api/auth').reply(200, NEGOCIOS)
  const client = await loadClient()
  const r = await client.connect({ email: 'a@b.co', password: 'p', deviceIdentifier: DEVICE })
  expect(r.kind).toBe('connected')
  if (r.kind === 'connected') {
    expect(r.grant.refreshToken).toBe('ref-1')
    expect(r.accounts.map(a => a.externalId)).toEqual(['neg-1', 'neg-2'])
    expect(r.accounts[0]).toMatchObject({ label: 'Sucursal Centro', balance: 1500.5, active: true, clabe: '0123' })
  }
})

it('connect: needDeviceValidation → starts identity + returns challenge', async () => {
  nock(BASE).post('/api/auth/sign-in/merchant').reply(200, { needDeviceValidation: true, token: 'tmp-tok' })
  nock(BASE).post('/api/identity/start/web').reply(200, { proccessId: 'proc-9', needValidateOtp: true })
  const client = await loadClient()
  const r = await client.connect({ email: 'a@b.co', password: 'p', deviceIdentifier: DEVICE })
  expect(r.kind).toBe('need_device_validation')
  if (r.kind === 'need_device_validation') {
    expect(r.challenge).toEqual({ accessToken: 'tmp-tok', processId: 'proc-9' })
  }
})

it('validateDevice: valid OTP → re-signs in and returns grant', async () => {
  nock(BASE).post('/api/identity/validate-otp-code/web').reply(200, { isValid: true })
  nock(BASE).post('/api/auth/sign-in/merchant').reply(200, {
    signedIn: true, token: 'acc-2', refreshToken: 'ref-2',
    expiresIn: new Date(Date.now() + 3600e3).toISOString(),
  })
  nock(BASE).get('/api/auth').reply(200, NEGOCIOS)
  const client = await loadClient()
  const r = await client.validateDevice({
    email: 'a@b.co', password: 'p', deviceIdentifier: DEVICE,
    challenge: { accessToken: 'tmp-tok', processId: 'proc-9' }, code: '123456',
  })
  expect(r.kind).toBe('connected')
  if (r.kind === 'connected') expect(r.grant.refreshToken).toBe('ref-2')
})

it('validateDevice: invalid OTP → throws', async () => {
  nock(BASE).post('/api/identity/validate-otp-code/web').reply(200, { isValid: false })
  const client = await loadClient()
  await expect(client.validateDevice({
    email: 'a@b.co', password: 'p', deviceIdentifier: DEVICE,
    challenge: { accessToken: 'tmp-tok', processId: 'proc-9' }, code: '000000',
  })).rejects.toThrow(/OTP|código|inválid/i)
})

it('refresh: silent re-login returns a new (rotated) grant', async () => {
  nock(BASE).post('/api/auth/sign-in/token').reply(200, {
    signedIn: true, token: 'acc-3', refreshToken: 'ref-3-rotated',
    expiresIn: new Date(Date.now() + 3600e3).toISOString(),
  })
  const client = await loadClient()
  const { grant, ctx } = await client.refresh({ refreshToken: 'ref-2' }, DEVICE)
  expect(grant.refreshToken).toBe('ref-3-rotated')
  expect(ctx.accessToken).toBe('acc-3')
})

it('getBalance: maps saldo/activo, and a null saldo stays null (state decided upstream)', async () => {
  nock(BASE).get('/api/auth').reply(200, NEGOCIOS)
  const client = await loadClient()
  const b = await client.getBalance({ accessToken: 'acc-x' }, 'neg-2')
  expect(b).toMatchObject({ amount: 0, currency: 'MXN', active: false })
})

it('getBalance: unknown negocio → throws NotFound', async () => {
  nock(BASE).get('/api/auth').reply(200, NEGOCIOS)
  const client = await loadClient()
  await expect(client.getBalance({ accessToken: 'acc-x' }, 'nope')).rejects.toThrow()
})
```

- [ ] **Step 2: Correr → falla.** Run: `npx jest tests/unit/services/financial-connections/externalBank.client.test.ts` → FAIL (no existe).

- [ ] **Step 3: Implementar el cliente**

`src/services/financial-connections/externalBank.client.ts`:
```typescript
import axios from 'axios'
import { env } from '@/config/env'
import { BadRequestError, NotFoundError } from '@/errors/AppError'
import { pick } from '@/services/externalBank/pick'
import type {
  FinancialProviderClient, ConnectInput, ConnectResult, Grant, ProviderAccount,
  BalanceSnapshot, ConnectionContext,
} from './types'

const base = () => env.EXTERNAL_BANK_API_BASE
const headers = (token?: string) => ({
  'Content-Type': 'application/json',
  mgPlatform: env.EXTERNAL_BANK_MG_PLATFORM,
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
})
const dispositivo = (deviceIdentifier: string) => ({
  marca: 'avoqado-server', sistemaOperativo: `node-${process.version}`,
  identificador: deviceIdentifier, latitud: '0', longitud: '0',
})

function toGrant(data: unknown): Grant {
  const refreshToken = pick<string>(data, 'refreshToken')
  if (!refreshToken) throw new BadRequestError('El proveedor no devolvió refreshToken.')
  return { refreshToken, expiresAt: pick<string>(data, 'expiresIn') ?? null }
}
function accessTokenOf(data: unknown): string {
  const t = pick<string>(data, 'token')
  if (!t) throw new BadRequestError('El proveedor no devolvió token de acceso.')
  return t
}
function normalizeAccounts(me: unknown): ProviderAccount[] {
  const negocios = pick<unknown[]>(me, 'negocios')
  if (!Array.isArray(negocios)) return []
  return negocios
    .map((n): ProviderAccount | null => {
      const externalId = pick<string>(n, 'idNegocio')
      if (!externalId) return null
      const cuenta = pick(n, 'cuentaDispersion')
      const saldo = pick(cuenta, 'saldo')
      return {
        externalId,
        label: pick<string>(n, 'nombre') ?? null,
        clabe: pick<string>(cuenta, 'cuentaClabe') ?? null,
        active: typeof pick(cuenta, 'activo') === 'boolean' ? (pick<boolean>(cuenta, 'activo') as boolean) : null,
        balance: typeof saldo === 'number' ? (saldo as number) : null,
      }
    })
    .filter((a): a is ProviderAccount => a !== null)
}
async function fetchMe(token: string): Promise<unknown> {
  const { data } = await axios.get(`${base()}/api/auth`, { headers: headers(token), timeout: 20_000 })
  return data
}
async function signIn(email: string, password: string, deviceIdentifier: string): Promise<unknown> {
  try {
    const { data } = await axios.post(`${base()}/api/auth/sign-in/merchant`,
      { email, password, dispositivo: dispositivo(deviceIdentifier) },
      { headers: { ...headers(), twoFactorEnabled: 'true' }, timeout: 20_000 })
    return data
  } catch (e) {
    if (axios.isAxiosError(e)) throw new BadRequestError(pick<string>(e.response?.data, 'message') || `sign-in falló (status ${e.response?.status})`)
    throw e
  }
}

export const externalBankClient: FinancialProviderClient = {
  async connect({ email, password, deviceIdentifier }: ConnectInput): Promise<ConnectResult> {
    const data = await signIn(email, password, deviceIdentifier)
    if (pick<boolean>(data, 'needDeviceValidation')) {
      const accessToken = accessTokenOf(data)
      const { data: started } = await axios.post(`${base()}/api/identity/start/web`,
        { identificadorDispositivo: deviceIdentifier }, { headers: headers(accessToken), timeout: 20_000 })
      const processId = pick<string>(started, 'proccessId')
      if (!processId) throw new BadRequestError('identity/start no devolvió proccessId.')
      return { kind: 'need_device_validation', challenge: { accessToken, processId } }
    }
    const grant = toGrant(data)
    const accounts = normalizeAccounts(await fetchMe(accessTokenOf(data)))
    return { kind: 'connected', grant, accounts }
  },

  async validateDevice({ email, password, deviceIdentifier, challenge, code }): Promise<ConnectResult> {
    const { data: v } = await axios.post(`${base()}/api/identity/validate-otp-code/web`,
      { proccessId: challenge.processId, code }, { headers: headers(challenge.accessToken), timeout: 20_000 })
    if (!pick<boolean>(v, 'isValid')) throw new BadRequestError('Código OTP inválido o expirado.')
    // Dispositivo ya confiable → re-login para obtener refreshToken definitivo.
    const data = await signIn(email, password, deviceIdentifier)
    const grant = toGrant(data)
    const accounts = normalizeAccounts(await fetchMe(accessTokenOf(data)))
    return { kind: 'connected', grant, accounts }
  },

  async refresh(grant: Grant, deviceIdentifier: string): Promise<{ grant: Grant; ctx: ConnectionContext }> {
    const { data } = await axios.post(`${base()}/api/auth/sign-in/token`,
      { refreshToken: grant.refreshToken, dispositivo: dispositivo(deviceIdentifier) },
      { headers: headers(), timeout: 20_000 })
    return { grant: toGrant(data), ctx: { accessToken: accessTokenOf(data) } }
  },

  async revoke(ctx: ConnectionContext): Promise<void> {
    try { await axios.post(`${base()}/api/auth/Log-Out`, {}, { headers: headers(ctx.accessToken), timeout: 10_000 }) }
    catch { /* best-effort; no bloquear la desconexión local */ }
  },

  async listAccounts(ctx: ConnectionContext): Promise<ProviderAccount[]> {
    return normalizeAccounts(await fetchMe(ctx.accessToken))
  },

  async getBalance(ctx: ConnectionContext, externalId: string): Promise<BalanceSnapshot> {
    const acc = normalizeAccounts(await fetchMe(ctx.accessToken)).find(a => a.externalId === externalId)
    if (!acc) throw new NotFoundError(`No se encontró el negocio ${externalId} en la cuenta.`)
    return { amount: acc.balance, currency: 'MXN', active: acc.active, providerAccountLabel: acc.label }
  },
}
```

- [ ] **Step 4: Correr los tests del cliente + del registry → pasan**

Run: `npx jest tests/unit/services/financial-connections/externalBank.client.test.ts tests/unit/services/financial-connections/registry.test.ts`
Expected: PASS (todos).

- [ ] **Step 5: Commit**

```bash
git add src/services/financial-connections/externalBank.client.ts tests/unit/services/financial-connections/externalBank.client.test.ts
git commit -m "feat(financial-connections): external bank client (connect/device/refresh/balance) against QPay"
```

---

### Task 5: Servicio de orquestación (crear/conectar, validar, seleccionar, saldo con lock, desconectar)

**Files:**
- Create: `src/services/financial-connections/financialConnection.service.ts`
- Test: `tests/unit/services/financial-connections/financialConnection.service.test.ts`
- Reference: `src/utils/prismaClient.ts` (default export `prisma`), `src/services/dashboard/activity-log.service.ts` (`logAction`)

**Interfaces:**
- Consumes: registry (Task 3), crypto (Task 2), client contract (Task 3).
- Produces (funciones que usa el controlador, Task 6):
  - `startConnection(input: { venueId: string; providerId: string; email: string; password: string; staffId?: string }): Promise<{ connectionId: string; status: FinancialConnectionStatus; accountOptions?: ProviderAccount[] }>`
  - `validateDevice(connectionId: string, code: string): Promise<{ status; accountOptions? }>`
  - `selectAccount(connectionId: string, externalId: string, merchantAccountId?: string): Promise<{ status }>`
  - `getBalanceForConnectionAccount(financialAccountId: string): Promise<{ amount: number | null; currency: string; syncedAt: string | null; state: 'OK'|'ERROR'|'UNKNOWN' }>`
  - `listConnectionsForVenue(venueId: string): Promise<…>`
  - `disconnect(connectionId: string, staffId?: string): Promise<void>`
  - `getBalanceForMerchant(merchantAccountId: string): Promise<Balance>` (para superadmin, Task 7)

- [ ] **Step 1: Tests (fallan) — cubrir: connect directo, device, refresh serializado (CAS), balance-state ERROR en saldo null, disconnect**

`tests/unit/services/financial-connections/financialConnection.service.test.ts` (usar mocks del registry + prisma; patrón `jest.mock`):
```typescript
const clientMock = {
  connect: jest.fn(), validateDevice: jest.fn(), refresh: jest.fn(),
  revoke: jest.fn(), listAccounts: jest.fn(), getBalance: jest.fn(),
}
jest.mock('@/services/financial-connections/registry', () => ({
  getFinancialProviderClient: () => clientMock,
}))
// prisma mock mínimo (financialConnection/financialAccount/$transaction/$executeRaw)
const db: any = {}
jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: db }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import * as svc from '@/services/financial-connections/financialConnection.service'

beforeEach(() => {
  jest.clearAllMocks()
  db.financialProvider = { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'prov-1', code: 'EXTERNAL_BANK' }) }
  db.financialConnection = { create: jest.fn(), update: jest.fn(), findUniqueOrThrow: jest.fn(), findUnique: jest.fn(), findMany: jest.fn() }
  db.financialAccount = { createMany: jest.fn(), findUniqueOrThrow: jest.fn(), findFirst: jest.fn(), update: jest.fn() }
  db.$transaction = jest.fn(async (fn: any) => fn(db))
  db.$executeRaw = jest.fn()
})

it('startConnection: single negocio → auto-selects, CONNECTED', async () => {
  db.financialConnection.create.mockResolvedValue({ id: 'c1', deviceIdentifier: 'dev-c1' })
  clientMock.connect.mockResolvedValue({ kind: 'connected', grant: { refreshToken: 'r1' },
    accounts: [{ externalId: 'neg-1', label: 'Centro', clabe: '01', active: true, balance: 100 }] })
  const r = await svc.startConnection({ venueId: 'v1', providerId: 'prov-1', email: 'a@b.co', password: 'p' })
  expect(r.status).toBe('CONNECTED')
  expect(db.financialAccount.createMany).toHaveBeenCalled()
})

it('startConnection: several negocios → PENDING_ACCOUNT_SELECTION with options', async () => {
  db.financialConnection.create.mockResolvedValue({ id: 'c2', deviceIdentifier: 'dev-c2' })
  clientMock.connect.mockResolvedValue({ kind: 'connected', grant: { refreshToken: 'r' },
    accounts: [{ externalId: 'neg-1' }, { externalId: 'neg-2' }] })
  const r = await svc.startConnection({ venueId: 'v1', providerId: 'prov-1', email: 'a@b.co', password: 'p' })
  expect(r.status).toBe('PENDING_ACCOUNT_SELECTION')
  expect(r.accountOptions?.length).toBe(2)
})

it('startConnection: needDeviceValidation → stores challenge, PENDING_DEVICE_VALIDATION', async () => {
  db.financialConnection.create.mockResolvedValue({ id: 'c3', deviceIdentifier: 'dev-c3' })
  clientMock.connect.mockResolvedValue({ kind: 'need_device_validation', challenge: { accessToken: 't', processId: 'p9' } })
  const r = await svc.startConnection({ venueId: 'v1', providerId: 'prov-1', email: 'a@b.co', password: 'p' })
  expect(r.status).toBe('PENDING_DEVICE_VALIDATION')
  const upd = db.financialConnection.update.mock.calls.at(-1)[0].data
  expect(upd.challengeEnc).toBeTruthy()
  expect(JSON.stringify(upd)).not.toContain('p9') // el processId va cifrado, no en claro
})

it('selectAccount: rejects an externalId not in the stored options', async () => {
  db.financialConnection.findUniqueOrThrow.mockResolvedValue({
    id: 'c2', status: 'PENDING_ACCOUNT_SELECTION',
    accounts: [{ id: 'fa1', externalId: 'neg-1' }, { id: 'fa2', externalId: 'neg-2' }],
  })
  await expect(svc.selectAccount('c2', 'neg-999')).rejects.toThrow()
})

it('getBalanceForConnectionAccount: provider null saldo → state ERROR, not OK', async () => {
  db.financialAccount.findUniqueOrThrow.mockResolvedValue({
    id: 'fa1', externalId: 'neg-1',
    connection: { id: 'c1', mode: 'SELF_CONNECT', grantEnc: encFixture(), tokenVersion: 0, deviceIdentifier: 'dev', provider: { code: 'EXTERNAL_BANK' } },
  })
  clientMock.refresh.mockResolvedValue({ grant: { refreshToken: 'r2' }, ctx: { accessToken: 'acc' } })
  clientMock.getBalance.mockResolvedValue({ amount: null, currency: 'MXN', active: true, providerAccountLabel: 'X' })
  const r = await svc.getBalanceForConnectionAccount('fa1')
  expect(r.state).toBe('ERROR')
  expect(r.amount).toBeNull()
})

it('refresh path takes the advisory lock (pg_advisory_xact_lock) inside a tx', async () => {
  db.financialAccount.findUniqueOrThrow.mockResolvedValue({
    id: 'fa1', externalId: 'neg-1',
    connection: { id: 'c1', mode: 'SELF_CONNECT', grantEnc: encFixture(), tokenVersion: 0, deviceIdentifier: 'dev', provider: { code: 'EXTERNAL_BANK' } },
  })
  clientMock.refresh.mockResolvedValue({ grant: { refreshToken: 'r2' }, ctx: { accessToken: 'acc' } })
  clientMock.getBalance.mockResolvedValue({ amount: 10, currency: 'MXN', active: true, providerAccountLabel: 'X' })
  await svc.getBalanceForConnectionAccount('fa1')
  expect(db.$transaction).toHaveBeenCalled()
  expect(db.$executeRaw).toHaveBeenCalled() // pg_advisory_xact_lock(...)
})
```
> `encFixture()` helper: `import { encryptGrant } from '@/services/financial-connections/crypto'` con `process.env.FINANCIAL_CONNECTION_KEY='a'.repeat(64)` en `beforeAll`, luego `const encFixture = () => encryptGrant({ refreshToken: 'r1' })`.

- [ ] **Step 2: Correr → falla.** Expected: FAIL (servicio no existe).

- [ ] **Step 3: Implementar el servicio**

`src/services/financial-connections/financialConnection.service.ts`:
```typescript
import prisma from '@/utils/prismaClient'
import { BadRequestError, NotFoundError } from '@/errors/AppError'
import { logAction } from '@/services/dashboard/activity-log.service'
import { getFinancialProviderClient } from './registry'
import { encryptGrant, decryptGrant } from './crypto'
import type { Grant, ProviderAccount } from './types'

const CHALLENGE_TTL_MS = 5 * 60_000
// Cache en memoria del access token por conexión (fast-path; evita re-login por lectura).
const tokenCache = new Map<string, { accessToken: string; exp: number }>()

function stableDeviceId(connectionId: string) {
  return `avoqado-conn-${connectionId}`
}
function clientFor(code: string) {
  const c = getFinancialProviderClient(code)
  if (!c) throw new BadRequestError(`Proveedor ${code} sin implementación.`)
  return c
}
async function persistAccounts(connectionId: string, accounts: ProviderAccount[]) {
  if (!accounts.length) return
  await prisma.financialAccount.createMany({
    data: accounts.map(a => ({
      connectionId, externalId: a.externalId, label: a.label ?? null,
      clabe: a.clabe ?? null, active: a.active ?? null,
      lastBalance: a.balance ?? null,
      lastSyncedAt: a.balance != null ? new Date() : null,
      balanceState: a.balance != null ? 'OK' : 'UNKNOWN',
    })),
    skipDuplicates: true,
  })
}

export async function startConnection(input: {
  venueId: string; providerId: string; email: string; password: string; staffId?: string
}) {
  const provider = await prisma.financialProvider.findUniqueOrThrow({ where: { id: input.providerId } })
  const conn = await prisma.financialConnection.create({
    data: {
      venueId: input.venueId, providerId: provider.id, mode: 'SELF_CONNECT',
      status: 'PENDING_DEVICE_VALIDATION', createdByStaffId: input.staffId ?? null,
    },
  })
  const deviceIdentifier = stableDeviceId(conn.id)
  const client = clientFor(provider.code)
  const r = await client.connect({ email: input.email, password: input.password, deviceIdentifier })

  if (r.kind === 'need_device_validation') {
    await prisma.financialConnection.update({
      where: { id: conn.id },
      data: {
        deviceIdentifier,
        challengeEnc: encryptGrant({ ...r.challenge, email: input.email, password: input.password }),
        challengeExpiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
        status: 'PENDING_DEVICE_VALIDATION',
      },
    })
    return { connectionId: conn.id, status: 'PENDING_DEVICE_VALIDATION' as const }
  }
  return finishConnected(conn.id, deviceIdentifier, r.grant, r.accounts)
}

export async function validateDevice(connectionId: string, code: string) {
  const conn = await prisma.financialConnection.findUniqueOrThrow({ where: { id: connectionId }, include: { provider: true } })
  if (!conn.challengeEnc || !conn.challengeExpiresAt || conn.challengeExpiresAt < new Date()) {
    throw new BadRequestError('El reto de validación expiró; vuelve a iniciar la conexión.')
  }
  const ch = decryptGrant<{ accessToken: string; processId: string; email: string; password: string }>(conn.challengeEnc)
  const client = clientFor(conn.provider.code)
  const r = await client.validateDevice({
    email: ch.email, password: ch.password, deviceIdentifier: conn.deviceIdentifier!,
    challenge: { accessToken: ch.accessToken, processId: ch.processId }, code,
  })
  if (r.kind !== 'connected') throw new BadRequestError('Validación incompleta.')
  await prisma.financialConnection.update({ where: { id: connectionId }, data: { challengeEnc: null, challengeExpiresAt: null } })
  return finishConnected(connectionId, conn.deviceIdentifier!, r.grant, r.accounts)
}

async function finishConnected(connectionId: string, deviceIdentifier: string, grant: Grant, accounts: ProviderAccount[]) {
  await persistAccounts(connectionId, accounts)
  const many = accounts.length > 1
  await prisma.financialConnection.update({
    where: { id: connectionId },
    data: {
      deviceIdentifier, grantEnc: encryptGrant(grant),
      expiresAt: grant.expiresAt ? new Date(grant.expiresAt) : null,
      connectedAt: new Date(),
      status: many ? 'PENDING_ACCOUNT_SELECTION' : 'CONNECTED',
    },
  })
  const accountOptions = many ? accounts : undefined
  return { connectionId, status: (many ? 'PENDING_ACCOUNT_SELECTION' : 'CONNECTED') as const, accountOptions }
}

export async function selectAccount(connectionId: string, externalId: string, merchantAccountId?: string) {
  const conn = await prisma.financialConnection.findUniqueOrThrow({ where: { id: connectionId }, include: { accounts: true } })
  const chosen = conn.accounts.find(a => a.externalId === externalId)
  if (!chosen) throw new BadRequestError(`La cuenta ${externalId} no está entre las opciones guardadas.`)
  if (merchantAccountId) {
    await prisma.merchantAccount.update({ where: { id: merchantAccountId }, data: { financialAccountId: chosen.id } })
  }
  await prisma.financialConnection.update({ where: { id: connectionId }, data: { status: 'CONNECTED' } })
  return { status: 'CONNECTED' as const }
}

/** Devuelve un access token válido, refrescando bajo lock si hace falta (el refreshToken rota). */
async function accessTokenFor(conn: { id: string; mode: string; grantEnc: string | null; deviceIdentifier: string | null; provider: { code: string } }): Promise<string> {
  const cached = tokenCache.get(conn.id)
  if (cached && cached.exp - 60_000 > Date.now()) return cached.accessToken
  if (conn.mode !== 'SELF_CONNECT' || !conn.grantEnc) throw new BadRequestError('Conexión sin grant utilizable.')
  const client = clientFor(conn.provider.code)

  return prisma.$transaction(async tx => {
    // Serializa el refresh entre instancias: solo uno refresca a la vez esta conexión.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${conn.id}))`
    const fresh = await tx.financialConnection.findUniqueOrThrow({ where: { id: conn.id } })
    // Otro proceso pudo haber refrescado mientras esperábamos el lock.
    const recheck = tokenCache.get(conn.id)
    if (recheck && recheck.exp - 60_000 > Date.now()) return recheck.accessToken
    const grant = decryptGrant<Grant>(fresh.grantEnc!)
    const { grant: rotated, ctx } = await client.refresh(grant, conn.deviceIdentifier ?? stableDeviceId(conn.id))
    await tx.financialConnection.update({
      where: { id: conn.id, tokenVersion: fresh.tokenVersion },
      data: { grantEnc: encryptGrant(rotated), tokenVersion: { increment: 1 },
        expiresAt: rotated.expiresAt ? new Date(rotated.expiresAt) : null, status: 'CONNECTED', lastError: null },
    })
    const exp = rotated.expiresAt ? new Date(rotated.expiresAt).getTime() : Date.now() + 55 * 60_000
    tokenCache.set(conn.id, { accessToken: ctx.accessToken, exp })
    return ctx.accessToken
  })
}

export async function getBalanceForConnectionAccount(financialAccountId: string) {
  const fa = await prisma.financialAccount.findUniqueOrThrow({
    where: { id: financialAccountId }, include: { connection: { include: { provider: true } } },
  })
  const client = clientFor(fa.connection.provider.code)
  try {
    const token = await accessTokenFor(fa.connection)
    const snap = await client.getBalance({ accessToken: token }, fa.externalId)
    const state = snap.amount != null ? 'OK' : 'ERROR'   // saldo null del proveedor NO es OK
    const now = new Date()
    await prisma.financialAccount.update({
      where: { id: fa.id },
      data: { lastBalance: snap.amount ?? null, active: snap.active ?? null,
        lastSyncedAt: state === 'OK' ? now : fa.lastSyncedAt,
        balanceState: state, lastError: state === 'OK' ? null : 'saldo nulo del proveedor' },
    })
    return { amount: snap.amount, currency: snap.currency,
      syncedAt: (state === 'OK' ? now : fa.lastSyncedAt)?.toISOString() ?? null, state: state as 'OK' | 'ERROR' }
  } catch (e) {
    tokenCache.delete(fa.connection.id)
    await prisma.financialConnection.update({ where: { id: fa.connection.id }, data: { status: 'NEEDS_REAUTH', lastError: (e as Error).message } }).catch(() => {})
    await prisma.financialAccount.update({ where: { id: fa.id }, data: { balanceState: 'ERROR', lastError: (e as Error).message } }).catch(() => {})
    return { amount: null, currency: fa.currency, syncedAt: fa.lastSyncedAt?.toISOString() ?? null, state: 'ERROR' as const }
  }
}

export async function getBalanceForMerchant(merchantAccountId: string) {
  const m = await prisma.merchantAccount.findUniqueOrThrow({ where: { id: merchantAccountId }, select: { financialAccountId: true } })
  if (!m.financialAccountId) throw new BadRequestError('Este merchant no tiene una cuenta bancaria conectada.')
  return getBalanceForConnectionAccount(m.financialAccountId)
}

export async function listConnectionsForVenue(venueId: string) {
  return prisma.financialConnection.findMany({
    where: { venueId },
    select: {
      id: true, status: true, mode: true, lastError: true,
      provider: { select: { code: true, name: true } },
      accounts: { select: { id: true, externalId: true, label: true, clabe: true, currency: true,
        lastBalance: true, lastSyncedAt: true, balanceState: true, merchantAccounts: { select: { id: true } } } },
    },
    orderBy: { createdAt: 'desc' },
  })
}

export async function disconnect(connectionId: string, staffId?: string) {
  const conn = await prisma.financialConnection.findUniqueOrThrow({ where: { id: connectionId }, include: { provider: true } })
  if (conn.mode === 'SELF_CONNECT' && conn.grantEnc) {
    try {
      const client = clientFor(conn.provider.code)
      const token = tokenCache.get(conn.id)?.accessToken ?? (await accessTokenFor(conn))
      await client.revoke({ accessToken: token })
    } catch { /* best-effort */ }
  }
  tokenCache.delete(conn.id)
  await prisma.financialConnection.update({
    where: { id: conn.id },
    data: { status: 'REVOKED', grantEnc: null, challengeEnc: null, revokedAt: new Date() },
  })
  await logAction({ staffId: staffId ?? null, venueId: conn.venueId, action: 'FINANCIAL_CONNECTION_DISCONNECTED',
    entity: 'FinancialConnection', entityId: conn.id, data: { provider: conn.provider.code } })
}
```

- [ ] **Step 4: Correr los tests → pasan.** Run: `npx jest tests/unit/services/financial-connections/financialConnection.service.test.ts` → PASS. Ajustar mocks/firmas si algún assert falla.

- [ ] **Step 5: Commit**

```bash
git add src/services/financial-connections/financialConnection.service.ts tests/unit/services/financial-connections/financialConnection.service.test.ts
git commit -m "feat(financial-connections): orchestration service (connect/device/select/balance w/ advisory-lock refresh/disconnect)"
```

---

### Task 6: Endpoints REST (catálogo + conexiones por sucursal)

**Files:**
- Create: `src/controllers/dashboard/financialConnection.controller.ts`
- Create: `src/routes/dashboard/financialConnection.routes.ts`
- Modify: `src/routes/dashboard.routes.ts` (mount)
- Test: `tests/unit/controllers/financialConnection.controller.test.ts` (opcional light) — o cubrir vía el servicio ya testeado

**Interfaces:**
- Consumes: el servicio (Task 5).
- Produces: rutas `GET /financial-providers`, `GET|POST /venues/:venueId/financial-connections`, `POST /financial-connections/:id/validate-device`, `POST /financial-connections/:id/select-account`, `GET /financial-accounts/:id/balance`, `DELETE /financial-connections/:id`.

- [ ] **Step 1: Controlador**

`src/controllers/dashboard/financialConnection.controller.ts`:
```typescript
import { Request, Response, NextFunction } from 'express'
import prisma from '@/utils/prismaClient'
import * as svc from '@/services/financial-connections/financialConnection.service'
import { BadRequestError } from '@/errors/AppError'

export async function listProviders(_req: Request, res: Response, next: NextFunction) {
  try {
    const data = await prisma.financialProvider.findMany({ where: { active: true }, orderBy: { name: 'asc' } })
    res.json({ success: true, data })
  } catch (e) { next(e) }
}
export async function listConnections(req: Request, res: Response, next: NextFunction) {
  try { res.json({ success: true, data: await svc.listConnectionsForVenue(req.params.venueId) }) } catch (e) { next(e) }
}
export async function createConnection(req: Request, res: Response, next: NextFunction) {
  try {
    const { providerId, email, password } = req.body ?? {}
    if (!providerId || !email || !password) throw new BadRequestError('providerId, email y password son requeridos.')
    const staffId = (req as any).authContext?.userId
    const r = await svc.startConnection({ venueId: req.params.venueId, providerId, email, password, staffId })
    res.status(201).json({ success: true, data: r })
  } catch (e) { next(e) }
}
export async function validateDevice(req: Request, res: Response, next: NextFunction) {
  try {
    const { code } = req.body ?? {}
    if (!code) throw new BadRequestError('code es requerido.')
    res.json({ success: true, data: await svc.validateDevice(req.params.id, String(code)) })
  } catch (e) { next(e) }
}
export async function selectAccount(req: Request, res: Response, next: NextFunction) {
  try {
    const { externalId, merchantAccountId } = req.body ?? {}
    if (!externalId) throw new BadRequestError('externalId es requerido.')
    res.json({ success: true, data: await svc.selectAccount(req.params.id, String(externalId), merchantAccountId) })
  } catch (e) { next(e) }
}
export async function getBalance(req: Request, res: Response, next: NextFunction) {
  try { res.json({ success: true, data: await svc.getBalanceForConnectionAccount(req.params.id) }) } catch (e) { next(e) }
}
export async function disconnect(req: Request, res: Response, next: NextFunction) {
  try {
    await svc.disconnect(req.params.id, (req as any).authContext?.userId)
    res.json({ success: true })
  } catch (e) { next(e) }
}
```

- [ ] **Step 2: Rutas**

`src/routes/dashboard/financialConnection.routes.ts`:
```typescript
import { Router } from 'express'
import { checkOwnerAccess } from '@/middlewares/checkOwnerAccess.middleware'
import * as ctrl from '@/controllers/dashboard/financialConnection.controller'

// venue-scoped (montado bajo /venues/:venueId/…). mergeParams hereda :venueId.
export const venueFinancialConnectionRoutes = Router({ mergeParams: true })
venueFinancialConnectionRoutes.get('/', checkOwnerAccess, ctrl.listConnections)
venueFinancialConnectionRoutes.post('/', checkOwnerAccess, ctrl.createConnection)

// no venue-scoped (por id de conexión / cuenta).
export const financialConnectionRoutes = Router()
financialConnectionRoutes.post('/financial-connections/:id/validate-device', checkOwnerAccess, ctrl.validateDevice)
financialConnectionRoutes.post('/financial-connections/:id/select-account', checkOwnerAccess, ctrl.selectAccount)
financialConnectionRoutes.delete('/financial-connections/:id', checkOwnerAccess, ctrl.disconnect)
financialConnectionRoutes.get('/financial-accounts/:id/balance', checkOwnerAccess, ctrl.getBalance)
financialConnectionRoutes.get('/financial-providers', ctrl.listProviders)
```
> Nota: `checkOwnerAccess` valida OWNER/SUPERADMIN a nivel org. Los endpoints por `:id` (no scoped por venue) confían en ese gate; si se requiere aislar por venue del owner de esa conexión, agregar una verificación en el servicio (fuera de alcance del v1).

- [ ] **Step 3: Montar en el router de dashboard**

En `src/routes/dashboard.routes.ts`, junto a los otros `router.use('/venues/:venueId/…')` (ej. cerca de `ecommerce-merchants`, ~línea 3931) agregar:
```typescript
import { venueFinancialConnectionRoutes, financialConnectionRoutes } from './dashboard/financialConnection.routes'
// …
router.use('/venues/:venueId/financial-connections', authenticateTokenMiddleware, venueFinancialConnectionRoutes)
router.use('/', authenticateTokenMiddleware, financialConnectionRoutes)
```
(Usar el mismo identificador de middleware de auth que ya usan las rutas vecinas — `authenticateTokenMiddleware`.)

- [ ] **Step 4: Typecheck + smoke de rutas**

Run: `npm run typecheck` → sin errores en los archivos nuevos.
Run (con server levantado en dev): `curl -s -H "Authorization: Bearer <token-dev>" localhost:3000/api/v1/dashboard/financial-providers | jq` → `{ success:true, data:[{code:"EXTERNAL_BANK",…}] }` (tras el seed de Task 7).

- [ ] **Step 5: Commit**

```bash
git add src/controllers/dashboard/financialConnection.controller.ts src/routes/dashboard/financialConnection.routes.ts src/routes/dashboard.routes.ts
git commit -m "feat(financial-connections): REST endpoints (providers catalog + venue-scoped connections)"
```

---

### Task 7: Reapuntar superadmin/aggregator al modelo nuevo + seed + smoke script

**Files:**
- Modify: `src/services/superadmin/merchantAccount.service.ts` (`getBalance`, `updateMerchantAccount`, `UpdateMerchantAccountData`, imports)
- Modify: `src/controllers/superadmin/merchantAccount.controller.ts` (body destructure de update, `getBalance`)
- Modify: `src/routes/superadmin/merchantAccount.routes.ts` (ruta `/:id/balance`)
- Modify: `src/services/superadmin/aggregator.service.ts` (`getAggregatorById` select)
- Modify: `scripts/seed-balance-providers.ts` → seedear `FinancialProvider`
- Modify: `scripts/test-external-bank-balance.ts` (opcional, dejar el broker)
- Modify: `src/routes/superadmin.routes.ts` / `src/routes/dashboard/superadmin.routes.ts` (si el mount de `balance-providers` cambia de nombre) y `balanceProvider.*` (renombrar a `financialProvider` o dejar leyendo `financialProvider`)

**Interfaces:**
- Consumes: `getBalanceForMerchant` (Task 5), modelo `FinancialProvider`/`FinancialAccount` (Task 1).

- [ ] **Step 1: `merchantAccount.service.ts` — reemplazar `getBalance` y limpiar el update**

Reemplazar el cuerpo de `getBalance(id)` para delegar:
```typescript
import { getBalanceForMerchant } from '../financial-connections/financialConnection.service'
export async function getBalance(id: string) { return getBalanceForMerchant(id) }
```
En `UpdateMerchantAccountData` quitar `balanceProviderId`/`balanceProviderAccountId` (ya no se setean aquí; el link se hace en `selectAccount`). Borrar el bloque de validación de `balanceProviderId`/`balanceProviderAccountId` dentro de `updateMerchantAccount` (el que usa `getBalanceProviderClient`). Quitar el import de `../balance-providers/registry` si queda sin uso.

- [ ] **Step 2: `merchantAccount.controller.ts` + routes**

En el controlador: quitar `balanceProviderId, balanceProviderAccountId` del destructure y del objeto pasado a `updateMerchantAccount`. `getBalance` (o `getMoneygiverBalance` si aún existe con ese nombre) ya llama `merchantAccountService.getBalance(id)` — mantener. En `merchantAccount.routes.ts`, dejar `GET /:id/balance` apuntando a ese handler.

- [ ] **Step 3: `aggregator.service.ts` — actualizar el select**

En `getAggregatorById`, reemplazar el `select` de `merchants` para traer la cuenta financiera en lugar de los campos viejos:
```typescript
      merchants: {
        select: {
          id: true, displayName: true, externalMerchantId: true, active: true,
          financialAccount: { select: { id: true, label: true, lastBalance: true, balanceState: true, connection: { select: { provider: { select: { code: true, name: true } } } } } },
        },
      },
```

- [ ] **Step 4: Seed del catálogo**

En `scripts/seed-balance-providers.ts`, cambiar el upsert a `prisma.financialProvider`:
```typescript
  const provider = await prisma.financialProvider.upsert({
    where: { code: 'EXTERNAL_BANK' },
    update: {},
    create: { code: 'EXTERNAL_BANK', name: 'Proveedor bancario externo', active: true, connectionType: 'DIRECT_CREDENTIAL' },
  })
```
Run: `npx tsx -r tsconfig-paths/register scripts/seed-balance-providers.ts` → imprime el id.
Migrar la fila existente en dev: `psql "$DATABASE_URL" -c "SELECT code FROM \"FinancialProvider\";"` → `EXTERNAL_BANK`.

- [ ] **Step 5: Renombrar el endpoint de catálogo superadmin (si aplica)**

Si `balanceProvider.service.ts`/`controller`/`routes` (superadmin) siguen leyendo `prisma.balanceProvider`, cambiarlos a `prisma.financialProvider`. Alternativa mínima: dejar esos archivos pero cambiar la query al nuevo modelo. Confirmar con `grep -rn "prisma.balanceProvider\|balanceProvider\." src` → 0 resultados.

- [ ] **Step 6: Typecheck limpio (cero refs a los campos viejos)**

Run: `npm run typecheck` → sin errores.
Run: `grep -rn "balanceProviderId\|balanceProviderAccountId\|getBalanceProviderClient\|prisma.balanceProvider" src scripts` → `(vacío)`.

- [ ] **Step 7: Commit**

```bash
git add src/services/superadmin/merchantAccount.service.ts src/controllers/superadmin/merchantAccount.controller.ts src/routes/superadmin/merchantAccount.routes.ts src/services/superadmin/aggregator.service.ts scripts/seed-balance-providers.ts src/services/superadmin/balanceProvider.service.ts src/controllers/superadmin/balanceProvider.controller.ts src/routes/superadmin/balanceProvider.routes.ts
git commit -m "refactor(financial-connections): repoint superadmin getBalance + aggregator + catalog seed to new model; drop old MerchantAccount balance fields"
```

---

### Task 8: Verificación backend (typecheck/lint/test + smoke en vivo)

**Files:** ninguno nuevo (verificación).

- [ ] **Step 1: Suite completa**

Run: `npm run typecheck` → limpio.
Run: `npm run lint` → limpio (arreglar imports sin usar, etc.).
Run: `npx jest tests/unit/services/financial-connections` → todos verde.
Run: `npx jest tests/unit/services/superadmin/merchantAccount` → sin regresiones.

- [ ] **Step 2: Smoke en vivo contra el negocio de prueba (broker)**

Run: `npx tsx -r tsconfig-paths/register scripts/test-external-bank-balance.ts 3c45a403-d1ca-4449-c735-08de70ba745e`
Expected: imprime el saldo real del negocio `AV-MoneyGiver` (confirma que el cliente/tokens siguen sirviendo).

- [ ] **Step 3: (Manual, opcional) Smoke self-connect end-to-end**

Con `FINANCIAL_CONNECTION_KEY` seteada (`openssl rand -hex 32`), levantar el server y ejercer:
`POST /api/v1/dashboard/venues/<venueId>/financial-connections` con `{ providerId, email, password }` de una cuenta de prueba → seguir `validate-device` si aplica → `GET /api/v1/dashboard/financial-accounts/<id>/balance` → `{ state:'OK', amount, currency }`. Confirmar que una 2ª lectura NO re-loguea (el token cacheado sirve) revisando logs.

- [ ] **Step 4: Commit final (si hubo ajustes)**

```bash
git add -A && git commit -m "test(financial-connections): backend verification green (typecheck/lint/jest + live smoke)"
```

---

## Self-Review (hecho al escribir el plan)

- **Cobertura de spec:** §3 modelo (Task 1) · §4 cliente/adaptador (Tasks 3-4) · §5 flujo connect+device+select (Tasks 4-5) · §6.1 cripto dedicada (Task 2) · §6.3 refresh serializado con `pg_advisory_xact_lock` (Task 5) · §6.4 disconnect+revoke+audit (Task 5) · §7 contrato de saldo OK/ERROR (Task 5) · §8 REST (Task 6) · §9 broker/superadmin + migración (Task 7) · §10 pruebas/rollout (Task 8). Invariante `venueId⇔mode` y `OK⇒amount no nulo` cubiertas en Tasks 1/5.
- **Fuera de este plan (frontend, plan aparte):** sección "Cuentas de banco" en `Integrations.tsx`, wizard de connect, `BalanceCell` del `AggregatorDetailSheet`, y los services del dashboard (`paymentProvider.service.ts`/`aggregator.service.ts`/nuevo `financialConnection.service.ts`).
- **Riesgo conocido:** `createTokenCipher` — confirmar en `src/lib/token-encryption.ts` que expone `encryptToBase64`/`decryptFromBase64`; si no, ajustar `crypto.ts` (Task 2) a la API real. El endpoint `Log-Out` del proveedor no está verificado empíricamente; `revoke` es best-effort y no bloquea.
