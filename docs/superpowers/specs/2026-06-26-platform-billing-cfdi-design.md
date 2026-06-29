# Platform Billing CFDI — Avoqado factura a sus propios clientes

**Fecha:** 2026-06-26 **Estado:** Diseño aprobado (pendiente revisión del spec → plan de implementación) **Repos afectados:**
`avoqado-server` (backend + schema), `avoqado-superadmin` (UI) **Autor del diseño:** sesión de brainstorming con el founder

---

## 1. Problema

Hoy Avoqado tiene **dos relaciones de facturación distintas**:

1. **Tenant → consumidor** (ya existe en código, `src/services/fiscal/`): cada venue/org puede timbrar CFDIs a SUS clientes vía Facturapi.
   El emisor es el venue (`FiscalEmisor.venueId`). Flujos A (autofactura), B (staff), C (global).
2. **Avoqado → cliente** (NO existe): Avoqado, como empresa, necesita timbrarle un CFDI a **sus propios clientes** por:

   - la mensualidad de la suscripción (ej. $1,599 MXN + IVA),
   - setup / otros servicios,
   - **ventas de TPV (hardware)** — incluso a compradores que **NO están dados de alta como venue**.

   El cobro puede ser **por Stripe o por fuera** (efectivo / transferencia / etc.). Hoy Stripe genera **su propia factura de Stripe**, que
   **NO es un CFDI válido ante el SAT**, y las ventas por fuera no tienen ningún CFDI.

Este spec cubre **únicamente la relación #2**.

### Hallazgos de verificación (producción, solo-lectura, 2026-06-26)

| Qué se buscó                                         | Resultado     |
| ---------------------------------------------------- | ------------- |
| Emisores configurados (`FiscalEmisor`)               | **0**         |
| CFDIs emitidos (`Cfdi`)                              | **0**         |
| Feature "CFDI" sembrado                              | **No existe** |
| Perfiles fiscales de receptor (`CustomerTaxProfile`) | **0**         |
| Facturas internas (`Invoice`)                        | 1 (semilla)   |

**Conclusión:** el motor de CFDI existe en código y las tablas están en prod, pero está **dormido** — nunca se ha timbrado desde
avoqado-server, y **Avoqado no está dado de alta como emisor**. La facturación actual "para otras empresas" corre fuera de este backend
(panel de Facturapi directo u otra herramienta). Las llaves `FACTURAPI_USER_KEY` / `FISCAL_PROVIDER_KEY` viven solo en Render (prod), no en
`.env` local.

---

## 2. Decisiones tomadas (brainstorming)

| #   | Pregunta                           | Decisión                                                                                                                                                                               |
| --- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | ¿Cómo se generan las facturas?     | **Manual a demanda** (MVP). Auto-timbrado con Stripe = fase 2.                                                                                                                         |
| 2   | ¿Receptor es org, venue o externo? | **Mixto**: `Organization`, `Venue`, **o un receptor externo (STANDALONE)** no dado de alta — p.ej. comprador de TPV.                                                                   |
| 3   | Datos fiscales del receptor        | El cliente **puede no tener constancia dada de alta** → superadmin la **captura a mano** (con o sin subir el PDF). Aplica también a receptores STANDALONE. Requisito de primera clase. |
| 4   | ¿Qué conceptos?                    | **Líneas libres + presets** ("Mensualidad 1599+IVA", "Venta TPV"). Claves SAT por defecto, sobreescribibles. Soporta servicios **y** bienes (hardware).                                |
| 5   | Alta del emisor Avoqado            | **Pantalla de alta dentro del módulo** (reusa `fiscalOnboarding`: createOrganization + uploadCsd) **y** opción de pegar `providerOrgId`/key si se crea directo en el panel.            |
| 6   | Arquitectura                       | **Opción A: módulo dedicado que reusa el motor.** Tablas nuevas, reusa la capa de proveedor/cifrado/IVA.                                                                               |
| 7   | Método de pago                     | **Soporta PUE y PPD**, elegido por factura (_"¿ya me pagó?"_). PPD incluye **Complemento de Pago (REP, CFDI tipo P)** al recibir el pago. Ver §7.                                      |
| 8   | Cobro (Stripe o por fuera)         | `formaPago` es **selector completo del catálogo c_FormaPago** (efectivo/transferencia/tarjeta/etc.), **no atado a Stripe**.                                                            |

---

## 3. Arquitectura (Opción A)

