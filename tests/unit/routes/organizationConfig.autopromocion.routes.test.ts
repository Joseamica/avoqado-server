/**
 * Codex ronda 3, S1 (24-sep): un EXsuperadmin con token vigente que además es dueño de una organización
 * pasaba `requireOrgOwner` como OWNER, y el cambio de rol volvía a leer SUPERADMIN del TOKEN para decidir
 * qué roles podía asignar ⇒ se volvía a poner SUPERADMIN a sí mismo. El rol de quien asigna sale de la base.
 *
 * Aquí `rolVigente` es el REAL: la base (prismaMock) dice si la fila de superadmin sigue activa.
 */
import express from 'express'
import request from 'supertest'
import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: any, _res: any, next: any) => {
    const ctx = req.headers['x-test-auth-context']
    if (ctx) req.authContext = JSON.parse(ctx as string)
    next()
  },
}))

import organizationConfigRouter from '@/routes/dashboard/organizationConfig.routes'

const ORG = 'org-1'
const YO = 'ex-sa'
const tokenQueDiceSuperadmin = { userId: YO, orgId: ORG, venueId: 'v-1', role: 'SUPERADMIN' }

function app() {
  const a = express()
  a.use(express.json())
  a.use('/dashboard/organizations/:orgId', organizationConfigRouter)
  return a
}

beforeEach(() => {
  jest.clearAllMocks()
  // La base: YA NO tiene fila de superadmin; SÍ es dueño activo en la organización.
  prismaMock.staffVenue.findFirst.mockImplementation((({ where }: any) =>
    Promise.resolve(where?.role === 'SUPERADMIN' ? null : where?.role === 'OWNER' ? { id: 'sv-owner' } : null)) as any)
})

it('🔴 un exsuperadmin que es dueño NO puede volver a asignarse SUPERADMIN', async () => {
  const r = await request(app())
    .patch(`/dashboard/organizations/${ORG}/team/${YO}/role`)
    .set('x-test-auth-context', JSON.stringify(tokenQueDiceSuperadmin))
    .send({ role: 'SUPERADMIN' })
  expect(r.status).toBe(403)
  expect(prismaMock.staffVenue.updateMany).not.toHaveBeenCalled()
  expect(prismaMock.staffVenue.upsert).not.toHaveBeenCalled()
})
