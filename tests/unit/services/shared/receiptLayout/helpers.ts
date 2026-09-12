import type { ReceiptInput, ReceiptSale, ReceiptVenueInfo } from '@/services/shared/receiptLayout/types'

export const baseSale = (over: Partial<ReceiptSale> = {}): ReceiptSale => ({
  kind: 'SALE',
  orderNumber: '42',
  orderType: 'En tienda',
  occurredAt: '2026-09-02T18:05:00.000Z',
  timezone: 'America/Mexico_City',
  items: [{ name: 'Galleta', quantity: 1, unitPriceCents: 4500, totalPriceCents: 4500 }],
  subtotalCents: 4500,
  taxCents: 621,
  discountCents: null,
  tipCents: null,
  totalCents: 4500,
  tender: { kind: 'CASH', label: 'Efectivo', tenderedCents: 5000, changeCents: 500 },
  staffName: 'Ana',
  transactionId: 'pay_123',
  receiptUrl: 'https://r.avoqado.io/x/abc',
  ...over,
})

export const baseVenue = (over: Partial<ReceiptVenueInfo> = {}): ReceiptVenueInfo => ({
  name: 'Testarudo Cafe',
  address: 'Nápoles 47',
  city: 'Cuauhtémoc',
  state: 'Ciudad de México',
  zipCode: '06600',
  phone: '55 1234 5678',
  hasLogo: true,
  fiscalEmisors: [
    {
      id: 'emA',
      legalName: 'TESTARUDO CAFE S.A.P.I. DE C.V.',
      rfc: 'TCA2501231A6',
      lugarExpedicion: '06600',
      merchantAccountIds: ['maA'],
    },
  ],
  principalEmisorId: 'emA',
  legacy: { legalName: null, rfc: null },
  ...over,
})

export const input = (saleOver: Partial<ReceiptSale> = {}, venueOver: Partial<ReceiptVenueInfo> = {}): ReceiptInput => ({
  sale: baseSale(saleOver),
  venue: baseVenue(venueOver),
})
