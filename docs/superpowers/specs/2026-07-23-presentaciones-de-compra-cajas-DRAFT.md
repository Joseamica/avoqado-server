# Conversión de unidades por producto (compra ≠ salida) — CEDIS / inventario

> **DRAFT actualizado 2026-07-24** con la respuesta del cliente (Barbara, WhatsApp).
> El requerimiento quedó CLARO: **conversión de unidades por producto**, entrada en la unidad
> del proveedor, salida en la que requiere el consumidor. Verificado contra código y contra
> PostgreSQL de producción. Queda UNA pregunta de alcance abierta (§4b: ¿toca el POS de venta?).

## 1. Context — en palabras del cliente

> "Básicamente es conversión de unidades. Entrada o compra con base en la unidad de medida del
> proveedor, y salida o venta con base en la unidad de medida que requiere el cliente.
> Ejemplo: compro 50 **cajas** de huevo, la salida sería en **cono, caja y kilos**."

El CEDIS compra al mayoreo en una unidad y despacha/consume en otra(s). El caso del huevo es el
que define el diseño porque **las unidades de salida cruzan dimensiones**:

| Unidad de salida | Dimensión |
| --- | --- |
| cono (charola de ~30 huevos) | CONTEO |
| caja | CONTEO |
| kilos | **PESO** |

El mismo producto (huevo) se mueve en conteo Y en peso. Sin esto, el inventario se descuadra y
el costo unitario sale mal. **Por qué ahora:** es el ICP activo (retail) y es el flujo natural
del CEDIS que ya construimos (traslados).

## 2. Current State (verificado 2026-07-24)

El patrón "compro en unidad A, guardo en unidad base B" **ya funciona** para conversiones dentro
de la MISMA dimensión (kg↔g, L↔ml): `purchaseOrder.service.ts:690` usa `convertUnit`; todo
escritor de stock normaliza a la unidad base vía `toRawMaterialUnit` (`rawMaterial.service.ts:20`);
`convertUnit` (`unitConversion.ts:368`) es el único punto de conversión.

**Los tres límites que el caso del huevo destapa (todos verificados hoy):**

1. 🔴 **Conversión cross-dimensión PROHIBIDA.** `unitConversion.ts:377`:
   `if (fromMeta.type !== toMeta.type) throw 'Cannot convert between incompatible unit types'`.
   Cono/caja (COUNT) ↔ kilos (WEIGHT) tira error. Es correcto en general (no puedes convertir
   "3 piezas" a kg sin saber cuánto pesa cada una), pero es justo lo que el cliente necesita.
2. **"cono" no existe** en el enum `Unit` (0 coincidencias de cono/tray/charola). Las presentaciones
   del cliente son nombres propios de producto, no un enum global.
3. **No hay puente conteo↔peso por producto.** `RawMaterial` no tiene peso-por-pieza (0 campos).
   Sin "1 huevo ≈ 0.055 kg" el sistema no puede saber cuántos huevos son 2 kg.

Además el factor de empaque global está hardcodeado (`unitConversion.ts:189` CASE=24 para todos)
y `UnitConversion` tiene `@@unique([fromUnit,toUnit])` → una sola fila global por par; no puede
expresar "esta caja de huevo = 360, esa caja de vasos = 70".

### Preflight de producción (read-only, DB de Render)

| Chequeo | Resultado |
| --- | --- |
| Insumos activos | 114 (48 KG, 24 L, 20 G, 17 UNIT, 5 PIECE), todos en UNA dimensión limpia |
| Insumos en CASE/BOX/BAG o multi-unidad | **0** |
| Renglones de compra en unidad ≠ insumo (mismo tipo) | 14 (patrón vivo, seguirá por `convertUnit`) |

**Consecuencia:** cero productos usan hoy presentaciones ni cruzan dimensiones → el cambio es
**100% aditivo, sin migración**. La regla de oro (§3) mantiene byte-idéntico a los 114 existentes.

## 3. Proposed Change — presentaciones por producto, byte-idéntico para quien no las use

Modelo: cada `RawMaterial` puede declarar **presentaciones** (unidades en las que se compra,
cuenta o despacha), cada una con un **factor explícito a la unidad base**. El factor explícito ES
el puente cross-dimensión: el operador captura "1 caja = 360 huevos", "1 cono = 30 huevos",
"1 kilo = 18.18 huevos" (o al revés). Al ser explícito, no hace falta que el sistema derive
conteo↔peso — el operador lo declara una vez por producto.

- **Resolver nuevo `resolveProductConversion(rawMaterial, fromPresentation, toPresentation)`** que
  usa los factores por-producto. Un producto CON presentaciones NO pasa por el bloqueo
  cross-dimensión de `convertUnit` (usa sus factores). Un producto SIN presentaciones cae al
  `convertUnit` de hoy **sin tocarlo** — el bloqueo global sigue intacto para ese camino (correcto:
  no queremos convertir piezas↔kg en silencio para un producto que no declaró su peso).
- **Superficie (escritores de `currentStock`, verificados):** recepción de compras
  (`purchaseOrder.service.ts`), FIFO (`fifoBatch.service.ts`), ajustes (`rawMaterial.service.ts`),
  CEDIS (`interVenueTransfer.service.ts`). Cada uno resuelve a base vía el resolver.
- **CEDIS caja→pieza:** hoy `interVenueTransfer.service.ts:207` exige `source.unit === destination.unit`.
  Con presentaciones, el origen despacha en caja y el destino recibe en pieza/kilo, convertido por
  los factores de cada insumo. Se relaja "misma unidad" a "convertible vía presentaciones".
