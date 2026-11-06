/**
 * The CRM router with the REAL guard (`requireCrm` re-reading the keys from the — mocked — database): an admin who
 * manages the team but does not see the pipeline still reads and edits the stages and the lost reasons, and still does
 * not see a single account.
 */
import 'express-async-errors'
import express from 'express'
import request from 'supertest'
import { prismaMock } from '@tests/__helpers__/setup'

const ADMIN_ID = 'cstaffadm0000000000000009'

/** Las 8 llaves finas (plan 2026-11-04), todas apagadas. */
const SIN_FINAS = {
  cerrar: false,
  bajas: false,
  plantillas: false,
  preparar: false,
  mandar: false,
  verCampanas: false,
  equipo: false,
  configurar: false,
}

jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: any, _res: unknown, next: () => void) => {
    req.authContext = {
      userId: 'cstaffadm0000000000000009',
      orgId: 'corgteam00000000000000001',
      venueId: 'cvenuecrm0000000000000001',
      role: 'VIEWER',
    }
    next()
  },
}))

import router from '@/routes/crm.routes'
import * as hubspotImport from '@/services/crm/hubspotImport.service'
import * as fichaService from '@/services/crm/ficha.service'

const app = express().use(express.json()).use('/crm', router)
/** With the app's error handler reduced to what these tests read: the status, the code and the message. */
const appWithErrors = express()
  .use('/crm', router)
  .use(
    (
      error: { statusCode?: number; code?: string; message: string },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(error.statusCode ?? 500).json({ code: error.code, message: error.message })
    },
  )

beforeEach(() => {
  for (const fn of [
    prismaMock.staff.findUnique,
    prismaMock.staffVenue.findFirst,
    prismaMock.platformAccess.findUnique,
    prismaMock.crmStage.count,
    prismaMock.crmLostReason.count,
    prismaMock.crmStage.findMany,
    prismaMock.crmLostReason.findMany,
    prismaMock.crmStage.findFirst,
    prismaMock.crmAccount.findMany,
    prismaMock.crmContact.groupBy,
    prismaMock.platformAccess.findFirst,
    prismaMock.platformAccess.update,
    prismaMock.platformAccess.updateManyAndReturn,
  ])
    fn.mockReset()
  // An admin of the team: «Administrar» on, «Ver negocios» off. Not a superadmin. Como lo deja la migración de las llaves
  // finas (L2): `admin` trae las 3 de administración y las 4 de correo masivo, y el espejo `campanas`/`admin` prendido.
  prismaMock.staff.findUnique.mockResolvedValue({ email: 'admin@avoqado.io', active: true, emailVerified: true })
  prismaMock.staffVenue.findFirst.mockResolvedValue(null)
  prismaMock.platformAccess.findUnique.mockResolvedValue({
    id: 'caccessrw0000000000000009',
    staffId: ADMIN_ID,
    verScope: null,
    editarScope: null,
    contactar: false,
    campanas: true,
    exportar: false,
    ventas: false,
    admin: true,
    ...SIN_FINAS,
    plantillas: true,
    preparar: true,
    mandar: true,
    verCampanas: true,
    equipo: true,
    configurar: true,
    bajas: true,
  })
  prismaMock.crmStage.count.mockResolvedValue(7)
  prismaMock.crmLostReason.count.mockResolvedValue(5)
})

it('admin_sin_ver_lee_etapas_y_motivos', async () => {
  prismaMock.crmStage.findMany.mockResolvedValue([
    { id: 'cstageprs0000000000000001', name: 'Prospecto', order: 1, kind: 'ABIERTA', staleDays: 2 },
  ])
  prismaMock.crmLostReason.findMany.mockResolvedValue([{ id: 'creasonpr0000000000000001', name: 'Precio', active: true }])

  const stages = await request(app).get('/crm/stages')
  expect(stages.status).toBe(200)
  expect(stages.body.data).toEqual([{ id: 'cstageprs0000000000000001', name: 'Prospecto', order: 1, kind: 'ABIERTA', staleDays: 2 }])

  const reasons = await request(app).get('/crm/lost-reasons')
  expect(reasons.status).toBe(200)
  expect(reasons.body.data).toEqual([{ id: 'creasonpr0000000000000001', name: 'Precio', active: true }])

  // The pipeline itself stays closed to them.
  for (const path of ['/crm/accounts', '/crm/pending']) {
    const res = await request(app).get(path)
    expect(res.status).toBe(403)
    expect(res.body).toMatchObject({ code: 'CRM_FORBIDDEN' })
  }
})

