import { Request, Response, NextFunction } from 'express'
import { resolveVenueBySlug, resolveVenueBySlugIncludingInactive } from '@/middlewares/resolveVenueBySlug.middleware'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { venue: { findFirst: jest.fn() } },
}))

const venueFindFirst = prisma.venue.findFirst as jest.Mock

function mkRes() {
  const res: Partial<Response> = {}
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  return res as Response
}

beforeEach(() => jest.clearAllMocks())

/**
 * Fase 0.B — el venue de la URL se resuelve ANTES de la identidad, para que
 * `authenticateCustomer` pueda comparar el venue del token contra el de la ruta.
 */
describe('resolveVenueBySlug', () => {
  it('slug existente y activo → req.publicVenue = {id, slug} y next()', async () => {
    venueFindFirst.mockResolvedValue({ id: 'v1', slug: 'estudio-a' })
    const req = { params: { venueSlug: 'estudio-a' } } as unknown as Request
    const res = mkRes()
    const next = jest.fn() as NextFunction

    await resolveVenueBySlug(req, res, next)

    expect(venueFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ slug: 'estudio-a', active: true }) }),
    )
    expect((req as any).publicVenue).toEqual({ id: 'v1', slug: 'estudio-a' })
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('slug inexistente → 404 VENUE_NOT_FOUND, sin next()', async () => {
    venueFindFirst.mockResolvedValue(null)
    const req = { params: { venueSlug: 'no-existe' } } as unknown as Request
    const res = mkRes()
    const next = jest.fn() as NextFunction

    await resolveVenueBySlug(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'VENUE_NOT_FOUND' }))
  })

  it('sin :venueSlug en la ruta → 404 VENUE_NOT_FOUND (no consulta DB)', async () => {
    const req = { params: {} } as unknown as Request
    const res = mkRes()
    const next = jest.fn() as NextFunction

    await resolveVenueBySlug(req, res, next)

    expect(venueFindFirst).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(404)
  })
})

/**
 * Codex r3: crear un pedido en línea resuelve el negocio aunque esté desactivado. Ese rechazo lo decide el servicio bajo el
 * candado de la llave y queda guardado; aquí, un 404 se adelantaría a un envío vivo de la misma llave.
 */
describe('resolveVenueBySlugIncludingInactive', () => {
  it('no filtra por `active`: un negocio desactivado se resuelve y sigue', async () => {
    venueFindFirst.mockResolvedValue({ id: 'v1', slug: 'estudio-a' })
    const req = { params: { venueSlug: 'estudio-a' } } as unknown as Request
    const next = jest.fn() as NextFunction

    await resolveVenueBySlugIncludingInactive(req, mkRes(), next)

    expect(venueFindFirst.mock.calls[0][0].where).toEqual({ slug: 'estudio-a' })
    expect((req as any).publicVenue).toEqual({ id: 'v1', slug: 'estudio-a' })
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('slug inexistente → 404 VENUE_NOT_FOUND, sin next()', async () => {
    venueFindFirst.mockResolvedValue(null)
    const res = mkRes()
    const next = jest.fn() as NextFunction

    await resolveVenueBySlugIncludingInactive({ params: { venueSlug: 'no-existe' } } as unknown as Request, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'VENUE_NOT_FOUND' }))
  })
})
