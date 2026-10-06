import { Prisma } from '@prisma/client'
import { issueGlobalForEmisor, IssueGlobalDeps, GlobalEmisor } from '@/services/fiscal/cfdiGlobal.service'

const emisor: GlobalEmisor = {
  id: 'e1',
  venueId: 'v1',
  globalPeriodicity: 'MENSUAL',
  serie: null,
  lugarExpedicion: '83000',
  csdStatus: 'ACTIVE',
  providerKeyEnc: null,
  provider: 'FACTURAPI',
  invoiceCashSales: false,
}
const params = { emisorId: 'e1', now: new Date('2026-06-03T17:00:00Z'), sandbox: true }
function deps(over: Partial<IssueGlobalDeps> = {}): Partial<IssueGlobalDeps> {
  return {
    loadEmisor: jest.fn().mockResolvedValue(emisor),
    findExistingGlobal: jest.fn().mockResolvedValue(null),
    loadGlobalCandidates: jest.fn().mockResolvedValue([]),
    resolveProvider: jest.fn(),
    ...over,
  }
}
describe('issueGlobalForEmisor — guardas sin efectos', () => {
  it.each(['NONE', 'PENDING'])('CSD %s omite reserva y PAC', async csdStatus => {
    const d = deps({ loadEmisor: jest.fn().mockResolvedValue({ ...emisor, csdStatus }) })
    expect(await issueGlobalForEmisor(params, d)).toMatchObject({ status: 'SKIPPED' })
    expect(d.loadGlobalCandidates).not.toHaveBeenCalled()
    expect(d.resolveProvider).not.toHaveBeenCalled()
  })
  it('emisor inexistente no toca PAC', async () => {
    await expect(issueGlobalForEmisor(params, deps({ loadEmisor: jest.fn().mockResolvedValue(null) }))).rejects.toThrow(/not found/)
  })
  it('STAMPED es idempotente, conserva periodo y cuenta mixta', async () => {
    const c = { id: 'g1', venueId: 'v1', fiscalEmisorId: 'e1', status: 'STAMPED', entrada: { excluidasPorIvaMixto: 2 } }
    const d = deps({ findExistingGlobal: jest.fn().mockResolvedValue(c) })
    expect(await issueGlobalForEmisor(params, d)).toMatchObject({
      status: 'STAMPED',
      cfdi: c,
      candidateCount: 0,
      excluidasPorIvaMixto: 2,
      period: { meses: '05', anio: 2026 },
    })
    expect(d.findExistingGlobal).toHaveBeenCalledWith('cfdi-global-e1-2026-05-04')
    expect(d.resolveProvider).not.toHaveBeenCalled()
  })
  it('no devuelve una fila de otro emisor/venue', async () => {
    await expect(
      issueGlobalForEmisor(
        params,
        deps({ findExistingGlobal: jest.fn().mockResolvedValue({ status: 'STAMPED', venueId: 'other', fiscalEmisorId: 'e1' }) }),
      ),
    ).rejects.toThrow(/not found/)
  })
})

// ── Extras y peso también en la GLOBAL (mismo defecto que la individual, Testarudo 21-sep-2026) ──
import { globalLinesFromOrder, ORDER_SELECT } from '../../../../src/services/fiscal/cfdiGlobal.service'
import { DESCUENTOS_PARA_CONCEPTOS } from '../../../../src/services/fiscal/descuentoPorRenglon'

