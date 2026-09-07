/**
 * Efectivo esperado para el corte de caja — la suma vive en Postgres (query-guard 2026-09-07).
 *
 * Antes: `payment.findMany` SIN tope de todo el efectivo desde el último corte, filtrado y
 * sumado en Node. Un negocio que nunca ha cortado caja carga su historia completa en cada
 * apertura de «Saldo disponible» (Testarudo: 5,449 filas el 7-sep, y una más por cada venta).
 * Ahora: `payment.aggregate` con el filtro de cajón de `tenderSemantics` dentro del `where`.
 *
 * Lo que se afirma: (1) nunca se hidratan filas, (2) el `where` es EXACTAMENTE el de
 * tenderSemantics más el periodo, (3) los números que ve la pantalla no cambian de forma.
 */
import { Prisma } from '@prisma/client'
import { getExpectedCashAmount } from '@/services/dashboard/cashCloseout.dashboard.service'
import { DRAWER_CASH_WHERE } from '@/services/shared/tenderSemantics'
import { prismaMock } from '@tests/__helpers__/setup'

const VENUE_CREATED = new Date('2026-01-15T06:00:00Z')

function agregado(amount: string | null, tip: string | null, count: number) {
  return {
    _sum: {
      amount: amount === null ? null : new Prisma.Decimal(amount),
      tipAmount: tip === null ? null : new Prisma.Decimal(tip),
    },
    _count: { _all: count },
  }
}

describe('getExpectedCashAmount — suma en Postgres, no en Node', () => {
  beforeEach(() => {
    // El helper compartido no modela cashCloseout; se declara aquí y se limpia por prueba.
    prismaMock.cashCloseout = { findFirst: jest.fn().mockResolvedValue(null) }
    prismaMock.venue.findUnique.mockReset()
    prismaMock.venue.findUnique.mockResolvedValue({ createdAt: VENUE_CREATED })
    prismaMock.payment.aggregate.mockReset()
    prismaMock.payment.findMany.mockReset()
  })

  it('pide a Postgres la suma y el conteo con el filtro de cajón de tenderSemantics, y nunca hidrata filas', async () => {
    prismaMock.payment.aggregate.mockResolvedValue(agregado('12345.67', '89.10', 5449))

    const r = await getExpectedCashAmount('venue-1')

    expect(prismaMock.payment.findMany).not.toHaveBeenCalled()
    expect(prismaMock.payment.aggregate).toHaveBeenCalledTimes(1)
    const args = prismaMock.payment.aggregate.mock.calls[0][0]
    expect(args._sum).toEqual({ amount: true, tipAmount: true })
    expect(args._count).toEqual({ _all: true })
    expect(args.where).toEqual({
      venueId: 'venue-1',
      status: 'COMPLETED',
      createdAt: { gt: VENUE_CREATED },
      OR: DRAWER_CASH_WHERE.OR,
    })

    expect(r.expectedAmount).toBeCloseTo(12434.77, 2)
    expect(r.transactionCount).toBe(5449)
    expect(r.needsCloseout).toBe(true)
    expect(r.hasCloseouts).toBe(false)
    expect(r.periodStart).toEqual(VENUE_CREATED)
  })

  it('regresión: un negocio sólo tarjeta (cero efectivo) no recibe el recordatorio de corte', async () => {
    prismaMock.payment.aggregate.mockResolvedValue(agregado(null, null, 0))
    const r = await getExpectedCashAmount('venue-1')
    expect(r).toMatchObject({ expectedAmount: 0, transactionCount: 0, needsCloseout: false })
  })

  it('regresión: con un corte previo, el periodo arranca en su periodEnd y hasCloseouts es true', async () => {
    const periodEnd = new Date('2026-09-01T05:00:00Z')
    prismaMock.cashCloseout.findFirst.mockResolvedValue({ periodEnd })
    prismaMock.payment.aggregate.mockResolvedValue(agregado('300.00', '0', 3))
    const r = await getExpectedCashAmount('venue-1')
    expect(prismaMock.venue.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.payment.aggregate.mock.calls[0][0].where.createdAt).toEqual({ gt: periodEnd })
    expect(r).toMatchObject({ expectedAmount: 300, transactionCount: 3, hasCloseouts: true, periodStart: periodEnd })
  })

  it('regresión: los reembolsos en efectivo (COMPLETED con signo negativo) restan porque la suma es firmada', async () => {
    prismaMock.payment.aggregate.mockResolvedValue(agregado('1000.00', '-20.00', 4))
    const r = await getExpectedCashAmount('venue-1')
    expect(r.expectedAmount).toBeCloseTo(980, 2)
  })
})
