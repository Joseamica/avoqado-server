import type { ReceiptSale } from './types'

/**
 * Ventas de ejemplo de la VISTA PREVIA del diseñador (spec § 7.2).
 *
 * 🔴 Viven en `src/` porque el preview es código de PRODUCCIÓN: importar de `tests/fixtures/`
 * rompería el build. Son primas de los fixtures de los casos dorados, no las mismas.
 * Centavos enteros, igual que una venta real.
 */
const BASE = {
  kind: 'SALE',
  orderNumber: '1042',
  occurredAt: '2026-09-02T18:05:00.000Z',
  timezone: 'America/Mexico_City',
  discountCents: null,
  staffName: 'Ana',
  transactionId: 'pay_ejemplo',
  receiptUrl: 'https://r.avoqado.io/x/ejemplo',
} as const

export const SAMPLE_SALES: Record<'retail' | 'restaurant' | 'appointments', ReceiptSale> = {
  retail: {
    ...BASE,
    orderType: 'En tienda',
    subtotalCents: 12000,
    taxCents: 1655,
    tipCents: null,
    totalCents: 12000,
    items: [
      { name: 'Galleta de avena', quantity: 2, unitPriceCents: 4500, totalPriceCents: 9000, note: 'Para llevar' },
      { name: 'Café americano', quantity: 1, unitPriceCents: 3000, totalPriceCents: 3000 },
    ],
    tender: { kind: 'CASH', label: 'Efectivo', tenderedCents: 15000, changeCents: 3000 },
  },
  restaurant: {
    ...BASE,
    orderType: 'En mesa',
    subtotalCents: 6600,
    taxCents: 910,
    tipCents: 1000,
    totalCents: 7600,
    items: [
      { name: 'Tacos al pastor', quantity: 3, unitPriceCents: 2200, totalPriceCents: 6600, modifiers: ['Con todo'] },
      { name: 'Agua mineral', quantity: 1, unitPriceCents: 2500, totalPriceCents: 0, isCortesia: true },
    ],
    tender: { kind: 'CARD', label: 'Tarjeta', cardBrand: 'VISA', cardLastFour: '1234', authCode: 'A1B2C3', referenceNumber: '000123' },
  },
  appointments: {
    ...BASE,
    orderType: 'Cita',
    subtotalCents: 35000,
    taxCents: 4828,
    tipCents: null,
    totalCents: 35000,
    items: [{ name: 'Corte de cabello', quantity: 1, unitPriceCents: 35000, totalPriceCents: 35000 }],
    tender: { kind: 'CARD', label: 'Tarjeta', cardBrand: 'MASTERCARD', cardLastFour: '9876', authCode: 'R9X0', referenceNumber: '000777' },
  },
}
