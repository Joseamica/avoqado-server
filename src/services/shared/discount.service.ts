/**
 * Shared Discount Helpers
 *
 * Pure, channel-agnostic discount validation + calculation logic used by
 * order-creation flows across clients (TPV, mobile/iOS/Android). Extracted
 * from `order.tpv.service.ts` (the reference implementation) so every
 * channel that lets a client attach a `Discount` row to an order/line item
 * applies the exact same rules.
 *
 * IMPORTANT: extracted from TPV's original inline logic. Since IVA B2 the rows
 * also carry their `reparto` (and `filaDeDescuentoDeCuenta` is new), so it is no
 * longer a verbatim copy — do not change behavior here without re-validating
 * every caller (TPV's order.tpv.service.ts and mobile's order.mobile.service.ts).
 */

import { Prisma } from '@prisma/client'
import { BadRequestError } from '../../errors/AppError'
import { comoJson, nuevoRepartoDeCuenta, nuevoRepartoDirigido } from './repartoDescuento'
import type { DescuentoDeLiga } from '../dashboard/paymentLinkDiscount'

/**
 * Compute the peso amount a `Discount` reduces a given base (line or order)
 * total by. Handles PERCENTAGE, FIXED_AMOUNT, and COMP types, and clamps to
 * `maxDiscountAmount` / the base itself (a discount can never make a
 * line/order negative).
 *
 * @throws BadRequestError if `basePesos` is below the discount's
 *   `minPurchaseAmount`, or if the discount has an unsupported `type`.
 */
export function calculateDiscountPesos(discount: any, basePesos: number): number {
  if (basePesos <= 0) return 0

  if (discount.minPurchaseAmount && basePesos < Number(discount.minPurchaseAmount)) {
    throw new BadRequestError(`Discount "${discount.name}" requires a minimum purchase amount`)
  }

  let amountPesos: number
  if (discount.type === 'PERCENTAGE') {
    amountPesos = roundPesos((basePesos * Number(discount.value)) / 100)
  } else if (discount.type === 'FIXED_AMOUNT') {
    amountPesos = roundPesos(Number(discount.value))
  } else if (discount.type === 'COMP') {
    amountPesos = basePesos
  } else {
    throw new BadRequestError(`Unsupported discount type: ${discount.type}`)
  }

  if (discount.maxDiscountAmount) {
    amountPesos = Math.min(amountPesos, Number(discount.maxDiscountAmount))
  }

  return roundPesos(Math.min(amountPesos, basePesos))
}

/**
 * Lo que un `Discount` de catálogo rebaja a una base en CENTAVOS enteros, redondeando como las apps (`descuentoDeLineaCents`:
 * `Math.round(baseCents × % / 100)`, sin pasar por pesos flotantes: 2135 ¢ al 10 % son 214 ¢, no 213). Lo usa la línea con
 * «Ajuste de precio» (D12), para cobrar al centavo lo que la caja vio. No juzga `minPurchaseAmount`: quien llama decide contra
 * qué base. Topes iguales a `calculateDiscountPesos`: `maxDiscountAmount` y la base misma; nunca menos de 0.
 */
export function calculateDiscountCents(discount: any, baseCents: number): number {
  if (baseCents <= 0) return 0

  let amountCents: number
  if (discount.type === 'PERCENTAGE') {
    amountCents = Math.round((baseCents * Number(discount.value)) / 100)
  } else if (discount.type === 'FIXED_AMOUNT') {
    amountCents = Math.round(Number(discount.value) * 100)
  } else if (discount.type === 'COMP') {
    amountCents = baseCents
  } else {
    throw new BadRequestError(`Unsupported discount type: ${discount.type}`)
  }

  if (discount.maxDiscountAmount) {
    amountCents = Math.min(amountCents, Math.round(Number(discount.maxDiscountAmount) * 100))
  }

  return Math.max(0, Math.min(amountCents, baseCents))
}

/**
 * Validate that a `Discount` row is currently usable: active, within its
 * validity window, and under its total-use cap.
 *
 * `opciones.horaDeLaVenta` (sólo una venta de la cola sin red, «Cobrar sin red» S6): el vencimiento se mide a la hora en que se
 * VENDIÓ, no a la de llegada; «todavía no empieza» sigue midiéndose a la llegada, así un reloj del aparato atrasado nunca rechaza
 * más que hoy. Sin ella, todo a la llegada, como siempre.
 *
 * 🔴 Va en un OBJETO a propósito: `discounts.forEach(validateDiscountActive)` le pasaba el ÍNDICE como segundo argumento, y un
 * `0` posicional como «hora» aceptaba en silencio un descuento vencido. Llámala siempre con una flecha.
 *
 * @throws BadRequestError on any failed check.
 */
