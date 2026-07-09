# Guía: Crear un Venue Nuevo (de cero a funcionando)

> **Documento vivo.** Recoge TODO lo que se necesita para levantar un venue nuevo en Avoqado —demo o real— y que las superficies (booking
> widget, dashboard, checkout, TPV) funcionen. Aún no está al 100%; se irá afinando. Última actualización: **2026-07-07**.
>
> Ejemplo canónico end-to-end: el clon "Avoqado Fitness" → `scripts/seed-avoqado-fitness-demo.ts` +
> `docs/superpowers/specs/2026-07-07-avoqado-fitness-demo-clone-design.md`.

---

## 0. TL;DR — dos verdades

1. **Crear un `Venue` es trivial** (solo requiere `organizationId`, `name`, `slug`). **Hacerlo FUNCIONAL no lo es**: un venue usable
   necesita settings, features, staff con acceso, catálogo, config de reservas, KYC aprobado y —si quieres cobrar— config de pagos.
2. **La forma más segura de crear uno es CLONAR la config de un venue que ya funciona** (`avoqado-full`) fila por fila, y solo cambiar lo
   específico. Clonar es _drift-proof_: copias exactamente lo que ya existe en prod, sin adivinar columnas.

**Patrón recomendado:** un script TypeScript idempotente + reversible (`--teardown`), corrido con **`tsx`** (NO `ts-node`), apuntando
`DATABASE_URL` a la DB destino.

---

## 1. Prerrequisitos y entorno

| Tema                   | Regla                                                                                                                                                                                                                                                      |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **DB de PROD**         | Render. `DATABASE_URL="postgresql://…oregon-postgres.render.com/avoqado_db"`. (`platform-fly-demo-render-prod`: Fly = solo demo).                                                                                                                          |
| **Runner**             | **`npx tsx scripts/x.ts`**. NO `ts-node` — su type-check en runtime tarda >2 min solo en arrancar contra la DB remota y el proceso muere por timeout antes de escribir.                                                                                    |
| **IDs**                | Prisma genera cuid automáticamente en `.create()`. Si insertas por SQL crudo, usa **cuid v1** (25 chars, prefijo `c`) — `npm i --no-save cuid && node -e "console.log(require('cuid')())"`. Nunca prefijos custom ni UUID.                                 |
| **Dinero**             | Pesos, unidades mayores 1:1 (`799.00` = 799 pesos). Nunca centavos salvo en el borde de un proveedor.                                                                                                                                                      |
| **Fechas venue-local** | Para horas de clases/citas usa `fromZonedTime(\`${ymd}T${hh}:mm:00\`, 'America/Mexico_City')`— NUNCA`new Date('YYYY-MM-DD')` (trampa de timezone del host; prod corre en UTC).                                                                             |
| **Schema drift**       | Antes de usar Prisma contra prod, confirma que el schema local no está adelantado en los modelos que tocas (`SELECT migration_name FROM _prisma_migrations ORDER BY finished_at DESC`). Si lo está solo en modelos que NO tocas, Prisma es seguro.         |
| **Git**                | No commitear sin permiso explícito del founder.                                                                                                                                                                                                            |
| **Auditoría**          | Si creas el venue vía **endpoint/servicio de la app**, cada mutación audit-worthy debe escribir `ActivityLog`. Si es un **seed directo por psql/script de ops**, ese requisito no aplica (queda fuera del pipeline de la app) — pero deja todo reversible. |

---

## 2. Las 4 superficies y qué necesita cada una

