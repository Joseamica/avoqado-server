// Guards the trial→real conversion against destroying user-captured data.
//
// Real prod bug (audit 2026-08-12, verified): cleanDemoData zeroed NON-demo
// Inventory and RawMaterial stock (`updateMany({ where: { isDemo: false },
// data: { currentStock: 0 } })`) and deleted ALL RawMaterialMovements and
// StockBatches of the venue — wiping the real inventory the user captured
// during the trial. The cleanup must only ever touch isDemo:true data.

import { prismaMock } from '@tests/__helpers__/setup'
import { cleanDemoData } from '@/services/onboarding/demoCleanup.service'

const VENUE_ID = 'venue-1'

// Every model cleanDemoData mutates or reads. jest.clearAllMocks() in the
// global beforeEach wipes return values, so re-prime before each test.
const TOUCHED_MODELS = [
  'payment',
  'order',
  'orderItem',
  'review',
  'rawMaterialMovement',
  'stockBatch',
  'venuePaymentConfig',
  'venuePricingStructure',
  'providerCostStructure',
  'merchantAccount',
  'organizationPaymentConfig',
  'customer',
  'recipeLine',
  'recipe',
  'inventory',
  'product',
  'productModifierGroup',
  'modifier',
  'modifierGroup',
  'menuCategory',
  'menuCategoryAssignment',
  'menu',
  'table',
  'area',
  'customerGroup',
  'loyaltyConfig',
  'rawMaterial',
] as const

