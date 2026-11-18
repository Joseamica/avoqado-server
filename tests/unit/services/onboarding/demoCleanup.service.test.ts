// Guards the trial→real conversion against destroying user-captured data.
//
// Real prod bug (audit 2026-08-12, verified): cleanDemoData zeroed NON-demo
// Inventory and RawMaterial stock (`updateMany({ where: { isDemo: false },
// data: { currentStock: 0 } })`) and deleted ALL RawMaterialMovements and
// StockBatches of the venue — wiping the real inventory the user captured
// during the trial. The cleanup must only ever touch isDemo:true data.

import { prismaMock } from '@tests/__helpers__/setup'
import { cleanDemoData } from '@/services/onboarding/demoCleanup.service'
import { Prisma } from '@prisma/client'

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
    // Los candados en SQL (posiciones, negocio, y los de tarifas/costos y canales de na4b2c82): sin filas por default.
    ;(prismaMock.$queryRaw as jest.Mock).mockResolvedValue([])
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

    it('principal demo + secundaria real (Codex r3): como antes borra la configuración, pero NUNCA la cuenta real', async () => {
      conConfig({ primaryAccountId: 'demo-1', secondaryAccountId: 'real-1' })
      sonDemo(['demo-1'])

      const r = await cleanDemoData(VENUE_ID)

      expect(prismaMock.venuePaymentConfig.delete).toHaveBeenCalledWith({ where: { venueId: VENUE_ID } })
      expect(prismaMock.venuePaymentConfig.update).not.toHaveBeenCalled()
      expect(prismaMock.merchantAccount.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['demo-1'] } } })
      expect(r.pagosDemo?.cuentasRealesDesligadas).toEqual([{ posicion: 'SECONDARY', id: 'real-1' }])
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

    it('[real, demo, demo]: vacía las dos demo en una sola escritura y borra sólo sus tarifas', async () => {
      conConfig({ primaryAccountId: 'real-1', secondaryAccountId: 'demo-1', tertiaryAccountId: 'demo-2' })
      sonDemo(['demo-1', 'demo-2'])

      await cleanDemoData(VENUE_ID)

      expect(prismaMock.venuePaymentConfig.delete).not.toHaveBeenCalled()
      expect(prismaMock.venuePaymentConfig.update).toHaveBeenCalledWith({
        where: { venueId: VENUE_ID },
        data: { secondaryAccountId: null, tertiaryAccountId: null },
      })
      expect(prismaMock.venuePricingStructure.deleteMany).toHaveBeenCalledWith({
        where: { venueId: VENUE_ID, accountType: { in: ['SECONDARY', 'TERTIARY'] } },
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

    // hz:nube0000:na4b2c82: al borrar la tarifa o el costo demo, la llave pone en null el enlace de un canal en línea real
    // (FK SET NULL). Se sigue borrando (Codex r2 #1 de fe2b91), pero ANTES se bloquean las estructuras que se van y los canales
    // ligados (Codex r1 #11), y cada canal queda en la bitácora DENTRO de la transacción (Codex r1 #12) y en el resultado.
    const conSql = (responder: (sql: string, valores: unknown[]) => unknown[]) =>
      (prismaMock.$queryRaw as jest.Mock).mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const q = Prisma.sql(strings, ...(values as any[]))
        return responder(q.text, q.values) // `text`: con $1, $2 como los ve Postgres
      })
    const filasDeBitacora = () =>
      (prismaMock.activityLog.create as jest.Mock).mock.calls
        .map(([a]: any) => a.data)
        .filter((d: any) => d.action === 'DEMO_CLEANUP_ECOMMERCE_CHANNEL_UNLINKED')

    it('🔴 canal en línea ligado a la tarifa de una posición demo: se bloquea y se detecta ANTES de borrar, sale en el resultado y en la bitácora', async () => {
      conConfig({ primaryAccountId: 'real-1', secondaryAccountId: 'demo-1' })
      sonDemo(['demo-1'])
      const orden: string[] = []
      const consultas: Array<{ sql: string; valores: unknown[] }> = []
      conSql((sql, valores) => {
        consultas.push({ sql, valores })
        if (sql.includes('FROM "VenuePricingStructure"')) return orden.push('candado-tarifas'), [{ id: 'tarifa-sec' }]
        if (sql.includes('FROM "EcommerceMerchant"') && sql.includes('"pricingStructureId"')) {
          orden.push('canales')
          return [{ id: 'canal-1', venueId: VENUE_ID, channelName: 'Web Principal', estructura: 'tarifa-sec' }]
        }
        return []
      })
      ;(prismaMock.venuePricingStructure.deleteMany as jest.Mock).mockImplementation(async () => (orden.push('borrar'), { count: 1 }))

      const r = await cleanDemoData(VENUE_ID, 'staff-1')

      expect(orden).toEqual(['candado-tarifas', 'canales', 'borrar'])
      const candado = consultas.find(c => c.sql.includes('FROM "VenuePricingStructure"'))!
      expect(candado.sql).toMatch(/"venueId" = \$1 AND "accountType"::text = ANY\(\$2\) FOR UPDATE/)
      expect(candado.valores).toEqual([VENUE_ID, ['SECONDARY']])
      expect(consultas.find(c => c.sql.includes('FROM "EcommerceMerchant"'))!.sql).toMatch(/FOR UPDATE/)
      expect(r.canalesEnLineaSinTarifa).toEqual([
        { id: 'canal-1', venueId: VENUE_ID, channelName: 'Web Principal', perdio: ['tarifa'], pricingStructureId: 'tarifa-sec' },
      ])
      expect(filasDeBitacora()).toEqual([
        expect.objectContaining({
          staffId: null, // Codex r2 #9 y #10: sin actor (la llave no tumba la limpieza; el otro negocio no ve quién)
          venueId: VENUE_ID,
          entity: 'EcommerceMerchant',
          entityId: 'canal-1',
          data: expect.objectContaining({ channelName: 'Web Principal', perdio: ['tarifa'], pricingStructureId: 'tarifa-sec' }),
        }),
      ])
    })

    it('🔴 principal demo: todas las tarifas del negocio y el costo de la cuenta demo; un canal de OTRO negocio va a SU bitácora', async () => {
      conConfig({ primaryAccountId: 'demo-1' })
      sonDemo(['demo-1'])
      const consultasHechas: string[] = []
      conSql(sql => {
        consultasHechas.push(sql)
        if (sql.includes('FROM "VenuePricingStructure"')) return [{ id: 't1' }]
        if (sql.includes('FROM "ProviderCostStructure"')) return [{ id: 'c1' }]
        if (sql.includes('FROM "EcommerceMerchant"') && sql.includes('"pricingStructureId"'))
          return [{ id: 'canal-1', venueId: VENUE_ID, channelName: 'Web Principal', estructura: 't1' }]
        if (sql.includes('FROM "EcommerceMerchant"') && sql.includes('"costStructureId"'))
          return [
            { id: 'canal-1', venueId: VENUE_ID, channelName: 'Web Principal', estructura: 'c1' },
            { id: 'canal-2', venueId: 'otro-negocio', channelName: 'App', estructura: 'c1' },
          ]
        return []
      })

      const r = await cleanDemoData(VENUE_ID, 'staff-1')

      // Codex r2 #7: la cuenta demo se toma `FOR UPDATE` antes de listar sus costos (un costo nuevo no se cuela).
      expect(consultasHechas.some(q => /FROM "MerchantAccount" WHERE id = ANY\(\$1\) FOR UPDATE/.test(q))).toBe(true)
      expect(r.canalesEnLineaSinTarifa).toEqual([
        {
          id: 'canal-1',
          venueId: VENUE_ID,
          channelName: 'Web Principal',
          perdio: ['tarifa', 'costo'],
          pricingStructureId: 't1',
          costStructureId: 'c1',
        },
        { id: 'canal-2', venueId: 'otro-negocio', channelName: 'App', perdio: ['costo'], costStructureId: 'c1' },
      ])
      expect(filasDeBitacora()).toEqual([
        expect.objectContaining({ entityId: 'canal-1', venueId: VENUE_ID }),
        expect.objectContaining({
          entityId: 'canal-2',
          venueId: 'otro-negocio',
          data: expect.not.objectContaining({ negocioConvertido: expect.anything() }),
        }),
      ])
    })

    it('sin canales ligados: resultado vacío y ninguna fila de canal en la bitácora', async () => {
      conConfig({ primaryAccountId: 'real-1', secondaryAccountId: 'demo-1' })
      sonDemo(['demo-1'])

      const r = await cleanDemoData(VENUE_ID)

      expect(r.canalesEnLineaSinTarifa).toEqual([])
      expect(filasDeBitacora()).toEqual([])
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