| Superficie           | URL / cliente                                                    | Requisitos mínimos para que "funcione"                                                                                                                                                                                               |
| -------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Booking widget**   | `book.avoqado.io/:slug/classes` (y `/citas`)                     | Venue `active` + `status=ACTIVE`; Feature **RESERVATIONS**; `ReservationSettings.publicBookingEnabled=true`; productos `CLASS`/`APPOINTMENTS_SERVICE` activos; **ClassSession** futuras (para clases) o pacing de citas.             |
| **Web dashboard**    | `dashboard.avoqado.io`                                           | Al menos un **StaffVenue** activo con rol que puedas loguear; features prendidas; `kycStatus=VERIFIED` para que no salga banner de onboarding pendiente.                                                                             |
| **Checkout / pagos** | pack de clases: API pública; membresías: payment link / checkout | Compra de **credit pack** → usa Stripe **de plataforma** (no requiere config del venue). Cobro online de reservas / venta de producto por checkout hospedado → requiere **EcommerceMerchant chargeable de Stripe Connect** (ver §5). |
| **TPV**              | app en terminal PAX/Nexgo                                        | **Hardware físico**: no se clona. Se activa un dispositivo real al venue (código de activación) + `MerchantAccount` asignado (`Terminal.assignedMerchantIds`). Para demo suele configurarlo el founder aparte.                       |

> **Nota real (2026-07-07):** ni `avoqado-full` ni sus clones tienen Stripe Connect, así que `canVenueChargeOnline=false` en ambos. El cobro
> online de clases "cae" al mismo comportamiento que full (reserva sin cobro / redención de créditos). La venta de credit packs sí cobra
> (plataforma).

---

## 3. Anatomía del venue — componente por componente

Orden de creación recomendado (respeta las FKs). ✅ = obligatorio para un venue funcional · ◽ = opcional/según superficie · 🔁 = clonar de
`avoqado-full` es lo más seguro.

### 3.1 Organization ✅

Reusar una existente (p.ej. `Grupo Avoqado Prime` = `cmhvejg1t00a52gtx889cat0e`) o crear una nueva. Para un demo, reusar es lo más simple
(comparte config org-level). Una org nueva implica también `OrganizationModule`, membresías de staff (`StaffOrganization`), etc.

### 3.2 Venue ✅

Campos **verdaderamente obligatorios** (NOT NULL sin default): `organizationId`, `name`, `slug` (`id`/`updatedAt` los pone Prisma). Todo lo
demás tiene default. Pero para que se vea **onboarded** setea explícito:

| Campo                                | Valor recomendado                                                          | Por qué                                                                        |
| ------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `type`                               | `VenueType` correcto (`FITNESS`, `RESTAURANT`, `SALON`, `RETAIL_STORE`, …) | Define comportamiento/copy por industria.                                      |
| `slug`                               | único, kebab-case                                                          | Resuelve el booking widget y URLs públicas.                                    |
| `status`                             | `ACTIVE`                                                                   | Default es `ONBOARDING`.                                                       |
| `kycStatus`                          | `VERIFIED`                                                                 | Default `NOT_SUBMITTED` → banners de "KYC pendiente". VERIFIED = opera normal. |
| `entityType`                         | `PERSONA_MORAL` o `PERSONA_FISICA`                                         | Espeja un venue real.                                                          |
| `seatCapExempt`                      | `true` (para demos)                                                        | Grandfathered: sin seat-cap ni paywalls de tier.                               |
| `timezone` / `currency` / `language` | `America/Mexico_City` / `MXN` / `es`                                       | Defaults ya correctos para MX.                                                 |
| `primaryColor`                       | `#7ADD2C` (verde marca)                                                    | Acento del widget.                                                             |
| `logo` / `logoFull` / `heroImageUrl` | opcional                                                                   | Marca en recibos y página pública de booking.                                  |

`VenueType` (enum) incluye, entre otros: FOOD (RESTAURANT, BAR, CAFE, BAKERY…), RETAIL (RETAIL_STORE, CLOTHING, PHARMACY,
TELECOMUNICACIONES…), **SERVICES (SALON, SPA, FITNESS, CLINIC, VETERINARY…)**, HOSPITALITY (HOTEL…), ENTERTAINMENT (CINEMA, ARCADE…).

### 3.3 VenueSettings ✅ 🔁

**No se auto-crea** (68 filas / 70 venues activos). Clónala de la plantilla (impuestos, propina, moneda, formatos). Solo
`id`/`venueId`/`updatedAt` son obligatorios; el resto tiene defaults.

### 3.4 VenueFeature ✅ 🔁

Prende capacidades. Usa el helper `saveVenueFeatures(venueId, featureIds)` (busca Feature por code, crea `VenueFeature` con `monthlyPrice`
que es NOT NULL). **Solo prende codes ACTIVOS** — si el Feature está `active=false` se ignora en silencio.