export function validateDiscountActive(discount: any, opciones?: { horaDeLaVenta?: Date }): void {
  const now = new Date()
  if (!discount.active) {
    throw new BadRequestError(`Discount "${discount.name}" is inactive`)
  }
  if (discount.validFrom && discount.validFrom > now) {
    throw new BadRequestError(`Discount "${discount.name}" is not active yet`)
  }
  if (discount.validUntil && discount.validUntil < (opciones?.horaDeLaVenta ?? now)) {
    throw new BadRequestError(`Discount "${discount.name}" has expired`)
  }
  if (discount.maxTotalUses != null && discount.currentUses >= discount.maxTotalUses) {
    throw new BadRequestError(`Discount "${discount.name}" has reached its usage limit`)
  }
}

/**
 * Enforce that an ITEM/CATEGORY-scoped `Discount` actually targets the line
 * item it's being applied to, and that an ORDER-scoped discount is never
 * smuggled in through a per-item `discountId`/`itemDiscountId` field.
 *
 * Without this, a tampered client could send an ITEM discount scoped to
 * product A against product B's line item, or send an ORDER-scoped discount
 * (meant only for the order-level discount field) as a per-item discount.
 *
 * Wildcard rule: an ITEM discount with an empty/null `targetItemIds` (same
 * for CATEGORY + `targetCategoryIds`) applies to ALL products/categories —
 * it is not "targets nothing". This matches the long-standing client
 * semantic (iOS's `Discount.appliesToProduct` in CartModels.swift has always
 * treated an empty target list as "applies to everything"), so a venue's
 * ITEM/CATEGORY discount created with no explicit targets keeps working
 * everywhere instead of being newly rejected by this server-side check.
 *
 * @param item The line item's `productId`/`categoryId` (both `null` for a
 *   custom "Otro importe" line — which then can never match an ITEM/CATEGORY
 *   discount, since there's no real product to check against).
 * @throws BadRequestError — same class + rejection style as the existing
 *   "Descuento no encontrado o no pertenece a este local" check in this same
 *   code path: reject the WHOLE order, Spanish message naming the mismatch.
 */
export function validateDiscountScopeForItem(discount: any, item: { productId: string | null; categoryId: string | null }): void {
  if (discount.scope === 'ORDER') {
    throw new BadRequestError(`Descuento "${discount.name}" es de alcance de orden y no puede aplicarse a un artículo individual`)
  }

  if (discount.scope === 'ITEM') {
    const targetItemIds: string[] = discount.targetItemIds ?? []
    const isWildcard = targetItemIds.length === 0
    if (!isWildcard && (!item.productId || !targetItemIds.includes(item.productId))) {
      throw new BadRequestError(`Descuento "${discount.name}" no aplica a este producto`)
    }
    return
  }

  if (discount.scope === 'CATEGORY') {
    const targetCategoryIds: string[] = discount.targetCategoryIds ?? []
    const isWildcard = targetCategoryIds.length === 0
    if (!isWildcard && (!item.categoryId || !targetCategoryIds.includes(item.categoryId))) {
      throw new BadRequestError(`Descuento "${discount.name}" no aplica a la categoría de este producto`)
    }
    return
  }

  // Other scopes (e.g. CUSTOMER_GROUP) aren't reachable via the per-item
  // discountId/itemDiscountId input today — nothing to enforce here.
}

export type ItemDiscountRowInput = {
  orderId: string
  itemId: string
  discount: any
  discountAmountPesos: number
  appliedById: string | null
}

/**
 * Build the `OrderDiscount` create-input for a single item-scoped discount
 * application: one row per discounted item, `appliedToItemIds: [itemId]`.
 * This is the shape TPV writes in `order.tpv.service.ts createOrderWithItems`
 * (plus its mirror `reparto` since IVA B2) — used by both TPV and mobile
 * so dashboard discount-breakdown reporting (which reads `OrderDiscount`)
 * reflects item discounts applied through either channel identically.
 */
