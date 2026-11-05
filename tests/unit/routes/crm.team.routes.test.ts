/**
 * Every CRM route asks for a key. The «Equipo de ventas» routes decide who holds Avoqado's sales pipeline: they all ask
 * for `crm:equipo` («Equipo y llaves»), and a route that forgot it would let ANY logged-in person list the team (emails and
 * keys) or change it. The rest ask for exactly the key of the plan's table (llaves finas, 2026-11-04, L4–L9), so a new
 * route without one fails here. 🔴 Ninguna ruta pide ya `crm:campanas` ni `crm:admin` (son sólo el espejo de la pantalla vieja).
 *
 * `requireCrm` is swapped for a marker that remembers the key it was given, so the test reads, straight from the router,
 * which key each route asks for. The real guard is covered by its own tests and by the sabotage integration test.
 */
jest.mock('@/middlewares/requireCrm.middleware', () => ({
  requireCrm: (key: unknown) => Object.assign((_req: unknown, _res: unknown, next: () => void) => next(), { crmKey: key }),
}))

import { authenticateTokenMiddleware } from '@/middlewares/authenticateToken.middleware'
import { autenticacionOpcional } from '@/middlewares/autenticacionOpcional.middleware'
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
  it('cada_ruta_del_equipo_pide_crm_equipo (L6)', () => {
    const asked = routes().filter(({ route }) => route.split(' ')[1].startsWith('/team'))

    expect(asked).toEqual(
      expect.arrayContaining([
        { route: 'GET /team', keys: ['crm:equipo'] },
        { route: 'POST /team', keys: ['crm:equipo'] },
        { route: 'PATCH /team/:id', keys: ['crm:equipo'] },
        { route: 'DELETE /team/:id', keys: ['crm:equipo'] },
        // Ruling 13: the owner selector. The service hands the names only to whoever can reassign (equipo o editar: todos).
        { route: 'GET /team/options', keys: [['crm:equipo', 'crm:editar']] },
      ]),
    )
    expect(asked).toHaveLength(5)
  })

  it('cada_ruta_del_crm_pide_su_llave (llaves finas, L4–L9)', () => {
    const ver = ['crm:ver']
    const editar = ['crm:editar']
    // L9: ganar, perder y reabrir. «Cerrar negocios» sólo vale encima de «Editar» y en su alcance (L1).
    const cerrar = ['crm:cerrar']
    // L7: ordenar el archivero (etapas, motivos, ocultos, importar) y la puerta de «Eliminar».
    const configurar = ['crm:configurar']
    // L4: escribir plantillas y su prueba.
    const plantillas = ['crm:plantillas']
    // L4: las lee quien las usa: el uno a uno, quien las escribe y quien arma campañas.
    const leerPlantillas = [['crm:contactar', 'crm:plantillas', 'crm:preparar']]
    // L5: lista, detalle y conteo. `ver-campanas` es la efectiva: también la traen «Preparar» y «Mandar» (L1).
    const verCampanas = ['crm:ver-campanas']
    const preparar = ['crm:preparar']
    const mandar = ['crm:mandar']
    const asked = routes().filter(({ route }) => !route.split(' ')[1].startsWith('/team'))

    expect(asked).toEqual([
      // Google's return from «Conectar mi Gmail» (task 7): the ONE route without a key, on purpose — see the next test.
      { route: 'GET /gmail/callback', keys: [] },
      // Cualquier llave abre «/me», también las 8 finas (plan 2026-11-04): quien sólo tiene «Plantillas» entra.
      {
        route: 'GET /me',
        keys: [
          [
            'crm:ver',
            'crm:editar',
            'crm:contactar',
            'crm:campanas',
            'crm:exportar',
            'crm:ventas',
            'crm:admin',
            'crm:plantillas',
            'crm:preparar',
            'crm:mandar',
            'crm:ver-campanas',
            'crm:equipo',
            'crm:configurar',
            'crm:bajas',
            'crm:cerrar',
          ],
        ],
      },
      { route: 'GET /pending', keys: ver },
      // L7: quien configura las cambia aunque no vea el embudo; quien ve el embudo las lee.
      { route: 'GET /stages', keys: [['crm:ver', 'crm:configurar']] },
      { route: 'POST /stages', keys: configurar },
      { route: 'PATCH /stages/:id', keys: configurar },
      { route: 'GET /lost-reasons', keys: [['crm:ver', 'crm:configurar']] },
      { route: 'POST /lost-reasons', keys: configurar },
      { route: 'PATCH /lost-reasons/:id', keys: configurar },
      { route: 'GET /organizations/search', keys: editar },
      { route: 'GET /accounts', keys: ver },
      { route: 'POST /accounts', keys: editar },
      { route: 'GET /accounts/:id', keys: ver },
      { route: 'POST /accounts/:id/take', keys: editar },
      // L6: «Editar: todos» o «Equipo y llaves», decided by the service: a «propios» seller gets a 403 that says why.
      { route: 'POST /accounts/:id/reassign', keys: [['crm:editar', 'crm:equipo']] },
      // Mover uno abierto pide «Editar»; reabrir uno GANADO o PERDIDO pide además «Cerrar negocios» (lo decide el servicio, L9).
      { route: 'POST /accounts/:id/stage', keys: editar },
      { route: 'POST /accounts/:id/lose', keys: cerrar },
      { route: 'POST /accounts/:id/win', keys: cerrar },
      { route: 'POST /accounts/:id/archive', keys: editar },
      // «Regresar al embudo» desarchiva (no reabre un cierre): la misma llave que archivar.
      { route: 'POST /accounts/:id/reactivate', keys: editar },
      // «Eliminar» (D7): «Configurar el CRM» es la puerta; el servicio sólo deja pasar al superadmin real (L7).
      { route: 'POST /accounts/:id/delete', keys: configurar },
      { route: 'POST /accounts/:id/notes', keys: editar },
      { route: 'POST /accounts/:id/activities', keys: editar },
      // Task 9: what is live, «Clientes» and the reports with «Ver negocios»; the CSV with its own key.
      { route: 'GET /accounts/:id/live', keys: ver },
      { route: 'GET /clients', keys: ver },
      // Ruling 39 y L7: ocultar una organización interna o de prueba de «Clientes» es de quien configura el CRM.
      { route: 'POST /clients/:organizationId/hide', keys: configurar },
      { route: 'POST /clients/:organizationId/unhide', keys: configurar },
      // Ruling 47: what is live for a client without a CRM account, with the same key as the account's.
      { route: 'GET /clients/:organizationId/live', keys: ver },
      { route: 'GET /reports', keys: ver },
      { route: 'GET /export.csv', keys: ['crm:exportar'] },
      { route: 'POST /activities/:id/done', keys: editar },
      // Ruling 55: «Reagendar», with the same key and scope as «Hecha».
      { route: 'POST /activities/:id/reschedule', keys: editar },
      // L4: las plantillas las escribe «Plantillas»; la vista previa también la usa quien ve campañas (`VistaPrevia`).
      { route: 'GET /templates', keys: leerPlantillas },
      { route: 'POST /templates', keys: plantillas },
      { route: 'POST /templates/preview', keys: [['crm:contactar', 'crm:plantillas', 'crm:preparar', 'crm:ver-campanas']] },
      { route: 'POST /templates/test', keys: plantillas },
      { route: 'GET /templates/:id', keys: leerPlantillas },
      { route: 'PATCH /templates/:id', keys: plantillas },
      { route: 'POST /templates/:id/archive', keys: plantillas },
      { route: 'POST /templates/:id/unarchive', keys: plantillas },
      // L5: ver, preparar (crear, editar, probar) y mandar (mandar y cancelar).
      { route: 'GET /campaigns', keys: verCampanas },
      { route: 'POST /campaigns', keys: preparar },
      { route: 'GET /campaigns/:id', keys: verCampanas },
      { route: 'PATCH /campaigns/:id', keys: preparar },
      { route: 'POST /campaigns/:id/preview', keys: verCampanas },
      { route: 'POST /campaigns/:id/test', keys: preparar },
      { route: 'POST /campaigns/:id/send', keys: mandar },
      { route: 'POST /campaigns/:id/cancel', keys: mandar },
      // L4: la plantilla y el contenido de la campaña llevan imágenes.
      { route: 'POST /uploads/image', keys: [['crm:plantillas', 'crm:preparar']] },
      // The seller's own Gmail (task 7): «Mandar correo», which only counts on top of «Ver negocios».
      { route: 'GET /gmail', keys: ['crm:contactar'] },
      { route: 'GET /gmail/connect', keys: ['crm:contactar'] },
      { route: 'POST /gmail/disconnect', keys: ['crm:contactar'] },
      { route: 'POST /accounts/:id/emails', keys: ['crm:contactar'] },
      // «Dar de baja este correo» (la oposición): «Bajas de correo», que va sola (L8).
      { route: 'POST /opt-outs', keys: ['crm:bajas'] },
      // «Importar lo de HubSpot» (task 8, L7).
      { route: 'POST /import/hubspot/preview', keys: configurar },
      { route: 'POST /import/hubspot/apply', keys: configurar },
    ])
    // 🔴 Fuera de `/me` (que acepta cualquier llave), ninguna ruta decide con las llaves viejas.
    const viejas = routes()
      .filter(({ route }) => route !== 'GET /me')
      .filter(({ keys }) => JSON.stringify(keys).match(/crm:(campanas|admin)"/))
    expect(viejas).toEqual([])
  })

  it('cada_ruta_pide_su_llave_antes_que_nada_y_el_token_antes_de_todo (m-5, ruling 52)', () => {
    // The router lives OUTSIDE the superadmin guard (a seller is a VIEWER of the team's venue): a route whose first
    // handler is not `requireCrm` would validate, read or upload for any signed-in user of any business before saying no.
    const layers = router.stack as unknown as Array<Layer & { handle?: unknown }>
    const unguarded = layers
      .filter(layer => layer.route && !layer.route.stack[0]?.handle.crmKey)
      .map(layer => `${Object.keys(layer.route!.methods).join(',').toUpperCase()} ${layer.route!.path}`)
    // The ONE exception (plan task 7): Google's return lands here from Google's screen, so a missing or foreign session must
    // become a redirect to «Mi Gmail» (`?error=otra-sesion`), not a bare 401. It reads the session WITHOUT demanding it, and
    // `completarConexion` demands it be the person who asked for the link and re-reads their key.
    expect(unguarded).toEqual(['GET /gmail/callback'])
    const callback = layers.findIndex(layer => layer.route?.path === '/gmail/callback')
    expect(layers[callback].route!.stack[0].handle).toBe(autenticacionOpcional)

    const auth = layers.findIndex(layer => layer.handle === authenticateTokenMiddleware)
    expect(auth).toBeGreaterThanOrEqual(0)
    expect(callback).toBeLessThan(auth)
    expect(auth).toBeLessThan(layers.findIndex(layer => layer.route && layer.route.path !== '/gmail/callback'))
  })

  it('importar_pide_crm_configurar_antes_de_leer_los_archivos', () => {
    // The key is the FIRST handler: a caller without it never has its upload read into memory.
    for (const path of ['/import/hubspot/preview', '/import/hubspot/apply']) {
      const layer = (router.stack as unknown as Layer[]).find(candidate => candidate.route?.path === path)
      expect(layer!.route!.stack[0].handle.crmKey).toBe('crm:configurar')
    }
  })
})