Módulo dedicado de **platform billing** que **reusa la parte cara** del motor fiscal existente pero con tablas propias, para no contaminar
el aislamiento multi-tenant (regla: _cada query filtra por `venueId`_) ni acoplarse a `Order`.

Tres modelos nuevos que **espejan** los existentes:

| Nuevo (plataforma)  | Espeja a             | Qué guarda                                                          |
| ------------------- | -------------------- | ------------------------------------------------------------------- |
| `PlatformEmisor`    | `FiscalEmisor`       | RFC + CSD + org Facturapi **de Avoqado** (≈ singleton)              |
| `PlatformCfdi`      | `Cfdi`               | Cada CFDI emitido a un cliente (ingreso **y** complementos de pago) |
| `BillingTaxProfile` | `CustomerTaxProfile` | Datos fiscales del receptor (org, venue **o externo**)              |

Nombre `PlatformCfdi` (no `PlatformInvoice`) para no chocar con el modelo `Invoice` interno y señalar "es un CFDI".

### Reuso explícito (capa de proveedor, venue-agnóstica)

- `FacturapiProvider` — `createInvoice` (tipo **I** ingreso y tipo **P** pago/REP), `cancelInvoice`, `getInvoice`, `downloadXml/Pdf`,
  `createOrganization`, `updateOrgLegal`, `uploadCsd`
- `fiscalKey.service` — `encryptProviderKey` / `decryptProviderKey` (AES-256-GCM con `FISCAL_PROVIDER_KEY`)
- `ivaMath.ts` — cálculo de IVA
- `cfdiValidation.ts` — validación de RFC / CP / régimen del receptor
- `satCatalogLookup.service.ts` — validación de claves producto/unidad (opcional)
- Patrón `fiscalProvider.factory` — adaptado para resolver desde `PlatformEmisor`

---

## 4. Modelo de datos (Prisma) — **schema additivo, 3 tablas + 3 enums, cero cambios a tablas existentes**

### `PlatformEmisor` (Avoqado como emisor)

```
id                String   @id @default(cuid())
rfc               String
legalName         String
regimenFiscal     String          // c_RegimenFiscal (3 dígitos)
lugarExpedicion   String          // CP del emisor
provider          FiscalProviderType @default(FACTURAPI)   // enum existente
providerOrgId     String?         // org en Facturapi
providerKeyEnc    String?         // live key cifrada (fiscalKey.service)
csdStatus         CsdStatus @default(NONE)                  // enum existente
csdExpiresAt      DateTime?
csdLastCheckedAt  DateTime?
serie             String   @default("A")
defaultUsoCfdi    String?         // típicamente null; lo fija el receptor
isActive          Boolean  @default(true)
createdAt/updatedAt
```

Reusa enums `FiscalProviderType` y `CsdStatus`. Es ≈ singleton, pero como tabla por si en el futuro hay >1 RFC emisor.

### `BillingTaxProfile` (receptor = cliente de Avoqado: org, venue o externo)

```
id               String   @id @default(cuid())
customerType     BillingCustomerType         // ORGANIZATION | VENUE | STANDALONE
organizationId   String?  // set si customerType=ORGANIZATION
venueId          String?  // set si customerType=VENUE   (STANDALONE = ambos null)
displayName      String?  // etiqueta para STANDALONE (no ligado a org/venue), ej. "Venta TPV - Juan Pérez"
rfc              String
razonSocial      String
regimenFiscal    String   // c_RegimenFiscal
codigoPostal     String   // CP del receptor
defaultUsoCfdi   String   @default("G03")   // Gastos en general (fees); ventas de bien pueden usar otra
email            String?
constanciaUrl    String?  // PDF de constancia en Firebase Storage (buildStoragePath); OPCIONAL
validationStatus String   @default("PENDING")  // PENDING | VALID | INVALID
validatedAt      DateTime?
createdByStaffId String?  // quién lo capturó
createdAt/updatedAt

@@unique([organizationId])   // 1 perfil por org
@@unique([venueId])          // 1 perfil por venue
// STANDALONE: dedupe por RFC en el service (o índice único parcial: WHERE customerType='STANDALONE')
```

**Captura 100% manejable desde superadmin.** No depende de que el cliente lo haya dado de alta. Se puede:

- Capturar **a mano** todos los campos para un venue/org **sin ningún dato fiscal previo**, o para un **receptor externo** (comprador de TPV
  no dado de alta).
