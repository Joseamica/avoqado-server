/**
 * El RECORRIDO DE LA PROMESA del «saldo a favor» (fase 2 del Cambio, IQ), por HTTP real contra Postgres real: las rutas, los
 * permisos, los validadores y los servicios son los de producción (sólo la identidad viene de cabeceras de prueba y WhatsApp es un
 * doble). Es la prueba REPETIBLE del recorrido que antes se hacía a mano en la SAMSUNG: nace ROJA (la función no existe) y se
 * vuelve verde conforme aterrizan S3 a S8c. Se corre al cerrar S5, S7, S10 y en A5 (plan 2026-10-31-saldo-a-favor, Task S0).
 *
 *   Paso 1  venta de $500 con tarjeta → Cambio por una prenda de $300 → $200 de saldo a favor para la clienta
 *   Paso 2  venta en efectivo → Reembolso de $150 a saldo a favor
 *   Paso 3  su ficha (DASHBOARD y POS) dice $350
 *   Paso 4  otra venta de $350 se cobra con su teléfono + el código que le llega por WhatsApp
 *   Paso 5  reenviar el Reembolso con la MISMA llave no duplica nada
 *   Paso 6  la base: UN solo sobre, sus tres movimientos y las dos devoluciones de las ventas originales
 *
 * Un paso que no puede correr porque uno anterior falló FALLA con un mensaje claro («No se puede probar este paso: …»); nunca se
 * salta en silencio. El bloque «Control» corre lo que ya funciona hoy por el MISMO camino (Cambio y Reembolso en efectivo, pedir el
 * código por teléfono): si falla, el rojo de los pasos no vale (sería la tubería de la prueba, no la función).
 *
 * Correr (en la nube, con su propia base; el veredicto está en el CUERPO, no en el exit):
 *   cd /Users/amieva/Documents/Programming/Avoqado && AVQ_TREE=$HOME/.claude/worktrees/saldo-a-favor/avoqado-server \
 *     ./scripts/avq-verify.sh avoqado-server npx jest --selectProjects integration --testPathPattern "recorridoDeLaPromesa" --ci
 */
import { randomUUID } from 'crypto'
import type { NextFunction, Request, Response } from 'express'
import type { Response as HttpResponse } from 'supertest'
import { Prisma } from '@prisma/client'

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() },
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
// 🔴 Nada sale a nadie: WhatsApp es un doble que recuerda a quién y qué código (así la prueba lo lee).
jest.mock('@/services/whatsapp.service', () => ({
  ...jest.requireActual('@/services/whatsapp.service'),
  sendOtpWhatsApp: (...args: unknown[]) => mockEnviarCodigo(...args),
}))
// La identidad del token: quién (`x-test-actor`) y con qué rol. Lo demás (permisos, validadores, servicios) es real.
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
import { encryptGiftCardCode, generateGiftCardCode, generateOpaqueToken, hashGiftCardCode } from '@/services/giftCards/giftCardCode'
import { ensureGiftCardTender } from '@/services/giftCards/giftCardTender'
import { seedCardSale, seedClothingSale } from '../exchanges/seedExchange'

const mockEnviarCodigo = jest.fn()

const express = require('express') as typeof import('express')
const request = require('supertest') as typeof import('supertest')
const mobileRouter = (require('@/routes/mobile.routes') as typeof import('@/routes/mobile.routes')).default

interface ErrorHttp {
  statusCode?: number
  message?: string
  code?: string
  details?: unknown
}
function appCon(montar: (app: ReturnType<typeof express>) => void) {
  const app = express()
  app.use(express.json())
  montar(app)
  app.use((error: ErrorHttp, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error.statusCode ?? 500).json({ success: false, message: error.message, code: error.code, details: error.details })
  })
  return app
}
const app = appCon(a => a.use('/api/v1/mobile', mobileRouter))
/** El router del DASHBOARD pesa: se monta la primera vez que una prueba lo pide. */
let appDashboard: ReturnType<typeof appCon> | undefined
function dashboard() {
  appDashboard ??= appCon(a =>
    a.use('/api/v1/dashboard', (require('@/routes/dashboard.routes') as typeof import('@/routes/dashboard.routes')).default),
  )
  return appDashboard
}

