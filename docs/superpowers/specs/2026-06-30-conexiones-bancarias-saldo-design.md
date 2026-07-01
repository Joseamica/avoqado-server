# Spec de diseño — Conexiones financieras del cliente (saldo hoy, portal embebido después)

**Fecha:** 2026-06-30 · **Estado:** Diseño para revisión — **v2.2 (lean + verificado por Codex)** · **Autor:** Jose + Claude
**Repos afectados:** `avoqado-server` (backend + schema) · `avoqado-web-dashboard` (UI)

> **Historial:** v1 → review de Codex (huecos reales de datos/seguridad) → v2 → pasada "no overengineer" (v2.1) → **2ª pasada de Codex sobre la lean (v2.2)**: cazó 2 correcciones baratas que un recorte había reabierto — refresh serializado *entre instancias* (lock en Postgres, no solo CAS) y la **cardinalidad del FK** (muchos merchants → una cuenta ⇒ el FK vive en `MerchantAccount.financialAccountId`) — más 3 invariantes de una línea. Deltas en §1.5.

---

## 0. Resumen en español sencillo (léelo aunque no leas el resto)

**El problema:** cuando un cliente cobra, el dinero pasa por un **procesador de pago** (y a veces un **agregador**) y al final **cae en su cuenta bancaria final** (Moneygiver hoy, BBVA u otros después). Hoy **no puede ver dentro de Avoqado si ya cayó** ni su saldo. Eso sirve para **conciliar**.

**Lo que hacemos:** que el cliente **conecte su banco** desde Integraciones y **vea su saldo**, sin loguearse cada vez.

**Ideas clave:**
1. **Bancos ≠ procesadores de cobro.** Stripe/MP/Blumon son *cómo cobras*; Moneygiver/BBVA son *dónde vive tu dinero*. Secciones y tablas separadas.
2. **Un login = una "conexión" que puede tener varias cuentas.** Un login de Moneygiver ve **varios negocios**, así que: **Conexión** (el login) → **Cuentas** (los negocios) → cada cuenta se liga al **merchant** que liquida ahí.
3. **Se conecta una vez.** Credenciales + código de Google Authenticator la 1ª vez. Guardamos un **"pase" cifrado (refreshToken), NUNCA el password**. El saldo aparece solo después.
4. **El id de la cuenta se autosaca** del login (1 negocio → directo; varios → escoge, validado en el server).
5. **Sin bancos "quemados":** catálogo que crece solo (un agregador con 50 bancos = 1 fila).
6. **Dueño claro:** la conexión pertenece a la **sucursal** que la conectó → sabemos quién puede conectar/ver/desconectar.
7. **El saldo trae estado:** moneda + "actualizado hace X" + **OK/ERROR** — para no confundir "tengo $0" con "falló la consulta".

**Futuro:** ver movimientos, hacer SPEIs, como el portal de Moneygiver embebido. Por eso el saldo (lectura) y los pagos (SPEI) se tratan como **cosas separadas**; hoy solo lectura de saldo, y **el iniciar SPEI es un adaptador aparte a diseñar después**.

**Fuera de alcance (YAGNI):** movimientos, SPEI, conciliación automática, BBVA/agregador reales, OAuth al banco.

---

## 1. Problema y estado actual

### 1.1 El flujo del dinero (y el hueco)
```
Cliente paga → Procesador (Blumon/AngelPay/…) → [Agregador opcional] → CUENTA FINAL (Moneygiver/BBVA)
                                                                          └─ sin visibilidad hoy
```

### 1.2 Lo que ya existe (sesión previa)
- Catálogo `BalanceProvider` (`{id,code,name,active}`, 1 fila `EXTERNAL_BANK`) → se **renombra a `FinancialProvider`**.
- Registry en `src/services/balance-providers/` + cliente `src/services/externalBank/` contra `prod.moneygiver.xyz` con **login broker compartido** (`EXTERNAL_BANK_*`).
- Enganche 1:1 en `MerchantAccount` (`balanceProviderId`+`balanceProviderAccountId`) + endpoint superadmin (idNegocio a mano).

