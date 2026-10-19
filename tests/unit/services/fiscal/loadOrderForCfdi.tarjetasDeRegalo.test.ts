/**
 * Factura individual y tarjetas de regalo (spec §7). La cuenta de VENTA de tarjetas nunca se factura, con un motivo claro; la cuenta
 * de mercancía pagada SÓLO con saldo (OTHER, tender de sistema, sin comercio) SÍ se factura nominativa con forma 01.
 */
import { Prisma } from '@prisma/client'

jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    order: { findUnique: jest.fn() },
    merchantFiscalConfig: { findUnique: jest.fn() },
    fiscalEmisor: { findMany: jest.fn().mockResolvedValue([]) },
    orderDiscount: { findMany: jest.fn() },
  },
}))
jest.mock('../../../../src/config/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))

import prisma from '../../../../src/utils/prismaClient'
import { MOTIVO_TARJETA_DE_REGALO, loadOrderForCfdiFromDb } from '../../../../src/services/fiscal/cfdi.service'
import { mapFormaPago } from '../../../../src/services/fiscal/satCatalog'

const D = (n: number) => new Prisma.Decimal(n)
const orderMock = prisma.order.findUnique as jest.Mock
const cfgMock = prisma.merchantFiscalConfig.findUnique as jest.Mock
const emisoresMock = prisma.fiscalEmisor.findMany as jest.Mock

const emisor = {
  id: 'e1',
  venueId: 'venueB',
  provider: 'FACTURAPI',
  providerKeyEnc: null,
  csdStatus: 'ACTIVE',
  serie: 'F',
  invoiceCashSales: false,
}
const renglon16 = {
  productName: 'Playera',
  quantity: 1,
  unitPrice: D(100),
  discountAmount: D(0),
  total: D(100),
  weightQuantity: null,
  modifiers: [],
  giftCardId: null,
  product: { satProductKey: '90101500', satUnitKey: 'E48', objetoImp: '02', taxRate: D(0.16), category: null },
}
const cuenta = (over: Record<string, unknown>) => ({
  venueId: 'venueB',
  subtotal: D(100),
  taxAmount: D(16),
  total: D(116),
  tipAmount: D(0),
  discountAmount: D(0),
  venue: { slug: 'demo', type: 'RETAIL' },
  items: [renglon16],
  ...over,
})

beforeEach(() => {
  jest.clearAllMocks()
  emisoresMock.mockResolvedValue([])
})

describe('loadOrderForCfdiFromDb · tarjetas de regalo', () => {
  it('🔴 la cuenta de VENTA de tarjetas trae un único motivo, el de tarjetas (el ticket y el portal no ofrecen autofactura)', async () => {
    orderMock.mockResolvedValue(
      cuenta({
        subtotal: D(500),
        taxAmount: D(0),
        total: D(500),
        payments: [
          { method: 'CREDIT_CARD', merchantAccountId: 'm1', ecommerceMerchantId: null, amount: D(500), type: 'REGULAR', tenderType: null },
        ],
        items: [
          {
            productName: 'Tarjeta de regalo',
            quantity: 1,
            unitPrice: D(500),
            discountAmount: D(0),
            total: D(500),
            weightQuantity: null,
            modifiers: [],
            ivaTratamiento: 'NO_OBJETO',
            giftCardId: 'gc1',
            product: null,
          },
        ],
      }),
    )
    cfgMock.mockResolvedValue({ facturacionEnabled: true, autofacturaEnabled: true, fiscalEmisor: emisor })
    const bundle = await loadOrderForCfdiFromDb('o1')
    expect(bundle?.unsupportedReasons).toEqual([MOTIVO_TARJETA_DE_REGALO])
  })

  it('🔴 la mercancía pagada SÓLO con saldo (sin comercio) se factura nominativa con forma 01', async () => {
    orderMock.mockResolvedValue(
      cuenta({
        payments: [
          {
            method: 'OTHER',
            merchantAccountId: null,
            ecommerceMerchantId: null,
            tenderSatFormaPago: '01',
            amount: D(116),
            type: 'REGULAR',
            tenderType: { systemKind: 'GIFT_CARD' },
          },
        ],
      }),
    )
    emisoresMock.mockResolvedValue([{ ...emisor, merchantConfigs: [{ facturacionEnabled: true, autofacturaEnabled: true }] }])
    const bundle = await loadOrderForCfdiFromDb('o1')
    expect(bundle).not.toBeNull()
    expect(bundle!.paymentMethod).toBe('OTHER')
    expect(bundle!.tenderSatFormaPago).toBe('01')
    expect(bundle!.unsupportedReasons).toBeUndefined()
  })

  it('regresión: un OTHER de un tipo propio (vale) sin comercio sigue sin facturarse aquí', async () => {
    orderMock.mockResolvedValue(
      cuenta({
        payments: [
          {
            method: 'OTHER',
            merchantAccountId: null,
            ecommerceMerchantId: null,
            tenderSatFormaPago: '08',
            amount: D(116),
            type: 'REGULAR',
            tenderType: { systemKind: null },
          },
        ],
      }),
    )
    emisoresMock.mockResolvedValue([{ ...emisor, merchantConfigs: [{ facturacionEnabled: true, autofacturaEnabled: true }] }])
    expect(await loadOrderForCfdiFromDb('o1')).toBeNull()
  })

  describe('r1 B-2 · cuenta MIXTA (saldo + tarjeta del banco): gana la forma de MAYOR importe; el emisor sigue saliendo del comercio', () => {
    const saldo = (monto: number) => ({
      method: 'OTHER',
      merchantAccountId: null,
      ecommerceMerchantId: null,
      tenderSatFormaPago: '01',
      amount: D(monto),
      type: 'REGULAR',
      tenderType: { systemKind: 'GIFT_CARD' },
    })
    const tarjeta = (monto: number) => ({
      method: 'CREDIT_CARD',
      merchantAccountId: 'm1',
      ecommerceMerchantId: null,
      tenderSatFormaPago: null,
      amount: D(monto),
      type: 'REGULAR',
      tenderType: null,
    })

    it('🔴 la mayor parte con saldo ⇒ forma 01 (el cobro con comercio ya no gana por traer comercio)', async () => {
      orderMock.mockResolvedValue(cuenta({ payments: [tarjeta(16), saldo(100)] }))
      cfgMock.mockResolvedValue({ facturacionEnabled: true, autofacturaEnabled: true, fiscalEmisor: emisor })
      const bundle = await loadOrderForCfdiFromDb('o1')
      expect(bundle).not.toBeNull()
      expect([bundle!.paymentMethod, bundle!.tenderSatFormaPago]).toEqual(['OTHER', '01'])
      expect(mapFormaPago(bundle!.paymentMethod, bundle!.tenderSatFormaPago)).toBe('01')
      expect(bundle!.emisor.id).toBe('e1')
      expect(cfgMock.mock.calls[0][0].where).toEqual({ merchantAccountId: 'm1' })
    })

    it('🔴 la mayor parte con la tarjeta del banco ⇒ la forma de la tarjeta (04); el emisor, el mismo', async () => {
      orderMock.mockResolvedValue(cuenta({ payments: [saldo(16), tarjeta(100)] }))
      cfgMock.mockResolvedValue({ facturacionEnabled: true, autofacturaEnabled: true, fiscalEmisor: emisor })
      const bundle = await loadOrderForCfdiFromDb('o1')
      expect(bundle).not.toBeNull()
      expect(bundle!.paymentMethod).toBe('CREDIT_CARD')
      expect(mapFormaPago(bundle!.paymentMethod, bundle!.tenderSatFormaPago)).toBe('04')
      expect(bundle!.emisor.id).toBe('e1')
      expect(cfgMock.mock.calls[0][0].where).toEqual({ merchantAccountId: 'm1' })
    })
  })

  // B3 r1 (fix 1, decisión del coordinador): la regla de MAYOR importe sólo en cuentas con un cobro con saldo. Sin saldo, la forma sale del
  // cobro que resuelve el emisor, EXACTAMENTE como en la base `4a558eccc` (`paymentMethod: pay.method`, `tenderSatFormaPago: pay.… ?? null`).
  describe('r1 fix 1 · cuenta mixta SIN saldo: la forma es la de siempre (la del cobro con comercio), aunque otra forma cobre más', () => {
    const tarjeta = (monto: number) => ({
      method: 'CREDIT_CARD',
      merchantAccountId: 'm1',
      ecommerceMerchantId: null,
      tenderSatFormaPago: null,
      amount: D(monto),
      type: 'REGULAR',
      tenderType: null,
    })
    const sinComercio = (method: string, monto: number, tenderSatFormaPago: string | null = null) => ({
      method,
      merchantAccountId: null,
      ecommerceMerchantId: null,
      tenderSatFormaPago,
      amount: D(monto),
      type: 'REGULAR',
      tenderType: null,
    })

    it('🔴 tarjeta $16 (comercio) + efectivo $100, factura del personal ⇒ sigue CREDIT_CARD / null (forma 04), no la del efectivo', async () => {
      orderMock.mockResolvedValue(cuenta({ payments: [tarjeta(16), sinComercio('CASH', 100)] }))
      cfgMock.mockResolvedValue({ facturacionEnabled: true, autofacturaEnabled: true, fiscalEmisor: emisor })
      const bundle = await loadOrderForCfdiFromDb('o1', { permitirEfectivo: true })
      expect(bundle).not.toBeNull()
      expect([bundle!.paymentMethod, bundle!.tenderSatFormaPago]).toEqual(['CREDIT_CARD', null])
      expect(mapFormaPago(bundle!.paymentMethod, bundle!.tenderSatFormaPago)).toBe('04')
      expect(bundle!.unsupportedReasons).toBeUndefined()
    })

    it('🔴 tarjeta $16 (comercio) + OTHER sin forma SAT $100 ⇒ sigue timbrando con la forma de la tarjeta (04), no se detiene en 99', async () => {
      orderMock.mockResolvedValue(cuenta({ payments: [tarjeta(16), sinComercio('OTHER', 100)] }))
      cfgMock.mockResolvedValue({ facturacionEnabled: true, autofacturaEnabled: true, fiscalEmisor: emisor })
      const bundle = await loadOrderForCfdiFromDb('o1')
      expect(bundle).not.toBeNull()
      expect([bundle!.paymentMethod, bundle!.tenderSatFormaPago]).toEqual(['CREDIT_CARD', null])
      expect(mapFormaPago(bundle!.paymentMethod, bundle!.tenderSatFormaPago)).toBe('04')
      expect(bundle!.unsupportedReasons).toBeUndefined()
    })
  })

  it('🔴 r1 fix 3 · cuenta MEZCLADA (un renglón de tarjeta + mercancía; A5 no la deja nacer): se detiene con el motivo de tarjetas', async () => {
    orderMock.mockResolvedValue(
      cuenta({
        subtotal: D(600),
        total: D(616),
        payments: [
          { method: 'CREDIT_CARD', merchantAccountId: 'm1', ecommerceMerchantId: null, amount: D(616), type: 'REGULAR', tenderType: null },
        ],
        items: [
          {
            productName: 'Tarjeta de regalo',
            quantity: 1,
            unitPrice: D(500),
            discountAmount: D(0),
            total: D(500),
            weightQuantity: null,
            modifiers: [],
            ivaTratamiento: 'NO_OBJETO',
            giftCardId: 'gc1',
            product: null,
          },
          renglon16,
        ],
      }),
    )
    cfgMock.mockResolvedValue({ facturacionEnabled: true, autofacturaEnabled: true, fiscalEmisor: emisor })
    const bundle = await loadOrderForCfdiFromDb('o1')
    expect(bundle?.unsupportedReasons).toEqual([MOTIVO_TARJETA_DE_REGALO])
  })

  it('el select pide la marca del tender de cada cobro y la de cada renglón', async () => {
    orderMock.mockResolvedValue(null)
    await loadOrderForCfdiFromDb('o1')
    const select = orderMock.mock.calls[0][0].select
    expect(select.payments.select.tenderType).toEqual({ select: { systemKind: true } })
    expect(select.items.select.giftCardId).toBe(true)
  })
})
