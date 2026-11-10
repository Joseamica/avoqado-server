/**
 * Mensajes de validación escritos a mano: salen en español, como los lee la persona en pantalla. Se prueba con el
 * esquema REAL y el middleware REAL (`validateRequest`), que arma «Error de validación: <motivo>» sin la ruta del campo.
 *
 * Dos con dependencia real: el cobro que manda la TPV (muestra el texto del servidor al cajero) y la invitación al
 * equipo del panel. Si alguien vuelve a escribir un mensaje en inglés en un esquema, la regla «Zod en español» de
 * `.claude/rules/critical-warnings.md` lo dice; aquí sólo se fija que éstos no regresen.
 */
import { Request, Response } from 'express'
import { validateRequest } from '@/middlewares/validation'
import { BadRequestError } from '@/errors/AppError'
import { recordPaymentBodySchema } from '@/schemas/tpv.schema'
import { InviteTeamMemberSchema } from '@/schemas/dashboard/team.schema'

const venueId = 'cmn3acoxt000mn227k1vdgj95'

async function error400(schema: Parameters<typeof validateRequest>[0], body: unknown, params: Record<string, string> = {}) {
  const next = jest.fn()
  await validateRequest(schema)({ body, query: {}, params } as unknown as Request, {} as Response, next)
  return next.mock.calls[0][0]
}

describe('cobro de la TPV sin cuenta de comercio', () => {
  const cobro = {
    venueId,
    amount: 44000,
    tip: 0,
    status: 'COMPLETED',
    method: 'CREDIT_CARD',
    source: 'TPV',
    splitType: 'FULLPAYMENT',
    staffId: 'staff-1',
    paidProductsId: [],
    currency: 'MXN',
  }

  it('tarjeta sin cuenta de comercio ni serial → 400 en español, sin nombres del código', async () => {
    const err = await error400(recordPaymentBodySchema, cobro)
    expect(err).toBeInstanceOf(BadRequestError)
    expect(err.statusCode).toBe(400)
    expect(err.message).toBe(
      'Error de validación: Un cobro con tarjeta necesita la cuenta de comercio o el serial de Blumon para saber a qué comercio va. Un cobro en efectivo no debe llevar cuenta de comercio',
    )
    expect(err.message).not.toMatch(/merchantAccountId|blumonSerialNumber|Card payments/)
  })

  it('con cuenta de comercio sigue pasando', async () => {
    expect(await error400(recordPaymentBodySchema, { ...cobro, merchantAccountId: 'cmn3a6xr8000kn227eg8zeh41' })).toBeUndefined()
  })
})

describe('invitar a alguien al equipo', () => {
  it('nombre y apellido vacíos → 400 en español', async () => {
    const err = await error400(
      InviteTeamMemberSchema,
      { firstName: '', lastName: '', role: 'CASHIER', email: 'ana@ejemplo.com' },
      { venueId },
    )
    expect(err.message).toBe('Error de validación: El nombre es obligatorio, El apellido es obligatorio')
  })

  it('invitar como superadministrador se rechaza en español', async () => {
    const err = await error400(
      InviteTeamMemberSchema,
      { firstName: 'Ana', lastName: 'Pérez', role: 'SUPERADMIN', email: 'ana@ejemplo.com' },
      { venueId },
    )
    expect(err.message).toBe('Error de validación: No puedes invitar a alguien como superadministrador')
  })
})
