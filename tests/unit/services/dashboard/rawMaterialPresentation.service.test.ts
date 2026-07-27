import { Decimal } from '@prisma/client/runtime/library'
import { prismaMock } from '@tests/__helpers__/setup'

const logActionMock = jest.fn().mockResolvedValue(undefined)
jest.mock('@/services/dashboard/activity-log.service', () => ({
  __esModule: true,
  logAction: (...args: unknown[]) => logActionMock(...args),
}))

import { getPresentationSet, listPresentations, setPresentations } from '@/services/dashboard/rawMaterialPresentation.service'

describe('rawMaterialPresentation.service', () => {
  const VENUE = 'venue-1'
  const RM = 'rm-huevo'

  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
  })

  describe('getPresentationSet — alimenta al resolver puro', () => {
    it('arma el set desde la unidad base + presentaciones', async () => {
      prismaMock.rawMaterial.findUnique.mockResolvedValue({
        unit: 'PIECE',
        presentations: [
          { name: 'caja', factorToBase: new Decimal(360) },
          { name: 'cono', factorToBase: new Decimal(30) },
        ],
      })

      const set = await getPresentationSet(RM)

      expect(set).toEqual({
        baseUnit: 'PIECE',
        presentations: [
          { name: 'caja', factorToBase: expect.anything() },
          { name: 'cono', factorToBase: expect.anything() },
        ],
      })
    })

    it('REGRESIÓN: insumo SIN presentaciones devuelve null (el caller sigue con convertUnit de hoy)', async () => {
      prismaMock.rawMaterial.findUnique.mockResolvedValue({ unit: 'KILOGRAM', presentations: [] })
      await expect(getPresentationSet(RM)).resolves.toBeNull()
    })

    it('insumo inexistente devuelve null, no revienta', async () => {
      prismaMock.rawMaterial.findUnique.mockResolvedValue(null)
      await expect(getPresentationSet(RM)).resolves.toBeNull()
    })
  })

  describe('setPresentations — reemplazo validado', () => {
    beforeEach(() => {
      prismaMock.rawMaterial.findFirst.mockResolvedValue({ id: RM, unit: 'PIECE' })
      prismaMock.rawMaterialPresentation.deleteMany.mockResolvedValue({ count: 0 })
      prismaMock.rawMaterialPresentation.createMany.mockResolvedValue({ count: 2 })
      prismaMock.rawMaterialPresentation.findMany.mockResolvedValue([
        { id: 'p1', name: 'caja', factorToBase: new Decimal(360), isPurchase: true, isDefaultOut: false },
      ])
    })

    it('REGRESIÓN: toma candado de fila del insumo ANTES de borrar (replace-all atómico)', async () => {
      // Sin el `FOR UPDATE`, dos guardados simultáneos del mismo insumo se
      // intercalan en READ COMMITTED y el resultado es la UNIÓN de ambos sets
      // en vez del reemplazo: una presentación borrada por el usuario "revive".
      const order: string[] = []
      prismaMock.$queryRaw.mockImplementation(async () => {
        order.push('lock')
        return []
      })
      prismaMock.rawMaterialPresentation.deleteMany.mockImplementation(async () => {
        order.push('delete')
        return { count: 0 }
      })

      await setPresentations(VENUE, RM, [{ name: 'caja', factorToBase: 360 }], 'staff-1')

      expect(prismaMock.$queryRaw).toHaveBeenCalled()
      expect(order).toEqual(['lock', 'delete'])
    })

    it('guarda el set y audita en ActivityLog', async () => {
      await setPresentations(
        VENUE,
        RM,
        [
          { name: 'caja', factorToBase: 360, isPurchase: true },
          { name: 'cono', factorToBase: 30 },
        ],
        'staff-1',
      )

      expect(prismaMock.rawMaterialPresentation.deleteMany).toHaveBeenCalledWith({ where: { rawMaterialId: RM, venueId: VENUE } })
      expect(prismaMock.rawMaterialPresentation.createMany).toHaveBeenCalled()
      expect(logActionMock).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'RAW_MATERIAL_PRESENTATIONS_UPDATED',
          entity: 'RawMaterial',
          entityId: RM,
          venueId: VENUE,
          staffId: 'staff-1',
        }),
      )
    })

    it('un set vacío limpia las presentaciones (vuelve al comportamiento legacy)', async () => {
      await setPresentations(VENUE, RM, [], 'staff-1')
      expect(prismaMock.rawMaterialPresentation.deleteMany).toHaveBeenCalled()
      expect(prismaMock.rawMaterialPresentation.createMany).not.toHaveBeenCalled()
    })

    it('VALIDA ANTES DE BORRAR: un factor inválido no toca la base', async () => {
      await expect(setPresentations(VENUE, RM, [{ name: 'caja', factorToBase: 0 }], 'staff-1')).rejects.toThrow(/mayor que cero/i)
      expect(prismaMock.rawMaterialPresentation.deleteMany).not.toHaveBeenCalled()
    })

    it('rechaza nombres duplicados sin borrar', async () => {
      await expect(
        setPresentations(
          VENUE,
          RM,
          [
            { name: 'caja', factorToBase: 360 },
            { name: 'caja', factorToBase: 12 },
          ],
          'staff-1',
        ),
      ).rejects.toThrow(/duplicada/i)
      expect(prismaMock.rawMaterialPresentation.deleteMany).not.toHaveBeenCalled()
    })

    it('rechaza dos unidades de compra', async () => {
      await expect(
        setPresentations(
          VENUE,
          RM,
          [
            { name: 'caja', factorToBase: 360, isPurchase: true },
            { name: 'cono', factorToBase: 30, isPurchase: true },
          ],
          'staff-1',
        ),
      ).rejects.toThrow(/una presentación puede ser la unidad de compra/i)
      expect(prismaMock.rawMaterialPresentation.deleteMany).not.toHaveBeenCalled()
    })

    it('TENANT ISOLATION: insumo de otro venue → 404 y cero writes', async () => {
      prismaMock.rawMaterial.findFirst.mockResolvedValue(null)
      await expect(setPresentations('venue-ajeno', RM, [{ name: 'caja', factorToBase: 360 }], 'staff-1')).rejects.toThrow(/no encontrado/i)
      expect(prismaMock.rawMaterialPresentation.deleteMany).not.toHaveBeenCalled()
      expect(logActionMock).not.toHaveBeenCalled()
    })
  })

  describe('listPresentations', () => {
    it('filtra por venue (tenant isolation)', async () => {
      prismaMock.rawMaterial.findFirst.mockResolvedValue({ id: RM, unit: 'PIECE' })
      prismaMock.rawMaterialPresentation.findMany.mockResolvedValue([])

      await listPresentations(VENUE, RM)

      expect(prismaMock.rawMaterialPresentation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { rawMaterialId: RM, venueId: VENUE } }),
      )
    })
  })
})
