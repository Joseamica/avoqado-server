// tests/unit/schemas/enhancedCreateVenue.schema.test.ts
// D25 (15-nov): el alta avanzada de negocio (`POST /dashboard/venues/enhanced`) prende los pagos por default, pero la cuenta
// principal era opcional. La configuración de pagos exige una cuenta principal (llave foránea), así que sin ella Prisma rechazaba
// la creación y el alta ENTERA tronaba con un error genérico. Ahora el esquema la pide, en español, antes de tocar la base.
// Mismo patrón que D10 (el asistente de Blumon pide la Principal primero).
import { enhancedCreateVenueSchema } from '../../../src/schemas/dashboard/cost-management.schema'

const MENSAJE = 'Para activar los cobros elige la cuenta principal, o desactiva los cobros para crear el negocio sin ellos.'

const base = {
  name: 'Estética Luna',
  type: 'SALON',
  address: 'Av. Siempre Viva 742',
  city: 'Querétaro',
  state: 'Querétaro',
  zipCode: '76000',
  phone: '4421234567',
  email: 'luna@example.com',
}

const parse = (body: unknown) => enhancedCreateVenueSchema.safeParse({ body })
const mensajes = (r: ReturnType<typeof parse>) => (r.success ? [] : r.error.issues.map(i => i.message))

describe('enhancedCreateVenueSchema — cuenta principal con los cobros prendidos (D25)', () => {
  it('🔴 sin decir nada de cobros (default: prendidos) y sin cuenta principal ⇒ 400 con el mensaje en español', () => {
    const r = parse(base)
    expect(r.success).toBe(false)
    expect(mensajes(r)).toEqual([MENSAJE])
    if (!r.success) expect(r.error.issues[0].path).toEqual(['body', 'primaryAccountId'])
  })

  it('🔴 cobros prendidos a propósito y sin cuenta principal ⇒ mismo 400', () => {
    expect(mensajes(parse({ ...base, enablePaymentProcessing: true }))).toEqual([MENSAJE])
  })

  it('🔴 una cuenta principal vacía ("") cuenta como ausente (el servicio la convertía en null)', () => {
    expect(mensajes(parse({ ...base, primaryAccountId: '' }))).toEqual([MENSAJE])
    expect(mensajes(parse({ ...base, primaryAccountId: '   ' }))).toEqual([MENSAJE])
  })

  it('🔴 sólo secundaria o terciaria, sin principal ⇒ también se rechaza (la principal es la obligatoria)', () => {
    expect(mensajes(parse({ ...base, secondaryAccountId: 'cm0000000000000000000000a' }))).toEqual([MENSAJE])
  })

  // ── Lo que no cambia ──
  it('control — cobros prendidos con cuenta principal ⇒ pasa, igual que antes', () => {
    const r = parse({ ...base, primaryAccountId: 'cm0000000000000000000000a' })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.body.enablePaymentProcessing).toBe(true)
      expect(r.data.body.primaryAccountId).toBe('cm0000000000000000000000a')
    }
  })

  it('control — cobros apagados y sin cuenta ⇒ pasa (el negocio se crea sin configuración de pagos)', () => {
    const r = parse({ ...base, enablePaymentProcessing: false })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.body.enablePaymentProcessing).toBe(false)
  })

  it('control — los defaults de siempre se conservan (país, moneda, zona horaria, precios)', () => {
    const r = parse({ ...base, primaryAccountId: 'cm0000000000000000000000a' })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.body.country).toBe('MX')
      expect(r.data.body.currency).toBe('MXN')
      expect(r.data.body.timezone).toBe('America/Mexico_City')
      expect(r.data.body.setupPricingStructure).toBe(true)
      expect(r.data.body.pricingTier).toBe('STANDARD')
    }
  })

  it('control — un campo de forma inválido sigue dando su propio mensaje (no se tapa con el de la cuenta)', () => {
    const r = parse({ ...base, email: 'no-es-correo', primaryAccountId: 'cm0000000000000000000000a' })
    expect(mensajes(r)).toEqual(['Escribe un correo electrónico válido'])
  })
})