describe('globalLinesFromOrder — la línea global cuadra con el ticket (misma verdad de dinero que la individual)', () => {
  const Dc = (n: number) => new Prisma.Decimal(n)
  const base = { id: 'o1', orderNumber: 'ORD-1', subtotal: Dc(110), taxAmount: Dc(0), total: Dc(126.5), discountAmount: Dc(0) }
  const itemP = (over: Record<string, any>) => ({
    productName: 'X',
    quantity: 1,
    unitPrice: Dc(0),
    discountAmount: Dc(0),
    taxAmount: Dc(0),
    total: Dc(0),
    weightQuantity: null,
    modifiers: [],
    product: { taxRate: Dc(0.16), objetoImp: '02', satProductKey: '90101501', satUnitKey: 'E48', category: null },
    ...over,
  })
  const pagos = (amount: number, type = 'REGULAR') => [{ method: 'CREDIT_CARD', tenderSatFormaPago: null, amount: Dc(amount), type }]
  const suma = (lines: Array<{ totalCents: number }>) => lines.reduce((s, l) => s + l.totalCents, 0)

  it('GROSS con modificador con precio (guardado por unidad): la línea vale OrderItem.total, igual que la individual', () => {
    const lines = globalLinesFromOrder({
      ...base,
      payments: pagos(110),
      items: [
        itemP({
          productName: 'CAPUCCINO',
          unitPrice: Dc(65),
          total: Dc(70),
          modifiers: [{ name: 'Deslactosada', price: Dc(5), quantity: 1 }],
        }),
        itemP({ productName: 'TOPOCHICO', unitPrice: Dc(40), total: Dc(40) }),
      ],
    } as any)
    expect(suma(lines)).toBe(11000) // 70 + 40, no 105
  })

  it('GROSS venta por peso: la línea vale lo cobrado (precio × kilos)', () => {
    const lines = globalLinesFromOrder({
      ...base,
      subtotal: Dc(87),
      total: Dc(87),
      payments: pagos(87),
      items: [
        itemP({
          productName: 'JAMÓN',
          unitPrice: Dc(200),
          total: Dc(87),
          weightQuantity: Dc(0.435),
          product: { taxRate: Dc(0.16), objetoImp: '02', satProductKey: '50112000', satUnitKey: 'KGM', category: null },
        }),
      ],
    } as any)
    expect(suma(lines)).toBe(8700)
  })

  it('DESCUENTO de orden sin constancia sobre varios renglones del mismo IVA: la global la INCLUYE (D8, misma verdad que la individual)', () => {
    const lines = globalLinesFromOrder({
      ...base,
      subtotal: Dc(100),
      total: Dc(90),
      discountAmount: Dc(10),
      payments: pagos(90),
      items: [itemP({ unitPrice: Dc(60), total: Dc(60) }), itemP({ unitPrice: Dc(40), total: Dc(40) })],
    } as any)
    expect(suma(lines)).toBe(9000)
  })

  it('B3a (control): con una cortesía de «Cobrar» la global suma lo cobrado', () => {
    const lines = globalLinesFromOrder({
      ...base,
      subtotal: Dc(150),
      total: Dc(100),
      discountAmount: Dc(50),
      payments: pagos(100),
      items: [
        itemP({ unitPrice: Dc(100), total: Dc(100) }),
        itemP({ productName: 'Pan', unitPrice: Dc(50), total: Dc(50), discountAmount: Dc(50), isCortesia: true }),
      ],
    } as any)
    expect(suma(lines)).toBe(10000)
  })

  it('B3a: la global lee lo mismo que la individual (filas de descuento, liga a la promoción, marca de cortesía)', () => {
    expect(ORDER_SELECT.orderDiscounts).toBe(DESCUENTOS_PARA_CONCEPTOS)
    expect(ORDER_SELECT.items.select.orderPromotionId).toBe(true)
    expect(ORDER_SELECT.items.select.isCortesia).toBe(true)
    expect((ORDER_SELECT as any).promotions).toBeUndefined()
  })

  it('B3a: una venta con promoción entra a la global por lo cobrado', () => {
    const lines = globalLinesFromOrder({
      ...base,
      subtotal: Dc(80),
      total: Dc(80),
      payments: pagos(80),
      items: [itemP({ unitPrice: Dc(100), total: Dc(80), discountAmount: Dc(20), orderPromotionId: 'op1' })],
    } as any)
    expect(suma(lines)).toBe(8000)
  })

  it('B3a: una venta por peso con fracción de centavo entra a la global por lo cobrado', () => {
    const lines = globalLinesFromOrder({
      ...base,
      subtotal: Dc(69.16),
      total: Dc(69.16),
      payments: pagos(69.16),
      items: [
        itemP({
          productName: 'JAMÓN',
          unitPrice: Dc(45),
          total: Dc(69.16),
          weightQuantity: Dc(1.537),
          product: { taxRate: Dc(0.16), objetoImp: '02', satProductKey: '50112000', satUnitKey: 'KGM', category: null },
        }),
      ],
    } as any)
    expect(suma(lines)).toBe(6916)
  })

  it('BARRERA en la global: una orden cuyo documento ≠ lo cobrado se EXCLUYE (nunca se declara mal)', () => {
    const lines = globalLinesFromOrder({
      ...base,
      payments: pagos(140), // cobrados 140, pero los renglones sólo explican 135
      items: [itemP({ productName: 'CAPUCCINO', quantity: 2, unitPrice: Dc(65), total: Dc(135) })],
    } as any)
    expect(lines).toEqual([])
  })

  it('sin renglones (importe libre): una línea por lo PAGADO, no por order.total (que trae propina)', () => {
    const lines = globalLinesFromOrder({ ...base, subtotal: Dc(100), total: Dc(115), payments: pagos(100, 'FAST'), items: [] } as any)
    expect(lines).toHaveLength(1)
    expect(lines[0].totalCents).toBe(10000)
  })

  it('pagos TEST no cuentan como cobro de la global', () => {
    const lines = globalLinesFromOrder({ ...base, subtotal: Dc(100), total: Dc(100), payments: pagos(100, 'TEST'), items: [] } as any)
    expect(lines).toEqual([])
  })
})

describe('globalLinesFromOrder — sin renglones tampoco se salta las exclusiones de orden', () => {
  it('orden vacía con cargo por servicio: excluida (no se inventa una «Venta» al 16 %)', () => {
    const Dc = (n: number) => new Prisma.Decimal(n)
    const lines = globalLinesFromOrder({
      id: 'o1',
      orderNumber: 'ORD-1',
      subtotal: Dc(0),
      taxAmount: Dc(0),
      total: Dc(100),
      discountAmount: Dc(0),
      serviceChargeAmount: Dc(100),
      payments: [{ method: 'CREDIT_CARD', tenderSatFormaPago: null, amount: Dc(100), type: 'FAST' }],
      items: [],
    } as any)
    expect(lines).toEqual([])
  })
})
