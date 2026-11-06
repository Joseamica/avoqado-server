/**
 * D24 (5-nov): los ejemplos que midió Codex (docs/audit/2026-11-05-hallazgos-videos/codex-d15-r2.md) con los esquemas
 * REALES de clientes y el middleware REAL: el 400 sale en español y sin el nombre técnico del campo delante
 * («marketingConsent: Expected boolean, received string»). La forma de la respuesta no cambia: sólo el texto.
 */
import { Request, Response } from 'express'
import { validateRequest } from '@/middlewares/validation'
import { BadRequestError } from '@/errors/AppError'
import { CreateCustomerSchema, MobileUpdateCustomerSchema, UpdateCustomerSchema } from '@/schemas/dashboard/customer.schema'
import { createDiscountBodySchema } from '@/schemas/dashboard/discount.schema'
import { z } from 'zod'

const venueId = 'cm12345678901234567890123'
const customerId = 'cm22345678901234567890123'

async function rechazo(schema: z.AnyZodObject, body: unknown, params: Record<string, string>) {
  const next = jest.fn()
  await validateRequest(schema)({ body, query: {}, params } as unknown as Request, {} as Response, next)
  const err = next.mock.calls[0][0]
  expect(err).toBeInstanceOf(BadRequestError)
  expect(err.statusCode).toBe(400)
  return err.message as string
}

const sinIngles = (m: string) => {
  expect(m).toMatch(/^Error de validación: /)
  expect(m).not.toMatch(/Expected|received|Required|Invalid/)
  expect(m).not.toMatch(/\b(marketingConsent|tags|phone|email|name|code):/)
}

describe('validateRequest en español (D24)', () => {
  it('crear cliente con marketingConsent:"false"', async () => {
    const m = await rechazo(CreateCustomerSchema, { email: 'a@b.mx', marketingConsent: 'false' }, { venueId })
    sinIngles(m)
    expect(m).toBe('Error de validación: Se esperaba sí o no y llegó texto')
  })

  it('editar cliente con tags:"VIP"', async () => {
    const m = await rechazo(UpdateCustomerSchema, { tags: 'VIP' }, { venueId, customerId })
    sinIngles(m)
    expect(m).toBe('Error de validación: Se esperaba una lista y llegó texto')
  })

  it('ruta móvil con phone:42', async () => {
    const m = await rechazo(MobileUpdateCustomerSchema, { phone: 42 }, { venueId, customerId })
    sinIngles(m)
    expect(m).toBe('Error de validación: Se esperaba texto y llegó un número')
  })

  it('ruta móvil con email:null', async () => {
    const m = await rechazo(MobileUpdateCustomerSchema, { email: null }, { venueId, customerId })
    sinIngles(m)
    expect(m).toBe('Error de validación: Se esperaba texto y llegó vacío')
  })

  it('el mensaje propio del esquema sigue igual, ahora sin el campo delante', async () => {
    const m = await rechazo(CreateCustomerSchema, { email: 'a@b.mx', firstName: '' }, { venueId })
    expect(m).toBe('Error de validación: El nombre no puede quedar vacío')
  })

  it('dos campos con el mismo motivo no repiten la frase', async () => {
    const m = await rechazo(MobileUpdateCustomerSchema, { phone: 42, email: 7 }, { venueId, customerId })
    expect(m).toBe('Error de validación: Se esperaba texto y llegó un número')
  })
})

// Codex d24 r1 #1: sin el campo delante, los mensajes genéricos de los esquemas («Debe ser texto», «No puede ser negativo»)
// ya no decían qué dato era. Ahora lo dicen ellos.
describe('los mensajes propios dicen qué dato es (Codex d24 r1)', () => {
  it('crear cliente con firstName:42', async () => {
    expect(await rechazo(CreateCustomerSchema, { email: 'a@b.mx', firstName: 42 }, { venueId })).toBe(
      'Error de validación: Se esperaba texto en el nombre',
    )
  })

  it('crear descuento con minPurchaseAmount:-1', async () => {
    // Igual que la ruta real (`POST /venues/:venueId/discounts` en dashboard.routes.ts).
    const m = await rechazo(
      z.object({ body: createDiscountBodySchema }),
      { name: 'P', type: 'PERCENTAGE', value: 10, minPurchaseAmount: -1 },
      { venueId },
    )
    expect(m).toBe('Error de validación: La compra mínima debe ser 0 o más')
  })
})