- Subir la constancia (PDF) como respaldo — **opcional**; en MVP **no** se hace OCR, los campos se teclean.
- Editar/reutilizar el perfil para futuras facturas (los STANDALONE se reusan buscando por RFC).

### `PlatformCfdi` (el CFDI emitido — ingreso o complemento de pago) — espeja los campos snapshot de `Cfdi`

```
id                String   @id @default(cuid())
platformEmisorId  String
billingTaxProfileId String?         // perfil usado; en MVP siempre se persiste/upsertea uno (nullable solo defensivo)

type              PlatformCfdiType @default(INGRESO)   // INGRESO (I) | PAGO (P, complemento)
parentPlatformCfdiId String?        // si type=PAGO: apunta a la factura de ingreso (PPD) que liquida

// destinatario (denormalizado para listado/filtro). STANDALONE → ambos null (se usa billingTaxProfileId + snapshot).
organizationId    String?
venueId           String?

// SNAPSHOT del receptor al momento de timbrar (inmutable) — espeja Cfdi
receptorRfc       String
receptorNombre    String
receptorRegimen   String
receptorCp        String
usoCfdi           String

// conceptos: JSON en MVP (tabla hija = mejora futura). Solo type=INGRESO. Soporta servicios y bienes.
lines             Json?    // [{ description, claveProdServ, claveUnidad, quantity, unitPriceCents, taxRate }]

formaPago         String   // catálogo c_FormaPago completo. INGRESO PUE: forma real. INGRESO PPD: "99". PAGO: forma real del pago.
metodoPago        String   @default("PUE")   // PUE | PPD  (solo type=INGRESO)

subtotalCents     Int      @default(0)
discountCents     Int      @default(0)
taxCents          Int      @default(0)
totalCents        Int      @default(0)
currency          String   @default("MXN")

amountPaidCents   Int      @default(0)   // solo INGRESO PPD: suma de REPs aplicados
paymentInfo       Json?    // solo type=PAGO (REP): { fechaPago, formaPago, montoCents, parcialidad, saldoAnterior, saldoInsoluto }

status            PlatformCfdiStatus @default(DRAFT)
facturapiId       String?
uuid              String?  @unique   // folio fiscal (timbre)
serie             String?
folio             Int?
stampedAt         DateTime?
xmlUrl            String?
pdfUrl            String?

cancelStatus        String?
cancelMotivo        String?
cancelSubstituteUuid String?

idempotencyKey    String?  @unique
emailSentAt       DateTime?
createdByStaffId  String
createdAt/updatedAt

@@index([organizationId])
@@index([venueId])
@@index([status])
@@index([type])
@@index([parentPlatformCfdiId])
@@index([createdAt])
```

**Dinero en centavos (Int), MXN** — igual que `Cfdi`. Nunca float. **Estado de pago de una factura PPD** (`PENDING` / `PARTIAL` / `PAID`) se
**deriva** de `amountPaidCents` vs `totalCents` en el service/UI — no se guarda como enum.

### Enums nuevos

```
enum PlatformCfdiStatus {
  DRAFT
  STAMPING
  STAMPED
  STAMP_FAILED
  CANCEL_REQUESTED
  CANCELLED
}

enum PlatformCfdiType {
  INGRESO   // CFDI tipo I (la factura)
  PAGO      // CFDI tipo P (complemento de pago / REP)
}

enum BillingCustomerType {
  ORGANIZATION
  VENUE
  STANDALONE   // receptor externo no dado de alta (ej. venta de TPV)
}
```

### Regla obligatoria de schema-map

Al agregar los 3 modelos: añadir `PlatformEmisor`, `BillingTaxProfile`, `PlatformCfdi` al mapa `MODEL_TO_DOMAIN` en
`scripts/generate-schema-map.ts` (dominio fiscal/billing) y correr `npm run schema:map`. Stagear `generate-schema-map.ts` +
`docs/SCHEMA_MAP.md` en el MISMO commit del schema.

Migración: **`npx prisma migrate dev --name add_platform_billing_cfdi`** (NUNCA `db push`). Aditiva, tablas vacías → se aplica en prod sin
downtime ni backfill.

---

## 5. Backend

Ubicación: `src/services/superadmin/platform-billing/`

- `platformEmisor.service.ts` — CRUD legal + provision (createOrganization + updateOrgLegal) o set manual de `providerOrgId`/key + uploadCsd
- `billingTaxProfile.service.ts` — upsert (captura manual, incl. STANDALONE), subir constancia (`buildStoragePath`), búsqueda de clientes
  facturables (orgs + venues + standalone por RFC)