export function buildItemDiscountRow(input: ItemDiscountRowInput): Prisma.OrderDiscountUncheckedCreateInput {
  const { orderId, itemId, discount, discountAmountPesos, appliedById } = input
  const amountPesos = roundPesos(discountAmountPesos)
  return {
    orderId,
    discountId: discount.id,
    type: discount.type,
    name: discount.name,
    value: discount.value,
    amount: new Prisma.Decimal(amountPesos),
    taxReduction: 0,
    isComp: discount.type === 'COMP',
    isManual: true,
    compReason: discount.type === 'COMP' ? discount.compReason || discount.name : null,
    appliedById,
    appliedToItemIds: [itemId],
    // B2: el descuento ya vive en el renglón; la fila lo DUPLICA para cabecera y reportes ⇒ espejo (la factura no lo cuenta).
    reparto: comoJson(nuevoRepartoDirigido(amountPesos, { [itemId]: amountPesos }, { espejo: true })),
  }
}

/** La rebaja heredada ya vive en el renglón: la fila sólo la explica, con el mismo reparto espejo. */
export function keptMarkdownDiscountRow(input: Omit<ItemDiscountRowInput, 'discount'>): Prisma.OrderDiscountUncheckedCreateInput {
  return {
    ...buildItemDiscountRow({
      ...input,
      discount: { id: null, type: 'FIXED_AMOUNT', name: 'Rebaja conservada (cambio)', value: input.discountAmountPesos },
    }),
    isManual: false,
    isAutomatic: true,
  }
}

/**
 * D12: el «Ajuste de precio» que la caja escribe a mano en un producto (`adjustedUnitPrice`). UNA fila por venta con todos los
 * renglones ajustados (`renglones` = el `ajustesDePrecio` de `buildOrderItemsData`, tal cual), como `filaDeCortesias`. El
 * descuento ya vive en cada renglón (`discountAmount`); la fila lo duplica ⇒ espejo. No es del catálogo: `discountId` null.
 */
export function filaDeAjustesDePrecio(p: {
  orderId: string
  renglones: Array<{ itemId: string; pesos: number }>
  appliedById: string | null
}): Prisma.OrderDiscountUncheckedCreateInput {
  const monto = roundPesos(p.renglones.reduce((sum, r) => sum + r.pesos, 0))
  return {
    orderId: p.orderId,
    discountId: null,
    type: 'FIXED_AMOUNT',
    name: 'Ajuste de precio',
    value: new Prisma.Decimal(monto),
    amount: new Prisma.Decimal(monto),
    taxReduction: 0,
    isComp: false,
    isManual: true,
    appliedById: p.appliedById,
    appliedToItemIds: p.renglones.map(r => r.itemId),
    reparto: comoJson(nuevoRepartoDirigido(monto, Object.fromEntries(p.renglones.map(r => [r.itemId, r.pesos])), { espejo: true })),
  }
}

/**
 * B2 (founder, 27-sep): el descuento de CUENTA del POS (`discount` del móvil, el descuento libre de «Cobrar») es su propia
 * fila, con su regla (la cuenta CON promociones). Vivía sólo en la cabecera y cualquier recálculo posterior lo borraba. Los
 * centavos por renglón los pone `sincronizarRepartos`. Lo usan el móvil y la terminal: un solo literal.
 */
export function filaDeDescuentoDeCuenta(p: {
  orderId: string
  montoPesos: number
  appliedById: string | null
}): Prisma.OrderDiscountUncheckedCreateInput {
  const monto = roundPesos(p.montoPesos)
  return {
    orderId: p.orderId,
    type: 'FIXED_AMOUNT',
    name: 'Descuento de la cuenta',
    value: new Prisma.Decimal(monto),
    amount: new Prisma.Decimal(monto),
    taxReduction: 0,
    isManual: true,
    appliedById: p.appliedById,
    reparto: comoJson(nuevoRepartoDeCuenta({ conPromociones: true })),
  }
}

/**
 * Descuento en ligas de pago (spec 2026-10-24): la fila de CUENTA de la venta de una liga con descuento, desde la foto que
 * guardó la sesión de pago. Misma regla que `filaDeDescuentoDeCuenta`; aquí con el tipo, valor, nombre y `discountId` de la
 * foto (null si el descuento del catálogo ya no existe) y sin quien lo aplicó (lo paga la clienta desde la web).
 */
