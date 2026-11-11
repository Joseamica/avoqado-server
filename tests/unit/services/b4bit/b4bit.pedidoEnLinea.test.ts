/**
 * S9 (P2-5): B4Bit (cripto) ya no INICIA un cobro sobre un pedido en línea. Confirma el dinero minutos después y, si para entonces el
 * folio venció, el dinero quedaba para conciliar a mano. La misma guarda que excluía la tarjeta en línea excluye cualquier pedido en
 * línea, antes de crear nada. Lo YA iniciado antes no pasa por la guarda: la repetición de su operación y su confirmación siguen (la
 * confirmación tardía y su marca de lealtad atómica las fija S3 en `lealtadDelFolio.integration.test.ts`).
 */
jest.mock('@/services/mobile/areaTicketV7.mobile.service', () => ({
  lockAreaTicketCheckoutHierarchy: jest.fn().mockResolvedValue(null),
  cerrarSesionDeValesAlCerrarLaVenta: jest.fn().mockResolvedValue(false),
}))
jest.mock('@/utils/prismaClient', () => {
  const client: any = {
    payment: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    order: { findUnique: jest.fn(), create: jest.fn() },
    onlineOrder: { findFirst: jest.fn() },
    venueCryptoConfig: { findUnique: jest.fn() },
    shift: { findFirst: jest.fn() },
    terminal: { findFirst: jest.fn() },
    $executeRaw: jest.fn(),
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
  }
  client.$transaction.mockImplementation((cb: any) => cb(client))
  return { __esModule: true, default: client }
})
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/communication/sockets/managers/socketManager', () => ({ socketManager: { broadcastToVenue: jest.fn() } }))
jest.mock('@/services/venueSalesGuard', () => ({ assertVenueSalesEnabled: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/access/access.service', () => ({
  getUserAccess: jest.fn().mockResolvedValue({}),
  hasPermission: jest.fn().mockReturnValue(true),
}))

import fs from 'fs'
import path from 'path'
import { initiateCryptoPayment } from '@/services/b4bit/b4bit.service'
import prisma from '@/utils/prismaClient'

const db = prisma as any
const V = 'c000000000000000000000001'
const A = 'c000000000000000000000003'
const K = 'c000000000000000000000004'
const ORDER = 'c000000000000000000000009'
let row: any
const provider = jest.fn()
const iniciar = (over: Record<string, unknown> = {}) =>
  initiateCryptoPayment({
    venueId: V,
    orgId: 'org',
    staffId: 'declarado',
    actorStaffId: A,
    terminalSerialNumber: 'AVQD-auth',
    idempotencyKey: K,
    amount: 13400,
    orderId: ORDER,
    ...over,
  } as any)
const enLinea = (si: boolean, mode = 'PAY_AT_PICKUP') =>
  db.onlineOrder.findFirst.mockImplementation(async ({ where, select }: any) =>
    si && where.orderId === ORDER && where.venueId === V
      ? select?.paymentMode
        ? { paymentMode: mode, charge: null }
        : { id: 'conline1' }
      : null,
  )

beforeEach(() => {
  jest.clearAllMocks()
  row = null
  db.$queryRaw.mockResolvedValue([{ id: K }])
  db.payment.findUnique.mockImplementation(async ({ where }: any) =>
    row && (where.venueId_idempotencyKey?.venueId ?? where.venueId) === row.venueId ? { ...row } : null,
  )
  db.payment.findUniqueOrThrow.mockImplementation(async () => ({ ...row }))
  db.payment.findFirst.mockImplementation(async () => (row ? { ...row } : null))
  db.payment.create.mockImplementation(async ({ data }: any) => (row = { id: 'generado', ...data }))
  db.payment.update.mockImplementation(async ({ data }: any) => (row = { ...row, ...data }))
  db.payment.updateMany.mockImplementation(async ({ data }: any) => {
    row = { ...row, ...data }
    return { count: 1 }
  })
  db.order.findUnique.mockResolvedValue({ id: ORDER, status: 'PENDING', paymentStatus: 'PENDING', thirdPartyCashDue: null })
  db.order.create.mockResolvedValue({ id: 'order-own', orderNumber: 'test' })
  db.terminal.findFirst.mockResolvedValue({ id: 'terminal-own' })
  db.shift.findFirst.mockResolvedValue(null)
  db.venueCryptoConfig.findUnique.mockResolvedValue({ status: 'ACTIVE', b4bitDeviceId: 'stub-device' })
  enLinea(false)
  provider.mockImplementation(async (_url: string, options: any) =>
    options.method === 'POST'
      ? {
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          text: async () => JSON.stringify({ identifier: 'request-own', web_url: 'https://pay.test/own' }),
        }
      : { json: async () => ({ status: 'PE' }) },
  )
  global.fetch = provider as any
})

