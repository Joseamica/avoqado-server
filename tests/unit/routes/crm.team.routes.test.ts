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

import { authenticateTokenMiddleware } from '@/middlewares/authenticateToken.middleware'
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
      // «Eliminar» (D7): the key is the door; the service lets only the real superadmin through.
      { route: 'POST /accounts/:id/delete', keys: admin },
      { route: 'POST /accounts/:id/notes', keys: editar },
      { route: 'POST /accounts/:id/activities', keys: editar },
      // Task 9: what is live, «Clientes» and the reports with «Ver negocios»; the CSV with its own key.
      { route: 'GET /accounts/:id/live', keys: ver },
      { route: 'GET /clients', keys: ver },
      // Ruling 39: hiding an internal or test organization from «Clientes» is the admin's.
      { route: 'POST /clients/:organizationId/hide', keys: admin },
      { route: 'POST /clients/:organizationId/unhide', keys: admin },
      // Ruling 47: what is live for a client without a CRM account, with the same key as the account's.
      { route: 'GET /clients/:organizationId/live', keys: ver },
      { route: 'GET /reports', keys: ver },
      { route: 'GET /export.csv', keys: ['crm:exportar'] },
      { route: 'POST /activities/:id/done', keys: editar },
      // Ruling 55: «Reagendar», with the same key and scope as «Hecha».
      { route: 'POST /activities/:id/reschedule', keys: editar },
      // «Importar lo de HubSpot» (task 8).
      { route: 'POST /import/hubspot/preview', keys: admin },
      { route: 'POST /import/hubspot/apply', keys: admin },
    ])
  })

  it('cada_ruta_pide_su_llave_antes_que_nada_y_el_token_antes_de_todo (m-5, ruling 52)', () => {
    // The router lives OUTSIDE the superadmin guard (a seller is a VIEWER of the team's venue): a route whose first
    // handler is not `requireCrm` would validate, read or upload for any signed-in user of any business before saying no.
    const layers = router.stack as unknown as Array<Layer & { handle?: unknown }>
    const unguarded = layers
      .filter(layer => layer.route && !layer.route.stack[0]?.handle.crmKey)
      .map(layer => `${Object.keys(layer.route!.methods).join(',').toUpperCase()} ${layer.route!.path}`)
    expect(unguarded).toEqual([])

    const auth = layers.findIndex(layer => layer.handle === authenticateTokenMiddleware)
    expect(auth).toBeGreaterThanOrEqual(0)
    expect(auth).toBeLessThan(layers.findIndex(layer => layer.route))
  })

  it('importar_pide_crm_admin_antes_de_leer_los_archivos', () => {
    // The key is the FIRST handler: a caller without it never has its upload read into memory.
    for (const path of ['/import/hubspot/preview', '/import/hubspot/apply']) {
      const layer = (router.stack as unknown as Layer[]).find(candidate => candidate.route?.path === path)
      expect(layer!.route!.stack[0].handle.crmKey).toBe('crm:admin')
    }
  })
})
