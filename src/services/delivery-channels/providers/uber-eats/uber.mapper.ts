/**
 * Traductor: formato crudo de Uber Eats → contrato interno (`NormalizedDeliveryOrder`).
 *
 * ESCRITO CONTRA UN PEDIDO REAL (2026-08-20, tienda "Avoqado Sandbox 1"), no contra la
 * documentación. El pedido real corrigió tres suposiciones que la spec traía mal y que
 * habrían roto esto en producción:
 *
 *   1. `title` es un STRING plano en el pedido. Lo de `title.translations.en` es del MENÚ.
 *   2. `quantity` es un ENTERO, no un objeto con `.amount`.
 *   3. `selected_modifier_groups` llega `null`, no como lista vacía.
 *
 * 🔴 El ÷100 de centavos a pesos ocurre AQUÍ y sólo aquí. De este módulo hacia adentro,
 * todo el dinero es string decimal en pesos (`.claude/rules/critical-warnings.md`).
 *
 * Módulo PURO: sin Prisma CLIENT (sin DB/red/env) — sí usa `Prisma.Decimal`, igual que
 * `core/money.ts`, que es sólo un tipo de dato, no un acceso a la base.
 */
import { OrderSource, Prisma } from '@prisma/client'

import type { NormalizedDeliveryItem, NormalizedDeliveryModifier, NormalizedDeliveryOrder } from '../../core/types'

/** Centavos Decimal → pesos con dos decimales. El único lugar donde se divide entre 100. */
function aPesos(centavos: Prisma.Decimal): string {
  return centavos.dividedBy(100).toFixed(2)
}

/**
 * Extrae `.amount` (centavos) de un objeto Money de Uber (`{ amount, currency_code, ... }`)
 * como `Prisma.Decimal` — nunca `number`.
 *
 * 🔴 HALLAZGO 1 (auditoría externa, 2026-08-20): antes esta función (y toda la aritmética
 * que la rodeaba: restas, multiplicaciones) trabajaba en `number` — viola
 * `.claude/rules/critical-warnings.md` ("Money = Decimal, Never Float") y permite redondeos
 * silenciosos del estilo `0.1 + 0.2 !== 0.3`. En valores extremos (que un payload corrupto
 * SÍ podría traer) `number` pierde precisión de verdad: `3002399751580331 * 3` da
 * `9007199254740992` en `number` (equivocado por 1 centavo) vs. `9007199254740993` exacto
 * en Decimal — cruza `Number.MAX_SAFE_INTEGER` (2^53). Con montos normales de un pedido el
 * error de `number` es demasiado chico para verse en el string final (`.toFixed(2)` lo
 * absorbe), pero la regla del repo es categórica: nunca `number` para dinero, sin excepción
 * "no se nota".
 *
 * 🔴 HALLAZGO 3 (misma auditoría): distingue "el cargo no existe" de "existe pero está mal
 * tipado". Antes ambos casos colapsaban en silencio a 0: un `charges.total.amount` corrupto
 * (string, objeto, booleano, NaN) producía un pedido de $0 que el núcleo marca PAID y
 * descuenta inventario de comida jamás cobrada.
 *   - El CARGO entero ausente (`undefined`/`null` — Uber usa `null` como "sin valor real" en
 *     este mismo payload, ver `selected_modifier_groups`) o presente sin `.amount`: legítimo
 *     — es exactamente el caso de `charges.tip` en un pedido sin propina. ⇒ 0.
 *   - `.amount` presente pero no un número finito (string, objeto, booleano, NaN, null
 *     explícito EN amount): payload corrupto. ⇒ RECHAZA.
 */
function montoDe(charge: unknown, contexto: string): Prisma.Decimal {
  if (charge === undefined || charge === null) return new Prisma.Decimal(0)
  if (typeof charge !== 'object' || Array.isArray(charge)) {
    throw new Error(`Monto de Uber corrupto en "${contexto}": se esperaba un objeto de dinero, llegó ${JSON.stringify(charge)}`)
  }
  const amount = (charge as { amount?: unknown }).amount
  if (amount === undefined || amount === null) return new Prisma.Decimal(0)
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw new Error(`Monto de Uber corrupto en "${contexto}.amount": ${JSON.stringify(amount)}`)
  }
  return new Prisma.Decimal(amount)
}

/**
 * El título del pedido es texto plano. Se acepta también la forma con traducciones por si
 * Uber la usa en algún tipo de pedido que todavía no hemos visto — pero NUNCA se inventa un
 * nombre: sin título legible, el pedido se rechaza.
 */