describe('importar lo de HubSpot', () => {
  const FIVE_MB = 5 * 1024 * 1024
  const DEALS = Buffer.from('Record ID,Deal Name,Deal Stage,Associated Contact IDs\n')
  const preview = () => request(appWithErrors).post('/crm/import/hubspot/preview')

  it('archivo_de_mas_de_5_mb_es_422_no_500', async () => {
    const res = await preview()
      .attach('contactos', Buffer.alloc(FIVE_MB + 1, 'a'), 'contactos.csv')
      .attach('negocios', DEALS, 'negocios.csv')

    expect(res.status).toBe(422)
    expect(res.body).toEqual({ code: 'CRM_IMPORT_ARCHIVO_INVALIDO', message: 'Cada archivo puede pesar hasta 5 MB' })
  })

  it('5_mb_exactos_se_leen_y_la_vista_previa_dice_por_que_no_sirve', async () => {
    const res = await preview().attach('contactos', Buffer.alloc(FIVE_MB, 'a'), 'contactos.csv').attach('negocios', DEALS, 'negocios.csv')

    expect(res.status).toBe(200)
    expect(res.body.data.conError).toEqual([{ archivo: 'contactos', fila: 1, razon: 'Falta la columna «Record ID»' }])
  })

  it('sin_uno_de_los_dos_archivos_es_422', async () => {
    const res = await preview().attach('contactos', Buffer.from('Record ID\n1\n'), 'contactos.csv')

    expect(res.status).toBe(422)
    expect(res.body).toEqual({ code: 'CRM_IMPORT_ARCHIVO_INVALIDO', message: 'Falta el archivo de negocios' })
  })

  it('archivo_que_no_es_utf8_es_422', async () => {
    // Excel re-saved it as ANSI: «José» would come in as «Jos�» without a word.
    const res = await preview()
      .attach('contactos', Buffer.from('Record ID,First Name\n1,José\n', 'latin1'), 'contactos.csv')
      .attach('negocios', DEALS, 'negocios.csv')

    expect(res.status).toBe(422)
    expect(res.body).toEqual({
      code: 'CRM_IMPORT_ARCHIVO_INVALIDO',
      message: 'El archivo de contactos no está en UTF-8: guárdalo como «CSV UTF-8» o expórtalo de nuevo desde HubSpot',
    })
  })

  it('un_utf8_con_un_signo_de_reemplazo_de_verdad_si_se_lee', async () => {
    // A «�» that HubSpot already had in a name is valid UTF-8: it must not block the whole import.
    prismaMock.crmStage.findMany.mockResolvedValue([{ id: 'cstageprs0000000000000001', name: 'Prospecto', order: 1, kind: 'ABIERTA' }])
    prismaMock.crmLostReason.findMany.mockResolvedValue([])
    prismaMock.crmStage.findFirst.mockResolvedValue({ id: 'cstageprs0000000000000001', name: 'Prospecto' })
    prismaMock.crmAccount.findMany.mockResolvedValue([])
    prismaMock.crmContact.groupBy.mockResolvedValue([])

    const res = await preview()
      .attach('contactos', Buffer.from('Record ID,First Name\n1,Jos\uFFFD\n', 'utf8'), 'contactos.csv')
      .attach('negocios', DEALS, 'negocios.csv')

    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ nuevos: 1, archivados: 1 })
  })

  describe('la casilla «Aceptaron recibir correos»', () => {
    const apply = () =>
      request(appWithErrors).post('/crm/import/hubspot/apply').attach('contactos', DEALS, 'c.csv').attach('negocios', DEALS, 'n.csv')
    const applied = { aplicados: 0 } as never

    it('aceptaronCorreos=true llega al servicio', async () => {
      const spy = jest.spyOn(hubspotImport, 'applyHubspot').mockResolvedValue(applied)
      const res = await apply().field('aceptaronCorreos', 'true')
      expect(res.status).toBe(200)
      expect(spy).toHaveBeenCalledWith(expect.anything(), expect.any(String), expect.any(String), { aceptaronCorreos: true })
      spy.mockRestore()
    })

    it('sin el campo (o con false) es como hoy: sin casilla', async () => {
      const spy = jest.spyOn(hubspotImport, 'applyHubspot').mockResolvedValue(applied)
      await apply()
      await apply().field('aceptaronCorreos', 'false')
      expect(spy.mock.calls.map(call => call[3])).toEqual([{ aceptaronCorreos: false }, { aceptaronCorreos: false }])
      spy.mockRestore()
    })

    it('aceptaronCorreos=quiza es 422 y no importa nada', async () => {
      const spy = jest.spyOn(hubspotImport, 'applyHubspot').mockResolvedValue(applied)
      const res = await apply().field('aceptaronCorreos', 'quiza')
      expect(res.status).toBe(422)
      expect(res.body).toEqual({ code: 'CRM_IMPORT_ARCHIVO_INVALIDO', message: 'La casilla de los correos no es válida' })
      expect(spy).not.toHaveBeenCalled()
      spy.mockRestore()
    })

    it('dos campos de texto es 422 como hoy', async () => {
      const res = await apply().field('aceptaronCorreos', 'true').field('otro', 'x')
      expect(res.status).toBe(422)
      expect(res.body.code).toBe('CRM_IMPORT_ARCHIVO_INVALIDO')
    })
  })

  it('sin_configurar_es_403 (L7)', async () => {
    // A seller who sees and edits every account, but does not configure the CRM.
    prismaMock.platformAccess.findUnique.mockResolvedValue({
      id: 'caccessrw0000000000000009',
      staffId: ADMIN_ID,
      verScope: 'todos',
      editarScope: 'todos',
      contactar: true,
      campanas: false,
      exportar: false,
      ventas: false,
      admin: false,
    })

    for (const path of ['/crm/import/hubspot/preview', '/crm/import/hubspot/apply']) {
      const res = await request(appWithErrors)
        .post(path)
        .attach('contactos', DEALS, 'contactos.csv')
        .attach('negocios', DEALS, 'negocios.csv')
      expect(res.status).toBe(403)
      expect(res.body).toMatchObject({ code: 'CRM_FORBIDDEN' })
    }
  })
})

