/**
 * Repetir la misma opción en un grupo de extras (encargo a508f4, Flautas Coyoacán): «2 de Cochinita + 1 de Papa».
 * El grupo lleva el interruptor (`allowRepeat`, como Square y Toast) y cada opción un tope opcional (`maxQuantity`, como el «max.» de
 * Fudo). Los dos son aditivos: sin mandarlos, nada cambia.
 */
import {
  CreateModifierGroupSchema,
  CreateModifierSchema,
  UpdateModifierGroupSchema,
  UpdateModifierSchema,
} from '@/schemas/dashboard/menu.schema'
import { createModifier, createModifierGroup, updateModifier, updateModifierGroup } from '@/services/dashboard/menu.dashboard.service'
import { prismaMock } from '../../../__helpers__/setup'

const params = {
  venueId: 'cjld2cjxh0000qzrmn831i7rn',
  modifierGroupId: 'cjld2cjxh0001qzrmn831i7ro',
  modifierId: 'cjld2cjxh0002qzrmn831i7rp',
}

describe('Grupo de extras que deja repetir la misma opción', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.modifierGroup.findFirst.mockResolvedValue({ id: params.modifierGroupId } as any)
    prismaMock.modifierGroup.create.mockImplementation((args: any) => Promise.resolve({ id: 'g-nuevo', ...args.data }) as any)
    prismaMock.modifierGroup.update.mockImplementation((args: any) => Promise.resolve({ id: params.modifierGroupId, ...args.data }) as any)
    prismaMock.modifier.findFirst.mockResolvedValue({ id: params.modifierId, rawMaterialId: null, linkedProductId: null } as any)
    prismaMock.modifier.update.mockImplementation((args: any) => Promise.resolve({ id: params.modifierId, ...args.data }) as any)
    prismaMock.modifier.create.mockImplementation((args: any) => Promise.resolve({ id: 'm-nuevo', ...args.data }) as any)
  })

  it('el panel puede mandar allowRepeat al crear y al editar el grupo', () => {
    const crear = CreateModifierGroupSchema.parse({
      params: { venueId: params.venueId },
      body: { name: 'Flautas (elige 3)', required: true, allowMultiple: true, allowRepeat: true, minSelections: 3, maxSelections: 3 },
    })
    expect(crear.body.allowRepeat).toBe(true)
    const editar = UpdateModifierGroupSchema.parse({ params, body: { allowRepeat: false } })
    expect(editar.body.allowRepeat).toBe(false)
  })

  it('crear el grupo guarda allowRepeat; sin mandarlo queda en false (como hasta hoy)', async () => {
    await createModifierGroup(params.venueId, { name: 'Flautas', allowMultiple: true, allowRepeat: true, maxSelections: 3 } as any)
    expect((prismaMock.modifierGroup.create.mock.calls[0][0] as any).data.allowRepeat).toBe(true)
    await createModifierGroup(params.venueId, { name: 'Salsas', allowMultiple: true, maxSelections: 2 } as any)
    expect((prismaMock.modifierGroup.create.mock.calls[1][0] as any).data.allowRepeat).toBe(false)
  })

  it('editar el grupo sin allowRepeat NO lo toca (el POS de ANDROID edita grupos sin mandarlo)', async () => {
    await updateModifierGroup(params.venueId, params.modifierGroupId, { name: 'Flautas', maxSelections: 3 } as any)
    expect('allowRepeat' in (prismaMock.modifierGroup.update.mock.calls[0][0] as any).data).toBe(false)
    await updateModifierGroup(params.venueId, params.modifierGroupId, { allowRepeat: true } as any)
    expect((prismaMock.modifierGroup.update.mock.calls[1][0] as any).data.allowRepeat).toBe(true)
  })

  it('el tope por opción acepta de 1 a 99 o null, y rechaza 0 con mensaje en español', () => {
    const parse = (maxQuantity: unknown) =>
      CreateModifierSchema.safeParse({ params, body: { name: 'Flautas Cochinita', price: 0, maxQuantity } })
    expect(parse(2).success).toBe(true)
    expect(parse(null).success).toBe(true)
    expect(parse(99).success).toBe(true)
    const cero = parse(0)
    expect(cero.success).toBe(false)
    expect(JSON.stringify((cero as any).error.issues)).toContain('El máximo de veces debe ser al menos 1')
    expect(parse(100).success).toBe(false)
    expect(parse(1.5).success).toBe(false)
    expect(UpdateModifierSchema.safeParse({ params, body: { maxQuantity: 3 } }).success).toBe(true)
  })

  it('crear la opción guarda su tope; sin tope queda null (= hasta el máximo del grupo)', async () => {
    await createModifier(params.venueId, params.modifierGroupId, { name: 'Flautas Queso', price: 0, maxQuantity: 1 } as any)
    expect((prismaMock.modifier.create.mock.calls[0][0] as any).data.maxQuantity).toBe(1)
    await createModifier(params.venueId, params.modifierGroupId, { name: 'Flautas Papa', price: 0 } as any)
    expect((prismaMock.modifier.create.mock.calls[1][0] as any).data.maxQuantity).toBeNull()
  })

  it('editar la opción sin maxQuantity NO lo toca; con null lo quita', async () => {
    await updateModifier(params.venueId, params.modifierGroupId, params.modifierId, { name: 'Flautas Papa', price: 0 } as any)
    expect('maxQuantity' in (prismaMock.modifier.update.mock.calls[0][0] as any).data).toBe(false)
    await updateModifier(params.venueId, params.modifierGroupId, params.modifierId, { maxQuantity: null } as any)
    expect((prismaMock.modifier.update.mock.calls[1][0] as any).data.maxQuantity).toBeNull()
  })

  // Regresión: lo que ya existía sigue igual.
  it('un grupo normal se sigue creando con sus reglas de siempre', async () => {
    await createModifierGroup(params.venueId, { name: 'Término', required: true, minSelections: 1 } as any)
    const data = (prismaMock.modifierGroup.create.mock.calls[0][0] as any).data
    expect(data).toEqual(expect.objectContaining({ required: true, allowMultiple: false, allowRepeat: false, minSelections: 1 }))
  })
})