- `platformCfdi.service.ts` — `issueIncome` (PUE/PPD), `registerPayment` (emite REP tipo P), `list`, `get`, `cancel`, `resendEmail`. Valida
  receptor → arma payload → `FacturapiProvider.createInvoice` con la key del `PlatformEmisor` descifrada → persiste + snapshot → ActivityLog

Controller: `src/controllers/superadmin/platformBilling.controller.ts` Rutas: `/api/v1/superadmin/billing/*` (el namespace que el superadmin
ya consume)

| Método + ruta                                                      | Propósito                                                        |
| ------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `GET /superadmin/billing/emisor`                                   | Emisor Avoqado + estado CSD                                      |
| `PUT /superadmin/billing/emisor`                                   | Crear/actualizar datos legales                                   |
| `POST /superadmin/billing/emisor/provision`                        | Provisionar en Facturapi **o** pegar org/key existente           |
| `POST /superadmin/billing/emisor/csd`                              | Subir CSD (.cer/.key/contraseña)                                 |
| `GET /superadmin/billing/customers?type=org\|venue\|standalone&q=` | Buscar clientes facturables + si tienen perfil                   |
| `POST /superadmin/billing/customers/standalone`                    | **Crear receptor externo** (no ligado a org/venue)               |
| `GET /superadmin/billing/customers/:type/:id/tax-profile`          | Leer perfil fiscal                                               |
| `PUT /superadmin/billing/customers/:type/:id/tax-profile`          | **Upsert manual** del perfil (caso "venue/externo sin datos")    |
| `POST /superadmin/billing/customers/:type/:id/constancia`          | Subir constancia (opcional)                                      |
| `POST /superadmin/billing/invoices`                                | Crear + timbrar factura de ingreso (PUE/PPD)                     |
| `GET /superadmin/billing/invoices`                                 | Listar (filtros: status, tipo, cliente, fecha, pago pendiente)   |
| `GET /superadmin/billing/invoices/:id`                             | Detalle (incluye REPs hijos)                                     |
| `POST /superadmin/billing/invoices/:id/payments`                   | **Registrar pago → timbra complemento de pago (REP)** (solo PPD) |
| `POST /superadmin/billing/invoices/:id/cancel`                     | Cancelar (motivo)                                                |
| `GET /superadmin/billing/invoices/:id/pdf` · `/xml`                | Descargar                                                        |
| `POST /superadmin/billing/invoices/:id/email`                      | (Re)enviar al correo del receptor                                |

Validación: Zod, **mensajes en español** (regla del repo). Shape-only en schema; reglas de negocio en el service.

---

## 6. Frontend — `avoqado-superadmin/src/features/billing/`

Sigue el patrón de `subscriptions` (`api.ts` / `types.ts` / `use-billing.ts` con TanStack Query / pages). Axios a
`/api/v1/superadmin/billing/*` (cookies httpOnly, sin Bearer).

Pantallas:

- **`BillingPage`** — lista de CFDIs emitidos + KPIs + botones "Nueva factura" / "Configurar emisor". Columna/badge de **estado de pago**
  para PPD (Pendiente / Parcial / Pagada).
- **`EmisorSetupPage`** — alta de Avoqado: datos legales + subir CSD **o** pegar org/key + estado del CSD
- **`NewInvoiceDialog`** — elegir cliente: buscar org/venue **o crear receptor externo (STANDALONE)** → **si no tiene `BillingTaxProfile`,
  formulario inline de captura manual** (+ constancia opcional) → líneas libres o presets ("Mensualidad 1599+IVA" / "Venta TPV") →
  **selectores por factura**: `formaPago` (catálogo), `serie` (default emisor), `usoCfdi` (default receptor) + **toggle "¿Ya me pagó?"**
  (PUE / PPD) → timbrar
- **`InvoiceDetailDrawer`** — detalle, descargar PDF/XML, cancelar, reenviar correo. Si es **PPD**: sección "Pagos" con **"Registrar pago"**
  (→ REP) y los complementos ya emitidos.

* ruta en `router.tsx`, nav en `AppLayout.tsx` (grupo nuevo "Facturación" o bajo "Catálogo"). Respeta `.impeccable.md` (dark, tabular-nums
  para montos, badges de estado).

---