jest.setTimeout(120_000)

const APARATO = 'caja-recorrido-1'
const TELEFONO = '5512345678'
const E164 = `+52${TELEFONO}`
const LLAVE_REEMBOLSO = `recorrido-reembolso-${randomUUID().slice(0, 8)}`
const LLAVE_GASTO = `recorrido-gasto-${randomUUID().slice(0, 8)}`
const cents = (pesos: number) => pesos * 100

let s: Awaited<ReturnType<typeof seedCardSale>>
let control: Awaited<ReturnType<typeof seedClothingSale>>
let ventaEnEfectivo: { orderId: string; paymentId: string }

/** Lo que cada paso deja para el siguiente. */
const estado: {
  cambio?: { id: string; refundPaymentIds: string[] }
  sobreId?: string
  reembolso?: { refundId: string }
  codigo?: string
  prueba?: { proofToken: string; giftCardId: string }
  gasto?: { paymentId: string; orderId: string }
} = {}

const cabeceras = (staffId: string) => ({ 'x-test-actor': staffId, 'x-test-role': 'OWNER', 'x-device-id': APARATO })
const mobile = (venueId: string, ruta: string) => `/api/v1/mobile/venues/${venueId}${ruta}`
const POST = (url: string, body: object, staffId: string = s.staffId) => request(app).post(url).set(cabeceras(staffId)).send(body)
const GET = (url: string, staffId: string = s.staffId) => request(app).get(url).set(cabeceras(staffId))

/** Falla con TODO lo que respondió el servidor: el rojo de hoy tiene que decir por qué (estado, código y mensaje). */
function respondio(res: HttpResponse, status: number, paso: string): void {
  if (res.status !== status) {
    throw new Error(`${paso}: se esperaba HTTP ${status} y respondió HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 700)}`)
  }
}
/** Un paso que depende de otro no se salta: falla diciendo cuál no terminó. */
function requiere<T>(valor: T | undefined, queFalta: string): T {
  if (valor === undefined) throw new Error(`No se puede probar este paso: ${queFalta} no terminó (mira su rojo más arriba).`)
  return valor
}

/** Una venta YA cobrada en efectivo en la misma sucursal y de la misma clienta (como la deja el POS: PAID, con su cobro del cajón). */
async function sembrarVentaEnEfectivo(total: number, nombre: string) {
  const order = await prisma.order.create({
    data: {
      venueId: s.venueId,
      shiftId: s.shift.id,
      orderNumber: `RECORRIDO-${nombre}-${randomUUID().slice(0, 8)}`,
      type: 'TAKEOUT',
      source: 'AVOQADO_IOS',
      servedById: s.seller.id,
      createdById: s.seller.id,
      customerId: s.customer.id,
      status: 'COMPLETED',
      paymentStatus: 'PAID',
      kitchenStatus: 'SERVED',
      contratoDePrecio: 'IVA_INCLUIDO',
      subtotal: total,
      discountAmount: 0,
      taxAmount: 0,
      total,
      paidAmount: total,
      remainingBalance: 0,
      orderCustomers: { create: { customerId: s.customer.id, isPrimary: true } },
      items: {
        create: { productId: s.products[4].id, productName: 'Top', quantity: 1, unitPrice: total, discountAmount: 0, taxAmount: 0, total },
      },
    },
  })
  const payment = await prisma.payment.create({
    data: {
      venueId: s.venueId,
      orderId: order.id,
      shiftId: s.shift.id,
      amount: total,
      tipAmount: 0,
      netAmount: total,
      feeAmount: 0,
      feePercentage: 0,
      method: 'CASH',
      source: 'POS',
      fundsFlow: 'CASH_DRAWER',
      status: 'COMPLETED',
      type: 'REGULAR',
      splitType: 'FULLPAYMENT',
      processedById: s.seller.id,
    },
  })
  return { orderId: order.id, paymentId: payment.id }
}

