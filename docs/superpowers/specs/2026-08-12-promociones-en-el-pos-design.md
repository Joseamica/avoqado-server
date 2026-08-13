# Promociones en el POS — se tocan y entran al carrito

**Repos:** avoqado-server · avoqado-web-dashboard · avoqado-android · avoqado-ios · MCP
**Origen:** lo pidió un cliente que hace autoservicio girando la pantalla 180°. Brainstorming con el founder el 2026-08-12.
**Tier:** PRO (decisión del founder). Los descuentos se quedan en FREE — no se le quita nada a nadie.

---

## Qué se pide, en una frase

Que el local publique sus promociones vigentes, que aparezcan en la pantalla de cobro, y que al tocar una **entren los productos al carrito** con su precio de promoción — sin que nadie tenga que armarla a mano.

---

## Lo que ya existe y no se rehace

`Discount` (`schema.prisma:6301`) ya es medio motor de promociones: BOGO (`buyQuantity`/`getQuantity`/`getItemIds`), ventana de vigencia (`validFrom`/`validUntil`/`daysOfWeek`/`timeFrom`/`timeUntil`), automáticas con prioridad, mínimo de compra, tope, alcance ORDER/ITEM/CATEGORY, límites de uso y reglas de apilamiento.

Lo que **no** tiene, y es justo lo que se pide: **meter productos al carrito**.

`discountEngine.service.ts` ya evalúa la vigencia, incluida la ventana que cruza la medianoche (`timeFrom > timeUntil`, línea 1059). **Las promociones usan ESE mismo predicado.** Escribir otro garantiza que un martes a las 23:50 una promo y un descuento discrepen sobre si el martes sigue vivo.

---

## Comparación con Square (regla del workspace)

