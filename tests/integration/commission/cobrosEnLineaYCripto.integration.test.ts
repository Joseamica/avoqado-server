// tests/integration/commission/cobrosEnLineaYCripto.integration.test.ts
/**
 * Fase 3 de Pago al personal, FT-GRAVES T2 (regla del founder, 8-oct): **un cobro COMPLETED con una persona atribuida genera
 * comisión según los esquemas; sin persona atribuida, no**. Contra Postgres REAL.
 *
 * - Liga de pago por Mercado Pago (`finalizeMercadoPagoCheckout`): las ligas por Stripe y Blumon ya congelaban la comisión de
 *   sus personas atribuidas con el cobro; la de Mercado Pago ni leía las atribuciones. Ahora hace lo MISMO que las otras dos:
 *   la primera persona atribuida queda como quien cobró y la comisión se congela con el cobro.
 * - Cripto B4Bit (`processWebhook` → `completeAndAttributeB4BitPaymentInTx`): el cobro lo inicia una persona en la terminal
 *   (`processedById`); al confirmarse comisiona con el mismo gancho que la terminal.
 * En los dos, la devolución revierte la comisión por el mecanismo de siempre.
 *
 * Correr: TZ=UTC TEST_DATABASE_URL="<base de prueba>" npx jest --selectProjects=integration \
 *   --runTestsByPath tests/integration/commission/cobrosEnLineaYCripto.integration.test.ts --ci --runInBand
 */
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { finalizeMercadoPagoCheckout } from '@/services/dashboard/paymentLink.service'
import { processWebhook } from '@/services/b4bit/b4bit.service'
import { issueRefund } from '@/services/dashboard/refund.dashboard.service'
import {
  asegurarBaseDePrueba,
  borrarMundoComisiones,
  crearMundoComisiones,
  MundoComisiones,
  netoVivo,
  procesarEfectos,
} from './_mundoComisiones'

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() },
}))
jest.mock('@/communication/sockets/managers/socketManager', () => ({ socketManager: { broadcastToVenue: jest.fn() } }))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn().mockResolvedValue({ notified: 0 }),
}))
jest.mock('@/services/shared/cashDrawerPosting', () => ({
  ...jest.requireActual('@/services/shared/cashDrawerPosting'),
  postCashSaleToDrawer: jest.fn().mockResolvedValue(undefined),
  postCashRefundToDrawer: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({ generateAndStoreReceipt: jest.fn().mockResolvedValue(undefined) }))

const PROVEEDOR = 'PAGO_F3_PRUEBA_MP'
const D = (n: number) => new Prisma.Decimal(n)
let m: MundoComisiones
beforeAll(asegurarBaseDePrueba)
beforeEach(async () => {
  m = await crearMundoComisiones('cobros-linea-cripto')
})
afterEach(() => borrarMundoComisiones(m))
afterAll(() => prisma.paymentProvider.deleteMany({ where: { code: PROVEEDOR } }))

async function comisionesDeLaOrden(orderId: string) {
  const filas = await prisma.commissionCalculation.findMany({
    where: { venueId: m.venueId, orderId, status: { not: 'VOIDED' } },
    orderBy: { staffId: 'asc' },
    take: 10,
  })
  return filas.map(f => [f.staffId, f.netCommission.toFixed(2)])
}

/** Una liga atribuida a estas personas, pagada por Mercado Pago. Devuelve el cobro que creó. */
async function ligaPagadaPorMercadoPago(staffIds: string[], monto = 200) {
  const proveedor = await prisma.paymentProvider.upsert({
    where: { code: PROVEEDOR },
    create: { code: PROVEEDOR, name: 'Mercado Pago (prueba)', type: 'PAYMENT_PROCESSOR' },
    update: {},
  })
  const canal = await prisma.ecommerceMerchant.create({
    data: {
      venueId: m.venueId,
      businessName: 'Liga MP',
      contactEmail: `${m.key}-mp@example.test`,
      publicKey: `pk_test_mp_${m.key}`,
      secretKeyHash: `hash-mp-${m.key}`,
      providerId: proveedor.id,
      providerCredentials: {},
    },
  })
  const liga = await prisma.paymentLink.create({
    data: {
      shortCode: Math.random().toString(36).slice(2, 10),
      venueId: m.venueId,
      ecommerceMerchantId: canal.id,
      createdById: m.owner,
      title: 'Clase muestra',
      amountType: 'FIXED',
      purpose: 'PAYMENT',
      attributions: staffIds.length > 0 ? { create: staffIds.map(staffId => ({ staffId })) } : undefined,
    },
  })
  const sessionId = `cs_mp_${m.key}_${randomUUID().slice(0, 6)}`
  await prisma.checkoutSession.create({
    data: {
      sessionId,
      ecommerceMerchantId: canal.id,
      amount: D(monto),
      expiresAt: new Date(Date.now() + 86_400_000),
      paymentLinkId: liga.id,
      metadata: { tipAmount: 0 },
    },
  })
  const mpPaymentId = `${Date.now()}${Math.floor(Math.random() * 1000)}`
  await finalizeMercadoPagoCheckout({ sessionId, mpPaymentId })
  return prisma.payment.findFirstOrThrow({ where: { venueId: m.venueId, processor: 'mercadopago', processorId: mpPaymentId } })
}

describe('T2 · liga de pago cobrada por Mercado Pago', () => {
  it('🔴 con una persona atribuida: queda como quien cobró, comisiona 10 % y la devolución la revierte', async () => {
    const pago = await ligaPagadaPorMercadoPago([m.bea])
    expect(pago.processedById).toBe(m.bea)
    await procesarEfectos(m)
    expect(await comisionesDeLaOrden(pago.orderId!)).toEqual([[m.bea, '20.00']])

    await issueRefund({ venueId: m.venueId, paymentId: pago.id, amount: 20_000, reason: 'RETURNED_GOODS', staffId: m.owner })
    await procesarEfectos(m)
    expect(await netoVivo({ venueId: m.venueId, orderId: pago.orderId! })).toBe('0.00')
  })

  it('🔴 dividida entre dos personas: $10 y $10, igual que la liga por Stripe', async () => {
    const pago = await ligaPagadaPorMercadoPago([m.ana, m.bea])
    await procesarEfectos(m)
    expect(await comisionesDeLaOrden(pago.orderId!)).toEqual(
      [
        [m.ana, '10.00'],
        [m.bea, '10.00'],
      ].sort((a, b) => a[0].localeCompare(b[0])),
    )
  })

  it('sin personas atribuidas: el cobro se registra y no hay comisión (no se inventa a quién)', async () => {
    const pago = await ligaPagadaPorMercadoPago([])
    expect(pago.processedById).toBeNull()
    await procesarEfectos(m)
    expect(await comisionesDeLaOrden(pago.orderId!)).toEqual([])
    expect(await prisma.paymentEffect.count({ where: { venueId: m.venueId, paymentId: pago.id, kind: 'COMMISSION' } })).toBe(0)
  })
})

describe('T2 · cobro en cripto (B4Bit), al confirmarse', () => {
  /** Un cobro cripto PENDIENTE de $100 iniciado en la terminal por `quien`, sobre una cuenta abierta. */
  async function criptoPendiente(quien: string | null) {
    const orden = await prisma.order.create({
      data: {
        venueId: m.venueId,
        orderNumber: `${m.key}-cripto-${randomUUID().slice(0, 6)}`,
        subtotal: D(100),
        discountAmount: D(0),
        taxAmount: D(0),
        total: D(100),
        paidAmount: D(0),
        remainingBalance: D(100),
        status: 'CONFIRMED',
        paymentStatus: 'PENDING',
      },
    })
    return prisma.payment.create({
      data: {
        venueId: m.venueId,
        orderId: orden.id,
        amount: D(100),
        tipAmount: D(0),
        method: 'CRYPTOCURRENCY',
        status: 'PENDING',
        source: 'TPV',
        type: 'FAST',
        processor: 'B4BIT',
        processedById: quien,
        feePercentage: 0,
        feeAmount: D(0),
        netAmount: D(100),
      },
    })
  }
  const confirmar = (paymentId: string) =>
    processWebhook({
      identifier: randomUUID(),
      reference: paymentId,
      fiat_amount: 100,
      fiat_currency: 'MXN',
      crypto_amount: '0.0010',
      currency: 'BTC',
      status: 'CO',
      tx_hash: `0x${randomUUID().replace(/-/g, '')}`,
      confirmations: 3,
    } as Parameters<typeof processWebhook>[0])

  it('🔴 con quien lo cobró en la terminal: comisiona 10 % al confirmarse, una sola vez aunque el aviso se repita, y la devolución la revierte', async () => {
    const pago = await criptoPendiente(m.ana)
    await confirmar(pago.id)
    await confirmar(pago.id) // B4Bit reentrega el aviso: no comisiona dos veces
    await procesarEfectos(m)
    expect(await comisionesDeLaOrden(pago.orderId!)).toEqual([[m.ana, '10.00']])

    await issueRefund({ venueId: m.venueId, paymentId: pago.id, amount: 10_000, reason: 'RETURNED_GOODS', staffId: m.owner })
    await procesarEfectos(m)
    expect(await netoVivo({ venueId: m.venueId, orderId: pago.orderId! })).toBe('0.00')
  })

  it('sin nadie que lo haya cobrado: se confirma y no hay comisión', async () => {
    const pago = await criptoPendiente(null)
    await confirmar(pago.id)
    await procesarEfectos(m)
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: pago.id } })).status).toBe('COMPLETED')
    expect(await comisionesDeLaOrden(pago.orderId!)).toEqual([])
  })
})
