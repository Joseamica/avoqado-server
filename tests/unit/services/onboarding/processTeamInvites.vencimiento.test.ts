/**
 * D32: la invitación del alta vence 7 × 24 h después, sin importar la zona horaria del proceso.
 * Con setDate/getDate, en America/Los_Angeles cruzar el fin del horario de verano agregaba una hora.
 */
const mockInvitationCreate = jest.fn()
jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    staff: { findUnique: jest.fn(async ({ where }: any) => (where.id ? { firstName: 'Ana', lastName: 'Dueña' } : null)) },
    invitation: { findFirst: jest.fn().mockResolvedValue(null), create: (...a: unknown[]) => mockInvitationCreate(...a) },
  },
}))
jest.mock('../../../../src/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}))
jest.mock('../../../../src/services/stripe.service', () => ({ __esModule: true }))
jest.mock('../../../../src/services/superadmin/kycReview.service', () => ({ __esModule: true }))
jest.mock('../../../../src/services/email.service', () => ({ __esModule: true, default: {} }))
jest.mock('../../../../src/services/resend.service', () => ({ __esModule: true }))
jest.mock('../../../../src/services/onboarding/demoSeed.service', () => ({ __esModule: true, seedDemoVenue: jest.fn() }))

import { processTeamInvites } from '../../../../src/services/onboarding/venueCreation.service'

describe('processTeamInvites — vencimiento de la invitación', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-10-30T18:00:00.000Z'), doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] })
    // La invitación se crea y el resto del alta se corta aquí: sólo importa la fecha que se guardó.
    mockInvitationCreate.mockRejectedValue(new Error('alto: ya se leyó la fecha'))
  })
  afterEach(() => jest.useRealTimers())

  it('expiresAt = ahora + 7 días exactos, también cruzando el cambio de horario', async () => {
    await processTeamInvites(
      'venue-1',
      'org-1',
      'staff-1',
      [{ email: 'nuevo@negocio.mx', firstName: 'Beto', lastName: 'Mesero', role: 'WAITER' }],
      'Café',
      'Org',
    )
    expect(mockInvitationCreate.mock.calls[0][0].data.expiresAt.toISOString()).toBe('2026-11-06T18:00:00.000Z')
  })
})