- **Codes activos hoy:** `ADVANCED_REPORTS`, `AI_ASSISTANT_BUBBLE`, `AVAILABLE_BALANCE`, `CHATBOT`, `INVENTORY_TRACKING`, `LOYALTY_PROGRAM`,
  `ONLINE_ORDERING`, `RESERVATIONS` (+ `PLAN_PRO`/`PLAN_PREMIUM`).
- **`ADVANCED_ANALYTICS` está INACTIVO** (deprecado) → no se prende aunque lo pidas. Es esperado.
- **Booking widget necesita `RESERVATIONS`.**

### 3.5 VenueModule ◽ (Module ≠ Feature — no cruzar)

Solo si el venue usa módulos: `SERIALIZED_INVENTORY`, `WHITE_LABEL_DASHBOARD`, `COMMISSIONS`. Se gatean con `moduleService.isModuleEnabled`,
NO con el resolver de Features. `avoqado-full` no tiene módulos. Ver `.claude/rules/feature-gating.md`.

### 3.6 Staff / StaffVenue ✅

Para loguear al dashboard necesitas un `StaffVenue` activo. Lo más simple para demos: **reusar las cuentas demo existentes**
(`owner@owner.com`, `admin@admin.com`, `manager@manager.com`, `cashier@cashier.com`, `superadmin@superadmin.com`) agregando un `StaffVenue`
que las ligue al venue.

- Requeridos: `staffId`, `venueId`, `role` (`StaffRole`). `active=true`.
- Únicos a cuidar: `(staffId, venueId)`, `(venueId, pin)`, `(venueId, posStaffId)`. Deja `pin` null (múltiples null OK) para no colisionar.
- Roles: SUPERADMIN > OWNER > ADMIN > MANAGER > CASHIER > WAITER > KITCHEN > HOST > VIEWER.

### 3.7 Menu + MenuCategory + MenuCategoryAssignment ✅

- **Menu**: `venueId`, `name` (+ `type`, default `REGULAR`).
- **MenuCategory**: `venueId`, `name`, `slug` (único `(venueId, slug)`), `displayOrder`, `active`. Opcional `icon`, `color`, `imageUrl`.
- **MenuCategoryAssignment** (junction Menu↔Categoría): `menuId`, `categoryId`, `displayOrder`. Sin esta fila la categoría no cuelga del
  menú.

### 3.8 Product ✅

Requeridos sin default: `venueId`, `sku`, `name`, `categoryId`, `price` (`type` default `FOOD`, `taxRate` 0.16, `displayOrder` 0, `active`
true…). **`sku` es único por venue** (`(venueId, sku)`).

`ProductType` a usar (los legacy FOOD/BEVERAGE/RETAIL están deprecados): | Tipo | Para | |---|---| | `REGULAR` | producto físico / retail /
membresías | | `FOOD_AND_BEV` | comida y bebida (`isAlcoholic` para alcohol) | | `APPOINTMENTS_SERVICE` | servicios agendables (citas,
personal training, corte) — set `durationMinutes` | | `CLASS` | clases con cupo por sesión — set `durationMinutes`, `maxParticipants`,
`allowCreditRedemption` | | `EVENT` | boletos de evento (`eventCapacity`, `eventDate`…) | | `DIGITAL` / `DONATION` | descargables /
donaciones |

### 3.9 ClassSession ◽ (necesario para booking de clases)

Para que el widget muestre disponibilidad de una clase, siembra sesiones futuras: `venueId`, `productId` (el producto CLASS), `startsAt`,
`endsAt`, `duration`, `capacity`, `status` (`SCHEDULED`). Opcional `assignedStaffId` (instructor — cualquier `Staff.id` válido) y
`createdById`.

- **Horas venue-local:** `startsAt = fromZonedTime(\`${ymd}T07:00:00\`, 'America/Mexico_City')`. Se guarda como el instante UTC; la app lo
  re-convierte a local al mostrarlo.
- Respeta `ReservationSettings.operatingHours` (no siembres en días cerrados, p.ej. domingo).