export function filaDeDescuentoDeLiga(p: {
  orderId: string
  foto: DescuentoDeLiga
  montoPesos: number
  /** La base de la sesión: con ella se reconoce un % que el catálogo topó (`maxDiscountAmount`). */
  basePesos: number
}): Prisma.OrderDiscountUncheckedCreateInput {
  const monto = roundPesos(p.montoPesos)
  // R6: un % que cobró menos que su porcentaje fue topado; el tope viaja en el reparto para que un recálculo no lo pase
  // (como el motor y la terminal). Sale de la sesión sola: la foto no guarda `maxDiscountAmount`.
  const porcentaje = new Prisma.Decimal(p.basePesos).mul(p.foto.value).div(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
  const tope = p.foto.type === 'PERCENTAGE' && porcentaje.gt(monto) ? monto : null
  return {
    orderId: p.orderId,
    discountId: p.foto.discountId,
    type: p.foto.type,
    name: p.foto.name,
    value: new Prisma.Decimal(p.foto.value),
    amount: new Prisma.Decimal(monto),
    taxReduction: 0,
    isManual: p.foto.origen === 'MANUAL',
    appliedById: null,
    reparto: comoJson(nuevoRepartoDeCuenta({ conPromociones: true, tope })),
  }
}

/** Un renglón regalado entero en una venta nueva: su bruto ((precio + extras) × cantidad) y el motivo que dio la caja. */
export type RenglonEnCortesia = { id: string; brutoPesos: number; motivo?: string | null }

/**
 * La fila COMP «Cortesía» de una venta nueva: UNA por venta, con todos sus renglones regalados. La escriben «Cobrar» de la
 * terminal (`/tpv/with-items`) y la orden de mobile (la cola sin red de la terminal), así que es un solo literal.
 * B2: la cortesía ya vive en cada renglón (bruto + discountAmount = bruto); la fila la duplica ⇒ espejo.
 */
export function filaDeCortesias(p: {
  orderId: string
  renglones: RenglonEnCortesia[]
  appliedById: string | null
}): Prisma.OrderDiscountUncheckedCreateInput {
  const montoPesos = roundPesos(p.renglones.reduce((sum, r) => sum + r.brutoPesos, 0))
  return {
    orderId: p.orderId,
    type: 'COMP',
    name: 'Cortesía',
    value: new Prisma.Decimal(100),
    amount: new Prisma.Decimal(roundPesos(montoPesos)),
    taxReduction: 0,
    isComp: true,
    isManual: true,
    compReason:
      p.renglones
        .map(r => r.motivo)
        .filter(Boolean)
        .join('; ') || 'Cortesía',
    appliedById: p.appliedById,
    appliedToItemIds: p.renglones.map(r => r.id),
    reparto: comoJson(nuevoRepartoDirigido(montoPesos, Object.fromEntries(p.renglones.map(r => [r.id, r.brutoPesos])), { espejo: true })),
  }
}

/** La OrderAction COMP de cada renglón regalado en una venta nueva (mismos dos escritores que `filaDeCortesias`). */
export function accionDeCortesia(p: {
  orderId: string
  performedById: string
  renglon: RenglonEnCortesia
  productId: string | null
  productName: string
}): Prisma.OrderActionUncheckedCreateInput {
  return {
    orderId: p.orderId,
    actionType: 'COMP',
    performedById: p.performedById,
    reason: p.renglon.motivo || 'Cortesía',
    metadata: {
      orderItemId: p.renglon.id,
      productId: p.productId,
      productName: p.productName,
      lineSubtotalGivenAway: roundPesos(p.renglon.brutoPesos),
      cortesiaReason: p.renglon.motivo,
    },
  }
}

/**
 * La fila del descuento de catálogo de la CUENTA de una venta nueva (`orderDiscountId`, mismos dos escritores). B2: su base fue
 * bruto − artículo − cortesías, sobre los renglones sin cortesía; los centavos por renglón los pone `sincronizarRepartos`.
 */
export function filaDeDescuentoDeCatalogoEnCuenta(p: {
  orderId: string
  discount: any
  montoPesos: number
  appliedById: string | null
  renglonesSinCortesia: string[]
}): Prisma.OrderDiscountUncheckedCreateInput {
  const { discount } = p
  return {
    orderId: p.orderId,
    discountId: discount.id,
    type: discount.type,
    name: discount.name,
    value: discount.value,
    amount: new Prisma.Decimal(roundPesos(p.montoPesos)),
    taxReduction: 0,
    isComp: discount.type === 'COMP',
    isManual: true,
    compReason: discount.type === 'COMP' ? discount.compReason || discount.name : null,
    appliedById: p.appliedById,
    appliedToItemIds: p.renglonesSinCortesia,
    reparto: comoJson(nuevoRepartoDeCuenta({ conPromociones: false, base: p.renglonesSinCortesia })),
  }
}

function roundPesos(value: number): number {
  return Math.round(value * 100) / 100
}
