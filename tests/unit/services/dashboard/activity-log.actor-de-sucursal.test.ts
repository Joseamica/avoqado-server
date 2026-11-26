/**
 * D33 (hz:be99f328:D33) — «Ajustar puntos» quedaba en la bitácora sin quién lo hizo.
 *
 * Varios escritores le pasan a `logAction` el id de la ficha persona-sucursal (`StaffVenue.id`) porque su propia tabla
 * (`LoyaltyTransaction`, `Discount`, `CreditTransaction`…) apunta a `StaffVenue`. `ActivityLog.staffId` apunta a `Staff`, así
 * que el INSERT tronaba por la llave foránea y el reintento lo guardaba sin actor («Actor desconocido»). El arreglo vive en
 * el lugar común: antes de rendirse, `logAction` pregunta si ese id es una ficha de sucursal y, si sí, firma con su persona.
 */
jest.unmock('@/services/dashboard/activity-log.service')

import { logAction } from '@/services/dashboard/activity-log.service'
import { prismaMock } from '@tests/__helpers__/setup'

const FK = new Error('Foreign key constraint violated on the constraint: `ActivityLog_staffId_fkey`')

describe('logAction — un id de StaffVenue firma con su persona (D33)', () => {
  beforeEach(() => {
    prismaMock.activityLog.create.mockReset()
    prismaMock.staffVenue.findUnique.mockReset()
  })

  it('reintenta con el Staff.id de la ficha de sucursal, sin marcarlo como desconocido', async () => {
    prismaMock.activityLog.create.mockRejectedValueOnce(FK).mockResolvedValueOnce({ id: 'audit-2' } as never)
    prismaMock.staffVenue.findUnique.mockResolvedValue({ staffId: 'staff-real' } as never)

    await logAction({
      staffId: 'staffvenue-1',
      venueId: 'venue-1',
      action: 'LOYALTY_POINTS_ADJUSTED',
      entity: 'Customer',
      entityId: 'customer-1',
      data: { points: 50, newBalance: 150 },
    })

    expect(prismaMock.staffVenue.findUnique).toHaveBeenCalledWith({ where: { id: 'staffvenue-1' }, select: { staffId: true } })
    expect(prismaMock.activityLog.create).toHaveBeenCalledTimes(2)
    expect(prismaMock.activityLog.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        staffId: 'staff-real',
        venueId: 'venue-1',
        action: 'LOYALTY_POINTS_ADJUSTED',
        data: { points: 50, newBalance: 150 },
      }),
    })
  })

  it('si no es una ficha de sucursal, sigue como antes: sin actor y con el id desconocido en los datos', async () => {
    prismaMock.activityLog.create.mockRejectedValueOnce(FK).mockResolvedValueOnce({ id: 'audit-3' } as never)
    prismaMock.staffVenue.findUnique.mockResolvedValue(null)

    await logAction({ staffId: 'staff-borrado', venueId: 'venue-1', action: 'PERMISSION_DENIED', data: { ruta: '/x' } })

    expect(prismaMock.activityLog.create).toHaveBeenCalledTimes(2)
    expect(prismaMock.activityLog.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({ staffId: null, data: { ruta: '/x', unknownStaffId: 'staff-borrado' } }),
    })
  })

  it('si la persona de la ficha tampoco entra (la llave vuelve a tronar), queda sin actor y con el id original', async () => {
    prismaMock.activityLog.create
      .mockRejectedValueOnce(FK)
      .mockRejectedValueOnce(FK)
      .mockResolvedValueOnce({ id: 'audit-4' } as never)
    prismaMock.staffVenue.findUnique.mockResolvedValue({ staffId: 'staff-real' } as never)

    await logAction({ staffId: 'staffvenue-1', venueId: 'venue-1', action: 'DISCOUNT_CREATED' })

    expect(prismaMock.activityLog.create).toHaveBeenCalledTimes(3)
    expect(prismaMock.activityLog.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({ staffId: null, data: { unknownStaffId: 'staffvenue-1' } }),
    })
  })

  it('un id correcto no consulta nada de más', async () => {
    prismaMock.activityLog.create.mockResolvedValueOnce({ id: 'audit-5' } as never)

    await logAction({ staffId: 'staff-real', venueId: 'venue-1', action: 'ORDER_UPDATED' })

    expect(prismaMock.staffVenue.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.activityLog.create).toHaveBeenCalledTimes(1)
  })
})
