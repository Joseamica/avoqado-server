/**
 * Traductor: pedido crudo de Uber Eats (uAPI, `/v1/delivery/order/{id}`) → contrato interno
 * (`NormalizedDeliveryOrder`).
 *
 * 🔴 POR QUÉ HABLA uAPI Y NO LA API CLÁSICA (27-ago): la validación de producción de Uber
 * (caso 59605086) REPROBÓ la integración — su rastreador exige llamadas exitosas a la
 * familia `/v1/delivery/*`, y las tiendas de prueba fueron re-integradas a "API version
 * 1.0.0". Nuestra integración hablaba la familia clásica (`/v1/eats/*`): funcionaba, pero
 * en la puerta que Uber ya no está mirando.
 *
 * ESCRITO CONTRA UN PEDIDO REAL del uAPI (fixture `pedido-real-uapi.json`, bajado del
 * sandbox el 27-ago con `?expand=carts,payment`), no contra documentación. Lo que el pedido
 * real fijó:
 *
 *   1. El dinero viaja en `amount_e5`: 100000 = $1.00. La división es ÷100,000 — ni la
 *      clásica ÷100 ni la de Stripe. Equivocarse aquí multiplica cada venta por mil.
 *   2. `quantity` es un OBJETO `{amount, unit}` — al revés que la API clásica, donde era un
 *      entero. La lección de "verificar con pedido real" aplica en ambas direcciones.
 *   3. Las notas del cliente SÍ llegan: `customer_request.special_instructions` ("Sin
 *      cebolla, por favor" en el pedido real). En la clásica nunca vimos una.
 *   4. Los precios por línea viven en `payment.payment_detail.item_charges.price_breakdown`,
 *      indexados por `cart_item_id` — no dentro del item del carrito.
 *
 * 🔴 El ÷100,000 ocurre AQUÍ y sólo aquí. De este módulo hacia adentro, todo el dinero es
 * string decimal en pesos (`.claude/rules/critical-warnings.md`).
 *
 * Módulo PURO: sin Prisma CLIENT (sin DB/red/env) — sí usa `Prisma.Decimal`, que es sólo un
 * tipo de dato.
 */
import { OrderSource, Prisma } from '@prisma/client'

import type { NormalizedDeliveryItem, NormalizedDeliveryModifier, NormalizedDeliveryOrder } from '../../core/types'

/** e5 Decimal → pesos con dos decimales. El único lugar donde se divide entre 100,000. */
function aPesos(e5: Prisma.Decimal): string {
  return e5.dividedBy(100_000).toFixed(2)
}

/**
 * Extrae `.amount_e5` de un objeto Money del uAPI (`{amount_e5, currency_code, formatted}`)
 * como `Prisma.Decimal` — nunca `number` en aritmética (regla: Money = Decimal).
 *
 * Distingue "no existe" de "existe pero corrupto" (lección heredada de la API clásica, donde
 * colapsarlos convertía un payload corrupto en una venta de $0 marcada como pagada):
 *   - Nodo ausente (`undefined`/`null`) o sin `.amount_e5`: legítimo — es el caso de la
 *     propina en un pedido que reparte Uber. ⇒ 0.
 *   - `.amount_e5` presente pero no un número finito: payload corrupto. ⇒ RECHAZA.
 */
function montoE5(nodo: unknown, contexto: string): Prisma.Decimal {
  if (nodo === undefined || nodo === null) return new Prisma.Decimal(0)
  if (typeof nodo !== 'object' || Array.isArray(nodo)) {
    throw new Error(`Monto de Uber corrupto en "${contexto}": se esperaba un objeto de dinero, llegó ${JSON.stringify(nodo)}`)
  }
  const amount = (nodo as { amount_e5?: unknown }).amount_e5
  if (amount === undefined || amount === null) return new Prisma.Decimal(0)
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw new Error(`Monto de Uber corrupto en "${contexto}.amount_e5": ${JSON.stringify(amount)}`)
  }
  return new Prisma.Decimal(amount)
}

/**
 * Igual que `montoE5`, pero para los montos que un pedido NO puede no traer.
 *
 * La diferencia vale dinero: ausente-es-cero es correcto para la propina, pero aplicado al
 * total significaría crear una venta de $0 —ingerida como legítima y pagada— a partir de un
 * payload truncado.
 */
