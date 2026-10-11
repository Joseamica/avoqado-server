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

import express, { type Request } from 'express'
import request from 'supertest'
import type { Logform } from 'winston'

import logger from '@/config/logger'
import { resolveRequestVenueId } from '@/middlewares/checkPermission.middleware'
import { requestLoggerMiddleware } from '@/middlewares/requestLogger'
import { enrichContext, getContext, runWithContext, type ExecutionContext } from '@/observability/executionContext'
import { contextFormat } from '@/observability/logContext'
import { getVenueName, primeVenueNames, __resetVenueNameCacheForTests } from '@/observability/venueNames'
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

/**
 * 🔴 7-oct-2026 · `Request End`, la línea que de verdad se busca, seguía con el venue del TOKEN.
 *
 * `resolveRequestVenueId` corrige el contexto ambiental (venueId + venueName) al venue de la operación, pero el logger
 * escribía `venueId: authContext.venueId` como campo EXPLÍCITO, y un campo explícito gana al ambiental (`logContext.ts`):
 * la línea salía con el venueId del token junto al venueName del venue operado. Caso real: un OWNER con token de
 * «Avoqado Wellness» miraba una terminal de «Avoqado Full» y su `Request End` decía venueId de Wellness con
 * venueName «Avoqado Full». Filtrar por venueId mandaba la investigación al negocio equivocado.
 *
 * Express REAL, logger real y resolución real del venue. Lo único doble es la autenticación (estampa el tenant del token, como
 * `authenticateTokenMiddleware`) y winston: de ahí se lee el registro YA mezclado con el contexto (`contextFormat`), o sea lo
 * que de verdad se escribe.
 */
describe('Request End — el venue de la línea es el de la OPERACIÓN, no el del token', () => {
  const registros: Array<Record<string, unknown>> = []

  beforeEach(() => {
    registros.length = 0
    ;(logger.log as jest.Mock).mockImplementation((level: string, message: string, meta: object) => {
      registros.push(
        contextFormat().transform({ level, message, ...meta } as Logform.TransformableInfo) as unknown as Record<string, unknown>,
      )
    })
  })

  afterAll(() => {
    ;(logger.log as jest.Mock).mockReset()
  })

  /** Lo que hace `authenticateTokenMiddleware`: el tenant del TOKEN, en `req.authContext` y en el contexto ambiental. */
  const autenticaConToken: express.RequestHandler = (req, _res, next) => {
    const authContext = { userId: 'staff-1', venueId: TOKEN_VENUE, role: 'SUPERADMIN' }
    ;(req as any).authContext = authContext
    enrichContext({
      venueId: authContext.venueId,
      venueName: getVenueName(authContext.venueId),
      userId: authContext.userId,
      role: authContext.role,
    })
    next()
  }

  /** Una autenticación que pone `req.authContext` pero NO estampa el contexto ambiental (como la vieja `protectRoute`). */
  const autenticaSinEstamparContexto: express.RequestHandler = (req, _res, next) => {
    ;(req as any).authContext = { userId: 'staff-1', venueId: TOKEN_VENUE, role: 'SUPERADMIN' }
    next()
  }

  const armarApp = (autentica: express.RequestHandler | null) => {
    const app = express()
    app.use(requestLoggerMiddleware)
    if (autentica) app.use(autentica)
    // Lo que hace `checkPermission`: resuelve el venue de la OPERACIÓN (params → header → token) y lo publica al contexto.
    const resuelveElVenue: express.RequestHandler = (req, res) => {
      resolveRequestVenueId(req, (req as any).authContext ?? {})
      res.json({})
    }
    app.get('/venues/:venueId/cosa', resuelveElVenue)
    app.get('/cosa', resuelveElVenue)
    app.get('/sin-resolver', (_req, res) => res.json({}))
    return app
  }

  const requestEnd = async (ruta: string) => {
    await new Promise(resolve => setImmediate(resolve)) // `finish` corre en el servidor al terminar de escribir la respuesta
    return registros.find(r => String(r.message).startsWith(`Request End: GET ${ruta} - `))
  }

  it('🔴 superadmin cross-venue (:venueId en la ruta): la línea lleva el venueId Y el venueName del venue operado', async () => {
    await request(armarApp(autenticaConToken)).get(`/venues/${OTHER_VENUE}/cosa`).expect(200)

    expect(await requestEnd(`/venues/${OTHER_VENUE}/cosa`)).toMatchObject({ venueId: OTHER_VENUE, venueName: 'BAE Papagayo' })
  })

  it('🔴 dashboard con `x-venue-id`: gana el venue activo del header sobre el JWT viejo', async () => {
    await request(armarApp(autenticaConToken)).get('/cosa').set('x-venue-id', OTHER_VENUE).expect(200)

    expect(await requestEnd('/cosa')).toMatchObject({ venueId: OTHER_VENUE, venueName: 'BAE Papagayo' })
  })

  it('camino normal (opera sobre su propio venue): la línea queda igual', async () => {
    await request(armarApp(autenticaConToken)).get(`/venues/${TOKEN_VENUE}/cosa`).expect(200)

    expect(await requestEnd(`/venues/${TOKEN_VENUE}/cosa`)).toMatchObject({ venueId: TOKEN_VENUE, venueName: 'Venue De Casa' })
  })

  it('el resto de la línea no cambia: usuario y rol siguen siendo los del token, y el status, el método y el entrypoint', async () => {
    await request(armarApp(autenticaConToken)).get(`/venues/${OTHER_VENUE}/cosa`).expect(200)

    expect(await requestEnd(`/venues/${OTHER_VENUE}/cosa`)).toMatchObject({
      userId: 'staff-1',
      role: 'SUPERADMIN',
      method: 'GET',
      statusCode: 200,
      source: 'http',
      entrypoint: `GET /venues/${OTHER_VENUE}/cosa`,
    })
  })

  it('🔴 una autenticación que NO estampó el contexto sigue dejando el venueId del token (el respaldo)', async () => {
    await request(armarApp(autenticaSinEstamparContexto)).get('/sin-resolver').expect(200)

    expect(await requestEnd('/sin-resolver')).toMatchObject({ venueId: TOKEN_VENUE })
  })

  it('una ruta sin autenticación no inventa un venue', async () => {
    await request(armarApp(null)).get('/sin-resolver').expect(200)

    const linea = await requestEnd('/sin-resolver')
    expect(linea).toBeDefined()
    expect(linea).not.toHaveProperty('venueId')
  })
})
