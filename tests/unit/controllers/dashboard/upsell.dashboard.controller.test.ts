/**
 * Upsell dashboard — body → Zod → controlador → servicio (ronda 1 de correcciones, spec B3).
 *
 * 🔴 Por qué existe este archivo y no basta con el de servicio
 * (`tests/unit/services/upsell/upsell.service.test.ts`): esa suite mockea `prisma` y llama
 * `createRule`/`updateRule` DIRECTO con un `input` armado a mano — nunca pasa por
 * `validateRequest` ni por el Zod real de la ruta. `src/schemas/dashboard/upsell.schema.ts`
 * no declaraba `suggestedModifiers` (ni `suggestedProductId` en update), y `z.object()`
 * strippea llaves desconocidas; `src/middlewares/validation.ts` además REEMPLAZA `req.body`
 * con el resultado ya parseado. Con eso, `input.suggestedModifiers` era SIEMPRE `undefined`
 * en producción aunque el servicio y sus tests estuvieran perfectos — la ceguera de capa
 * que dejó pasar esto. Este archivo ejerce el camino COMPLETO: body crudo → el middleware
 * `validateRequest` real con el schema real → el controlador real → el servicio (mockeado,
 * sólo para leer con QUÉ lo llamaron).
 *
 * También cubre la rama 400 nueva de `handle()` (líneas 41-44) para `UpsellModifierError`,
 * que no tenía test.
 */

import type { NextFunction, Request, Response } from 'express'
import type { AnyZodObject } from 'zod'

import { validateRequest } from '../../../../src/middlewares/validation'
import { createUpsellRuleSchema, updateUpsellRuleSchema } from '../../../../src/schemas/dashboard/upsell.schema'
import { createUpsellRule, updateUpsellRule } from '../../../../src/controllers/dashboard/upsell.dashboard.controller'
import { createRule, updateRule } from '../../../../src/services/upsell/upsell.service'
import { UpsellModifierError } from '../../../../src/services/upsell/upsellModifiers'

// Sólo createRule/updateRule se mockean — el resto del módulo (UpsellValidationError, etc.)
// queda REAL, porque el `handle()` del controlador hace `instanceof` contra esa clase.
jest.mock('../../../../src/services/upsell/upsell.service', () => ({
  ...jest.requireActual('../../../../src/services/upsell/upsell.service'),
  createRule: jest.fn(),
  updateRule: jest.fn(),
}))

const mockedCreateRule = createRule as jest.Mock
const mockedUpdateRule = updateRule as jest.Mock

function makeRes(): Response & { __status: number; __json: any } {
  const res: any = {}
  res.__status = 0
  res.__json = undefined
  res.status = jest.fn((code: number) => {
    res.__status = code
    return res
  })
  res.json = jest.fn((payload: any) => {
    res.__json = payload
    return res
  })
  return res
}

/**
 * El camino completo: body crudo por el Zod REAL (`validateRequest`), y si pasa, el
 * controlador REAL con el servicio mockeado. Devuelve el error de validación (si lo hubo,
 * `undefined` si pasó) y el `res` para inspeccionar qué respondió el controlador.
 */
async function runFullChain(
  schema: AnyZodObject,
  body: any,
  controller: (req: Request, res: Response) => Promise<any>,
  params: Record<string, string> = { venueId: 'v1' },
) {
  const req = { body, params, query: {}, authContext: { userId: 'staff_1' } } as unknown as Request
  const res = makeRes()
  const next = jest.fn()

  await validateRequest(schema)(req, res, next as unknown as NextFunction)
  const validationError = (next as jest.Mock).mock.calls[0]?.[0]

  if (!validationError) {
    await controller(req, res)
  }

  return { req, res, validationError }
}

