import { DeliveryChannelLink, OrderSource, Prisma } from '@prisma/client'
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

/**
 * centavos (o la unidad que declare decimalDigits) → PESOS, `Prisma.Decimal`. SOLO aquí se
 * divide.
 *
 * 🔴 HALLAZGO 1 (auditoría externa, 2026-08-20): antes dividía en `number`
 * (`Math.round(minor) / Math.pow(10, decimalDigits)`) y toda la aritmética posterior
 * (restas, multiplicaciones) seguía en `number` — viola
 * `.claude/rules/critical-warnings.md` ("Money = Decimal, Never Float") y permite redondeos
 * silenciosos del estilo `0.1 + 0.2 !== 0.3`. Caso real encontrado: con `number`,
 * `serviceCharge=$10.00 + deliveryCost=$4.12` contra un `total=$14.12` (EXACTAMENTE iguales)
 * daba `ventaSinCargos = -1.7763568394002505e-15` — no CERO — y el mapper rechazaba un
 * pedido perfectamente cuadrado creyendo que los cargos superaban el total. Con Decimal da 0
 * exacto. `Math.round` se conserva (no aritmética de dinero: sólo sanea centavos
 * fraccionarios de un payload corrupto) pero la conversión y todo lo que sigue es Decimal.
 */
function toPesosDecimal(minor: number | undefined | null, decimalDigits: number): Prisma.Decimal {
  if (minor == null) return new Prisma.Decimal(0)
  return new Prisma.Decimal(Math.round(minor)).dividedBy(new Prisma.Decimal(10).pow(decimalDigits))
}

/** PESOS Decimal → string decimal 2 lugares, la forma en que viaja el contrato. */
const toStr = (pesos: Prisma.Decimal): string => pesos.toFixed(2)

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
    const unitPriceDecimal = toPesosDecimal(it.price, dd)
    if (!unitPriceDecimal.isFinite() || unitPriceDecimal.isNegative()) {
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
      const modUnitDecimal = toPesosDecimal(s.price, dd)
      if (!modUnitDecimal.isFinite() || modUnitDecimal.isNegative()) {
        throw new Error('Deliverect: payload con unitPrice de modifier inválido')
      }
      return {
        externalId: String(s.plu ?? ''),
        name: String(s.name ?? 'Modificador'),
        quantity: Number(s.quantity ?? 1),
        price: toStr(modUnitDecimal.times(quantity)),
      }
    })

    const modifiersTotal = modifiers.reduce((sum, m) => sum.plus(new Prisma.Decimal(m.price).times(m.quantity)), new Prisma.Decimal(0))
    const lineTotal = unitPriceDecimal.times(quantity).plus(modifiersTotal)

    return {
      externalId: String(it.plu ?? ''),
      name: String(it.name ?? 'Producto'),
      quantity,
      unitPrice: toStr(unitPriceDecimal),
      total: toStr(lineTotal),
      modifiers,
    }
  })

  // Fix 1 (audit, SECURITY): mismo motivo que arriba — payment.amount es lo que financia
  // saleAmount; un valor negativo/no-finito crearía un pedido "PAID" con forma de reembolso.
  const saleAmountDecimal = toPesosDecimal(p.payment?.amount, dd)
  if (!saleAmountDecimal.isFinite() || saleAmountDecimal.isNegative()) {
    throw new Error('Deliverect: payload con total inválido')
  }

  // merchantFees: cargos que el proveedor cobra al cliente PERO liquida al comercio
  // (bolsa/envío propio) — para Deliverect eso es serviceCharge + deliveryCost.
  // REVALIDAR EN STAGING: no hay documentación pública que confirme que Deliverect
  // siempre liquida estos dos campos al comercio (vs. quedárselos la plataforma) — es
  // la lectura más razonable del payload de ejemplo, pero no está verificada end-to-end.
  const merchantFeesDecimal = toPesosDecimal(p.serviceCharge, dd).plus(toPesosDecimal(p.deliveryCost, dd))
  const tipAmountDecimal = toPesosDecimal(p.tip, dd)

  // 🔴 `payment.amount` YA INCLUYE los cargos. El propio schema lo documenta
  // (`prisma/schema.prisma`, `deliveryFeeAmount`): "para pedidos de agregador el proveedor
  // la cobra al cliente y viaja DENTRO del total". Antes se tomaba `amount` como
  // `saleAmount` y ADEMÁS se sumaban los cargos como `merchantFees`: una venta de $165 con
  // $25 de envío quedaba registrada en $190. Hallado por auditoría externa el 2026-08-20;
  // el test no lo veía porque su fixture trae ambos cargos en cero.
  //
  // 🔴 HALLAZGO 1: esta resta viviendo en Decimal (no `number`) es justo lo que evita el
  // épsilon de coma flotante que rechazaba pedidos perfectamente cuadrados — ver el
  // comentario de `toPesosDecimal` arriba.
  const ventaSinCargos = saleAmountDecimal.minus(merchantFeesDecimal)
  if (ventaSinCargos.isNegative()) {
    throw new Error(
      `Deliverect: los cargos (${merchantFeesDecimal.toFixed(2)}) superan el total (${saleAmountDecimal.toFixed(2)}) — el reparto no se puede determinar sin inventar`,
    )
  }

  // 🔴 `orderIsAlreadyPaid` NO es decorativo: Deliverect manda `payment.amount` tanto para
  // pedidos PAGADOS como para los que NO lo están, y este flag es lo ÚNICO que los
  // distingue. Declararlos todos liquidados creaba un Payment COMPLETED, dejaba la orden
  // PAID y descontaba inventario de un pedido que el cliente todavía debía.
  // [doc] https://developers.deliverect.com/page/glossary-pos-orders
  // Conservador: SÓLO `=== true` cuenta como pagado — ausente o cualquier otro valor deja
  // el dinero por cobrar, nunca al revés.
  const yaPagado = (p as { orderIsAlreadyPaid?: unknown })?.orderIsAlreadyPaid === true
  const totalCobrable = ventaSinCargos.plus(merchantFeesDecimal)

  const payment: NormalizedDeliveryOrder['payment'] = {
    currency: 'MXN',
    saleAmount: toStr(ventaSinCargos),
    merchantFees: toStr(merchantFeesDecimal),
    tipAmount: toStr(tipAmountDecimal),
    // Pagado ⇒ la plataforma ya liquidó. No pagado ⇒ queda por cobrar contra entrega.
    externallyPaidSale: yaPagado ? toStr(totalCobrable) : '0.00',
    externallyPaidTip: yaPagado ? toStr(tipAmountDecimal) : '0.00',
    cashDueSale: yaPagado ? '0.00' : toStr(totalCobrable),
    cashDueTip: yaPagado ? '0.00' : toStr(tipAmountDecimal),
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