describe('clientes, datos vivos, reportes y exportar (tarea 9)', () => {
  it('exportar_pide_su_propia_llave', async () => {
    // Sees and edits every account, but without «Exportar».
    prismaMock.platformAccess.findUnique.mockResolvedValue({
      id: 'caccessrw0000000000000009',
      staffId: ADMIN_ID,
      verScope: 'todos',
      editarScope: 'todos',
      contactar: true,
      campanas: false,
      exportar: false,
      ventas: false,
      admin: false,
    })

    const res = await request(app).get('/crm/export.csv')
    expect(res.status).toBe(403)
    expect(res.body).toMatchObject({ code: 'CRM_FORBIDDEN', message: 'No tienes la llave «Exportar»' })
    expect(prismaMock.crmAccount.findMany).not.toHaveBeenCalled()
  })

  it('sin_ver_negocios_no_hay_clientes_ni_ficha_ni_reportes', async () => {
    // The admin of the team from `beforeEach`: «Administrar» on, «Ver negocios» off.
    for (const path of [
      '/crm/clients',
      '/crm/accounts/caccounta0000000000000001/live',
      // Ruling 47: a client's live data by Organization asks for «Ver» too.
      '/crm/clients/corgclient000000000000001/live',
      '/crm/reports?desde=2026-10-01&hasta=2026-10-31',
    ]) {
      const res = await request(app).get(path)
      expect(res.status).toBe(403)
      expect(res.body).toMatchObject({ code: 'CRM_FORBIDDEN' })
    }
  })

  it('C1: los filtros nuevos piden «Ver»; con ella, 200 y meta.legible = 1; un valor que no existe es 400', async () => {
    // The admin of the team from `beforeEach`: «Ver negocios» off.
    const forbidden = await request(app).get('/crm/clients?usa=POS')
    expect(forbidden.status).toBe(403)
    expect(forbidden.body).toMatchObject({ code: 'CRM_FORBIDDEN' })

    prismaMock.platformAccess.findUnique.mockResolvedValue({
      id: 'caccessrw0000000000000009',
      staffId: ADMIN_ID,
      verScope: 'propios',
      editarScope: null,
      contactar: false,
      campanas: false,
      exportar: false,
      ventas: false,
      admin: false,
      ...SIN_FINAS,
    })
    prismaMock.$queryRaw.mockReset()
    prismaMock.$queryRaw.mockImplementation(async (query: { sql: string }) =>
      query.sql.includes('AS "altaSinTarjeta"') ? [{ altaSinTarjeta: 0 }] : query.sql.includes('AS "total"') ? [{ total: 0 }] : [],
    )

    const ok = await request(appWithErrors).get('/crm/clients?usa=POS&nivel=PRO&estado=COBRA&dueno=MIOS&motivo=SIN_MOTIVO&altas=true')
    expect(ok.status).toBe(200)
    expect(ok.body.meta).toMatchObject({ total: 0, nextCursor: null, legible: 1, conteos: { altaSinTarjeta: 0 } })
    for (const query of ['usa=AVISO', 'motivo=SIN_MOTIVO', 'condicion=PAGADO']) {
      expect((await request(appWithErrors).get(`/crm/clients?${query}`)).status).toBe(200)
    }

    for (const query of ['usa=OTRA', 'nivel=ENTERPRISE', 'estado=OTRO', 'motivo=CARO']) {
      const bad = await request(appWithErrors).get(`/crm/clients?${query}`)
      expect(bad.status).toBe(400)
      expect(bad.body.message).toContain('Ese filtro no existe')
    }
    const badOwner = await request(appWithErrors).get('/crm/clients?dueno=a%20b')
    expect(badOwner.status).toBe(400)
    expect(badOwner.body.message).toContain('El dueño no es válido')

    // Their own id is «Míos».
    expect((await request(appWithErrors).get(`/crm/clients?dueno=${ADMIN_ID}`)).status).toBe(200)

    // A «propios» seller filtering by somebody else.
    const otro = await request(appWithErrors).get('/crm/clients?dueno=cstaffoth0000000000000001')
    expect(otro.status).toBe(400)
    expect(otro.body).toMatchObject({ code: 'CRM_FILTRO_DE_DUENO', message: 'Con «Ver: propios» sólo puedes filtrar «Míos» o «Sin dueño»' })
  })

  it('ocultar_y_regresar_piden_configurar (L7)', async () => {
    const ORG = 'corgprime0000000000000001'
    prismaMock.organization.findUnique.mockResolvedValue({ id: ORG, name: 'Grupo de pruebas' })
    prismaMock.crmHiddenClient.createMany.mockResolvedValue({ count: 1 })
    prismaMock.crmHiddenClient.deleteMany.mockResolvedValue({ count: 1 })

    // The admin of the team from `beforeEach` («Configurar el CRM» on, L2), even without «Ver negocios».
    const hidden = await request(app).post(`/crm/clients/${ORG}/hide`)
    expect(hidden.status).toBe(200)
    expect(hidden.body.data).toEqual({ organizationId: ORG, oculta: true })
    const shown = await request(app).post(`/crm/clients/${ORG}/unhide`)
    expect(shown.status).toBe(200)
    expect(shown.body.data).toEqual({ organizationId: ORG, oculta: false })

    // A seller who sees and edits everything, without «Configurar el CRM».
    prismaMock.platformAccess.findUnique.mockResolvedValue({
      id: 'caccessrw0000000000000009',
      staffId: ADMIN_ID,
      verScope: 'todos',
      editarScope: 'todos',
      contactar: true,
      campanas: false,
      exportar: true,
      ventas: true,
      admin: false,
    })
    prismaMock.crmHiddenClient.createMany.mockClear()
    for (const action of ['hide', 'unhide']) {
      const res = await request(app).post(`/crm/clients/${ORG}/${action}`)
      expect(res.status).toBe(403)
      expect(res.body).toMatchObject({ code: 'CRM_FORBIDDEN' })
    }
    expect(prismaMock.crmHiddenClient.createMany).not.toHaveBeenCalled()
  })
})

