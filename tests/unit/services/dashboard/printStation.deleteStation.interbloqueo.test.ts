/**
 * hz:e82938e1:D40 (Codex d40-r4 #2): borrar una estación pone en NULL su referencia en las comandas; anular una cuenta separada crea
 * un folio que copia esa estación. Los dos se pueden esperar al revés y Postgres corta uno (40P01). La anulación ya se repite sola
 * (`withDeadlockRetry`); el borrado de la estación también debe repetirse, en vez de devolverle un error al dueño.
 */
import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import { deleteStation } from '@/services/dashboard/printStation.dashboard.service'

describe('deleteStation — la red por traba (40P01)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(prismaMock as any).printStation.findFirst.mockResolvedValue({ id: 'st-1', venueId: 'v1', name: 'Cocina', isDefault: false })
    ;(prismaMock as any).printStation.delete.mockResolvedValue({ id: 'st-1' })
    prismaMock.$queryRaw.mockResolvedValue([{ id: 'v1' }] as any)
  })

  it('🔴 si Postgres la elige como víctima de un bloqueo mutuo, la repite y la estación se borra', async () => {
    let intento = 0
    prismaMock.$transaction.mockImplementation((async (cb: any) => {
      intento += 1
      if (intento === 1) throw Object.assign(new Error('deadlock detected'), { code: '40P01' })
      return cb(prismaMock)
    }) as any)

    await expect(deleteStation('v1', 'st-1', 'staff-1')).resolves.toEqual({ id: 'st-1', deleted: true })
    expect(intento).toBe(2)
    expect((prismaMock as any).printStation.delete).toHaveBeenCalledTimes(1)
  })

  it('regresión: otro error no se repite', async () => {
    prismaMock.$transaction.mockImplementation((async () => {
      throw Object.assign(new Error('otra cosa'), { code: 'P2025' })
    }) as any)
    await expect(deleteStation('v1', 'st-1')).rejects.toMatchObject({ code: 'P2025' })
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
  })
})
