# Subir ventas aprobadas fuera de TPV — Design Spec

**Fecha:** 2026-07-07 · **Autor:** Jose Amieva (con Claude) · **Estado:** Diseño (para revisión) **Asana:**
[Subir ventas aprobadas fuera de TPV](https://app.asana.com/1/12709793723059/project/1213523434401320/task/1216210416581285) (Bait ↔ Play
Telecom, [Dashboard], Alta) **Cliente:** PlayTelecom (Isaac Mayoral, org OWNER)

## 1. Problema

Los promotores nuevos no reciben TPV hasta ~1 mes; los cubre-descansos a veces venden sin TPV. Esas ventas **reales nunca entran a
Avoqado**: el SIM sigue marcado `AVAILABLE`, no hay Order/Payment/SaleVerification, y no aparecen en Ventas/KPIs/comisiones. Isaac tiene un
backlog (**342 transacciones**, may-jul) y estima **~35 ventas/semana** recurrentes.

Hoy **NO existe** forma de crear una venta serializada fuera del TPV: `markAsSold` sólo se llama desde `src/services/tpv/`. El único
precedente es un script de una-sola-vez (`scripts/temp-mark-sim-sold.ts`) que sólo volteaba el status del inventario **sin** crear la venta
→ invisible en reportes. Este feature lo resuelve bien.

## 2. Decisiones confirmadas (con el founder, 2026-07-07)

1. **Captura = subir Excel/CSV** (template). No formulario una-por-una. Sirve para el backlog de 342 y el flujo recurrente.
2. **Estado = COMPLETED directo.** Son "ventas aprobadas"; entran a Ventas/KPIs/comisiones sin revisión extra (NO PENDING).
3. **Gating = permiso (OWNER) + módulo `SERIALIZED_INVENTORY`.** NO es tier de plan (es ops interno del white-label). No se toca
   FREE/PRO/PREMIUM.

## 3. Prerrequisitos (confirmados por Isaac)

- Los SIMs vendidos **ya están cargados** en Avoqado como `AVAILABLE`.
- Los vendedores **ya existen** como usuarios (aunque no tengan TPV).
- Las tiendas ya existen como venues del org.

→ El feature **resuelve/valida** contra registros existentes; **no** crea SIMs, usuarios ni tiendas.

## 4. Formato del archivo (basado en el Excel real de Isaac)

Columnas usadas (las demás se ignoran):

| Columna                                                    | Uso                                                                     | Resuelve a                                                                                                               |
| ---------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **ID SIM** (ICCID)                                         | identifica el SIM                                                       | `SerializedItem` por `serialNumber` (case-insensitive), debe estar `AVAILABLE` en el org                                 |
| **ID Promotor** (código, ej. BSCLOXH0405)                  | vendedor                                                                | `Staff` (por `employeeCode`; fallback nombre)                                                                            |
| **ID Tienda** (número, ej. 2485) / **Nombre de la Tienda** | tienda donde se vendió                                                  | `Venue` del org (número en el nombre / slug)                                                                             |
| **Fecha**                                                  | fecha de venta                                                          | `soldAt` + `Order.createdAt` (venue-local → UTC vía `fromZonedTime`)                                                     |
| **Tipo de Venta** (Línea nueva / Portabilidad)             | `SaleVerification.isPortabilidad` (Portabilidad→true)                   |
| **Tipo de SIM** / **Categoría**                            | categoría del item                                                      | `ItemCategory` (match por nombre, case-insensitive; ver [[project-playtelecom-sim-saletype-tables]] para el vocabulario) |
| **Forma de Pago**                                          | `Payment.method` (Efectivo→CASH, Tarjeta→CARD…, **"No aplica"→ver §6**) |
| **Monto de Venta**                                         | `Payment.amount` en pesos (**"No aplica"→0**, ver §6)                   |

Se ofrece un **template descargable** con exactamente estas columnas. `Estado Avoqado` y `Sucursal Avoqado` (dónde está hoy el SIM) son
informativas; la venta se atribuye a **Nombre de la Tienda** (dónde se vendió), no a Sucursal Avoqado.

## 5. Arquitectura

### 5.1 Backend (`avoqado-server`)

Endpoint nuevo, org-scoped: `POST /api/v1/dashboard/organizations/:orgId/manual-sales/bulk` (permiso `manual-sales:create`,
`requireOrgOwner`, módulo SERIALIZED_INVENTORY).

**Dos fases (confirm-gate, como el resto del MCP/back-office):**