## 7. Flujos y manejo de pago (PUE / PPD / impago)

### 7.1 Regla fiscal

- **PUE (Pago en una sola exhibición)** — usar cuando **ya cobraste** (mismo periodo). `metodoPago=PUE`, `formaPago` = método real (`01`
  efectivo, `03` transferencia, `04` tarjeta vía Stripe, etc.). Un solo documento, **sin** complemento.
- **PPD (Pago en parcialidades o diferido)** — usar cuando **aún NO te pagan** al timbrar, o pagarán en otro mes / parcialidades.
  `metodoPago=PPD`, `formaPago="99"` (Por definir). **Obliga** a emitir un **Complemento de Pago (REP, CFDI tipo P)** cuando se reciba el
  pago, a más tardar el día 5 del mes siguiente.

### 7.2 Timbrar factura de ingreso (happy path)

1. "Nueva factura" → elegir cliente: org/venue existente **o** crear receptor externo (STANDALONE).
2. **¿Sin perfil fiscal?** → formulario inline: RFC, razón social, régimen, CP, uso CFDI, email + (opcional) subir constancia. Se guarda
   como `BillingTaxProfile` para reuso.
3. Agregar líneas o presets:
   - **"Mensualidad 1599+IVA"** — servicio. Defaults: clave `81161700`, unidad `E48 Servicio`, IVA 16%. Toma **1599 como base (pre-IVA)**:
     `unitPriceCents=159900`, IVA = `25584`, total = `185484` ($1,854.84). IVA **add-on** (no inclusivo, a diferencia de Stripe que es
     IVA-inclusive).
   - **"Venta TPV"** — bien/hardware. Unidad `H87 Pieza`, clave de terminal punto de venta (a confirmar §11), precio capturable.
4. **Selector de `formaPago`** (catálogo completo) + **toggle "¿Ya me pagó?"**: Sí → PUE. No → PPD + formaPago 99.
5. Backend valida receptor → arma payload tipo I → `FacturapiProvider.createInvoice` → persiste `PlatformCfdi` (STAMPED + uuid + xml/pdf) →
   **ActivityLog**.
6. UI muestra el CFDI: descargar PDF/XML + "Enviar por correo".

### 7.3 Registrar pago de una PPD → Complemento de Pago (REP)

1. En el detalle de una factura PPD, "Registrar pago": fecha, monto, forma de pago (real), parcialidad.
2. Backend calcula `saldoAnterior`/`saldoInsoluto`, arma payload **tipo P** referenciando el `uuid` de la factura origen →
   `FacturapiProvider.createInvoice(type=P)` → persiste un `PlatformCfdi` hijo (`type=PAGO`, `parentPlatformCfdiId`) → suma a
   `amountPaidCents` del padre → **ActivityLog** `PLATFORM_PAYMENT_RECEIVED`.
3. Estado de pago del padre se recalcula (Pendiente/Parcial/Pagada).

### 7.4 "Facturé y no me paga"

- **Si fue PUE**: afirmaste un pago inexistente → **cancelar** el CFDI (motivo 02/04 según caso). Mientras no se cancele, hay IVA/ISR sobre
  ingreso no cobrado. _(El UI puede advertir esto al elegir PUE.)_
- **Si fue PPD**: **no se emite ningún REP** (correcto, no hubo pago). La factura queda "Pendiente". Si es incobrable, se maneja como cuenta
  incobrable en contabilidad o se cancela. **Este es el flujo recomendado para "facturo antes de cobrar".**

### 7.5 Cancelar

`FacturapiProvider.cancelInvoice(motivo)`. Motivo `01` requiere `cancelSubstituteUuid`. Persiste `cancelStatus` + ActivityLog
`PLATFORM_CFDI_CANCELLED`.

### 7.6 Idempotencia / orphan recovery

`idempotencyKey` por intento (espeja `Cfdi`). Si Facturapi timbra pero el guardado local falla → reconciliar por `external_id` /
`findByExternalId` (mismo patrón que `cfdiReconcile.service`).

---

## 8. Cumplimiento de reglas críticas

- **Tier-gating:** módulo **interno de superadmin** (Avoqado factura a SUS clientes) → **NO lleva tier FREE/PRO/PREMIUM**. Distinto del
  Feature `CFDI` (venues→consumidores). Pregunta obligatoria de tier: respondida conscientemente = _sin tier, back-office interno_.