> Este diseño **reemplaza** ese enganche por 2 tablas (§3). Como esos campos son de esta sesión, **sin commit, 0 filas, 0 consumidores en prod**, se reemplazan directo (§9).

### 1.3 Validado contra producción
- `POST /api/auth/sign-in/merchant` → `token` + **`refreshToken`** + `expiresIn`; éxito=`signedIn`; casing mixto → `pick()`.
- Sin re-login: `POST /api/auth/sign-in/token` (silencioso) / `refresh-token`. **El refreshToken ROTA** → dos refrescos concurrentes se pisan (§6.3).
- Saldo: `GET /api/auth` → `negocios[]` (`idNegocio`,`nombre`,`cuentaDispersion.saldo`).
- Device one-time: `needDeviceValidation` → `identity/start/web` → OTP → `identity/validate-otp-code/web` (**usa el Bearer temporal del login**).
- `needTwoFactorAuth` no bloquea la lectura (no dice nada de transferencias).

### 1.5 Qué cambió (v2 → v2.1 lean)
- **2 tablas** (Conexión → Cuenta) en vez de 3: el merchant lleva un FK `financialAccountId` a su cuenta (**muchos merchants → una cuenta**), sin tabla de mapeo ni `isPrimary/purpose`.
- Dueño = **`venueId`** (null = broker) en vez de un `ownerScope` polimórfico.
- Cifrado dedicado AES-GCM sin fallback, **una sola versión** (sin maquinaria de rotación).
- Saldo con estado **OK/ERROR/UNKNOWN** + `lastSyncedAt` (sin timestamp del proveedor ni STALE).
- **Migración directa** (sin dual-write) por 0 filas / 0 consumidores.
- Un solo cliente (conectar+leer); el adaptador de pagos ni se especifica ahora.
- Se conservan (necesarios): split conexión/cuenta, llave dedicada sin fallback, estado del reto OTP, estado OK/ERROR, authz por OWNER de sucursal, redacción de secretos, refresh serializado.

---

## 2. Objetivos y NO-objetivos

**Objetivos:** (1) self-connect de Moneygiver una vez y ver saldo (moneda + estado); (2) saldo sin re-login (refreshToken cifrado + refresh serializado); (3) una conexión con varias cuentas, cada cuenta ligada a ≤1 merchant; (4) solo el OWNER de la sucursal conecta/ve/desconecta; (5) extensible sin enums de banco, con lectura y pagos separados; (6) coexistir con el broker compartido.

**NO-objetivos (§10):** movimientos, SPEI, conciliación automática, BBVA/agregador reales, OAuth al banco, scheduler de refresh en background, rotación de llave.

---

## 3. Modelo de datos (2 tablas + catálogo)

Regla mental: **catálogo = tipo de banco**; **conexión = un login (de una sucursal)**; **cuenta = un negocio que ese login ve, ligado a ≤1 merchant**.

