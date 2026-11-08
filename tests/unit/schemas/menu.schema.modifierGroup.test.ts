/**
 * Grupos de extras: el 400 de «mínimo mayor que máximo» sale en español, como lo lee el POS en pantalla, y el
 * mínimo menor o igual al máximo sigue pasando. Se prueba con el esquema REAL y el middleware REAL (`validateRequest`),
 * que es lo que arma «Error de validación: <motivo>» sin la ruta del campo.
 */
import { Request, Response } from 'express'
import { validateRequest } from '@/middlewares/validation'
import { BadRequestError } from '@/errors/AppError'
import { CreateModifierGroupSchema, UpdateModifierGroupSchema } from '@/schemas/dashboard/menu.schema'

const venueId = 'cm12345678901234567890123'
const modifierGroupId = 'cm22345678901234567890123'

const TEXTO = 'Error de validación: El máximo de selecciones debe ser mayor o igual al mínimo'

async function mensaje(schema: Parameters<typeof validateRequest>[0], body: unknown, params: Record<string, string>) {
  const next = jest.fn()
  await validateRequest(schema)({ body, query: {}, params } as unknown as Request, {} as Response, next)
  return next.mock.calls[0][0]
}

describe('grupo de extras: mínimo y máximo de selecciones', () => {
  it.each([
    ['crear', CreateModifierGroupSchema, { venueId }],
    ['editar', UpdateModifierGroupSchema, { venueId, modifierGroupId }],
  ])('%s: mínimo 3 y máximo 1 → 400 en español, sin nombres del código', async (_nombre, schema, params) => {
    const err = await mensaje(schema, { name: 'Extras', minSelections: 3, maxSelections: 1 }, params)
    expect(err).toBeInstanceOf(BadRequestError)
    expect(err.statusCode).toBe(400)
    expect(err.message).toBe(TEXTO)
    expect(err.message).not.toMatch(/minSelections|maxSelections/)
  })

  it.each([
    ['crear', CreateModifierGroupSchema, { venueId }],
    ['editar', UpdateModifierGroupSchema, { venueId, modifierGroupId }],
  ])('%s: mínimo 1 y máximo 3 (y 3 con 3) pasan', async (_nombre, schema, params) => {
    for (const [minSelections, maxSelections] of [
      [1, 3],
      [3, 3],
    ]) {
      expect(await mensaje(schema, { name: 'Extras', minSelections, maxSelections }, params)).toBeUndefined()
    }
  })

  it('el nombre vacío del grupo y del extra también salen en español', async () => {
    const err = await mensaje(CreateModifierGroupSchema, { name: '', modifiers: [{ name: '' }] }, { venueId })
    expect(err.message).toBe('Error de validación: El nombre del grupo de extras es obligatorio, El nombre del extra es obligatorio')
  })
})