- **ActivityLog (obligatorio):** cada mutación escribe su fila — `PLATFORM_EMISOR_PROVISIONED`, `PLATFORM_CSD_UPLOADED`,
  `PLATFORM_TAXPROFILE_UPSERTED`, `PLATFORM_CFDI_ISSUED`, `PLATFORM_PAYMENT_RECEIVED` (REP), `PLATFORM_CFDI_CANCELLED`. `staffId` desde
  `authContext`, `venueId` cuando aplique (factura a venue; STANDALONE/org → null), `data` con contexto. `logAction` fire-and-forget fuera
  de transacción.
- **MCP:** el customer MCP (`src/mcp/`) es tenant-scoped (`getUserAccess`) → **no aplica** (esto es founder-ops, no scoped por tenant).
  Lugar correcto = **Admin MCP** (`scripts/mcp/`, rama `feat/admin-mcp`, lifecycle aparte) como **follow-up**, NO en este cambio.
  Documentado para no saltar la regla a ciegas.
- **Presentación de ventas:** back-office interno, sin capacidad visible al cliente → **exento**.
- **Permisos:** nuevos `billing:configure`, `billing:issue`, `billing:view`, default SUPERADMIN, registrados en `permissions.ts`
  (`DEFAULT_PERMISSIONS` + `INDIVIDUAL_PERMISSIONS_BY_RESOURCE`); correr `npm run audit:permissions`.
- **Money = Int centavos / Decimal**, **tenant isolation** intacto (justo por elegir A), **Zod español**, **`migrate dev` no `db push`**,
  **schema-map** actualizado.

---

## 9. Fuera de alcance (YAGNI — MVP)

- Auto-timbrado disparado por Stripe (`invoice.payment_succeeded`) → **fase 2**.
- Vincular la venta de TPV con un `TpvOrder` existente (MVP: la línea de hardware es libre, sin ligarse al módulo tpv-orders).
- Notas de crédito (egreso) más allá de cancelar.
- Recurrencias / programación automática.
- Tabla hija `PlatformCfdiItem` (MVP usa `lines: Json`).
- OCR de la constancia (se teclea; PDF solo se guarda).
- Contabilidad automática de cuentas incobrables / recuperación de IVA por impago (es tema contable, no de emisión).
- Portal self-service del cliente.

> **EN ALCANCE (ya no YAGNI):** PUE **y** PPD + Complemento de Pago (REP); receptor **STANDALONE** (venta de TPV a no-venues); `formaPago`
> de catálogo completo (Stripe o por fuera). Todo reusa `FacturapiProvider`.

---

## 10. Prerrequisitos

- **CSD de Avoqado** (.cer/.key/contraseña) + RFC + régimen fiscal + CP de lugar de expedición.
- Confirmar `FACTURAPI_USER_KEY` y `FISCAL_PROVIDER_KEY` en Render prod (al provisionar el emisor se valida en vivo).
- Clave SAT de la terminal TPV (bien) + uso CFDI típico para venta de bien.

---

## 11. Decisiones de runtime (resueltas)

**Decisión del founder:** todo lo fiscal se **elige durante la creación de cada factura**, con defaults editables — no como config global
fija. Por lo tanto:

| Antes "abierto"                  | Resuelto como                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| PUE vs PPD                       | **Toggle por factura** ("¿Ya me pagó?"). Sin flujo dominante fijo.                                                       |
| `formaPago`                      | **Selector por factura** (catálogo c_FormaPago completo). Default sugerido `04` (Stripe), editable; PPD fuerza `99`.     |
| Serie                            | **Selector por factura** con default del emisor (`A`). Permite serie distinta para mensualidad vs venta TPV si se desea. |
| Uso CFDI                         | **Selector por factura** con default del receptor (`G03`).                                                               |
| Clave SAT / unidad de cada línea | Editable por línea; presets traen defaults ("Mensualidad" → `81161700`/`E48`; "Venta TPV" → terminal/`H87`).             |

**Defaults de preset (editables al crear, confirmar clave TPV con contador):**

- Mensualidad: clave `81161700`, unidad `E48 Servicio`, IVA 16% add-on.
- Venta TPV: clave `43211902` (Terminales de punto de venta — **confirmar**), unidad `H87 Pieza`.

**Constancia:** se guarda indefinidamente (respaldo).

**No bloqueante:** se asume que la facturación actual "para otras empresas" corre fuera de avoqado-server (panel Facturapi); este módulo es
independiente y no activa el motor tenant.
