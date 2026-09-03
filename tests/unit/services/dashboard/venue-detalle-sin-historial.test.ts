/**
 * El detalle del venue NO carga el historial transaccional.
 *
 * Incidente 2026-09-01: `getVenueById` incluía `orders`, `payments`, `transactions`,
 * `shifts` y `reviews` SIN límite. Testarudo (33k órdenes + 33k pagos) hacía que cada
 * carga del dashboard materializara ~66k filas en el proceso: bloqueos del event loop
 * de 4-14 s, GC de cientos de MB, /health muerto de hambre y Render reemplazando la
 * instancia ("Server failure detected", 01-sep 09:34). Detalle: los 29 handlers del
 * menú pasaban por `checkVenueAccess`, que pagaba ese mismo costo sólo para comprobar
 * que el venue existe.
 *
 * Estas pruebas fijan la FORMA de la consulta (la lección de asistencia: el mock pasa
 * el campo gratis, el select real no). Si alguien vuelve a incluir una relación sin
 * tope aquí, esto falla ANTES de que llegue a producción.
 */
import prisma from '@/utils/prismaClient'
import { getVenueById, assertVenueAccessible } from '@/services/dashboard/venue.dashboard.service'
import { NotFoundError } from '@/errors/AppError'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { venue: { findFirst: jest.fn() } },
}))

const venueFindFirst = (prisma as unknown as { venue: { findFirst: jest.Mock } }).venue.findFirst

// Relaciones que crecen con cada venta: JAMÁS viajan en el detalle del venue.
const RELACIONES_SIN_TOPE = ['orders', 'payments', 'transactions', 'shifts', 'reviews'] as const

beforeEach(() => {
  jest.clearAllMocks()
})

describe('getVenueById — forma de la consulta', () => {
  it('no incluye ninguna relación sin tope (orders/payments/transactions/shifts/reviews)', async () => {
    venueFindFirst.mockResolvedValue({ id: 'venue-1' })

    await getVenueById('org-1', 'venue-1')

    expect(venueFindFirst).toHaveBeenCalledTimes(1)
    const args = venueFindFirst.mock.calls[0][0]
    for (const relacion of RELACIONES_SIN_TOPE) {
      expect(args.include?.[relacion]).toBeUndefined()
    }
  })

  it('conserva lo que los consumidores sí leen (settings y features)', async () => {
    venueFindFirst.mockResolvedValue({ id: 'venue-1' })

    await getVenueById('org-1', 'venue-1')

    const args = venueFindFirst.mock.calls[0][0]
    expect(args.include?.settings).toBe(true)
    expect(args.include?.features).toBe(true)
  })

  it('sigue filtrando por organización salvo skipOrgCheck', async () => {
    venueFindFirst.mockResolvedValue({ id: 'venue-1' })

    await getVenueById('org-1', 'venue-1')
    expect(venueFindFirst.mock.calls[0][0].where).toEqual({ id: 'venue-1', organizationId: 'org-1' })

    await getVenueById('org-1', 'venue-1', { skipOrgCheck: true })
    expect(venueFindFirst.mock.calls[1][0].where).toEqual({ id: 'venue-1' })
  })
})

describe('assertVenueAccessible — el chequeo barato de existencia', () => {
  it('consulta sólo el id, nunca relaciones', async () => {
    venueFindFirst.mockResolvedValue({ id: 'venue-1' })

    await assertVenueAccessible('org-1', 'venue-1')

    const args = venueFindFirst.mock.calls[0][0]
    expect(args.select).toEqual({ id: true })
    expect(args.include).toBeUndefined()
    expect(args.where).toEqual({ id: 'venue-1', organizationId: 'org-1' })
  })

  it('lanza NotFoundError cuando el venue no existe o es de otra organización', async () => {
    venueFindFirst.mockResolvedValue(null)

    await expect(assertVenueAccessible('org-1', 'venue-ajeno')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('con skipOrgCheck no filtra por organización (SUPERADMIN)', async () => {
    venueFindFirst.mockResolvedValue({ id: 'venue-1' })

    await assertVenueAccessible('org-1', 'venue-1', { skipOrgCheck: true })

    expect(venueFindFirst.mock.calls[0][0].where).toEqual({ id: 'venue-1' })
  })
})
