/**
 * D15 (grabando los tutoriales, 5-nov-2026): dar de alta un cliente sólo con teléfono fallaba con «Invalid email format»: el
 * panel manda el correo vacío ("") y el schema lo leía como un correo mal escrito. "" es «sin correo» (y lo mismo el
 * teléfono). Regla del repo: los mensajes de Zod los ve el usuario tal cual, así que van en español.
 */
import { CreateCustomerSchema, UpdateCustomerSchema } from '@/schemas/dashboard/customer.schema'

const venueId = 'c'.padEnd(25, '1')
const customerId = 'c'.padEnd(25, '2')
const mensajes = (r: { success: boolean; error?: { issues: { message: string }[] } }) =>
  r.success ? '' : r.error!.issues.map(i => i.message).join(' | ')
const SIN_INGLES = /invalid|required|must|too long|expected|at least|only contain|greater than|less than|integer|number|string/i

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

describe('D15 · lo que quedaba en inglés (Codex D15 r1 #2)', () => {
  it('correo null con teléfono: pasa como «sin correo»', () => {
    const r = CreateCustomerSchema.safeParse({ params: { venueId }, body: { email: null, phone: '5544102263' } })
    expect(mensajes(r)).toBe('')
    expect(r.success && r.data.body.email).toBeUndefined()
  })

  it('género desconocido o nombre que no es texto: en español', () => {
    for (const body of [
      { phone: '5544102263', gender: 'X' },
      { phone: '5544102263', firstName: 5 },
    ]) {
      const r = CreateCustomerSchema.safeParse({ params: { venueId }, body })
      expect(r.success).toBe(false)
      expect(mensajes(r)).not.toMatch(SIN_INGLES)
    }
    const u = UpdateCustomerSchema.safeParse({ params: { venueId, customerId }, body: { gender: 'X' } })
    expect(mensajes(u)).not.toMatch(SIN_INGLES)
  })
})