function montoE5Requerido(nodo: unknown, contexto: string): Prisma.Decimal {
  if (nodo === undefined || nodo === null || (nodo as { amount_e5?: unknown })?.amount_e5 === undefined) {
    throw new Error(`El pedido de Uber no trae "${contexto}": sin ese monto no se puede determinar la venta sin inventarla`)
  }
  return montoE5(nodo, contexto)
}

function tituloDe(t: unknown, contexto: string): string {
  if (typeof t === 'string' && t.trim()) return t.trim()
  throw new Error(`El pedido de Uber trae un item sin título legible (${contexto})`)
}

interface UapiMoney {
  amount_e5?: unknown
}

interface UapiBreakdownEntry {
  cart_item_id?: string
  price_type?: string
  total?: { gross?: UapiMoney }
  unit?: { gross?: UapiMoney }
}

export function mapUberOrder(raw: unknown): NormalizedDeliveryOrder {
  // `fetchUberOrder` devuelve `{order: {...}}`; se acepta también el objeto pelón por si un
  // webhook trae el pedido embebido sin el sobre.
  const envelope = raw as { order?: unknown }
  const d = (envelope?.order ?? raw) as {
    id?: string
    display_id?: string
    created_time?: string
    fulfillment_type?: unknown
    customers?: Array<{
      name?: { display_name?: string; first_name?: string; last_name?: string }
      contact?: { phone?: { number?: string } }
    }>
    carts?: Array<{
      items?: Array<{
        id?: string
        cart_item_id?: string
        title?: unknown
        quantity?: { amount?: unknown }
        customer_request?: { special_instructions?: unknown }
        /** Los extras que eligió el cliente. Su PRECIO no viene aquí: vive en el
         *  price_breakdown, indexado por el `cart_item_id` de cada opción. */
        selected_modifier_groups?: Array<{
          id?: string
          title?: unknown
          selected_items?: Array<{
            id?: string
            cart_item_id?: string
            external_data?: string
            title?: unknown
            quantity?: { amount?: unknown }
          }>
        }>
      }>
    }>
    status?: unknown
    scheduled_order_target_delivery_time_range?: { start_time?: unknown; end_time?: unknown }
    payment?: {
      payment_detail?: {
        currency_code?: string
        order_total?: { gross?: UapiMoney }
        item_charges?: { total?: { gross?: UapiMoney }; price_breakdown?: UapiBreakdownEntry[] }
        tips?: { total?: { gross?: UapiMoney } }
        /**
         * Promociones aplicadas al pedido (con IVA, como todo `gross`). Venía en el payload
         * desde siempre y el tipo no la declaraba, así que nadie podía leerla sin que el
         * compilador se quejara — parte de por qué el descuento se perdía en silencio.
         */
        promotions?: { total?: { gross?: UapiMoney } }
        fees?: { total?: { gross?: UapiMoney } }
      }
    }
  }

  if (typeof d?.id !== 'string' || !d.id) {
    throw new Error('El pedido de Uber no trae `id`: no se puede ingerir sin identidad')
  }

  const detail = d.payment?.payment_detail
  const moneda = detail?.currency_code ?? (detail?.order_total?.gross as { currency_code?: string })?.currency_code ?? 'MXN'
  if (moneda !== 'MXN') {
    throw new Error(`Moneda no soportada en el pedido ${d.id}: "${moneda}". Sólo MXN.`)
  }

  // ── Los repartos verificados con un pedido REAL ────────────────────────────────────
  //
  //   DELIVERY_BY_UBER     — reparte Uber. Cobra en su app, liquida todo. La propina es del
  //                          REPARTIDOR y no llega (medido: `tips` ausente).
  //   DELIVERY_BY_MERCHANT — reparte el NEGOCIO (lo que Uber llama BYOC). Verificado con el
  //                          pedido a4623ab7-… (30-ago) en la tienda de pruebas 2:
  //                            · el envío es $0.00 — lo pone el negocio, no Uber
  //                            · la PROPINA sí llega y es del NEGOCIO ($15.23; la app dice
  //                              "se envía al restaurante 1 hora después de la entrega")
  //                            · NO hay efectivo contra entrega: el cliente pagó con tarjeta
  //                              en la app y el único campo con "due" es
  //                              `marketplace_fee_due_to_uber` — lo que le debemos a Uber
  //                            · order_total ($160.23) = artículos ($145) + propina ($15.23)
  //                          El reparto de abajo ya lo maneja sin cambios: la propina se lee
  //                          defensivamente desde siempre y aquí simplemente aparece.
  //
  // 🔴 Cualquier OTRO tipo se sigue rechazando. Y para BYOC hay una guarda extra abajo:
  // este tipo es el que PUEDE traer efectivo contra entrega en otros mercados, y ese caso
  // nunca lo hemos visto. Si el dinero no cuadra exactamente, se rechaza en vez de suponer
  // que la diferencia es un cargo del comercio — suponerlo sub-reportaría la venta.
  const fulfillment = typeof d.fulfillment_type === 'string' ? d.fulfillment_type : 'DESCONOCIDO'
  if (fulfillment !== 'DELIVERY_BY_UBER' && fulfillment !== 'DELIVERY_BY_MERCHANT') {
    throw new Error(
      `Pedido de Uber ${d.id} con fulfillment_type="${fulfillment}": ese tipo de entrega aún no está verificado con un ` +
        `pedido real (reparto del efectivo/propina desconocido). Verifica manualmente antes de reintentar.`,
    )
  }

  // ── Precios por línea: viven en el breakdown, indexados por cart_item_id ───────────
  const breakdown = detail?.item_charges?.price_breakdown ?? []
  const porLinea = new Map<string, UapiBreakdownEntry>()
  for (const b of breakdown) {
    if (typeof b?.cart_item_id !== 'string') continue
    // 🔴 VARIAS entradas para el MISMO `cart_item_id` ⇒ RECHAZA. Se probó a sumarlas para
    // soportar un hipotético `ITEM` + `DISCOUNT`, y fue peor: el neto bajaba el total de la
    // línea pero NO `unitPrice` ni `discountAmount`, así que `lineRevenue` reportaba el
    // precio completo sobre una venta descontada — dinero mal, en silencio y para siempre
    // (Codex, 3ª pasada). Y era código escrito para un payload que NUNCA hemos visto: en los
    // 3 pedidos reales del sandbox no hay un solo id repetido.
    //
    // Se mantiene la política del repo: rechazar en vez de adivinar. El pedido queda FAILED
    // y VISIBLE para reconciliar, y el mensaje trae el payload que hace falta para cablearlo
    // de verdad — que es exactamente como se descubrieron OPTION y CUSTOMIZATION hoy.
    const previa = porLinea.get(b.cart_item_id)
    if (previa) {
      const importePrevio = montoE5(previa.total?.gross, `price_breakdown ${b.cart_item_id} (1ª)`)
      const importeNuevo = montoE5(b.total?.gross, `price_breakdown ${b.cart_item_id} (2ª)`)
      // Una segunda entrada en CERO no aporta dinero: se ignora sin tumbar la venta.
      if (importeNuevo.isZero()) continue
      if (!importePrevio.isZero()) {
        throw new Error(
          `Pedido de Uber ${d.id}: el price_breakdown trae DOS importes para el mismo cart_item_id ` +
            `"${b.cart_item_id}" (price_type="${String(previa.price_type)}" ${aPesos(importePrevio)} y ` +
            `"${String(b.price_type)}" ${aPesos(importeNuevo)}). Aún no se ha verificado con un pedido real ` +
            `cómo se reparte eso entre precio y descuento, y repartirlo mal descuadraría los reportes. ` +
            `Guarda este payload para cablearlo.`,
        )
      }
    }
    porLinea.set(b.cart_item_id, b)
  }

  // 🔴 QUÉ SE RECHAZA, Y POR QUÉ NO ES EL NOMBRE DEL TIPO (corregido tras la auditoría de
  // Codex, 27-ago). La versión anterior rechazaba cualquier `price_type` fuera de la lista
  // conocida. Suena prudente y es una VENTA PERDIDA: `processUberEvent` ACEPTA el pedido en
  // Uber ANTES de traducirlo (para no perder el plazo de ~11.5 min), así que un tipo nuevo
  // —un `DISCOUNT`, una promoción— dejaba al cliente cobrado, a Uber contando la venta, y al
  // restaurante sin comanda. Para siempre: cada reintento fallaba igual.
  //
  // La pregunta correcta no es "¿conozco este nombre?" sino "¿queda dinero sin colocar?".
  // Se rechaza sólo cuando una entrada con IMPORTE distinto de cero no aterriza en ninguna
  // línea — que es exactamente el caso en que la comanda cobraría mal. Una entrada nueva en
  // $0.00 (como los `CUSTOMIZATION` que son el contenedor del grupo) no mueve un centavo y
  // deja pasar el pedido.
  //
  // Tipos vistos en pedidos reales del sandbox: ITEM (producto base, ya multiplicado por la
  // cantidad), OPTION (cada extra) y CUSTOMIZATION ($0.00, el grupo).
  const colocadas = new Set<string>()

  const items: NormalizedDeliveryItem[] = []
  for (const cart of d.carts ?? []) {
    for (const [i, it] of (cart.items ?? []).entries()) {
      const cantidadCruda = it.quantity?.amount
      // 🔴 OBJETO `{amount}` — al revés que la API clásica, donde era un entero. Verificado
      // con el pedido real. Sin cantidad legible se asume 1, igual que siempre.
      // 🔴 Ausente ⇒ 1 (legítimo). PRESENTE pero imposible ⇒ RECHAZA (Codex, 2ª pasada):
      // un 0 o un negativo convertidos en 1 en silencio le mienten a la cocina y al cobro,
      // y una fracción (0.5) revienta al guardarse en la columna `Int` DESPUÉS de haber
      // aceptado el pedido en Uber — o sea, venta perdida con el cliente ya cobrado.
      if (cantidadCruda !== undefined && cantidadCruda !== null) {
        if (typeof cantidadCruda !== 'number' || !Number.isInteger(cantidadCruda) || cantidadCruda <= 0) {
          throw new Error(
            `Pedido de Uber ${d.id}: el item "${String(it.id ?? i)}" trae quantity.amount=${JSON.stringify(cantidadCruda)}, ` +
              `que no es un entero positivo. No se ingiere para no inventar cuánto se vendió.`,
          )
        }
      }
      const cantidad = typeof cantidadCruda === 'number' ? cantidadCruda : 1

      const linea = typeof it.cart_item_id === 'string' ? porLinea.get(it.cart_item_id) : undefined
      if (!linea) {
        throw new Error(
          `Pedido de Uber ${d.id}: el item "${String(it.id ?? i)}" no aparece en price_breakdown — sin su precio no se ` +
            `puede ingerir la venta sin inventarla`,
        )
      }

      if (typeof it.cart_item_id === 'string') colocadas.add(it.cart_item_id)
      const totalLinea = montoE5Requerido(linea.total?.gross, `item ${i} price_breakdown.total.gross`)
      // `unit` es opcional; sin él se deriva del total para que `unitPrice × cantidad` siga
      // siendo la base de la línea — que es lo que los reportes multiplican.
      const unitario = linea.unit?.gross
        ? montoE5(linea.unit.gross, `item ${i} price_breakdown.unit.gross`)
        : totalLinea.dividedBy(cantidad)

      const notas = it.customer_request?.special_instructions

      // ── Los extras que eligió el cliente ────────────────────────────────────────────
      // Viven DENTRO del item (`selected_modifier_groups[].selected_items[]`) pero su
      // DINERO vive fuera, en el breakdown, indexado por el `cart_item_id` PROPIO de cada
      // opción. Sin unir las dos mitades el extra llega gratis: la cocina prepara el
      // aderezo y el cobro no lo incluye.
      const modifiers: NormalizedDeliveryModifier[] = []
      // POR UNIDAD del padre: la entrada ITEM ya viene multiplicada por la cantidad
      // ($338 = 169x2) pero las OPTION vienen por unidad ($15, $10) aunque el cliente pague
      // dos de cada una. Medido con un pedido real de cantidad 2 el 27-ago.
      let extrasPorUnidad = new Prisma.Decimal(0)
      for (const grupo of it.selected_modifier_groups ?? []) {
        for (const [j, sel] of (grupo?.selected_items ?? []).entries()) {
          const entrada = typeof sel?.cart_item_id === 'string' ? porLinea.get(sel.cart_item_id) : undefined
          // Un extra SIN entrada en el breakdown es gratis ($0), no un error: los grupos
          // llegan como CUSTOMIZATION en cero y hay opciones que de verdad no cuestan.
          if (entrada && typeof sel?.cart_item_id === 'string') colocadas.add(sel.cart_item_id)
          const totalDelExtra = entrada ? montoE5(entrada.total?.gross, `modificador ${i}.${j} total.gross`) : new Prisma.Decimal(0)
          extrasPorUnidad = extrasPorUnidad.plus(totalDelExtra)

          // Misma regla que la cantidad del producto: ausente ⇒ 1; presente pero imposible
          // ⇒ RECHAZA (Codex, 3ª pasada). Un 0 convertido en 1 le miente a la cocina, y una
          // fracción revienta al guardarse en la columna `Int` DESPUÉS de aceptar el pedido.
          const cantidadCrudaMod = sel?.quantity?.amount
          if (cantidadCrudaMod !== undefined && cantidadCrudaMod !== null) {
            if (typeof cantidadCrudaMod !== 'number' || !Number.isInteger(cantidadCrudaMod) || cantidadCrudaMod <= 0) {
              throw new Error(
                `Pedido de Uber ${d.id}: el modificador ${i}.${j} trae quantity.amount=` +
                  `${JSON.stringify(cantidadCrudaMod)}, que no es un entero positivo. No se ingiere para no ` +
                  `inventar cuánto se pidió.`,
              )
            }
          }
          const cantidadPropia = typeof cantidadCrudaMod === 'number' ? cantidadCrudaMod : 1

          // 🔴 EL CONTRATO YA ESTÁ DECLARADO EN EL NÚCLEO, y es el que se respeta —
          // `deliveryOrderIngestion.service.ts`: "`modifier.price` ya viene multiplicado por
          // la cantidad del padre; sólo falta la cantidad PROPIA del modifier para el monto
          // total de esa línea". O sea: precio = unitario × cantidad del producto,
          // cantidad = las que pidió de ese extra POR producto.
          //
          // Por qué importa: `lineRevenue.ts` (el SQL con el que el dashboard calcula
          // ingresos) hace `unitPrice × cantidad + Σ(price × quantity)` y NO multiplica los
          // modificadores por la cantidad del padre. Con el precio "a secas" el reporte
          // decía $363 sobre una venta de $388 (lo cazó Codex leyendo `lineGrossSql`).
          // Se sigue la convención del núcleo en vez de inventar una tercera.
          const unitarioDelExtra = entrada?.unit?.gross
            ? montoE5(entrada.unit.gross, `modificador ${i}.${j} unit.gross`)
            : totalDelExtra.dividedBy(cantidadPropia)
          const precioDelExtra = unitarioDelExtra.mul(cantidad)

          modifiers.push({
            externalId: String(sel?.external_data ?? sel?.id ?? `mod-${i}-${j}`),
            name: tituloDe(sel?.title, `modificador ${i}.${j}`),
            quantity: cantidadPropia,
            price: aPesos(precioDelExtra),
          })
        }
      }

      items.push({
        // `id` ES lo que Avoqado escribió al publicar el menú (verificado: "external_item_1"
        // en el pedido real) — es la llave con la que la ingesta resuelve el producto.
        externalId: String(it.id ?? `sin-id-${i}`),
        externalData: typeof it.id === 'string' ? it.id : null,
        name: tituloDe(it.title, `item ${i}`),
        // ✓ VERIFICADO con pedido real ("Sin cebolla, por favor") — en la API clásica nunca
        // logramos ver una nota; en el uAPI sí llegan y la cocina las lee en la comanda.
        notes: typeof notas === 'string' && notas.trim() ? notas.trim() : null,
        quantity: cantidad,
        unitPrice: aPesos(unitario),
        // La línea COMPLETA: la base (que ya trae la cantidad dentro) más los extras
        // multiplicados por esa misma cantidad. Es lo que hace que cuadre contra
        // `item_charges` — hay un test con el pedido real de cantidad 2.
        total: aPesos(totalLinea.plus(extrasPorUnidad.mul(cantidad))),
        modifiers,
      })
    }
  }

  // 🔴 EL GUARD REAL: dinero que Uber cobró y que no aterrizó en ninguna línea. Cubre a la
  // vez el tipo desconocido con importe y la entrada huérfana (una OPTION cuyo
  // `cart_item_id` no aparece en ningún `selected_modifier_groups`), que descuadraría la
  // venta sin que ningún nombre de tipo lo delatara.
  for (const b of breakdown) {
    if (typeof b?.cart_item_id !== 'string' || colocadas.has(b.cart_item_id)) continue
    const huerfano = montoE5(b.total?.gross, `price_breakdown huérfano ${b.cart_item_id}`)
    if (!huerfano.isZero()) {
      throw new Error(
        `Pedido de Uber ${d.id}: el price_breakdown trae ${aPesos(huerfano)} con price_type=` +
          `"${String(b.price_type)}" que no corresponde a ningún artículo ni a ningún extra del carrito. ` +
          `No se ingiere para no repartir mal el dinero.`,
      )
    }
  }

  // ── Reparto del dinero ─────────────────────────────────────────────────────────────
  // `item_charges.total` son los artículos (con IVA — `is_tax_inclusive: true`, México);
  // `order_total` es lo que el cliente pagó al comercio en total. Lo que exceda, menos la
  // propina, son cargos del comercio. En DELIVERY_BY_UBER la propina es del repartidor de
  // Uber y no llega (mismo comportamiento medido en la API clásica); el lector defensivo
  // queda por si algún día aparece.
  const subTotal = montoE5Requerido(detail?.item_charges?.total?.gross, 'payment_detail.item_charges.total.gross')
  const total = montoE5Requerido(detail?.order_total?.gross, 'payment_detail.order_total.gross')
  const propina = montoE5(detail?.tips?.total?.gross, 'payment_detail.tips.total.gross')
  // 🔴 La PROMOCIÓN. Venía en el mensaje desde siempre y no la leía nadie: `order_total` es
  // lo que el cliente pagó YA con el descuento, así que `total − subTotal` salía NEGATIVO y
  // el `max(0, …)` lo aplastaba a cero. El pedido se registraba como si se hubiera cobrado el
  // precio de lista, y el reporte de ventas quedaba por encima del depósito de Uber.
  const descuento = montoE5(detail?.promotions?.total?.gross, 'payment_detail.promotions.total.gross')
  // Los cargos del comercio se miden contra el precio YA descontado: sumarle el descuento de
  // vuelta convertiría la promoción en un cargo inventado.
  const cargosComercio = Prisma.Decimal.max(new Prisma.Decimal(0), total.plus(descuento).minus(subTotal).minus(propina))

  // 🔴 GUARDA DEL BYOC: en este reparto el negocio entrega, y es el escenario donde en otros
  // mercados aparece el efectivo contra entrega — un caso que NO hemos visto en un pedido
  // real. `cashDueSale`/`cashDueTip` se escriben en cero más abajo; si de verdad hubiera
  // efectivo, ese cero registraría como liquidado por la plataforma dinero que el repartidor
  // trae en la mano, y el arqueo del negocio saldría corto sin que nada falle.
  //
  // No se puede detectar un campo que no conocemos, así que se comprueba la ARITMÉTICA: en
  // el pedido real todo cuadra al centavo (145.00 + 15.23 = 160.23). Si un día no cuadra,
  // significa que hay dinero en el mensaje que no estamos leyendo, y ahí se para.
  if (fulfillment === 'DELIVERY_BY_MERCHANT') {
    const reconstruido = subTotal.plus(propina).plus(cargosComercio).minus(descuento)
    if (!reconstruido.equals(total)) {
      throw new Error(
        `Pedido BYOC de Uber ${d.id}: el dinero no cuadra — artículos ${aPesos(subTotal)} + propina ${aPesos(propina)} + ` +
          `cargos ${aPesos(cargosComercio)} − promoción ${aPesos(descuento)} = ${aPesos(reconstruido)}, pero order_total dice ` +
          `${aPesos(total)}. Hay dinero en el mensaje que no estamos leyendo (¿efectivo contra entrega?). No se ingiere.`,
      )
    }
  }

  return {
    externalId: d.id,
    displayId: String(d.display_id ?? d.id.slice(0, 8)),
    source: OrderSource.UBER_EATS,
    items,
    payment: {
      currency: 'MXN',
      // BRUTO, como Square: las ventas brutas no se ajustan por descuentos, y así los
      // renglones siguen cuadrando al centavo contra este número.
      saleAmount: aPesos(subTotal),
      merchantFees: aPesos(cargosComercio),
      discountAmount: aPesos(descuento),
      tipAmount: aPesos(propina),
      // Lo que Uber liquida SÍ baja por la promoción: es lo que de verdad va a depositar.
      externallyPaidSale: aPesos(subTotal.plus(cargosComercio).minus(descuento)),
      externallyPaidTip: aPesos(propina),
      cashDueSale: '0.00',
      cashDueTip: '0.00',
    },
    customer: {
      name:
        d.customers?.[0]?.name?.display_name ??
        ([d.customers?.[0]?.name?.first_name, d.customers?.[0]?.name?.last_name].filter(Boolean).join(' ') || undefined),
      phone: d.customers?.[0]?.contact?.phone?.number,
    },
    raw,
    placedAt: d.created_time ? new Date(d.created_time) : new Date(),
    // 🔴 PROGRAMADO — cableado con un pedido REAL (8919c3ff-…, 30-ago), no con el puente
    // que había antes. Ese puente leía los nombres de la API CLÁSICA
    // (`scheduled_order` + `estimated_ready_for_pickup_at`) y en el uAPI NO EXISTEN: un
    // pedido agendado para MAÑANA entró como normal y su comanda salió a la cocina HOY.
    // Se midió: `scheduledFor: null` y una comanda creada al instante.
    //
    // Lo que el uAPI sí manda:
    //   status: "SCHEDULED"                                   ← la marca, arriba del todo
    //   scheduled_order_target_delivery_time_range: {start_time, end_time}
    //   action_eligibility.adjust_ready_for_pickup_time.reason = "SCHEDULED_ORDER_NOT_YET_ACTIVE"
    //
    // Se usa el INICIO de la ventana de entrega. Es lo que el flujo ya construido necesita
    // para no mandar la comanda hasta su hora, y llegar tarde a un pedido agendado es peor
    // que prepararlo con holgura.
    scheduledFor: fechaProgramada(d),
  }
}