function tituloDe(t: unknown, contexto: string): string {
  if (typeof t === 'string' && t.trim()) return t.trim()
  const trad = (t as { translations?: Record<string, string> })?.translations
  if (trad) {
    const primero = Object.values(trad).find(v => typeof v === 'string' && v.trim())
    if (primero) return primero.trim()
  }
  throw new Error(`El pedido de Uber trae un item sin título legible (${contexto})`)
}

function mapModificadores(grupos: unknown, cantidadPadre: number): NormalizedDeliveryModifier[] {
  // 🔴 `null` es el valor REAL cuando no hay modificadores — verificado en el pedido real.
  if (!Array.isArray(grupos)) return []

  const salida: NormalizedDeliveryModifier[] = []
  for (const g of grupos) {
    const items = (g as { selected_items?: unknown[] })?.selected_items
    if (!Array.isArray(items)) continue

    for (const m of items) {
      const it = m as { id?: string; title?: unknown; quantity?: unknown; price?: { unit_price?: unknown } }
      const cantidad = typeof it.quantity === 'number' ? it.quantity : 1
      // 🔴 `price` es UNITARIO. La cantidad propia viaja en `quantity` y el core la guarda
      // aparte, así que multiplicarla aquí la contaría DOS veces: un reporte que haga
      // `price × quantity` (dashboard/lineRevenue.ts) cobraría el doble. Lo único que sí se
      // aplica es la cantidad del PADRE: [doc] 2 hamburguesas con extra queso c/u cuestan
      // 2× el extra, y esa multiplicación no la hace nadie más.
      const unitario = montoDe(it.price?.unit_price, `modificador "${String(it.id ?? '?')}" price.unit_price`)
      salida.push({
        externalId: String(it.id ?? ''),
        name: tituloDe(it.title, 'modificador'),
        quantity: cantidad,
        price: aPesos(unitario.times(cantidadPadre)),
      })
    }
  }
  return salida
}