describe('POST /crm/clients/:organizationId/cuenta (C1, tarea 6)', () => {
  const PATH = '/crm/clients/corgclient000000000000001/cuenta'
  const access = (over: Record<string, unknown>) =>
    prismaMock.platformAccess.findUnique.mockResolvedValue({
      id: 'caccessrw0000000000000009',
      staffId: ADMIN_ID,
      verScope: 'todos',
      editarScope: null,
      contactar: false,
      campanas: false,
      exportar: false,
      ventas: false,
      admin: false,
      ...SIN_FINAS,
      ...over,
    })

  it('🔴 sin «Editar» → 403; con «Ver» y sin «Editar» → 403; con «Editar: propios» → 200', async () => {
    // The admin of the team from `beforeEach`: no «Editar».
    expect((await request(app).post(PATH)).status).toBe(403)
    access({ verScope: 'propios', editarScope: null })
    const ver = await request(app).post(PATH)
    expect(ver.status).toBe(403)
    expect(ver.body).toMatchObject({ code: 'CRM_FORBIDDEN' })
    expect(prismaMock.crmAccount.createMany).not.toHaveBeenCalled()

    access({ verScope: 'propios', editarScope: 'propios' })
    prismaMock.$queryRaw.mockReset()
    prismaMock.$queryRaw.mockImplementation(async (query: { sql: string }) =>
      query.sql.includes('AS "esCliente"') ? [{ id: 'corgclient000000000000001', name: 'Tacos', esCliente: true }] : [],
    )
    prismaMock.crmStage.count.mockResolvedValue(1)
    prismaMock.crmLostReason.count.mockResolvedValue(1)
    prismaMock.crmStage.findFirst.mockResolvedValue({ id: 'cstagegana000000000000001' })
    prismaMock.crmAccount.createMany.mockResolvedValue({ count: 0 })
    prismaMock.crmAccount.findFirst.mockResolvedValue({ id: 'caccounta0000000000000001' })
    const ok = await request(appWithErrors).post(PATH)
    expect(ok.status).toBe(200)
    expect(ok.body.data).toEqual({ accountId: 'caccounta0000000000000001', creada: false })
  })
})

