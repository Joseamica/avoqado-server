/**
 * Extra ligado a un PLATILLO del menú (encargo 27771e; founder, 16-nov-2026: como Fudo y Toast; Pro y Premium desde el 20-nov).
 *
 * El dueño escoge en la ficha del extra el platillo que ese extra «es». Reglas al ligar:
 *  - Pro y Premium (`ADVANCED_REPORTS`, el plan del reporte; founder «A», 20-nov) sólo para PONERLO; quitarlo siempre se puede.
 *    Antes era Premium (INVENTORY_TRACKING). Que DESCUENTE sigue siendo Premium: lo decide el inventario del platillo.
 *  - Mismo negocio, no borrado y que no se venda por kilo. Sin inventario también se liga (founder «B», 20-nov, Flautas): ahí no
 *    descuenta nada y sólo cuenta en «Ventas por artículo» como «Dentro de paquete».
 *  - Un extra descuenta un insumo o un platillo, no los dos.
 *  - El costo del extra pasa a ser el del platillo (receta o costo del producto).
 *  - La bitácora del dueño dice de qué platillo a qué platillo.
 */
import { Prisma } from '@prisma/client'
import { CreateModifierSchema, UpdateModifierSchema } from '@/schemas/dashboard/menu.schema'
import { createModifier, getModifierById, searchLinkableProducts, updateModifier } from '@/services/dashboard/menu.dashboard.service'
import { prismaMock } from '../../../__helpers__/setup'

