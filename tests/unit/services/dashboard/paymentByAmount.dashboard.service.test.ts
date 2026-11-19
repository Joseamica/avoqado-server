/**
 * «¿Entró un cobro de $X?» (C2 de la B y, después, la tool del MCP de Task 12): la consulta se arma sin base. Lo que dice contra
 * Postgres de verdad (paridad con el listado, aislamiento, plan de ejecución) está en la integración.
 */
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import { invoiceStateOfOrders, paymentsByAmountSql } from '@/services/dashboard/paymentByAmount.dashboard.service'
import { FACTURAS_QUE_CUENTAN_DE_LA_VENTA } from '@/services/fiscal/facturaDeLaVenta'

const amount = new Prisma.Decimal('935')

it('no windows: the query is still built (no RangeError), it matches nothing and binds no date', () => {
  const sql = paymentsByAmountSql('ckq7z1x2y0000abcd1234efgh', { amount, windows: [], take: 5 })
  expect(sql.sql).toMatch(/AND \(?FALSE\)?/)
  expect(sql.values.filter(v => v instanceof Date)).toEqual([])
})

it('with windows, the range goes from the first window to the last one', () => {
  const windows = [
    { from: new Date('2026-11-12T07:30:00Z'), to: new Date('2026-11-12T08:30:00Z') },
    { from: new Date('2026-11-12T19:30:00Z'), to: new Date('2026-11-12T20:30:00Z') },
  ]
  const dates = paymentsByAmountSql('ckq7z1x2y0000abcd1234efgh', { amount, windows, take: 5 })
    .values.filter((v): v is Date => v instanceof Date)
    .map(d => d.toISOString())
  expect(dates.slice(0, 2)).toEqual(['2026-11-12T07:30:00.000Z', '2026-11-12T20:30:00.000Z'])
})

it('the row brings only the system kind of its tender type, as Pagos of the panel reads it; never the free name of the tender (C7 r1)', () => {
  const { sql } = paymentsByAmountSql('ckq7z1x2y0000abcd1234efgh', { amount, windows: [], take: 5 })
  expect(sql).toContain('t."systemKind"::text AS "tenderSystemKind"')
  // por la llave compuesta del tipo de pago: la sucursal del cobro y su id
  expect(sql).toMatch(/LEFT JOIN "VenueTenderType" t ON t\."venueId" = p\."venueId" AND t\."id" = p\."tenderTypeId"/)
  expect(sql).not.toMatch(/tenderLabel|t\."name"|tenderRevision|tenderSatFormaPago|tenderCommission|tenderCountsAsCash|tenderCaptureTip/)
})

describe('invoiceStateOfOrders (C7)', () => {
  const VENUE = 'ckq7z1x2y0000abcd1234efgh'
  const cfdi = (id: string, orderId: string, over: Record<string, unknown> = {}) => ({
    id,
    orderId,
    replacesCfdiId: null,
    status: 'STAMPED',
    cancelStatus: null,
    ...over,
  })
  beforeEach(() => prismaMock.cfdi.findMany.mockReset())

  it('ONE query: the invoices that count (the rule of the sales list of the panel), of the venue, only the fields of the rule, take 50', async () => {
    prismaMock.cfdi.findMany.mockResolvedValue([])
    await invoiceStateOfOrders(VENUE, ['o1', 'o2'])
    expect(prismaMock.cfdi.findMany.mock.calls).toEqual([
      [
        {
          where: { ...FACTURAS_QUE_CUENTAN_DE_LA_VENTA, orderId: { in: ['o1', 'o2'] }, venueId: VENUE },
          select: { orderId: true, id: true, replacesCfdiId: true, status: true, cancelStatus: true },
          take: 50,
        },
      ],
    ])
    // La sucursal es la última llave: nada de la regla puede pisarla
    const where = prismaMock.cfdi.findMany.mock.calls[0][0].where
    expect(Object.keys(where).slice(-1)).toEqual(['venueId'])
  })

  it('every sale asked gets its own state, as estadoDeFacturaDeLaVenta over its own invoices', async () => {
    prismaMock.cfdi.findMany.mockResolvedValue([
      cfdi('a1', 'stamped'),
      cfdi('b1', 'cancelling', { status: 'CANCEL_REQUESTED' }),
      cfdi('c1', 'cancel-asked', { cancelStatus: 'REQUESTED' }),
      cfdi('d1', 'replaced', { status: 'CANCEL_REQUESTED' }),
      cfdi('d2', 'replaced', { replacesCfdiId: 'd1' }),
    ])
    const states = await invoiceStateOfOrders(VENUE, ['stamped', 'cancelling', 'cancel-asked', 'replaced', 'none'])
    expect([...states]).toEqual([
      ['stamped', 'VIGENTE'],
      ['cancelling', 'EN_CANCELACION'],
      ['cancel-asked', 'EN_CANCELACION'],
      ['replaced', 'VIGENTE'],
      ['none', null],
    ])
  })

  it('no sales: no query and an empty map; more than 5 throws before any query (whoever calls cut before)', async () => {
    expect(await invoiceStateOfOrders(VENUE, [])).toEqual(new Map())
    await expect(invoiceStateOfOrders(VENUE, ['1', '2', '3', '4', '5', '6'])).rejects.toThrow()
    expect(prismaMock.cfdi.findMany).not.toHaveBeenCalled()
  })
})
