/**
 * El Reembolso del POS a saldo a favor por HTTP real contra Postgres real (spec 2026-10-30-saldo-a-favor §5.5, tarea S4). Las rutas,
 * los permisos, los validadores y los servicios son los de producción; sólo la identidad viene de cabeceras de prueba.
 *
 * Lo que un mock no prueba:
 * - una venta con tarjeta de la TPV se devuelve a saldo de OTRA clienta (mamá → hija) y el detalle del REFUND lo dice al reimprimir;
 * - 🔴 la app muere tras el commit y reenvía OTRA cajera con la misma llave: un solo reembolso, a nombre de la primera;
 * - el crédito de un Cambio REAL con raíz en tarjeta bancaria se pasa a saldo por la ruta del POS;
 * - «Sólo saldo a favor»: CASH con devolución de mercancía se rechaza sin escribir; con «es por defecto» pasa; y el registro tardío de
 *   lo que la terminal ya devolvió se acepta igual (el banco ya devolvió).
 *
 * Correr (en la nube, con su propia base; el veredicto está en el CUERPO, no en el exit):
 *   cd /Users/amieva/Documents/Programming/Avoqado && AVQ_TREE=$HOME/.claude/worktrees/saldo-a-favor/avoqado-server \
 *     ./scripts/avq-verify.sh avoqado-server npx jest --selectProjects integration --testPathPattern "reembolsoDelPos" --ci
 */
import { randomUUID } from 'crypto'
import type { NextFunction, Request, Response } from 'express'

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn(), broadcastToUser: jest.fn() },
  broadcastTpvStatusUpdate: jest.fn(),
}))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn().mockResolvedValue({ notified: 0 }),
}))
jest.mock('@/services/wallet/firstStampEmail.service', () => ({ sendFirstStampEmailIfDue: jest.fn() }))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({ generateAndStoreReceipt: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/access/basePlan.service', () => ({
  ...jest.requireActual('@/services/access/basePlan.service'),
  venueHasFeatureAccess: jest.fn().mockResolvedValue(true),
}))
jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: Request, res: Response, next: NextFunction) => {
    const actorId = req.get('x-test-actor')
    if (!actorId) return res.status(401).json({ success: false, message: 'Autenticación requerida' })
    Object.assign(req, {
      authContext: { userId: actorId, venueId: req.params.venueId, orgId: req.params.venueId, role: req.get('x-test-role') ?? 'OWNER' },
    })
    next()
  },
}))
jest.mock('@/middlewares/registerDevice.middleware', () => ({
  registerDeviceMiddleware: (_req: Request, _res: Response, next: NextFunction) => next(),
  capturarVenueDeLaRuta: (_req: Request, _res: Response, next: NextFunction) => next(),
}))

import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'
import { createExchange } from '@/services/exchanges/exchange.service'
import { recordRefund } from '@/services/tpv/refund.tpv.service'
import { seedClothingSale } from '../exchanges/seedExchange'

const express = require('express') as typeof import('express')
const request = require('supertest') as typeof import('supertest')
const mobileRouter = (require('@/routes/mobile.routes') as typeof import('@/routes/mobile.routes')).default

const app = express()
app.use(express.json())
app.use('/api/v1/mobile', mobileRouter)
app.use(
  (error: { statusCode?: number; message?: string; code?: string; details?: unknown }, _req: Request, res: Response, _n: NextFunction) => {
    res.status(error.statusCode ?? 500).json({ success: false, message: error.message, code: error.code, details: error.details })
  },
)

jest.setTimeout(120_000)

type Seed = Awaited<ReturnType<typeof seedClothingSale>>
const fixtures: Seed[] = []
let n = 0
const telefono = () => `55${String(10_000_000 + ((process.pid * 97 + ++n * 7919 + Date.now()) % 89_999_999)).padStart(8, '0')}`

/** Una venta de $500 de la MAMÁ (efectivo, o tarjeta de la TPV procesada por Avoqado), y su HIJA como otra clienta con teléfono. */
async function seed(opts: Parameters<typeof seedClothingSale>[0] = {}) {
  const s = await seedClothingSale(opts)
  fixtures.push(s)
  await prisma.staffVenue.updateMany({ where: { venueId: s.venueId, staffId: s.staffId }, data: { role: 'OWNER' } })
  await prisma.customer.update({ where: { id: s.customer.id }, data: { firstName: 'Mamá', lastName: 'Prueba', phone: telefono() } })
  const hija = await prisma.customer.create({ data: { venueId: s.venueId, firstName: 'Hija', lastName: 'Prueba', phone: telefono() } })
  return { ...s, hija }
}