describe('reagendar (ruling 55)', () => {
  it('reagendar_pide_editar_y_una_fecha_valida', async () => {
    // The admin of the team from `beforeEach`: «Administrar», without «Editar negocios».
    const forbidden = await request(app)
      .post('/crm/activities/cactivity0000000000000001/reschedule')
      .send({ dueAt: '2026-11-07T17:00:00.000Z' })
    expect(forbidden.status).toBe(403)
    expect(forbidden.body).toMatchObject({ code: 'CRM_FORBIDDEN' })

    // A seller who edits their own: the date is checked before anything is read.
    prismaMock.platformAccess.findUnique.mockResolvedValue({
      id: 'caccessrw0000000000000009',
      staffId: ADMIN_ID,
      verScope: 'propios',
      editarScope: 'propios',
      contactar: false,
      campanas: false,
      exportar: false,
      ventas: false,
      admin: false,
    })
    const invalid = await request(appWithErrors).post('/crm/activities/cactivity0000000000000001/reschedule').send({ dueAt: 'el viernes' })
    expect(invalid.status).toBe(400)
  })
})

describe('cambiar llaves con expectedKeys (ruling 60)', () => {
  // A JSON body and the error handler: `appWithErrors` has no body parser of its own.
  const jsonApp = express().use(express.json()).use(appWithErrors)

  it('patch_team_lleva_expectedKeys_hasta_el_servicio_y_responde_409', async () => {
    // Carla, as stored: a default seller. The screen saw her with «Mandar correo» off, but someone turned it on since.
    const carla = {
      id: 'caccessrw0000000000000001',
      email: 'carla@avoqado.io',
      staffId: 'cstaffsel0000000000000001',
      verScope: 'propios',
      editarScope: 'propios',
      contactar: true,
      campanas: false,
      exportar: false,
      ventas: false,
      admin: false,
      ...SIN_FINAS,
      cerrar: true,
      active: true,
    }
    prismaMock.platformAccess.findFirst.mockResolvedValue(carla)
    // Las 13 de la pantalla nueva (L10).
    const keys = { ver: 'propios', editar: 'propios', contactar: false, exportar: false, ventas: false, ...SIN_FINAS, cerrar: true }

    const stale = await request(jsonApp)
      .patch(`/crm/team/${carla.id}`)
      .send({ keys, expectedKeys: { ...keys, contactar: false } })
    expect(stale.status).toBe(409)
    expect(stale.body).toEqual({ code: 'CRM_LLAVES_CAMBIARON', message: 'Alguien más cambió sus llaves' })
    expect(prismaMock.platformAccess.updateManyAndReturn).not.toHaveBeenCalled()
    expect(prismaMock.platformAccess.update).not.toHaveBeenCalled()

    // Without `expectedKeys`, as today: the change is written.
    prismaMock.platformAccess.update.mockImplementation(async ({ data }: any) => ({ ...carla, ...data }))
    const asToday = await request(jsonApp).patch(`/crm/team/${carla.id}`).send({ keys })
    expect(asToday.status).toBe(200)
    expect(asToday.body.data.keys).toMatchObject({ contactar: false })
  })
})