- **Captura:** dashboard (RawMaterial edit + wizard) gana la tabla de presentaciones por producto.
  El modelo `MeasurementUnit` (por-venue, nombre+abreviatura, hoy huérfano) puede reusarse para los
  nombres custom tipo "cono".
- **MCP:** `create_raw_material` / edición (`src/mcp/tools/inventory.ts`) acepta presentaciones.

## 4. Modelo de datos (RESUELTO — el ejemplo del huevo obliga la tabla)

Mi opción anterior de "1 campo en RawMaterial" queda **descartada**: el huevo tiene ≥3
presentaciones cruzando dimensiones. Es tabla:

```prisma
model RawMaterialPresentation {
  id            String      @id @default(cuid())
  rawMaterialId String
  rawMaterial   RawMaterial @relation(fields: [rawMaterialId], references: [id], onDelete: Cascade)
  venueId       String      // denormalizado para tenant isolation
  name          String      // "cono", "caja", "kilo", "pieza" — libre, no enum
  factorToBase  Decimal     @db.Decimal(14,6) // en unidades base; explícito ⇒ cruza dimensiones
  isPurchase    Boolean     @default(false)   // unidad por defecto de COMPRA/entrada
  isDefaultOut  Boolean     @default(false)   // unidad por defecto de SALIDA/despacho
  createdAt     DateTime    @default(now())
  @@index([rawMaterialId])
  @@index([venueId])
}
```

- Base del producto = su `unit`/`unitType` actual (sin cambio). Todo se contabiliza en base.
- Sin filas de presentación ⇒ comportamiento actual byte-idéntico.
- `factorToBase` explícito por presentación evita el `throw` de cross-dimensión: para el huevo con
  base PIECE, "kilo" tiene `factorToBase = 18.18` (piezas por kilo), capturado por el operador.

### 4b. 🔴 ÚNICA pregunta de alcance abierta — ¿"venta" incluye el POS?

Barbara dijo "salida o **venta**". Dos lecturas:
- **Inventario/CEDIS solamente** (recomendado v1): comprar, despachar, recibir, contar y ajustar
  en cualquier presentación. NO toca el POS de cara al cliente. Cubre el 100% del CEDIS.
- **+ Venta en POS**: además vender el producto final en cono/caja/kilo desde la caja. Esto extiende
  el alcance a la ruta de venta (productos, no sólo insumos) — más grande, probablemente v2.

Pregunta a confirmar con el cliente: *"cuando dices 'venta', ¿te refieres a que la SUCURSAL vende
ese producto en cono/caja/kilo desde su punto de venta, o sólo a que el CEDIS lo despacha/entrega
en esas unidades?"*

## 5. Acceptance Criteria

1. Insumo SIN presentaciones → compra, FIFO, ajuste y CEDIS byte-idénticos a hoy (regresión).
2. Huevo con base PIECE + presentaciones cono=30, caja=360, kilo=18.18: comprar 50 cajas → +18,000
   piezas en base; despachar 2 kilos → −36.36 piezas; contabilidad al centavo, costo unitario ÷ factor.
3. CEDIS: origen despacha en caja, destino recibe en kilo → conversión correcta, sin el 400 de
   "misma unidad".
4. `convertUnit` sin cambios (sus tests actuales pasan sin tocar asserts); el bloqueo cross-dimensión
   sigue vivo para productos sin presentaciones.
5. Reportes (`stock_value`, low-stock) siguen en base, correctos.

## 6. Testing Plan

| Capa | Qué | ~ |
| --- | --- | --- |
| Unit | `resolveProductConversion`: con/sin presentaciones, cross-dimensión vía factor explícito, delega a convertUnit cuando no hay presentaciones | +7 |
| Unit (regresión) | insumo sin presentaciones → todos los caminos byte-idénticos; `convertUnit` intacto | +3 |
| Integration (PG) | comprar en caja → base sube ×factor; FIFO; ajuste; CEDIS caja→kilo | +4 |
| Dashboard | captura de presentaciones por producto + wizard | +2 |

## 7. Rollback

Tabla nueva + resolver que cae a `convertUnit` si el producto no tiene presentaciones. Revertir el
commit deja todo inerte; los 114 insumos sin presentaciones nunca se tocaron. Cero migración.

## 8. Out of Scope (v1)

- **Venta en POS en estas unidades** (§4b — pendiente de confirmar; probablemente v2).
- **"Presupuestos por área"** — Barbara lo mencionó pero al re-preguntar se centró SÓLO en conversión;
  sigue vago y es un módulo aparte (no existe `Budget`; el `Area` actual es de mesas, no centro de
  costo). NO construir hasta descubrir el QUÉ.
- iOS (no en roadmap inmediato, founder 2026-07-23).

## 9. Files Reference

| File | Change |
| --- | --- |
| `prisma/schema.prisma` | +model RawMaterialPresentation + relación en RawMaterial (+ `npm run schema:map`) |
| `src/utils/unitConversion.ts` | +`resolveProductConversion` (NO tocar `convertUnit`) |
| `src/services/dashboard/rawMaterial.service.ts` | `toRawMaterialUnit` usa el resolver |
| `src/services/dashboard/purchaseOrder.service.ts` | recepción usa el resolver |
| `src/services/dashboard/interVenueTransfer.service.ts` | relajar `unit ===` a convertible-vía-presentaciones (§3) |
| `src/mcp/tools/inventory.ts` | `create_raw_material` acepta presentaciones |
| `avoqado-web-dashboard` RawMaterial edit + wizard | captura de presentaciones |

## Related
- Preflight + contexto en memoria: `venue-cedis-transfers.md`.
- CEDIS backend `6fadf05e`, dashboard `dc9c3f67`, Android `6829ab3`.
