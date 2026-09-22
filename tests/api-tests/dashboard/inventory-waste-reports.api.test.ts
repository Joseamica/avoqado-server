/*
  tests/api-tests/dashboard/inventory-waste-reports.api.test.ts

  GET /api/v1/dashboard/venues/:venueId/inventory/waste-reports — la lista paginada de folios de
  merma que va a consumir el dashboard (spec §4.6: «las declaraciones sin movimientos se ven aquí»).
  Express real + supertest; el lector se mockea (su SQL lo cubre la integración contra Postgres):
  aquí se prueba el CONTRATO HTTP — candados, query y códigos de error.

  Middleware real: authenticateTokenMiddleware → checkFeatureAccess('INVENTORY_TRACKING') (todo el
  router de inventario) → checkPermission('inventory:read') → controlador.

  🔴 UN SOLO candado de permiso (Ruling 19). El controlador NO re-evalúa el permiso con
  `requireWastePermission`: `checkPermission` respeta el PIN de gerente (`X-Permission-Override`,
  token de UN solo uso) y una segunda evaluación que no lo conoce contestaría 403 con el PIN ya
  gastado — el defecto que la tarea 8 cerró en `/mobile`. El mock de abajo lo rechaza siempre: si
  alguien vuelve a llamarlo desde este controlador, estas pruebas se ponen rojas.

  Hechos de permisos (src/lib/permissions.ts, medidos con hasPermission): `inventory:read` lo traen
  OWNER, ADMIN, MANAGER, CASHIER, WAITER y KITCHEN (los tres últimos por la dependencia de
  `orders:create`); HOST y VIEWER no lo traen.
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

import jwt from 'jsonwebtoken'
import request from 'supertest'
import { prismaMock } from '@tests/__helpers__/setup'
import { mirrorTokenRoleOnStaffVenue } from '@tests/__helpers__/venueRoleMock'
import { ForbiddenError } from '../../../src/errors/AppError'

const requireWastePermission = jest.fn()
jest.mock('../../../src/services/shared/inventoryWaste.service', () => ({
  ...jest.requireActual('../../../src/services/shared/inventoryWaste.service'),
  requireWastePermission: (...a: unknown[]) => requireWastePermission(...a),
}))
const listWasteReports = jest.fn()
jest.mock('../../../src/services/shared/inventoryWasteRead.service', () => ({
  ...jest.requireActual('../../../src/services/shared/inventoryWasteRead.service'),
  listWasteReports: (...a: unknown[]) => listWasteReports(...a),
}))

const app = require('../../../src/app').default

const venueId = 'clvenuewastereports00001'
const otherVenueId = 'clvenuewastereports00002'
const RUTA = `/api/v1/dashboard/venues/${venueId}/inventory/waste-reports`
const CONCESION = {
  id: 'vf-inv-1',
  active: true,
  endDate: null,
  suspendedAt: null,
  stripeSubscriptionId: null,
  feature: { code: 'INVENTORY_TRACKING', name: 'Inventario' },
}

/** Lo que devuelve el lector real: `{ items, total, page, pageSize }`, Decimals como texto en JSON. */
const FOLIO = {
  id: 'clwastereport00000000001',
  itemType: 'RAW_MATERIAL',
  rawMaterialId: 'clrawmaterial00000000001',
  productId: null,
  unit: 'KILOGRAM',
  reasonCode: 'EXPIRED',
  declaredQuantity: '5',
  deductedQuantity: '3',
  unrecordedQuantity: '2',
  costImpact: '8',
  costState: 'PARTIAL',
  unitCostSnapshot: null,
  note: null,
  reference: null,
  supplier: null,
  source: 'POS',
  createdAt: '2026-09-21T19:05:00.000Z',
  clientOccurredAt: null,
  reportedByStaffId: 'user_test',
  reportedByStaff: { firstName: 'Ana', lastName: 'López' },
  rawMaterial: { name: 'Aguacate', sku: 'AGU-1' },
  product: null,
}
const PAGINA = { items: [FOLIO], total: 1, page: 1, pageSize: 100 }

