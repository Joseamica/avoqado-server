/*
  tests/api-tests/dashboard/receipt-layout.api.test.ts

  La CAPA HTTP del diseñador de tickets, de punta a punta: arranca el Express real y le pega a
  las rutas con supertest.

  🔴 Existe porque la prueba de permisos que ya hay es de CABLEADO (comprueba que OWNER/ADMIN
  tengan el permiso en permissions.ts). Eso demuestra que está bien escrito, NO que un gerente
  reciba un 403 de verdad. Este archivo sí lo demuestra: ejercita
  authenticateToken → checkPermission → validateRequest → controlador.

  Hecho de permisos que este archivo protege: MANAGER tiene `printers:manage` pero NO
  `receipt-layout:manage`. Si alguien "simplifica" copiando el precedente de impresoras, todos
  los gerentes podrían rediseñar el ticket del negocio. Aquí se cae.
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

// El servicio se simula: aquí se prueba la CAPA HTTP, no el CAS (que tiene sus pruebas puras
// y sus tres de integración contra Postgres).
jest.mock('../../../src/services/dashboard/receiptLayout/receiptLayout.service', () => ({
  __esModule: true,
  getReceiptLayout: jest.fn(),
  putReceiptLayout: jest.fn(),
  resetReceiptLayout: jest.fn(),
}))
jest.mock('../../../src/services/dashboard/receiptLayout/readiness.service', () => ({
  __esModule: true,
  getReceiptReadiness: jest.fn(),
  getReceiptDevices: jest.fn(),
  cargarVenueInfo: jest.fn(),
}))

import jwt from 'jsonwebtoken'
import request from 'supertest'

import { prismaMock } from '@tests/__helpers__/setup'
import { mirrorTokenRoleOnStaffVenue } from '@tests/__helpers__/venueRoleMock'
import { CANONICAL_LAYOUT } from '@/services/shared/receiptLayout'

const app = require('../../../src/app').default
const servicio = require('../../../src/services/dashboard/receiptLayout/receiptLayout.service')
const readiness = require('../../../src/services/dashboard/receiptLayout/readiness.service')

const DASH = '/api/v1/dashboard'
const venueId = 'clvenuereceipt000000001'
const otroVenueId = 'clvenuereceipt000000002'
const RUTA = `${DASH}/venues/${venueId}/receipt-layout`

function makeToken(role: string, tokenVenueId: string = venueId) {
  mirrorTokenRoleOnStaffVenue(role, tokenVenueId)
  return jwt.sign({ sub: 'user_test', orgId: 'org_test', venueId: tokenVenueId, role }, process.env.ACCESS_TOKEN_SECRET as string, {
    expiresIn: '15m',
  })
}

const LEIDO = { blocks: CANONICAL_LAYOUT, schemaVersion: 1, revision: 0, source: 'default', updatedAt: null }

beforeEach(() => {
  jest.clearAllMocks()
  // checkPermission determinista: sin bypass de SUPERADMIN ni overrides personalizados.
  prismaMock.staffVenue.findFirst.mockResolvedValue(null)
  prismaMock.staffVenue.findUnique.mockResolvedValue(null)
  prismaMock.venue.findUnique.mockResolvedValue(null)
  prismaMock.venueRolePermission.findUnique.mockResolvedValue(null)
  servicio.getReceiptLayout.mockResolvedValue(LEIDO)
  servicio.putReceiptLayout.mockResolvedValue({ ...LEIDO, revision: 1, source: 'custom' })
  readiness.getReceiptReadiness.mockResolvedValue({ fiscalEmisor: true, logo: false })
  readiness.getReceiptDevices.mockResolvedValue({ supporting: 0, notSupporting: [] })
})

describe('401 sin credencial', () => {
  it('sin cabecera Authorization', async () => {
    expect((await request(app).get(RUTA)).status).toBe(401)
  })
  it('con un Bearer mal formado', async () => {
    expect((await request(app).get(RUTA).set('Authorization', 'Bearer no.es.un.jwt')).status).toBe(401)
  })
})

describe('🔴 403 por ROL — el ticket es administrativo', () => {
  it('🔴 MANAGER recibe 403 al GUARDAR y NO llega a escribir', async () => {
    const res = await request(app)
      .put(RUTA)
      .set('Authorization', `Bearer ${makeToken('MANAGER')}`)
      .send({ blocks: CANONICAL_LAYOUT, expectedRevision: 0 })
    expect(res.status).toBe(403)
    expect(res.body).toHaveProperty('required', 'receipt-layout:manage')
    expect(servicio.putReceiptLayout).not.toHaveBeenCalled()
  })

  it.each([['MANAGER'], ['CASHIER'], ['WAITER']])('%s recibe 403 incluso para LEER', async role => {
    const res = await request(app)
      .get(RUTA)
      .set('Authorization', `Bearer ${makeToken(role)}`)
    expect(res.status).toBe(403)
    expect(servicio.getReceiptLayout).not.toHaveBeenCalled()
  })

  it('🔴 CASHIER tampoco puede restablecer', async () => {
    const res = await request(app)
      .delete(RUTA)
      .set('Authorization', `Bearer ${makeToken('CASHIER')}`)
      .send({ expectedRevision: 1 })
    expect(res.status).toBe(403)
    expect(servicio.resetReceiptLayout).not.toHaveBeenCalled()
  })
})

describe('ADMIN y OWNER sí', () => {
  it.each([['ADMIN'], ['OWNER']])('%s lee 200 con readiness y devices', async role => {
    const res = await request(app)
      .get(RUTA)
      .set('Authorization', `Bearer ${makeToken(role)}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ source: 'default', revision: 0 })
    expect(res.body.data.readiness).toEqual({ fiscalEmisor: true, logo: false })
    expect(res.body.data.devices).toEqual({ supporting: 0, notSupporting: [] })
  })

  it('ADMIN guarda y el servicio recibe la revisión y el autor', async () => {
    const res = await request(app)
      .put(RUTA)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ blocks: CANONICAL_LAYOUT, expectedRevision: 3 })
    expect(res.status).toBe(200)
    expect(servicio.putReceiptLayout).toHaveBeenCalledWith(
      expect.objectContaining({ venueId, expectedRevision: 3, updatedById: 'user_test' }),
    )
  })
})

describe('🔴 Zod: la revisión no es opcional', () => {
  it('sin expectedRevision el PUT es 400, no un guardado silencioso', async () => {
    const res = await request(app)
      .put(RUTA)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ blocks: CANONICAL_LAYOUT })
    expect(res.status).toBe(400)
    expect(servicio.putReceiptLayout).not.toHaveBeenCalled()
  })

  it('una revisión negativa es 400', async () => {
    const res = await request(app)
      .put(RUTA)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ blocks: CANONICAL_LAYOUT, expectedRevision: -1 })
    expect(res.status).toBe(400)
  })

  it('expectedRevision 0 SÍ vale: es «sé que no hay fila»', async () => {
    const res = await request(app)
      .put(RUTA)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ blocks: CANONICAL_LAYOUT, expectedRevision: 0 })
    expect(res.status).toBe(200)
  })
})

describe('🔴 Zod: mensajes en español y tope de bloques en la puerta', () => {
  // El middleware muestra el mensaje de Zod TAL CUAL: uno en inglés («Required») sale crudo en la pantalla.
  it('sin expectedRevision el mensaje dice qué falta, en español', async () => {
    const res = await request(app)
      .put(RUTA)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ blocks: CANONICAL_LAYOUT })
    expect(res.body.message).toContain('La revisión es obligatoria')
    expect(res.body.message).not.toMatch(/Required/)
  })

  it('sin blocks el mensaje dice qué falta, en español', async () => {
    const res = await request(app)
      .put(RUTA)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ expectedRevision: 0 })
    expect(res.status).toBe(400)
    expect(res.body.message).toContain('Faltan los bloques del ticket')
  })

  it('restablecer sin expectedRevision también lo dice en español', async () => {
    const res = await request(app)
      .delete(RUTA)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({})
    expect(res.status).toBe(400)
    expect(res.body.message).toContain('La revisión es obligatoria')
    expect(servicio.resetReceiptLayout).not.toHaveBeenCalled()
  })

  // 🔴 La vista previa interpreta CADA bloque: sin tope, un cuerpo con miles de bloques es CPU gratis.
  it.each([['put'], ['preview']])('🔴 más de 40 bloques se corta en la puerta (%s)', async ruta => {
    const blocks = Array(41).fill({ type: 'separator' })
    const token = `Bearer ${makeToken('ADMIN')}`
    const res =
      ruta === 'put'
        ? await request(app).put(RUTA).set('Authorization', token).send({ blocks, expectedRevision: 0 })
        : await request(app).post(`${RUTA}/preview`).set('Authorization', token).send({ blocks, paperWidth: 80 })
    expect(res.status).toBe(400)
    expect(res.body.message).toContain('hasta 40 bloques')
    expect(servicio.putReceiptLayout).not.toHaveBeenCalled()
    expect(readiness.cargarVenueInfo).not.toHaveBeenCalled()
  })

  it('una venta de ejemplo que no existe se explica en español', async () => {
    const res = await request(app)
      .post(`${RUTA}/preview`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ blocks: CANONICAL_LAYOUT, paperWidth: 80, sample: 'hotel' })
    expect(res.status).toBe(400)
    expect(res.body.message).toContain('La venta de ejemplo debe ser')
    expect(res.body.message).not.toMatch(/Invalid enum/)
  })
})

describe('🔴 bitácora del restablecer: sólo lo que PASÓ', () => {
  // El setup global simula `logAction` (tests/__helpers__/setup.ts): se mira el mock, no Prisma.
  const { logAction } = require('../../../src/services/dashboard/activity-log.service')
  const esperarBitacora = () => new Promise(r => setImmediate(r))

  it('restablecer un diseño guardado escribe RECEIPT_LAYOUT_RESET con la revisión descartada', async () => {
    servicio.resetReceiptLayout.mockResolvedValue({ layout: LEIDO, discardedRevision: 4 })
    const res = await request(app)
      .delete(RUTA)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ expectedRevision: 4 })
    await esperarBitacora()
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ source: 'default', revision: 0 })
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'RECEIPT_LAYOUT_RESET', venueId, staffId: 'user_test', data: { revisionDescartada: 4 } }),
    )
  })

  it('🔴 restablecer lo que YA era la canónica no escribe bitácora: no se borró nada', async () => {
    servicio.resetReceiptLayout.mockResolvedValue({ layout: LEIDO, discardedRevision: null })
    const res = await request(app)
      .delete(RUTA)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ expectedRevision: 0 })
    await esperarBitacora()
    expect(res.status).toBe(200)
    expect(logAction).not.toHaveBeenCalled()
  })
})

describe('🔴 aislamiento entre negocios', () => {
  it('un token de OTRO negocio no lee este diseño', async () => {
    const res = await request(app)
      .get(RUTA)
      .set('Authorization', `Bearer ${makeToken('ADMIN', otroVenueId)}`)
    expect(res.status).toBe(403)
    expect(servicio.getReceiptLayout).not.toHaveBeenCalled()
  })
})
