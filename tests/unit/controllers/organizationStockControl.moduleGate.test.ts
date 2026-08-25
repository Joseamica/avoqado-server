import { prismaMock } from '@tests/__helpers__/setup'
import { isSerializedInventoryOrg, isWhiteLabelOrg } from '@/controllers/dashboard/organizationStockControl.controller'

/**
 * El Control de Stock sirve inventario serializado, así que su candado es el
 * módulo SERIALIZED_INVENTORY — nunca WHITE_LABEL_DASHBOARD.
 *
 * Son módulos independientes. Cruzarlos falla EN SILENCIO: el único tenant real
 * hoy tiene los dos, así que un candado equivocado "pasa" para todos y nadie se
 * entera hasta que llega un cliente con uno solo.
 * Ver `.claude/rules/feature-gating.md`.
 */

const ORG = 'org-1'

function mockModules({ orgLevel, venueLevel }: { orgLevel: string | null; venueLevel: number }) {
  prismaMock.organizationModule.findFirst.mockImplementation(((args: any) => {
    const code = args?.where?.module?.code
    return Promise.resolve(orgLevel === code ? { id: 'om-1' } : null)
  }) as any)
  prismaMock.venueModule.count.mockResolvedValue(venueLevel as any)
}

describe('candado de módulo del Control de Stock', () => {
  describe('isSerializedInventoryOrg', () => {
    it('pasa si el módulo está a nivel organización', async () => {
      mockModules({ orgLevel: 'SERIALIZED_INVENTORY', venueLevel: 0 })
      await expect(isSerializedInventoryOrg(ORG)).resolves.toBe(true)
    })

    it('pasa si algún venue de la organización lo tiene, aunque la org no', async () => {
      mockModules({ orgLevel: null, venueLevel: 3 })
      await expect(isSerializedInventoryOrg(ORG)).resolves.toBe(true)
    })

    it('NO pasa si no está en ningún nivel', async () => {
      mockModules({ orgLevel: null, venueLevel: 0 })
      await expect(isSerializedInventoryOrg(ORG)).resolves.toBe(false)
    })

    it('🔴 tener marca blanca NO abre el inventario serializado', async () => {
      // El caso que el candado anterior dejaba pasar por error.
      mockModules({ orgLevel: 'WHITE_LABEL_DASHBOARD', venueLevel: 0 })
      await expect(isSerializedInventoryOrg(ORG)).resolves.toBe(false)
    })

    it('🔴 NO tener marca blanca no bloquea a quien sí tiene inventario serializado', async () => {
      // El caso que el candado anterior bloqueaba por error: el tenant pagó
      // inventario serializado y no podía ver su propio inventario.
      mockModules({ orgLevel: 'SERIALIZED_INVENTORY', venueLevel: 0 })
      await expect(isSerializedInventoryOrg(ORG)).resolves.toBe(true)
      await expect(isWhiteLabelOrg(ORG)).resolves.toBe(false)
    })

    it('pregunta por el código de módulo correcto', async () => {
      mockModules({ orgLevel: null, venueLevel: 0 })
      await isSerializedInventoryOrg(ORG)

      expect(prismaMock.organizationModule.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            organizationId: ORG,
            enabled: true,
            module: { code: 'SERIALIZED_INVENTORY' },
          }),
        }),
      )
    })
  })

  describe('regresión: isWhiteLabelOrg sigue intacta para lo suyo', () => {
    it('sigue respondiendo por WHITE_LABEL_DASHBOARD — la usa la ubicación de TPVs', async () => {
      mockModules({ orgLevel: 'WHITE_LABEL_DASHBOARD', venueLevel: 0 })
      await expect(isWhiteLabelOrg(ORG)).resolves.toBe(true)
    })

    it('no confunde inventario serializado con marca blanca', async () => {
      mockModules({ orgLevel: 'SERIALIZED_INVENTORY', venueLevel: 0 })
      await expect(isWhiteLabelOrg(ORG)).resolves.toBe(false)
    })
  })

  describe('el tenant real de hoy', () => {
    it('con ambos módulos a nivel org, pasa los dos candados — el cambio no lo afecta', async () => {
      prismaMock.organizationModule.findFirst.mockResolvedValue({ id: 'om-1' } as any)
      prismaMock.venueModule.count.mockResolvedValue(0 as any)

      await expect(isSerializedInventoryOrg(ORG)).resolves.toBe(true)
      await expect(isWhiteLabelOrg(ORG)).resolves.toBe(true)
    })
  })
})