const OVERRIDE = 'tok-override-folios-0001'

/** Un mensaje de Zod sin traducir se reconoce por estas palabras. */
const INGLES = /\b(Invalid|Expected|Required|Unrecognized|received|String must|Number must|must contain|characters?)\b/

function token(role: string, tokenVenueId: string = venueId) {
  mirrorTokenRoleOnStaffVenue(role, tokenVenueId)
  return jwt.sign({ sub: 'user_test', orgId: 'org_test', venueId: tokenVenueId, role }, process.env.ACCESS_TOKEN_SECRET as string, {
    expiresIn: '15m',
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.staffVenue.findFirst.mockResolvedValue(null)
  prismaMock.staffVenue.findUnique.mockResolvedValue(null)
  prismaMock.venue.findUnique.mockResolvedValue(null)
  prismaMock.staffOrganization.findUnique.mockResolvedValue(null)
  prismaMock.venueRolePermission.findUnique.mockResolvedValue(null)
  prismaMock.venueFeature.findFirst.mockResolvedValue(CONCESION as never)
  prismaMock.venueSettings.findUnique.mockResolvedValue(null)
  prismaMock.permissionOverride.updateMany.mockResolvedValue({ count: 0 })
  prismaMock.permissionOverride.findUnique.mockResolvedValue(null)
  requireWastePermission.mockRejectedValue(
    new ForbiddenError('No tienes permiso para esta operación de inventario.', 'WASTE_PERMISSION_DENIED'),
  )
  listWasteReports.mockResolvedValue(PAGINA)
})

describe('GET …/dashboard/venues/:venueId/inventory/waste-reports', () => {
  it('401 sin credencial', async () => {
    const res = await request(app).get(RUTA)
    expect(res.status).toBe(401)
    expect(listWasteReports).not.toHaveBeenCalled()
  })

  it.each(['OWNER', 'ADMIN', 'MANAGER', 'CASHIER'])(
    '200 para %s con la forma del contrato { items, total, page, pageSize }',
    async role => {
      const res = await request(app)
        .get(RUTA)
        .set('Authorization', `Bearer ${token(role)}`)
      expect(res.status).toBe(200)
      expect(res.body).toEqual(PAGINA)
      expect(Object.keys(res.body).sort()).toEqual(['items', 'page', 'pageSize', 'total'])
      // Sin query: primera página de 100, sin filtros.
      expect(listWasteReports).toHaveBeenCalledWith(venueId, { page: 1, pageSize: 100 })
      // 🔴 Ruling 19: el permiso lo decide SÓLO checkPermission.
      expect(requireWastePermission).not.toHaveBeenCalled()
    },
  )

  it.each(['HOST', 'VIEWER'])('🔴 403 real para %s (sin inventory:read) y el lector ni se toca', async role => {
    const res = await request(app)
      .get(RUTA)
      .set('Authorization', `Bearer ${token(role)}`)
    expect(res.status).toBe(403)
    expect(res.body).toHaveProperty('required', 'inventory:read')
    expect(listWasteReports).not.toHaveBeenCalled()
  })

  it('🔴 403 de plan con featureCode cuando el venue no tiene INVENTORY_TRACKING', async () => {
    prismaMock.venueFeature.findFirst.mockResolvedValue(null)
    const res = await request(app)
      .get(RUTA)
      .set('Authorization', `Bearer ${token('OWNER')}`)
    expect(res.status).toBe(403)
    expect(res.body.featureCode).toBe('INVENTORY_TRACKING')
    expect(listWasteReports).not.toHaveBeenCalled()
  })

  it('🔴 aislamiento: un token de OTRO venue recibe 403 y no lee folios de éste', async () => {
    const res = await request(app)
      .get(RUTA)
      .set('Authorization', `Bearer ${token('OWNER', otherVenueId)}`)
    expect(res.status).toBe(403)
    expect(listWasteReports).not.toHaveBeenCalled()
  })

  it('🔴 el venue de la URL manda: el dueño de la organización lee ESTE venue aunque su token traiga otro', async () => {
    const ownerToken = jwt.sign(
      { sub: 'user_test', orgId: 'org_test', venueId: otherVenueId, role: 'OWNER' },
      process.env.ACCESS_TOKEN_SECRET as string,
      { expiresIn: '15m' },
    )
    prismaMock.venue.findUnique.mockResolvedValue({ organizationId: 'org_test' } as never)
    prismaMock.staffOrganization.findUnique.mockResolvedValue({ role: 'OWNER', isActive: true } as never)
    const res = await request(app).get(RUTA).set('Authorization', `Bearer ${ownerToken}`)
    expect(res.status).toBe(200)
    expect(listWasteReports).toHaveBeenCalledTimes(1)
    expect(listWasteReports.mock.calls[0][0]).toBe(venueId)
  })

  it('pasa página, búsqueda y fechas ISO con zona tal cual al lector', async () => {
    const res = await request(app)
      .get(RUTA)
      .query({
        page: '2',
        pageSize: '25',
        search: 'aguacate',
        startDate: '2026-09-01T00:00:00-06:00',
        endDate: '2026-09-21T23:59:59.999-06:00',
      })
      .set('Authorization', `Bearer ${token('MANAGER')}`)
    expect(res.status).toBe(200)
    expect(listWasteReports).toHaveBeenCalledWith(venueId, {
      page: 2,
      pageSize: 25,
      search: 'aguacate',
      startDate: '2026-09-01T00:00:00-06:00',
      endDate: '2026-09-21T23:59:59.999-06:00',
    })
  })

  it('🔴 un pageSize hostil se RECORTA a 200, nunca se obedece', async () => {
    const res = await request(app)
      .get(RUTA)
      .query({ pageSize: '100000' })
      .set('Authorization', `Bearer ${token('MANAGER')}`)
    expect(res.status).toBe(200)
    expect(listWasteReports).toHaveBeenCalledWith(venueId, expect.objectContaining({ pageSize: 200 }))
  })

  it.each([
    ['fecha pelona', { startDate: '2026-09-01' }],
    ['fecha con hora pero sin zona', { endDate: '2026-09-21T23:59:59' }],
    ['texto que no es fecha', { startDate: 'ayer' }],
    ['inicio después del final', { startDate: '2026-09-21T00:00:00Z', endDate: '2026-09-01T00:00:00Z' }],
    ['página cero', { page: '0' }],
    ['página no numérica', { page: 'uno' }],
  ])('🔴 422 INVALID_WASTE_PAYLOAD con %s, en español y sin tocar el lector', async (_caso, query) => {
    const res = await request(app)
      .get(RUTA)
      .query(query)
      .set('Authorization', `Bearer ${token('MANAGER')}`)
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('INVALID_WASTE_PAYLOAD')
    expect(res.body.message).not.toMatch(INGLES)
    expect(listWasteReports).not.toHaveBeenCalled()
  })

  it('🔴 con el PIN de un gerente, un rol sin inventory:read lee la lista y el token se consume UNA vez', async () => {
    prismaMock.venueSettings.findUnique.mockResolvedValue({ managerPinOverrideEnabled: true } as never)
    let usado = false
    prismaMock.permissionOverride.updateMany.mockImplementation((async (args: any) => {
      const w = args?.where ?? {}
      if (usado || w.token !== OVERRIDE || w.venueId !== venueId || w.permission !== 'inventory:read') return { count: 0 }
      usado = true
      return { count: 1 }
    }) as never)
    prismaMock.permissionOverride.findUnique.mockResolvedValue({ authorizedById: 'sv_gerente' } as never)

    const res = await request(app)
      .get(RUTA)
      .set('Authorization', `Bearer ${token('HOST')}`)
      .set('X-Permission-Override', OVERRIDE)
    expect(res.status).toBe(200)
    expect(res.body).toEqual(PAGINA)
    expect(prismaMock.permissionOverride.updateMany).toHaveBeenCalledTimes(1)
    expect(requireWastePermission).not.toHaveBeenCalled()
  })
})
