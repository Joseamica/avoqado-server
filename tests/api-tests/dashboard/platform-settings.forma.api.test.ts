/*
  Planes editables B1, Task 9 (Codex b1-r1 #4): la columna nueva `PlatformSettings.avisosDelAltaCorreos` (los destinatarios de
  los avisos internos) NO sale por la API vieja. El `GET` y el `PATCH` de /api/v1/dashboard/superadmin/platform-settings responden
  exactamente las cinco llaves de hoy, con el Express real y el servicio real sobre `prismaMock`.
*/

process.env.NODE_ENV = process.env.NODE_ENV || 'test'
process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'test-access-secret'
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret'
process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || 'test-cookie-secret'
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/testdb?schema=public'

jest.mock('../../../src/config/session', () => {
  const noop = (req: any, _res: any, next: any) => next()
  return { __esModule: true, default: noop }
})
jest.mock('../../../src/config/swagger', () => ({ __esModule: true, setupSwaggerUI: jest.fn() }))
jest.mock('../../../src/services/dashboard/activity-log.service', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }))

import jwt from 'jsonwebtoken'
import { api, startApiServer } from '@tests/__helpers__/apiServer'
import { prismaMock } from '@tests/__helpers__/setup'
import { mirrorTokenRoleOnStaffVenue, simularSuperadminReal } from '@tests/__helpers__/venueRoleMock'

const app = require('../../../src/app').default
startApiServer(() => app)

const RUTA = '/api/v1/dashboard/superadmin/platform-settings'
const VENUE = 'clvenuesoporte00000000001'
const LLAVES_DE_HOY = ['ecommercePlatformFeeBpsDefault', 'id', 'updatedAt', 'updatedById', 'vatRateBps']

const token = () => {
  mirrorTokenRoleOnStaffVenue('SUPERADMIN', VENUE)
  simularSuperadminReal(true)
  return jwt.sign(
    { sub: 'staff-soporte', orgId: 'org_test', venueId: VENUE, role: 'SUPERADMIN' },
    process.env.ACCESS_TOKEN_SECRET as string,
    {
      expiresIn: '15m',
    },
  )
}

// La fila COMPLETA, con la columna nueva llena: si el controlador la reenviara tal cual, saldría.
const FILA = {
  id: 'default',
  ecommercePlatformFeeBpsDefault: 100,
  vatRateBps: 1600,
  avisosDelAltaCorreos: ['ops@example.com'],
  updatedAt: new Date('2026-11-25T12:00:00Z'),
  updatedById: 'staff-soporte',
}

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.platformSettings.findUnique.mockResolvedValue(FILA)
  prismaMock.platformSettings.upsert.mockResolvedValue({ ...FILA, vatRateBps: 800 })
})

describe('/api/v1/dashboard/superadmin/platform-settings — la forma de hoy', () => {
  it('🔴 GET y PATCH /api/v1/dashboard/superadmin/platform-settings responden exactamente las llaves de hoy, sin avisosDelAltaCorreos', async () => {
    const leido = await api().get(RUTA).set('Authorization', `Bearer ${token()}`)
    expect(leido.status).toBe(200)
    expect(leido.body.success).toBe(true)
    expect(Object.keys(leido.body.data).sort()).toEqual(LLAVES_DE_HOY)
    expect(leido.body.data).toEqual({
      id: 'default',
      ecommercePlatformFeeBpsDefault: 100,
      vatRateBps: 1600,
      updatedAt: '2026-11-25T12:00:00.000Z',
      updatedById: 'staff-soporte',
    })

    const guardado = await api().patch(RUTA).set('Authorization', `Bearer ${token()}`).send({ vatRateBps: 800 })
    expect(guardado.status).toBe(200)
    expect(Object.keys(guardado.body.data).sort()).toEqual(LLAVES_DE_HOY)
    expect(guardado.body.data).toMatchObject({ vatRateBps: 800 })
    expect(guardado.body.data).not.toHaveProperty('avisosDelAltaCorreos')
  })

  it('el PATCH viejo no escribe la columna nueva aunque venga en el cuerpo', async () => {
    const res = await api()
      .patch(RUTA)
      .set('Authorization', `Bearer ${token()}`)
      .send({ vatRateBps: 800, avisosDelAltaCorreos: ['otro@example.com'] })
    expect(res.status).toBe(200)
    const llamada = prismaMock.platformSettings.upsert.mock.calls[0][0]
    expect(llamada.update).not.toHaveProperty('avisosDelAltaCorreos')
    expect(llamada.create).not.toHaveProperty('avisosDelAltaCorreos')
  })
})
