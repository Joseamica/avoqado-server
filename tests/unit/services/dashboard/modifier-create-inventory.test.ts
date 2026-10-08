import { Prisma } from '@prisma/client'
import { CreateModifierSchema, UpdateModifierSchema } from '@/schemas/dashboard/menu.schema'
import { createModifier, updateModifier } from '@/services/dashboard/menu.dashboard.service'
import { prismaMock } from '../../../__helpers__/setup'

const params = {
  venueId: 'cjld2cjxh0000qzrmn831i7rn',
  modifierGroupId: 'cjld2cjxh0001qzrmn831i7ro',
  modifierId: 'cjld2cjxh0002qzrmn831i7rp',
}
const RAW_MATERIAL_ID = 'cjld2cjxh0003qzrmn831i7rq'

// Lo que manda el dashboard al CREAR un extra con «Track Inventory» y duración.
const altaDelDashboard = {
  name: 'Gel',
  price: 120,
  durationMin: 20,
  active: true,
  rawMaterialId: RAW_MATERIAL_ID,
  quantityPerUnit: 2,
  unit: 'GRAM',
  inventoryMode: 'ADDITION',
}
const parseAlta = (body: any) => CreateModifierSchema.parse({ params, body }).body
const parseEdicion = (body: any) => UpdateModifierSchema.parse({ params, body }).body

describe('Extras: inventario y duración al crear y editar (CFG-01)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.modifierGroup.findFirst.mockResolvedValue({ id: params.modifierGroupId } as any)
    prismaMock.modifier.findFirst.mockResolvedValue({ id: params.modifierId, rawMaterialId: null, quantityPerUnit: null } as any)
    prismaMock.modifier.create.mockImplementation((args: any) => Promise.resolve({ id: 'nuevo', ...args.data }) as any)
    prismaMock.modifier.update.mockImplementation((args: any) => Promise.resolve({ id: params.modifierId, ...args.data }) as any)
    prismaMock.rawMaterial.findFirst.mockResolvedValue({ id: RAW_MATERIAL_ID, avgCostPerUnit: new Prisma.Decimal('10') } as any)
  })

  it('el schema del alta conserva materia prima, cantidad, unidad, modo y duración', () => {
    expect(parseAlta(altaDelDashboard)).toMatchObject({
      durationMin: 20,
      rawMaterialId: RAW_MATERIAL_ID,
      quantityPerUnit: 2,
      unit: 'GRAM',
      inventoryMode: 'ADDITION',
    })
  })

  it('createModifier guarda inventario y duración en UNA escritura, con el costo de la edición (promedio × cantidad)', async () => {
    await createModifier(params.venueId, params.modifierGroupId, parseAlta(altaDelDashboard))
    expect(prismaMock.modifier.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.modifier.update).not.toHaveBeenCalled()
    const data = (prismaMock.modifier.create.mock.calls[0][0] as any).data
    expect(data.durationMin).toBe(20)
    expect(data.rawMaterial).toEqual({ connect: { id: RAW_MATERIAL_ID } })
    expect(data.quantityPerUnit).toBe(2)
    expect(data.unit).toBe('GRAM')
    expect(data.inventoryMode).toBe('ADDITION')
    expect(data.cost.toString()).toBe('20')
  })

  it('el alta rechaza una materia prima de OTRO negocio y no crea nada', async () => {
    prismaMock.rawMaterial.findFirst.mockResolvedValue(null)
    await expect(createModifier(params.venueId, params.modifierGroupId, parseAlta(altaDelDashboard))).rejects.toThrow(
      `Raw material with ID ${RAW_MATERIAL_ID} not found in venue ${params.venueId}.`,
    )
    expect(prismaMock.rawMaterial.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: RAW_MATERIAL_ID, venueId: params.venueId } }),
    )
    expect(prismaMock.modifier.create).not.toHaveBeenCalled()
  })

  it('regresión: un alta sin inventario ni duración queda como antes', async () => {
    await createModifier(params.venueId, params.modifierGroupId, parseAlta({ name: 'Shot', price: 15 }))
    const data = (prismaMock.modifier.create.mock.calls[0][0] as any).data
    expect(data.durationMin ?? null).toBeNull()
    expect('rawMaterial' in data).toBe(false)
    expect('cost' in data).toBe(false)
    expect(prismaMock.rawMaterial.findFirst).not.toHaveBeenCalled()
  })

  it('la edición guarda la duración, la borra con null y no la toca si no viene', async () => {
    await updateModifier(params.venueId, params.modifierGroupId, params.modifierId, parseEdicion({ durationMin: 30 }))
    await updateModifier(params.venueId, params.modifierGroupId, params.modifierId, parseEdicion({ durationMin: null }))
    await updateModifier(params.venueId, params.modifierGroupId, params.modifierId, parseEdicion({ name: 'Gel doble' }))
    const calls = prismaMock.modifier.update.mock.calls as any[]
    expect(calls[0][0].data.durationMin).toBe(30)
    expect(calls[1][0].data.durationMin).toBeNull()
    expect('durationMin' in calls[2][0].data).toBe(false)
  })

  it('una duración negativa, con decimales o de más de 480 min se rechaza al crear y al editar', () => {
    for (const durationMin of [-5, 12.5, 481]) {
      expect(CreateModifierSchema.safeParse({ params, body: { name: 'Gel', price: 0, durationMin } }).success).toBe(false)
      expect(UpdateModifierSchema.safeParse({ params, body: { durationMin } }).success).toBe(false)
    }
  })
})