```prisma
enum FinancialConnectionType   { DIRECT_CREDENTIAL DIRECT_OAUTH AGGREGATOR }
enum FinancialConnectionMode   { SELF_CONNECT SHARED_BROKER }
enum FinancialConnectionStatus { PENDING_DEVICE_VALIDATION PENDING_ACCOUNT_SELECTION CONNECTED NEEDS_REAUTH REVOKED ERROR }
enum FinancialBalanceState     { OK ERROR UNKNOWN }

// Catálogo (renombrado de BalanceProvider). Crece solo; sin enums de banco.
model FinancialProvider {
  id             String  @id @default(cuid())
  code           String  @unique                 // "EXTERNAL_BANK", futuro "BBVA_DIRECT", "BELVO"
  name           String
  active         Boolean @default(true)
  connectionType FinancialConnectionType @default(DIRECT_CREDENTIAL)
  connections    FinancialConnection[]
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  @@index([active])
}

// La conexión = un login. Dueño = la sucursal (null = broker compartido / plataforma).
model FinancialConnection {
  id           String @id @default(cuid())
  venueId      String?
  venue        Venue?  @relation(fields: [venueId], references: [id], onDelete: Cascade)
  providerId   String
  provider     FinancialProvider @relation(fields: [providerId], references: [id])
  mode         FinancialConnectionMode   @default(SELF_CONNECT)
  status       FinancialConnectionStatus @default(PENDING_DEVICE_VALIDATION)

  // 🔐 refreshToken cifrado (AES-256-GCM, llave dedicada). null en SHARED_BROKER.
  grantEnc     String?
  tokenVersion Int      @default(0)   // CAS al refrescar (el token rota) — §6.3
  expiresAt    DateTime?

  // 🔐 Reto OTP entre requests (Bearer temporal + processId), cifrado y efímero.
  challengeEnc       String?
  challengeExpiresAt DateTime?

  deviceIdentifier String?            // huella estable del dispositivo. ⚠️ no reescribir tras validar
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

// Una cuenta = un negocio que ve la conexión, ligada a ≤1 merchant (el que liquida ahí).
model FinancialAccount {
  id                String @id @default(cuid())
  connectionId      String
  connection        FinancialConnection @relation(fields: [connectionId], references: [id], onDelete: Cascade)

  externalId        String              // idNegocio de Moneygiver (opaco)
  label             String?             // nombre del negocio (DATO, no se ramifica)
  institution       String?             // agregador: banco subyacente
  clabe             String?

  currency          String  @default("MXN")
  active            Boolean?
  lastBalance       Decimal? @db.Decimal(18, 2)
  lastSyncedAt      DateTime?
  balanceState      FinancialBalanceState @default(UNKNOWN)
  lastError         String?

  // Los merchants que liquidan en esta cuenta (VARIOS pueden caer en la misma).
  // El FK vive en MerchantAccount.financialAccountId (ver nota abajo).
  merchantAccounts  MerchantAccount[]

  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  @@unique([connectionId, externalId])
  @@index([connectionId])
}
```

**Invariantes (app + check):** `SELF_CONNECT`+`CONNECTED` ⇒ `grantEnc` no nulo; `SHARED_BROKER` ⇒ `grantEnc` nulo. `challengeEnc` solo mientras `status=PENDING_*`. **`venueId IS NULL ⇔ mode=SHARED_BROKER`** (evita que una fila contradictoria exponga cuentas del broker a un dueño de sucursal).

**`MerchantAccount`:** agregar `financialAccountId String?` + `financialAccount FinancialAccount? @relation(onDelete: SetNull)` (dónde liquida ESTE merchant — muchos merchants pueden apuntar a la misma cuenta; borrar la cuenta solo pone el FK en null, no toca al merchant); quitar `balanceProviderId`/`balanceProviderAccountId` (§9). `getBalance(merchant)` sigue `merchant.financialAccountId`.

---

## 4. El cliente del provider (registry)

Un cliente por provider en el registry, con dos responsabilidades hoy:
- **Conectar:** `connect(credenciales)` → `{ grant, accountOptions }` | `{ needDeviceValidation, challenge }`; `validateDevice(challenge, code)`; `refresh(grant)` (rota); `revoke(grant)`.
- **Leer:** `listAccounts(ctx)` (GET /api/auth → negocios[]); `getBalance(ctx, externalId)` → `{ amount, currency, active }`.

El descifrado del grant ocurre solo en el borde de la llamada; el `ctx` lleva el access token ya renovado, no el secreto en reposo.

**Pagos/SPEI = adaptador aparte, NO se diseña ahora** (idempotencia, beneficiarios, límites, step-up auth, async, webhooks). No es "un método más" del de lectura. Solo se deja anotado el hueco.

Agregar un banco = fila en catálogo + su cliente (+ su rama de connect en el front si aplica). Aditivo y acotado (no "cero cambios").

---

## 5. Flujo de conexión (self-connect Moneygiver)