const cabeceras = (staffId: string) => ({ 'x-test-actor': staffId, 'x-test-role': 'OWNER', 'x-device-id': 'caja-reembolso-1' })
const POST = (s: Seed, ruta: string, body: object, staffId = s.staffId) =>
  request(app).post(`/api/v1/mobile/venues/${s.venueId}${ruta}`).set(cabeceras(staffId)).send(body)
const GET = (s: Seed, ruta: string) => request(app).get(`/api/v1/mobile/venues/${s.venueId}${ruta}`).set(cabeceras(s.staffId))
const llave = () => `pos-saldo-${randomUUID().slice(0, 12)}`
const reembolsos = (s: Seed) => prisma.payment.findMany({ where: { venueId: s.venueId, type: 'REFUND' }, take: 10 })
const soloSaldo = (s: Seed) =>
  prisma.venueSettings.upsert({
    where: { venueId: s.venueId },
    create: { venueId: s.venueId, storeCreditOnly: true },
    update: { storeCreditOnly: true },
  })

afterAll(async () => {
  for (const s of fixtures) {
    await prisma.transactionCost.deleteMany({ where: { payment: { venueId: s.venueId } } })
    await s.cleanup().catch(error => console.warn('reembolsoDelPos: la limpieza no terminó', String(error)))
  }
  await prisma.$disconnect()
})

