/**
 * Encargo 1569b9 (24-nov-2026): el SUPERADMIN cambiaba el estado de un negocio desde el montaje legado
 * (`PATCH /dashboard/superadmin/venues/:venueId/status`) y la bitácora (ActivityLog) no guardaba nada: sólo un
 * `logger.info`. Y el `POST …/suspend` legado sí escribía VENUE_SUSPENDED, pero a nombre de «system», sin quién ni motivo.
 *
 * Nuevo: los dos guardan quién, el estado de antes y el de después, y el motivo. El cambio de estado usa la MISMA acción
 * que el panel nuevo (`SUPERADMIN_VENUE_STATUS_UPDATED`, con `changes.status.{from,to}`), que el DASHBOARD ya sabe leer.
 */
import { VenueStatus } from '@prisma/client'
import { logAction } from '@/services/dashboard/activity-log.service' // mockeado globalmente en setup
import { prismaMock } from '../../../__helpers__/setup'

import { approveVenue, changeVenueStatus, reactivateVenueByAdmin } from '@/services/dashboard/superadmin.service'
import * as superadminController from '@/controllers/dashboard/superadmin.controller'

/** Los asientos de la bitácora con esa acción. */
const asientos = (action: string) => (logAction as jest.Mock).mock.calls.map((c: any[]) => c[0]).filter((p: any) => p.action === action)

/** El único asiento con esa acción (falla si no hay exactamente uno). */
const asiento = (action: string) => {
  const llamadas = asientos(action)
  expect(llamadas).toHaveLength(1)
  return llamadas[0]
}

const negocio = (status: VenueStatus) => ({ status, name: 'Un negocio', organizationId: 'corg1' })

beforeEach(() => {
  ;(logAction as jest.Mock).mockClear()
  prismaMock.venue.update.mockReset().mockResolvedValue({ id: 'cven1' } as never)
})

describe('bitácora: el superadmin cambia el estado de un negocio (montaje legado)', () => {
  it('suspender guarda quién, de qué estado a cuál y el motivo', async () => {
    prismaMock.venue.findUnique.mockResolvedValue(negocio(VenueStatus.ACTIVE) as never)

    await changeVenueStatus('cven1', VenueStatus.SUSPENDED, 'Falta de pago', 'sa-1')

    expect(asiento('SUPERADMIN_VENUE_STATUS_UPDATED')).toEqual({
      staffId: 'sa-1',
      venueId: 'cven1',
      organizationId: 'corg1',
      action: 'SUPERADMIN_VENUE_STATUS_UPDATED',
      entity: 'Venue',
      entityId: 'cven1',
      data: { changes: { status: { from: 'ACTIVE', to: 'SUSPENDED' } }, reason: 'Falta de pago' },
    })
  })

  it('reactivar sin motivo guarda el cambio sin inventar un motivo', async () => {
    prismaMock.venue.findUnique.mockResolvedValue(negocio(VenueStatus.SUSPENDED) as never)

    await changeVenueStatus('cven1', VenueStatus.ACTIVE, undefined, 'sa-1')

    expect(asiento('SUPERADMIN_VENUE_STATUS_UPDATED').data).toEqual({ changes: { status: { from: 'SUSPENDED', to: 'ACTIVE' } } })
  })

  it('cerrar guarda el motivo que se escribió', async () => {
    prismaMock.venue.findUnique.mockResolvedValue(negocio(VenueStatus.ACTIVE) as never)

    await changeVenueStatus('cven1', VenueStatus.CLOSED, 'Cerró el local', 'sa-1')

    expect(asiento('SUPERADMIN_VENUE_STATUS_UPDATED').data).toEqual({
      changes: { status: { from: 'ACTIVE', to: 'CLOSED' } },
      reason: 'Cerró el local',
    })
  })

  it('una transición no permitida no cambia nada ni deja asiento', async () => {
    prismaMock.venue.findUnique.mockResolvedValue(negocio(VenueStatus.PENDING_ACTIVATION) as never)

    await expect(changeVenueStatus('cven1', VenueStatus.CLOSED, 'x', 'sa-1')).rejects.toThrow(/Cannot transition/)

    expect(prismaMock.venue.update).not.toHaveBeenCalled()
    expect(asientos('SUPERADMIN_VENUE_STATUS_UPDATED')).toHaveLength(0)
  })

  it('si la escritura falla, no deja un asiento de algo que no pasó', async () => {
    prismaMock.venue.findUnique.mockResolvedValue(negocio(VenueStatus.ACTIVE) as never)
    prismaMock.venue.update.mockRejectedValue(new Error('base caída') as never)

    await expect(changeVenueStatus('cven1', VenueStatus.SUSPENDED, 'x', 'sa-1')).rejects.toThrow('base caída')

    expect(asientos('SUPERADMIN_VENUE_STATUS_UPDATED')).toHaveLength(0)
  })

  it('el cambio de estado sigue escribiendo lo mismo en el negocio', async () => {
    prismaMock.venue.findUnique.mockResolvedValue(negocio(VenueStatus.ACTIVE) as never)

    await changeVenueStatus('cven1', VenueStatus.SUSPENDED, 'Falta de pago', 'sa-1')

    expect(prismaMock.venue.update).toHaveBeenCalledWith({
      where: { id: 'cven1' },
      data: expect.objectContaining({
        status: 'SUSPENDED',
        statusChangedBy: 'sa-1',
        suspensionReason: 'Falta de pago',
        active: false,
      }),
    })
  })
})

describe('bitácora: el POST …/suspend legado', () => {
  it('guarda la suspensión a nombre de quien la hizo y con su motivo', async () => {
    prismaMock.venue.findUnique.mockResolvedValue(negocio(VenueStatus.ACTIVE) as never)
    const req = { params: { venueId: 'cven1' }, body: { reason: 'Falta de pago' }, authContext: { userId: 'sa-1' } } as any
    const res = { json: jest.fn() } as any
    const next = jest.fn()

    await superadminController.suspendVenue(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(asiento('VENUE_SUSPENDED')).toEqual({
      staffId: 'sa-1',
      venueId: 'cven1',
      organizationId: 'corg1',
      action: 'VENUE_SUSPENDED',
      entity: 'Venue',
      entityId: 'cven1',
      data: { changes: { status: { from: 'ACTIVE', to: 'ADMIN_SUSPENDED' } }, reason: 'Falta de pago' },
    })
    expect(prismaMock.venue.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ statusChangedBy: 'sa-1', suspensionReason: 'Falta de pago' }) }),
    )
  })
})

describe('regresión: aprobar y reactivar siguen en la bitácora', () => {
  it('aprobar guarda VENUE_APPROVED a nombre de quien aprobó', async () => {
    prismaMock.venue.findUnique.mockResolvedValue(negocio(VenueStatus.PENDING_ACTIVATION) as never)

    await approveVenue('cven1', 'sa-1')

    expect(asiento('VENUE_APPROVED')).toMatchObject({ staffId: 'sa-1', venueId: 'cven1', entity: 'Venue', entityId: 'cven1' })
  })

  it('reactivar guarda VENUE_REACTIVATED a nombre de quien reactivó', async () => {
    prismaMock.venue.findUnique.mockResolvedValue(negocio(VenueStatus.ADMIN_SUSPENDED) as never)

    await reactivateVenueByAdmin('cven1', 'sa-1')

    expect(asiento('VENUE_REACTIVATED')).toMatchObject({ staffId: 'sa-1', venueId: 'cven1', entity: 'Venue', entityId: 'cven1' })
  })
})