describe('la pantalla vieja del equipo recibe 409 y no escribe nada (L10)', () => {
  const jsonApp = express().use(express.json()).use(appWithErrors)
  const VIEJA_7 = { ver: 'propios', editar: 'propios', contactar: true, campanas: false, exportar: false, ventas: false, admin: false }
  const NUEVA = { ver: 'propios', editar: 'propios', contactar: true, exportar: false, ventas: false, ...SIN_FINAS, cerrar: true }
  const recarga = { code: 'CRM_LLAVES_PANTALLA_VIEJA', message: 'El editor de llaves cambió. Recarga la página y vuelve a intentarlo.' }

  it('agregar_con_la_forma_vieja_es_409', async () => {
    // Los 7 campos de la pantalla vieja, y los 15 que copió de la respuesta nueva.
    for (const keys of [VIEJA_7, { ...NUEVA, campanas: false, admin: false }]) {
      const res = await request(jsonApp).post('/crm/team').send({ email: 'ana@avoqado.io', firstName: 'Ana', lastName: 'López', keys })
      expect(res.status).toBe(409)
      expect(res.body).toEqual(recarga)
    }
    expect(prismaMock.platformAccess.upsert).not.toHaveBeenCalled()
  })

  it('cambiar_con_la_forma_vieja_es_409', async () => {
    const ID = 'caccessrw0000000000000001'
    for (const body of [
      { keys: VIEJA_7, expectedKeys: VIEJA_7 },
      { keys: { ...NUEVA, campanas: false, admin: false } },
      { keys: NUEVA, expectedKeys: { ...NUEVA, admin: false } },
    ]) {
      const res = await request(jsonApp).patch(`/crm/team/${ID}`).send(body)
      expect(res.status).toBe(409)
      expect(res.body).toEqual(recarga)
    }
    expect(prismaMock.platformAccess.findFirst).not.toHaveBeenCalled()
    expect(prismaMock.platformAccess.update).not.toHaveBeenCalled()
    expect(prismaMock.platformAccess.updateManyAndReturn).not.toHaveBeenCalled()
  })
})

describe('GET /crm/me con las llaves finas', () => {
  it('solo_plantillas_trae_el_espejo_apagado_y_las_8_nuevas', async () => {
    prismaMock.platformAccess.findUnique.mockResolvedValue({
      id: 'caccessrw0000000000000009',
      staffId: ADMIN_ID,
      verScope: null,
      editarScope: null,
      contactar: false,
      campanas: false,
      exportar: false,
      ventas: false,
      admin: false,
      ...SIN_FINAS,
      plantillas: true,
    })

    const res = await request(app).get('/crm/me')

    expect(res.status).toBe(200)
    // `campanas` y `admin` siguen en la respuesta (la pantalla vieja los lee), con el espejo de L11: sólo con las 4.
    expect(res.body.data).toEqual({
      staffId: ADMIN_ID,
      isSuperadmin: false,
      ver: null,
      editar: null,
      contactar: false,
      exportar: false,
      ventas: false,
      ...SIN_FINAS,
      plantillas: true,
      campanas: false,
      admin: false,
    })
  })
})

describe('POST /crm/accounts/:id/usa (C1, tarea 7)', () => {
  const PATH = '/crm/accounts/caccounta0000000000000001/usa'
  const access = (over: Record<string, unknown>) =>
    prismaMock.platformAccess.findUnique.mockResolvedValue({
      id: 'caccessrw0000000000000009',
      staffId: ADMIN_ID,
      verScope: 'todos',
      editarScope: null,
      contactar: false,
      campanas: false,
      exportar: false,
      ventas: false,
      admin: false,
      ...SIN_FINAS,
      ...over,
    })

  it('🔴 sin «Editar» → 403 y no escribe; con «Editar» → 200', async () => {
    access({ verScope: 'propios', editarScope: null })
    const sin = await request(app).post(PATH).send({ valor: null })
    expect(sin.status).toBe(403)
    expect(prismaMock.crmAccount.update).not.toHaveBeenCalled()

    access({ verScope: 'propios', editarScope: 'propios' })
    prismaMock.crmAccount.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.crmAccount.findFirst.mockResolvedValue({ id: 'caccounta0000000000000001' })
    prismaMock.crmAccount.findUniqueOrThrow.mockResolvedValue({ usaManual: 'POS', organizationId: 'corgclient000000000000001' })
    prismaMock.crmTimelineEvent.createMany.mockResolvedValue({ count: 1 })
    // `appWithErrors` has no body parser: this one sends JSON, so it goes through `app` and reads the 200 as is.
    const ok = await request(app).post(PATH).send({ valor: null })
    expect(ok.status).toBe(200)
    expect(ok.body.data).toEqual({ accountId: 'caccounta0000000000000001', usaManual: null })
  })
})

