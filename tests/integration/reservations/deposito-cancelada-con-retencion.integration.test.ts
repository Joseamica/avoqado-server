/**
 * Integration (REAL DB) — el depósito que se cobra sobre una reserva YA cancelada se devuelve completo, aunque el negocio retenga el
 * depósito por cancelación tardía (hz:0caed727:D9).
 *
 * La carrera: la cancelación confirma su transacción con el depósito PENDIENTE; el aviso de Stripe registra el cobro sobre la reserva
 * cancelada (y quiere devolverlo sin retener); y la cancelación, ya fuera de su transacción, lee ese depósito como PAGADO y le aplica
 * la retención. (a) Si la retención escribe primero, la devolución ya no hace nada. (b) Si la devolución termina primero, la
 * retención la pisa y Avoqado dice «retenido» de un dinero que Stripe ya devolvió.
 * La regla (decidida en el bloque 0b): la retención sólo aplica a un depósito que ya estaba pagado AL CANCELAR.
 * Stripe no se toca: el proveedor va simulado; la base es real. El orden se fija con un espía sobre la lectura del depósito.
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'test'

const provider = { refund: jest.fn() }
jest.mock('@/services/payments/provider-registry', () => ({ __esModule: true, getProvider: () => provider }))

import '../../__helpers__/integration-setup'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { aTiempo } from '@tests/__helpers__/candadosDePostgres'
import { cancelReservation, handleReservationDepositCancellation } from '@/services/dashboard/reservation.dashboard.service'
import { processStripeConnectWebhookEvent } from '@/services/payments/reservation-deposit-webhook.service'

const RUN = Date.now()
const CUENTA = 'acct_simulado_retencion'
const HORA = 3_600_000

describe('depósito cobrado sobre una reserva cancelada, con retención por cancelación tardía (integration, real DB)', () => {
  let orgId: string | undefined
  let venueId: string | undefined
  let merchantId: string

  const mkReservation = async (extra: Partial<Prisma.ReservationUncheckedCreateInput>) =>
    prisma.reservation.create({
      data: {
        venueId: venueId!,
        confirmationCode: `ITEST-RET-${RUN}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
        // Dentro de 1 h: con la política de abajo (24 h) toda cancelación es tardía y el negocio se quedaría el depósito.
        startsAt: new Date(Date.now() + HORA),
        endsAt: new Date(Date.now() + 2 * HORA),
        blockedEndsAt: new Date(Date.now() + 2 * HORA),
        duration: 60,
        status: 'PENDING',
        ecommerceMerchantId: merchantId,
        guestName: 'Ana',
        depositAmount: new Prisma.Decimal(100),
        depositStatus: 'PENDING',
        checkoutSessionId: `cs_ret_${RUN}_${Math.random().toString(36).slice(2, 9)}`,
        ...extra,
      },
    })

  const avisoDeStripe = (sessionId: string) => ({
    id: `evt_ret_${Math.random().toString(36).slice(2, 12)}`,
    type: 'checkout.session.completed',
    account: CUENTA,
    livemode: false,
    data: { id: sessionId, payment_status: 'paid', payment_intent: 'pi_simulado', metadata: { type: 'reservation_deposit' } },
  })
  const fila = (id: string) => prisma.reservation.findUniqueOrThrow({ where: { id } })
  const alertas = (reservationId: string) =>
    prisma.moneyAnomaly.findMany({ where: { reservationId }, select: { category: true, resolvedAt: true } })
  // La lectura con que `handleReservationDepositCancellation` decide retener o devolver (la cancelación y el cobro la usan igual).
  const esLecturaDelDeposito = (args: any) => !!args?.select?.depositProcessorRef && !!args?.select?.ecommerceMerchantId
  const leer = prisma.reservation.findFirst.bind(prisma.reservation)
  const señal = () => {
    let dar!: () => void
    const llegó = new Promise<void>(r => (dar = r))
    return { dar, esperar: (que: string) => aTiempo(llegó, 8_000, que) }
  }

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: 'ITEST RET Org', email: `itest-ret-${RUN}@test.com`, phone: '5550000000' },
    })
    orgId = org.id
    const venue = await prisma.venue.create({
      data: {
        name: 'ITEST RET Venue',
        slug: `itest-ret-${RUN}`,
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
    // El negocio se queda el depósito si la cancelación llega con menos de 24 h.
    await prisma.reservationSettings.create({ data: { venueId: venue.id, forfeitDeposit: true, minHoursBeforeCancel: 24 } })
    // La devolución busca el comercio fijado en la reserva como Stripe Connect. El proveedor se comparte con otras pruebas (código
    // único): se reusa y no se borra.
    const providerId = (
      await prisma.paymentProvider.upsert({
        where: { code: 'STRIPE_CONNECT' },
        create: { code: 'STRIPE_CONNECT', name: 'Stripe Connect', type: 'PAYMENT_PROCESSOR', countryCode: ['MX'] },
        update: {},
      })
    ).id
    merchantId = (
      await prisma.ecommerceMerchant.create({
        data: {
          venueId: venue.id,
          businessName: 'Pagos en línea de prueba',
          contactEmail: `itest-ret-${RUN}@example.test`,
          publicKey: `pk_test_ret_${RUN}`,
          secretKeyHash: `hash-ret-${RUN}`,
          providerId,
          providerCredentials: {},
        },
      })
    ).id
  })

  beforeEach(() => {
    provider.refund.mockReset().mockResolvedValue({ status: 'SUCCEEDED', refundId: 're_simulado' })
  })

  afterEach(() => jest.restoreAllMocks())

  afterAll(async () => {
    const step = (fn: () => Promise<unknown>) => fn().catch(() => {})
    if (venueId) {
      const ids = (await prisma.reservation.findMany({ where: { venueId }, select: { id: true } })).map(r => r.id)
      await step(() => prisma.moneyAnomaly.deleteMany({ where: { reservationId: { in: ids } } }))
      await step(() => prisma.processedStripeEvent.deleteMany({ where: { account: CUENTA } }))
      await step(() => prisma.reservation.deleteMany({ where: { venueId } }))
      await step(() => prisma.reservationSettings.deleteMany({ where: { venueId } }))
      await step(() => prisma.ecommerceMerchant.deleteMany({ where: { venueId } }))
      await step(() => prisma.venue.deleteMany({ where: { id: venueId } }))
    }
    if (orgId) await step(() => prisma.organization.deleteMany({ where: { id: orgId } }))
  })

  it('🔴 (a) la retención de la cancelación NO le gana a la devolución del cobro que entró después', async () => {
    const r = await mkReservation({})
    let aviso: Promise<unknown> | null = null
    const avisoEnLaDevolucion = señal()
    const cancelacionTerminada = señal()

    jest.spyOn(prisma.reservation, 'findFirst').mockImplementation((async (args: unknown) => {
      if (esLecturaDelDeposito(args)) {
        if (!aviso) {
          // La cancelación ya confirmó (depósito PENDIENTE) y va a decidir su depósito: en este instante llega el aviso de Stripe,
          // registra el cobro sobre la reserva cancelada y se detiene justo antes de devolverlo.
          aviso = processStripeConnectWebhookEvent(avisoDeStripe(r.checkoutSessionId!) as never)
          await avisoEnLaDevolucion.esperar('el aviso no llegó a la devolución')
        } else {
          // El aviso ya registró el cobro y va a devolverlo: espera a que la cancelación termine lo suyo.
          avisoEnLaDevolucion.dar()
          await cancelacionTerminada.esperar('la cancelación no terminó')
        }
      }
      return leer(args as never)
    }) as never)

    await cancelReservation(venueId!, r.id, 'CUSTOMER', 'Ya no puedo ir')
    cancelacionTerminada.dar()
    // Si la cancelación ya no lee el depósito, el aviso llega justo después de ella (el mismo orden de la carrera).
    aviso ??= processStripeConnectWebhookEvent(avisoDeStripe(r.checkoutSessionId!) as never)
    await aTiempo(aviso, 8_000, 'el aviso no terminó')

    const f = await fila(r.id)
    expect(f.status).toBe('CANCELLED')
    expect(f.depositStatus).toBe('REFUNDED')
    expect(f.depositProcessorRef).toBe('pi_simulado')
    expect(provider.refund).toHaveBeenCalledTimes(1)
    expect(await alertas(r.id)).toEqual([{ category: 'DEPOSIT_PAID_ON_CANCELLED_RESERVATION', resolvedAt: expect.any(Date) }])
  })

  it('🔴 (b) una retención tardía no pisa la devolución que ya se completó', async () => {
    const r = await mkReservation({})
    let aviso: Promise<unknown> | null = null
    const avisoEnLaDevolucion = señal()
    const avisoSuelto = señal()

    jest.spyOn(prisma.reservation, 'findFirst').mockImplementation((async (args: unknown) => {
      if (esLecturaDelDeposito(args)) {
        if (!aviso) {
          // La cancelación lee el depósito justo después de que el aviso registró el cobro (lo ve PAGADO)…
          aviso = processStripeConnectWebhookEvent(avisoDeStripe(r.checkoutSessionId!) as never)
          await avisoEnLaDevolucion.esperar('el aviso no llegó a la devolución')
          const leido = await leer(args as never)
          // …y antes de que escriba, el aviso devuelve todo (Stripe devolvió, REFUNDED, alerta cerrada).
          avisoSuelto.dar()
          await aTiempo(aviso, 8_000, 'el aviso no terminó')
          return leido
        }
        avisoEnLaDevolucion.dar()
        await avisoSuelto.esperar('nadie soltó el aviso')
      }
      return leer(args as never)
    }) as never)

    await cancelReservation(venueId!, r.id, 'CUSTOMER', 'Ya no puedo ir')
    if (!aviso) {
      aviso = processStripeConnectWebhookEvent(avisoDeStripe(r.checkoutSessionId!) as never)
      avisoSuelto.dar()
    }
    await aTiempo(aviso, 8_000, 'el aviso no terminó')

    const f = await fila(r.id)
    expect(f.status).toBe('CANCELLED')
    expect(f.depositStatus).toBe('REFUNDED')
    expect(f.refundStatus).toBe('SUCCEEDED')
    expect(provider.refund).toHaveBeenCalledTimes(1)
    expect(await alertas(r.id)).toEqual([{ category: 'DEPOSIT_PAID_ON_CANCELLED_RESERVATION', resolvedAt: expect.any(Date) }])
  })

  it('🔴 la retención nunca pisa una devolución que terminó entre su lectura y su escritura', async () => {
    const r = await mkReservation({
      status: 'CANCELLED',
      cancelledBy: 'CUSTOMER',
      cancelledAt: new Date(),
      depositStatus: 'PAID',
      depositPaidAt: new Date(),
      depositProcessorRef: 'pi_ya_pagado',
    })
    let primera = true
    jest.spyOn(prisma.reservation, 'findFirst').mockImplementation((async (args: unknown) => {
      if (esLecturaDelDeposito(args) && primera) {
        primera = false
        const leido = await leer(args as never)
        // Entre la lectura de la retención y su escritura, una devolución sin retener termina.
        await handleReservationDepositCancellation(r.id, venueId!, { sinRetener: true })
        return leido
      }
      return leer(args as never)
    }) as never)

    await handleReservationDepositCancellation(r.id, venueId!)

    const f = await fila(r.id)
    expect(f.depositStatus).toBe('REFUNDED')
    expect(provider.refund).toHaveBeenCalledTimes(1)
  })

  it('🔴 la retención tampoco escribe sobre una devolución que empezó después de su lectura y sigue en curso', async () => {
    const r = await mkReservation({
      status: 'CANCELLED',
      cancelledBy: 'CUSTOMER',
      cancelledAt: new Date(),
      depositStatus: 'PAID',
      depositPaidAt: new Date(),
      depositProcessorRef: 'pi_en_curso',
    })
    const enStripe = señal()
    const stripeContesta = señal()
    provider.refund.mockImplementation(async () => {
      enStripe.dar()
      await stripeContesta.esperar('Stripe nunca contestó')
      return { status: 'SUCCEEDED', refundId: 're_simulado' }
    })
    const enCurso: { devolucion?: Promise<void> } = {}
    let primera = true
    jest.spyOn(prisma.reservation, 'findFirst').mockImplementation((async (args: unknown) => {
      if (esLecturaDelDeposito(args) && primera) {
        primera = false
        const leido = await leer(args as never)
        // Después de la lectura de la retención empieza una devolución: marca su intento (PENDING, el depósito sigue PAID) y
        // queda esperando la respuesta de Stripe.
        enCurso.devolucion = handleReservationDepositCancellation(r.id, venueId!, { sinRetener: true })
        await enStripe.esperar('la devolución no llegó a Stripe')
        return leido
      }
      return leer(args as never)
    }) as never)

    await handleReservationDepositCancellation(r.id, venueId!)

    const durante = await fila(r.id)
    expect(durante.depositStatus).toBe('PAID')
    expect(durante.refundStatus).toBe('PENDING')
    stripeContesta.dar()
    await aTiempo(enCurso.devolucion!, 8_000, 'la devolución no terminó')
    expect((await fila(r.id)).depositStatus).toBe('REFUNDED')
    expect(provider.refund).toHaveBeenCalledTimes(1)
  })

  it('regresión: el depósito que ya estaba pagado al cancelar tarde se retiene, sin devolución', async () => {
    const r = await mkReservation({
      status: 'CONFIRMED',
      depositStatus: 'PAID',
      depositPaidAt: new Date(),
      depositProcessorRef: 'pi_antes',
    })
    await cancelReservation(venueId!, r.id, 'CUSTOMER', 'Ya no puedo ir')
    const f = await fila(r.id)
    expect(f.status).toBe('CANCELLED')
    expect(f.depositStatus).toBe('FORFEITED')
    expect(provider.refund).not.toHaveBeenCalled()
  })

  it('regresión: el depósito que ya estaba pagado al cancelar a tiempo se devuelve', async () => {
    const r = await mkReservation({
      status: 'CONFIRMED',
      startsAt: new Date(Date.now() + 48 * HORA),
      endsAt: new Date(Date.now() + 49 * HORA),
      blockedEndsAt: new Date(Date.now() + 49 * HORA),
      depositStatus: 'PAID',
      depositPaidAt: new Date(),
      depositProcessorRef: 'pi_antes_a_tiempo',
    })
    await cancelReservation(venueId!, r.id, 'CUSTOMER', 'Cambio de planes')
    const f = await fila(r.id)
    expect(f.depositStatus).toBe('REFUNDED')
    expect(provider.refund).toHaveBeenCalledTimes(1)
  })

  it('regresión: cancelar con el depósito pendiente (sin aviso) no lo toca', async () => {
    const r = await mkReservation({})
    await cancelReservation(venueId!, r.id, 'CUSTOMER', 'Ya no puedo ir')
    const f = await fila(r.id)
    expect(f.status).toBe('CANCELLED')
    expect(f.depositStatus).toBe('PENDING')
    expect(provider.refund).not.toHaveBeenCalled()
  })
})