1. **Preview (dry-run):** valida cada renglón y devuelve `{ crear: [...], omitir: [...], error: [...] }` con motivo por renglón. No escribe.
2. **Apply (`confirm:true`):** por cada renglón válido, en **una transacción por venta** (no una gigante — aísla fallos):
   - Resolver ICCID→SerializedItem (AVAILABLE, org), vendedor→Staff, tienda→Venue, categoría→ItemCategory.
   - Crear `Order` (`type: MANUAL_ENTRY`, `source: DASHBOARD_MANUAL` o nuevo `EXTERNAL_SALE`), `OrderItem` (el SIM), `Payment` (monto,
     method, `source`, sin pasar por Blumon).
   - `markAsSold(venueId, serial, orderItemId, tx, { staffId: vendedor })` → status SOLD + custodyState SOLD + soldAt + sellingVenueId.
   - Crear `SaleVerification` **status=COMPLETED** (reviewedBy=actor, reviewedAt=now, isPortabilidad, serialNumbers=[ICCID]). Reusar la
     forma de `createPendingSaleVerification` pero aterrizando COMPLETED.
   - `logAction` ActivityLog `MANUAL_SALE_CREATED` + `SerializedItemCustodyEvent` (MARKED_SOLD) — dual-write.

**Reusar (no reinventar):** patrón `MANUAL_ENTRY` de `manualPayment.service.ts`; `serializedInventoryService.markAsSold`; la creación de
SaleVerification de `sale-verification.service.ts`; resolución de categoría case-insensitive.

**Idempotencia:** si el ICCID ya está SOLD → renglón a `omitir` (motivo "ya vendido"), nunca duplica. Re-subir el mismo archivo es seguro.

### 5.2 Frontend (`avoqado-web-dashboard`)

- Nueva entrada en el dashboard org de PlayTelecom (junto a "Ventas" / en Control de Stock): **"Subir ventas fuera de TPV"**,
  `PermissionGate` + módulo.
- Reusar `BulkUploadSection` (drag & drop CSV/Excel ya existe para stock).
- Flujo: subir archivo → **tabla de preview** (por renglón: crear ✅ / omitir ⏭️ / error ❌ con motivo) → botón "Crear N ventas" →
  **resumen** (creadas/omitidas/errores, descargable).
- Botón **"Descargar template"**.

### 5.3 MCP (regla de lockstep)

Tool nuevo `record_serialized_sale` (una venta, confirm-gated) en `src/mcp/tools/` — el MCP registra de a una; el bulk vive en el dashboard.
Honra los invariantes MCP (permiso, venueFilter, audit, pesos 1:1, fechas venue-local, confirm-gate).

## 6. Casos borde (decisiones)

- **Monto/Forma de pago = "No aplica"** (común en "SIM de intercambio"): son ventas **sin dinero**. → Crear la venta con
  `Payment.amount = 0` y `method` = un valor "N/A"/`OTHER`. La venta cuenta para inventario/comisiones/reportes de unidades, con monto $0.
  **(Confirmar en revisión.)**
- **ICCID no existe / no está AVAILABLE / es de otro org** → renglón `error`, no se crea.
- **Vendedor o tienda no existe** → renglón `error` con el valor que no resolvió.
- **Renglones duplicados en el archivo** (mismo ICCID) → se colapsan; se crea una, el resto `omitir`.
- **Fecha inválida** → error de renglón (no rompe el lote).

## 7. Fuera de alcance (YAGNI)

- Crear SIMs, usuarios o tiendas (prerrequisito del cliente).
- Timbrado CFDI de estas ventas (si se requiere después, se engancha aparte).
- Editar/borrar una venta ya subida (para corregir se usa el flujo existente `editOrgSaleVerification`; borrar = fuera de alcance v1).
- Evidencia/foto por venta (Isaac la tiene aparte; opcional a futuro).

## 8. Backlog de 342

Se cargan **con este mismo feature** (subir el `Ventas no en Avoqado.xlsx`), una vez construido — no con script SQL a mano. Verificado: las
342 están todas `AVAILABLE` hoy (0 traslape con las 73 de Cubre Descanso ya reasignadas).

## 9. Permiso (mirror completo)

Nuevo `manual-sales:create` (o reusar `sale-verifications:create` si se prefiere): catálogo `INDIVIDUAL_PERMISSIONS_BY_RESOURCE` +
`DEFAULT_PERMISSIONS` (OWNER, SUPERADMIN) + gate backend + `PermissionGate` dashboard + `npm run audit:permissions` = 0.

## 10. Pruebas

- Unit: resolución (ICCID/vendedor/tienda/categoría), idempotencia (ya SOLD → skip), monto "No aplica"→0, fecha venue-tz→UTC.
- API: bulk preview + apply, permiso (no-OWNER→403), cross-org→403, reconciliación (N creadas = N SOLD nuevas + N SaleVerification
  COMPLETED).
- Regresión: no romper el flujo TPV `markAsSold` ni `editOrgSaleVerification`.

## 11. Orden de deploy

Backend (endpoint + permiso + MCP) → estable → dashboard (upload UI). Aditivo, sin quitar campos.