1. En **Integraciones** (sucursal), sección "Cuentas de banco" → **"Conectar banco"**.
2. Elige "Moneygiver" + captura usuario+contraseña (una vez).
3. Server crea `FinancialConnection` (`venueId`, `PENDING_*`) y llama `connect` con un `deviceIdentifier` estable:
   - `needDeviceValidation` → guarda **`challengeEnc`** (Bearer temporal + processId, cifrado, con expiry); la UI solo recibe `connectionId` + "captura tu código" → `POST /financial-connections/:id/validate-device` completa el handshake.
4. Al éxito: `listAccounts` → un `FinancialAccount` por negocio.
   - 1 cuenta → auto-selecciona y auto-liga al merchant de esa sucursal.
   - varias → `PENDING_ACCOUNT_SELECTION`; la UI muestra la lista que **el server ya guardó**; `/select-account` **valida el `externalId` contra ese set**.
5. Guarda el **grant cifrado**, borra `challengeEnc`, `CONNECTED`. **Descarta el password.**
6. Saldo: server renueva el access token (serializado, §6.3) → `getBalance` → `lastBalance`+`balanceState=OK`+`lastSyncedAt`. Cacheado; sin re-login.
7. Si el refresh falla → `NEEDS_REAUTH` + `balanceState=ERROR`; la UI ofrece "reconectar".

---

## 6. Seguridad (lo necesario, sin adornos)

**6.1 Cifrado.** Llave **dedicada** `FINANCIAL_CONNECTION_KEY` (hex 32 bytes), **AES-256-GCM**. **Sin fallback a llave default** — si falta, la feature falla cerrada (no cifra con llave conocida como el helper actual en `merchantAccount.service.ts:28`). El secreto nunca sale en logs ni respuestas; se descifra solo en el borde de la llamada.

**6.2 Autorización.** Endpoints colgados de la sucursal (`/venues/:venueId/financial-connections`), guardados por **OWNER** de esa sucursal. Conexiones broker (`venueId` null) = solo superadmin.

**6.3 Refresh serializado (entre instancias).** El refreshToken **rota**, así que dos instancias del server no deben llamar `refresh` a la vez — el daño es la doble llamada al proveedor, no el guardado (un CAS al escribir llega tarde). Se serializa **la llamada al proveedor** con un **lock por conexión en Postgres**: `pg_advisory_xact_lock(hashtext(connectionId))` al inicio de la transacción de refresh (una línea, usa la DB que ya tenemos, sin Redis). Dentro del lock: re-leer el grant, refrescar solo si sigue vencido, guardar. El single-flight en memoria queda como fast-path; `tokenVersion` como cinturón extra opcional.

**6.4 Desconexión.** `revoke` best-effort del lado del proveedor + borrar el secreto + una línea de auditoría (reusar `logAction`). Se marca `REVOKED` (sin secreto), no hard-delete ciego. `MerchantAccount.financialAccountId` es `SetNull` al borrar la cuenta/conexión (el merchant/procesador queda intacto; sin cascade silencioso).

**6.5 Endpoints connect/OTP.** Reusar el rate-limit existente; `challengeExpiresAt` corto; **redactar** passwords/tokens/OTP/processId en logs y errores de Axios.

---

## 7. Contrato de saldo (honesto pero chico)

Por cuenta la API devuelve `{ amount, currency, syncedAt, state }`, `state ∈ OK|ERROR|UNKNOWN`.
- **`OK` ⇒ `amount` y `syncedAt` no nulos.** El `saldo` de Moneygiver es nullable → un saldo nulo/malformado del proveedor se mapea a `ERROR` (o `UNKNOWN`), **nunca `OK` con número en blanco**.
- Distingue **"$0 real"** de **"falló la consulta"** (`ERROR`). La UI pinta el número si `OK` (con "actualizado hace X" desde `syncedAt`); si `ERROR`, "no disponible / reconectar".

---

## 8. Contrato REST (aditivo, por sucursal)

