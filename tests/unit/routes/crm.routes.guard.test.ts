/**
 * m-5 (ruling 52): every route of `/api/v1/crm` opens only with a CRM key. The router is mounted OUTSIDE the superadmin
 * guard on purpose (a seller is a VIEWER of the team's venue), so a route that forgot `requireCrm` would be open to any
 * signed-in user of any business. This walks the real router: each route's FIRST handler is `requireCrm`, and the token
 * is checked before everything.
 */
jest.mock('@/middlewares/requireCrm.middleware', () => ({
  requireCrm: (keys: unknown) => Object.assign((_req: unknown, _res: unknown, next: () => void) => next(), { crmKeys: keys }),
}))

import { authenticateTokenMiddleware } from '@/middlewares/authenticateToken.middleware'
import router from '@/routes/crm.routes'

type Layer = {
  handle: ((...args: unknown[]) => unknown) & { crmKeys?: unknown }
  route?: { path: string; methods: object; stack: Layer[] }
}
const stack = (router as unknown as { stack: Layer[] }).stack

it('cada_ruta_del_crm_pide_requireCrm_antes_que_nada', () => {
  const routes = stack.filter(layer => layer.route).map(layer => layer.route!)
  // The walk sees the real router: all of today's routes, the two of the final review included.
  expect(routes.length).toBeGreaterThanOrEqual(37)
  expect(routes.map(route => route.path)).toEqual(expect.arrayContaining(['/clients/:organizationId/live', '/activities/:id/reschedule']))

  const unguarded = routes
    .filter(route => !route.stack[0]?.handle.crmKeys)
    .map(route => `${Object.keys(route.methods).join(',').toUpperCase()} ${route.path}`)
  expect(unguarded).toEqual([])
})

it('el_token_va_antes_de_cualquier_ruta', () => {
  const first = stack.findIndex(layer => layer.route)
  const auth = stack.findIndex(layer => layer.handle === authenticateTokenMiddleware)
  expect(auth).toBeGreaterThanOrEqual(0)
  expect(auth).toBeLessThan(first)
})
