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
 * Módulo PURO: sin Prisma, sin env, sin red. Recibe el JSON y devuelve el contrato.
 */
import { OrderSource } from '@prisma/client'

import type { NormalizedDeliveryItem, NormalizedDeliveryModifier, NormalizedDeliveryOrder } from '../../core/types'

/** Centavos enteros → pesos con dos decimales. El único lugar donde se divide entre 100. */
function aPesos(centavos: unknown): string {
  const n = typeof centavos === 'number' ? centavos : Number(centavos)
  if (!Number.isFinite(n)) throw new Error(`Monto de Uber ilegible: ${JSON.stringify(centavos)}`)
  return (n / 100).toFixed(2)
}

function montoDe(charge: unknown): number {
  const c = charge as { amount?: unknown } | undefined
  const n = typeof c?.amount === 'number' ? c.amount : 0
  return Number.isFinite(n) ? n : 0
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
      const unitario = montoDe(it.price?.unit_price)
      salida.push({
        externalId: String(it.id ?? ''),
        name: tituloDe(it.title, 'modificador'),
        quantity: cantidad,
        price: aPesos(unitario * cantidadPadre),
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

    const totalLinea = montoDe(it.price?.total_price) + modifiers.reduce((a, m) => a + Number(m.price) * 100, 0)

    return {
      externalId: String(it.id ?? `sin-id-${i}`),
      // El `id` del item ES lo que Avoqado escribió al publicar el menú; `external_data`
      // se prefiere si Uber lo manda por separado en algún tipo de pedido.
      externalData: it.external_data ?? (typeof it.id === 'string' ? it.id : null),
      name: tituloDe(it.title, `item ${i}`),
      quantity: cantidad,
      unitPrice: aPesos(montoDe(it.price?.unit_price)),
      total: aPesos(totalLinea),
      modifiers,
    }
  })

  // ── Reparto del dinero ─────────────────────────────────────────────────────────────
  // `sub_total` son los artículos; lo que exceda en `total` son cargos que el cliente paga
  // AL COMERCIO. La propina sólo aparece en pedidos que reparte el propio restaurante:
  // en DELIVERY_BY_UBER es del repartidor de Uber y NO llega — verificado con el pedido real.
  const subTotal = montoDe(charges.sub_total)
  const total = montoDe(charges.total)
  const propina = montoDe(charges.tip)
  const cargosComercio = Math.max(0, total - subTotal - propina)

  // Uber liquida todo lo cobrado en su app; no queda nada por cobrar en persona.
  // (Un pedido BYOC con efectivo repartiría distinto — no lo inventamos hasta tener uno.)
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
      externallyPaidSale: aPesos(subTotal + cargosComercio),
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