jest.mock('@/services/access/basePlan.service', () => ({
  ...jest.requireActual('@/services/access/basePlan.service'),
  venueHasFeatureAccess: jest.fn(),
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import { elPlanConcede, venueHasFeatureAccess } from '@/services/access/basePlan.service'
import { LIGA_DE_EXTRA_PLAN } from '@/services/dashboard/menu.dashboard.service'
import { logAction } from '@/services/dashboard/activity-log.service'

const params = {
  venueId: 'cjld2cjxh0000qzrmn831i7rn',
  modifierGroupId: 'cjld2cjxh0001qzrmn831i7ro',
  modifierId: 'cjld2cjxh0002qzrmn831i7rp',
}
const PAPAS_ID = 'cjld2cjxh0004qzrmn831i7rs'
const AROS_ID = 'cjld2cjxh0005qzrmn831i7rt'
const RAW_MATERIAL_ID = 'cjld2cjxh0003qzrmn831i7rq'

const papas = {
  id: PAPAS_ID,
  name: 'Papas a la francesa',
  trackInventory: true,
  inventoryMethod: 'QUANTITY',
  soldByWeight: false,
  cost: new Prisma.Decimal('12.50'),
  recipe: null,
}
const aros = {
  id: AROS_ID,
  name: 'Aros de cebolla',
  trackInventory: true,
  inventoryMethod: 'RECIPE',
  soldByWeight: false,
  cost: null,
  recipe: { totalCost: new Prisma.Decimal('8.2500') },
}

const parseAlta = (body: any) => CreateModifierSchema.parse({ params, body }).body
const parseEdicion = (body: any) => UpdateModifierSchema.parse({ params, body }).body
const premium = (on: boolean) => (venueHasFeatureAccess as jest.Mock).mockResolvedValue(on)

describe('Extra ligado a un platillo del menú', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    premium(true)
    prismaMock.modifierGroup.findFirst.mockResolvedValue({ id: params.modifierGroupId } as any)
    prismaMock.modifier.findFirst.mockResolvedValue({
      id: params.modifierId,
      name: 'Papas',
      rawMaterialId: null,
      linkedProductId: null,
      quantityPerUnit: null,
    } as any)
    prismaMock.modifier.create.mockImplementation(
      (args: any) => Promise.resolve({ id: 'nuevo', name: args.data.name, ...args.data }) as any,
    )
    prismaMock.modifier.update.mockImplementation(
      (args: any) => Promise.resolve({ id: params.modifierId, name: 'Papas', ...args.data }) as any,
    )
    prismaMock.product.findFirst.mockImplementation(((args: any) =>
      Promise.resolve(args.where.id === PAPAS_ID ? papas : args.where.id === AROS_ID ? aros : null)) as any)
  })

  it('el schema acepta el platillo ligado (y null para quitarlo)', () => {
    expect(parseAlta({ name: 'Papas', price: 0, linkedProductId: PAPAS_ID }).linkedProductId).toBe(PAPAS_ID)
    expect(parseEdicion({ linkedProductId: null }).linkedProductId).toBeNull()
    expect(() => parseEdicion({ linkedProductId: 'no es un id; DROP' })).toThrow()
  })

  it('al CREAR, liga el platillo del mismo negocio, con su costo, y lo anota en la bitácora', async () => {
    await createModifier(params.venueId, params.modifierGroupId, parseAlta({ name: 'Papas', price: 25, linkedProductId: PAPAS_ID }))
    const data = (prismaMock.modifier.create.mock.calls[0][0] as any).data
    expect(data.linkedProduct).toEqual({ connect: { id: PAPAS_ID } })
    expect(data.cost.toString()).toBe('12.5')
    expect(prismaMock.product.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: PAPAS_ID, venueId: params.venueId, deletedAt: null }) }),
    )
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'MODIFIER_CREATED',
        data: expect.objectContaining({ linkedProduct: { id: PAPAS_ID, name: 'Papas a la francesa' } }),
      }),
    )
  })

  it('al EDITAR, un platillo por receta toma el costo de su receta y la bitácora dice de cuál a cuál', async () => {
    prismaMock.modifier.findFirst.mockResolvedValue({
      id: params.modifierId,
      name: 'Papas',
      rawMaterialId: null,
      linkedProductId: PAPAS_ID,
    } as any)
    await updateModifier(params.venueId, params.modifierGroupId, params.modifierId, parseEdicion({ linkedProductId: AROS_ID }))
    const data = (prismaMock.modifier.update.mock.calls[0][0] as any).data
    expect(data.linkedProduct).toEqual({ connect: { id: AROS_ID } })
    expect(data.cost.toString()).toBe('8.25')
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'MODIFIER_UPDATED',
        data: expect.objectContaining({ linkedProduct: { from: PAPAS_ID, to: AROS_ID } }),
      }),
    )
  })

  it('sin Pro (plan Gratis) no se puede PONER: 403 con código y explicación, sin escribir', async () => {
    premium(false)
    const err = await updateModifier(
      params.venueId,
      params.modifierGroupId,
      params.modifierId,
      parseEdicion({ linkedProductId: PAPAS_ID }),
    ).catch(e => e)
    expect(err.statusCode).toBe(403)
    expect(err.code).toBe('MODIFIER_LINK_REQUIRES_PREMIUM')
    expect(err.message).toMatch(/plan Pro/)
    expect(prismaMock.modifier.update).not.toHaveBeenCalled()
    expect(venueHasFeatureAccess).toHaveBeenCalledWith(params.venueId, 'ADVANCED_REPORTS')
  })

  it('founder «A» (20-nov): Pro y Premium ligan — el candado es el del reporte, no el de inventario', () => {
    expect(LIGA_DE_EXTRA_PLAN).toEqual({ feature: 'ADVANCED_REPORTS', plan: 'Pro' })
    expect(elPlanConcede('PRO', LIGA_DE_EXTRA_PLAN!.feature)).toBe(true)
    expect(elPlanConcede('PREMIUM', LIGA_DE_EXTRA_PLAN!.feature)).toBe(true)
  })

  it('un negocio Pro (con reportes, SIN inventario Premium) liga su extra', async () => {
    ;(venueHasFeatureAccess as jest.Mock).mockImplementation(async (_venueId: string, code: string) => code === 'ADVANCED_REPORTS')
    prismaMock.product.findFirst.mockResolvedValue({ ...papas, trackInventory: false, inventoryMethod: null } as any)
    await createModifier(params.venueId, params.modifierGroupId, parseAlta({ name: 'Papas', price: 0, linkedProductId: PAPAS_ID }))
    const data = (prismaMock.modifier.create.mock.calls[0][0] as any).data
    expect(data.linkedProduct).toEqual({ connect: { id: PAPAS_ID } })
    expect(venueHasFeatureAccess).not.toHaveBeenCalledWith(params.venueId, 'INVENTORY_TRACKING')
  })

  it('sin plan SÍ se puede QUITAR (bajar de plan no deja el extra atorado)', async () => {
    premium(false)
    prismaMock.modifier.findFirst.mockResolvedValue({
      id: params.modifierId,
      name: 'Papas',
      rawMaterialId: null,
      linkedProductId: PAPAS_ID,
    } as any)
    await updateModifier(params.venueId, params.modifierGroupId, params.modifierId, parseEdicion({ linkedProductId: null }))
    const data = (prismaMock.modifier.update.mock.calls[0][0] as any).data
    expect(data.linkedProduct).toEqual({ disconnect: true })
    expect(data.cost).toBeNull()
  })

  it('un platillo de OTRO negocio (o borrado) es 404 y no se liga', async () => {
    const otro = 'cjld2cjxh0009qzrmn831i7rz'
    const err = await updateModifier(
      params.venueId,
      params.modifierGroupId,
      params.modifierId,
      parseEdicion({ linkedProductId: otro }),
    ).catch(e => e)
    expect(err.statusCode).toBe(404)
    expect(prismaMock.modifier.update).not.toHaveBeenCalled()
  })

  it('un platillo SIN inventario SÍ se liga (founder «B», 20-nov): no descuenta nada, sólo cuenta en «Dentro de paquete»', async () => {
    prismaMock.product.findFirst.mockResolvedValue({ ...papas, trackInventory: false, inventoryMethod: null } as any)
    await updateModifier(params.venueId, params.modifierGroupId, params.modifierId, parseEdicion({ linkedProductId: PAPAS_ID }))
    const data = (prismaMock.modifier.update.mock.calls[0][0] as any).data
    expect(data.linkedProduct).toEqual({ connect: { id: PAPAS_ID } })
    // Sin inventario la liga sólo cuenta: no lleva costo, para no mover el reporte de costos de extras (Codex r1 #7).
    expect(data.cost).toBeNull()
  })

  it('Codex r1 #1: un negocio Pro NO liga un platillo CON inventario (descontar sigue siendo Premium)', async () => {
    ;(venueHasFeatureAccess as jest.Mock).mockImplementation(async (_venueId: string, code: string) => code === 'ADVANCED_REPORTS')
    const err = await createModifier(
      params.venueId,
      params.modifierGroupId,
      parseAlta({ name: 'Papas', price: 0, linkedProductId: PAPAS_ID }), // papas: por piezas, se descontaría
    ).catch(e => e)
    expect(err.statusCode).toBe(403)
    expect(err.code).toBe('MODIFIER_LINK_DEDUCT_REQUIRES_PREMIUM')
    expect(err.message).toMatch(/Premium/)
    expect(prismaMock.modifier.create).not.toHaveBeenCalled()
    expect(venueHasFeatureAccess).toHaveBeenCalledWith(params.venueId, 'INVENTORY_TRACKING')
  })

  it('Codex r3 #7: con el efecto esperado de la MCP, si el inventario del platillo cambió desde la vista previa, no guarda (409)', async () => {
    // La vista previa dijo «sólo cuenta» (false), pero hoy las papas llevan inventario (por piezas).
    const err = await updateModifier(
      params.venueId,
      params.modifierGroupId,
      params.modifierId,
      parseEdicion({ linkedProductId: PAPAS_ID }),
      { linkedDeducts: false },
    ).catch(e => e)
    expect(err.statusCode).toBe(409)
    expect(err.code).toBe('MODIFIER_LINK_EFFECT_CHANGED')
    expect(prismaMock.modifier.update).not.toHaveBeenCalled()
    // Con el efecto correcto, sí guarda.
    await updateModifier(params.venueId, params.modifierGroupId, params.modifierId, parseEdicion({ linkedProductId: PAPAS_ID }), {
      linkedDeducts: true,
    })
    expect(prismaMock.modifier.update).toHaveBeenCalledTimes(1)
  })

  it('sin inventario y sin costo: se liga con costo vacío (no inventa uno)', async () => {
    prismaMock.product.findFirst.mockResolvedValue({ ...papas, trackInventory: false, inventoryMethod: null, cost: null } as any)
    await createModifier(params.venueId, params.modifierGroupId, parseAlta({ name: 'Papas', price: 0, linkedProductId: PAPAS_ID }))
    const data = (prismaMock.modifier.create.mock.calls[0][0] as any).data
    expect(data.linkedProduct).toEqual({ connect: { id: PAPAS_ID } })
    expect(data.cost).toBeNull()
  })

  it('el candado de plan (Pro) sigue pidiéndose aunque el platillo no lleve inventario', async () => {
    premium(false)
    prismaMock.product.findFirst.mockResolvedValue({ ...papas, trackInventory: false, inventoryMethod: null } as any)
    const err = await createModifier(
      params.venueId,
      params.modifierGroupId,
      parseAlta({ name: 'Papas', price: 0, linkedProductId: PAPAS_ID }),
    ).catch(e => e)
    expect(err.code).toBe('MODIFIER_LINK_REQUIRES_PREMIUM')
    expect(prismaMock.modifier.create).not.toHaveBeenCalled()
  })

  it('un platillo que se vende por kilo se rechaza', async () => {
    prismaMock.product.findFirst.mockResolvedValue({ ...papas, soldByWeight: true } as any)
    const err = await updateModifier(
      params.venueId,
      params.modifierGroupId,
      params.modifierId,
      parseEdicion({ linkedProductId: PAPAS_ID }),
    ).catch(e => e)
    expect(err.statusCode).toBe(400)
    expect(err.code).toBe('MODIFIER_LINK_SOLD_BY_WEIGHT')
  })

  it('insumo Y platillo a la vez se rechaza (en la misma petición o contra lo guardado)', async () => {
    prismaMock.rawMaterial.findFirst.mockResolvedValue({ id: RAW_MATERIAL_ID, avgCostPerUnit: new Prisma.Decimal('1') } as any)
    const a = await updateModifier(
      params.venueId,
      params.modifierGroupId,
      params.modifierId,
      parseEdicion({ linkedProductId: PAPAS_ID, rawMaterialId: RAW_MATERIAL_ID, quantityPerUnit: 1, unit: 'GRAM' }),
    ).catch(e => e)
    expect(a.code).toBe('MODIFIER_LINK_AND_RAW_MATERIAL')

    prismaMock.modifier.findFirst.mockResolvedValue({
      id: params.modifierId,
      name: 'Papas',
      rawMaterialId: RAW_MATERIAL_ID,
      linkedProductId: null,
    } as any)
    const b = await updateModifier(
      params.venueId,
      params.modifierGroupId,
      params.modifierId,
      parseEdicion({ linkedProductId: PAPAS_ID }),
    ).catch(e => e)
    expect(b.code).toBe('MODIFIER_LINK_AND_RAW_MATERIAL')

    prismaMock.modifier.findFirst.mockResolvedValue({
      id: params.modifierId,
      name: 'Papas',
      rawMaterialId: null,
      linkedProductId: PAPAS_ID,
    } as any)
    const c = await updateModifier(
      params.venueId,
      params.modifierGroupId,
      params.modifierId,
      parseEdicion({ rawMaterialId: RAW_MATERIAL_ID, quantityPerUnit: 1, unit: 'GRAM' }),
    ).catch(e => e)
    expect(c.code).toBe('MODIFIER_LINK_AND_RAW_MATERIAL')
    expect(prismaMock.modifier.update).not.toHaveBeenCalled()
  })

  it('cambiar de platillo a insumo en UNA petición (quita el ligado y pone el insumo) sí se puede', async () => {
    prismaMock.rawMaterial.findFirst.mockResolvedValue({ id: RAW_MATERIAL_ID, avgCostPerUnit: new Prisma.Decimal('2') } as any)
    prismaMock.modifier.findFirst.mockResolvedValue({
      id: params.modifierId,
      name: 'Papas',
      rawMaterialId: null,
      linkedProductId: PAPAS_ID,
    } as any)
    await updateModifier(
      params.venueId,
      params.modifierGroupId,
      params.modifierId,
      parseEdicion({ linkedProductId: null, rawMaterialId: RAW_MATERIAL_ID, quantityPerUnit: 3, unit: 'GRAM' }),
    )
    const data = (prismaMock.modifier.update.mock.calls[0][0] as any).data
    expect(data.linkedProduct).toEqual({ disconnect: true })
    expect(data.rawMaterial).toEqual({ connect: { id: RAW_MATERIAL_ID } })
    expect(data.cost.toString()).toBe('6')
  })

  it('regresión: una app vieja que edita el extra sin mandar el campo no toca el ligado ni pide plan', async () => {
    premium(false)
    prismaMock.modifier.findFirst.mockResolvedValue({
      id: params.modifierId,
      name: 'Papas',
      rawMaterialId: null,
      linkedProductId: PAPAS_ID,
    } as any)
    await updateModifier(params.venueId, params.modifierGroupId, params.modifierId, parseEdicion({ price: 30, active: true }))
    const data = (prismaMock.modifier.update.mock.calls[0][0] as any).data
    expect('linkedProduct' in data).toBe(false)
    expect('cost' in data).toBe(false)
    expect(venueHasFeatureAccess).not.toHaveBeenCalled()
  })

  it('re-mandar el MISMO platillo (editar el precio) no pide plan ni reescribe el ligado', async () => {
    premium(false)
    prismaMock.modifier.findFirst.mockResolvedValue({
      id: params.modifierId,
      name: 'Papas',
      rawMaterialId: null,
      linkedProductId: PAPAS_ID,
    } as any)
    await updateModifier(params.venueId, params.modifierGroupId, params.modifierId, parseEdicion({ price: 30, linkedProductId: PAPAS_ID }))
    const data = (prismaMock.modifier.update.mock.calls[0][0] as any).data
    expect('linkedProduct' in data).toBe(false)
    expect(venueHasFeatureAccess).not.toHaveBeenCalled()
  })

  it('Codex r3 #3: lo que manda el DASHBOARD (limpiar el ingrediente con nulls) no borra el costo del platillo ligado', async () => {
    const limpiarIngrediente = { rawMaterialId: null, quantityPerUnit: null, unit: null, inventoryMode: null }
    await updateModifier(
      params.venueId,
      params.modifierGroupId,
      params.modifierId,
      parseEdicion({ ...limpiarIngrediente, linkedProductId: PAPAS_ID }),
    )
    expect((prismaMock.modifier.update.mock.calls[0][0] as any).data.cost.toString()).toBe('12.5')

    prismaMock.modifier.findFirst.mockResolvedValue({
      id: params.modifierId,
      name: 'Papas',
      rawMaterialId: null,
      linkedProductId: PAPAS_ID,
    } as any)
    await updateModifier(params.venueId, params.modifierGroupId, params.modifierId, parseEdicion({ ...limpiarIngrediente, price: 30 }))
    expect('cost' in (prismaMock.modifier.update.mock.calls[1][0] as any).data).toBe(false)
  })

  it('la ficha del extra devuelve el platillo ligado con lo que la pantalla necesita para avisar', async () => {
    prismaMock.modifier.findFirst.mockResolvedValue({ id: params.modifierId } as any)
    await getModifierById(params.venueId, params.modifierGroupId, params.modifierId)
    const include = (prismaMock.modifier.findFirst.mock.calls[0][0] as any).include
    expect(include.linkedProduct.select).toMatchObject({
      id: true,
      name: true,
      trackInventory: true,
      inventoryMethod: true,
      soldByWeight: true,
    })
  })
})

