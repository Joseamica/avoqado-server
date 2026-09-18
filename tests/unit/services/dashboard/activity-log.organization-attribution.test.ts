/**
 * S15 — la bitácora sabe a qué ORGANIZACIÓN pertenece un asiento (spec 2026-09-17 § 9.1).
 *
 * 🔴 Por qué importa: toda la feature de campañas de lanzamiento escribe asientos de
 * PLATAFORMA, con `venueId` nulo (una ficha no pertenece a un local). Sin este campo esos
 * asientos quedan sin a quién atribuirlos: la columna `ActivityLog.organizationId` existe
 * desde hace tiempo y **nadie la escribía**.
 *
 * Aditivo: un `logAction` sin el campo sigue guardando `organizationId: null`, así que los
 * 200+ llamadores actuales no cambian de comportamiento.
 */
jest.unmock('@/services/dashboard/activity-log.service')

import { logAction } from '@/services/dashboard/activity-log.service'
import { prismaMock } from '@tests/__helpers__/setup'

describe('logAction — atribución por organización (S15)', () => {
  beforeEach(() => {
    prismaMock.activityLog.create.mockReset()
    prismaMock.activityLog.create.mockResolvedValue({ id: 'audit-1' } as never)
  })

  it('guarda la organización cuando se la pasan (asiento de plataforma, sin local)', async () => {
    await logAction({
      staffId: 'staff-1',
      venueId: null,
      organizationId: 'org-1',
      action: 'LAUNCH_CAMPAIGN_ACTIVATED',
      entity: 'LaunchCampaign',
      entityId: 'lc-1',
    })

    expect(prismaMock.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ venueId: null, organizationId: 'org-1', action: 'LAUNCH_CAMPAIGN_ACTIVATED' }),
    })
  })

  it('sin el campo sigue guardando null — los llamadores existentes no cambian', async () => {
    await logAction({ staffId: 'staff-1', venueId: 'venue-1', action: 'SOMETHING_OLD' })

    expect(prismaMock.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ venueId: 'venue-1', organizationId: null }),
    })
  })

  it('el reintento sin actor (FK de Staff caída) CONSERVA la organización', async () => {
    // 🔴 Es el caso que se pierde si sólo se toca el primer `create`: el asiento que más
    // importa —alguien con un token de un empleado borrado— se guardaría sin organización.
    prismaMock.activityLog.create
      .mockRejectedValueOnce(new Error('Foreign key constraint failed: ActivityLog_staffId_fkey'))
      .mockResolvedValueOnce({ id: 'audit-2' } as never)

    await logAction({
      staffId: 'staff-borrado',
      organizationId: 'org-1',
      action: 'PERMISSION_DENIED',
    })

    expect(prismaMock.activityLog.create).toHaveBeenCalledTimes(2)
    expect(prismaMock.activityLog.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({ staffId: null, organizationId: 'org-1' }),
    })
  })
})