/**
 * La hora para la que el cliente agendó el pedido, o `null` si es para ahora.
 *
 * Se exige que el pedido DIGA que está programado (`status: "SCHEDULED"`) antes de mirar la
 * ventana: sin esa condición, cualquier estimación de entrega convertiría un pedido normal en
 * uno agendado y la cocina no lo vería hasta esa hora — un pedido que el cliente espera YA.
 */
function fechaProgramada(d: { status?: unknown; scheduled_order_target_delivery_time_range?: { start_time?: unknown } }): Date | null {
  if (d.status !== 'SCHEDULED') return null

  const inicio = d.scheduled_order_target_delivery_time_range?.start_time
  if (typeof inicio !== 'string') return null

  // 🔴 SE EXIGE EL FORMATO, no basta con que `new Date` no falle. Lo destapó una prueba:
  // `new Date('mañana como a las 8')` NO devuelve Invalid Date — devuelve
  // 2001-08-01T05:00:00Z, porque el parser de JavaScript encuentra "a las 8" y arma una
  // fecha con lo que puede. O sea que una cadena basura produce una fecha VÁLIDA y
  // completamente equivocada, que es peor que un error: el pedido se liberaría a una hora
  // inventada —en el pasado, así que a la cocina de inmediato— sin que nada falle.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(inicio)) return null

  const cuando = new Date(inicio)
  return Number.isNaN(cuando.getTime()) ? null : cuando
}
