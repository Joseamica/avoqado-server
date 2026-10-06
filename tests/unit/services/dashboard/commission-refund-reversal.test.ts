/**
 * 🔴 MONEY — un reembolso nunca revierte más comisión de la que se pagó.
 *
 * Auditoría de Codex (29-sep-2026): `createRefundCommission` dividía (venta + propina devueltas)
 * entre la base de CADA fila de comisión. Con una base SIN propina ($145) y un reembolso total con
 * propina ($159.50) revertía el 110%; con una comisión dividida entre dos (base $50 c/u) una
 * devolución de $50 revertía el 100% de CADA una.
 *
 * La parte devuelta se mide contra el COBRO original, venta y propina por separado, y la propina
 * sólo pesa si entró a la base de la fila (`tipAmount` de la fila = propina DENTRO de su base).
 */
import { Decimal } from '@prisma/client/runtime/library'
import { createRefundCommission } from '../../../../src/services/dashboard/commission/commission-calculation.service'
import { prismaMock } from '../../../__helpers__/setup'

const cobro = (venta: number, propina: number) => ({
  id: 'pay-orig',
  venueId: 'venue-1',
  orderId: 'order-1',
  amount: new Decimal(venta),
  tipAmount: new Decimal(propina),
})

const reembolso = (id: string, venta: number, propina: number) => ({
  id,
  venueId: 'venue-1',
  orderId: 'order-1',
  type: 'REFUND',
  amount: new Decimal(-venta),
  tipAmount: new Decimal(-propina),
  createdAt: new Date('2026-09-29T18:00:00Z'),
})

const fila = (staffId: string, base: number, tip: number, net: number) => ({
  id: `calc-${staffId}`,
  venueId: 'venue-1',
  staffId,
  paymentId: 'pay-orig',
  orderId: 'order-1',
  shiftId: null,
  configId: 'cfg-1',
  baseAmount: new Decimal(base),
  tipAmount: new Decimal(tip),
  discountAmount: new Decimal(0),
  taxAmount: new Decimal(0),
  effectiveRate: new Decimal(0.1),
  grossCommission: new Decimal(net),
  netCommission: new Decimal(net),
  calcType: 'PERCENTAGE',
  tier: null,
  tierName: null,
  status: 'CALCULATED',
})

const CAMPOS = ['baseAmount', 'tipAmount', 'discountAmount', 'taxAmount', 'grossCommission', 'netCommission']
/** Lo devuelto en la prueba hasta ahora: la base suma TODAS las devoluciones confirmadas visibles (las anteriores + ésta). */
let devuelto = { venta: 0, propina: 0 }
/** Las filas de reverso que la prueba ya escribió: lo que la base devuelve como «ya revertido por las demás». */
let revertidas: any[] = []

/** Corre el reverso real y devuelve las filas que escribiría. */
async function revertir(
  original: ReturnType<typeof cobro>,
  refund: ReturnType<typeof reembolso>,
  filas: ReturnType<typeof fila>[],
): Promise<any[]> {
  devuelto = {
    venta: devuelto.venta + Math.abs(Number(refund.amount)),
    propina: devuelto.propina + Math.abs(Number(refund.tipAmount)),
  }
  prismaMock.payment.findUnique.mockResolvedValue(refund as any)
  prismaMock.payment.findFirst.mockResolvedValue(original as any)
  prismaMock.commissionCalculation.findMany.mockResolvedValue(filas as any)
  prismaMock.paymentEffect.findMany.mockResolvedValue([])
  prismaMock.commissionCalculation.findFirst.mockResolvedValue(null)
  prismaMock.payment.aggregate.mockResolvedValue({
    _sum: { amount: new Decimal(-devuelto.venta), tipAmount: new Decimal(-devuelto.propina) },
  } as any)
  // `$queryRaw`: el candado de la orden (no devuelve nada) y la suma de «lo ya revertido» (positiva, por persona).
  prismaMock.$queryRaw.mockImplementation(async (q: any) => {
    if (!String(q?.strings?.join(' ') ?? '').includes('revertido')) return []
    const suyas = revertidas.filter(r => (q.values as unknown[]).includes(r.staffId))
    return [Object.fromEntries(CAMPOS.map(k => [k, new Decimal(-suyas.reduce((t: number, r: any) => t + Number(r[k]), 0))]))]
  })
  prismaMock.commissionCalculation.create.mockImplementation(async (a: any) => ({ id: `rev-${a.data.staffId}`, ...a.data }))
  const antes = prismaMock.commissionCalculation.create.mock.calls.length
  await createRefundCommission(refund.id, original.id, { db: prismaMock as any })
  const nuevas = prismaMock.commissionCalculation.create.mock.calls.slice(antes).map((c: any) => c[0].data)
  revertidas.push(...nuevas)
  return nuevas
}

