import { prismaMock } from '@tests/__helpers__/setup'
import { ForbiddenError } from '@/errors/AppError'

/**
 * Fase 1 slice 3 — el gate de aprobación en TODAS las superficies que consumen capacidad
 * o dinero en nombre de un cliente (matriz §4bis del diseño).
 *
 * Aquí no se prueba la LÓGICA del gate (eso vive en `customerBookingAccess.service.test.ts`,
 * 27 tests): se prueba que cada superficie lo LLAME, con el customerId correcto, y que el
 * staff y el demo NO pasen por él. Un gate perfecto que una superficie no invoca es un
 * agujero — y v1 del diseño se dejaba cinco.
 */
jest.mock('@/services/public/customerBookingAccess.service', () => ({
  __esModule: true,
  assertCustomerCanCreateReservation: jest.fn(async () => undefined),
  activateCustomerAccount: jest.fn(async () => ({ approvalStatus: 'APPROVED', requestsApproval: false, approvalVersion: 0 })),
}))
jest.mock('@/utils/serializableRetry', () => ({
  __esModule: true,
  withSerializableRetry: jest.fn(),
}))
jest.mock('@/services/reservation/appointmentSlotHold.service', () => ({
  __esModule: true,
  mintNormalAppointmentHold: jest.fn(async () => ({ id: 'hold-1', expiresAt: new Date(Date.now() + 600_000) })),
  pruneExpiredHolds: jest.fn(async () => undefined),
  fastFailLiveHold: jest.fn(async () => null),
  resolveCanonicalAppointmentDuration: jest.fn(async () => 60),
  assertLegacyAppointmentDurationFloor: jest.fn(async () => undefined),
}))

import { assertCustomerCanCreateReservation, activateCustomerAccount } from '@/services/public/customerBookingAccess.service'
import { withSerializableRetry } from '@/utils/serializableRetry'
import * as reservationService from '@/services/dashboard/reservation.dashboard.service'
import * as settingsService from '@/services/dashboard/reservationSettings.service'
import { createReservationForConsumer } from '@/services/consumer/reservation.consumer.service'
import * as creditPackService from '@/services/dashboard/creditPack.public.service'
import * as creditConsumerService from '@/services/consumer/credit.consumer.service'
import * as reservationPublicController from '@/controllers/public/reservation.public.controller'
import { mintNormalAppointmentHold } from '@/services/reservation/appointmentSlotHold.service'

const VENUE = 'venue-1'
const GATE = assertCustomerCanCreateReservation as jest.Mock

/** El gate va PRIMERO dentro de la transacción: al lanzar, nada más del flujo llega a correr. */
function armGateRejects() {
  GATE.mockRejectedValue(new ForbiddenError('Tu cuenta está en espera de aprobación del negocio.', 'CUSTOMER_APPROVAL_PENDING'))
}

function reservationInput(customerId?: string) {
  return {
    startsAt: new Date('2026-09-01T16:00:00.000Z'),
    endsAt: new Date('2026-09-01T17:00:00.000Z'),
    duration: 60,
    guestName: 'Ana',
    guestPhone: '5512345678',
    partySize: 1,
    ...(customerId ? { customerId } : {}),
  }
}