### 3.10 ReservationSettings ✅ 🔁 (necesario para booking público)

Único por venue. Clona de la plantilla. Flags clave: `publicBookingEnabled=true`, `autoConfirm`, `operatingHours` (JSON por día),
`maxAdvanceDays`, `minNoticeMin`, `slotIntervalMin`, `defaultDurationMin`, `classUpfrontDefault` (`required`/`at_venue`/`none`),
`appointmentUpfrontDefault`, `depositMode`.

> ⚠️ `classUpfrontDefault=required` implica pago por adelantado para reservar clase. Si el venue **no** puede cobrar online (sin Stripe
> Connect), o lo pones en `at_venue`/`none`, o el cliente redime créditos, o el flujo cae a "reserva sin cobro" (como full). Para un demo
> sin pagos, `at_venue` es lo más simple.

### 3.11 Reservation ◽ (citas/clases de ejemplo)

Requeridos sin default: `venueId`, `confirmationCode`, `cancelSecret`, `startsAt`, `endsAt`, `duration` (`status`/`channel`/`partySize`
tienen default). El cliente se guarda en **`guestName`/`guestPhone`/`guestEmail`** (NO `customerName`) o vía `customerId`.

### 3.12 CreditPack + CreditPackItem ◽ (paquetes de clases)

- **CreditPack**: `venueId`, `name`, `price` (+ `validityDays`, `maxPerCustomer`, `displayOrder`, `active`). `stripeProductId/stripePriceId`
  se crean _lazy_ en el primer checkout — déjalos null.
- **CreditPackItem**: `creditPackId`, `productId` (un producto `CLASS`), `quantity`. Único `(creditPackId, productId)` → cada producto
  aparece una vez por pack.

### 3.13 EcommerceMerchant ◽ (checkout / cobro online)

`venueId`, `businessName`, `contactEmail` (único), `publicKey` (único), `secretKeyHash` (único), `providerId`, `channelName`. Para cobro
**online real** (reservas con depósito / venta por checkout), `canVenueChargeOnline` exige un merchant **STRIPE_CONNECT** con
`chargesEnabled=true` (`resolveChargeableStripeMerchant`). Un merchant Blumon sandbox NO habilita ese cobro. La compra de credit packs NO lo
necesita (va por plataforma).

### 3.14 TPV: MerchantAccount + Terminal + VenuePaymentConfig ◽ (hardware)

No se clona el hardware. Para que una terminal cobre: activar un dispositivo físico al venue (flujo de `activationCode`) y asignarle un
`MerchantAccount` (`Terminal.assignedMerchantIds`, o vía `VenuePaymentConfig`/`OrganizationPaymentConfig`). Para demos, el founder lo hace
aparte. **Pendiente de investigar:** correr 2 builds de TPV apuntando a venues distintos (una terminal ya está anexada a un venue).

### 3.15 Opcionales 🔁

`LoyaltyConfig`, `ReferralProgramConfig`, branding (`paymentLinkBranding`, `reservationBranding`), payment links de demo, cliente demo con
saldo de créditos (para enseñar canje).

---

## 4. Helper de clonado (drift-proof)

Leer una fila de config de la plantilla y recrearla para el venue nuevo evita enumerar 200 columnas:

```ts
async function cloneSingletonConfig(model, venueId) {
  const src = await prisma[model].findUnique({ where: { venueId: TEMPLATE_VENUE_ID } })
  if (!src) return
  const { id, venueId: _v, createdAt, updatedAt, ...rest } = src
  await prisma[model].create({ data: { ...rest, venueId } })
}
// úsalo con: 'venueSettings', 'reservationSettings', 'loyaltyConfig'
```

Para filas con únicos extra (EcommerceMerchant: contactEmail/publicKey/secretKeyHash), **no** clones en crudo — crea con valores únicos
frescos.

---

## 5. Verificación (read-only, después de crear)

