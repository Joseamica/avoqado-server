// tests/integration/dashboard/ligaStripeDobleAviso.integration.test.ts
/**
 * Liga de pago por Stripe: dos avisos del MISMO cobro que llegan a la vez (o un reintento) dejan UNA venta. El candado de
 * afuera (`status === 'COMPLETED'`) se lee fuera de la transacción, así que las dos llamadas lo pasan; lo que impide la
 * segunda orden es la llave única `Payment_venueId_idempotencyKey_key` (= el `pi_…`): la segunda transacción choca ahí y se
 * deshace entera (orden, contadores de la liga, vale de inventario). La lealtad y las métricas del cliente corren después
 * del commit, sólo en la que ganó. Postgres REAL.
 * Medido el 12-nov: con `paymentIntentId: null` las dos llamadas registran (2 órdenes, 2 pagos, la clienta cuenta doble). Hoy
 * ningún llamador lo manda nulo (el webhook sólo finaliza sesiones `paid`, que siempre traen `pi_…`); si alguno lo hiciera,
 * hace falta un CAS sobre la sesión dentro de la transacción. Reporte: docs/audit/2026-11-12-liga-stripe-doble-aviso/.
 *
 * Correr: TEST_DATABASE_URL=<base desechable> npx jest --selectProjects integration \
 *   --runTestsByPath tests/integration/dashboard/ligaStripeDobleAviso.integration.test.ts --ci
 */
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { finalizePaymentLinkCheckout } from '@/services/dashboard/paymentLink.service'
import { barreraDeFila, borrarMundoComisiones, crearMundoComisiones, MundoComisiones } from '../commission/_mundoComisiones'

const PROVEEDOR = 'LIGA_DOBLE_AVISO_PRUEBA'
let m: MundoComisiones

beforeEach(async () => {
  m = await crearMundoComisiones('liga-doble')
})
afterEach(() => borrarMundoComisiones(m))
afterAll(() => prisma.paymentProvider.deleteMany({ where: { code: PROVEEDOR } }))

/** Una liga de $200 atribuida a Ana, con una clienta registrada, y su sesión de Stripe pendiente de cobrar. */
async function sesionPendiente() {
  const proveedor = await prisma.paymentProvider.upsert({
    where: { code: PROVEEDOR },
    create: { code: PROVEEDOR, name: 'Liga doble aviso (prueba)', type: 'PAYMENT_PROCESSOR' },
    update: {},
  })
  const canal = await prisma.ecommerceMerchant.create({
    data: {
      venueId: m.venueId,
      businessName: 'Liga doble aviso',
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
      attributions: { create: [{ staffId: m.ana }] },
    },
  })
  const cliente = await prisma.customer.create({
    data: { venueId: m.venueId, email: `${m.key}-cliente@example.test`, firstName: 'Clienta', active: true },
  })
  const sesion = await prisma.checkoutSession.create({
    data: {
      sessionId: `cs_test_${m.key}`,
      ecommerceMerchantId: canal.id,
      amount: new Prisma.Decimal(200),
      expiresAt: new Date(Date.now() + 86_400_000),
      paymentLinkId: liga.id,
      attributedCustomerId: cliente.id,
      metadata: { tipAmount: 0 },
    },
  })
  return { sesion, ligaId: liga.id, clienteId: cliente.id, aviso: { stripeSessionId: sesion.sessionId, paymentIntentId: `pi_${m.key}` } }
}

/** Lo que quedó registrado para esta liga: debe ser UNA venta, contada una vez. */
async function registrado(ligaId: string, clienteId: string) {
  const [ordenes, pagos, liga, cliente, efectos] = await Promise.all([
    prisma.order.count({ where: { venueId: m.venueId, source: 'PAYMENT_LINK' } }),
    prisma.payment.count({ where: { venueId: m.venueId, processor: 'stripe' } }),
    prisma.paymentLink.findUniqueOrThrow({ where: { id: ligaId }, select: { paymentCount: true, totalCollected: true } }),
    prisma.customer.findUniqueOrThrow({ where: { id: clienteId }, select: { totalVisits: true, totalSpent: true } }),
    prisma.paymentEffect.count({ where: { venueId: m.venueId, kind: 'COMMISSION' } }),
  ])
  return {
    ordenes,
    pagos,
    cobrosDeLaLiga: liga.paymentCount,
    cobradoPorLaLiga: liga.totalCollected.toFixed(2),
    visitasDeLaClienta: cliente.totalVisits,
    gastoDeLaClienta: cliente.totalSpent.toFixed(2),
    comisionesEnCola: efectos,
  }
}

const UNA_VENTA = {
  ordenes: 1,
  pagos: 1,
  cobrosDeLaLiga: 1,
  cobradoPorLaLiga: '200.00',
  visitasDeLaClienta: 1,
  gastoDeLaClienta: '200.00',
  comisionesEnCola: 1,
}

describe('Liga por Stripe: el mismo cobro avisado dos veces deja UNA venta', () => {
  it('🔴 dos avisos a la vez, los dos pasan el candado de afuera: una orden, un pago, la clienta cuenta una vez', async () => {
    const { sesion, ligaId, clienteId, aviso } = await sesionPendiente()
    // La barrera detiene a los dos DESPUÉS de leer la sesión PENDIENTE (fuera de la transacción) y antes de marcarla: así las
    // dos llamadas pasan el `status === 'COMPLETED'` de afuera, que es exactamente la carrera que se sospechaba.
    const barrera = await barreraDeFila('CheckoutSession', sesion.id)
    let resultados: PromiseSettledResult<void>[]
    try {
      const avisos = Promise.allSettled([finalizePaymentLinkCheckout(aviso), finalizePaymentLinkCheckout(aviso)])
      await barrera.esperarA(2)
      await barrera.soltar()
      resultados = await avisos
    } finally {
      await barrera.soltar()
    }

    expect(await registrado(ligaId, clienteId)).toEqual(UNA_VENTA)
    expect(resultados.filter(r => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1)
    // La que pierde sólo puede caer por la llave del cobro (el `pi_…`), nunca por otra cosa a medias.
    for (const r of resultados.filter((r): r is PromiseRejectedResult => r.status === 'rejected')) {
      expect(r.reason?.code).toBe('P2002')
      expect(String(r.reason?.meta?.target ?? '')).toContain('idempotencyKey')
    }
  })

  it('un reintento después de registrado no hace nada y no lanza', async () => {
    const { ligaId, clienteId, aviso } = await sesionPendiente()
    await finalizePaymentLinkCheckout(aviso)
    await expect(finalizePaymentLinkCheckout(aviso)).resolves.toBeUndefined()
    expect(await registrado(ligaId, clienteId)).toEqual(UNA_VENTA)
  })
})
