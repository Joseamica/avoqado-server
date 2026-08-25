# Promociones en el POS — se tocan y entran al carrito

**Repos:** avoqado-server · avoqado-web-dashboard · avoqado-android · avoqado-ios · MCP **Origen:** lo pidió un cliente que hace
autoservicio girando la pantalla 180°. Brainstorming con el founder el 2026-08-12. **Tier:** PRO (decisión del founder). Los descuentos se
quedan en FREE — no se le quita nada a nadie.

> **v2 — reescrito tras una auditoría con Codex (`gpt-5.6-sol`, xhigh) que reprobó la v1 con 17 P1.** Tres afirmaciones centrales de la v1
> eran falsas y están corregidas abajo con su nombre. Los defectos que la auditoría encontró en el código existente **ya se arreglaron**
> antes de esta reescritura (`0778d35d`, `dc8840f0`); este spec se apoya en el código YA corregido, no en el que había.

---

## Qué se pide, en una frase

Que el local publique sus promociones vigentes, que aparezcan en la pantalla de cobro, y que al tocar una **entren los productos al
carrito** con su precio de promoción — sin que nadie tenga que armarla a mano.

---

## Lo que la v1 dijo mal (para que nadie lo reintroduzca)

| La v1 afirmaba                                                                       | La realidad, verificada en el código                                                                                                                                                                  |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Offline sale gratis: el POS resuelve la promo a líneas y las manda por `ADD_ITEMS`" | **Falso.** `ADD_ITEMS` **recalcula** `unitPrice` desde el catálogo (`order.tpv.service.ts:1438`) y no recibe `promotionId` ni `discountId`. Un combo de $99 con componentes de $250 se cobraría $250. |
| "Reúso el algoritmo de `RefundAmountCalculator`"                                     | **No existe en el server** — es una clase de Android. El equivalente real es `allocateByWeights` (`src/services/fiscal/ivaMath.ts:33`).                                                               |
| "Nuestro `Discount` no tiene regla de cuál se regala en un BOGO"                     | **Sí la tiene**, cheapest-first, y el código lo dice literal. Lo que sí tenía era un bug de conteo, ya arreglado en `dc8840f0`.                                                                       |
| "`OrderItemAppliedDiscount` es un descuento por línea"                               | Es sólo el **nombre de una relación** Prisma con un único `appliedDiscountId`. No alcanza para una promoción.                                                                                         |

---

## Lo que ya se arregló y este spec da por hecho

No re-hacer. Son prerequisitos que estaban rotos y ya no lo están:

- **`0778d35d`** — una línea con `isCortesia` dentro de `ADD_ITEMS` evadía `orders:comp`; las cantidades no se validaban (`-1` bajaba el
  total y al cobrar **sumaba** stock).
- **`dc8840f0`** — el BOGO contaba las unidades regaladas como compradas, así que con conjuntos traslapados regalaba **la línea entera** (4
  cervezas en 2x1 = las 4 gratis). Y la vigencia se leía en la zona del **proceso** (server en UTC, venues en México = 6 horas de
  corrimiento), con la ventana nocturna muriendo a medianoche. Ahora existe `isWithinVenueSchedule` en `utils/datetime.ts`: pura, exportada,
  con el instante y la zona por parámetro. **Las promociones usan ESA función**, no una nueva.

---

## Comparación con Square (regla del workspace)

