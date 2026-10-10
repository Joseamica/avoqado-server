jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    digitalReceipt: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn().mockResolvedValue({}) },
    payment: { findFirst: jest.fn().mockResolvedValue({ id: 'pay_1', venueId: 'v1' }) },
  },
}))
jest.mock('@/services/whatsapp.service', () => ({ __esModule: true, sendReceiptWhatsApp: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({ __esModule: true, generateAndStoreReceipt: jest.fn() }))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

import { sendReceiptWhatsapp } from '@/controllers/mobile/receipt.mobile.controller'
import { sendPaymentReceiptWhatsApp } from '@/controllers/tpv/payment.tpv.controller'
import { generateAndStoreReceipt } from '@/services/dashboard/receipt.dashboard.service'
import { sendReceiptWhatsApp } from '@/services/whatsapp.service'
import prisma from '@/utils/prismaClient'

/**
 * Revisión final del 7a, m-1 (A7-R8): el WhatsApp del recibo dice el MISMO total que el recibo (`ticketTotalsDelSnapshot`), en
 * magnitud: ni el total de toda la orden en una cuenta dividida, ni un «−» en una devolución.
 */
const prismaMock = prisma as any
const res = () => {
  const r: any = {}
  r.status = jest.fn(() => r)
  r.json = jest.fn(() => r)
  return r
}
const totalEnviado = () => (sendReceiptWhatsApp as jest.Mock).mock.calls[0][1].totalAmount

// El snapshot del TPV (`digitalReceipt.tpv.service`) NO trae `payment.totalAmount`.
const primerCobroDeCuatro = {
  venue: { name: 'Testarudo', currency: 'MXN' },
  payment: { id: 'pay_1', amount: 250, tipAmount: 0 },
  order: { total: 1000 },
  ticketTotals: { kind: 'COBRO', desglosado: false, subtotal: 250, serviceCharge: 0, addedTax: 0, tip: 0, total: 250 },
}
// Devolución PARCIAL de $50 de una venta de $116.
const devolucion = {
  venue: { name: 'Testarudo', currency: 'MXN' },
  payment: { id: 'ref_1', amount: -50, tipAmount: 0, type: 'REFUND' },
  order: { total: 116 },
  ticketTotals: { kind: 'DEVOLUCION', desglosado: false, subtotal: 50, serviceCharge: 0, addedTax: 0, tip: 0, total: 50 },
}

const porMovil = async (dataSnapshot: unknown) => {
  prismaMock.digitalReceipt.findUnique.mockResolvedValue({ id: 'r1', accessKey: 'k1', payment: { venueId: 'v1' }, dataSnapshot })
  const next = jest.fn()
  await sendReceiptWhatsapp({ params: { venueId: 'v1' }, body: { receiptAccessKey: 'k1', phone: '5512345678' } } as any, res(), next)
  expect(next).not.toHaveBeenCalled()
  return totalEnviado()
}
const porTpv = async (dataSnapshot: unknown) => {
  ;(generateAndStoreReceipt as jest.Mock).mockResolvedValue({ id: 'r1', accessKey: 'k1', dataSnapshot })
  const next = jest.fn()
  await sendPaymentReceiptWhatsApp(
    { params: { venueId: 'v1', paymentId: 'pay_1' }, body: { recipientPhone: '5512345678' } } as any,
    res(),
    next,
  )
  expect(next).not.toHaveBeenCalled()
  return totalEnviado()
}

beforeEach(() => jest.clearAllMocks())

describe('WhatsApp del recibo (POS móvil)', () => {
  it('🔴 cuenta dividida de $1,000 en cuatro: el primer cobro dice $250, como su recibo (no el total de la orden)', async () => {
    expect(await porMovil(primerCobroDeCuatro)).toBe('$250.00 MXN')
  })
  it('🔴 recibo VIEJO sin totales congelados: el importe del cobro, no el de la orden', async () => {
    expect(await porMovil({ ...primerCobroDeCuatro, ticketTotals: undefined })).toBe('$250.00 MXN')
  })
  it('🔴 devolución parcial de $50: «$50.00», en magnitud (no el total de la venta)', async () => {
    expect(await porMovil(devolucion)).toBe('$50.00 MXN')
  })
  it('control — snapshot sin cobro: el respaldo de siempre (total de la orden)', async () => {
    expect(await porMovil({ venue: { name: 'Testarudo', currency: 'MXN' }, order: { total: 300 } })).toBe('$300.00 MXN')
  })
})

describe('WhatsApp del recibo (terminal)', () => {
  it('control — cuenta dividida: el primer cobro dice $250', async () => {
    expect(await porTpv(primerCobroDeCuatro)).toBe('$250.00')
  })
  it('🔴 devolución parcial de $50: «$50.00», sin el «−»', async () => {
    expect(await porTpv(devolucion)).toBe('$50.00')
  })
  it('control — snapshot sin cobro: el respaldo de siempre ($0.00)', async () => {
    expect(await porTpv({ venue: { name: 'Testarudo' } })).toBe('$0.00')
  })
})