describe('Gate de aprobación — reservas de CITA (createReservation)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // El proyecto resetea implementaciones entre tests: se re-arman aquí, no en la fábrica.
    ;(withSerializableRetry as jest.Mock).mockImplementation(async (fn: any) => fn(prismaMock))
    GATE.mockResolvedValue(undefined)
  })

  it('🔴 origen PUBLIC: gatea con el customerId de la sesión', async () => {
    armGateRejects()

    await expect(reservationService.createReservation(VENUE, reservationInput('cust-1'), { writeOrigin: 'PUBLIC' })).rejects.toMatchObject({
      code: 'CUSTOMER_APPROVAL_PENDING',
    })

    expect(GATE).toHaveBeenCalledWith(expect.anything(), { customerId: 'cust-1', venueId: VENUE })
  })

  it('🔴 origen CONSUMER: también gatea (v1 del diseño lo olvidaba)', async () => {
    armGateRejects()

    await expect(
      reservationService.createReservation(VENUE, reservationInput('cust-2'), { writeOrigin: 'CONSUMER' }),
    ).rejects.toMatchObject({ code: 'CUSTOMER_APPROVAL_PENDING' })

    expect(GATE).toHaveBeenCalledWith(expect.anything(), { customerId: 'cust-2', venueId: VENUE })
  })

  it('🔴 origen DASHBOARD (staff): NO se gatea — el staff decide por su cuenta', async () => {
    armGateRejects()

    // El gate no corre; el flujo sigue y truena más adelante por falta de datos, no por 403.
    await expect(
      reservationService.createReservation(VENUE, reservationInput('cust-3'), { writeOrigin: 'DASHBOARD' }, 'staff-1'),
    ).rejects.not.toMatchObject({ code: 'CUSTOMER_APPROVAL_PENDING' })

    expect(GATE).not.toHaveBeenCalled()
  })

  it('🔴 origen MCP: tampoco se gatea', async () => {
    armGateRejects()

    await expect(
      reservationService.createReservation(VENUE, reservationInput('cust-4'), { writeOrigin: 'MCP' }, 'staff-1'),
    ).rejects.not.toMatchObject({ code: 'CUSTOMER_APPROVAL_PENDING' })

    expect(GATE).not.toHaveBeenCalled()
  })

  it('🔴 Live Demo: se etiqueta PUBLIC artificialmente y DEBE quedar exento', async () => {
    armGateRejects()

    await expect(
      reservationService.createReservation(VENUE, reservationInput(), { writeOrigin: 'PUBLIC', skipCustomerApprovalGate: true }, 'staff-1'),
    ).rejects.not.toMatchObject({ code: 'CUSTOMER_APPROVAL_PENDING' })

    expect(GATE).not.toHaveBeenCalled()
  })

  it('🔴 el gate corre ANTES de tocar capacidad: sin sesión, PUBLIC llega igual al gate (él decide)', async () => {
    armGateRejects()

    await expect(reservationService.createReservation(VENUE, reservationInput(), { writeOrigin: 'PUBLIC' })).rejects.toMatchObject({
      code: 'CUSTOMER_APPROVAL_PENDING',
    })
    // customerId indefinido llega como undefined: es el gate quien lanza CUSTOMER_AUTH_REQUIRED,
    // no la superficie — así el mensaje es uno solo en toda la plataforma.
    expect(GATE).toHaveBeenCalledWith(expect.anything(), { customerId: undefined, venueId: VENUE })
  })
})

describe('Gate de aprobación — reserva de CLASE desde la app del consumidor', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(withSerializableRetry as jest.Mock).mockImplementation(async (fn: any) => fn(prismaMock))
    GATE.mockResolvedValue(undefined)
    ;(activateCustomerAccount as jest.Mock).mockResolvedValue({ approvalStatus: 'PENDING', requestsApproval: true, approvalVersion: 0 })
    prismaMock.venue.findFirst.mockResolvedValue({ id: VENUE, slug: 'estudio', name: 'Estudio' } as any)
    prismaMock.consumer.findUnique.mockResolvedValue({
      id: 'cons-1',
      email: 'ana@test.com',
      phone: '+525511110000',
      firstName: 'Ana',
      active: true,
    } as any)
    prismaMock.customer.findFirst.mockResolvedValue({ id: 'cust-clase', venueId: VENUE, active: true } as any)
    jest.spyOn(settingsService, 'getReservationSettings').mockResolvedValue({
      publicBooking: { enabled: true, requirePhone: false, requireEmail: false },
      deposits: { enabled: false, mode: 'none' },
      scheduling: { autoConfirm: true },
    } as any)
  })

  it('🔴 la clase reservada desde la app también pasa por el gate (v1 sólo cubría la web)', async () => {
    armGateRejects()

    await expect(
      createReservationForConsumer('cons-1', 'estudio', { classSessionId: 'sess-1', partySize: 1 } as any),
    ).rejects.toMatchObject({ code: 'CUSTOMER_APPROVAL_PENDING' })

    expect(GATE).toHaveBeenCalledWith(expect.anything(), { customerId: 'cust-clase', venueId: VENUE })
  })
})

