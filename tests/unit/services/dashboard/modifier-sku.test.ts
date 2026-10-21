import { Prisma } from '@prisma/client'
import { CreateModifierSchema, UpdateModifierSchema } from '@/schemas/dashboard/menu.schema'
import { createModifier, updateModifier } from '@/services/dashboard/menu.dashboard.service'
import { prismaMock } from '../../../__helpers__/setup'

const params = {
  venueId: 'cjld2cjxh0000qzrmn831i7rn',
  modifierGroupId: 'cjld2cjxh0001qzrmn831i7ro',
  modifierId: 'cjld2cjxh0002qzrmn831i7rp',
}

// Un extra que YA descuenta inventario: 2 unidades de su materia prima por pieza.
const extraConInventario = {
  id: params.modifierId,
  sku: 'P000672',
  rawMaterialId: 'rm-anterior',
  quantityPerUnit: new Prisma.Decimal('2'),
}

describe('Extras: SKU de caja externa', () => {
  beforeEach(() => {
    jest.clearAllMocks() // cada prueba cuenta SUS llamadas a update (calls[0], calls[1])
    prismaMock.modifierGroup.findFirst.mockResolvedValue({ id: params.modifierGroupId } as any)
    prismaMock.modifier.findFirst.mockResolvedValue({
      id: params.modifierId,
      sku: 'P000672',
      rawMaterialId: null,
      quantityPerUnit: null,
    } as any)
    prismaMock.modifier.update.mockImplementation(
      (args: any) => Promise.resolve({ id: params.modifierId, name: 'Shot', ...args.data }) as any,
    )
    prismaMock.modifier.create.mockImplementation((args: any) => Promise.resolve({ id: 'nuevo', ...args.data }) as any)
  })

  it('P1 editar un extra SIN inventario no da 400: el dashboard y Android mandan null', () => {
    const result = UpdateModifierSchema.safeParse({
      params,
      body: { name: 'Shot de espresso', price: 15, rawMaterialId: null, quantityPerUnit: null, unit: null, inventoryMode: null },
    })
    expect(result.success).toBe(true)
  })

  it('el SKU se recorta, vacío vale null y sin SKU no aparece', () => {
    const parse = (body: any) => CreateModifierSchema.parse({ params, body: { name: 'Shot', price: 15, ...body } }).body
    expect(parse({ sku: '  P000672 ' }).sku).toBe('P000672')
    expect(parse({ sku: '   ' }).sku).toBeNull()
    expect(parse({ sku: null }).sku).toBeNull()
    expect('sku' in parse({})).toBe(false)
  })

  it('rechaza un SKU con espacios o símbolos, con mensaje en español', () => {
    const result = CreateModifierSchema.safeParse({ params, body: { name: 'Shot', price: 15, sku: 'P 000672' } })
    expect(result.success).toBe(false)
    expect(JSON.stringify((result as any).error.issues)).toContain('El SKU sólo admite letras, números, guion y guion bajo')
  })

  it('createModifier guarda el SKU', async () => {
    await createModifier(params.venueId, params.modifierGroupId, { name: 'Shot', price: 15, sku: 'P000672' } as any)
    expect(prismaMock.modifier.create).toHaveBeenCalledWith({ data: expect.objectContaining({ sku: 'P000672' }) })
  })

  it('updateModifier sin sku NO lo toca (Android edita extras sin mandarlo)', async () => {
    await updateModifier(params.venueId, params.modifierGroupId, params.modifierId, { name: 'Shot doble', price: 20 } as any)
    const data = (prismaMock.modifier.update.mock.calls[0][0] as any).data
    expect('sku' in data).toBe(false)
  })

  it('updateModifier con sku null lo borra y con texto lo cambia', async () => {
    await updateModifier(params.venueId, params.modifierGroupId, params.modifierId, { sku: null } as any)
    expect((prismaMock.modifier.update.mock.calls[0][0] as any).data.sku).toBeNull()
    await updateModifier(params.venueId, params.modifierGroupId, params.modifierId, { sku: 'P000673' } as any)
    expect((prismaMock.modifier.update.mock.calls[1][0] as any).data.sku).toBe('P000673')
  })

  it('updateModifier con inventoryMode null no escribe el modo (columna obligatoria) y sí limpia cantidad y unidad', async () => {
    await updateModifier(params.venueId, params.modifierGroupId, params.modifierId, {
      rawMaterialId: null,
      quantityPerUnit: null,
      unit: null,
      inventoryMode: null,
    } as any)
    const data = (prismaMock.modifier.update.mock.calls[0][0] as any).data
    expect('inventoryMode' in data).toBe(false)
    expect(data.quantityPerUnit).toBeNull()
    expect(data.unit).toBeNull()
  })

  it('contrato del PATCH: {name, price} no trae la llave sku y sku vacío llega como null', () => {
    const parse = (body: any) => UpdateModifierSchema.parse({ params, body }).body
    expect('sku' in parse({ name: 'Shot doble', price: 20 })).toBe(false)
    expect(parse({ sku: '' }).sku).toBeNull()
  })

  it('P1 materia prima con cantidad vacía (null): el costo queda en null y no se calcula con la cantidad anterior', async () => {
    // El dashboard, con «Track Inventory» encendido y materia prima elegida, manda la cantidad vacía como null.
    prismaMock.modifier.findFirst.mockResolvedValue({ ...extraConInventario } as any)
    prismaMock.rawMaterial.findFirst.mockResolvedValue({ id: 'rm-nueva', avgCostPerUnit: new Prisma.Decimal('10') } as any)

    await updateModifier(params.venueId, params.modifierGroupId, params.modifierId, {
      rawMaterialId: 'rm-nueva',
      quantityPerUnit: null,
    } as any)
    const data = (prismaMock.modifier.update.mock.calls[0][0] as any).data
    expect(data.quantityPerUnit).toBeNull()
    expect(data.cost).toBeNull() // no 10 × 2: la cantidad anterior ya no aplica
  })

  it('sólo la cantidad en null (sin tocar la materia prima): el costo anterior no se queda', async () => {
    prismaMock.modifier.findFirst.mockResolvedValue({ ...extraConInventario } as any)

    await updateModifier(params.venueId, params.modifierGroupId, params.modifierId, { quantityPerUnit: null } as any)
    const data = (prismaMock.modifier.update.mock.calls[0][0] as any).data
    expect(data.quantityPerUnit).toBeNull()
    expect(data.cost).toBeNull()
  })

  it('regresión: sin tocar la cantidad, el costo se sigue calculando con la cantidad guardada', async () => {
    prismaMock.modifier.findFirst.mockResolvedValue({ ...extraConInventario } as any)
    prismaMock.rawMaterial.findFirst.mockResolvedValue({ id: 'rm-nueva', avgCostPerUnit: new Prisma.Decimal('10') } as any)

    await updateModifier(params.venueId, params.modifierGroupId, params.modifierId, { rawMaterialId: 'rm-nueva' } as any)
    expect((prismaMock.modifier.update.mock.calls[0][0] as any).data.cost.toString()).toBe('20') // 10 × 2
  })
})
