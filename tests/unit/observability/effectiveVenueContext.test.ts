/**
 * El `venueName` del log tiene que ser el venue de la OPERACIÓN, no el del TOKEN.
 *
 * `authenticateTokenMiddleware` estampa el tenant desde el JWT — correcto casi siempre, y
 * equivocado justo en los dos casos que uno investiga:
 *
 *  1. **Superadmin cross-venue**: el token trae su venue "de casa" y el controlador opera sobre
 *     `req.params.venueId`. Aprobar el KYC del venue B se logueaba como venue A.
 *  2. **Dashboard con `x-venue-id`**: las rutas org-scoped mandan el venue activo por header
 *     precisamente porque el JWT trae el venue viejo del último `switchVenue`.
 *
 * `resolveRequestVenueId` ya era la respuesta canónica a "¿de qué venue es esta operación?"
 * (params → header → token). Esto verifica que además la publique a la observabilidad.
 *
 * Filtrar el log por negocio (`grep "venueName: 'BAE Papagayo'"`) es la única forma práctica de
 * investigar con ~30 crons escribiendo en paralelo: un tenant equivocado no es un detalle
 * cosmético, manda la investigación al negocio que no era.
 */

import type { Request } from 'express'

import { resolveRequestVenueId } from '@/middlewares/checkPermission.middleware'
import { getContext, runWithContext, type ExecutionContext } from '@/observability/executionContext'
import { primeVenueNames, __resetVenueNameCacheForTests } from '@/observability/venueNames'
import prisma from '@/utils/prismaClient'

const prismaMock = prisma as unknown as {
  venue: { findUnique: jest.Mock; findMany: jest.Mock }
}

const TOKEN_VENUE = 'venue-token-casa'
const OTHER_VENUE = 'venue-operacion'

const buildReq = (overrides: { params?: Record<string, string>; headers?: Record<string, string> } = {}): Request =>
  ({
    params: overrides.params ?? {},
    headers: overrides.headers ?? {},
  }) as unknown as Request

/** El contexto tal cual queda tras `authenticateTokenMiddleware`: el venue del TOKEN. */
const contextFromToken = (): ExecutionContext => ({
  correlationId: 'corr-1',
  source: 'http',
  entrypoint: 'POST /api/v1/dashboard/venues/:id/kyc',
  venueId: TOKEN_VENUE,
  venueName: 'Venue De Casa',
  userId: 'staff-1',
  role: 'SUPERADMIN',
})

beforeEach(async () => {
  __resetVenueNameCacheForTests()
  prismaMock.venue.findUnique.mockReset()
  prismaMock.venue.findMany.mockReset()
  prismaMock.venue.findMany.mockResolvedValue([
    { id: TOKEN_VENUE, name: 'Venue De Casa' },
    { id: OTHER_VENUE, name: 'BAE Papagayo' },
  ])
  await primeVenueNames()
})

describe('resolveRequestVenueId — estampa el venue EFECTIVO en el contexto del log', () => {
  it('🔴 superadmin cross-venue (:venueId en la ruta): el log queda con el venue operado, no con el del token', () => {
    runWithContext(contextFromToken(), () => {
      const resolved = resolveRequestVenueId(buildReq({ params: { venueId: OTHER_VENUE } }), { venueId: TOKEN_VENUE })

      expect(resolved).toBe(OTHER_VENUE)
      expect(getContext()?.venueId).toBe(OTHER_VENUE)
      // El NOMBRE es lo que se lee y se filtra — sin él la corrección no sirve de nada.
      expect(getContext()?.venueName).toBe('BAE Papagayo')
    })
  })

  it('🔴 dashboard con `x-venue-id`: gana el venue activo del header sobre el JWT viejo', () => {
    runWithContext(contextFromToken(), () => {
      const resolved = resolveRequestVenueId(buildReq({ headers: { 'x-venue-id': OTHER_VENUE } }), { venueId: TOKEN_VENUE })

      expect(resolved).toBe(OTHER_VENUE)
      expect(getContext()?.venueId).toBe(OTHER_VENUE)
      expect(getContext()?.venueName).toBe('BAE Papagayo')
    })
  })

  it('camino normal (opera sobre su propio venue): el contexto queda igual', () => {
    runWithContext(contextFromToken(), () => {
      const resolved = resolveRequestVenueId(buildReq({ params: { venueId: TOKEN_VENUE } }), { venueId: TOKEN_VENUE })

      expect(resolved).toBe(TOKEN_VENUE)
      expect(getContext()?.venueId).toBe(TOKEN_VENUE)
      expect(getContext()?.venueName).toBe('Venue De Casa')
    })
  })

  it('no rompe el resto del contexto: correlationId, entrypoint y usuario se conservan', () => {
    runWithContext(contextFromToken(), () => {
      resolveRequestVenueId(buildReq({ params: { venueId: OTHER_VENUE } }), { venueId: TOKEN_VENUE })

      const ctx = getContext()
      expect(ctx?.correlationId).toBe('corr-1')
      expect(ctx?.entrypoint).toBe('POST /api/v1/dashboard/venues/:id/kyc')
      expect(ctx?.userId).toBe('staff-1')
    })
  })

  it('🔴 fuera de un contexto (script, test, webhook) no truena: sigue resolviendo el venue', () => {
    expect(() => {
      const resolved = resolveRequestVenueId(buildReq({ params: { venueId: OTHER_VENUE } }), { venueId: TOKEN_VENUE })
      expect(resolved).toBe(OTHER_VENUE)
    }).not.toThrow()
    expect(getContext()).toBeUndefined()
  })

  it('un venue cuyo nombre aún no está en cache no bloquea ni borra el id (nombre = nicety)', () => {
    prismaMock.venue.findUnique.mockResolvedValue({ name: 'Venue Nuevo' })

    runWithContext(contextFromToken(), () => {
      resolveRequestVenueId(buildReq({ params: { venueId: 'venue-recien-creado' } }), { venueId: TOKEN_VENUE })

      expect(getContext()?.venueId).toBe('venue-recien-creado')
      expect(getContext()?.venueName).toBeUndefined()
    })
  })

  it('la resolución pura no cambia: params gana al header, y el header al token', () => {
    const req = buildReq({ params: { venueId: 'de-params' }, headers: { 'x-venue-id': 'de-header' } })
    expect(resolveRequestVenueId(req, { venueId: TOKEN_VENUE })).toBe('de-params')
    expect(resolveRequestVenueId(buildReq({ headers: { 'x-venue-id': 'de-header' } }), { venueId: TOKEN_VENUE })).toBe('de-header')
    expect(resolveRequestVenueId(buildReq(), { venueId: TOKEN_VENUE })).toBe(TOKEN_VENUE)
    expect(resolveRequestVenueId(buildReq(), {})).toBeUndefined()
  })
})
