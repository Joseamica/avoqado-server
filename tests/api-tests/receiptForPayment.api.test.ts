/*
  tests/api-tests/receiptForPayment.api.test.ts

  La CAPA HTTP de la liga del recibo, en los DOS namespaces: arranca el Express real y le pega a
  `/mobile` y a `/tpv` con supertest.

  🔴 Existe porque una prueba que lee el archivo de rutas demuestra que alguien escribió
  `payments:read` en el sitio correcto, NO que un token ajeno reciba un 403 de verdad. Aquí se
  ejercita el encadenado completo authenticateToken → checkPermission → controlador.

  Hechos de permisos (src/lib/permissions.ts): `payments:read` lo tienen TODOS los roles operativos
  —hasta VIEWER (:738) y, por dependencia de `area-tickets:deliver` (:114), KITCHEN—. Es lo correcto:
  reimprimir un ticket es tarea de piso, no una acción administrativa. Por eso el candado que de
  verdad importa aquí no es el rol sino el NEGOCIO: un token de otro venue no puede sacar la liga
  del recibo de un ticket que no es suyo, y un pago de otro venue no existe.
*/

process.env.NODE_ENV = process.env.NODE_ENV || 'test'
process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'test-access-secret'
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret'
process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || 'test-cookie-secret'
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/testdb?schema=public'

jest.mock('../../src/config/session', () => {
  const noop = (req: any, _res: any, next: any) => next()
  return { __esModule: true, default: noop }
})
jest.mock('../../src/config/swagger', () => ({ __esModule: true, setupSwaggerUI: jest.fn() }))

const mockGenerateDigitalReceipt = jest.fn()
jest.mock('../../src/services/tpv/digitalReceipt.tpv.service', () => ({
  generateDigitalReceipt: (...args: unknown[]) => mockGenerateDigitalReceipt(...args),
  generateReceiptUrl: jest.fn(),
  getDigitalReceiptByAccessKey: jest.fn(),
}))

const mockLoadOrderForCfdiFromDb = jest.fn()
jest.mock('../../src/services/fiscal/cfdi.service', () => ({
  loadOrderForCfdiFromDb: (...args: unknown[]) => mockLoadOrderForCfdiFromDb(...args),
}))

import jwt from 'jsonwebtoken'
import request from 'supertest'

import { prismaMock } from '@tests/__helpers__/setup'
import { mirrorTokenRoleOnStaffVenue } from '@tests/__helpers__/venueRoleMock'

const app = require('../../src/app').default

const venueId = 'clvenuereceipt0000000001'
const otherVenueId = 'clvenuereceipt0000000002'
const paymentId = 'clpaymentreceipt00000001'

const RUTAS = [
  ['mobile', `/api/v1/mobile/venues/${venueId}/payments/${paymentId}/receipt`],
  ['tpv', `/api/v1/tpv/venues/${venueId}/payments/${paymentId}/receipt`],
] as const

function makeToken(role: string, tokenVenueId: string = venueId) {
  mirrorTokenRoleOnStaffVenue(role, tokenVenueId)
  return jwt.sign({ sub: 'user_test', orgId: 'org_test', venueId: tokenVenueId, role }, process.env.ACCESS_TOKEN_SECRET as string, {
    expiresIn: '15m',
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  // checkPermission determinista: sin bypass de SUPERADMIN ni overrides personalizados.
  prismaMock.staffVenue.findFirst.mockResolvedValue(null)
  prismaMock.staffVenue.findUnique.mockResolvedValue(null)
  prismaMock.venue.findUnique.mockResolvedValue(null)
  prismaMock.venueRolePermission.findUnique.mockResolvedValue(null)

  prismaMock.payment.findFirst.mockResolvedValue({ id: paymentId, orderId: 'ord-1' } as never)
  mockGenerateDigitalReceipt.mockResolvedValue({
    id: 'rcp-1',
    accessKey: 'llave-abc',
    dataSnapshot: { items: [{ productName: 'Latte' }] },
    recipientEmail: 'cliente@ejemplo.com',
    recipientPhone: '+5215512345678',
  })
  mockLoadOrderForCfdiFromDb.mockResolvedValue({ facturacionEnabled: true, autofacturaEnabled: true })
})

describe.each(RUTAS)('GET liga del recibo — namespace %s', (_namespace, RUTA) => {
  describe('401 sin credencial', () => {
    it('sin cabecera Authorization', async () => {
      const res = await request(app).get(RUTA)
      expect(res.status).toBe(401)
    })

    it('con un Bearer mal formado', async () => {
      const res = await request(app).get(RUTA).set('Authorization', 'Bearer no.es.un.jwt')
      expect(res.status).toBe(401)
    })
  })

  it('🔴 403 entre negocios: un token de otro venue no saca la liga de este ticket', async () => {
    const res = await request(app)
      .get(RUTA)
      .set('Authorization', `Bearer ${makeToken('OWNER', otherVenueId)}`)

    expect(res.status).toBe(403)
    expect(mockGenerateDigitalReceipt).not.toHaveBeenCalled()
  })

  it('🔴 404 cuando el pago es de OTRO negocio (el servicio filtra por venue)', async () => {
    prismaMock.payment.findFirst.mockResolvedValue(null as never)

    const res = await request(app)
      .get(RUTA)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)

    expect(res.status).toBe(404)
    expect(mockGenerateDigitalReceipt).not.toHaveBeenCalled()
  })

  describe('roles que SÍ pueden reimprimir', () => {
    it.each([['CASHIER'], ['WAITER'], ['MANAGER'], ['ADMIN'], ['OWNER']])('%s recibe 200 con la liga', async role => {
      const res = await request(app)
        .get(RUTA)
        .set('Authorization', `Bearer ${makeToken(role)}`)

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.receipt.accessKey).toBe('llave-abc')
      expect(res.body.receipt.receiptUrl).toContain('/receipts/public/llave-abc')
      expect(res.body.receipt.autofacturaAvailable).toBe(true)
    })
  })

  it('🔴 el cuerpo NO lleva el dataSnapshot ni los datos personales del cliente', async () => {
    const res = await request(app)
      .get(RUTA)
      .set('Authorization', `Bearer ${makeToken('CASHIER')}`)

    expect(Object.keys(res.body.receipt).sort()).toEqual(['accessKey', 'autofacturaAvailable', 'receiptUrl'])
    expect(JSON.stringify(res.body)).not.toContain('cliente@ejemplo.com')
    expect(JSON.stringify(res.body)).not.toContain('Latte')
  })
})
