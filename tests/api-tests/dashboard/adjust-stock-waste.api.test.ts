/*
  tests/api-tests/dashboard/adjust-stock-waste.api.test.ts

  Las dos rutas `adjust-stock` del dashboard tras la tarea 10: la merma (SPOILAGE/LOSS negativa) va
  al libro de merma por `adaptDashboardWaste`, y todo lo demás sigue por el servicio de siempre.
  Express real + supertest; los servicios se mockean (el SQL lo cubre la integración contra
  Postgres): aquí se prueba el CONTRATO HTTP — validación, candados, qué camino toma cada petición
  y la forma de la respuesta.

  Middleware real: authenticateTokenMiddleware → checkFeatureAccess('INVENTORY_TRACKING') (todo el
  router de inventario) → checkPermission('inventory:adjust') → validateRequest → controlador.

  🔴 UN SOLO candado de permiso (Rulings 18 y 20). El adaptador NO re-evalúa el permiso: si lo hiciera
  con `requireWastePermission`, un cajero autorizado con el PIN de gerente recibiría 403 DESPUÉS de
  que `checkPermission` ya gastó el token. El mock de abajo lo rechaza siempre: si alguien vuelve a
  llamarlo en este camino, estas pruebas se ponen rojas.

  Hechos de permisos (src/lib/permissions.ts): `inventory:adjust` lo traen MANAGER (explícito) y
  OWNER/ADMIN (`inventory:*`); CASHIER no.
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
import { ConflictError, ForbiddenError } from '../../../src/errors/AppError'

const requireWastePermission = jest.fn()
jest.mock('../../../src/services/shared/inventoryWaste.service', () => ({
  ...jest.requireActual('../../../src/services/shared/inventoryWaste.service'),
  requireWastePermission: (...a: unknown[]) => requireWastePermission(...a),
}))
const adaptDashboardWaste = jest.fn()
jest.mock('../../../src/services/shared/dashboardWasteAdapter', () => ({
  ...jest.requireActual('../../../src/services/shared/dashboardWasteAdapter'),
  adaptDashboardWaste: (...a: unknown[]) => adaptDashboardWaste(...a),
}))
const legacyRawAdjust = jest.fn()
jest.mock('../../../src/services/dashboard/rawMaterial.service', () => ({
  ...jest.requireActual('../../../src/services/dashboard/rawMaterial.service'),
  adjustStock: (...a: unknown[]) => legacyRawAdjust(...a),
}))
const legacyProductAdjust = jest.fn()
jest.mock('../../../src/services/dashboard/productInventory.service', () => ({
  ...jest.requireActual('../../../src/services/dashboard/productInventory.service'),
  adjustInventoryStock: (...a: unknown[]) => legacyProductAdjust(...a),
}))

const app = require('../../../src/app').default

const venueId = 'clvenueadjustwaste000001'
const rawMaterialId = 'clrawmaterialwaste000001'
const productId = 'clproductwaste0000000001'
const RUTA_INSUMO = `/api/v1/dashboard/venues/${venueId}/inventory/raw-materials/${rawMaterialId}/adjust-stock`
const RUTA_PRODUCTO = `/api/v1/dashboard/venues/${venueId}/inventory/products/${productId}/adjust-stock`
const FOLIO = '3f1c9a52-7b1e-4c1d-9f0a-2b6f4e8d1c07'
const OVERRIDE = 'tok-override-merma-dash-01'
const INGLES = /\b(Invalid|Expected|Required|Unrecognized|received|String must|Number must|must contain|characters?)\b/

const CONCESION = {
  id: 'vf-inv-1',
  active: true,
  endDate: null,
  suspendedAt: null,
  stripeSubscriptionId: null,
  feature: { code: 'INVENTORY_TRACKING', name: 'Inventario' },
}
const RESUMEN = { reportId: 'clwastereport00000000001', declared: '2', deducted: '2', unrecorded: '0' }
const FILA_INSUMO = { id: rawMaterialId, venueId, name: 'Aguacate', currentStock: '8', unit: 'KILOGRAM' }
const INVENTARIO = {
  id: 'clinventory0000000000001',
  productId,
  venueId,
  currentStock: { toNumber: () => 8 },
  minimumStock: { toNumber: () => 2 },
  reservedStock: { toNumber: () => 0 },
}

function token(role: string) {
  mirrorTokenRoleOnStaffVenue(role, venueId)
  return jwt.sign({ sub: 'user_test', orgId: 'org_test', venueId, role }, process.env.ACCESS_TOKEN_SECRET as string, { expiresIn: '15m' })
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
  // El adaptador devuelve el resumen del folio Y el artículo ya releído: la ruta sólo responde.
  adaptDashboardWaste.mockImplementation(async (_venueId: unknown, _staffId: unknown, itemType: unknown) => ({
    waste: RESUMEN,
    item: itemType === 'RAW_MATERIAL' ? FILA_INSUMO : INVENTARIO,
  }))
  legacyRawAdjust.mockResolvedValue(FILA_INSUMO)
  legacyProductAdjust.mockResolvedValue({ currentStock: 8, minimumStock: 2, reservedStock: 0 })
})

describe('POST …/raw-materials/:id/adjust-stock', () => {
  it('401 sin credencial', async () => {
    const res = await request(app).post(RUTA_INSUMO).send({ type: 'SPOILAGE', quantity: -2 })
    expect(res.status).toBe(401)
    expect(adaptDashboardWaste).not.toHaveBeenCalled()
  })

  it('🔴 403 real para CASHIER (sin inventory:adjust): ni el adaptador ni el servicio viejo se tocan', async () => {
    const res = await request(app)
      .post(RUTA_INSUMO)
      .set('Authorization', `Bearer ${token('CASHIER')}`)
      .send({ type: 'SPOILAGE', quantity: -2 })
    expect(res.status).toBe(403)
    expect(res.body).toHaveProperty('required', 'inventory:adjust')
    expect(adaptDashboardWaste).not.toHaveBeenCalled()
    expect(legacyRawAdjust).not.toHaveBeenCalled()
  })

  it.each(['MANAGER', 'ADMIN', 'OWNER'])(
    '🔴 %s: una merma va al libro con motivo y folio, y la respuesta es la de siempre + `waste`',
    async role => {
      const res = await request(app)
        .post(RUTA_INSUMO)
        .set('Authorization', `Bearer ${token(role)}`)
        .send({ type: 'SPOILAGE', quantity: -2, reason: 'Caducó', reasonCode: 'EXPIRED', idempotencyKey: FOLIO })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ success: true, message: 'Stock adjusted successfully', data: FILA_INSUMO, waste: RESUMEN })
      expect(adaptDashboardWaste).toHaveBeenCalledWith(
        venueId,
        'user_test',
        'RAW_MATERIAL',
        rawMaterialId,
        expect.objectContaining({ quantity: -2, reason: 'Caducó', reasonCode: 'EXPIRED', idempotencyKey: FOLIO }),
      )
      expect(legacyRawAdjust).not.toHaveBeenCalled()
      // Controlador delgado: la relectura es del adaptador, la ruta no toca la base.
      expect(prismaMock.rawMaterial.findFirstOrThrow).not.toHaveBeenCalled()
      expect(prismaMock.rawMaterial.findFirst).not.toHaveBeenCalled()
      expect(requireWastePermission).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['ADJUSTMENT negativo', { type: 'ADJUSTMENT', quantity: -2 }],
    ['una entrada de merma (positiva)', { type: 'SPOILAGE', quantity: 2 }],
    ['una compra', { type: 'PURCHASE', quantity: 5 }],
  ])('%s sigue por el servicio de siempre, con la respuesta de siempre', async (_caso, body) => {
    const res = await request(app)
      .post(RUTA_INSUMO)
      .set('Authorization', `Bearer ${token('MANAGER')}`)
      .send(body)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true, message: 'Stock adjusted successfully', data: FILA_INSUMO })
    expect(legacyRawAdjust).toHaveBeenCalledWith(venueId, rawMaterialId, expect.objectContaining(body), 'user_test')
    expect(adaptDashboardWaste).not.toHaveBeenCalled()
  })

  it.each([
    ['un motivo que no existe', { reasonCode: 'NOPE' }, 'El motivo de la merma no es válido.'],
    ['un folio que no es UUID', { idempotencyKey: 'abc' }, 'El folio (idempotencyKey) debe ser un UUID.'],
    // El MISMO patrón que el servicio (versión 1-8, variante RFC): el nulo y la versión 0 los
    // rechaza el esquema con este 400, no el servicio con otro código.
    ['el folio nulo', { idempotencyKey: '00000000-0000-0000-0000-000000000000' }, 'El folio (idempotencyKey) debe ser un UUID.'],
    ['un folio versión 0', { idempotencyKey: '3f1c9a52-7b1e-0c1d-9f0a-2b6f4e8d1c07' }, 'El folio (idempotencyKey) debe ser un UUID.'],
  ])('🔴 400 en español con %s, y nada se registra', async (_caso, extra, mensaje) => {
    const res = await request(app)
      .post(RUTA_INSUMO)
      .set('Authorization', `Bearer ${token('MANAGER')}`)
      .send({ type: 'SPOILAGE', quantity: -2, ...extra })
    expect(res.status).toBe(400)
    expect(res.body.message).toContain(mensaje)
    expect(res.body.message).not.toMatch(INGLES)
    expect(adaptDashboardWaste).not.toHaveBeenCalled()
    expect(legacyRawAdjust).not.toHaveBeenCalled()
  })

  it('un rechazo del libro (folio anulado) sale con su status y su código', async () => {
    adaptDashboardWaste.mockRejectedValue(new ConflictError('Este folio fue anulado.', 'WASTE_VOIDED'))
    const res = await request(app)
      .post(RUTA_INSUMO)
      .set('Authorization', `Bearer ${token('MANAGER')}`)
      .send({ type: 'SPOILAGE', quantity: -2, idempotencyKey: FOLIO })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('WASTE_VOIDED')
  })

  it('🔴 con el PIN de un gerente, un CASHIER registra la merma y el token se consume UNA vez', async () => {
    prismaMock.venueSettings.findUnique.mockResolvedValue({ managerPinOverrideEnabled: true } as never)
    let usado = false
    prismaMock.permissionOverride.updateMany.mockImplementation((async (args: any) => {
      const w = args?.where ?? {}
      if (usado || w.token !== OVERRIDE || w.venueId !== venueId || w.permission !== 'inventory:adjust') return { count: 0 }
      usado = true
      return { count: 1 }
    }) as never)
    prismaMock.permissionOverride.findUnique.mockResolvedValue({ authorizedById: 'sv_gerente' } as never)

    const res = await request(app)
      .post(RUTA_INSUMO)
      .set('Authorization', `Bearer ${token('CASHIER')}`)
      .set('X-Permission-Override', OVERRIDE)
      .send({ type: 'SPOILAGE', quantity: -2 })
    expect(res.status).toBe(200)
    expect(res.body.waste).toEqual(RESUMEN)
    expect(adaptDashboardWaste).toHaveBeenCalledTimes(1)
    expect(prismaMock.permissionOverride.updateMany).toHaveBeenCalledTimes(1)
    expect(requireWastePermission).not.toHaveBeenCalled()
  })
})

describe('POST …/products/:id/adjust-stock', () => {
  it('🔴 403 real para CASHIER (sin inventory:adjust)', async () => {
    const res = await request(app)
      .post(RUTA_PRODUCTO)
      .set('Authorization', `Bearer ${token('CASHIER')}`)
      .send({ type: 'LOSS', quantity: -2 })
    expect(res.status).toBe(403)
    expect(res.body).toHaveProperty('required', 'inventory:adjust')
    expect(adaptDashboardWaste).not.toHaveBeenCalled()
    expect(legacyProductAdjust).not.toHaveBeenCalled()
  })

  it('🔴 una merma (LOSS negativa) va al libro; la respuesta es la de siempre + `waste`', async () => {
    const res = await request(app)
      .post(RUTA_PRODUCTO)
      .set('Authorization', `Bearer ${token('MANAGER')}`)
      .send({ type: 'LOSS', quantity: -2, reason: 'Roto', reference: 'R-1', unitCost: 7.5, supplier: 'X', reasonCode: 'DEFECTIVE' })
    expect(res.status).toBe(200)
    expect(Object.keys(res.body).sort()).toEqual(['correlationId', 'data', 'message', 'waste'])
    expect(res.body.message).toBe('Inventory stock adjusted successfully')
    expect(res.body.data).toEqual({ currentStock: 8, minimumStock: 2, reservedStock: 0 })
    expect(res.body.waste).toEqual(RESUMEN)
    expect(adaptDashboardWaste).toHaveBeenCalledWith(
      venueId,
      'user_test',
      'PRODUCT',
      productId,
      expect.objectContaining({ quantity: -2, reason: 'Roto', reference: 'R-1', unitCost: 7.5, supplier: 'X', reasonCode: 'DEFECTIVE' }),
    )
    expect(legacyProductAdjust).not.toHaveBeenCalled()
    // Controlador delgado: la relectura es del adaptador, la ruta no toca la base.
    expect(prismaMock.inventory.findFirstOrThrow).not.toHaveBeenCalled()
    expect(prismaMock.inventory.findFirst).not.toHaveBeenCalled()
    expect(requireWastePermission).not.toHaveBeenCalled()
  })

  it.each([
    ['ADJUSTMENT negativo', { type: 'ADJUSTMENT', quantity: -2 }],
    ['una entrada de merma (positiva)', { type: 'LOSS', quantity: 2 }],
    ['una compra', { type: 'PURCHASE', quantity: 5, unitCost: 3 }],
  ])('%s sigue por el servicio de siempre, sin `waste`', async (_caso, body) => {
    const res = await request(app)
      .post(RUTA_PRODUCTO)
      .set('Authorization', `Bearer ${token('MANAGER')}`)
      .send(body)
    expect(res.status).toBe(200)
    expect(Object.keys(res.body).sort()).toEqual(['correlationId', 'data', 'message'])
    expect(legacyProductAdjust).toHaveBeenCalledWith(venueId, productId, expect.objectContaining(body), 'user_test')
    expect(adaptDashboardWaste).not.toHaveBeenCalled()
  })
})
