/**
 * Tests: importMenu debe PERSISTIR `duration` (servicios con cita)
 *
 * Contexto real (Amaena, incidente RES-PY45XU del 2026-07-20):
 * `importMenu` nunca escribía `duration`, ni al crear ni al actualizar. Los 5
 * servicios que entraron por import el 2026-07-16 nacieron con `duration = NULL`
 * y el motor de reservas los rellenó con el default del local (90 min), que era
 * corto para un combo real → se agendó al siguiente cliente encima.
 *
 * Decisión de producto (founder, 2026-08-09): la duración NO se vuelve
 * obligatoria — hay clientes que a propósito no quieren fijar tiempos, y el
 * fallback al default del venue es un comportamiento válido y deseado. Lo que se
 * arregla es que quien SÍ quiere fijarla pueda cargarla por import.
 *
 * Verifica:
 *  - crea con duration cuando el payload la trae
 *  - crea SIN duration cuando el payload no la trae (opt-out sigue vivo)
 *  - actualiza duration en una fila existente (repara filas legacy rotas)
 *  - REGRESIÓN: un import que omite duration NO borra la que ya estaba
 */

import { prismaMock } from '../../../__helpers__/setup'
import * as menuService from '../../../../src/services/dashboard/menu.dashboard.service'

jest.mock('../../../../src/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn().mockReturnValue(null) },
}))

jest.mock('../../../../src/utils/slugify', () => ({
  generateSlug: jest.fn((name: string) => name.toLowerCase().replace(/\s+/g, '-')),
}))

jest.mock('../../../../src/services/master-catalog/catalogGovernance.service', () => ({
  assertLegacyCatalogGovernanceComputedForVenue: jest.fn(),
}))

jest.mock('../../../../src/services/dashboard/activity-log.service', () => ({
  logAction: jest.fn(),
}))

const VENUE = 'venue-amaena'
const ACTOR = { type: 'HUMAN' as const, staffId: 'staff-1' }

/** Arma el payload mínimo de import con UN servicio de cita. */
const importPayload = (product: Record<string, any>) => ({
  mode: 'merge' as const,
  categories: [{ name: 'Uñas', slug: 'unas', products: [{ name: 'Servicio', sku: 'SKU-1', price: 1000, ...product }] }],
})

/** Cablea el mock de Prisma; `existing` = producto ya en la DB (o null). */
function wirePrisma(existing: Record<string, any> | null) {
  prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
  prismaMock.menu.findFirst.mockResolvedValue({ id: 'menu-1', venueId: VENUE } as any)
  prismaMock.menuCategory.findFirst.mockResolvedValue(null as any)
  prismaMock.menuCategory.create.mockResolvedValue({ id: 'cat-1', venueId: VENUE } as any)
  prismaMock.menuCategoryAssignment.findFirst.mockResolvedValue(null as any)
  prismaMock.menuCategoryAssignment.create.mockResolvedValue({} as any)
  prismaMock.product.findMany.mockResolvedValue([] as any)
  prismaMock.product.findFirst.mockResolvedValue(existing as any)
  prismaMock.product.create.mockResolvedValue({ id: 'prod-1' } as any)
  prismaMock.product.update.mockResolvedValue({ id: 'prod-1' } as any)
  prismaMock.inventory.findFirst.mockResolvedValue(null as any)
}

describe('importMenu — persistencia de duration', () => {
  beforeEach(() => jest.clearAllMocks())

  it('CREA con la duración que trae el payload', async () => {
    wirePrisma(null)

    await menuService.importMenu(VENUE, importPayload({ type: 'APPOINTMENTS_SERVICE', duration: 150 }) as any, ACTOR as any)

    expect(prismaMock.product.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ duration: 150 }) }))
  })

  it('CREA sin duración cuando el payload no la trae — el opt-out sigue vivo', async () => {
    wirePrisma(null)

    await menuService.importMenu(VENUE, importPayload({ type: 'APPOINTMENTS_SERVICE' }) as any, ACTOR as any)

    expect(prismaMock.product.create).toHaveBeenCalled()
    const data = (prismaMock.product.create as jest.Mock).mock.calls[0][0].data
    // No se inventa un valor: se deja nulo y el motor cae al default del venue.
    expect(data.duration ?? null).toBeNull()
  })

  it('ACTUALIZA la duración de una fila existente — repara filas legacy rotas', async () => {
    wirePrisma({ id: 'prod-1', venueId: VENUE, sku: 'SKU-1', duration: null })

    await menuService.importMenu(VENUE, importPayload({ type: 'APPOINTMENTS_SERVICE', duration: 165 }) as any, ACTOR as any)

    expect(prismaMock.product.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ duration: 165 }) }))
  })

  it('REGRESIÓN: un import que omite duration NO borra la que ya estaba', async () => {
    wirePrisma({ id: 'prod-1', venueId: VENUE, sku: 'SKU-1', duration: 120 })

    await menuService.importMenu(VENUE, importPayload({ type: 'APPOINTMENTS_SERVICE' }) as any, ACTOR as any)

    const data = (prismaMock.product.update as jest.Mock).mock.calls[0][0].data
    // Ausente ≠ null. Re-importar precios no puede desconfigurar la agenda.
    expect(data).not.toHaveProperty('duration')
  })
})