/** Un sobre de tarjeta de regalo ACTIVO, mandado por WhatsApp a `telefono`: el camino que el saldo a favor reusa para gastarse. */
async function sembrarSobreDeTelefono(x: { venueId: string; organizationId: string }, telefono: string, monto: number) {
  const codigo = generateGiftCardCode()
  const pesos = new Prisma.Decimal(monto)
  const sobre = await prisma.giftCard.create({
    data: {
      venueId: x.venueId,
      organizationId: x.organizationId,
      codeHash: hashGiftCardCode(codigo.normalized),
      codeEnc: encryptGiftCardCode(codigo.normalized),
      codeLast4: codigo.last4,
      pageToken: generateOpaqueToken(),
      initialAmount: pesos,
      balance: pesos,
      status: 'ACTIVE',
      activatedAt: new Date(),
      termsVersion: '2026-10-14',
      deliveryChannel: 'WHATSAPP',
      recipientPhone: telefono,
      recipientName: 'Ana',
      deliveryStatus: 'SENT',
    },
  })
  await prisma.giftCardActivity.create({
    data: { giftCardId: sobre.id, venueId: x.venueId, type: 'ACTIVATE', amount: pesos, balanceAfter: pesos },
  })
  await ensureGiftCardTender(prisma, x.venueId)
  return sobre.id
}

/** El código que el doble de WhatsApp «mandó» a ese teléfono (el envío es en segundo plano: se espera hasta 2 s). */
async function esperarCodigoEnviadoA(destino: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const llamada = [...mockEnviarCodigo.mock.calls].reverse().find(c => c[0] === destino)
    if (llamada) return llamada[1] as string
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(
    `No salió ningún código por WhatsApp a ${destino}: ningún sobre de saldo a favor se encuentra por el teléfono de la clienta.`,
  )
}

/** Lo que la base dice del dinero de la clienta: para comparar antes y después de reenviar. */
async function fotoDelSaldo() {
  const [sobres, movimientos, devolucionesASaldo] = await Promise.all([
    prisma.giftCard.findMany({ where: { venueId: s.venueId }, select: { id: true, balance: true }, take: 20 }),
    prisma.giftCardActivity.count({ where: { venueId: s.venueId } }),
    prisma.payment.count({ where: { venueId: s.venueId, type: 'REFUND', tenderType: { systemKind: 'STORE_CREDIT' } } }),
  ])
  return { sobres: sobres.map(x => [x.id, x.balance.toNumber()]), movimientos, devolucionesASaldo }
}

beforeAll(async () => {
  mockEnviarCodigo.mockResolvedValue(true)
  s = await seedCardSale({ provider: 'BLUMON', amounts: [500] }) // venta de $500 pagada con tarjeta (TPV), de la clienta
  control = await seedClothingSale() // otra sucursal, sólo para el bloque «Control»
  for (const x of [s, control]) {
    await prisma.staffVenue.updateMany({ where: { venueId: x.venueId, staffId: x.staffId }, data: { role: 'OWNER' } })
    await prisma.product.update({ where: { id: x.products[3].id }, data: { price: new Prisma.Decimal(300) } }) // la prenda de $300
  }
  await prisma.customer.update({ where: { id: s.customer.id }, data: { firstName: 'Clienta', lastName: 'Prueba', phone: TELEFONO } })
  ventaEnEfectivo = await sembrarVentaEnEfectivo(300, 'EFECTIVO')
})

