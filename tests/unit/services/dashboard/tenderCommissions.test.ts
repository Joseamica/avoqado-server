/**
 * 🔴 DINERO — reporte de comisiones por tipo de pago.
 *
 * Responde la pregunta que el dueño no podía contestar desde ningún lado: **"¿cuánto me
 * cobró Uber Eats este mes?"**. La comisión se congela como MONTO en cada cobro
 * (`tenderCommissionAmount`), así que el reporte SUMA lo que realmente se cobró — nunca
 * recalcula con el porcentaje de HOY, que es justo el error que haría que subir la comisión
 * de 30% a 35% reescribiera el costo de todo el mes pasado.
 */
import prisma from '@/utils/prismaClient'
import { getTenderCommissionsReport } from '@/services/dashboard/tenderType.dashboard.service'

const prismaMock = prisma as any

describe('getTenderCommissionsReport', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.venue.findUnique.mockResolvedValue({ id: 'venue-1', timezone: 'America/Mexico_City' })
  })

  const fila = (over: Record<string, unknown> = {}) => ({
    tenderTypeId: 'tender-uber',
    tenderLabel: 'Uber Eats',
    _sum: { tenderCommissionAmount: 45, amount: 150, tipAmount: 0 },
    _count: { _all: 3 },
    ...over,
  })

  it('suma la comisión CONGELADA de cada cobro, no un recálculo con el porcentaje de hoy', async () => {
    prismaMock.payment.groupBy.mockResolvedValue([fila()])

    const r = await getTenderCommissionsReport('venue-1', {})

    expect(r.rows[0]).toMatchObject({ tenderLabel: 'Uber Eats', commission: 45, gross: 150, count: 3 })
    expect(r.totalCommission).toBe(45)
  })

  it('el neto es lo que le queda al negocio después de la comisión', async () => {
    prismaMock.payment.groupBy.mockResolvedValue([fila()])

    const r = await getTenderCommissionsReport('venue-1', {})

    expect(r.rows[0].net).toBe(105) // 150 − 45
  })

  it('un tipo sin comisión aparece con 0, no se esconde (el dueño quiere ver TODOS sus tipos)', async () => {
    prismaMock.payment.groupBy.mockResolvedValue([
      fila(),
      fila({
        tenderTypeId: 'tender-vale',
        tenderLabel: 'Vale',
        _sum: { tenderCommissionAmount: null, amount: 80, tipAmount: 0 },
        _count: { _all: 2 },
      }),
    ])

    const r = await getTenderCommissionsReport('venue-1', {})

    expect(r.rows).toHaveLength(2)
    expect(r.rows.find(x => x.tenderLabel === 'Vale')).toMatchObject({ commission: 0, net: 80 })
  })

  it('ordena por comisión pagada, de mayor a menor: lo que más cuesta va primero', async () => {
    prismaMock.payment.groupBy.mockResolvedValue([
      fila({
        tenderTypeId: 't-a',
        tenderLabel: 'Chico',
        _sum: { tenderCommissionAmount: 5, amount: 50, tipAmount: 0 },
        _count: { _all: 1 },
      }),
      fila({
        tenderTypeId: 't-b',
        tenderLabel: 'Caro',
        _sum: { tenderCommissionAmount: 200, amount: 600, tipAmount: 0 },
        _count: { _all: 9 },
      }),
    ])

    const r = await getTenderCommissionsReport('venue-1', {})

    expect(r.rows.map(x => x.tenderLabel)).toEqual(['Caro', 'Chico'])
  })

  // 🔴 BUG REAL encontrado validando contra la DB (2026-08-17): la primera versión filtraba
  // `type: 'REGULAR'` y así dejaba fuera **toda venta rápida** (`type: 'FAST'`) — que es
  // justo donde el mostrador cobra con tipos propios. El reporte habría mostrado CERO en el
  // caso más común, y el test con mocks no lo detectó porque afirmaba el filtro equivocado.
  //
  // Lo que sí hay que excluir es el REEMBOLSO: hoy no hereda comisión a propósito (no sabemos
  // si la plataforma la devuelve), así que restarlo inventaría un ahorro que quizá no ocurrió.
  it('🔴 incluye la VENTA RÁPIDA (FAST) — es donde más se usan los tipos propios', async () => {
    prismaMock.payment.groupBy.mockResolvedValue([])

    await getTenderCommissionsReport('venue-1', {})

    const where = prismaMock.payment.groupBy.mock.calls[0][0].where
    expect(where.type).toEqual({ not: 'REFUND' })
    expect(where.status).toBe('COMPLETED')
    expect(where.venueId).toBe('venue-1')
    expect(where.tenderTypeId).toEqual({ not: null })
  })

  // 🔴 TIMEZONE: el rango es del día LOCAL del negocio. Con un host en UTC (prod), parsear
  // "2026-08-01" a secas daría jul-31 18:00 en México y el reporte arrancaría un día antes.
  it('el rango de fechas se interpreta en la zona horaria del NEGOCIO', async () => {
    prismaMock.payment.groupBy.mockResolvedValue([])

    await getTenderCommissionsReport('venue-1', { from: '2026-08-01', to: '2026-08-31' })

    const where = prismaMock.payment.groupBy.mock.calls[0][0].where
    // Agosto en Mexico_City es UTC-6 → el inicio del día local es 06:00Z.
    expect((where.createdAt.gte as Date).toISOString()).toBe('2026-08-01T06:00:00.000Z')
  })

  it('sin tipos usados devuelve vacío y total 0, no revienta', async () => {
    prismaMock.payment.groupBy.mockResolvedValue([])

    const r = await getTenderCommissionsReport('venue-1', {})

    expect(r.rows).toEqual([])
    expect(r.totalCommission).toBe(0)
  })
})
