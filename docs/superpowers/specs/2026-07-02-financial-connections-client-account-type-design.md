# Financial Connections — Tipo de cuenta: Negocio (merchant) vs Personal (cliente)

**Fecha:** 2026-07-02
**Repos:** `avoqado-server` (backend) + `avoqado-web-dashboard` (frontend)
**Estado:** Diseño aprobado (brainstorming) — pendiente escribir plan por tareas.

## Problema

El wizard "Conectar cuenta de banco" (Financial Connections) hoy solo conecta cuentas
**merchant** de Moneygiver/QPay. Un dueño de venue también puede tener una **cuenta personal
(cliente)** en Moneygiver — un mundo paralelo con login y modelo de cuentas distintos. Al
intentar conectar una cuenta cliente por el flujo merchant, QPay responde
`"Este usuario no tiene una cuenta."` y el usuario nunca entra. Este spec agrega la opción de
elegir y conectar el tipo **Personal (cliente)**.

## Descubrimiento (verificado en vivo contra `prod.moneygiver.xyz`)

Moneygiver tiene **dos jerarquías paralelas** `wallet → cuentas → movimientos`: **Negocio
(merchant)** y **Cliente**. El login y el listado de cuentas difieren; el resto se reusa.

| Dimensión | Merchant (ya existe) | Cliente (nuevo) |
|---|---|---|
| Login endpoint | `POST /api/auth/sign-in/merchant` | `POST /api/auth/sign-in` |
| Header `mgPlatform` | `MERCHANT` | `PWA` |
| 2FA | `POST /api/auth/validate-two-factor-code` | **igual** (mismo endpoint, `mgPlatform: PWA`) |
| Dispositivo / refresh / cifrado grant | — | **se reusan** |
| Lista de cuentas | `GET /api/auth` → `negocios[].cuentaDispersion` | `GET /api/clients/get-wallet-clientAccounts/v3r2.1?idMoneyGiver=<id>` → `{ cuentas: Cuenta[] }` |
| Saldo | `saldo` de `cuentaDispersion` | `saldo` de cada `Cuenta` |
| Movimientos / stats | `GET /api/clients/movimientos/{idNegocio}?idCuenta=` + `/Estadisticas/{idCuenta}` | `GET /api/clients/movimientos/{idCuenta}` + `/Estadisticas/{idCuenta}` (**mismos endpoints**) |

**`Cuenta` (cliente)** — mapea 1:1 a nuestro `ProviderAccount`:
`idCuenta`(uuid) → `cuentaId`+`externalId` · `nombre` → `label` · `cuentaClabe` → `clabe` ·
`saldo`(number) → `balance` · `activo`(bool) → `active` · `idCuentaAlt`(int) → `altId`.

**`idMoneyGiver`** del cliente viene en el `userData` de la respuesta de login (confirmado en
vivo: `4e15415b-939a-4948-98f5-08de3f2e6e3f`). Se usa como query param de
`get-wallet-clientAccounts`.

## Arquitectura

Se agrega **una sola dimensión** a la conexión: `accountKind` (`MERCHANT` | `CLIENT`). Ese
valor decide **4 branch points** dentro del client de provider; todo lo demás (2FA,
dispositivo, refresh, cifrado, UI de detalle de saldo/movimientos, orphan cleanup,
ActivityLog, needs-reauth) se reusa sin cambios.

Branch points por `accountKind`:
1. **`mgPlatform`** header — `MERCHANT` → `MERCHANT`; `CLIENT` → `PWA`.
2. **Login endpoint** — `/sign-in/merchant` vs `/sign-in`.
3. **Listado de cuentas** — `negocios[]` (vía `/api/auth`) vs `cuentas[]` (vía `get-wallet-clientAccounts?idMoneyGiver=`).
4. **Path de movimientos/saldo** — merchant: `idNegocio` en ruta + `idCuenta` query; cliente: `idCuenta` en ruta.

### Componentes — Backend (`avoqado-server`)

- **`prisma/schema.prisma`**: `enum FinancialConnectionAccountKind { MERCHANT CLIENT }` y campo
  `FinancialConnection.accountKind FinancialConnectionAccountKind @default(MERCHANT)`. Migración
  aditiva (default MERCHANT → conexiones existentes intactas).
- **`services/financial-connections/types.ts`**:
  - `ConnectInput.accountKind: FinancialConnectionAccountKind`.
  - `ConnectionContext` gana `platform: string` (el `mgPlatform` resuelto para esa conexión), para
    threading en todas las llamadas.
  - `ProviderAccount` no cambia (el mapeo del cliente encaja en el shape actual).
