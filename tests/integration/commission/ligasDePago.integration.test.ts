// tests/integration/commission/ligasDePago.integration.test.ts
/**
 * Fase 3 de pago por servicio (A5; spec §9-7, Codex r3-12; caso 23 del §13): la comisión de una liga de pago nace como
 * efecto durable EN la transacción del cobro. Si el proceso muere después del commit, el worker la crea; si la venta se
 * devuelve antes de que aparezca, el reverso la encuentra y el neto queda en $0.
 *
 * Correr: TZ=UTC TEST_DATABASE_URL="$PAGO_F3_DB" npx jest --selectProjects integration \
 *   --runTestsByPath tests/integration/commission/ligasDePago.integration.test.ts --ci
 */
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { finalizePaymentLinkCheckout } from '@/services/dashboard/paymentLink.service'
import { issueRefund } from '@/services/dashboard/refund.dashboard.service'
import {
  asegurarBaseDePrueba,
  borrarMundoComisiones,
  crearMundoComisiones,
  MundoComisiones,
  netoVivo,
  procesarEfectos,
} from './_mundoComisiones'

jest.mock('@/services/shared/cashDrawerPosting', () => ({ postCashRefundToDrawer: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({ generateAndStoreReceipt: jest.fn().mockResolvedValue(undefined) }))

const PROVEEDOR = 'PAGO_F3_PRUEBA'
let m: MundoComisiones
beforeAll(asegurarBaseDePrueba)
beforeEach(async () => {
  m = await crearMundoComisiones('liga')
})
afterEach(() => borrarMundoComisiones(m))
afterAll(() => prisma.paymentProvider.deleteMany({ where: { code: PROVEEDOR } }))

/** Una liga atribuida a estas personas, pagada por Stripe (webhook). Devuelve el cobro que creó. */
async function ligaPagada(staffIds: string[], monto = 200) {
  const proveedor = await prisma.paymentProvider.upsert({
    where: { code: PROVEEDOR },
    create: { code: PROVEEDOR, name: 'Pago F3 (prueba)', type: 'PAYMENT_PROCESSOR' },
    update: {},
  })
  const canal = await prisma.ecommerceMerchant.create({
    data: {
      venueId: m.venueId,
      businessName: 'Liga F3',
      contactEmail: `${m.key}-canal@example.test`,
      publicKey: `pk_test_${m.key}`,
      secretKeyHash: `hash-${m.key}`,
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
      attributions: { create: staffIds.map(staffId => ({ staffId })) },
    },
  })
  const sessionId = `cs_test_${m.key}`
  await prisma.checkoutSession.create({
    data: {
      sessionId,
      ecommerceMerchantId: canal.id,
      amount: new Prisma.Decimal(monto),
      expiresAt: new Date(Date.now() + 86_400_000),
      paymentLinkId: liga.id,
      metadata: { tipAmount: 0 },
    },
  })
  await finalizePaymentLinkCheckout({ stripeSessionId: sessionId, paymentIntentId: `pi_${m.key}` })
  return prisma.payment.findFirstOrThrow({ where: { venueId: m.venueId, processor: 'stripe' } })
}

describe('A5 · la comisión de una liga de pago se congela con el cobro (spec §9-7)', () => {
  it('🔴 dividida entre dos: al volver del cobro ya está en cola para las dos personas, y el worker la crea', async () => {
    const pago = await ligaPagada([m.ana, m.bea])
    const planes = await prisma.paymentEffect.findMany({ where: { venueId: m.venueId, paymentId: pago.id, kind: 'COMMISSION' }, take: 10 })
    expect(planes.map(p => (p.payload as { staffId: string }).staffId).sort()).toEqual([m.ana, m.bea].sort())
    await procesarEfectos(m)
    const filas = await prisma.commissionCalculation.findMany({ where: { venueId: m.venueId, paymentId: pago.id }, take: 10 })
    expect(filas.map(f => f.netCommission.toFixed(2))).toEqual(['10.00', '10.00'])
  })

  it('🔴 dividida entre TRES: las filas suman exacto lo cobrado, con el centavo de más en orden estable (plan r1-4)', async () => {
    const pago = await ligaPagada([m.owner, m.bea, m.ana], 100)
    await procesarEfectos(m)
    const filas = await prisma.commissionCalculation.findMany({
      where: { venueId: m.venueId, paymentId: pago.id },
      orderBy: { staffId: 'asc' },
      take: 10,
    })
    expect(filas.map(f => [f.baseAmount.toFixed(2), f.netCommission.toFixed(2)])).toEqual([
      ['33.34', '3.34'],
      ['33.33', '3.33'],
      ['33.33', '3.33'],
    ])
    const suma = (k: 'baseAmount' | 'netCommission') => filas.reduce((t, f) => t.add(f[k]), new Prisma.Decimal(0)).toFixed(2)
    expect([suma('baseAmount'), suma('netCommission')]).toEqual(['100.00', '10.00'])
  })

  it('una sola persona: el esquema decide a quién (como la terminal) y se lleva la comisión completa', async () => {
    const pago = await ligaPagada([m.bea])
    await procesarEfectos(m)
    const fila = await prisma.commissionCalculation.findFirstOrThrow({ where: { venueId: m.venueId, paymentId: pago.id } })
    expect([fila.staffId, fila.netCommission.toFixed(2)]).toEqual([m.bea, '20.00'])
  })

  it('🔴 venta devuelta ANTES de que se materialice su comisión: el neto queda en $0', async () => {
    const pago = await ligaPagada([m.ana, m.bea])
    await issueRefund({ venueId: m.venueId, paymentId: pago.id, amount: 20_000, reason: 'RETURNED_GOODS', staffId: m.owner })
    await procesarEfectos(m)
    expect(await netoVivo({ venueId: m.venueId, orderId: pago.orderId! })).toBe('0.00')
  })
})
