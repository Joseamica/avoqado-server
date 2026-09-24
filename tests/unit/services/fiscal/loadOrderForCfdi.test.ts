// tests/unit/services/fiscal/loadOrderForCfdi.test.ts
// Real-path tests for the DB-backed loader that resolves the emisor via the payment's merchant.
// Critical: the tenant guard (emisor.venueId MUST equal order.venueId) — a shared MerchantAccount
// must never let venue B stamp a CFDI under venue A's RFC.
import { Prisma } from '@prisma/client'

jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    order: { findUnique: jest.fn() },
    merchantFiscalConfig: { findUnique: jest.fn() },
    fiscalEmisor: { findMany: jest.fn().mockResolvedValue([]) },
  },
}))
jest.mock('../../../../src/config/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))

import prisma from '../../../../src/utils/prismaClient'
import { loadOrderForCfdiFromDb, importeConceptoCents } from '../../../../src/services/fiscal/cfdi.service'

const D = (n: number) => new Prisma.Decimal(n)
const orderMock = prisma.order.findUnique as jest.Mock
const cfgMock = prisma.merchantFiscalConfig.findUnique as jest.Mock

function anOrder(over: Record<string, any> = {}) {
  return {
    venueId: 'venueB',
    subtotal: D(100),
    taxAmount: D(16),
    total: D(116),
    tipAmount: D(0),
    discountAmount: D(0),
    venue: { slug: 'demo', type: 'RESTAURANT' },
    payments: [{ method: 'CREDIT_CARD', merchantAccountId: 'm1', ecommerceMerchantId: null, amount: D(116), type: 'REGULAR' }],
    items: [
      {
        productName: 'X',
        quantity: 1,
        unitPrice: D(100),
        discountAmount: D(0),
        total: D(100),
        weightQuantity: null,
        modifiers: [],
        product: { satProductKey: '90101500', satUnitKey: 'E48', objetoImp: '02', taxRate: D(0.16), category: null },
      },
    ],
    ...over,
  }
}

function aConfig(over: Record<string, any> = {}) {
  return {
    facturacionEnabled: true,
    autofacturaEnabled: false,
    fiscalEmisor: {
      id: 'e1',
      venueId: 'venueB',
      provider: 'FACTURAPI',
      providerKeyEnc: null,
      csdStatus: 'ACTIVE',
      serie: 'F',
      invoiceCashSales: false,
    },
    ...over,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe('loadOrderForCfdiFromDb', () => {
  it('resolves the emisor via the merchant config when the emisor belongs to the order venue', async () => {
    orderMock.mockResolvedValue(anOrder())
    cfgMock.mockResolvedValue(aConfig())

    const bundle = await loadOrderForCfdiFromDb('o1')

    expect(bundle).not.toBeNull()
    expect(bundle!.venueId).toBe('venueB')
    expect(bundle!.emisor.id).toBe('e1')
    expect(bundle!.facturacionEnabled).toBe(true)
    expect(bundle!.autofacturaEnabled).toBe(false)
    expect(bundle!.subtotalCents).toBe(10000)
    expect(bundle!.taxCents).toBe(1600)
    expect(bundle!.totalCents).toBe(11600)
    // resolved by merchantAccountId (in-person), not ecommerce
    expect(cfgMock).toHaveBeenCalledWith(expect.objectContaining({ where: { merchantAccountId: 'm1' } }))
  })

  it('SECURITY: refuses to stamp when the merchant emisor belongs to a DIFFERENT venue', async () => {
    orderMock.mockResolvedValue(anOrder({ venueId: 'venueB' }))
    // shared MerchantAccount whose fiscal config points at venue A's emisor
    cfgMock.mockResolvedValue(aConfig({ fiscalEmisor: { ...aConfig().fiscalEmisor, venueId: 'venueA' } }))

    const bundle = await loadOrderForCfdiFromDb('o1')

    expect(bundle).toBeNull() // never returns another venue's emisor
  })

  it('returns null when the order does not exist', async () => {
    orderMock.mockResolvedValue(null)
    expect(await loadOrderForCfdiFromDb('missing')).toBeNull()
    expect(cfgMock).not.toHaveBeenCalled()
  })

  it('returns null when no settled payment carries a merchant (e.g. cash only)', async () => {
    orderMock.mockResolvedValue(anOrder({ payments: [] }))
    expect(await loadOrderForCfdiFromDb('o1')).toBeNull()
    expect(cfgMock).not.toHaveBeenCalled()
  })

  it('CASH sale with a merchant: NOT invoiceable when emisor.invoiceCashSales=false (default)', async () => {
    // Rare case: a cash payment that carries a merchant FK. The emisor opt-out must still block it,
    // so a cash ticket cannot self-invoice via the receipt QR when the venue does not declare cash.
    orderMock.mockResolvedValue(anOrder({ payments: [{ method: 'CASH', merchantAccountId: 'm1', ecommerceMerchantId: null }] }))
    cfgMock.mockResolvedValue(aConfig())
    const bundle = await loadOrderForCfdiFromDb('o1')
    expect(bundle).toBeNull()
  })

  it('CASH sale with a merchant: invoiceable when emisor.invoiceCashSales=true (opted in)', async () => {
    orderMock.mockResolvedValue(anOrder({ payments: [{ method: 'CASH', merchantAccountId: 'm1', ecommerceMerchantId: null }] }))
    cfgMock.mockResolvedValue(aConfig({ fiscalEmisor: { ...aConfig().fiscalEmisor, invoiceCashSales: true } }))
    const bundle = await loadOrderForCfdiFromDb('o1')
    expect(bundle).not.toBeNull()
    expect(bundle!.paymentMethod).toBe('CASH')
  })

  it('MIXTA (tarjeta + efectivo): NO facturable si la orden tiene CUALQUIER pago en efectivo e invoiceCashSales=false', async () => {
    // El emisor se resuelve por el pago con merchant (la tarjeta), pero basta que exista un pago en
    // efectivo para bloquear el timbrado — si no, se facturaría el total incluyendo el efectivo.
    orderMock.mockResolvedValue(
      anOrder({
        payments: [
          { method: 'CREDIT_CARD', merchantAccountId: 'm1', ecommerceMerchantId: null },
          { method: 'CASH', merchantAccountId: null, ecommerceMerchantId: null },
        ],
      }),
    )
    cfgMock.mockResolvedValue(aConfig()) // invoiceCashSales=false
    expect(await loadOrderForCfdiFromDb('o1')).toBeNull()
  })

  it('MIXTA (tarjeta + efectivo): facturable si el emisor optó (invoiceCashSales=true)', async () => {
    orderMock.mockResolvedValue(
      anOrder({
        payments: [
          { method: 'CREDIT_CARD', merchantAccountId: 'm1', ecommerceMerchantId: null },
          { method: 'CASH', merchantAccountId: null, ecommerceMerchantId: null },
        ],
      }),
    )
    cfgMock.mockResolvedValue(aConfig({ fiscalEmisor: { ...aConfig().fiscalEmisor, invoiceCashSales: true } }))
    expect(await loadOrderForCfdiFromDb('o1')).not.toBeNull()
  })

  it('returns null when the payment has no merchant FK', async () => {
    orderMock.mockResolvedValue(anOrder({ payments: [{ method: 'CASH', merchantAccountId: null, ecommerceMerchantId: null }] }))
    expect(await loadOrderForCfdiFromDb('o1')).toBeNull()
    expect(cfgMock).not.toHaveBeenCalled()
  })

  // ─── Venta SIN terminal (Testarudo, 24-sep-2026) ──────────────────────────────────────────────
  // 698 ventas en efectivo y una transferencia de $3,082 en 30 días no se podían facturar: el emisor sólo
  // se sacaba del comercio de la TERMINAL, y un cobro en efectivo o por transferencia no lleva comercio.
  // Si el negocio tiene UN solo emisor, es inequívoco quién factura. El efectivo sigue su interruptor,
  // salvo que la factura la emita el personal a propósito (`permitirEfectivo`).
  describe('venta sin terminal', () => {
    const emisorMock = (prisma as any).fiscalEmisor.findMany as jest.Mock
    afterEach(() => emisorMock.mockResolvedValue([]))
    function unEmisor(over: Record<string, any> = {}) {
      return {
        id: 'e1',
        venueId: 'venueB',
        provider: 'FACTURAPI',
        providerKeyEnc: null,
        csdStatus: 'ACTIVE',
        serie: 'A',
        invoiceCashSales: false,
        merchantConfigs: [{ facturacionEnabled: true, autofacturaEnabled: true }],
        ...over,
      }
    }
    const transferencia = { method: 'BANK_TRANSFER', merchantAccountId: null, ecommerceMerchantId: null, amount: D(116), type: 'REGULAR' }
    const efectivo = { method: 'CASH', merchantAccountId: null, ecommerceMerchantId: null, amount: D(116), type: 'REGULAR' }

    it('TRANSFERENCIA con un solo emisor ⇒ lo factura ese emisor (no hace falta el interruptor de efectivo)', async () => {
      orderMock.mockResolvedValue(anOrder({ payments: [transferencia] }))
      emisorMock.mockResolvedValue([unEmisor()])
      const bundle = await loadOrderForCfdiFromDb('o1')
      expect(bundle).not.toBeNull()
      expect(bundle!.emisor.id).toBe('e1')
      expect(bundle!.paymentMethod).toBe('BANK_TRANSFER')
      expect(bundle!.facturacionEnabled).toBe(true)
      expect(emisorMock.mock.calls[0][0].where).toEqual({ venueId: 'venueB' })
    })

    it('EFECTIVO con el interruptor apagado ⇒ no para la autofactura (default), SÍ para el personal', async () => {
      orderMock.mockResolvedValue(anOrder({ payments: [efectivo] }))
      emisorMock.mockResolvedValue([unEmisor({ invoiceCashSales: false })])
      expect(await loadOrderForCfdiFromDb('o1')).toBeNull()
      const bundle = await loadOrderForCfdiFromDb('o1', { permitirEfectivo: true })
      expect(bundle).not.toBeNull()
      expect(bundle!.paymentMethod).toBe('CASH')
    })

    it('EFECTIVO con el interruptor prendido ⇒ facturable también por autofactura', async () => {
      orderMock.mockResolvedValue(anOrder({ payments: [efectivo] }))
      emisorMock.mockResolvedValue([unEmisor({ invoiceCashSales: true })])
      expect(await loadOrderForCfdiFromDb('o1')).not.toBeNull()
    })

    it('DOS emisores (dos RFC) ⇒ no se adivina quién factura', async () => {
      orderMock.mockResolvedValue(anOrder({ payments: [transferencia] }))
      emisorMock.mockResolvedValue([unEmisor(), unEmisor({ id: 'e2' })])
      expect(await loadOrderForCfdiFromDb('o1', { permitirEfectivo: true })).toBeNull()
    })

    it('tipo del catálogo (OTHER: Uber Eats, vales…) ⇒ no se factura por este camino', async () => {
      orderMock.mockResolvedValue(anOrder({ payments: [{ ...transferencia, method: 'OTHER' }] }))
      emisorMock.mockResolvedValue([unEmisor()])
      expect(await loadOrderForCfdiFromDb('o1', { permitirEfectivo: true })).toBeNull()
    })

    it('autofactura sólo si TODOS los comercios con facturación encendida la tienen encendida', async () => {
      orderMock.mockResolvedValue(anOrder({ payments: [transferencia] }))
      emisorMock.mockResolvedValue([
        unEmisor({
          merchantConfigs: [
            { facturacionEnabled: true, autofacturaEnabled: true },
            { facturacionEnabled: true, autofacturaEnabled: false },
          ],
        }),
      ])
      const bundle = await loadOrderForCfdiFromDb('o1')
      expect(bundle!.facturacionEnabled).toBe(true)
      expect(bundle!.autofacturaEnabled).toBe(false)
    })

    it('sin ningún comercio con facturación encendida ⇒ facturación apagada', async () => {
      orderMock.mockResolvedValue(anOrder({ payments: [transferencia] }))
      emisorMock.mockResolvedValue([unEmisor({ merchantConfigs: [{ facturacionEnabled: false, autofacturaEnabled: false }] })])
      expect((await loadOrderForCfdiFromDb('o1'))!.facturacionEnabled).toBe(false)
    })

    it('REGRESIÓN: una venta con tarjeta sigue resolviendo por su comercio, sin consultar emisores', async () => {
      orderMock.mockResolvedValue(anOrder())
      cfgMock.mockResolvedValue(aConfig())
      await loadOrderForCfdiFromDb('o1')
      expect(emisorMock).not.toHaveBeenCalled()
    })
  })

  it('MIXTA con efectivo e interruptor apagado: la emite el PERSONAL (permitirEfectivo), no la autofactura', async () => {
    orderMock.mockResolvedValue(
      anOrder({
        payments: [
          { method: 'CREDIT_CARD', merchantAccountId: 'm1', ecommerceMerchantId: null },
          { method: 'CASH', merchantAccountId: null, ecommerceMerchantId: null },
        ],
      }),
    )
    cfgMock.mockResolvedValue(aConfig())
    expect(await loadOrderForCfdiFromDb('o1')).toBeNull()
    expect(await loadOrderForCfdiFromDb('o1', { permitirEfectivo: true })).not.toBeNull()
  })

  it('returns null when the merchant has no fiscal config', async () => {
    orderMock.mockResolvedValue(anOrder())
    cfgMock.mockResolvedValue(null)
    expect(await loadOrderForCfdiFromDb('o1')).toBeNull()
  })

  it('returns null when the fiscal config has no linked emisor', async () => {
    orderMock.mockResolvedValue(anOrder())
    cfgMock.mockResolvedValue(aConfig({ fiscalEmisor: null }))
    expect(await loadOrderForCfdiFromDb('o1')).toBeNull()
  })

  it('resolves via ecommerceMerchantId for an online payment', async () => {
    orderMock.mockResolvedValue(anOrder({ payments: [{ method: 'CREDIT_CARD', merchantAccountId: null, ecommerceMerchantId: 'ec9' }] }))
    cfgMock.mockResolvedValue(aConfig())
    const bundle = await loadOrderForCfdiFromDb('o1')
    expect(bundle).not.toBeNull()
    expect(cfgMock).toHaveBeenCalledWith(expect.objectContaining({ where: { ecommerceMerchantId: 'ec9' } }))
  })

  it('only considers COMPLETED payments (settled merchant), not refunds', async () => {
    orderMock.mockResolvedValue(anOrder())
    cfgMock.mockResolvedValue(aConfig())
    await loadOrderForCfdiFromDb('o1')
    // the query must filter payments by status COMPLETED and by eligible type (REGULAR/FAST/legacy null)
    const arg = orderMock.mock.calls[0][0]
    expect(arg.select.payments.where).toEqual({ status: 'COMPLETED', OR: [{ type: { in: ['REGULAR', 'FAST'] } }, { type: null }] })
  })

  // ── IVA-included (GROSS) orders — the live TPV reality (taxAmount=0, prices include IVA) ──────

  it('GROSS order (taxAmount=0): derives base+IVA from items so total == paid and taxCents ≠ 0', async () => {
    // Customer paid 116 (IVA-included). taxAmount=0 marks the gross convention.
    orderMock.mockResolvedValue(
      anOrder({
        subtotal: D(116),
        taxAmount: D(0),
        total: D(116),
        items: [
          {
            productName: 'X',
            quantity: 1,
            unitPrice: D(116), // IVA-included price the customer actually paid
            discountAmount: D(0),
            total: D(116),
            product: { satProductKey: '90101500', satUnitKey: 'E48', objetoImp: '02', taxRate: D(0.16), category: null },
          },
        ],
      }),
    )
    cfgMock.mockResolvedValue(aConfig())

    const bundle = await loadOrderForCfdiFromDb('o1')

    expect(bundle).not.toBeNull()
    expect(bundle!.totalCents).toBe(11600) // == what the customer paid (NOT 11600 × 1.16)
    expect(bundle!.subtotalCents).toBe(10000) // 11600 / 1.16
    expect(bundle!.taxCents).toBe(1600) // no longer 0 — real IVA recorded
    expect(bundle!.subtotalCents + bundle!.taxCents).toBe(bundle!.totalCents) // cuadra al centavo
    expect(bundle!.order.pricesIncludeIva).toBe(true) // → items stamped tax_included downstream
  })

  // ── Extras, peso y descuentos: la factura debe cuadrar con el TICKET (lo cobrado), no con el precio de lista ──
  // Caso real (Testarudo A-14, 21-sep): CAPUCCINO $65 + Deslactosada $5 y TOPOCHICO $40 = $110 pagados;
  // la factura salió por $105 porque el motor ignoraba los modificadores con precio.
  // 🔑 La verdad por renglón es `OrderItem.total` (los escritores TPV y mobile guardan ahí lo cobrado,
  // extras incluidos, ANTES del descuento de renglón); el precio del modificador se guarda POR UNIDAD.
  const P = { satProductKey: '90101501', satUnitKey: 'E48', objetoImp: '02', taxRate: D(0.16), category: null }
  const pago = (amount: number, over: Record<string, any> = {}) => ({
    method: 'CREDIT_CARD',
    merchantAccountId: 'm1',
    ecommerceMerchantId: null,
    amount: D(amount),
    type: 'REGULAR',
    ...over,
  })

  it('GROSS con MODIFICADOR con precio: el extra sale como concepto propio y el total == lo pagado', async () => {
    orderMock.mockResolvedValue(
      anOrder({
        subtotal: D(110),
        taxAmount: D(0),
        total: D(126.5),
        tipAmount: D(16.5),
        discountAmount: D(0),
        payments: [pago(110)],
        items: [
          {
            productName: 'CAPUCCINO',
            quantity: 1,
            unitPrice: D(65),
            discountAmount: D(0),
            total: D(70),
            weightQuantity: null,
            modifiers: [
              { name: 'Deslactosada', price: D(5), quantity: 1 },
              { name: 'Caliente', price: D(0), quantity: 1 },
            ],
            product: P,
          },
          {
            productName: 'TOPOCHICO',
            quantity: 1,
            unitPrice: D(40),
            discountAmount: D(0),
            total: D(40),
            weightQuantity: null,
            modifiers: [],
            product: P,
          },
        ],
      }),
    )
    cfgMock.mockResolvedValue(aConfig())

    const bundle = await loadOrderForCfdiFromDb('o1')

    expect(bundle).not.toBeNull()
    expect(bundle!.totalCents).toBe(11000) // == lo que pagó el cliente (sin propina), NO 10500
    expect(bundle!.paidCents).toBe(11000)
    const items = bundle!.order.items
    expect(items.map(i => [i.productName, i.quantity, Number(i.unitPrice)])).toEqual([
      ['CAPUCCINO (Caliente)', 1, 65], // el extra de $0 se queda en el nombre, como en el ticket
      ['Deslactosada (CAPUCCINO)', 1, 5], // el extra con precio es un concepto propio
      ['TOPOCHICO', 1, 40],
    ])
    expect(items[1].product?.satProductKey).toBe('90101501') // hereda las claves SAT del producto padre
    expect(bundle!.subtotalCents + bundle!.taxCents).toBe(bundle!.totalCents)
  })

  it('GROSS con cantidad 2 y extra guardado POR UNIDAD (como TPV/mobile): cantidad y precio de lista se conservan, el extra cuadra por OrderItem.total', async () => {
    orderMock.mockResolvedValue(
      anOrder({
        subtotal: D(140),
        taxAmount: D(0),
        total: D(140),
        discountAmount: D(0),
        payments: [pago(140)],
        items: [
          {
            productName: 'CAPUCCINO',
            quantity: 2,
            unitPrice: D(65),
            discountAmount: D(0),
            total: D(140),
            weightQuantity: null,
            modifiers: [{ name: 'Deslactosada', price: D(5), quantity: 1 }],
            product: P,
          }, // (65 + 5) × 2 = 140; price NO viene multiplicado
        ],
      }),
    )
    cfgMock.mockResolvedValue(aConfig())

    const bundle = await loadOrderForCfdiFromDb('o1')

    expect(bundle!.totalCents).toBe(14000)
    expect(bundle!.order.items.map(i => [i.productName, i.quantity, Number(i.unitPrice)])).toEqual([
      ['CAPUCCINO', 2, 65],
      ['Deslactosada (CAPUCCINO)', 1, 10], // $5 × 2 unidades: lo que dice OrderItem.total, no una convención
    ])
  })

  it('GROSS venta por PESO: cantidad = kilos reales y unitario = precio por kilo (el SAT exige cantidad y valor unitario reales)', async () => {
    orderMock.mockResolvedValue(
      anOrder({
        subtotal: D(87),
        taxAmount: D(0),
        total: D(87),
        discountAmount: D(0),
        payments: [pago(87, { method: 'CASH' })],
        items: [
          {
            productName: 'JAMÓN',
            quantity: 1,
            unitPrice: D(200),
            discountAmount: D(0),
            total: D(87),
            weightQuantity: D(0.435),
            modifiers: [],
            product: { satProductKey: '50112000', satUnitKey: 'KGM', objetoImp: '02', taxRate: D(0.16), category: null },
          },
        ],
      }),
    )
    cfgMock.mockResolvedValue(aConfig({ fiscalEmisor: { ...aConfig().fiscalEmisor, invoiceCashSales: true } }))

    const bundle = await loadOrderForCfdiFromDb('o1')

    expect(bundle!.totalCents).toBe(8700) // 200 × 0.435 = 87.00, lo que pagó
    expect(bundle!.order.items[0].quantity).toBeCloseTo(0.435, 3)
    expect(Number(bundle!.order.items[0].unitPrice)).toBe(200)
  })

  it('DESCUENTO GENERAL sobre VARIOS renglones: su alcance no se puede demostrar (dirigido vs general) → razón, no se reparte', async () => {
    orderMock.mockResolvedValue(
      anOrder({
        subtotal: D(100),
        taxAmount: D(0),
        total: D(90),
        discountAmount: D(10), // 10% general… o $10 dirigidos a A: los datos no lo dicen
        payments: [pago(90)],
        items: [
          {
            productName: 'A',
            quantity: 1,
            unitPrice: D(60),
            discountAmount: D(0),
            total: D(60),
            weightQuantity: null,
            modifiers: [],
            product: P,
          },
          {
            productName: 'B',
            quantity: 1,
            unitPrice: D(40),
            discountAmount: D(0),
            total: D(40),
            weightQuantity: null,
            modifiers: [],
            product: P,
          },
        ],
      }),
    )
    cfgMock.mockResolvedValue(aConfig())

    const bundle = await loadOrderForCfdiFromDb('o1')

    expect(bundle!.unsupportedReasons?.join(' ')).toMatch(/descuento general/i)
  })

  it('DESCUENTO GENERAL sobre UN renglón CON extra: el motor de descuentos permite descontar SÓLO el extra sin dejar rastro → razón (se cuentan conceptos, no renglones)', async () => {
    // Codex pasada 8: «50 % sólo en Deslactosada» ($2.50) se repartía $2.33 al café y $0.17 al extra
    orderMock.mockResolvedValue(
      anOrder({
        subtotal: D(70),
        taxAmount: D(0),
        total: D(67.5),
        discountAmount: D(2.5),
        payments: [pago(67.5)],
        items: [
          {
            productName: 'CAPUCCINO',
            quantity: 1,
            unitPrice: D(65),
            discountAmount: D(0),
            total: D(70),
            weightQuantity: null,
            modifiers: [{ name: 'Deslactosada', price: D(5), quantity: 1 }],
            product: P,
          },
        ],
      }),
    )
    cfgMock.mockResolvedValue(aConfig())
    const bundle = await loadOrderForCfdiFromDb('o1')
    expect(bundle!.unsupportedReasons?.join(' ')).toMatch(/descuento general/i)
    expect(bundle!.unsupportedReasons?.join(' ')).not.toMatch(/no coincide con lo cobrado/) // no se apila el desajuste encima
  })

  it('DESCUENTO GENERAL sobre UN solo concepto (una línea sin extras): alcance inequívoco → se aplica y cuadra', async () => {
    orderMock.mockResolvedValue(
      anOrder({
        subtotal: D(65),
        taxAmount: D(0),
        total: D(58.5),
        discountAmount: D(6.5), // 10 % sobre el único concepto
        payments: [pago(58.5)],
        items: [
          {
            productName: 'CAPUCCINO',
            quantity: 1,
            unitPrice: D(65),
            discountAmount: D(0),
            total: D(65),
            weightQuantity: null,
            modifiers: [],
            product: P,
          },
        ],
      }),
    )
    cfgMock.mockResolvedValue(aConfig())
    const bundle = await loadOrderForCfdiFromDb('o1')
    expect(bundle!.unsupportedReasons ?? []).toEqual([])
    expect(bundle!.totalCents).toBe(5850)
    expect(bundle!.order.items.map(i => Number(i.discountAmount))).toEqual([6.5])
  })

  it('pagos ELEGIBLES: REGULAR/FAST (null = legado) suman; TEST y ADJUSTMENT no; REFUND no resta (la devolución tiene su nota de crédito)', async () => {
    orderMock.mockResolvedValue(
      anOrder({
        subtotal: D(116),
        taxAmount: D(0),
        total: D(116),
        discountAmount: D(0),
        payments: [pago(116), pago(999, { type: 'TEST' }), pago(50, { type: 'ADJUSTMENT' }), pago(-16, { type: 'REFUND' })],
        items: [
          {
            productName: 'X',
            quantity: 1,
            unitPrice: D(116),
            discountAmount: D(0),
            total: D(116),
            weightQuantity: null,
            modifiers: [],
            product: P,
          },
        ],
      }),
    )
    cfgMock.mockResolvedValue(aConfig())

    const bundle = await loadOrderForCfdiFromDb('o1')

    expect(bundle!.paidCents).toBe(11600)
    expect(bundle!.totalCents).toBe(11600)
    // y el filtro de elegibilidad viaja a la consulta (TEST/ADJUSTMENT no resuelven emisor ni suman)
    const where = orderMock.mock.calls[0][0].select.payments.where
    expect(JSON.stringify(where)).toMatch(/REGULAR/)
    expect(JSON.stringify(where)).not.toMatch(/TEST/)
  })

  it('importe libre sin renglones: un solo concepto por lo PAGADO (sin propina), IVA INCLUIDO aunque la orden sea NET', async () => {
    orderMock.mockResolvedValue(
      anOrder({
        subtotal: D(100),
        taxAmount: D(16),
        total: D(116),
        tipAmount: D(15),
        discountAmount: D(0), // fuente NET (taxAmount > 0)
        payments: [pago(116, { type: 'FAST' })],
        items: [],
      }),
    )
    cfgMock.mockResolvedValue(aConfig())

    const bundle = await loadOrderForCfdiFromDb('o1')

    expect(bundle!.totalCents).toBe(11600)
    expect(bundle!.order.items).toHaveLength(1)
    expect(Number(bundle!.order.items[0].unitPrice)).toBe(116)
    expect(bundle!.order.pricesIncludeIva).toBe(true) // el PAC EXTRAE el IVA de 116; no le suma 16% encima
    expect(bundle!.subtotalCents).toBe(10000)
    expect(bundle!.taxCents).toBe(1600)
  })

  // ── El SOBRE SEGURO (Codex pasada 4): la reconstrucción de conceptos sólo aplica cuando los datos la
  // sostienen; todo lo que sale del sobre se declara en `unsupportedReasons` y el motor lo BLOQUEA con la
  // razón escrita en vez de timbrar un documento con conceptos equivocados.
  it('CORTESÍA (descuento = total del renglón, con extra): el descuento se reparte entre producto y extra, nada negativo, y el documento cuadra', async () => {
    orderMock.mockResolvedValue(
      anOrder({
        subtotal: D(110),
        taxAmount: D(0),
        total: D(40),
        discountAmount: D(70),
        payments: [pago(40)],
        items: [
          {
            productName: 'CAPUCCINO',
            quantity: 1,
            unitPrice: D(65),
            discountAmount: D(70),
            total: D(70),
            weightQuantity: null,
            isCortesia: true,
            modifiers: [{ name: 'Deslactosada', price: D(5), quantity: 1 }],
            product: P,
          },
          {
            productName: 'CONSUMO',
            quantity: 1,
            unitPrice: D(40),
            discountAmount: D(0),
            total: D(40),
            weightQuantity: null,
            modifiers: [],
            product: P,
          },
        ],
      }),
    )
    cfgMock.mockResolvedValue(aConfig())

    const bundle = await loadOrderForCfdiFromDb('o1')

    expect(bundle!.unsupportedReasons ?? []).toEqual([])
    expect(bundle!.order.items.map(i => [i.productName, Number(i.unitPrice), Number(i.discountAmount)])).toEqual([
      ['CAPUCCINO', 65, 65],
      ['Deslactosada (CAPUCCINO)', 5, 5],
      ['CONSUMO', 40, 0],
    ])
    expect(bundle!.totalCents).toBe(4000)
  })

  it('PROMOCIÓN (total guardado ya NETO del descuento): fuera del sobre → razón, nunca un concepto de $60', async () => {
    orderMock.mockResolvedValue(
      anOrder({
        subtotal: D(100),
        taxAmount: D(0),
        total: D(80),
        discountAmount: D(20),
        promotions: [{ id: 'op1' }],
        payments: [pago(80)],
        items: [
          {
            productName: 'PROMO',
            quantity: 1,
            unitPrice: D(100),
            discountAmount: D(20),
            total: D(80),
            weightQuantity: null,
            modifiers: [],
            product: P,
          },
        ],
      }),
    )
    cfgMock.mockResolvedValue(aConfig())

    const bundle = await loadOrderForCfdiFromDb('o1')

    expect(bundle!.unsupportedReasons?.join(' ')).toMatch(/promoci/i)
  })

  it('RESERVA (total del renglón EXCLUYE los extras): extras con precio pero importe sin extras → razón', async () => {
    orderMock.mockResolvedValue(
      anOrder({
        subtotal: D(150),
        taxAmount: D(0),
        total: D(150),
        discountAmount: D(0),
        payments: [pago(150)],
        items: [
          {
            productName: 'CLASE',
            quantity: 1,
            unitPrice: D(100),
            discountAmount: D(0),
            total: D(100),
            weightQuantity: null,
            modifiers: [{ name: 'Tapete', price: D(50), quantity: 1 }],
            product: P,
          },
        ],
      }),
    )
    cfgMock.mockResolvedValue(aConfig())

    const bundle = await loadOrderForCfdiFromDb('o1')

    expect(bundle!.unsupportedReasons?.join(' ')).toMatch(/extras/i)
  })

  it('CARGO POR SERVICIO: es ingreso del negocio y no está en los conceptos → razón (no se bloquea en silencio ni se timbra de menos)', async () => {
    orderMock.mockResolvedValue(
      anOrder({
        subtotal: D(100),
        taxAmount: D(0),
        total: D(110),
        discountAmount: D(0),
        serviceChargeAmount: D(10),
        payments: [pago(110)],
        items: [
          {
            productName: 'X',
            quantity: 1,
            unitPrice: D(100),
            discountAmount: D(0),
            total: D(100),
            weightQuantity: null,
            modifiers: [],
            product: P,
          },
        ],
      }),
    )
    cfgMock.mockResolvedValue(aConfig())

    const bundle = await loadOrderForCfdiFromDb('o1')

    expect(bundle!.unsupportedReasons?.join(' ')).toMatch(/cargo por servicio/i)
  })

  it('DESCUENTO GENERAL con productos de IVA DISTINTO: no se reparte (movería bases entre tasas) → razón', async () => {
    orderMock.mockResolvedValue(
      anOrder({
        subtotal: D(200),
        taxAmount: D(0),
        total: D(180),
        discountAmount: D(20),
        payments: [pago(180)],
        items: [
          {
            productName: 'A16',
            quantity: 1,
            unitPrice: D(100),
            discountAmount: D(0),
            total: D(100),
            weightQuantity: null,
            modifiers: [],
            product: P,
          },
          {
            productName: 'B08',
            quantity: 1,
            unitPrice: D(100),
            discountAmount: D(0),
            total: D(100),
            weightQuantity: null,
            modifiers: [],
            product: { ...P, taxRate: D(0.08) },
          },
        ],
      }),
    )
    cfgMock.mockResolvedValue(aConfig())

    const bundle = await loadOrderForCfdiFromDb('o1')

    expect(bundle!.unsupportedReasons?.join(' ')).toMatch(/descuento general/i)
  })

  it('renglón con total 0 y descuento (recálculo de cortesía mobile): 0 es dato, no ausencia → razón, sin reconstruir por lineGross', async () => {
    orderMock.mockResolvedValue(
      anOrder({
        subtotal: D(140),
        taxAmount: D(0),
        total: D(40),
        discountAmount: D(140),
        payments: [pago(40)],
        items: [
          {
            productName: 'CAPUCCINO',
            quantity: 2,
            unitPrice: D(65),
            discountAmount: D(140),
            total: D(0),
            weightQuantity: null,
            modifiers: [{ name: 'Deslactosada', price: D(5), quantity: 1 }],
            product: P,
          },
          {
            productName: 'CONSUMO',
            quantity: 1,
            unitPrice: D(40),
            discountAmount: D(0),
            total: D(40),
            weightQuantity: null,
            modifiers: [],
            product: P,
          },
        ],
      }),
    )
    cfgMock.mockResolvedValue(aConfig())

    const bundle = await loadOrderForCfdiFromDb('o1')

    expect(bundle!.unsupportedReasons?.length).toBeGreaterThan(0)
    expect(bundle!.order.items.every(i => Number(i.unitPrice) >= 0)).toBe(true)
  })

  it('PESO que no cuadra con total: razón, sin colapsar a cantidad 1', async () => {
    orderMock.mockResolvedValue(
      anOrder({
        subtotal: D(90),
        taxAmount: D(0),
        total: D(90),
        discountAmount: D(0),
        payments: [pago(90)],
        items: [
          {
            productName: 'JAMÓN',
            quantity: 1,
            unitPrice: D(200),
            discountAmount: D(0),
            total: D(90),
            weightQuantity: D(0.435),
            modifiers: [],
            product: { ...P, satUnitKey: 'KGM' },
          },
        ],
      }),
    )
    cfgMock.mockResolvedValue(aConfig())

    const bundle = await loadOrderForCfdiFromDb('o1')

    expect(bundle!.unsupportedReasons?.join(' ')).toMatch(/no cuadra con precio × cantidad/)
    expect(bundle!.order.items).toEqual([]) // bloqueada: no se inventa un concepto de cantidad 1
  })

  // ── Pasada 5 de Codex: los huecos del sobre ──
  it('EXTRAS deben explicar EXACTAMENTE la diferencia (precio por unidad × cantidad): un cambio de precio a media cuenta NO se inventa como extra', async () => {
    // TPV: café $65→$75 y cantidad 2 a media cuenta; el renglón conserva unitPrice 65, total 160 y un extra de $5
    orderMock.mockResolvedValue(
      anOrder({
        subtotal: D(160),
        taxAmount: D(0),
        total: D(160),
        discountAmount: D(0),
        payments: [pago(160)],
        items: [
          {
            productName: 'CAPUCCINO',
            quantity: 2,
            unitPrice: D(65),
            discountAmount: D(0),
            total: D(160),
            weightQuantity: null,
            modifiers: [{ name: 'Deslactosada', price: D(5), quantity: 1 }],
            product: P,
          },
        ],
      }),
    )
    cfgMock.mockResolvedValue(aConfig())
    const bundle = await loadOrderForCfdiFromDb('o1')
    expect(bundle!.unsupportedReasons?.join(' ')).toMatch(/extras/i) // 160 − 130 = 30 ≠ 5 × 2
  })

  it('PESO con fracciones de centavo (0.5 kg × $39.99 = 19.995): fuera del sobre, porque el PAC puede sumar distinto', async () => {
    orderMock.mockResolvedValue(
      anOrder({
        subtotal: D(40),
        taxAmount: D(0),
        total: D(40),
        discountAmount: D(0),
        payments: [pago(40)],
        items: [
          {
            productName: 'JAMÓN',
            quantity: 1,
            unitPrice: D(39.99),
            discountAmount: D(0),
            total: D(20),
            weightQuantity: D(0.5),
            modifiers: [],
            product: { ...P, satUnitKey: 'KGM' },
          },
          {
            productName: 'JAMÓN',
            quantity: 1,
            unitPrice: D(39.99),
            discountAmount: D(0),
            total: D(20),
            weightQuantity: D(0.5),
            modifiers: [],
            product: { ...P, satUnitKey: 'KGM' },
          },
        ],
      }),
    )
    cfgMock.mockResolvedValue(aConfig())
    const bundle = await loadOrderForCfdiFromDb('o1')
    expect(bundle!.unsupportedReasons?.join(' ')).toMatch(/centavo/i)
  })

  it('PESO exige clave SAT de unidad de peso (KGM): un pesado con E48 queda fuera del sobre', async () => {
    orderMock.mockResolvedValue(
      anOrder({
        subtotal: D(87),
        taxAmount: D(0),
        total: D(87),
        discountAmount: D(0),
        payments: [pago(87)],
        items: [
          {
            productName: 'JAMÓN',
            quantity: 1,
            unitPrice: D(200),
            discountAmount: D(0),
            total: D(87),
            weightQuantity: D(0.435),
            modifiers: [],
            product: { ...P, satUnitKey: 'E48' },
          },
        ],
      }),
    )
    cfgMock.mockResolvedValue(aConfig())
    const bundle = await loadOrderForCfdiFromDb('o1')
    expect(bundle!.unsupportedReasons?.join(' ')).toMatch(/KGM/)
  })

  it('cortesía COMPLETA de una línea + otra línea pagada (sin descuento general): cuadra, y ningún concepto queda con descuento > importe', async () => {
    orderMock.mockResolvedValue(
      anOrder({
        subtotal: D(110),
        taxAmount: D(0),
        total: D(70),
        discountAmount: D(40),
        payments: [pago(70)],
        items: [
          {
            productName: 'CAPUCCINO',
            quantity: 1,
            unitPrice: D(65),
            discountAmount: D(0),
            total: D(70),
            weightQuantity: null,
            modifiers: [{ name: 'Deslactosada', price: D(5), quantity: 1 }],
            product: P,
          },
          {
            productName: 'CORTESÍA',
            quantity: 1,
            unitPrice: D(40),
            discountAmount: D(40),
            total: D(40),
            weightQuantity: null,
            isCortesia: true,
            modifiers: [],
            product: P,
          },
        ],
      }),
    )
    cfgMock.mockResolvedValue(aConfig())
    const bundle = await loadOrderForCfdiFromDb('o1')
    expect(bundle!.unsupportedReasons ?? []).toEqual([])
    expect(bundle!.totalCents).toBe(7000)
    for (const it of bundle!.order.items) expect(Number(it.discountAmount) * 100).toBeLessThanOrEqual(importeConceptoCents(it))
  })

  it('DESCUENTO DIRIGIDO a artículos (TPV lo guarda sólo en Order.discountAmount + OrderAction): fuera del sobre, no se reparte entre todos', async () => {
    orderMock.mockResolvedValue(
      anOrder({
        subtotal: D(200),
        taxAmount: D(0),
        total: D(150),
        discountAmount: D(50),
        payments: [pago(150)],
        items: [
          {
            productName: 'A',
            quantity: 1,
            unitPrice: D(100),
            discountAmount: D(0),
            total: D(100),
            weightQuantity: null,
            modifiers: [],
            product: P,
          },
          {
            productName: 'B',
            quantity: 1,
            unitPrice: D(100),
            discountAmount: D(0),
            total: D(100),
            weightQuantity: null,
            modifiers: [],
            product: P,
          },
        ],
      }),
    )
    cfgMock.mockResolvedValue(aConfig())
    const bundle = await loadOrderForCfdiFromDb('o1')
    expect(bundle!.unsupportedReasons?.join(' ')).toMatch(/descuento general/i)
  })

  it('CATÁLOGO inconsistente (objetoImp 01 «no objeto» con tasa 16 %): fuera del sobre', async () => {
    orderMock.mockResolvedValue(
      anOrder({
        subtotal: D(116),
        taxAmount: D(0),
        total: D(116),
        discountAmount: D(0),
        payments: [pago(116)],
        items: [
          {
            productName: 'X',
            quantity: 1,
            unitPrice: D(116),
            discountAmount: D(0),
            total: D(116),
            weightQuantity: null,
            modifiers: [],
            product: { ...P, objetoImp: '01', taxRate: D(0.16) },
          },
        ],
      }),
    )
    cfgMock.mockResolvedValue(aConfig())
    const bundle = await loadOrderForCfdiFromDb('o1')
    expect(bundle!.unsupportedReasons?.join(' ')).toMatch(/objeto de impuesto/i)
  })

  it('COMERCIOS de la misma cuenta: todos deben tener config, mismo emisor y facturación encendida; autofactura = todos encendidos', async () => {
    orderMock.mockResolvedValue(
      anOrder({
        subtotal: D(100),
        taxAmount: D(0),
        total: D(100),
        discountAmount: D(0),
        payments: [pago(50, { merchantAccountId: 'm1' }), pago(50, { merchantAccountId: 'm2' })],
        items: [
          {
            productName: 'X',
            quantity: 1,
            unitPrice: D(100),
            discountAmount: D(0),
            total: D(100),
            weightQuantity: null,
            modifiers: [],
            product: P,
          },
        ],
      }),
    )
    // m1 habilitado; m2 con facturación APAGADA → razón (no gana «el primero»)
    cfgMock.mockImplementation(async (args: any) =>
      args.where.merchantAccountId === 'm2' ? aConfig({ facturacionEnabled: false }) : aConfig(),
    )
    let bundle = await loadOrderForCfdiFromDb('o1')
    expect(bundle!.unsupportedReasons?.join(' ')).toMatch(/comercio.*facturaci/i)

    // m2 SIN configuración → razón
    cfgMock.mockImplementation(async (args: any) => (args.where.merchantAccountId === 'm2' ? null : aConfig()))
    bundle = await loadOrderForCfdiFromDb('o1')
    expect(bundle!.unsupportedReasons?.join(' ')).toMatch(/sin configuraci/i)

    // los dos bien pero m2 sin autofactura → la cuenta NO ofrece autofactura
    cfgMock.mockImplementation(async (args: any) =>
      args.where.merchantAccountId === 'm2' ? aConfig({ autofacturaEnabled: false }) : aConfig({ autofacturaEnabled: true }),
    )
    bundle = await loadOrderForCfdiFromDb('o1')
    expect(bundle!.unsupportedReasons ?? []).toEqual([])
    expect(bundle!.autofacturaEnabled).toBe(false)
  })

  it('sin renglones pero con CARGO POR SERVICIO: el respaldo «Venta» NO se salta el sobre → razón', async () => {
    orderMock.mockResolvedValue(
      anOrder({
        subtotal: D(0),
        taxAmount: D(0),
        total: D(100),
        discountAmount: D(0),
        serviceChargeAmount: D(100),
        payments: [pago(100, { type: 'FAST' })],
        items: [],
      }),
    )
    cfgMock.mockResolvedValue(aConfig())
    const bundle = await loadOrderForCfdiFromDb('o1')
    expect(bundle!.unsupportedReasons?.join(' ')).toMatch(/cargo por servicio/i)
  })

  it('DOS RFC en una cuenta (pagos con comercios de emisor distinto): razón, no «gana el más reciente»', async () => {
    orderMock.mockResolvedValue(
      anOrder({
        subtotal: D(100),
        taxAmount: D(0),
        total: D(100),
        discountAmount: D(0),
        payments: [pago(50, { merchantAccountId: 'm1' }), pago(50, { merchantAccountId: 'm2' })],
        items: [
          {
            productName: 'X',
            quantity: 1,
            unitPrice: D(100),
            discountAmount: D(0),
            total: D(100),
            weightQuantity: null,
            modifiers: [],
            product: P,
          },
        ],
      }),
    )
    cfgMock.mockImplementation(async (args: any) =>
      args.where.merchantAccountId === 'm2' ? aConfig({ fiscalEmisor: { ...aConfig().fiscalEmisor, id: 'e2' } }) : aConfig(),
    )
    const bundle = await loadOrderForCfdiFromDb('o1')
    expect(bundle!.unsupportedReasons?.join(' ')).toMatch(/RFC distinto/i)
  })

  it('TASA 0 con objeto de impuesto 02 (¿tasa cero o exento?): fuera del sobre hasta distinguirlos', async () => {
    orderMock.mockResolvedValue(
      anOrder({
        subtotal: D(100),
        taxAmount: D(0),
        total: D(100),
        discountAmount: D(0),
        payments: [pago(100)],
        items: [
          {
            productName: 'PAN',
            quantity: 1,
            unitPrice: D(100),
            discountAmount: D(0),
            total: D(100),
            weightQuantity: null,
            modifiers: [],
            product: { ...P, taxRate: D(0), objetoImp: '02' },
          },
        ],
      }),
    )
    cfgMock.mockResolvedValue(aConfig())
    const bundle = await loadOrderForCfdiFromDb('o1')
    expect(bundle!.unsupportedReasons?.join(' ')).toMatch(/tasa 0/i)
  })

  it('el DOCUMENTO ≠ lo pagado también es razón del sobre (así el ticket y el recibo no ofrecen una autofactura que fallaría)', async () => {
    orderMock.mockResolvedValue(
      anOrder({
        subtotal: D(100),
        taxAmount: D(16),
        total: D(116),
        discountAmount: D(0), // fuente NET (pos-sync) con precio bruto
        payments: [pago(116)],
        items: [
          {
            productName: 'X',
            quantity: 1,
            unitPrice: D(116),
            discountAmount: D(0),
            total: D(116),
            weightQuantity: null,
            modifiers: [],
            product: P,
          },
        ],
      }),
    )
    cfgMock.mockResolvedValue(aConfig())
    const bundle = await loadOrderForCfdiFromDb('o1')
    expect(bundle!.unsupportedReasons?.join(' ')).toMatch(/no coincide con lo cobrado/)
  })

  it('importeConceptoCents redondea en DECIMAL, half-up, al final (SAT): 100.05 × 0.300 kg = 3,002 ¢, no 3,001', () => {
    expect(importeConceptoCents({ unitPrice: D(100.05), quantity: 0.3 })).toBe(3002)
    expect(importeConceptoCents({ unitPrice: D(0.29), quantity: 0.5 })).toBe(15)
  })

  it('GROSS mixed cart (16% + exento): splits each line per its own rate, total stays == paid', async () => {
    orderMock.mockResolvedValue(
      anOrder({
        subtotal: D(216),
        taxAmount: D(0),
        total: D(216),
        items: [
          {
            productName: 'Comida',
            quantity: 1,
            unitPrice: D(116), // 16% gross
            discountAmount: D(0),
            total: D(116),
            product: { satProductKey: '90101500', satUnitKey: 'E48', objetoImp: '02', taxRate: D(0.16), category: null },
          },
          {
            productName: 'Libro',
            quantity: 1,
            unitPrice: D(100), // exento
            discountAmount: D(0),
            total: D(100),
            product: { satProductKey: '55101500', satUnitKey: 'H87', objetoImp: '01', taxRate: D(0), category: null },
          },
        ],
      }),
    )
    cfgMock.mockResolvedValue(aConfig())

    const bundle = await loadOrderForCfdiFromDb('o1')

    expect(bundle!.totalCents).toBe(21600) // 11600 + 10000 = exactly what was paid
    expect(bundle!.subtotalCents).toBe(20000) // 10000 (net of 116) + 10000 (exento)
    expect(bundle!.taxCents).toBe(1600) // only the 16% line carries IVA
    expect(bundle!.subtotalCents + bundle!.taxCents).toBe(bundle!.totalCents)
    expect(bundle!.order.pricesIncludeIva).toBe(true)
  })

  it('NET order (taxAmount>0, e.g. reservation/pos-sync): keeps the separated split unchanged', async () => {
    orderMock.mockResolvedValue(anOrder()) // subtotal 100, tax 16, total 116
    cfgMock.mockResolvedValue(aConfig())
    const bundle = await loadOrderForCfdiFromDb('o1')
    expect(bundle!.subtotalCents).toBe(10000)
    expect(bundle!.taxCents).toBe(1600)
    expect(bundle!.totalCents).toBe(11600)
    expect(bundle!.order.pricesIncludeIva).toBe(false) // NET → tax_included:false (no regression)
  })
})