|               | Qué hace                                                                                                                                                                                                                                          | Fuente                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **Square**    | Su API pública **no tiene** COMBO, BUNDLE ni COMPOSITION. Los tipos de `CatalogObject` son ITEM, CATEGORY, TAX, DISCOUNT, MODIFIER_LIST, TIME_PERIOD, PRODUCT_SET, PRICING_RULE, etc. Los combos existen como feature de vendedor, sin exponerse. | [CatalogObject](https://developer.squareup.com/reference/square/objects/CatalogObject) |
| **Avoqado**   | No existe nada equivalente.                                                                                                                                                                                                                       | —                                                                                      |
| **La brecha** | **No hay esquema de Square que copiar** para la parte central. Se diseña nuevo, y hay que decirlo con ese nombre en vez de fingir que se "adapta".                                                                                                | —                                                                                      |

**Lo que Square sí confirma:** los combos se rutean a cocina _"según los componentes individuales"_ y el reporte de ventas por artículo
_"muestra los artículos individuales de los combos vendidos"_
([Create and sell combos](https://squareup.com/help/us/en/article/8558-create-and-sell-combos)). Misma conclusión a la que llegamos por otro
camino: **componentes, nunca una línea opaca.**

**Lo que decidimos NO copiar:** Square parte la cosa en cuatro objetos (`Discount` cuánto + `ProductSet` a qué + `PricingRule` cuándo +
`TimePeriod`). Nuestro `Discount` los tiene fundidos. Refactorizar a cuatro cuesta mucho y no gana nada hoy.

---

## El modelo

```
Promotion              nombre, foto, estado, tipo, modo de precio, precio, vigencia, orden
  └── PromotionGroup        "Elige tu plato"   (minSelect / maxSelect)
        └── PromotionOption      → productId, quantity, chargedQuantity, priceDelta

OrderPromotion         la INSTANCIA vendida: snapshot inmutable de lo que se cobró
  └── OrderItem.orderPromotionId   las líneas que nacieron de ella
```

**Cómo se atan las dos mitades:** el POS genera un `promotionInstanceId` (UUID local) y lo manda dentro del intent; el server crea el
`OrderPromotion` con ese valor en `instanceId` —único por `(orderId, instanceId)`— y cuelga de él las líneas por `orderPromotionId`. El UUID
del cliente es lo que hace idempotente el replay; el id del `OrderPromotion` es lo que usan reportes, retiro y reembolso.

Una sola estructura cubre los tres casos, porque **un bundle es un combo donde nadie elige**:

| Tipo          | Cómo se ve en el modelo                         | Al tocarlo                   |
| ------------- | ----------------------------------------------- | ---------------------------- |
| **Bundle**    | todos los grupos tienen exactamente 1 opción    | entra directo, sin preguntar |
| **Combo**     | algún grupo tiene varias opciones               | pregunta grupo por grupo     |
| **Descuento** | sin grupos, apuntando a un `Discount` existente | se aplica al carrito         |

`Promotion.type` se **guarda explícito** y es la autoridad; la estructura debe ser consistente con él y se valida al publicar. (La v1 decía
a la vez que el tipo se guarda y que se deriva del número de opciones — dos implementadores lo habrían leído distinto.)

### Los dos modos de precio

| Modo          | Qué significa                                                               | Caso                                             |
| ------------- | --------------------------------------------------------------------------- | ------------------------------------------------ |
| `FIXED_TOTAL` | la promo cuesta `price` **más los `priceDelta` de lo elegido**              | Combo del día $99, o $114 si eligió pollo (+$15) |
| `PER_UNIT`    | no hay total fijo: cada línea se cobra su precio normal × `chargedQuantity` | 2x1 (cuesta lo que cueste la cerveza)            |

En `PER_UNIT` el `priceDelta` no se usa: el precio ya sale del producto elegido.

### Cuántas entran vs cuántas se cobran

| Promo               | quantity | chargedQuantity | Inventario |
| ------------------- | -------- | --------------- | ---------- |
| Componente de combo | 1        | 1               | −1         |
| **2x1**             | **2**    | **1**           | **−2**     |
| 3x2                 | 3        | 2               | −3         |

🔴 **El 2x1 entra como UNA línea de cantidad 2.** La deducción usa `item.quantity` (`payment.tpv.service.ts:949`), así que sólo así
descuenta 2. Verificado también que recetas y modificadores multiplican por esa misma cantidad.

**Consecuencia que la v1 no vio:** una sola `OrderItem` sólo puede contener el **mismo producto con la misma configuración**. El ejemplo de
"una cerveza de $50 y una de $120 en 2x1" exige dos líneas y no cabe en una. Por eso:

> **v1 sólo admite BOGO del MISMO producto y la misma configuración.** Un "2x1 en cualquier cerveza" mezclando SKUs distintos queda fuera;
> para eso ya está el `Discount` BOGO automático, que sí compara precios entre líneas y desde `dc8840f0` regala la más barata correctamente.

**Efecto colateral bueno:** con un solo SKU por línea, todas las unidades valen lo mismo, así que **la pregunta de "cuál se regala"
desaparece** en la v1 — no hace falta una regla de "la más barata" ni configurarla. Esa regla vive donde sí hace falta, en el motor de
descuentos.

---

## 🔴 La prorrata, definida al centavo

La v1 decía "las líneas suman $99" sin decir **cuánto le toca a cada una**, y eso no es un detalle: dos repartos válidos producen impuestos
y reembolsos distintos.

**Regla:** cada línea conserva su **precio bruto de catálogo**. Se calcula el descuento total de la promoción
(`suma de brutos − precio de la promoción`) y se reparte **proporcionalmente al bruto de cada componente**, en centavos, con
`allocateByWeights` (`src/services/fiscal/ivaMath.ts:33`) — que ya resuelve el residuo de forma determinista.

```
Combo $100 con productos de $80, $40, $20 (bruto $140)
  descuento total = $40
  reparto proporcional: $22.86 / $11.43 / $5.71   (suma exacta $40.00)
  líneas netas:         $57.14 / $28.57 / $14.29  (suma exacta $100.00)
```

Se elige proporcional-al-bruto y no partes iguales porque es lo único que **preserva la proporción fiscal**: si un componente es 0% IVA y
otro 16%, repartir en partes iguales le movería la base gravable a los dos.

---

## 🔴 La semántica fiscal, explícita

El motor de descuentos actual **no sirve como referencia**: estima 16% fijo y resta esa cifra de `Order.taxAmount`, que en POS normalmente
es cero porque el IVA va incluido en el precio. Un descuento de $116 producía una reducción de $18.56 cuando su IVA incluido es $16, y podía
dejar el impuesto en negativo.

**Regla de la v1 de promociones:**

- La promoción reduce la base gravable **mediante los descuentos por línea** ya repartidos arriba, cada uno con la tasa real de su producto.
- En ventas con IVA incluido, `taxAmount` se queda en **0** y el CFDI deriva el IVA del **neto por línea**, que es lo que ya hace
  (`src/services/fiscal/cfdi.service.ts:462`).
- Las promociones **no tocan** `Order.taxAmount` directamente. Nunca.

---

## 🔴 La base de la propina

Hoy el server recibe un monto absoluto de propina y lo suma después del descuento; no calcula sugerencias. Sin una base canónica, un combo
de $99 cuyo catálogo suma $200 produce "15%" de $14.85 en un cliente y $30 en otro.

**Base canónica: el subtotal NETO, después de promociones y descuentos, antes de propina.** El server devuelve los importes sugeridos ya
calculados; los clientes los muestran, no los inventan.

---

## 🔴 Offline: qué viaja y quién manda

La v1 prometía offline gratis y era falso. El arreglo:

**`ADD_ITEMS` gana campos OPCIONALES** — no se agrega un tipo de intent nuevo, así que los 14 tipos y el `pos_sync_status` del MCP no
cambian:

```
items[].promotionRef = {
  promotionId,
  promotionInstanceId,     // UUID local; ancla la idempotencia
  selections: [{ groupId, optionId }],
}
```

🔑 **El intent NO lleva precios.** Lleva qué promoción y qué eligió la persona; **toda la aritmética la hace el server** al aplicar. Es
aditivo: un cliente viejo que no manda `promotionRef` se comporta exactamente igual que hoy.

**Lo que el POS sí hace local:** mostrar el precio con el catálogo de promociones que ya tiene cacheado (lo necesita para pintar el panel).
Es una conveniencia de latencia, **nunca la autoridad del precio**.

### La contradicción de la autoridad, resuelta

Si el POS vende a las 19:59 sin red y sincroniza a las 20:30, revalidar contra "ahora" rechazaría una venta ya entregada. Pero confiar
ciegamente en el reloj del cliente deja abusar.

**Regla:** la vigencia se evalúa contra `createdAtLocal`, **acotado a la ventana `[sync − 24h, sync]`**. Un reloj movido más de 24 horas no
compra nada; una venta legítima de más temprano el mismo día se honra.

🔴 **La venta NUNCA se rechaza — lo que se cae es el descuento.** Rechazar mercancía ya entregada es peor que cualquier alternativa. Los
tres desenlaces posibles:

| Situación al sincronizar                                           | Qué pasa                                                             |
| ------------------------------------------------------------------ | -------------------------------------------------------------------- |
| La promoción estaba vigente en `createdAtLocal` acotado            | Se aplica normal                                                     |
| No estaba vigente (o el reloj se movió más de 24h)                 | **Las líneas entran a precio de lista** y se marca para revisión     |
| La promoción se archivó o cambió de precio mientras estaba sin red | Se aplica el **snapshot** que el POS mostró y se marca para revisión |

En los tres casos los productos entran a la cuenta, la cocina los ve y el inventario se descuenta. Lo único que varía es el precio y si
queda marcado.

---

## 🔴 Atomicidad y retiro

**Atomicidad.** Hoy las líneas se crean con `Promise.all` y el CAS de totales viene después: si el tercer componente falla, queda **media
promoción** en la orden. Una promoción se aplica dentro de **una sola transacción** que encierra validación final, `OrderPromotion`, líneas,
descuentos por línea, totales y el CAS. Índice único por `(orderId, promotionInstanceId)`: un replay actualiza, no duplica.

**Retiro.** Hoy `removeOrderItem` borra una fila y **deja vivo** el `OrderDiscount` que la mencionaba, que luego se vuelve a sumar sobre las
otras líneas. Se agrega una operación de retiro **por `promotionInstanceId`**, en transacción, que borra todas sus líneas, sus descuentos y
su `OrderPromotion`, y recalcula una vez. Quitar cualquier línea de una promoción dispara esa operación: **una promo se quita completa.**

---

## 🔴 Las promos no se apilan con descuentos automáticos

Si un local configura el 2x1 **como promoción** y deja vivo el **BOGO automático** sobre los mismos productos, el automático se aplicaría
encima de lo que la promo ya regaló.

La v1 decía "se filtran las líneas", y eso no basta: el motor calcula porcentajes sobre `order.subtotal` **completo**, y al agregar
artículos se recalcula todo sobre el subtotal nuevo — así que un 20% automático subiría de $20 a $39.80 al meter un combo de $99, alcanzando
la promoción por la puerta de atrás.

**Regla:** el descuento automático **persiste su base elegible** y esa base excluye las líneas con `orderPromotionId`. Todos los recálculos
—agregar, quitar, dividir, fusionar— usan esa misma base persistida, no el subtotal vivo.

---

## Reembolsos

El reembolso por artículo usa `OrderItem.total` y **omite `discountAmount`**: devolver una unidad de un 2x1 reembolsaría el bruto, y ni
siquiera se sabría si era la pagada o la regalada.

**v1: sólo se reembolsa la promoción COMPLETA, por `promotionInstanceId`.** El monto es la suma de los netos de sus líneas. El reembolso
parcial de un componente queda fuera hasta que exista una regla escrita de cómo se reprecia el resto — porque al quitar un componente el
combo ya no es el combo.

---

## El panel

### Layout

Por default **panel lateral (1/4)**, configurable a **pestaña**. Medido sobre el checkout actual (50/50, `GridCells.Fixed(3)`, `isTablet` =
ancho ≥ 600dp):

| Ancho                | Panel lateral                  | Resultado      |
| -------------------- | ------------------------------ | -------------- |
| Tablet 10" (~1370dp) | ~171dp por columna de producto | usable         |
| Tablet 600dp         | ~75dp por columna              | **inservible** |
| Teléfono             | —                              | **imposible**  |

🔴 **El umbral se deriva, no se inventa.** Con panel lateral la columna de entrada se queda con el 37.5% del ancho. Una celda de producto
necesita ~120dp, o sea 360dp para las tres columnas → **el panel lateral sólo se usa a partir de ~960dp.** Por debajo cae solo a pestaña,
sin importar el ajuste. El 120dp va como constante con nombre, para ajustarlo con un dispositivo real enfrente.

### La tarjeta

Foto o gancho grande (`2x1`, `−20%`, `$99`), nombre, qué trae, y el precio o la condición. La vigencia se escribe **sólo cuando faltan menos
de 60 minutos** para que termine ("hasta las 11:00 pm").

### Orden y horizonte

Las promociones vigentes van primero, por `displayOrder` y luego por nombre. Debajo, las que empiezan **dentro de las próximas 4 horas**, en
gris y sin poder tocarse ("empieza a las 6:00 pm"). Más allá de 4 horas no se muestran.

Se descartó colapsar el panel cuando no hay ninguna vigente: recuperaría el 25% pero movería el layout dos veces al día, encogiendo la
cuadrícula que el cajero ya tiene memorizada. Y mostrar las que vienen convierte el hueco en herramienta de venta.

### Al tocar

| Tipo      | Qué pasa                                                    |
| --------- | ----------------------------------------------------------- |
| Bundle    | entra directo al carrito                                    |
| Combo     | hoja paso a paso, **sólo los grupos con más de una opción** |
| Descuento | se aplica al carrito                                        |

**Éxito:** `AvoqadoSuccessToast` ("¡Combo agregado!").

**Cuando no aplica: nunca un botón muerto ni un "no se pudo".** Siempre qué falta y cuánto:

- "Te faltan $45 para usar esta promoción. Llevas $155 de $200."
- "Agrega una cerveza a la cuenta para aplicar el 2x1."
- "Esta promoción es de 6:00 a 8:00 pm. Faltan 40 minutos."

---

## Configuración, estados y tier

### Los dos ajustes

| Ajuste                                  | Valores                         | Default      |
| --------------------------------------- | ------------------------------- | ------------ |
| Promociones en pantalla del **cajero**  | `HIDDEN` · `TAB` · `SIDE_PANEL` | `TAB`        |
| Promociones en pantalla del **cliente** | `HIDDEN` · `TAB` · `SIDE_PANEL` | `SIDE_PANEL` |

El switch se justifica bajo la regla del workspace (dos clientes reales queriendo lo contrario): un local de autoservicio quiere el panel
porque las promos **son** el menú; un mostrador con fila quiere el ancho para la cuadrícula.

🔴 **`HIDDEN` no contradice "apagado se ve y se explica".** Esa regla es sobre el **tier**: un local FREE ve el punto de entrada con el
candado y qué plan lo prende. `HIDDEN` es una preferencia de layout que el propio local eligió y que puede revertir desde el mismo lugar
donde la puso. Precedencia, en este orden: **tier → módulo → ajuste de pantalla → hay algo que mostrar.**

### Estados de la promoción

`DRAFT` · `PUBLISHED` · `ARCHIVED`. Sólo `PUBLISHED` llega al POS. Al publicar se valida, y sin eso no se publica:

- consistencia entre `type`, `pricingMode` y la estructura de grupos
- `0 ≤ chargedQuantity ≤ quantity`; `price ≥ 0`; `priceDelta ≥ 0`. El cero es DELIBERADO: `chargedQuantity: 0` significa "este componente va
  de regalo" ("botanero gratis en tu compra"), una forma legítima de promoción. La v1 del spec decía `1 ≤` por conservadurismo; el validador
  implementado permite 0 y este texto se alineó con esa decisión (2026-08-22).
- todo `productId` existe, está activo y **pertenece al mismo venue** (check de tenant)
- todo grupo tiene al menos una opción

**Editar o archivar una promoción no toca las ya vendidas:** `OrderPromotion` guarda el snapshot de lo que se cobró. Un reporte histórico
nunca cambia porque alguien editó el combo.

### Tier

**PRO**, código `PROMOTIONS`, espejado por nombre EXACTO en backend + dashboard + Android + iOS.

⚠️ **Android e iOS no tienen NINGÚN gate de tier hoy.** Esta feature sería la primera, así que hay que construir el mecanismo de lectura de
tier en los dos clientes, no sólo el gate de esta feature.

---

## Invariantes con test (ruta de dinero y de stock — TDD obligatorio)

1. **La suma de los netos == el precio de la promoción**, al centavo, incluido $100 entre 3 productos.
2. **El reparto es proporcional al bruto**, no en partes iguales (preserva la proporción fiscal).
3. **Un 2x1 descuenta 2 del inventario**, no 1.
4. **Las promociones no tocan `Order.taxAmount`**; el CFDI deriva el IVA del neto por línea.
5. **La propina se calcula sobre el subtotal neto** después de promociones.
6. **Una promoción no se puede partir**: quitar una línea quita la promoción entera, con sus descuentos.
7. **Un descuento automático no se aplica sobre líneas de promoción**, ni siquiera al recalcularse tras agregar más artículos.
8. **Un fallo a media aplicación no deja media promoción** en la orden.
9. **Un replay del mismo `promotionInstanceId` actualiza, no duplica.**
10. **Una promoción vendida offline se honra si `createdAtLocal` cae en la ventana acotada.** Si no —reloj movido, promoción archivada—,
    **la venta entra igual**: las líneas se cobran a precio de lista o con el snapshot, y queda marcada. Nunca se rechaza mercancía
    entregada.
11. **Editar la promoción no cambia lo ya vendido.**
12. **Un producto de otro venue nunca se publica en una promoción.**
13. **El reembolso de una promoción devuelve la suma de sus netos**, no los brutos.

---

## Alcance por repo

| Repo                      | Qué lleva                                                                                                                                                                                                                                                                                             |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **avoqado-server**        | modelos `Promotion`/`PromotionGroup`/`PromotionOption`/`OrderPromotion`; `orderPromotionId` en `OrderItem`; resolución transaccional con prorrata por `allocateByWeights`; retiro por instancia; base persistida de los automáticos; `promotionRef` opcional en `ADD_ITEMS`; endpoint móvil; gate PRO |
| **avoqado-web-dashboard** | sección Promociones: crear/editar/publicar/archivar, foto, grupos y opciones, vigencia, 2x1, los dos ajustes de panel                                                                                                                                                                                 |
| **avoqado-android**       | panel (lateral/pestaña/oculto + caída automática), hoja de combo, tarjetas, estados de "no aplica", lectura de tier                                                                                                                                                                                   |
| **avoqado-ios**           | espejo exacto — misma entrega, mismos textos, mismos nombres de campo                                                                                                                                                                                                                                 |
| **MCP**                   | `list_promotions`, `create_promotion` (preview + `confirm`), `promotion_status` (cuáles están vigentes ahora)                                                                                                                                                                                         |

**Obligaciones del workspace que van en el MISMO cambio:**

- `npm run schema:map` tras tocar `schema.prisma`, y commitear `docs/SCHEMA_MAP.md` junto, con los modelos nuevos dados de alta en
  `MODEL_TO_DOMAIN`.
- **Presentación de ventas**: deck + one-pager + one-pager de cliente, **y regenerar los tres PDFs**.

---

## Lo que NO va en la v1

- **BOGO mezclando SKUs distintos.** Una `OrderItem` sólo contiene el mismo producto con la misma configuración. Para eso está el `Discount`
  BOGO automático, ya corregido.
- **Elegir más de una opción por grupo.** Cada grupo es "elige exactamente 1" (`minSelect = maxSelect = 1`); los campos quedan en el modelo
  para no migrar después, y el server rechaza lo que no sea 1.
- **Reembolso parcial de un componente.** Sólo promoción completa.
- **Productos vendidos por peso y serializados dentro de una promoción.** El peso exige cantidad 1 y el restock de reembolso ignora
  sustituciones y modificadores; meterlos ahora es pedir un descuadre de stock.
- **`ProductSet` reusable.** Con arreglos de ids alcanza.
- **Apilar promociones entre sí.** Una promoción por vez sobre las mismas líneas.
- **Límites de uso por promoción** (`maxTotalUses`).
- **Promos en el KDS.** Cocina ve los componentes, que es lo que necesita.
