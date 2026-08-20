import { DeliveryChannelLink, OrderSource } from '@prisma/client'
import { NormalizedDeliveryOrder, NormalizedDeliveryItem, NormalizedDeliveryModifier, DeliveryOrderStatus } from '../../core/types'

/**
 * Mapa status interno → código numérico de Deliverect.
 * Fix C2 (auditoría G-Stack + Codex, 2026-07-19, spec §10.1.6): el scaffold asumió
 * PREPARING/READY/PICKED_UP = 30/40/50 — la doc real de "update-order-status" confirma
 * preparación/listo/final = 50/70/90 (corregidos abajo).
 * Doc: https://developers.deliverect.com/reference/update-order-status-1
 * REVALIDAR EN STAGING: ACCEPTED/CANCELLED/FAILED NO están confirmados contra la doc en
 * esta pasada (el hallazgo de la auditoría solo cubrió preparación/listo/final) — se dejan
 * sin tocar hasta verificarlos con el catálogo completo de códigos.
 */
export const DELIVERECT_STATUS_MAP: Record<DeliveryOrderStatus, number> = {
  ACCEPTED: 20,
  PREPARING: 50,
  READY: 70,
  PICKED_UP: 90,
  CANCELLED: 110,
  FAILED: 120,
}

export function resolveOrderSource(channelId: number | undefined, link: DeliveryChannelLink): OrderSource {
  const map = ((link.config as any)?.channelSourceMap ?? {}) as Record<string, string>
  const mapped = channelId != null ? map[String(channelId)] : undefined
  if (mapped && mapped in OrderSource) return mapped as OrderSource
  return OrderSource.DELIVERY_PLATFORM
}

/** centavos (o la unidad que declare decimalDigits) → PESOS, número interno. SOLO aquí se divide. */
function toPesosNum(minor: number | undefined | null, decimalDigits: number): number {
  if (minor == null) return 0
  return Math.round(minor) / Math.pow(10, decimalDigits)
}

/** PESOS número interno → string decimal 2 lugares, la forma en que viaja el contrato. */
const toStr = (pesos: number): string => pesos.toFixed(2)

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

  // Fix (audit, SECURITY): bounds-validate money/quantity BEFORE they can flow into un
  // Order/Payment. Un total/unitPrice negativo de un payload malformado (aunque
  // HMAC-autenticado) crearía una Order/Payment "PAID" con forma de reembolso, saltándose
  // el flujo de refund (permisos/confirm/audit). Deliberadamente NO se valida aquí
  // taxTotal/serviceCharge/deliveryCost — esos ya no se exponen en el contrato normalizado
  // (ver nota de Order.discountAmount/serviceChargeAmount/deliveryFeeAmount más abajo) y
  // `assertDeliveryMoneyInvariants` (core/money.ts) es quien valida merchantFees/tipAmount.
  const items: NormalizedDeliveryItem[] = p.items.map((it: any) => {
    const quantity = Number(it.quantity ?? 1)
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error('Deliverect: payload con quantity de item inválida')
    }
    const unitPriceNum = toPesosNum(it.price, dd)
    if (!Number.isFinite(unitPriceNum) || unitPriceNum < 0) {
      throw new Error('Deliverect: payload con unitPrice de item inválido')
    }

    // Fix C4 (audit, MONEY, spec §10.1.4): Deliverect define el monto de un modifier
    // como cantidad_modificador × cantidad_PRODUCTO (el padre) — 2 productos con un
    // modifier de $15 registran $30, no $15. Doc:
    // https://developers.deliverect.com/docs/how-to-interpret-modifiers-and-the-quantity-ordered
    // El contrato nuevo (Tarea 2) pide `modifier.price` YA multiplicado por la cantidad
    // del padre — la multiplicación por la cantidad PROPIA del modifier ocurre donde se
    // consuma (`price × quantity`), no aquí.
    const modifiers: NormalizedDeliveryModifier[] = (it.subItems ?? []).map((s: any) => {
      const modUnitNum = toPesosNum(s.price, dd)
      if (!Number.isFinite(modUnitNum) || modUnitNum < 0) {
        throw new Error('Deliverect: payload con unitPrice de modifier inválido')
      }
      return {
        externalId: String(s.plu ?? ''),
        name: String(s.name ?? 'Modificador'),
        quantity: Number(s.quantity ?? 1),
        price: toStr(modUnitNum * quantity),
      }
    })

    const modifiersTotal = modifiers.reduce((sum, m) => sum + Number(m.price) * m.quantity, 0)
    const lineTotal = unitPriceNum * quantity + modifiersTotal

    return {
      externalId: String(it.plu ?? ''),
      name: String(it.name ?? 'Producto'),
      quantity,
      unitPrice: toStr(unitPriceNum),
      total: toStr(lineTotal),
      modifiers,
    }
  })

  // Fix 1 (audit, SECURITY): mismo motivo que arriba — payment.amount es lo que financia
  // saleAmount; un valor negativo/no-finito crearía un pedido "PAID" con forma de reembolso.
  const saleAmountNum = toPesosNum(p.payment?.amount, dd)
  if (!Number.isFinite(saleAmountNum) || saleAmountNum < 0) {
    throw new Error('Deliverect: payload con total inválido')
  }

  // merchantFees: cargos que el proveedor cobra al cliente PERO liquida al comercio
  // (bolsa/envío propio) — para Deliverect eso es serviceCharge + deliveryCost.
  // REVALIDAR EN STAGING: no hay documentación pública que confirme que Deliverect
  // siempre liquida estos dos campos al comercio (vs. quedárselos la plataforma) — es
  // la lectura más razonable del payload de ejemplo, pero no está verificada end-to-end.
  const merchantFeesNum = toPesosNum(p.serviceCharge, dd) + toPesosNum(p.deliveryCost, dd)
  const tipAmountNum = toPesosNum(p.tip, dd)

  // Deliverect entrega pedidos ya pagados/liquidados por la plataforma al comercio — no
  // modela "pedido no pagado" en este contrato (a diferencia del `orderIsAlreadyPaid`
  // legacy que sí lo hacía leyendo el raw payload). externallyPaidSale/Tip = el 100% del
  // reparto; cashDue* siempre 0 → el invariante de dinero se cumple por construcción.
  const payment: NormalizedDeliveryOrder['payment'] = {
    currency: 'MXN',
    saleAmount: toStr(saleAmountNum),
    merchantFees: toStr(merchantFeesNum),
    tipAmount: toStr(tipAmountNum),
    externallyPaidSale: toStr(saleAmountNum + merchantFeesNum),
    externallyPaidTip: toStr(tipAmountNum),
    cashDueSale: '0.00',
    cashDueTip: '0.00',
  }

  return {
    externalId: String(p.channelOrderId),
    displayId: String(p.channelOrderDisplayId ?? p.channelOrderId),
    source: resolveOrderSource(p.channel, link),
    items,
    payment,
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
