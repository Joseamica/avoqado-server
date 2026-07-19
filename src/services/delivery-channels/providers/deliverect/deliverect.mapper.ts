import { DeliveryChannelLink, OrderSource } from '@prisma/client'
import { NormalizedDeliveryOrder, NormalizedDeliveryItem, DeliveryOrderStatus } from '../../core/types'

/**
 * Mapa status interno → código numérico de Deliverect.
 * Fuente: developers.deliverect.com/order-status — REVALIDAR EN STAGING.
 */
export const DELIVERECT_STATUS_MAP: Record<DeliveryOrderStatus, number> = {
  ACCEPTED: 20,
  PREPARING: 30,
  READY: 40,
  PICKED_UP: 50,
  CANCELLED: 110,
  FAILED: 120,
}

export function resolveOrderSource(channelId: number | undefined, link: DeliveryChannelLink): OrderSource {
  const map = ((link.config as any)?.channelSourceMap ?? {}) as Record<string, string>
  const mapped = channelId != null ? map[String(channelId)] : undefined
  if (mapped && mapped in OrderSource) return mapped as OrderSource
  return OrderSource.DELIVERY_PLATFORM
}

/** centavos (o la unidad que declare decimalDigits) → PESOS. SOLO aquí se divide. */
function toPesos(minor: number | undefined | null, decimalDigits: number): number {
  if (minor == null) return 0
  return Math.round(minor) / Math.pow(10, decimalDigits)
}

export function parseDeliverectOrder(rawBody: Buffer, link: DeliveryChannelLink): NormalizedDeliveryOrder {
  let p: any
  try {
    p = JSON.parse(rawBody.toString('utf8'))
  } catch {
    throw new Error('Deliverect: payload no es JSON válido')
  }
  if (!p?.channelOrderId || !Array.isArray(p?.items)) {
    throw new Error('Deliverect: payload sin channelOrderId/items')
  }
  const dd = typeof p.decimalDigits === 'number' ? p.decimalDigits : 2

  const items: NormalizedDeliveryItem[] = p.items.map((it: any) => ({
    plu: String(it.plu ?? ''),
    name: String(it.name ?? 'Producto'),
    quantity: Number(it.quantity ?? 1),
    unitPrice: toPesos(it.price, dd),
    modifiers: (it.subItems ?? []).map((s: any) => ({
      plu: String(s.plu ?? ''),
      name: String(s.name ?? 'Modificador'),
      quantity: Number(s.quantity ?? 1),
      unitPrice: toPesos(s.price, dd),
    })),
    notes: it.remark ? String(it.remark) : undefined,
  }))

  const subtotal = items.reduce(
    (sum, it) => sum + it.unitPrice * it.quantity + it.modifiers.reduce((m, s) => m + s.unitPrice * s.quantity, 0),
    0,
  )

  return {
    externalId: String(p.channelOrderId),
    displayId: String(p.channelOrderDisplayId ?? p.channelOrderId),
    source: resolveOrderSource(p.channel, link),
    items,
    subtotal: Math.round(subtotal * 100) / 100,
    taxAmount: toPesos(p.taxTotal, dd),
    discountAmount: toPesos(p.discountTotal, dd),
    tipAmount: toPesos(p.tip, dd),
    serviceChargeAmount: toPesos(p.serviceCharge, dd),
    deliveryFeeAmount: toPesos(p.deliveryCost, dd),
    total: toPesos(p.payment?.amount, dd),
    customer: p.customer || p.note ? { name: p.customer?.name, phone: p.customer?.phoneNumber, note: p.note } : undefined,
    raw: p,
    placedAt: p.createdAt ? new Date(p.createdAt) : new Date(),
  }
}

// ============================================================================
// Task 8: Deliverect Menu Mapper
// ============================================================================

export interface DeliverectProductsPayload {
  products: Array<{
    plu: string
    name: string
    description?: string
    price: number // CENTAVOS
    imageURL?: string
    productType: number // 1=product, 2=modifier, 3=modifierGroup
    subProducts?: string[]
  }>
}

/** PESOS → centavos. La ÚNICA multiplicación ×100 permitida (frontera Deliverect). */
const toCents = (pesos: number): number => Math.round(pesos * 100)

export function mapSnapshotToDeliverectProducts(
  snapshot: import('../../core/menuSnapshot.service').MenuSnapshot,
): DeliverectProductsPayload {
  const products: DeliverectProductsPayload['products'] = []
  const seenPlus = new Set<string>() // dedup O(1) — .some() sobre el array crece O(n²) con catálogos grandes
  for (const category of snapshot.categories) {
    for (const p of category.products) {
      products.push({
        plu: p.plu,
        name: p.name,
        description: p.description ?? undefined,
        price: toCents(p.price),
        imageURL: p.imageUrl ?? undefined,
        productType: 1,
        subProducts: p.modifierGroups.map(g => `GRP-${g.id}`),
      })
      seenPlus.add(p.plu)
      for (const g of p.modifierGroups) {
        if (!seenPlus.has(`GRP-${g.id}`)) {
          products.push({
            plu: `GRP-${g.id}`,
            name: g.name,
            price: 0,
            productType: 3,
            subProducts: g.modifiers.map(m => m.plu),
          })
          seenPlus.add(`GRP-${g.id}`)
          for (const m of g.modifiers) {
            if (!seenPlus.has(m.plu)) {
              products.push({
                plu: m.plu,
                name: m.name,
                price: toCents(m.price),
                productType: 2,
              })
              seenPlus.add(m.plu)
            }
          }
        }
      }
    }
  }
  return { products }
}