- **`services/financial-connections/externalBank.client.ts`**:
  - `headers(token?, platform)` — `mgPlatform` por conexión, no global desde env.
  - `signIn(email, password, deviceIdentifier, accountKind)` — elige endpoint + platform.
  - `normalizeClientAccounts(payload)` — nuevo; `{ cuentas: Cuenta[] }` → `ProviderAccount[]`.
  - `connect` / `validateTwoFactorCode` / `validateDevice` — tras auth, si `CLIENT`: extraer
    `idMoneyGiver` del `userData` → `GET get-wallet-clientAccounts?idMoneyGiver=` →
    `normalizeClientAccounts`. Si `MERCHANT`: flujo actual (`fetchMe` → `normalizeAccounts`).
  - `refresh` — usa el `platform` de la conexión.
  - `listMovements` / `getMovementStats` / `getBalance` — branch de construcción de ruta por
    `accountKind`.
- **`services/financial-connections/financialConnection.service.ts`**: `startConnection` recibe y
  persiste `accountKind`; lo pasa al client; resuelve `platform` desde `accountKind`. La lectura de
  saldo/movimientos usa el `accountKind` de la conexión.
- **`config/env.ts`**: mantener `EXTERNAL_BANK_MG_PLATFORM` (merchant, default `MERCHANT`) y agregar
  `EXTERNAL_BANK_MG_PLATFORM_CLIENT` (default `PWA`). El client mapea `accountKind → platform`.
- **Endpoint REST** de crear conexión: aceptar `accountKind` en el body (default `MERCHANT` si no
  viene, retrocompatible).

### Componentes — Frontend (`avoqado-web-dashboard`)

- **`pages/Venue/components/BankConnectWizard.tsx`**: en el paso `credentials`, un segmented control
  **"Tipo de cuenta: Negocio | Personal"** (default Negocio) arriba de correo/contraseña. Su valor
  se pasa a `createConnection`. Los demás pasos (`code` 2FA, `selectAccount`, `done`) sin cambios.
- **`services/financialConnection.service.ts`**: `createConnection(venueId, { providerId, email,
  password, accountKind })`.
- **i18n** (`locales/{es,en,fr}/financialConnections.json`): labels "Cuenta de negocio" /
  "Cuenta personal" + texto de ayuda ("Personal = la cuenta con la que entras a la app de tu
  banco"). Paridad de keys en los 3 locales.

## Verificación requerida durante implementación

Estos puntos NO se pudieron cerrar contra docs (QPay subdocumenta) y deben confirmarse en vivo con
la cuenta de prueba `devgerruiz` (Jose teclea las credenciales; el implementer lee la respuesta):

1. **Scoping de movimientos del cliente** — confirmar que `GET /api/clients/movimientos/{idCuenta}`
   (path = idCuenta) devuelve **solo** los movimientos de esa cuenta, y NO un pool global como pasó
   con la cuenta de dispersión del merchant. Si devolviera pool, aplicar filtro equivalente.
2. **Campo `idMoneyGiver`** — confirmar el nombre exacto del campo en el `userData` del login del
   cliente.
3. **Campos de `Cuenta`** — confirmar nombres (`idCuenta`, `cuentaClabe`, `saldo`, `nombre`,
   `activo`, `idCuentaAlt`) contra la respuesta viva de `get-wallet-clientAccounts`.

## Testing

- **Unit (nock)** en el client: login cliente (`/sign-in` + `mgPlatform: PWA` + branch 2FA),
  `normalizeClientAccounts`, y el branch de ruta de movimientos (idCuenta directo).
- **Paridad i18n** es/en/fr (mismo número de keys).
- **Typecheck** backend + frontend.
- **Smoke en vivo** con `devgerruiz` (login → 2FA → listar cuentas → saldo → movimientos).
- Regla de cobertura: N sitios cambiados → exactamente N tests nuevos; no agrupar cobertura ajena.

## Fuera de alcance (YAGNI)

- Auto-detección del tipo de cuenta — el usuario elige explícitamente.
- Transferencias desde cuenta cliente — el feature de transfer interno existe pero no se toca aquí.
- Modelo de "colaborador" (UsuarioGrupo) separado — el descubrimiento mostró que la "cuenta normal"
  es un **cliente**, no un colaborador; no se modela colaborador.
- Rollout a producción del catálogo/seed — es un pendiente separado (la DB de prod no tiene el
  `FinancialProvider` sembrado, por eso el wizard muestra "No hay bancos disponibles" en prod).
