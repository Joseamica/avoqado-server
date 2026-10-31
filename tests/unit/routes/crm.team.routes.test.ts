/**
 * The «Equipo de ventas» routes decide who holds Avoqado's sales pipeline: every one of them must ask for `crm:admin`.
 * A route that forgot it would let ANY logged-in person list the team (emails and keys) or change it.
 *
 * `requireCrm` is swapped for a marker that remembers the key it was given, so the test reads, straight from the router,
 * which key each route asks for. The real guard is covered by its own tests and by the sabotage integration test.
 */
jest.mock('@/middlewares/requireCrm.middleware', () => ({
  requireCrm: (key: unknown) => Object.assign((_req: unknown, _res: unknown, next: () => void) => next(), { crmKey: key }),
}))
jest.mock('@/controllers/crm/crm.controller', () => ({
  getMe: jest.fn(),
  listTeam: jest.fn(),
  addTeam: jest.fn(),
  updateTeam: jest.fn(),
  removeTeam: jest.fn(),
}))

import router from '@/routes/crm.routes'

type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: { crmKey?: unknown } }> } }

describe('crm team routes', () => {
  it('cada_ruta_del_equipo_pide_crm_admin', () => {
    const asked = (router.stack as unknown as Layer[])
      .filter(layer => layer.route?.path.startsWith('/team'))
      .map(layer => ({
        route: `${Object.keys(layer.route!.methods).join(',').toUpperCase()} ${layer.route!.path}`,
        keys: layer.route!.stack.map(handler => handler.handle.crmKey).filter(Boolean),
      }))

    expect(asked).toEqual(
      expect.arrayContaining([
        { route: 'GET /team', keys: ['crm:admin'] },
        { route: 'POST /team', keys: ['crm:admin'] },
        { route: 'PATCH /team/:id', keys: ['crm:admin'] },
        { route: 'DELETE /team/:id', keys: ['crm:admin'] },
      ]),
    )
    expect(asked).toHaveLength(4)
  })
})
