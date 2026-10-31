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
  ])
    fn.mockReset()
  // An admin of the team: «Administrar» on, «Ver negocios» off. Not a superadmin.
  prismaMock.staff.findUnique.mockResolvedValue({ email: 'admin@avoqado.io', active: true, emailVerified: true })
  prismaMock.staffVenue.findFirst.mockResolvedValue(null)
  prismaMock.platformAccess.findUnique.mockResolvedValue({
    id: 'caccessrw0000000000000009',
    staffId: ADMIN_ID,
    verScope: null,
    editarScope: null,
    contactar: false,
    campanas: false,
    exportar: false,
    ventas: false,
    admin: true,
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

  it('sin_crm_admin_es_403', async () => {
    // A seller who sees and edits every account, but does not administer the CRM.
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
