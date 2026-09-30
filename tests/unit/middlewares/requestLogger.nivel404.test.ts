/**
 * 30-sep-2026 · Inventario de warns de producción: ~920 líneas en 3 días eran `Request End … 404` de escáneres de internet
 * (`/.env`, `/wp-admin`, `//xmlrpc.php`, `/graphql`) — URLs que NINGUNA ruta atendió (`req.route` vacío). Eso no es un aviso
 * del sistema: baja a info (sigue en el log y se sigue pudiendo contar). Un 404 que decidió una RUTA —su handler o un
 * middleware de esa ruta, como `resolveVenueBySlug`— y cualquier otro 4xx siguen en warn; los 5xx, en error.
 *
 * Se prueba contra un Express REAL (con un router anidado, como `app.use('/api/v1', mainApiRouter)`) porque la regla depende
 * de cuándo Express llena `req.route`, y eso no se puede suponer con un doble.
 */
import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'
import logger from '@/config/logger'
import { requestLoggerMiddleware } from '@/middlewares/requestLogger'

const armarApp = () => {
  const app = express()
  app.use(requestLoggerMiddleware)
  const api = express.Router()
  api.get('/venues/:id', (_req: Request, res: Response) => res.status(404).json({ error: 'El negocio no existe' }))
  // Un middleware DE RUTA que contesta 404 antes del handler (la forma de resolveVenueBySlug / bindTpvCommandTarget).
  api.get(
    '/public/:slug',
    (_req: Request, res: Response, next: NextFunction) => (_req.params.slug === 'no-existe' ? res.status(404).json({}) : next()),
    (_req: Request, res: Response) => res.json({}),
  )
  api.get('/prohibido', (_req: Request, res: Response) => res.status(401).json({}))
  api.get('/truena', (_req: Request, res: Response) => res.status(500).json({}))
  api.get('/ok', (_req: Request, res: Response) => res.json({}))
  app.use('/api/v1', api)
  return app
}

/** El nivel con el que se escribió la línea `Request End` de esa ruta (el logger está mockeado globalmente). */
const nivelDe = async (ruta: string): Promise<string | undefined> => {
  await new Promise(resolve => setImmediate(resolve)) // `finish` corre en el servidor al terminar de escribir la respuesta
  return (logger.log as jest.Mock).mock.calls.find(([, mensaje]) => String(mensaje).startsWith(`Request End: GET ${ruta} - `))?.[0]
}

it('un 404 que NINGUNA ruta atendió (un escáner pidiendo /.env) cierra en info, no en warn', async () => {
  await request(armarApp()).get('/.env').expect(404)
  expect(await nivelDe('/.env')).toBe('info')
})

it('lo mismo dentro del prefijo de la API: /api/v1/graphql no existe y nadie lo atendió → info', async () => {
  await request(armarApp()).get('/api/v1/graphql').expect(404)
  expect(await nivelDe('/api/v1/graphql')).toBe('info')
})

it('🔴 un 404 que decidió el HANDLER de una ruta del router anidado («el negocio no existe») sigue en warn', async () => {
  await request(armarApp()).get('/api/v1/venues/cm123').expect(404)
  expect(await nivelDe('/api/v1/venues/cm123')).toBe('warn')
})

it('🔴 un 404 que decidió un MIDDLEWARE de la ruta (la forma de resolveVenueBySlug) sigue en warn', async () => {
  await request(armarApp()).get('/api/v1/public/no-existe').expect(404)
  expect(await nivelDe('/api/v1/public/no-existe')).toBe('warn')
})

it('regresión: 401 en warn, 500 en error y 200 en info', async () => {
  const app = armarApp()
  await request(app).get('/api/v1/prohibido').expect(401)
  await request(app).get('/api/v1/truena').expect(500)
  await request(app).get('/api/v1/ok').expect(200)
  expect(await nivelDe('/api/v1/prohibido')).toBe('warn')
  expect(await nivelDe('/api/v1/truena')).toBe('error')
  expect(await nivelDe('/api/v1/ok')).toBe('info')
})
