/**
 * The CRM router with the REAL guard (`requireCrm` re-reading the keys from the — mocked — database): an admin who
 * manages the team but does not see the pipeline still reads and edits the stages and the lost reasons, and still does
 * not see a single account.
 */
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