| | Qué hace | Fuente |
| --- | --- | --- |
| **Square** | Su API pública **no tiene** COMBO, BUNDLE ni COMPOSITION. Los tipos de `CatalogObject` son ITEM, CATEGORY, TAX, DISCOUNT, MODIFIER_LIST, TIME_PERIOD, PRODUCT_SET, PRICING_RULE, etc. Los combos existen como feature de vendedor, sin exponerse. | [CatalogObject](https://developer.squareup.com/reference/square/objects/CatalogObject) |
| **Avoqado** | No existe nada equivalente. | — |
| **La brecha** | **No hay esquema de Square que copiar** para la parte central. Se diseña nuevo, y hay que decirlo con ese nombre en vez de fingir que se "adapta". | — |

**Lo que Square sí confirma:** los combos se rutean a cocina *"según los componentes individuales"* y el reporte de ventas por artículo *"muestra los artículos individuales de los combos vendidos"* ([Create and sell combos](https://squareup.com/help/us/en/article/8558-create-and-sell-combos)). Es la misma conclusión a la que llegamos por otro camino: **componentes, nunca una línea opaca.**

**Lo que Square hace y nosotros no** — ver "La regla del más barato" abajo. Es la brecha que cuesta dinero.

**Lo que decidimos NO copiar:** Square parte la cosa en cuatro objetos (`Discount` cuánto + `ProductSet` a qué + `PricingRule` cuándo + `TimePeriod`). Nuestro `Discount` los tiene fundidos. Refactorizar a cuatro cuesta mucho y no gana nada hoy. El `ProductSet` reusable ("todas las cervezas" definido una vez) es lo único con valor real de esa separación, y se pospone: con arreglos de ids alcanza hasta que un local tenga varias promos sobre el mismo conjunto.

---

## El modelo

Una sola estructura cubre los tres casos, porque **un bundle es un combo donde nadie elige**:

```
Promotion              nombre, foto, precio, vigencia, tipo, orden de despliegue
  └── PromotionGroup        "Elige tu plato"   (minSelect / maxSelect)
        └── PromotionOption      → productId, quantity, chargedQuantity, priceDelta
```

| Tipo | Cómo se ve en el modelo | Al tocarlo |
| --- | --- | --- |
| **Bundle** | todos los grupos tienen exactamente 1 opción | entra directo, sin preguntar |
| **Combo** | algún grupo tiene varias opciones | pregunta grupo por grupo |
| **Descuento** | sin grupos, apuntando a un `Discount` existente | se aplica al carrito |

### Los dos modos de precio

| Modo | Qué significa | Caso |
| --- | --- | --- |
| `FIXED_TOTAL` | la promo cuesta `price` **más los `priceDelta` de lo que se eligió** | Combo del día $99, o $114 si eligió pollo (+$15) |
| `PER_UNIT` | no hay total fijo: cada línea se cobra su precio normal × `chargedQuantity` | 2x1 (cuesta lo que cueste la cerveza) |

En `PER_UNIT` el `priceDelta` no se usa: el precio ya sale del producto elegido. Sumarlo además sería cobrar dos veces la diferencia.

### Cuántas entran vs cuántas se cobran

Cada `PromotionOption` lleva `quantity` (cuántas unidades entran al carrito) y `chargedQuantity` (cuántas se pagan):

| Promo | quantity | chargedQuantity | Inventario |
| --- | --- | --- | --- |
| Componente de combo | 1 | 1 | −1 |
| **2x1** | **2** | **1** | **−2** |
| 3x2 | 3 | 2 | −3 |

🔴 **El 2x1 entra como UNA línea de cantidad 2**, no como dos promos de 1. La deducción de inventario usa `item.quantity` (`payment.tpv.service.ts:949`), así que sólo así descuenta 2.

Se representa como la línea de cantidad 2 **más un descuento pegado a la línea** por el valor de una unidad:

```
Cerveza × 2              $100.00
  └ Promo 2x1            −$50.00
```

En vez de "2 unidades a mitad de precio", que descontaría igual el inventario pero (a) escondería el regalo, así que nadie podría reportar cuánto se regaló en promociones, y (b) ensuciaría el precio de venta del producto en los reportes.

### Trazabilidad de las líneas

Cada `OrderItem` nacido de una promoción lleva `promotionId` y un `promotionInstanceId`. Sin lo segundo, dos combos iguales en la misma cuenta se fusionarían y ya no se podría quitar uno solo.

---

## 🔴 La regla del más barato

Un cliente se lleva una cerveza de $50 y una de $120 en un 2x1. **¿Cuál va gratis?**

Square lo resuelve con `exclude_strategy`, cuyo default es **`LEAST_EXPENSIVE`** ([CatalogPricingRule](https://developer.squareup.com/reference/square/objects/CatalogPricingRule)). Nuestro `Discount` tiene los campos de BOGO pero **ninguna regla de cuál se regala**.

Sin la regla, el sistema podría regalar la de $120: **$70 perdidos por transacción**, en silencio, y nadie reclama porque el ticket cuadra. Es la dirección cara del error.

**Decisión: se regala siempre la más barata.** No es configurable en la v1 — un local que quiera lo contrario está regalando dinero sin saberlo, y si algún día lo pide, se agrega con su nombre y su advertencia.

---

## 🔴 Las promos no se apilan con descuentos automáticos

Si un local configura el 2x1 **como promoción** y además deja vivo el **BOGO automático** de `Discount` sobre esos mismos productos, el automático se aplicaría encima de las 2 unidades que la promo ya regaló: **el cliente se lleva 2 gratis**.

**Las líneas nacidas de una promoción quedan fuera de la evaluación de descuentos automáticos.** La promo ya trae su precio negociado; nada se le encima solo.

---

## 🔴 Una promo se quita completa

Quitar una sola línea de un combo de $99 dejaría hamburguesa + papas cobradas a $99, o una prorrata sin sentido. **Quitar cualquier línea de una promo quita la promo entera.** Para llevarse sólo la hamburguesa: se quita la promo y se agrega el producto suelto.

---

## El panel

### Layout

Por default **panel lateral (1/4)**, configurable a **pestaña**. Medido sobre el checkout actual (50/50, `GridCells.Fixed(3)`, `isTablet` = ancho ≥ 600dp):

| Ancho | Panel lateral | Resultado |
| --- | --- | --- |
| Tablet 10" (~1370dp) | ~171dp por columna de producto | usable |
| Tablet 600dp | ~75dp por columna | **inservible** |
| Teléfono | — | **imposible** |

🔴 **El umbral no es un número mágico, se deriva.** Con el panel lateral la columna de entrada se queda con el 37.5% del ancho (25% promos + 37.5% entrada + 37.5% carrito). Una celda de producto necesita ~120dp para caber imagen y dos renglones de texto, o sea 360dp para las tres columnas → **el panel lateral sólo se usa a partir de ~960dp de ancho.** Por debajo cae solo a pestaña, **sin importar el ajuste**. No es configurable a propósito: dejar que el local escoja una pantalla rota es dejarle escoger una pantalla rota. El 120dp va como constante con nombre, para poder ajustarlo con un dispositivo real enfrente.

### La tarjeta

Foto o gancho grande (`2x1`, `−20%`, `$99`), nombre, qué trae, y el precio o la condición. La vigencia se escribe **sólo cuando está por vencer** ("hasta las 11:00 pm").

### Cuando no hay ninguna vigente

**Se muestran las que vienen, apagadas**: "Martes de cerveza — empieza a las 6:00 pm", en gris y sin poder tocarse.

Se descartó colapsar el panel: recuperaría el 25% pero movería el layout dos veces al día, encogiendo la cuadrícula que el cajero ya tiene memorizada. Y mostrar las que vienen convierte el hueco en herramienta de venta ("regrese a las 6 y son 2x1").

### Al tocar

| Tipo | Qué pasa |
| --- | --- |
| Bundle | entra directo al carrito |
| Combo | hoja paso a paso, **sólo los grupos con más de una opción** |
| Descuento | se aplica al carrito |

**Éxito:** `AvoqadoSuccessToast` ("¡Combo agregado!"), que es lo que manda el design system para una acción que hoy tendría éxito silencioso.

**Cuando no aplica: nunca un botón muerto ni un "no se pudo".** Siempre qué falta y cuánto:

- "Te faltan $45 para usar esta promoción. Llevas $155 de $200."
- "Agrega una cerveza a la cuenta para aplicar el 2x1."
- "Esta promoción es de 6:00 a 8:00 pm. Faltan 40 minutos."

---

## Configuración y activación

Dos ajustes, no tres — la petición de "prender/apagar por pantalla" y la de "panel o pestaña" se colapsan:

| Ajuste | Valores |
| --- | --- |
| Promociones en pantalla del **cajero** | `HIDDEN` · `TAB` · `SIDE_PANEL` |
| Promociones en pantalla del **cliente** | `HIDDEN` · `TAB` · `SIDE_PANEL` |

El switch se justifica bajo la regla del workspace (dos clientes reales queriendo lo contrario): un local de autoservicio quiere el panel porque las promos **son** el menú; un mostrador con fila quiere el ancho para la cuadrícula de productos.

**Default:** `SIDE_PANEL` en cliente, `TAB` en cajero. El cliente es quien descubre; el cajero ya sabe buscar por nombre.

El ajuste canónico vive en el dashboard, sobre el registro del server. Android e iOS lo **leen** — no se toca durante el turno desde el piso.

---

## Tier

**PRO**, código `PROMOTIONS`, espejado por nombre EXACTO en backend + dashboard + Android + iOS. Un desajuste de nombre falla en silencio.

Los descuentos siguen en FREE: ya lo están y quitárselo a alguien no es una opción.

⚠️ **Android e iOS no tienen NINGÚN gate de tier hoy.** Esta feature sería la primera, así que hay que construir el mecanismo de lectura de tier en los dos clientes, no sólo el gate de esta feature.

**Apagado se ve y se explica** (regla del workspace): un local FREE ve el punto de entrada con el candado y qué plan lo prende, nunca desaparecido en silencio.

---

## Offline

**No hace falta un tipo de intent nuevo.** El POS resuelve la promoción a líneas *localmente* y las manda por `ADD_ITEMS`, que ya existe entre los 14 tipos. Funciona sin internet desde el día uno, sin tocar el contrato de sincronización de los tres repos.

🔴 **Lo que eso obliga:** el server tiene que **re-verificar** que las líneas recibidas correspondan a esa promoción y que sumen su precio. Si confiara en lo que manda el cliente, un POS con la app modificada podría mandar un combo de $99 con productos de $500. La resolución local es una conveniencia de latencia y de offline, **nunca la autoridad del precio.**

---

## Invariantes con test (ruta de dinero y de stock — TDD obligatorio)

1. **La suma de las líneas == el precio de la promoción**, al centavo. Incluido $100 entre 3 productos, donde el reparto ingenuo pierde o inventa un centavo. Se reúsa el algoritmo de reparto con residuo de `RefundAmountCalculator`, no se escribe otro.
2. **Un 2x1 descuenta 2 del inventario**, no 1.
3. **En un 2x1 se regala la MÁS BARATA**, nunca la cara.
4. **Una promoción no se puede partir**: quitar una línea quita la promoción entera.
5. **Un descuento automático no se aplica sobre líneas de promoción.**
6. **El server rechaza líneas que no correspondan a la promoción o que no sumen su precio.**
7. **La vigencia usa el predicado de `discountEngine`**, incluida la ventana que cruza la medianoche.

---

## Alcance por repo

| Repo | Qué lleva |
| --- | --- |
| **avoqado-server** | modelos `Promotion`/`PromotionGroup`/`PromotionOption`; `promotionId` + `promotionInstanceId` en `OrderItem`; resolución a líneas con centavos exactos; regla del más barato; exclusión de automáticos; endpoint móvil; re-verificación; gate PRO |
| **avoqado-web-dashboard** | sección Promociones: crear/editar, foto, grupos y opciones, vigencia, 2x1, los dos ajustes de panel |
| **avoqado-android** | panel (lateral/pestaña/oculto + caída automática), hoja de combo, tarjetas, estados de "no aplica", lectura de tier |
| **avoqado-ios** | espejo exacto — misma entrega, mismos textos, mismos nombres de campo |
| **MCP** | `list_promotions`, `create_promotion` (con preview + `confirm`), y `promotion_status` para saber cuáles están vigentes ahora |

**Obligaciones del workspace que van en el MISMO cambio:**

- `npm run schema:map` tras tocar `schema.prisma`, y commitear `docs/SCHEMA_MAP.md` junto — con los modelos nuevos dados de alta en `MODEL_TO_DOMAIN`.
- **Presentación de ventas**: deck + one-pager + one-pager de cliente, **y regenerar los tres PDFs**. Esto sí es capacidad vendible nueva con empaquetado de tier.

---

## Lo que NO va en la v1

- **Elegir más de una opción por grupo.** En la v1 cada grupo es "elige exactamente 1" (`minSelect = maxSelect = 1`). Los campos quedan en el modelo para no migrar después, pero el POS no ofrece multi-selección y el server rechaza lo que no sea 1. Un "elige 2 de estas 5 guarniciones" es otra hoja de UI y otra prorrata.
- **`ProductSet` reusable.** Con arreglos de ids alcanza; se agrega cuando un local tenga varias promos sobre el mismo conjunto.
- **Elegir cuál se regala en un BOGO.** Siempre la más barata.
- **Promociones por cliente o por grupo de clientes.** `Discount` ya tiene `customerGroupId`; las promociones no lo usan todavía.
- **Apilar promociones entre sí.** Una promoción por vez sobre las mismas líneas.
- **Límites de uso por promoción** (`maxTotalUses`). Existe en `Discount`; se pospone hasta que alguien lo pida.
- **Promos en el KDS.** Cocina ve los componentes, que es lo que necesita.