describe('Reembolso del POS a saldo a favor · HTTP + Postgres real', () => {
  it('una venta con tarjeta de la TPV se devuelve a saldo de la HIJA: 201 con su storeCredit, fila STORE_CREDIT con origen tarjeta, y el detalle del REFUND la nombra aunque la venta sea de la mamá', async () => {
    const s = await seed({ card: true })

    const res = await POST(s, `/payments/${s.payments[0].id}/refund`, {
      amount: 20000,
      reason: 'RETURNED_GOODS',
      refundMethod: 'STORE_CREDIT',
      customerId: s.hija.id,
      idempotencyKey: llave(),
    })

    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({
      amount: 200,
      storeCredit: {
        customerId: s.hija.id,
        customerName: 'Hija Prueba',
        amountCents: 20000,
        newBalanceCents: 20000,
        phoneLast4: expect.stringMatching(/^\d{4}$/),
        phoneMismatch: false,
      },
    })
    expect(res.body.data).not.toHaveProperty('abono')
    const fila = await prisma.payment.findUniqueOrThrow({ where: { id: res.body.data.refundId }, include: { tenderType: true } })
    expect(fila.tenderType?.systemKind).toBe('STORE_CREDIT')
    expect(fila.processorData).toMatchObject({ originalPaymentId: s.payments[0].id, originalMethod: 'CREDIT_CARD' })
    const sobre = await prisma.giftCard.findFirstOrThrow({ where: { venueId: s.venueId, customerId: s.hija.id } })
    expect(sobre.balance.toFixed(2)).toBe('200.00')
    expect(await prisma.giftCard.count({ where: { venueId: s.venueId, customerId: s.customer.id } })).toBe(0)

    const detalle = await GET(s, `/transactions/${res.body.data.refundId}`)
    expect(detalle.status).toBe(200)
    expect(detalle.body.transaction).toMatchObject({ storeCredit: { customerName: 'Hija Prueba', amountCents: 20000 } })
    const venta = await GET(s, `/transactions/${s.payments[0].id}`)
    expect(venta.body.transaction).toMatchObject({ storeCreditOption: { available: true } })
  })

  it('🔴 A envía, se pierde la respuesta, B reenvía con la misma llave → un solo reembolso, staffId de A, y la misma respuesta', async () => {
    const s = await seed()
    const body = { amount: 15000, reason: 'RETURNED_GOODS', refundMethod: 'STORE_CREDIT', customerId: s.hija.id, idempotencyKey: llave() }

    const deA = await POST(s, `/payments/${s.payments[0].id}/refund`, body, s.staffId)
    expect(deA.status).toBe(201)
    // La cajera B (otra sesión, CASHIER) reabre la venta y reenvía lo pendiente con la MISMA llave.
    const deB = await POST(s, `/payments/${s.payments[0].id}/refund`, body, s.seller.id)

    expect(deB.status).toBe(201)
    expect(deB.body.data.refundId).toBe(deA.body.data.refundId)
    expect(deB.body.data.storeCredit).toEqual(deA.body.data.storeCredit)
    const filas = await reembolsos(s)
    expect(filas).toHaveLength(1)
    expect(filas[0].processedById).toBe(s.staffId)
    const sobre = await prisma.giftCard.findFirstOrThrow({ where: { venueId: s.venueId, customerId: s.hija.id } })
    expect(sobre.balance.toFixed(2)).toBe('150.00')
    expect(await prisma.giftCardActivity.count({ where: { giftCardId: sobre.id } })).toBe(1)
    // La bitácora (doble de la integración) se escribe UNA vez: la repetición no vuelve a registrar.
    const bitacora = (logAction as jest.Mock).mock.calls.filter(
      ([p]) => p.action === 'REFUND_TO_STORE_CREDIT' && p.entityId === deA.body.data.refundId,
    )
    expect(bitacora).toHaveLength(1)
    expect(bitacora[0][0]).toMatchObject({ staffId: s.staffId, data: { customerId: s.hija.id, amount: 150 } })
  })

  it('el crédito de un Cambio REAL con raíz en tarjeta bancaria se pasa a saldo por la ruta del POS', async () => {
    const s = await seed({ card: true })
    const { exchange } = await createExchange(s.input())

    const res = await POST(s, `/payments/${exchange.paymentIds[0]}/refund`, {
      amount: 20000,
      reason: 'RETURNED_GOODS',
      refundMethod: 'STORE_CREDIT',
      customerId: s.customer.id,
      idempotencyKey: llave(),
    })

    expect(res.status).toBe(201)
    expect(res.body.data.storeCredit).toMatchObject({ customerId: s.customer.id, amountCents: 20000, newBalanceCents: 20000 })
  })

  describe('«Sólo saldo a favor»', () => {
    it('devolución de mercancía en efectivo (una app vieja) → 400 STORE_CREDIT_ONLY sin escribir; con «es por defecto» → 201', async () => {
      const s = await seed()
      await soloSaldo(s)

      const vieja = await POST(s, `/payments/${s.payments[0].id}/refund`, { amount: 10000, reason: 'RETURNED_GOODS', refundMethod: 'CASH' })
      expect(vieja.status).toBe(400)
      expect(vieja.body).toMatchObject({ code: 'STORE_CREDIT_ONLY', message: expect.stringContaining('sólo como saldo a favor') })
      expect(await reembolsos(s)).toHaveLength(0)

      const defecto = await POST(s, `/payments/${s.payments[0].id}/refund`, {
        amount: 10000,
        reason: 'RETURNED_GOODS',
        refundMethod: 'CASH',
        defective: true,
      })
      expect(defecto.status).toBe(201)
      expect(await reembolsos(s)).toHaveLength(1)
    })

    it('el registro tardío de lo que la terminal YA devolvió se acepta aunque haya sólo saldo', async () => {
      const s = await seed({ card: true })
      await soloSaldo(s)

      const r = await recordRefund(
        s.venueId,
        {
          venueId: s.venueId,
          originalPaymentId: s.payments[0].id,
          originalOrderId: s.order.id,
          amount: 20000,
          reason: 'CUSTOMER_REQUEST',
          merchantAccountId: s.payments[0].merchantAccountId,
          authorizationNumber: 'AUT-SOLO-SALDO',
          referenceNumber: 'REF-SOLO-SALDO',
          isPartialRefund: true,
          currency: 'MXN',
          processor: 'angelpay',
          idempotencyKey: `${s.venueId}-terminal-solo-saldo`,
        } as Parameters<typeof recordRefund>[1],
        s.staffId,
      )

      expect(r).toBeTruthy()
      const filas = await reembolsos(s)
      expect(filas).toHaveLength(1)
      expect(filas[0].amount.toNumber()).toBe(-200)
    })
  })
})