| Método | Ruta | Auth | Qué hace |
|---|---|---|---|
| `GET` | `/financial-providers` | dashboard | Catálogo. |
| `GET` | `/venues/:venueId/financial-connections` | OWNER(venue) | Conexiones + cuentas + saldo (con `state`). |
| `POST` | `/venues/:venueId/financial-connections` | OWNER(venue) | `{ providerId, credentials }` → `{ connectionId, status, accountOptions? }`. |
| `POST` | `/financial-connections/:id/validate-device` | OWNER | `{ code }` → resuelve el handshake (usa `challengeEnc`). |
| `POST` | `/financial-connections/:id/select-account` | OWNER | `{ externalId }` (validado contra el set guardado). |
| `GET` | `/financial-accounts/:id/balance` | OWNER | Saldo en vivo (refresh serializado). |
| `DELETE` | `/financial-connections/:id` | OWNER | Revoca + audita + `REVOKED`. |

Superadmin: `getBalance(merchantAccountId)` → sigue `merchantAccount.financialAccountId` → el `FinancialAccount` → saldo.

---

## 9. Coexistencia con el broker + migración

- **Broker:** una `FinancialConnection` con `venueId=null`, `mode=SHARED_BROKER`, `grantEnc=null` (usa `EXTERNAL_BANK_*`). Sus negocios se materializan como `FinancialAccount` ligadas a los merchants (lo que hoy hace "pegar el idNegocio" pasa a "ligar la cuenta").
- **Migración directa (1 paso):** rename `BalanceProvider→FinancialProvider`; crear `FinancialConnection`+`FinancialAccount`+enums; agregar `MerchantAccount.financialAccountId`; quitar `balanceProviderId`/`balanceProviderAccountId` de `MerchantAccount`; actualizar el código (también sin commit) que los usa. Justificado: 0 filas, 0 consumidores en prod. (Si algún día hubiera datos vivos, sería expand/contract — no es el caso.)
- **Consumidores a actualizar** (ya conocidos de esta sesión): `src/services/superadmin/aggregator.service.ts` (select de merchants), `src/services/superadmin/merchantAccount.service.ts` (`getBalance` + `updateMerchantAccount`), sus controllers/routes, el `BalanceCell` del front, y los scripts `seed-balance-providers.ts` / `test-external-bank-balance.ts`.

---

## 10. Pruebas · Rollout · Fuera de alcance

**Pruebas (server):** connect (éxito / needDeviceValidation / needPasswordReset), validateDevice, refresh que rota, revoke; getBalance con `state`; cifrado AES-GCM (roundtrip + falla-cerrada sin llave); **CAS de refresh concurrente** (uno gana, el otro re-lee); `select-account` rechaza externalId fuera del set; authz (otro venue NO puede). Integración nock del connect completo. Smoke en vivo con `scripts/test-external-bank-balance.ts` (self-connect, `idNegocio 3c45a403-…`), confirmar "número directo sin re-login". Frontend: wizard (OTP, multi-cuenta, error/reconectar). `tsc`/lint/jest limpios en ambos repos.

**Rollout:** (1) schema (rename + 2 tablas + enums + seed); (2) server (cliente + endpoints + cripto dedicada + refresh serializado); (3) superadmin `BalanceCell`→modelo nuevo; (4) merchant (sección + wizard); (5) verificación + review adversarial.

**Fuera de alcance (explícito):** movimientos (`getMovements`), SPEI/transferencias (**adaptador de pagos aparte**), conciliación automática (`docs/MONEYGIVER_SETTLEMENT_FLOW.md`), BBVA/agregador reales, OAuth al banco, scheduler de refresh en background (v1 refresca síncrono al leer con cache corto), rotación de llave.

---

## Decisiones tomadas (Jose, 2026-06-30)
- **Renombrar** `BalanceProvider→FinancialProvider` (pre-ship). ✅
- Dueño de la conexión = **sucursal (`venueId`)**; ORG-level queda para después. ✅
- **Llave dedicada** `FINANCIAL_CONNECTION_KEY` + AES-GCM sin fallback (sin versión de rotación por ahora). ✅
- Mantener el mandato **"no overengineer"**: 2 tablas, sin dual-write, sin rotación, sin adaptador de pagos todavía. ✅