describe('B4Bit sobre un pedido en línea (S9)', () => {
  it.each([
    ['folio «Nadie», con llave', 'PAY_AT_PICKUP', K],
    ['folio «Nadie», sin llave (contrato viejo)', 'PAY_AT_PICKUP', undefined],
  ])('cripto NUEVO sobre un pedido en línea (%s) ⇒ 409 ONLINE_ORDER_PAID_AT_REGISTER antes de crear nada', async (_c, mode, key) => {
    enLinea(true, mode)
    await expect(iniciar({ idempotencyKey: key })).rejects.toMatchObject({
      statusCode: 409,
      code: 'ONLINE_ORDER_PAID_AT_REGISTER',
      message: 'Este pedido se cobra en caja con efectivo, tarjeta o saldo.',
    })
    expect(db.onlineOrder.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { orderId: ORDER, venueId: V } }))
    expect(db.payment.create).not.toHaveBeenCalled()
    expect(db.order.create).not.toHaveBeenCalled()
    expect(provider).not.toHaveBeenCalled()
  })

  it('un pedido de tarjeta en línea conserva su respuesta de hoy (ONLINE_ORDER_PAID_BY_CARD)', async () => {
    enLinea(true, 'CARD_ONLINE')
    await expect(iniciar()).rejects.toMatchObject({ statusCode: 409, code: 'ONLINE_ORDER_PAID_BY_CARD' })
    expect(db.payment.create).not.toHaveBeenCalled()
  })

  it('una cuenta que no es pedido en línea se cobra con cripto como hoy', async () => {
    await expect(iniciar()).resolves.toMatchObject({ paymentId: K })
    expect(db.payment.create).toHaveBeenCalledTimes(1)
    expect(provider.mock.calls.filter(c => c[1].method === 'POST')).toHaveLength(1)
  })

  it('cripto sin cuenta (venta rápida propia) no pregunta por pedidos en línea y se inicia como hoy', async () => {
    await expect(iniciar({ orderId: undefined })).resolves.toMatchObject({ paymentId: K })
    expect(db.onlineOrder.findFirst).not.toHaveBeenCalled()
    expect(db.order.create).toHaveBeenCalledTimes(1)
  })

  it('una operación YA iniciada antes (misma llave) se repite igual aunque su cuenta sea un folio: no se pierde lo iniciado', async () => {
    const primera = await iniciar() // antes de S9 (o antes de que la cuenta fuera folio): ya existe su Payment PENDING
    enLinea(true)
    const repeticion = await iniciar()
    expect(repeticion.paymentId).toBe(primera.paymentId)
    expect(db.payment.create).toHaveBeenCalledTimes(1)
    expect(provider.mock.calls.filter(c => c[1].method === 'POST')).toHaveLength(1)
  })

  it('la guarda vive SÓLO en el inicio: la confirmación y la recuperación de un cripto ya iniciado no la llaman', () => {
    const fuente = fs.readFileSync(path.join(__dirname, '../../../../src/services/b4bit/b4bit.service.ts'), 'utf8')
    const llamadas = [...fuente.matchAll(/assertNotOnlineOrderInTx\(/g)].map(m => m.index!)
    expect(llamadas).toHaveLength(1)
    const inicio = fuente.indexOf('export async function initiateCryptoPayment(')
    const siguiente = fuente.indexOf('\nexport async function ', inicio + 1)
    const otraFuncion = fuente.indexOf('\nasync function ', inicio + 1)
    const fin = Math.min(...[siguiente, otraFuncion].filter(i => i > 0))
    expect(llamadas[0]).toBeGreaterThan(inicio)
    expect(llamadas[0]).toBeLessThan(fin)
  })
})
