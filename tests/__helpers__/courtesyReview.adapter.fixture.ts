/** Borrador: promover a tests/__helpers__/courtesyReview.adapter.fixture.ts. Datos NUEVOS sintéticos, no QA. */
import cuid = require('cuid')

export const ids = {
  venue: cuid(),
  otherVenue: cuid(),
  actor: cuid(),
  historicalActor: cuid(),
  authorizer: cuid(),
  permissionSet: cuid(),
  order: cuid(),
  key: cuid(),
  line: cuid(),
  lineExternal: cuid(),
  product: cuid(),
  modifierA: cuid(),
  modifierB: cuid(),
  modifierRowA: cuid(),
  modifierRowB: cuid(),
}
export const original = {
  originalPaymentKey: ids.key,
  externalId: ids.key,
  expectedAmount: 0,
  expectedTip: 0,
  lines: [
    {
      externalId: ids.lineExternal,
      productId: ids.product,
      quantity: 1,
      modifierIds: [ids.modifierA, ids.modifierB],
      isCortesia: true,
      cortesiaReason: 'Especial del administrador',
    },
  ],
}
/** Tupla pública exacta en PESOS; se escribe explícita, no se deriva con el algoritmo de conversión que prueba. */
export const publicSnapshot = {
  orderId: ids.order,
  externalId: ids.key,
  orderNumber: 'SYN-ADAPTER-110',
  version: 1,
  status: 'CONFIRMED',
  paymentStatus: 'PENDING',
  originSystem: 'AVOQADO',
  contratoDePrecio: 'IVA_INCLUIDO',
  tableId: null,
  servedById: null,
  subtotal: 110,
  discountAmount: 0,
  taxAmount: 0,
  serviceChargeAmount: 0,
  deliveryFeeAmount: 0,
  tipAmount: 0,
  total: 110,
  paidAmount: 0,
  remainingBalance: 110,
  lines: [
    {
      id: ids.line,
      externalId: ids.lineExternal,
      productId: ids.product,
      quantity: 1,
      modifierIds: [ids.modifierA, ids.modifierB].sort(),
      isCortesia: false,
      cortesiaReason: null,
      unitPrice: 90,
      total: 110,
      discountAmount: 0,
      taxAmount: 0,
      appliedDiscountId: null,
      modifiers: [
        { id: ids.modifierRowA, modifierId: ids.modifierA, quantity: 1, price: 10 },
        { id: ids.modifierRowB, modifierId: ids.modifierB, quantity: 1, price: 10 },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    },
  ],
}
/** La misma tupla interna congelada: nombres y unidades existentes, sin reescribir su contrato. */
export const internalSnapshot = {
  orderId: ids.order,
  externalId: ids.key,
  orderNumber: 'SYN-ADAPTER-110',
  version: 1,
  status: 'CONFIRMED',
  paymentStatus: 'PENDING',
  originSystem: 'AVOQADO',
  contratoDePrecio: 'IVA_INCLUIDO',
  tableId: null,
  servedById: null,
  subtotalCents: 11000,
  discountCents: 0,
  taxCents: 0,
  serviceChargeCents: 0,
  deliveryFeeCents: 0,
  tipCents: 0,
  totalCents: 11000,
  paidAmountCents: 0,
  remainingBalanceCents: 11000,
  lines: [
    {
      id: ids.line,
      externalId: ids.lineExternal,
      productId: ids.product,
      quantity: 1,
      modifierIds: [ids.modifierA, ids.modifierB].sort(),
      isCortesia: false,
      cortesiaReason: null,
      unitPriceCents: 9000,
      totalCents: 11000,
      discountCents: 0,
      taxCents: 0,
      appliedDiscountId: null,
      modifiers: [
        { id: ids.modifierRowA, modifierId: ids.modifierA, quantity: 1, priceCents: 1000 },
        { id: ids.modifierRowB, modifierId: ids.modifierB, quantity: 1, priceCents: 1000 },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    },
  ],
}
export const internalOriginal = {
  originalPaymentKey: ids.key,
  externalId: ids.key,
  expectedAmountCents: 0,
  expectedTipCents: 0,
  lines: original.lines,
}
export const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))
export const previewReply = () => ({ outcome: 'PREVIEW', originalPaymentKey: ids.key, snapshot: clone(internalSnapshot) })
export const appliedReply = () => ({
  outcome: 'APPLIED',
  originalPaymentKey: ids.key,
  snapshot: {
    ...clone(internalSnapshot),
    version: 2,
    subtotalCents: 0,
    totalCents: 0,
    remainingBalanceCents: 0,
    lines: internalSnapshot.lines.map(line => ({
      ...clone(line),
      isCortesia: true,
      cortesiaReason: original.lines[0].cortesiaReason,
      totalCents: 0,
      discountCents: 11000,
    })),
  },
})