```sql
-- El venue existe y quedó onboarded
SELECT slug, status, "kycStatus", "entityType", type FROM "Venue" WHERE slug='<slug>';

-- Conteos del catálogo
SELECT
  (SELECT count(*) FROM "MenuCategory"  WHERE "venueId"='<id>') categories,
  (SELECT count(*) FROM "Product"       WHERE "venueId"='<id>') products,
  (SELECT count(*) FROM "ClassSession"  WHERE "venueId"='<id>') class_sessions,
  (SELECT count(*) FROM "CreditPack"    WHERE "venueId"='<id>') credit_packs,
  (SELECT count(*) FROM "StaffVenue"    WHERE "venueId"='<id>') staff,
  (SELECT count(*) FROM "VenueFeature"  WHERE "venueId"='<id>') features;

-- Horas de clase como las lee la app (stored=UTC → Mexico). Deben ser tus slots locales.
SELECT DISTINCT to_char(("startsAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Mexico_City','HH24:MI')
FROM "ClassSession" WHERE "venueId"='<id>' ORDER BY 1;
```

**API pública en prod** (prueba real del booking):

```bash
curl -s "https://api.avoqado.io/api/v1/public/venues/<slug>/info"          # venue + productos
curl -s "https://api.avoqado.io/api/v1/public/venues/<slug>/credit-packs"  # paquetes
curl -s "https://api.avoqado.io/api/v1/public/venues/<slug>/availability?productId=<CLASS_id>&type=class&date=YYYY-MM-DD"
# OJO: type es 'class' | 'appointment' (minúsculas).
```

**Si clonaste de una plantilla, prueba que la plantilla quedó INTACTA** (mismos conteos + hash):

```sql
SELECT md5(string_agg(id||name||price::text, ',' ORDER BY id)) FROM "Product" WHERE "venueId"='<template_id>';
```

---

## 6. Rollback / teardown

Un venue nuevo se borra con cascade (arrastra categorías, productos, sesiones, packs, settings, features, staff-links, reservas). Guarda el
`venueId` al crear.

```bash
DATABASE_URL="…" npx tsx scripts/seed-<x>.ts --teardown   # o:
```

```sql
DELETE FROM "Venue" WHERE slug='<slug>' AND id='<id>';   -- doble guarda por slug+id
```

Nunca borres por nombre parcial ni sin verificar el `id`.

---

## 7. Gotchas (aprendidos en vivo)

1. **`ts-node` mata el seed** contra DB remota (type-check en runtime, >2min). Usa **`tsx`**.
2. **Timezone**: `new Date('YYYY-MM-DD')` = medianoche en el TZ del host (prod=UTC) → día corrido. Usa
   `fromZonedTime('…', 'America/Mexico_City')`.
3. **KYC**: sin `kycStatus=VERIFIED` el venue se ve "en trámite".
4. **`ADVANCED_ANALYTICS`** está inactivo → no se prende (los 8 restantes sí).
5. **`canVenueChargeOnline`** = Stripe Connect, no Blumon. Credit packs van por plataforma igual.
6. **Reservation** usa `guestName/guestPhone`, no `customerName`.
7. **Product.sku** es único por venue; genera SKUs distintos.
8. **MenuCategoryAssignment** es la que engancha categoría↔menú; sin ella no aparece.
9. **Clonar filas** (temp/spread minus id/venueId/timestamps) es más seguro que enumerar columnas.
10. **`avoqado-empty`** existe como venue en blanco de referencia; `avoqado-full` como el "todo prendido".

---

## 7b. TPV demo money-safe: PROD backend + SANDBOX Blumon (patrón, con avoqado-fitness de ejemplo)

Objetivo: que una terminal TPV **cobre con tarjetas de prueba (sin dinero real)** pero que la venta **se refleje en el venue productivo**.
Se logra desacoplando el ambiente del **backend** del ambiente del **procesador Blumon**:

| Ambiente                                                        | Controla                                      | Valor para demo |
| --------------------------------------------------------------- | --------------------------------------------- | --------------- |
| Backend Avoqado (`API_ENV`)                                     | dónde viven órdenes/pagos y qué posId entrega | **PROD**        |
| Procesamiento Blumon (`BLUMON_ENV` + posId del MerchantAccount) | dónde ocurre el cargo                         | **SANDBOX**     |

