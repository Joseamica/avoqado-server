/**
 * 🔴 Codex C11 (22-sep): un conflicto de cobro (una suscripción que no sabemos representar, o dos planes vivos) dejaba
 * al negocio sin acceso y sólo quedaba en el log y en la bitácora. Nadie lo resolvía. Ahora, cuando NACE, además de la
 * bitácora sale un correo a operaciones con qué pasó y qué hacer — el mismo canal de los 🚨 de cobro.
 */
const mockSendOpsAlert = jest.fn()
jest.mock('@/services/alerts/opsAlert.service', () => ({ sendOpsAlert: (...a: unknown[]) => mockSendOpsAlert(...a) }))

import { avisarConflictoCreado } from '@/services/access/conflictosDeObligacion.service'
import { logAction } from '@/services/dashboard/activity-log.service'

beforeEach(() => {
  jest.clearAllMocks()
  mockSendOpsAlert.mockResolvedValue(true)
})

describe('avisarConflictoCreado', () => {
  it('🔴 producto desconocido: bitácora OBLIGACION_DESCONOCIDA y correo a operaciones con el negocio y la suscripción', () => {
    avisarConflictoCreado({ venueId: 'v1', subscriptionId: 'sub_x', kind: 'UNKNOWN_PRODUCT', detectedBy: 'webhook' })

    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ venueId: 'v1', action: 'OBLIGACION_DESCONOCIDA', entity: 'BillingObligationConflict', entityId: 'sub_x' }),
    )
    expect(mockSendOpsAlert).toHaveBeenCalledTimes(1)
    const alerta = mockSendOpsAlert.mock.calls[0][0]
    expect(alerta.subject).toContain('sub_x')
    expect(alerta.subject).toContain('v1')
    expect(alerta.lines.join(' ')).toMatch(/Stripe/)
  })

  it('🔴 dos planes vivos: bitácora OBLIGACION_DUPLICADA y el correo nombra la suscripción con la que choca', () => {
    avisarConflictoCreado({
      venueId: 'v1',
      subscriptionId: 'sub_new',
      kind: 'DUPLICATE_PLAN',
      conflictsWith: ['sub_primera'],
      detectedBy: 'checkout',
    })

    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'OBLIGACION_DUPLICADA', entityId: 'sub_new' }))
    expect(mockSendOpsAlert.mock.calls[0][0].lines.join(' ')).toContain('sub_primera')
  })
})
