/**
 * D14 y D15 (grabando los tutoriales, 5-nov-2026).
 *
 * D15: dar de alta un cliente sólo con teléfono fallaba con «Invalid email format»: el panel manda el correo vacío ("")
 * y el schema lo leía como un correo mal escrito. "" es «sin correo» (y lo mismo el teléfono).
 * D14: un descuento por «Categorías» se podía guardar sin ninguna categoría, y los mensajes salían en inglés.
 * Regla del repo: los mensajes de Zod los ve el usuario tal cual, así que van en español.
 */
import { CreateCustomerSchema, UpdateCustomerSchema } from '@/schemas/dashboard/customer.schema'
import { createDiscountBodySchema, updateDiscountBodySchema } from '@/schemas/dashboard/discount.schema'
import { bulkGenerateCouponsBodySchema, createCouponBodySchema, updateCouponBodySchema } from '@/schemas/dashboard/coupon.schema'

const venueId = 'c'.padEnd(25, '1')
const customerId = 'c'.padEnd(25, '2')
const mensajes = (r: { success: boolean; error?: { issues: { message: string }[] } }) =>
  r.success ? '' : r.error!.issues.map(i => i.message).join(' | ')
const SIN_INGLES = /invalid|required|must|too long|expected|at least|only contain/i

describe('D15 · alta de cliente con correo o teléfono vacío', () => {
  it('🔴 sólo teléfono, con el correo vacío como lo manda el panel: pasa y el correo queda ausente', () => {
    const r = CreateCustomerSchema.safeParse({ params: { venueId }, body: { firstName: 'Rosa', email: '', phone: '5544102263' } })
    expect(mensajes(r)).toBe('')
    expect(r.success && r.data.body.email).toBeUndefined()
  })

  it('sólo correo, con el teléfono vacío: pasa y el teléfono queda ausente', () => {
    const r = CreateCustomerSchema.safeParse({ params: { venueId }, body: { email: 'rosa@ejemplo.mx', phone: '' } })
    expect(mensajes(r)).toBe('')
    expect(r.success && r.data.body.phone).toBeUndefined()
  })

  it('los dos vacíos: se rechaza con el mensaje de siempre, en español', () => {
    const r = CreateCustomerSchema.safeParse({ params: { venueId }, body: { email: '', phone: '' } })
    expect(mensajes(r)).toBe('Se requiere email o teléfono')
  })

  it('un correo mal escrito sigue siendo error, en español', () => {
    const r = CreateCustomerSchema.safeParse({ params: { venueId }, body: { email: 'rosa@', phone: '5544102263' } })
    expect(r.success).toBe(false)
    expect(mensajes(r)).not.toMatch(SIN_INGLES)
    expect(mensajes(r)).toMatch(/correo/i)
  })

  it('un teléfono corto sigue siendo error, en español', () => {
    const r = CreateCustomerSchema.safeParse({ params: { venueId }, body: { phone: '55' } })
    expect(r.success).toBe(false)
    expect(mensajes(r)).not.toMatch(SIN_INGLES)
    expect(mensajes(r)).toMatch(/teléfono/i)
  })

  it('editar: el correo vacío llega como "" (el servicio decide si cambia algo) y no truena en el schema', () => {
    const r = UpdateCustomerSchema.safeParse({
      params: { venueId, customerId },
      body: { firstName: 'Rosa', email: '', phone: '5544102263' },
    })
    expect(mensajes(r)).toBe('')
  })

  it('editar: correo mal escrito y ningún campo, en español', () => {
    const r1 = UpdateCustomerSchema.safeParse({ params: { venueId, customerId }, body: { email: 'no-es-correo' } })
    expect(r1.success).toBe(false)
    expect(mensajes(r1)).not.toMatch(SIN_INGLES)
    const r2 = UpdateCustomerSchema.safeParse({ params: { venueId, customerId }, body: {} })
    expect(r2.success).toBe(false)
    expect(mensajes(r2)).not.toMatch(SIN_INGLES)
  })
})

describe('D14 · descuento por categorías sin categorías', () => {
  const base = { name: 'Martes de pan', type: 'PERCENTAGE', value: 10 }

  it('🔴 alcance «Categorías» sin ninguna: se rechaza con mensaje claro en español', () => {
    const sinLista = createDiscountBodySchema.safeParse({ ...base, scope: 'CATEGORY' })
    expect(sinLista.success).toBe(false)
    expect(mensajes(sinLista)).toMatch(/categor/i)
    const listaVacia = createDiscountBodySchema.safeParse({ ...base, scope: 'CATEGORY', targetCategoryIds: [] })
    expect(listaVacia.success).toBe(false)
    expect(mensajes(listaVacia)).toMatch(/categor/i)
  })

  it('con al menos una categoría pasa', () => {
    expect(createDiscountBodySchema.safeParse({ ...base, scope: 'CATEGORY', targetCategoryIds: ['cat-1'] }).success).toBe(true)
  })

  it('editar a «Categorías» con la lista vacía también se rechaza', () => {
    const r = updateDiscountBodySchema.safeParse({ scope: 'CATEGORY', targetCategoryIds: [] })
    expect(r.success).toBe(false)
    expect(mensajes(r)).toMatch(/categor/i)
  })

  it('editar otra cosa (prender o apagar) sigue pasando', () => {
    expect(updateDiscountBodySchema.safeParse({ active: false }).success).toBe(true)
  })

  it('los demás mensajes del descuento van en español', () => {
    const casos = [
      { ...base, name: '' },
      { ...base, value: -1 },
      { ...base, value: 120 },
      { ...base, scope: 'QUANTITY' },
      { ...base, timeFrom: '9am', timeUntil: '18:00' },
      { ...base, timeFrom: '09:00' },
      { ...base, validFrom: '2026-12-31', validUntil: '2026-01-01' },
    ]
    for (const caso of casos) {
      const r = createDiscountBodySchema.safeParse(caso)
      expect(r.success).toBe(false)
      expect(mensajes(r)).not.toMatch(SIN_INGLES)
    }
  })
})

describe('D14 · cupones en español', () => {
  it('código corto, con símbolos o sin descuento: mensajes en español', () => {
    for (const caso of [
      { discountId: 'd', code: 'AB' },
      { discountId: 'd', code: 'HOLA MUNDO!' },
      { discountId: '', code: 'HOLA' },
      { discountId: 'd', code: 'HOLA', validFrom: '2026-12-31', validUntil: '2026-01-01' },
    ]) {
      const r = createCouponBodySchema.safeParse(caso)
      expect(r.success).toBe(false)
      expect(mensajes(r)).not.toMatch(SIN_INGLES)
    }
    const u = updateCouponBodySchema.safeParse({ code: 'A' })
    expect(mensajes(u)).not.toMatch(SIN_INGLES)
    const b = bulkGenerateCouponsBodySchema.safeParse({ discountId: 'd', quantity: 0, prefix: 'ESTE PREFIJO ES LARGO' })
    expect(b.success).toBe(false)
    expect(mensajes(b)).not.toMatch(SIN_INGLES)
  })
})