export function mapUberOrder(raw: unknown): NormalizedDeliveryOrder {
  const d = raw as {
    id?: string
    display_id?: string
    placed_at?: string
    /** DINE_IN/PICK_UP/DELIVERY_BY_UBER/DELIVERY_BY_RESTAURANT — sólo se lee para el mensaje
     * de error del Hallazgo 4 (BYOC); no cambia el reparto por sí solo. */
    type?: unknown
    cart?: { items?: unknown[] }
    payment?: { charges?: Record<string, unknown> }
    eater?: { first_name?: string; last_name?: string; phone?: string }
  }

  if (typeof d?.id !== 'string' || !d.id) {
    throw new Error('El pedido de Uber no trae `id`: no se puede ingerir sin identidad')
  }

  const charges = d.payment?.charges ?? {}
  const moneda = (charges.total as { currency_code?: string })?.currency_code ?? 'MXN'
  if (moneda !== 'MXN') {
    throw new Error(`Moneda no soportada en el pedido ${d.id}: "${moneda}". Sólo MXN.`)
  }

  // ── HALLAZGO 4 (auditoría externa, 2026-08-20) ──────────────────────────────────────
  // Este mapper fijaba cashDueSale/cashDueTip en '0.00' SIEMPRE — válido sólo para pedidos
  // que Uber liquida 100% en su app (DELIVERY_BY_UBER, el único tipo verificado con un
  // pedido real). Un pedido BYOC (`type: DELIVERY_BY_RESTAURANT`) con efectivo contra
  // entrega (`cash_amount_due` > 0) quedaría marcado PAID sin serlo: Payment externo creado,
  // inventario descontado, sin que el cobro real haya ocurrido nunca.
  //
  // NO tenemos un pedido BYOC real para verificar el reparto exacto de `cash_amount_due`
  // entre "efectivo que se queda el comercio" (cashDueSale/cashDueTip) y "efectivo que el
  // comercio cobra EN NOMBRE de Uber" — riesgo ya documentado en
  // docs/superpowers/specs/2026-08-17-delivery-uber-eats-ANEXO-investigacion.md §5.1 como
  // `cashPassThroughToPlatform`, campo que el contrato `NormalizedDeliveryPayment` todavía
  // NO tiene. Adivinar ese reparto podría sub-reportar o sobre-reportar la venta del
  // comercio, así que: RECHAZA en vez de adivinar.
  //
  // Pendiente de verificar con un pedido BYOC real de Uber antes de soportarlo:
  //   1. ¿`cash_amount_due` incluye la propina o sólo la venta de artículos?
  //   2. ¿Uber cobra algo en efectivo PARA SÍ MISMO en este flujo (comisión, envío)? Si sí,
  //      hace falta el campo `cashPassThroughToPlatform` en el contrato antes de soportarlo.
  //   3. ¿El campo puede aparecer legítimamente con `type` distinto de
  //      DELIVERY_BY_RESTAURANT? (Aquí se rechaza esa combinación por no estar documentada.)
  const cashAmountDue = montoDe(charges.cash_amount_due, 'payment.charges.cash_amount_due')
  if (!cashAmountDue.isZero()) {
    throw new Error(
      `Pedido de Uber ${d.id} (type="${String(d.type ?? '?')}") trae cash_amount_due=${aPesos(cashAmountDue)} pesos: ` +
        `entrega con efectivo contra entrega (BYOC) todavía no está soportada — no hay un pedido real para verificar cómo ` +
        `repartir ese efectivo entre la venta del comercio y los cargos que se cobran en efectivo para Uber. Verifica ` +
        `manualmente con Uber antes de reintentar.`,
    )
  }

  const items: NormalizedDeliveryItem[] = (d.cart?.items ?? []).map((raw, i) => {
    const it = raw as {
      id?: string
      external_data?: string
      title?: unknown
      quantity?: unknown
      price?: { unit_price?: unknown; total_price?: unknown }
      selected_modifier_groups?: unknown
    }
    // 🔴 ENTERO, no objeto — verificado en el pedido real.
    const cantidad = typeof it.quantity === 'number' ? it.quantity : 1
    const modifiers = mapModificadores(it.selected_modifier_groups, cantidad)

    const modifiersTotalCentavos = modifiers.reduce((acc, m) => acc.plus(new Prisma.Decimal(m.price).times(100)), new Prisma.Decimal(0))
    const totalLinea = montoDe(it.price?.total_price, `item ${i} price.total_price`).plus(modifiersTotalCentavos)

    return {
      externalId: String(it.id ?? `sin-id-${i}`),
      // El `id` del item ES lo que Avoqado escribió al publicar el menú; `external_data`
      // se prefiere si Uber lo manda por separado en algún tipo de pedido.
      externalData: it.external_data ?? (typeof it.id === 'string' ? it.id : null),
      name: tituloDe(it.title, `item ${i}`),
      quantity: cantidad,
      unitPrice: aPesos(montoDe(it.price?.unit_price, `item ${i} price.unit_price`)),
      total: aPesos(totalLinea),
      modifiers,
    }
  })

  // ── Reparto del dinero ─────────────────────────────────────────────────────────────
  // `sub_total` son los artículos; lo que exceda en `total` son cargos que el cliente paga
  // AL COMERCIO. La propina sólo aparece en pedidos que reparte el propio restaurante:
  // en DELIVERY_BY_UBER es del repartidor de Uber y NO llega — verificado con el pedido real.
  const subTotal = montoDe(charges.sub_total, 'payment.charges.sub_total')
  const total = montoDe(charges.total, 'payment.charges.total')
  const propina = montoDe(charges.tip, 'payment.charges.tip')
  const cargosComercio = Prisma.Decimal.max(new Prisma.Decimal(0), total.minus(subTotal).minus(propina))

  // Uber liquida todo lo cobrado en su app; no queda nada por cobrar en persona (ya
  // validado arriba: cash_amount_due, si viene, está en cero — Hallazgo 4).
  return {
    externalId: d.id,
    displayId: String(d.display_id ?? d.id.slice(0, 8)),
    source: OrderSource.UBER_EATS,
    items,
    payment: {
      currency: 'MXN',
      saleAmount: aPesos(subTotal),
      merchantFees: aPesos(cargosComercio),
      tipAmount: aPesos(propina),
      externallyPaidSale: aPesos(subTotal.plus(cargosComercio)),
      externallyPaidTip: aPesos(propina),
      cashDueSale: '0.00',
      cashDueTip: '0.00',
    },
    customer: {
      name: [d.eater?.first_name, d.eater?.last_name].filter(Boolean).join(' ') || undefined,
      phone: d.eater?.phone,
    },
    raw,
    placedAt: d.placed_at ? new Date(d.placed_at) : new Date(),
  }
}