describe('Gate de aprobación — compra de PAQUETES de crédito', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(prismaMock))
    GATE.mockResolvedValue(undefined)
  })

  it('🔴 checkout público: el gate corre ANTES de crear la sesión de Stripe', async () => {
    armGateRejects()

    await expect(
      creditPackService.createCheckoutSession(VENUE, 'pack-1', 'ana@test.com', undefined, 'https://ok', 'https://no', {
        customerId: 'cust-pack',
      }),
    ).rejects.toMatchObject({ code: 'CUSTOMER_APPROVAL_PENDING' })

    expect(GATE).toHaveBeenCalledWith(expect.anything(), { customerId: 'cust-pack', venueId: VENUE })
    // Nunca se cobra a alguien que no va a poder usar el paquete: ni siquiera se lee el pack.
    expect(prismaMock.creditPack.findFirst).not.toHaveBeenCalled()
  })

  it('🔴 compra desde la app del consumidor: liga+activa su Customer y lo gatea', async () => {
    ;(activateCustomerAccount as jest.Mock).mockResolvedValue({ approvalStatus: 'PENDING', requestsApproval: true, approvalVersion: 0 })
    prismaMock.consumer.findUnique.mockResolvedValue({ id: 'cons-1', email: 'ana@test.com', phone: '+525511110000', active: true } as any)
    prismaMock.venue.findFirst.mockResolvedValue({ id: VENUE, slug: 'estudio' } as any)
    prismaMock.customer.findFirst.mockResolvedValue({ id: 'cust-app', venueId: VENUE, active: true } as any)
    armGateRejects()

    await expect(creditConsumerService.createCreditCheckoutForConsumer('cons-1', 'estudio', 'pack-1')).rejects.toMatchObject({
      code: 'CUSTOMER_APPROVAL_PENDING',
    })

    expect(GATE).toHaveBeenCalledWith(expect.anything(), { customerId: 'cust-app', venueId: VENUE })
  })
})

/**
 * El hold aparta 10 minutos de capacidad real. Decisión del diseño §4bis: un cliente en
 * espera de aprobación NO puede bloquear el lugar de alguien que sí puede reservar. Y la
 * ruta HOY ni siquiera autentica — el hueco era doble.
 */
describe('Gate de aprobación — HOLD de slot (aparta capacidad 10 min)', () => {
  function makeRes() {
    return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as any
  }

  beforeEach(() => {
    jest.clearAllMocks()
    ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(prismaMock))
    GATE.mockResolvedValue(undefined)
    prismaMock.venue.findFirst.mockResolvedValue({ id: VENUE, slug: 'estudio', name: 'Estudio', timezone: 'America/Mexico_City' } as any)
    prismaMock.product.findMany.mockResolvedValue([{ id: 'prod-1', type: 'SERVICE' }] as any)
    ;(mintNormalAppointmentHold as jest.Mock).mockResolvedValue({ id: 'hold-1', expiresAt: new Date(Date.now() + 600_000) })
    jest.spyOn(settingsService, 'getReservationSettings').mockResolvedValue({
      publicBooking: { enabled: true, requirePhone: false, requireEmail: false },
      deposits: { enabled: false, mode: 'none' },
      scheduling: { autoConfirm: true },
    } as any)
  })

  it('🔴 el gate viaja DENTRO de la transacción que mintea, no en una corta aparte', async () => {
    // Auditoría Codex #3: con el gate en su propia transacción cabía un rechazo entre "puede"
    // y "aparta", y el rechazado se quedaba con el lugar diez minutos. El contrato ahora es
    // que el customerId llegue al minteo, que lo gatea como primer paso de SU transacción.
    const next = jest.fn()
    const req = {
      params: { venueSlug: 'estudio' },
      body: {
        startsAt: new Date(Date.now() + 3_600_000).toISOString(),
        endsAt: new Date(Date.now() + 7_200_000).toISOString(),
        productId: 'prod-1',
      },
      customerAuth: { customerId: 'cust-hold', venueId: VENUE },
    } as any

    await reservationPublicController.createHold(req, makeRes(), next)

    expect(mintNormalAppointmentHold).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'cust-hold' }))
  })

  it('🔴 el rechazo del gate (que ahora vive en el minteo) llega al cliente como 403, no como 500', async () => {
    ;(mintNormalAppointmentHold as jest.Mock).mockRejectedValue(
      new ForbiddenError('Tu cuenta está en espera de aprobación del negocio.', 'CUSTOMER_APPROVAL_PENDING'),
    )
    const next = jest.fn()
    const req = {
      params: { venueSlug: 'estudio' },
      body: {
        startsAt: new Date(Date.now() + 3_600_000).toISOString(),
        endsAt: new Date(Date.now() + 7_200_000).toISOString(),
        productId: 'prod-1',
      },
      customerAuth: { customerId: 'cust-hold', venueId: VENUE },
    } as any

    await reservationPublicController.createHold(req, makeRes(), next)

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'CUSTOMER_APPROVAL_PENDING' }))
  })
})