describe('cleanDemoData (trial→real conversion)', () => {
  beforeEach(() => {
    for (const model of TOUCHED_MODELS) {
      const mock = (prismaMock as any)[model]
      mock.deleteMany?.mockResolvedValue({ count: 0 })
      mock.updateMany?.mockResolvedValue({ count: 0 })
      mock.findMany?.mockResolvedValue([])
      mock.findUnique?.mockResolvedValue(null)
    }
    // El candado de posiciones (fe2b91) lee la organización del negocio antes de formarse.
    ;(prismaMock.venue.findUnique as jest.Mock).mockResolvedValue({ organizationId: 'org-1' })
  })

  // ==========================================
  // THE BUG: user-captured (non-demo) inventory must survive conversion
  // ==========================================

  it('never zeroes non-demo Inventory stock', async () => {
    await cleanDemoData(VENUE_ID)

    expect(prismaMock.inventory.updateMany).not.toHaveBeenCalled()
  })

  it('never zeroes non-demo RawMaterial stock or cost', async () => {
    await cleanDemoData(VENUE_ID)

    expect(prismaMock.rawMaterial.updateMany).not.toHaveBeenCalled()
  })

  it('only deletes RawMaterialMovements belonging to demo raw materials', async () => {
    await cleanDemoData(VENUE_ID)

    expect(prismaMock.rawMaterialMovement.deleteMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.rawMaterialMovement.deleteMany).toHaveBeenCalledWith({
      where: { venueId: VENUE_ID, rawMaterial: { isDemo: true } },
    })
  })

  it('only deletes StockBatches belonging to demo raw materials (preserves the FIFO chain of real stock)', async () => {
    await cleanDemoData(VENUE_ID)

    expect(prismaMock.stockBatch.deleteMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.stockBatch.deleteMany).toHaveBeenCalledWith({
      where: { venueId: VENUE_ID, rawMaterial: { isDemo: true } },
    })
  })

  // ==========================================
  // REGRESSION: demo data is still cleaned as before
  // ==========================================

  it('still deletes only isDemo Inventory records', async () => {
    await cleanDemoData(VENUE_ID)

    expect(prismaMock.inventory.deleteMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.inventory.deleteMany).toHaveBeenCalledWith({
      where: { venueId: VENUE_ID, isDemo: true },
    })
  })

  it('still deletes only isDemo RawMaterials', async () => {
    await cleanDemoData(VENUE_ID)

    expect(prismaMock.rawMaterial.deleteMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.rawMaterial.deleteMany).toHaveBeenCalledWith({
      where: { venueId: VENUE_ID, isDemo: true },
    })
  })

  it('still deletes all orders and payments of the venue (transactional demo data)', async () => {
    await cleanDemoData(VENUE_ID)

    expect(prismaMock.payment.deleteMany).toHaveBeenCalledWith({ where: { venueId: VENUE_ID } })
    expect(prismaMock.order.deleteMany).toHaveBeenCalledWith({ where: { venueId: VENUE_ID } })
  })

  it('still deletes only isDemo Products', async () => {
    await cleanDemoData(VENUE_ID)

    expect(prismaMock.product.deleteMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.product.deleteMany).toHaveBeenCalledWith({
      where: { venueId: VENUE_ID, isDemo: true },
    })
  })

  it('reports the demo-scoped movement/batch deletions in the result', async () => {
    prismaMock.rawMaterialMovement.deleteMany.mockResolvedValue({ count: 3 })
    prismaMock.stockBatch.deleteMany.mockResolvedValue({ count: 2 })

    const result = await cleanDemoData(VENUE_ID)

    expect(result.deletedMovements).toBe(3)
    expect(result.deletedBatches).toBe(2)
  })

  it('plan 5 · borra renglones y órdenes ANTES que los productos demo (el trigger de Product lo exige)', async () => {
    prismaMock.order.findMany.mockResolvedValue([{ id: 'o1' }] as never)

    await cleanDemoData(VENUE_ID)

    const productos = prismaMock.product.deleteMany.mock.invocationCallOrder[0]
    expect(prismaMock.orderItem.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(productos)
    expect(prismaMock.order.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(productos)
  })

  // ==========================================
  // Cross-tenant bug (found 2026-09-29, reproduced with data): demo RecipeLines,
  // Recipes and Modifiers were deleted with `{ isDemo: true }` alone, so converting
  // ONE demo venue wiped the demo recipes and extras of EVERY other demo venue.
  // ==========================================

  it('only deletes demo RecipeLines of this venue', async () => {
    await cleanDemoData(VENUE_ID)

    expect(prismaMock.recipeLine.deleteMany).toHaveBeenCalledWith({
      where: { isDemo: true, recipe: { product: { venueId: VENUE_ID } } },
    })
  })

  it('only deletes demo Recipes of this venue', async () => {
    await cleanDemoData(VENUE_ID)

    expect(prismaMock.recipe.deleteMany).toHaveBeenCalledWith({
      where: { isDemo: true, product: { venueId: VENUE_ID } },
    })
  })

  it('only deletes demo Modifiers of this venue', async () => {
    await cleanDemoData(VENUE_ID)

    expect(prismaMock.modifier.deleteMany).toHaveBeenCalledWith({
      where: { isDemo: true, group: { venueId: VENUE_ID } },
    })
  })

  it('scopes EVERY delete to this venue (no cleanup can reach another tenant)', async () => {
    await cleanDemoData(VENUE_ID)

    const sinAcotar = TOUCHED_MODELS.flatMap(model =>
      ((prismaMock as any)[model].deleteMany?.mock.calls ?? [])
        .filter(([args]: [unknown]) => !JSON.stringify(args).includes(VENUE_ID))
        .map(([args]: [unknown]) => `${model}: ${JSON.stringify(args)}`),
    )
    expect(sinAcotar).toEqual([])
  })
  // Encargo fe2b91 (hz:87f4b879:D7): una cuenta demo en UNA posición ya no borra la configuración entera ni las tarifas de las
  // posiciones con cuenta real. La prueba contra base real está en tests/integration/demo/limpiezaDemoCuentasReales.
  describe('cuentas de cobro: sólo se limpia la posición con cuenta demo', () => {
    const conConfig = (config: { primaryAccountId: string; secondaryAccountId?: string | null; tertiaryAccountId?: string | null }) => {
      ;(prismaMock.venuePaymentConfig.findUnique as jest.Mock).mockResolvedValue({
        secondaryAccountId: null,
        tertiaryAccountId: null,
        ...config,
      })
    }
    // `enUso`: cuentas demo que alguna configuración (negocio u organización) sigue usando después de la limpieza.
    const sonDemo = (ids: string[], enUso: string[] = []) =>
      (prismaMock.merchantAccount.findMany as jest.Mock).mockImplementation(async ({ where }: any) =>
        (where.id.in as string[])
          .filter(id => ids.includes(id))
          .filter(id => (where.venueConfigsPrimary ? !enUso.includes(id) : true))
          .map(id => ({ id })),
      )

    it('🔴 principal real + secundaria demo: NO borra la configuración; vacía sólo la secundaria y borra sólo su tarifa', async () => {
      conConfig({ primaryAccountId: 'real-1', secondaryAccountId: 'demo-1' })
      sonDemo(['demo-1'])

      await cleanDemoData(VENUE_ID)

      expect(prismaMock.venuePaymentConfig.delete).not.toHaveBeenCalled()
      expect(prismaMock.venuePaymentConfig.update).toHaveBeenCalledWith({
        where: { venueId: VENUE_ID },
        data: { secondaryAccountId: null },
      })
      expect(prismaMock.venuePricingStructure.deleteMany).toHaveBeenCalledWith({
        where: { venueId: VENUE_ID, accountType: { in: ['SECONDARY'] } },
      })
    })

    it('🔴 principal demo + secundaria real: no borra ni vacía nada de pagos (la principal no puede quedar vacía)', async () => {
      conConfig({ primaryAccountId: 'demo-1', secondaryAccountId: 'real-1' })
      sonDemo(['demo-1'])

      await cleanDemoData(VENUE_ID)

      expect(prismaMock.venuePaymentConfig.delete).not.toHaveBeenCalled()
      expect(prismaMock.venuePaymentConfig.update).not.toHaveBeenCalled()
      expect(prismaMock.venuePricingStructure.deleteMany).not.toHaveBeenCalled()
    })

    it('regresión · todas demo: borra la configuración y todas sus tarifas, como siempre', async () => {
      conConfig({ primaryAccountId: 'demo-1', secondaryAccountId: 'demo-2' })
      sonDemo(['demo-1', 'demo-2'])

      await cleanDemoData(VENUE_ID)

      expect(prismaMock.venuePaymentConfig.delete).toHaveBeenCalledWith({ where: { venueId: VENUE_ID } })
      expect(prismaMock.venuePricingStructure.deleteMany).toHaveBeenCalledWith({
        where: { venueId: VENUE_ID },
      })
    })

    it('[demo, demo, real]: la principal demo se queda; la secundaria demo se vacía con su tarifa', async () => {
      conConfig({ primaryAccountId: 'demo-1', secondaryAccountId: 'demo-2', tertiaryAccountId: 'real-1' })
      sonDemo(['demo-1', 'demo-2'])

      await cleanDemoData(VENUE_ID)

      expect(prismaMock.venuePaymentConfig.delete).not.toHaveBeenCalled()
      expect(prismaMock.venuePaymentConfig.update).toHaveBeenCalledWith({
        where: { venueId: VENUE_ID },
        data: { secondaryAccountId: null },
      })
    })

    it('Codex r1 #1: toma el candado de posiciones ANTES de leer la configuración de pagos', async () => {
      conConfig({ primaryAccountId: 'real-1', secondaryAccountId: 'demo-1' })
      sonDemo(['demo-1'])
      const orden: string[] = []
      ;(prismaMock.$queryRaw as jest.Mock).mockImplementation(async (strings: TemplateStringsArray) => {
        if (strings.join('?').includes('posiciones-de-cobro') || strings.join('?').includes('pg_advisory_xact_lock')) orden.push('candado')
        return []
      })
      ;(prismaMock.venuePaymentConfig.findUnique as jest.Mock).mockImplementation(async () => {
        orden.push('leer')
        return { primaryAccountId: 'real-1', secondaryAccountId: 'demo-1', tertiaryAccountId: null }
      })

      await cleanDemoData(VENUE_ID)

      expect(orden[0]).toBe('candado')
      expect(orden).toContain('leer')
    })

    it('Codex r1/r2 #2: una cuenta demo que usa una organización no se borra (su llave tumbaría toda la limpieza)', async () => {
      conConfig({ primaryAccountId: 'demo-1', secondaryAccountId: 'demo-2' })
      sonDemo(['demo-1', 'demo-2'], ['demo-2'])

      await cleanDemoData(VENUE_ID)

      expect(prismaMock.merchantAccount.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['demo-1'] } } })
      // Se pregunta por cada cuenta, también por las organizaciones, sin tope.
      expect(prismaMock.merchantAccount.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            orgConfigsPrimary: { none: {} },
            orgConfigsSecondary: { none: {} },
            orgConfigsTertiary: { none: {} },
          }),
        }),
      )
    })

    it('regresión · todas reales: no toca la configuración ni las tarifas', async () => {
      conConfig({ primaryAccountId: 'real-1', secondaryAccountId: 'real-2' })
      sonDemo([])

      await cleanDemoData(VENUE_ID)

      expect(prismaMock.venuePaymentConfig.delete).not.toHaveBeenCalled()
      expect(prismaMock.venuePaymentConfig.update).not.toHaveBeenCalled()
      expect(prismaMock.venuePricingStructure.deleteMany).not.toHaveBeenCalled()
    })
  })

  // S5b (red por traba, R65 b): el resultado nace dentro de cada intento y sale en el retorno.
  describe('tras un 40P01 sólo cuenta el intento ganador', () => {
    const abortarElPrimerIntento = () => {
      let llamada = 0
      prismaMock.$transaction.mockImplementation((async (cb: any) => {
        const r = await cb(prismaMock)
        if (++llamada === 1) throw Object.assign(new Error('deadlock detected'), { code: '40P01' })
        return r
      }) as any)
    }
    afterEach(() => {
      prismaMock.$transaction.mockImplementation(((cb: any) => cb(prismaMock)) as any)
    })

    it('[repetirNoDuplica:cleanDemoData] los conteos del intento ABORTADO no se cuelan: si el ganador se salta (GIFT_CARDS), nada de lo que borró el primero queda en el resultado', async () => {
      // Intento 1: sin tarjetas ⇒ borra (cuenta 5 pagos) y se aborta. Intento 2: ya hay una tarjeta vendida ⇒ salta sin borrar nada.
      ;(prismaMock.payment.deleteMany as jest.Mock).mockResolvedValue({ count: 5 })
      ;(prismaMock.giftCard.findFirst as jest.Mock).mockResolvedValueOnce(null).mockResolvedValue({ id: 'gc1' })
      abortarElPrimerIntento()

      const r = await cleanDemoData(VENUE_ID)

      expect(r.skippedReason).toBe('GIFT_CARDS')
      expect(r.deletedPayments).toBe(0)
      expect(r.deletedOrders).toBe(0)
    })

    it('[repetirNoDuplica:cleanDemoData] un «salto» (GIFT_CARDS) del intento abortado no se queda pegado al resultado del ganador', async () => {
      ;(prismaMock.giftCard.findFirst as jest.Mock).mockResolvedValueOnce({ id: 'gc1' }).mockResolvedValue(null)
      abortarElPrimerIntento()

      const r = await cleanDemoData(VENUE_ID)

      expect(r.skippedReason).toBeUndefined()
      expect(prismaMock.payment.deleteMany).toHaveBeenCalled()
    })
  })
})