describe('Buscador del platillo a ligar (acotado en el servidor)', () => {
  const fila = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    name: `Platillo ${id}`,
    active: true,
    trackInventory: true,
    inventoryMethod: 'QUANTITY',
    soldByWeight: false,
    recipe: null,
    category: { name: 'Acompañantes' },
    ...over,
  })

  beforeEach(() => jest.clearAllMocks())

  it('un límite hostil se recorta a 50 y el orden es fijo (nombre, id) con el total real', async () => {
    prismaMock.product.count.mockResolvedValue(1234 as any)
    prismaMock.product.findMany.mockResolvedValue([] as any)
    const out = await searchLinkableProducts(params.venueId, { limit: 100000 })
    const args = prismaMock.product.findMany.mock.calls[0][0] as any
    expect(args.take).toBe(51)
    expect(args.orderBy).toEqual([{ name: 'asc' }, { id: 'asc' }])
    expect(args.where).toMatchObject({ venueId: params.venueId, deletedAt: null })
    expect(out.total).toBe(1234)
  })

  it('busca por nombre en el servidor y pagina con cursor', async () => {
    prismaMock.product.count.mockResolvedValue(3 as any)
    prismaMock.product.findMany.mockResolvedValue([fila('a'), fila('b'), fila('c')] as any)
    const out = await searchLinkableProducts(params.venueId, { search: 'papa', limit: 2, cursor: 'z' })
    const args = prismaMock.product.findMany.mock.calls[0][0] as any
    expect(args.where.name).toEqual({ contains: 'papa', mode: 'insensitive' })
    expect(args.cursor).toEqual({ id: 'z' })
    expect(args.skip).toBe(1)
    expect(out.data.map(d => d.id)).toEqual(['a', 'b'])
    expect(out.hasMore).toBe(true)
    expect(out.nextCursor).toBe('b')
  })

  it('marca en gris sólo los de kilo; uno sin inventario se puede ligar (sólo cuenta en el reporte)', async () => {
    prismaMock.product.count.mockResolvedValue(4 as any)
    prismaMock.product.findMany.mockResolvedValue([
      fila('ok'),
      fila('receta', { inventoryMethod: null, recipe: { id: 'r' } }),
      fila('sin', { trackInventory: false, inventoryMethod: null }),
      fila('kilo', { soldByWeight: true }),
    ] as any)
    const out = await searchLinkableProducts(params.venueId, {})
    expect(out.data.map(d => [d.id, d.linkable, d.blockedReason])).toEqual([
      ['ok', true, null],
      ['receta', true, null],
      ['sin', true, null],
      ['kilo', false, 'SOLD_BY_WEIGHT'],
    ])
    expect(out.hasMore).toBe(false)
    expect(out.nextCursor).toBeNull()
  })

  it('Codex r1 #1: en un negocio Pro, los que llevan inventario salen en gris (descontar es Premium); sin inventario se ligan', async () => {
    ;(venueHasFeatureAccess as jest.Mock).mockImplementation(async (_venueId: string, code: string) => code === 'ADVANCED_REPORTS')
    prismaMock.product.count.mockResolvedValue(3 as any)
    prismaMock.product.findMany.mockResolvedValue([
      fila('ok'),
      fila('receta', { inventoryMethod: null, recipe: { id: 'r' } }),
      fila('sin', { trackInventory: false, inventoryMethod: null }),
    ] as any)
    const out = await searchLinkableProducts(params.venueId, {})
    expect(out.data.map(d => [d.id, d.linkable, d.blockedReason])).toEqual([
      ['ok', false, 'DEDUCT_NEEDS_PREMIUM'],
      ['receta', false, 'DEDUCT_NEEDS_PREMIUM'],
      ['sin', true, null],
    ])
  })
})