describe('POST /crm/accounts/:id/alta (C1, tarea 8)', () => {
  const PATH = '/crm/accounts/caccounta0000000000000001/alta'
  const access = (over: Record<string, unknown>) =>
    prismaMock.platformAccess.findUnique.mockResolvedValue({
      id: 'caccessrw0000000000000009',
      staffId: ADMIN_ID,
      verScope: 'todos',
      editarScope: null,
      contactar: false,
      campanas: false,
      exportar: false,
      ventas: false,
      admin: false,
      ...SIN_FINAS,
      ...over,
    })

  it('🔴 sin «Editar» → 403 y no escribe; con «Editar» → 200', async () => {
    access({ verScope: 'propios', editarScope: null })
    const sin = await request(app).post(PATH).send({ motivo: 'PRECIO', perdido: false })
    expect(sin.status).toBe(403)
    expect(prismaMock.crmAccount.update).not.toHaveBeenCalled()

    access({ verScope: 'propios', editarScope: 'propios' })
    prismaMock.crmAccount.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.crmAccount.findFirst.mockResolvedValue({ id: 'caccounta0000000000000001' })
    prismaMock.crmAccount.findUniqueOrThrow.mockResolvedValue({
      altaMotivo: 'PRECIO',
      altaMotivoTexto: null,
      altaPerdido: false,
      organizationId: 'corgclient000000000000001',
    })
    prismaMock.$queryRaw.mockResolvedValue([{ pendiente: 1 }])
    const ok = await request(app).post(PATH).send({ motivo: 'PRECIO', perdido: false })
    expect(ok.status).toBe(200)
    expect(ok.body.data).toEqual({ accountId: 'caccounta0000000000000001', motivo: 'PRECIO', texto: null, perdido: false })
  })
})

