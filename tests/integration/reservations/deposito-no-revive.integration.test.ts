/**
 * Integration (REAL DB) — hz:fefa11b6:D20, bloque 0b: el cobro de un depósito nunca revive lo que ya se cerró.
 *  - Reconfirmar desde la app de clientes sólo pasa a pagado un depósito PENDIENTE o VENCIDO de la misma sesión (antes: cualquiera
 *    que no fuera PAID, también uno DEVUELTO) y no vuelve a confirmar una reserva que una PERSONA canceló (la que el sistema canceló
 *    sólo porque venció el plazo del depósito sí se recupera, como siempre).
 *  - El aviso de Stripe tampoco re-confirma una cancelada: registra el cobro (el dinero sí entró) y lo devuelve solo; si la
 *    devolución no se completa, queda una alerta de dinero (una por sesión).
 *  - Pedir un enlace nuevo no reescribe «pendiente» sobre un depósito que se cobró mientras se preparaba el enlace.
 * Stripe no se toca: el proveedor va simulado; la base es real.
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'test'

const merchant: { id: string; platformFeeBps: number } = { id: '', platformFeeBps: 0 }
const provider = {
  getPaymentStatus: jest.fn(),
  createCheckoutSession: jest.fn(),
  expireAuthorizationCheckout: jest.fn(),
  refund: jest.fn(),
}
jest.mock('@/services/payments/provider-registry', () => ({ __esModule: true, getProvider: () => provider }))
jest.mock('@/services/payments/ecommerceCapability', () => ({
  __esModule: true,
  resolveChargeableStripeMerchant: jest.fn(async () => merchant),
}))
jest.mock('@/services/superadmin/platformSettings.service', () => ({ __esModule: true, getVatRateBps: jest.fn(async () => 1600) }))

import '../../__helpers__/integration-setup'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { createDepositCheckoutForConsumer, finalizeDepositCheckoutForConsumer } from '@/services/consumer/reservation.consumer.service'
import { processStripeConnectWebhookEvent } from '@/services/payments/reservation-deposit-webhook.service'

const RUN = Date.now()

describe('D20 0b — el cobro de un depósito no revive lo cerrado (integration, real DB)', () => {
  let orgId: string | undefined
  let venueId: string | undefined
  let venueSlug: string
  let consumerId: string | undefined
  let customerId: string
  let providerId: string

  const mkReservation = async (extra: Partial<Prisma.ReservationUncheckedCreateInput>) =>
    prisma.reservation.create({
      data: {
        venueId: venueId!,
        confirmationCode: `ITEST-DEP-${RUN}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
        startsAt: new Date(Date.now() + 86_400_000),
        endsAt: new Date(Date.now() + 90_000_000),
        blockedEndsAt: new Date(Date.now() + 90_000_000),
        duration: 60,
        status: 'PENDING',
        customerId,
        ecommerceMerchantId: merchant.id,
        guestName: 'Ana',
        depositAmount: new Prisma.Decimal(100),
        depositStatus: 'PENDING',
        checkoutSessionId: `cs_${RUN}_${Math.random().toString(36).slice(2, 9)}`,
        ...extra,
      },
    })

  const pagado = () => ({ status: 'PAID', paidAt: new Date(), paymentIntentId: 'pi_simulado' })
  const avisoDeStripe = (sessionId: string) => ({
    id: `evt_${Math.random().toString(36).slice(2, 12)}`,
    type: 'checkout.session.completed',
    account: 'acct_simulado',
    livemode: false,
    data: { id: sessionId, payment_status: 'paid', payment_intent: 'pi_simulado', metadata: { type: 'reservation_deposit' } },
  })
  const anomalias = (reservationId: string) => prisma.moneyAnomaly.findMany({ where: { reservationId } })

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: 'ITEST DEP Org', email: `itest-dep-${RUN}@test.com`, phone: '5550000000' },
    })
    orgId = org.id
    venueSlug = `itest-dep-${RUN}`
    const venue = await prisma.venue.create({
      data: {
        name: 'ITEST DEP Venue',
        slug: venueSlug,
        organizationId: org.id,
        address: 'X',
        city: 'X',
        state: 'X',
        country: 'MX',
        zipCode: '00000',
        timezone: 'America/Mexico_City',
      },
    })
    venueId = venue.id
    consumerId = (await prisma.consumer.create({ data: { email: `ana-dep-${RUN}@test.com` }, select: { id: true } })).id
    customerId = (await prisma.customer.create({ data: { venueId: venue.id, consumerId, firstName: 'Ana' }, select: { id: true } })).id
    // El enlace nuevo fija su comercio en la reserva (llave foránea) y la devolución lo busca como Stripe Connect: hace falta uno de
    // verdad, aunque Stripe vaya simulado. El proveedor se comparte con otras pruebas (código único): se reusa y no se borra.
    providerId = (
      await prisma.paymentProvider.upsert({
        where: { code: 'STRIPE_CONNECT' },
        create: { code: 'STRIPE_CONNECT', name: 'Stripe Connect', type: 'PAYMENT_PROCESSOR', countryCode: ['MX'] },
        update: {},
      })
    ).id
    merchant.id = (
      await prisma.ecommerceMerchant.create({
        data: {
          venueId: venue.id,
          businessName: 'Pagos en línea de prueba',
          contactEmail: `itest-dep-${RUN}@example.test`,
          publicKey: `pk_test_dep_${RUN}`,
          secretKeyHash: `hash-dep-${RUN}`,
          providerId,
          providerCredentials: {},
        },
      })
    ).id
  })

  beforeEach(() => {
    provider.getPaymentStatus.mockReset()
    provider.createCheckoutSession.mockReset()
    provider.expireAuthorizationCheckout.mockReset().mockResolvedValue(undefined)
    provider.refund.mockReset().mockResolvedValue({ status: 'SUCCEEDED', refundId: 're_simulado' })
  })

  afterAll(async () => {
    const step = (fn: () => Promise<unknown>) => fn().catch(() => {})
    if (venueId) {
      const ids = (await prisma.reservation.findMany({ where: { venueId }, select: { id: true } })).map(r => r.id)
      await step(() => prisma.moneyAnomaly.deleteMany({ where: { reservationId: { in: ids } } }))
      await step(() => prisma.processedStripeEvent.deleteMany({ where: { account: 'acct_simulado' } }))
      await step(() => prisma.reservation.deleteMany({ where: { venueId } }))
      await step(() => prisma.reservationSettings.deleteMany({ where: { venueId } }))
      await step(() => prisma.customer.deleteMany({ where: { venueId } }))
      await step(() => prisma.ecommerceMerchant.deleteMany({ where: { venueId } }))
      await step(() => prisma.venue.deleteMany({ where: { id: venueId } }))
    }
    if (consumerId) await step(() => prisma.consumer.deleteMany({ where: { id: consumerId } }))
    if (orgId) await step(() => prisma.organization.deleteMany({ where: { id: orgId } }))
  })

  describe('reconfirmar desde la app', () => {
    it('🔴 un depósito DEVUELTO no vuelve a quedar pagado', async () => {
      const r = await mkReservation({ status: 'CANCELLED', depositStatus: 'REFUNDED', depositRefundedAt: new Date() })
      provider.getPaymentStatus.mockResolvedValue(pagado())

      await expect(finalizeDepositCheckoutForConsumer(consumerId!, r.checkoutSessionId!)).rejects.toThrow(/cancelada/)

      const fila = await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } })
      expect(fila.depositStatus).toBe('REFUNDED')
      expect(fila.status).toBe('CANCELLED')
      expect(provider.refund).not.toHaveBeenCalled()
    })

    it('un depósito RETENIDO (no llegó) no vuelve a quedar pagado', async () => {
      const r = await mkReservation({ status: 'NO_SHOW', depositStatus: 'FORFEITED', depositPaidAt: new Date() })
      provider.getPaymentStatus.mockResolvedValue(pagado())
      await finalizeDepositCheckoutForConsumer(consumerId!, r.checkoutSessionId!)
      const fila = await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } })
      expect(fila.depositStatus).toBe('FORFEITED')
      expect(fila.status).toBe('NO_SHOW')
    })

    it('🔴 reserva que una persona CANCELÓ con depósito pendiente que sí se pagó: no se confirma, se devuelve sola y la app lo dice', async () => {
      const r = await mkReservation({ status: 'CANCELLED', cancelledBy: 'CUSTOMER', cancelledAt: new Date() })
      provider.getPaymentStatus.mockResolvedValue(pagado())

      await expect(finalizeDepositCheckoutForConsumer(consumerId!, r.checkoutSessionId!)).rejects.toThrow(/cancelada/)
      // La app vuelve a preguntar: misma respuesta, sin otra devolución ni otra alerta.
      await expect(finalizeDepositCheckoutForConsumer(consumerId!, r.checkoutSessionId!)).rejects.toThrow(/cancelada/)

      const fila = await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } })
      expect(fila.status).toBe('CANCELLED')
      expect(fila.depositStatus).toBe('REFUNDED')
      expect(fila.depositPaidAt).toBeTruthy()
      expect(provider.refund).toHaveBeenCalledTimes(1)
      // La alerta nace con el cobro (no se pierde si el proceso cae) y queda resuelta al devolverse.
      const a = await anomalias(r.id)
      expect(a.map(x => [x.category, x.resolvedAt !== null])).toEqual([['DEPOSIT_PAID_ON_CANCELLED_RESERVATION', true]])
    })

    it('si esa devolución automática falla: el cobro queda registrado y UNA alerta de dinero', async () => {
      const r = await mkReservation({ status: 'CANCELLED', cancelledBy: 'CUSTOMER', cancelledAt: new Date() })
      provider.getPaymentStatus.mockResolvedValue(pagado())
      provider.refund.mockRejectedValue(new Error('stripe caído'))

      await expect(finalizeDepositCheckoutForConsumer(consumerId!, r.checkoutSessionId!)).rejects.toThrow(/cancelada/)

      const fila = await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } })
      expect(fila.status).toBe('CANCELLED')
      expect(fila.depositStatus).toBe('PAID')
      expect(fila.refundStatus).toBe('FAILED')
      expect((await anomalias(r.id)).map(a => [a.category, a.resolvedAt])).toEqual([['DEPOSIT_PAID_ON_CANCELLED_RESERVATION', null]])
    })

    it('regresión: pendiente y pagado ⇒ PAID y CONFIRMED', async () => {
      const r = await mkReservation({})
      provider.getPaymentStatus.mockResolvedValue(pagado())
      const res = await finalizeDepositCheckoutForConsumer(consumerId!, r.checkoutSessionId!)
      expect(res).toEqual(expect.objectContaining({ status: 'CONFIRMED', depositStatus: 'PAID' }))
      expect(await anomalias(r.id)).toHaveLength(0)
    })

    it('regresión: el SISTEMA la canceló porque venció el plazo y el pago fue a tiempo ⇒ se recupera (PAID y CONFIRMED)', async () => {
      const r = await mkReservation({
        status: 'CANCELLED',
        cancelledBy: 'SYSTEM',
        cancellationReason: 'Reservation deposit payment window expired',
        cancelledAt: new Date(),
        depositStatus: 'EXPIRED',
      })
      provider.getPaymentStatus.mockResolvedValue(pagado())
      const res = await finalizeDepositCheckoutForConsumer(consumerId!, r.checkoutSessionId!)
      expect(res).toEqual(expect.objectContaining({ status: 'CONFIRMED', depositStatus: 'PAID' }))
      expect(provider.refund).not.toHaveBeenCalled()
    })

    it('🔴 una CLASE que canceló el negocio (también «SYSTEM») con depósito vencido no se re-confirma: se devuelve', async () => {
      const r = await mkReservation({
        status: 'CANCELLED',
        cancelledBy: 'SYSTEM',
        cancellationReason: 'Sesión cancelada por el establecimiento',
        cancelledAt: new Date(),
        depositStatus: 'EXPIRED',
      })
      provider.getPaymentStatus.mockResolvedValue(pagado())
      await expect(finalizeDepositCheckoutForConsumer(consumerId!, r.checkoutSessionId!)).rejects.toThrow(/cancelada/)
      const fila = await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } })
      expect(fila.status).toBe('CANCELLED')
      expect(fila.depositStatus).toBe('REFUNDED')
    })
  })

  describe('aviso de Stripe', () => {
    it('🔴 reserva que una persona CANCELÓ con depósito pendiente: registra el cobro, NO la confirma y lo devuelve', async () => {
      const r = await mkReservation({ status: 'CANCELLED', cancelledBy: 'staff-1', cancelledAt: new Date() })
      await processStripeConnectWebhookEvent(avisoDeStripe(r.checkoutSessionId!) as never)
      const fila = await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } })
      expect(fila.status).toBe('CANCELLED')
      expect(fila.depositStatus).toBe('REFUNDED')
      expect(fila.depositProcessorRef).toBe('pi_simulado')
      expect(provider.refund).toHaveBeenCalledTimes(1)
    })

    it('el aviso que llega DESPUÉS de que la app registró y devolvió el mismo cobro no deja una alerta falsa', async () => {
      const r = await mkReservation({ status: 'CANCELLED', cancelledBy: 'CUSTOMER', cancelledAt: new Date() })
      provider.getPaymentStatus.mockResolvedValue(pagado())
      await expect(finalizeDepositCheckoutForConsumer(consumerId!, r.checkoutSessionId!)).rejects.toThrow(/cancelada/)
      await processStripeConnectWebhookEvent(avisoDeStripe(r.checkoutSessionId!) as never)
      const a = await anomalias(r.id)
      expect(a.map(x => x.category)).toEqual(['DEPOSIT_PAID_ON_CANCELLED_RESERVATION'])
      expect(a[0].resolvedAt).not.toBeNull()
    })

    it('si el proceso cayó entre devolver y resolver la alerta, el aviso tardío del mismo cobro la resuelve', async () => {
      const r = await mkReservation({ status: 'CANCELLED', cancelledBy: 'CUSTOMER', cancelledAt: new Date() })
      provider.getPaymentStatus.mockResolvedValue(pagado())
      await expect(finalizeDepositCheckoutForConsumer(consumerId!, r.checkoutSessionId!)).rejects.toThrow(/cancelada/)
      // Simula la caída: devuelto, pero la alerta quedó abierta.
      await prisma.moneyAnomaly.updateMany({
        where: { reservationId: r.id },
        data: { resolvedAt: null, resolvedBy: null, resolution: null },
      })
      await processStripeConnectWebhookEvent(avisoDeStripe(r.checkoutSessionId!) as never)
      expect((await anomalias(r.id)).map(a => a.resolvedAt !== null)).toEqual([true])
    })

    it('regresión de la conciliación: vencer el plazo de una reserva que una persona ya canceló no cambia quién la canceló', async () => {
      const { reservationDepositReconciliationJob } = await import('@/jobs/reservation-deposit-reconciliation.job')
      const r = await mkReservation({
        status: 'CANCELLED',
        cancelledBy: 'staff-1',
        cancelledAt: new Date(),
        depositExpiresAt: new Date(Date.now() - 60_000),
      })
      await (reservationDepositReconciliationJob as any).expirePastDueReservations()
      const fila = await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } })
      expect(fila.depositStatus).toBe('EXPIRED')
      expect(fila.cancelledBy).toBe('staff-1')
      // …y por eso, si después llega el pago, NO se re-confirma.
      provider.getPaymentStatus.mockResolvedValue(pagado())
      await expect(finalizeDepositCheckoutForConsumer(consumerId!, r.checkoutSessionId!)).rejects.toThrow(/cancelada/)
      expect((await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('CANCELLED')
    })

    it('y si la devolución no se completa, queda la alerta (y la app no duplica la alerta)', async () => {
      const r = await mkReservation({ status: 'CANCELLED', cancelledBy: 'staff-1', cancelledAt: new Date() })
      provider.refund.mockRejectedValue(new Error('stripe caído'))
      await processStripeConnectWebhookEvent(avisoDeStripe(r.checkoutSessionId!) as never)
      provider.getPaymentStatus.mockResolvedValue(pagado())
      await expect(finalizeDepositCheckoutForConsumer(consumerId!, r.checkoutSessionId!)).rejects.toThrow(/cancelada/)
      const fila = await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } })
      expect(fila.depositStatus).toBe('PAID')
      expect((await anomalias(r.id)).map(a => a.category)).toEqual(['DEPOSIT_PAID_ON_CANCELLED_RESERVATION'])
    })

    it('regresión: reserva viva ⇒ PAID y CONFIRMED, sin alerta ni devolución', async () => {
      const r = await mkReservation({})
      await processStripeConnectWebhookEvent(avisoDeStripe(r.checkoutSessionId!) as never)
      const fila = await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } })
      expect(fila.status).toBe('CONFIRMED')
      expect(fila.depositStatus).toBe('PAID')
      expect(await anomalias(r.id)).toHaveLength(0)
      expect(provider.refund).not.toHaveBeenCalled()
    })

    it('el aviso de un enlace ANTERIOR (la reserva ya apunta a otro) no se registra sobre el enlace nuevo', async () => {
      const r = await mkReservation({})
      await processStripeConnectWebhookEvent(avisoDeStripe('cs_anterior_que_ya_no_es') as never)
      const fila = await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } })
      expect(fila.depositStatus).toBe('PENDING')
      expect(fila.status).toBe('PENDING')
    })
  })

  describe('enlace nuevo', () => {
    it('🔴 si el depósito se cobró mientras se preparaba el enlace, no se reescribe «pendiente» y se vence el enlace nuevo', async () => {
      const r = await mkReservation({})
      provider.createCheckoutSession.mockImplementation(async () => {
        // En medio, el aviso del enlace ANTERIOR marca el depósito pagado.
        await prisma.reservation.update({ where: { id: r.id }, data: { depositStatus: 'PAID', depositPaidAt: new Date() } })
        return { id: 'cs_nuevo', url: 'https://pago.simulado/cs_nuevo', expiresAt: new Date(Date.now() + 1_800_000) }
      })

      await expect(createDepositCheckoutForConsumer(consumerId!, venueSlug, r.cancelSecret)).rejects.toThrow(/cambió/)

      const fila = await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } })
      expect(fila.depositStatus).toBe('PAID')
      expect(fila.checkoutSessionId).toBe(r.checkoutSessionId)
      expect(provider.expireAuthorizationCheckout).toHaveBeenCalledWith(expect.anything(), 'cs_nuevo')
    })

    it('dos toques a la vez reciben de Stripe la MISMA sesión: el segundo no vence el enlace vigente', async () => {
      const r = await mkReservation({})
      const sesion = { id: `cs_gemela_${RUN}`, url: 'https://pago.simulado/gemela', expiresAt: new Date(Date.now() + 1_800_000) }
      provider.createCheckoutSession.mockImplementation(async () => {
        // El otro toque ya instaló esta misma sesión.
        await prisma.reservation.update({ where: { id: r.id }, data: { checkoutSessionId: sesion.id } })
        return sesion
      })
      const res = await createDepositCheckoutForConsumer(consumerId!, venueSlug, r.cancelSecret)
      expect(res.checkoutUrl).toBe(sesion.url)
      expect(provider.expireAuthorizationCheckout).not.toHaveBeenCalled()
    })

    it('regresión: depósito vencido ⇒ enlace nuevo y vuelve a pendiente', async () => {
      const r = await mkReservation({ depositStatus: 'EXPIRED' })
      provider.createCheckoutSession.mockResolvedValue({
        id: `cs_otro_${RUN}`,
        url: 'https://pago.simulado/cs_otro',
        expiresAt: new Date(Date.now() + 1_800_000),
      })
      const res = await createDepositCheckoutForConsumer(consumerId!, venueSlug, r.cancelSecret)
      expect(res.checkoutUrl).toBe('https://pago.simulado/cs_otro')
      const fila = await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } })
      expect(fila.depositStatus).toBe('PENDING')
      expect(fila.checkoutSessionId).toBe(`cs_otro_${RUN}`)
    })

    it('regresión: reserva hecha cuando el negocio no tenía pagos en línea (sin estado de depósito) ⇒ ahora sí puede pagarlo', async () => {
      const r = await mkReservation({ status: 'CONFIRMED', depositStatus: null, checkoutSessionId: null })
      provider.createCheckoutSession.mockResolvedValue({
        id: `cs_primero_${RUN}`,
        url: 'https://pago.simulado/cs_primero',
        expiresAt: new Date(Date.now() + 1_800_000),
      })
      await createDepositCheckoutForConsumer(consumerId!, venueSlug, r.cancelSecret)
      const fila = await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } })
      expect(fila.depositStatus).toBe('PENDING')
      expect(fila.checkoutSessionId).toBe(`cs_primero_${RUN}`)
    })
  })
})