describe('POST /venues/:venueId/upsell-rules — body → Zod → controlador → servicio', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockedCreateRule.mockResolvedValue({ id: 'r1' })
  })

  it('🔴 suggestedModifiers sobrevive el viaje completo hasta el servicio, con su contenido', async () => {
    const body = {
      triggerType: 'ALWAYS',
      suggestedProductId: 'prod_agua',
      suggestedModifiers: [{ groupId: 'g_tam', modifierId: 'm_gr' }],
    }

    const { validationError } = await runFullChain(createUpsellRuleSchema, body, createUpsellRule)

    expect(validationError).toBeUndefined()
    expect(mockedCreateRule).toHaveBeenCalledWith(
      expect.objectContaining({ suggestedModifiers: [{ groupId: 'g_tam', modifierId: 'm_gr' }] }),
      'staff_1',
    )
  })

  it('sin suggestedModifiers en el body, crea igual (no rompe lo de hoy)', async () => {
    const body = { triggerType: 'ALWAYS', suggestedProductId: 'prod_coca' }

    const { validationError } = await runFullChain(createUpsellRuleSchema, body, createUpsellRule)

    expect(validationError).toBeUndefined()
    expect(mockedCreateRule).toHaveBeenCalled()
    expect(mockedCreateRule.mock.calls[0][0].suggestedModifiers).toBeUndefined()
  })

  it('400 con code y message cuando el servicio rechaza por UpsellModifierError (handle():41-44)', async () => {
    mockedCreateRule.mockRejectedValue(
      new UpsellModifierError('MISSING_REQUIRED_MODIFIER', 'Falta elegir una opción de "Tamaño" para poder sugerir este producto'),
    )
    const body = { triggerType: 'ALWAYS', suggestedProductId: 'prod_agua' }

    const { res, validationError } = await runFullChain(createUpsellRuleSchema, body, createUpsellRule)

    expect(validationError).toBeUndefined()
    expect(res.__status).toBe(400)
    expect(res.__json).toEqual({
      success: false,
      code: 'MISSING_REQUIRED_MODIFIER',
      message: expect.stringContaining('Tamaño'),
    })
  })
})

describe('PATCH /venues/:venueId/upsell-rules/:ruleId — body → Zod → controlador → servicio', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockedUpdateRule.mockResolvedValue({ id: 'r1' })
  })

  it('🔴 suggestedProductId Y suggestedModifiers sobreviven el viaje completo, con su contenido', async () => {
    const body = { suggestedProductId: 'prod_agua', suggestedModifiers: [{ groupId: 'g_tam', modifierId: 'm_gr' }] }

    const { validationError } = await runFullChain(updateUpsellRuleSchema, body, updateUpsellRule, { venueId: 'v1', ruleId: 'r1' })

    expect(validationError).toBeUndefined()
    expect(mockedUpdateRule).toHaveBeenCalledWith(
      'v1',
      'r1',
      expect.objectContaining({
        suggestedProductId: 'prod_agua',
        suggestedModifiers: [{ groupId: 'g_tam', modifierId: 'm_gr' }],
      }),
      'staff_1',
    )
  })

  it('null explícito en suggestedModifiers también sobrevive (limpiar una selección huérfana)', async () => {
    const body = { suggestedModifiers: null }

    const { validationError } = await runFullChain(updateUpsellRuleSchema, body, updateUpsellRule, { venueId: 'v1', ruleId: 'r1' })

    expect(validationError).toBeUndefined()
    expect(mockedUpdateRule).toHaveBeenCalledWith('v1', 'r1', expect.objectContaining({ suggestedModifiers: null }), 'staff_1')
  })

  it('400 con code y message cuando el servicio rechaza por UpsellModifierError (handle():41-44)', async () => {
    mockedUpdateRule.mockRejectedValue(new UpsellModifierError('MODIFIER_INACTIVE', 'La opción "Chico" está desactivada'))
    const body = { suggestedModifiers: [{ groupId: 'g_tam', modifierId: 'm_ch' }] }

    const { res, validationError } = await runFullChain(updateUpsellRuleSchema, body, updateUpsellRule, { venueId: 'v1', ruleId: 'r1' })

    expect(validationError).toBeUndefined()
    expect(res.__status).toBe(400)
    expect(res.__json).toEqual({
      success: false,
      code: 'MODIFIER_INACTIVE',
      message: expect.stringContaining('Chico'),
    })
  })
})