describe('C2 · ficha editable: las rutas piden «Editar» (o «Ver») antes de llamar al servicio', () => {
  const ACCOUNT = 'caccounta0000000000000001'
  const access = (over: Record<string, unknown>) =>
    prismaMock.platformAccess.findUnique.mockResolvedValue({
      id: 'caccessrw0000000000000009',
      staffId: ADMIN_ID,
      verScope: 'todos',
      editarScope: null,
      contactar: false,
      campanas: false,
      exportar: false,
      ventas: false,
      admin: false,
      ...SIN_FINAS,
      ...over,
    })
  const spies: jest.SpyInstance[] = []
  const espiar = (nombre: keyof typeof fichaService, valor: unknown) => {
    const spy = jest.spyOn(fichaService, nombre as any).mockResolvedValue(valor as never)
    spies.push(spy)
    return spy
  }
  afterEach(() => spies.splice(0).forEach(spy => spy.mockRestore()))

  describe('PATCH /crm/accounts/:id', () => {
    const body = { cambios: { giro: 'Bar' }, vio: { giro: 'Cafetería' } }

    it('🔴 sin «Editar» → 403; con «Ver» sin «Editar» → 403; el servicio no se llama', async () => {
      const spy = espiar('updateAccount', { accountId: ACCOUNT, cambiados: ['giro'] })
      access({ verScope: null, editarScope: null })
      expect((await request(app).patch(`/crm/accounts/${ACCOUNT}`).send(body)).status).toBe(403)
      access({ verScope: 'todos', editarScope: null })
      expect((await request(app).patch(`/crm/accounts/${ACCOUNT}`).send(body)).status).toBe(403)
      expect(spy).not.toHaveBeenCalled()
    })

    it('con «Editar: propios» → 200 y llama al servicio con el cuerpo', async () => {
      const spy = espiar('updateAccount', { accountId: ACCOUNT, cambiados: ['giro'] })
      access({ verScope: 'propios', editarScope: 'propios' })
      const res = await request(app).patch(`/crm/accounts/${ACCOUNT}`).send(body)
      expect(res.status).toBe(200)
      expect(res.body.data).toEqual({ accountId: ACCOUNT, cambiados: ['giro'] })
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ staffId: ADMIN_ID, editar: 'propios' }), ACCOUNT, body)
    })
  })

  describe('POST /crm/accounts/:id/contacts', () => {
    const body = { name: 'Ana', email: 'ana@cafe.mx', clientRequestId: '11111111-1111-4111-8111-111111111111' }

    it('🔴 sin «Editar» → 403 y el servicio no se llama; con «Editar» → 201', async () => {
      const spy = espiar('addContact', {
        contactId: 'ccontact00000000000000001',
        permisoDelCorreo: false,
        consentimientoRegistrado: false,
        repetido: false,
      })
      access({ verScope: 'todos', editarScope: null })
      expect((await request(app).post(`/crm/accounts/${ACCOUNT}/contacts`).send(body)).status).toBe(403)
      expect(spy).not.toHaveBeenCalled()
      access({ verScope: 'propios', editarScope: 'propios' })
      const res = await request(app).post(`/crm/accounts/${ACCOUNT}/contacts`).send(body)
      expect(res.status).toBe(201)
      expect(spy).toHaveBeenCalledWith(expect.anything(), ACCOUNT, body)
    })

    it('🔴 clientRequestId «ana@ejemplo.mx» o cualquier no-UUID → 400; la casilla sin correo → 400', async () => {
      const spy = espiar('addContact', {})
      access({ verScope: 'todos', editarScope: 'todos' })
      for (const malo of [
        { ...body, clientRequestId: 'ana@ejemplo.mx' },
        { ...body, clientRequestId: undefined },
      ]) {
        expect((await request(app).post(`/crm/accounts/${ACCOUNT}/contacts`).send(malo)).status).toBe(400)
      }
      const sinCorreo = await request(app)
        .post(`/crm/accounts/${ACCOUNT}/contacts`)
        .send({ name: 'Ana', aceptaCorreos: true, clientRequestId: body.clientRequestId })
      expect(sinCorreo.status).toBe(400)
      expect(spy).not.toHaveBeenCalled()
    })
  })

  describe('PATCH /crm/accounts/:id/contacts/:contactId y POST …/remove', () => {
    const CONTACT = 'ccontacta0000000000000001'
    const vio = { name: 'Ana', phoneE164: null, email: 'ana@cafe.mx', role: null, isPrimary: true }

    it('🔴 las dos rutas sin «Editar» → 403 y el servicio no se llama', async () => {
      const cambiar = espiar('updateContact', {})
      const quitar = espiar('removeContact', {})
      access({ verScope: 'todos', editarScope: null })
      expect(
        (
          await request(app)
            .patch(`/crm/accounts/${ACCOUNT}/contacts/${CONTACT}`)
            .send({ cambios: { role: 'X' }, vio })
        ).status,
      ).toBe(403)
      expect((await request(app).post(`/crm/accounts/${ACCOUNT}/contacts/${CONTACT}/remove`).send({ vio })).status).toBe(403)
      expect(cambiar).not.toHaveBeenCalled()
      expect(quitar).not.toHaveBeenCalled()
    })

    it('con «Editar» llegan al servicio; cambios vacío sin casilla → 400 «Di qué cambias»; con la casilla sola, sí', async () => {
      const cambiar = espiar('updateContact', { contactId: CONTACT, cambiados: [] })
      const quitar = espiar('removeContact', { contactId: CONTACT, yaNoEstaba: false })
      access({ verScope: 'todos', editarScope: 'todos' })
      expect((await request(app).patch(`/crm/accounts/${ACCOUNT}/contacts/${CONTACT}`).send({ cambios: {}, vio })).status).toBe(400)
      const casilla = await request(app)
        .patch(`/crm/accounts/${ACCOUNT}/contacts/${CONTACT}`)
        .send({ cambios: {}, vio, aceptaCorreos: true })
      expect(casilla.status).toBe(200)
      expect(cambiar).toHaveBeenCalledWith(expect.anything(), ACCOUNT, CONTACT, { cambios: {}, vio, aceptaCorreos: true })
      const fijo = await request(app)
        .patch(`/crm/accounts/${ACCOUNT}/contacts/${CONTACT}`)
        .send({ cambios: { accountId: 'x' }, vio })
      expect(fijo.status).toBe(400)
      expect((await request(app).post(`/crm/accounts/${ACCOUNT}/contacts/${CONTACT}/remove`).send({ vio })).status).toBe(200)
      expect(quitar).toHaveBeenCalledWith(expect.anything(), ACCOUNT, CONTACT, { vio })
    })
  })
})
