/**
 * Every CRM route asks for a key. The «Equipo de ventas» routes decide who holds Avoqado's sales pipeline: they all ask
 * for `crm:admin`, and a route that forgot it would let ANY logged-in person list the team (emails and keys) or change it.
 * The rest ask for exactly the key of the plan's table (task 4), so a new route without one fails here.
 *
 * `requireCrm` is swapped for a marker that remembers the key it was given, so the test reads, straight from the router,
 * which key each route asks for. The real guard is covered by its own tests and by the sabotage integration test.
 */
jest.mock('@/middlewares/requireCrm.middleware', () => ({
  requireCrm: (key: unknown) => Object.assign((_req: unknown, _res: unknown, next: () => void) => next(), { crmKey: key }),
}))

import router from '@/routes/crm.routes'

type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: { crmKey?: unknown } }> } }

const routes = () =>
  (router.stack as unknown as Layer[])
    .filter(layer => layer.route)
    .map(layer => ({
      route: `${Object.keys(layer.route!.methods).join(',').toUpperCase()} ${layer.route!.path}`,
      keys: layer.route!.stack.map(handler => handler.handle.crmKey).filter(Boolean),
    }))

describe('crm team routes', () => {
  it('cada_ruta_del_equipo_pide_crm_admin', () => {
    const asked = routes().filter(({ route }) => route.split(' ')[1].startsWith('/team'))

    expect(asked).toEqual(
      expect.arrayContaining([
        { route: 'GET /team', keys: ['crm:admin'] },
        { route: 'POST /team', keys: ['crm:admin'] },
        { route: 'PATCH /team/:id', keys: ['crm:admin'] },
        { route: 'DELETE /team/:id', keys: ['crm:admin'] },
        // Ruling 13: the owner selector. The service hands the names only to whoever can reassign.
        { route: 'GET /team/options', keys: [['crm:admin', 'crm:editar']] },
      ]),
    )
    expect(asked).toHaveLength(5)
  })

  it('cada_ruta_del_crm_pide_su_llave', () => {
    const ver = ['crm:ver']
    const editar = ['crm:editar']
    const admin = ['crm:admin']
    const asked = routes().filter(({ route }) => !route.split(' ')[1].startsWith('/team'))

    expect(asked).toEqual([
      { route: 'GET /me', keys: [['crm:ver', 'crm:editar', 'crm:contactar', 'crm:campanas', 'crm:exportar', 'crm:ventas', 'crm:admin']] },
      { route: 'GET /pending', keys: ver },
      // An admin without «Ver negocios» still edits the stages and the reasons.
      { route: 'GET /stages', keys: [['crm:ver', 'crm:admin']] },
      { route: 'POST /stages', keys: admin },
      { route: 'PATCH /stages/:id', keys: admin },
      { route: 'GET /lost-reasons', keys: [['crm:ver', 'crm:admin']] },
      { route: 'POST /lost-reasons', keys: admin },
      { route: 'PATCH /lost-reasons/:id', keys: admin },
      { route: 'GET /organizations/search', keys: editar },
      { route: 'GET /accounts', keys: ver },
      { route: 'POST /accounts', keys: editar },
      { route: 'GET /accounts/:id', keys: ver },
      { route: 'POST /accounts/:id/take', keys: editar },
      // «Editar: todos» or admin, decided by the service: a «propios» seller gets a 403 that says why.
      { route: 'POST /accounts/:id/reassign', keys: [['crm:editar', 'crm:admin']] },
      { route: 'POST /accounts/:id/stage', keys: editar },
      { route: 'POST /accounts/:id/lose', keys: editar },
      { route: 'POST /accounts/:id/win', keys: editar },
      { route: 'POST /accounts/:id/archive', keys: editar },
      { route: 'POST /accounts/:id/reactivate', keys: editar },
      { route: 'POST /accounts/:id/notes', keys: editar },
      { route: 'POST /accounts/:id/activities', keys: editar },
      { route: 'POST /activities/:id/done', keys: editar },
    ])
  })
})