**Backend (hecho para avoqado-fitness, 2026-07-07):** el `posId` que el TPV usa sale de `MerchantAccount.blumonPosId` (endpoint
`GET /tpv/terminals/:serial/config`, filtra por `blumonEnvironment`). Como el **autofetch de Blumon pega a la API PRODUCTIVA**, no puede
crear credenciales sandbox en prod → se **copia** un MerchantAccount sandbox que ya funciona desde el DEV local. Es portable porque el
Android desencripta con la llave default hardcodeada (`"default-key-change-in-production-use-env-var"`, `BlumonAuthManager.kt`), no con la
env key del backend. Script: `scripts/setup-avoqado-demo-tpv-sandbox.ts` (copia merchant + crea Terminal ACTIVE, idempotente, `--teardown`).
Ya en prod: merchant SANDBOX posId 387 (`cmrbewgsi0001c9hnhpv6l5nd`) + Terminal `AVQD-2841548418` en avoqado-fitness.

**TPV flavor `gymDemo` ("Avoqado Demo") — IMPLEMENTADO (avoqado-tpv, `main`, UNCOMMITTED, compila ✅):** NO toca `production`/`sandbox`.
Truco de desacople **sin tocar `NetworkModule`**: como `provideBaseUrl()` hace `if (BLUMON_ENV=="PROD") API_BASE_URL else API_BASE_URL_DEV`,
el flavor pone `BLUMON_ENV="SAND"` **y sobreescribe** `API_BASE_URL_DEV`/`SOCKET_URL_DEV` (que viven en `defaultConfig`) apuntándolos a
`api.avoqado.io` → resuelve a PROD solo para este flavor. Además: `OVERRIDE_TERMINAL_SERIAL="AVQD-2841548418"` (hook
`BuildConfig.DEBUG`-gated en `DeviceInfoManager.getSerialNumber()`, `""` en los demás flavors), `applicationIdSuffix=".demo"` (id propio →
coexiste con producción Y con el dev `sandbox` = **3 iconos** en un device; hubo que agregar un cliente `com.jaac.avoqado_tpv.demo` a
`app/google-services.json`, clonado del de sandbox — si usas `.sandbox` pisas el dev), `resValue app_name="Demo Prod"`, reusa
`src/sandbox/java`+`res` vía `sourceSets` + deps `gymDemoImplementation`. Compilar/instalar: `:app:assembleGymDemoDebug`. ⚠️ NUNCA
firmar/subir este flavor. `production`/`sandbox`/`nexgo*` quedan byte-idénticos (verificado por BuildConfig generado).

**⚠️ Consecuencia documentada:** los pagos sandbox de ese terminal **NO reconcilian** con Blumon PROD (`scripts/mcp-money-reconcile.ts`,
webhooks) — es **ESPERADO, no un bug**. Ver la nota de memoria `avoqado-fitness-prod-sandbox-tpv` para que una investigación de errores
futura no lo "arregle". Un `MerchantAccount` SANDBOX en prod es intencional SOLO para este venue demo.

## 8. Pendientes / lo que aún NO queda al 100%

- [x] **TPV backend money-safe** (§7b): merchant SANDBOX + Terminal creados en prod para avoqado-fitness.
- [x] **TPV flavor `gymDemo`** (§7b): implementado en avoqado-tpv (UNCOMMITTED, compila ✅), variants normales byte-idénticos.
- [ ] **Build + instalar** `:app:assembleGymDemoDebug` en el device del demo (y decidir commit del flavor).
- [ ] **Cobro online real** (Stripe Connect) para reservas con depósito / checkout de membresías.
- [ ] **Logo + hero image** por industria (branding visual del widget/página pública).
- [ ] **Cliente demo con saldo de créditos** sembrado para enseñar el flujo de canje.
- [ ] Confirmar lista completa de features/módulos "ideales" por tipo de industria (gym vs salón vs retail).
- [ ] ¿Org nueva vs org compartida? — definir criterio (aislamiento vs simplicidad).
- [ ] Automatizar como script parametrizable por industria (hoy hay uno por caso: `seed-avoqado-fitness-demo.ts`).

```

```