/** Al centavo; `|| 0` iguala -0 a 0 (Postgres guarda -0 como 0). */
const n = (v: unknown) => Math.round(Number(v) * 100) / 100 || 0

describe('reverso de comisión por reembolso — nunca más de lo pagado', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    devuelto = { venta: 0, propina: 0 }
    revertidas = []
  })

  it('🔴 tres devoluciones de un tercio de una comisión de $0.02 revierten EXACTAMENTE $0.02, no $0.03 (Codex r1-4)', async () => {
    const filas = [fila('staff-1', 0.21, 0, 0.02)]
    const tercios = [
      await revertir(cobro(0.21, 0), reembolso('ref-1', 0.07, 0), filas),
      await revertir(cobro(0.21, 0), reembolso('ref-2', 0.07, 0), filas),
      await revertir(cobro(0.21, 0), reembolso('ref-3', 0.07, 0), filas),
    ].flat()
    expect(tercios.map(r => n(r.netCommission))).toEqual([-0.01, 0, -0.01])
    expect(n(tercios.reduce((s, r) => s + Number(r.baseAmount), 0))).toBe(-0.21)
  })

  it('🔴 la mitad de $2.01 es $1.01 (½ hacia arriba en decimal), no $1.00 de la aritmética binaria (Codex plan r1-3)', async () => {
    const filas = [fila('staff-1', 20.1, 0, 2.01)]
    const [primera] = await revertir(cobro(20.1, 0), reembolso('ref-1', 10.05, 0), filas)
    const [segunda] = await revertir(cobro(20.1, 0), reembolso('ref-2', 10.05, 0), filas)
    expect([n(primera.netCommission), n(segunda.netCommission)]).toEqual([-1.01, -1])
  })

  it('🔴 cobro de $12.00 con 15 % ($1.80) y devolución de $2.50: 0.375 exacto ⇒ $0.38 (divide al final; Ronda 1 de A3)', async () => {
    // 2.50 / 12 no termina: dividir primero deja 0.37499999999999999994 y el ½↑ da 0.37.
    const [rev] = await revertir(cobro(12, 0), reembolso('ref-1', 2.5, 0), [fila('staff-1', 12, 0, 1.8)])
    expect([n(rev.netCommission), n(rev.grossCommission), n(rev.baseAmount)]).toEqual([-0.38, -0.38, -2.5])
  })

  it('🔴 con propina en la base, la fracción exacta también divide al final', async () => {
    // Base 12 + 3 de propina = 15, comisión 2.25. Se devuelven $2.50 de venta y $1.00 de propina:
    // (12 × 2.5/12 + 3 × 1/3) / 15 = 7/30 ⇒ 2.25 × 7/30 = 0.525 exacto ⇒ 0.53 (dividiendo antes: 0.52499…95 ⇒ 0.52).
    const [rev] = await revertir(cobro(12, 3), reembolso('ref-1', 2.5, 1), [fila('staff-1', 15, 3, 2.25)])
    expect([n(rev.netCommission), n(rev.baseAmount), n(rev.tipAmount)]).toEqual([-0.53, -3.5, -1])
  })

  it('P1: base SIN propina, reembolso total CON propina ⇒ revierte el 100%, no el 110%', async () => {
    const [rev] = await revertir(cobro(145, 14.5), reembolso('ref-1', 145, 14.5), [fila('staff-1', 145, 0, 14.5)])

    expect(n(rev.netCommission)).toBe(-14.5)
    expect(n(rev.grossCommission)).toBe(-14.5)
    expect(n(rev.baseAmount)).toBe(-145)
    expect(n(rev.tipAmount)).toBe(0)
  })

  it('P1: base SIN propina, reembolso SÓLO de la propina ⇒ no revierte comisión', async () => {
    const creadas = await revertir(cobro(145, 14.5), reembolso('ref-1', 0, 14.5), [fila('staff-1', 145, 0, 14.5)])

    expect(creadas).toHaveLength(0)
  })

  it('P1: comisión DIVIDIDA entre dos, devolución de la mitad ⇒ la mitad a cada quien', async () => {
    const creadas = await revertir(cobro(100, 0), reembolso('ref-1', 50, 0), [fila('staff-1', 50, 0, 5), fila('staff-2', 50, 0, 5)])

    expect(creadas.map(r => n(r.netCommission))).toEqual([-2.5, -2.5])
    expect(creadas.map(r => n(r.baseAmount))).toEqual([-25, -25])
  })

  it('P1: dos devoluciones de la mitad sobre una DIVIDIDA suman el 100% por persona, no el 200%', async () => {
    const filas = [fila('staff-1', 50, 0, 5), fila('staff-2', 50, 0, 5)]
    const primera = await revertir(cobro(100, 0), reembolso('ref-1', 50, 0), filas)
    const segunda = await revertir(cobro(100, 0), reembolso('ref-2', 50, 0), filas)

    const porPersona = (staffId: string) =>
      [...primera, ...segunda].filter(r => r.staffId === staffId).reduce((s, r) => s + Number(r.netCommission), 0)
    expect(n(porPersona('staff-1'))).toBe(-5)
    expect(n(porPersona('staff-2'))).toBe(-5)
  })

  // ── Lo que ya funcionaba ────────────────────────────────────────────────────────────────

  it('base CON propina, reembolso sólo de la propina ⇒ revierte la parte de la propina', async () => {
    const [rev] = await revertir(cobro(145, 14.5), reembolso('ref-1', 0, 14.5), [fila('staff-1', 159.5, 14.5, 15.95)])

    expect(n(rev.netCommission)).toBe(-1.45) // 14.50 de 159.50 = 9.09 % de 15.95
    expect(n(rev.baseAmount)).toBe(-14.5)
    expect(n(rev.tipAmount)).toBe(-14.5)
  })

  it('base CON propina, reembolso total ⇒ revierte el 100%', async () => {
    const [rev] = await revertir(cobro(145, 14.5), reembolso('ref-1', 145, 14.5), [fila('staff-1', 159.5, 14.5, 15.95)])

    expect(n(rev.netCommission)).toBe(-15.95)
    expect(n(rev.baseAmount)).toBe(-159.5)
  })

  it('sin propina, reembolso parcial ⇒ proporcional a la venta devuelta', async () => {
    const [rev] = await revertir(cobro(200, 0), reembolso('ref-1', 50, 0), [fila('staff-1', 200, 0, 20)])

    expect(n(rev.netCommission)).toBe(-5)
    expect(n(rev.baseAmount)).toBe(-50)
  })

  it('un reembolso que ya tiene su reverso no se duplica', async () => {
    prismaMock.commissionCalculation.findFirst.mockResolvedValue({ id: 'ya' } as any)
    prismaMock.payment.findUnique.mockResolvedValue(reembolso('ref-1', 145, 0) as any)
    prismaMock.payment.findFirst.mockResolvedValue(cobro(145, 0) as any)
    prismaMock.$queryRaw.mockResolvedValue([])
    prismaMock.commissionCalculation.findMany.mockResolvedValue([fila('staff-1', 145, 0, 14.5)] as any)
    prismaMock.paymentEffect.findMany.mockResolvedValue([])
    prismaMock.payment.aggregate.mockResolvedValue({ _sum: { amount: new Decimal(-145), tipAmount: new Decimal(0) } } as any)

    await createRefundCommission('ref-1', 'pay-orig', { db: prismaMock as any })

    expect(prismaMock.commissionCalculation.create).not.toHaveBeenCalled()
  })
})
