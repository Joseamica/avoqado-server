import { prismaMock } from '@tests/__helpers__/setup'
import { ForbiddenError } from '@/errors/AppError'

jest.mock('@/services/public/customerBookingAccess.service', () => ({
  __esModule: true,
  assertCustomerCanCreateReservation: jest.fn(async () => undefined),
}))
jest.mock('@/utils/serializableRetry', () => ({ __esModule: true, withSerializableRetry: jest.fn() }))

import { assertCustomerCanCreateReservation } from '@/services/public/customerBookingAccess.service'
import { withSerializableRetry } from '@/utils/serializableRetry'
import * as settingsService from '@/services/dashboard/reservationSettings.service'
import { mintNormalAppointmentHold } from '@/services/reservation/appointmentSlotHold.service'

/**
 * Fase 1 — hallazgo #3 de la auditoría de Codex.
 *
 * El gate del hold vivía en el controlador, en una transacción corta aparte. Entre esa
 * lectura ("¿puede reservar?") y el minteo ("aparta el lugar") cabía un rechazo: la dueña
 * rechazaba, y el rechazado se quedaba igual con diez minutos de capacidad apartada.
 *
 * El contrato ahora es que el gate corre como PRIMER paso dentro de la MISMA transacción
 * serializable que aparta — que es la única forma de que no exista esa ventana.
 */
const VENUE = 'venue-1'
const GATE = assertCustomerCanCreateReservation as jest.Mock

const baseInput = {
  venueId: VENUE,
  startsAt: new Date(Date.now() + 3_600_000),
  endsAt: new Date(Date.now() + 5_400_000),
  productIds: ['prod-1'],
}

describe('mintNormalAppointmentHold — gate de aprobación', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(withSerializableRetry as jest.Mock).mockImplementation(async (fn: any) => fn(prismaMock))
    GATE.mockResolvedValue(undefined)
    jest.spyOn(settingsService, 'getReservationSettings').mockResolvedValue({
      publicBooking: { enabled: true },
      scheduling: { autoConfirm: true },
      deposits: { enabled: false, mode: 'none' },
    } as any)
  })

  it('🔴 gatea con el customerId recibido, DENTRO de la transacción', async () => {
    GATE.mockRejectedValue(new ForbiddenError('En espera de aprobación', 'CUSTOMER_APPROVAL_PENDING'))

    await expect(mintNormalAppointmentHold({ ...baseInput, customerId: 'cust-1' } as any)).rejects.toMatchObject({
      code: 'CUSTOMER_APPROVAL_PENDING',
    })

    expect(GATE).toHaveBeenCalledWith(expect.anything(), { customerId: 'cust-1', venueId: VENUE })
  })

  it('🔴 el gate corre PRIMERO: al rechazar, ni siquiera se leen los ajustes del venue', async () => {
    GATE.mockRejectedValue(new ForbiddenError('En espera', 'CUSTOMER_APPROVAL_PENDING'))

    await expect(mintNormalAppointmentHold({ ...baseInput, customerId: 'cust-1' } as any)).rejects.toBeDefined()

    expect(settingsService.getReservationSettings).not.toHaveBeenCalled()
  })

  it('🔴 público SIN sesión (null) también pasa por el gate: él decide si el venue admite invitados', async () => {
    GATE.mockRejectedValue(new ForbiddenError('Inicia sesión', 'CUSTOMER_AUTH_REQUIRED'))

    await expect(mintNormalAppointmentHold({ ...baseInput, customerId: null } as any)).rejects.toMatchObject({
      code: 'CUSTOMER_AUTH_REQUIRED',
    })
    expect(GATE).toHaveBeenCalledWith(expect.anything(), { customerId: null, venueId: VENUE })
  })

  it('🔴 sin customerId (undefined = staff/MCP, no es superficie pública) NO se gatea', async () => {
    GATE.mockRejectedValue(new ForbiddenError('En espera', 'CUSTOMER_APPROVAL_PENDING'))

    // Truena más adelante por falta de datos del venue, no por el gate.
    await expect(mintNormalAppointmentHold(baseInput as any)).rejects.not.toMatchObject({ code: 'CUSTOMER_APPROVAL_PENDING' })
    expect(GATE).not.toHaveBeenCalled()
  })
})