afterAll(async () => {
  for (const x of [s, control]) {
    // La libreta es de sólo inserción: los sobres se quedan en la base desechable. Una limpieza que falla no tapa el veredicto.
    if (x?.venueId) await x.cleanup().catch(error => console.warn('recorridoDeLaPromesa: la limpieza no terminó', String(error)))
  }
})

describe('Recorrido de la promesa · saldo a favor', () => {
  describe('Control · lo que ya funciona hoy por el mismo camino (si falla, el rojo de abajo no vale)', () => {
    it('un Cambio por una prenda más barata, devuelto en efectivo, responde 201', async () => {
      const res = await POST(
        mobile(control.venueId, '/exchanges'),
        control.body({
          taken: [{ productId: control.products[3].id, quantity: 1 }],
          settlement: { kind: 'PAYOUT', method: 'CASH', expectedDifferenceCents: -cents(200), cashDrawerSessionId: control.drawer.id },
        }),
        control.staffId,
      )
      respondio(res, 201, 'Control · Cambio en efectivo')
      expect(res.body.data.exchange.settlement).toMatchObject({ kind: 'PAYOUT', method: 'CASH', amountCents: cents(200) })
    })

    it('un Reembolso de una venta en efectivo, como se pagó, responde 201', async () => {
      const chica = await sembrarVentaEnEfectivo(20, 'CONTROL')
      const res = await POST(mobile(s.venueId, `/payments/${chica.paymentId}/refund`), { amount: cents(10), reason: 'RETURNED_GOODS' })
      respondio(res, 201, 'Control · Reembolso en efectivo')
      expect(res.body.data).toMatchObject({ amount: 10 })
    })

    it('una venta con tarjeta de la TPV NO se devuelve en efectivo: 422 INSUFFICIENT_FOR_METHOD (lo que el saldo a favor viene a resolver)', async () => {
      const res = await POST(mobile(s.venueId, '/exchanges'), {
        ...s.body({ taken: [{ productId: s.products[3].id, quantity: 1 }] }),
        settlement: { kind: 'PAYOUT', method: 'CASH', expectedDifferenceCents: -cents(200) },
      })
      respondio(res, 422, 'Control · Cambio en efectivo de una venta con tarjeta')
      expect(res.body.details).toMatchObject({ reason: 'INSUFFICIENT_FOR_METHOD' })
      // No escribió nada: el Paso 1 parte de una venta intacta.
      expect(await prisma.exchange.count({ where: { venueId: s.venueId } })).toBe(0)
    })

    it('pedir el código por teléfono responde 200 aunque ese teléfono no tenga tarjetas', async () => {
      const res = await POST(mobile(s.venueId, '/gift-cards/phone/request'), { phone: '5500000000' })
      respondio(res, 200, 'Control · pedir código por teléfono')
      expect(res.body.data).toEqual({ enviado: true })
    })

    it('la ficha de la clienta responde 200 en el DASHBOARD y en la lista del POS (todavía sin storeCredit)', async () => {
      const detalle = await request(dashboard())
        .get(`/api/v1/dashboard/venues/${s.venueId}/customers/${s.customer.id}`)
        .set(cabeceras(s.staffId))
      respondio(detalle, 200, 'Control · ficha en el DASHBOARD')
      expect(detalle.body).toMatchObject({ id: s.customer.id })
      const lista = await GET(mobile(s.venueId, '/customers'))
      respondio(lista, 200, 'Control · lista de clientes del POS')
      expect((lista.body.data as Array<{ id: string }>).map(c => c.id)).toContain(s.customer.id)
    })

    it('teléfono + código cobra una venta nueva de $50 con el sobre de una tarjeta de regalo (el camino que el saldo a favor reusa)', async () => {
      const telefono = '5598765432'
      const giftCardId = await sembrarSobreDeTelefono(control, telefono, 50)
      mockEnviarCodigo.mockClear()
      respondio(
        await POST(mobile(control.venueId, '/gift-cards/phone/request'), { phone: telefono }, control.staffId),
        200,
        'Control · pedir código',
      )
      const verificado = await POST(
        mobile(control.venueId, '/gift-cards/phone/verify'),
        { phone: telefono, code: await esperarCodigoEnviadoA(`+52${telefono}`) },
        control.staffId,
      )
      respondio(verificado, 200, 'Control · verificar código')
      expect(verificado.body.data.cards).toEqual([expect.objectContaining({ giftCardId, balance: 50, usable: true })])
      const cobro = await POST(
        mobile(control.venueId, '/gift-cards/pay-new-order'),
        {
          idempotencyKey: `control-gasto-${randomUUID().slice(0, 8)}`,
          proof: { kind: 'PHONE_OTP', proofToken: verificado.body.data.proofToken, giftCardId },
          amount: 50,
          tip: 0,
          items: [{ name: 'Blusa', quantity: 1, unitPrice: cents(50) }],
          staffId: control.staffId,
          orderType: 'TAKEOUT',
          source: 'AVOQADO_ANDROID',
        },
        control.staffId,
      )
      respondio(cobro, 200, 'Control · cobrar con teléfono + código')
      expect(cobro.body.data).toMatchObject({
        amount: 50,
        orderPaymentStatus: 'PAID',
        redeemed: [expect.objectContaining({ giftCardId, amount: 50, balanceAfter: 0 })],
      })
    })
  })

  describe('Paso 1 · venta de $500 con tarjeta → Cambio por una prenda de $300 → $200 de saldo a favor para la clienta', () => {
    it('el Cambio con STORE_CREDIT responde 201 y dice a quién y cuánto: $200, saldo nuevo $200', async () => {
      const res = await POST(mobile(s.venueId, '/exchanges'), {
        ...s.body({ taken: [{ productId: s.products[3].id, quantity: 1 }] }),
        settlement: { kind: 'PAYOUT', method: 'STORE_CREDIT', expectedDifferenceCents: -cents(200), customerId: s.customer.id },
      })
      respondio(res, 201, 'Paso 1 · Cambio a saldo a favor')
      estado.cambio = res.body.data.exchange
      expect(res.body.data.exchange.settlement).toMatchObject({
        kind: 'PAYOUT',
        method: 'STORE_CREDIT',
        amountCents: cents(200),
        storeCredit: {
          customerId: s.customer.id,
          customerName: expect.stringContaining('Clienta'),
          amountCents: cents(200),
          newBalanceCents: cents(200),
          phoneLast4: TELEFONO.slice(-4),
          phoneMismatch: false,
        },
      })
    })

    it('la clienta queda con UN sobre ACTIVO de $200 a su nombre', async () => {
      requiere(estado.cambio, 'el Cambio del paso 1')
      const sobres = await prisma.giftCard.findMany({ where: { venueId: s.venueId, customerId: s.customer.id }, take: 5 })
      expect(sobres).toHaveLength(1)
      expect(sobres[0].status).toBe('ACTIVE')
      expect(sobres[0].balance.toNumber()).toBe(200)
      estado.sobreId = sobres[0].id
    })
  })

  describe('Paso 2 · venta en efectivo → Reembolso de $150 a saldo a favor', () => {
    it('el Reembolso del POS con STORE_CREDIT responde 201 y suma al MISMO sobre: saldo nuevo $350', async () => {
      // Sin `requiere` a propósito: el Reembolso es una puerta propia y su rojo de hoy tiene que verse aunque el Cambio falle.
      const res = await POST(mobile(s.venueId, `/payments/${ventaEnEfectivo.paymentId}/refund`), {
        amount: cents(150),
        reason: 'RETURNED_GOODS',
        refundMethod: 'STORE_CREDIT',
        customerId: s.customer.id,
        idempotencyKey: LLAVE_REEMBOLSO,
      })
      respondio(res, 201, 'Paso 2 · Reembolso a saldo a favor')
      estado.reembolso = res.body.data
      expect(res.body.data).toMatchObject({
        amount: 150,
        storeCredit: {
          customerId: s.customer.id,
          customerName: expect.stringContaining('Clienta'),
          amountCents: cents(150),
          newBalanceCents: cents(350),
          phoneLast4: TELEFONO.slice(-4),
          phoneMismatch: false,
        },
      })
    })
  })

  describe('Paso 3 · su ficha (DASHBOARD y POS) dice $350', () => {
    const fichaEsperada = () => ({
      balanceCents: cents(350),
      phoneLast4: TELEFONO.slice(-4),
      giftCardId: requiere(estado.sobreId, 'el paso 1 (Cambio a saldo a favor)'),
    })

    it('el detalle de la clienta en el DASHBOARD trae storeCredit con $350', async () => {
      requiere(estado.reembolso, 'el paso 2 (Reembolso a saldo a favor)')
      const res = await request(dashboard())
        .get(`/api/v1/dashboard/venues/${s.venueId}/customers/${s.customer.id}`)
        .set(cabeceras(s.staffId))
      respondio(res, 200, 'Paso 3 · ficha en el DASHBOARD')
      expect(res.body.storeCredit).toEqual(fichaEsperada())
    })

    it('la lista de clientes del POS trae storeCredit con $350 en la fila de la clienta', async () => {
      requiere(estado.reembolso, 'el paso 2 (Reembolso a saldo a favor)')
      const res = await GET(mobile(s.venueId, '/customers'))
      respondio(res, 200, 'Paso 3 · ficha en el POS')
      const fila = (res.body.data as Array<{ id: string; storeCredit?: unknown }>).find(c => c.id === s.customer.id)
      expect(fila).toBeDefined()
      expect(fila?.storeCredit).toEqual(fichaEsperada())
    })
  })

  describe('Paso 4 · otra venta de $350 se cobra con su teléfono + el código que le llega por WhatsApp', () => {
    it('pedir el código manda el WhatsApp al teléfono de la ficha', async () => {
      requiere(estado.reembolso, 'el paso 2 (Reembolso a saldo a favor)')
      mockEnviarCodigo.mockClear()
      const res = await POST(mobile(s.venueId, '/gift-cards/phone/request'), { phone: TELEFONO })
      respondio(res, 200, 'Paso 4 · pedir el código')
      estado.codigo = await esperarCodigoEnviadoA(E164)
      expect(estado.codigo).toMatch(/^\d{6}$/)
    })

    it('verificar el código lista UN sobre usable de $350', async () => {
      const codigo = requiere(estado.codigo, 'pedir el código del paso 4')
      const res = await POST(mobile(s.venueId, '/gift-cards/phone/verify'), { phone: TELEFONO, code: codigo })
      respondio(res, 200, 'Paso 4 · verificar el código')
      expect(res.body.data.usableBalance).toBe(350)
      expect(res.body.data.cards).toHaveLength(1)
      expect(res.body.data.cards[0]).toMatchObject({ giftCardId: estado.sobreId, balance: 350, usable: true })
      estado.prueba = { proofToken: res.body.data.proofToken, giftCardId: res.body.data.cards[0].giftCardId }
    })

    it('cobrar la venta de $350 con teléfono + código la deja pagada y el sobre en $0', async () => {
      const prueba = requiere(estado.prueba, 'verificar el código del paso 4')
      const res = await POST(mobile(s.venueId, '/gift-cards/pay-new-order'), {
        idempotencyKey: LLAVE_GASTO,
        proof: { kind: 'PHONE_OTP', proofToken: prueba.proofToken, giftCardId: prueba.giftCardId },
        amount: 350,
        tip: 0,
        items: [{ name: 'Blusa', quantity: 1, unitPrice: cents(350) }],
        staffId: s.staffId,
        orderType: 'TAKEOUT',
        source: 'AVOQADO_ANDROID',
      })
      respondio(res, 200, 'Paso 4 · cobrar con saldo')
      estado.gasto = res.body.data
      expect(res.body.data).toMatchObject({
        amount: 350,
        orderPaymentStatus: 'PAID',
        redeemed: [expect.objectContaining({ giftCardId: prueba.giftCardId, amount: 350, balanceAfter: 0 })],
      })
    })
  })

  describe('Paso 5 · reenviar el Reembolso con la MISMA llave no duplica nada', () => {
    it('el reenvío devuelve el mismo reembolso y no mueve ni el saldo, ni la libreta, ni las devoluciones', async () => {
      const original = requiere(estado.reembolso, 'el paso 2 (Reembolso a saldo a favor)')
      requiere(estado.gasto, 'el paso 4 (cobro con teléfono + código)')
      const antes = await fotoDelSaldo()
      const res = await POST(mobile(s.venueId, `/payments/${ventaEnEfectivo.paymentId}/refund`), {
        amount: cents(150),
        reason: 'RETURNED_GOODS',
        refundMethod: 'STORE_CREDIT',
        customerId: s.customer.id,
        idempotencyKey: LLAVE_REEMBOLSO,
      })
      respondio(res, 201, 'Paso 5 · reenviar el Reembolso')
      expect(res.body.data.refundId).toBe(original.refundId)
      expect(await fotoDelSaldo()).toEqual(antes)
    })
  })

  describe('Paso 6 · la base: UN solo sobre, sus tres movimientos y las dos devoluciones de las ventas originales', () => {
    it('hay un solo sobre en la sucursal, de la clienta y en $0', async () => {
      requiere(estado.gasto, 'el paso 4 (cobro con teléfono + código)')
      const sobres = await prisma.giftCard.findMany({ where: { venueId: s.venueId }, take: 5 })
      expect(sobres).toHaveLength(1)
      expect(sobres[0]).toMatchObject({ id: estado.sobreId, customerId: s.customer.id, status: 'ACTIVE' })
      expect(sobres[0].balance.toNumber()).toBe(0)
    })

    it('la libreta tiene exactamente: abono del Cambio $200, abono del Reembolso $150 y el cobro de $350', async () => {
      const cambio = requiere(estado.cambio, 'el paso 1 (Cambio a saldo a favor)')
      const reembolso = requiere(estado.reembolso, 'el paso 2 (Reembolso a saldo a favor)')
      const gasto = requiere(estado.gasto, 'el paso 4 (cobro con teléfono + código)')
      const movimientos = await prisma.giftCardActivity.findMany({
        where: { venueId: s.venueId, giftCardId: estado.sobreId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 20,
      })
      expect(movimientos.map(m => [m.type, m.amount.toNumber(), m.balanceAfter.toNumber()])).toEqual([
        ['ACTIVATE', 200, 200],
        ['ADJUST_INCREMENT', 150, 350],
        ['REDEEM', 350, 0],
      ])
      expect(cambio.refundPaymentIds).toContain(movimientos[0].refundPaymentId)
      expect(movimientos[1].refundPaymentId).toBe(reembolso.refundId)
      expect(movimientos[2].paymentId).toBe(gasto.paymentId)
    })

    it('cada abono es la devolución de SU venta original, con el medio «Saldo a favor» (STORE_CREDIT)', async () => {
      requiere(estado.gasto, 'el paso 4 (cobro con teléfono + código)')
      const devoluciones = await prisma.payment.findMany({
        where: { venueId: s.venueId, type: 'REFUND', tenderType: { systemKind: 'STORE_CREDIT' } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 10,
      })
      expect(devoluciones.map(d => d.amount.toNumber())).toEqual([-200, -150])
      expect(devoluciones.map(d => (d.processorData as { originalPaymentId?: string } | null)?.originalPaymentId)).toEqual([
        s.payments[0].id,
        ventaEnEfectivo.paymentId,
      ])
    })
  })
})
