/**
 * Tests: la duración de un servicio con cita es OPCIONAL
 *
 * Decisión de producto (founder, 2026-08-09): hay locales que a propósito no
 * quieren fijar tiempos por servicio. Obligarlos les impedía dar de alta el
 * servicio. El motor de reservas ya resuelve el caso: `resolveAppointmentWindow`
 * y `sumServiceDurations` caen al `defaultDurationMin` del venue y NUNCA aportan
 * cero minutos, así que una duración nula degrada bien en vez de romper.
 *
 * Antes, `CreateProductSchema` lo exigía (mínimo 5 min). Eso se quita — pero el
 * rango SIGUE validándose cuando el usuario sí escribe un valor, para que no se
 * cuele un 0 o un 100000 que sí descuadraría la agenda.
 *
 * El dashboard muestra "Usa la duración predeterminada del local" en la lista de
 * servicios, así que heredar el default es visible, no silencioso.
 */

import { CreateProductSchema, UpdateProductSchema } from '../../../../src/schemas/dashboard/menu.schema'

const params = { venueId: 'clzzzzzzzzzzzzzzzzzzzzzzz' }

const CATEGORY = 'clyyyyyyyyyyyyyyyyyyyyyyy'

const appointment = (extra: Record<string, any> = {}) => ({
  params,
  body: {
    name: 'Manicure + Pedicure Spa + Gel',
    sku: 'MANI-PEDI-GEL',
    categoryId: CATEGORY,
    price: 1000,
    type: 'APPOINTMENTS_SERVICE',
    ...extra,
  },
})

describe('CreateProductSchema — duración de servicios con cita', () => {
  it('ACEPTA un servicio con cita SIN duración (el local no quiere fijar tiempos)', () => {
    const result = CreateProductSchema.safeParse(appointment())
    expect(result.success).toBe(true)
  })

  it('ACEPTA null explícito', () => {
    expect(CreateProductSchema.safeParse(appointment({ duration: null })).success).toBe(true)
  })

  it('ACEPTA una duración válida', () => {
    const result = CreateProductSchema.safeParse(appointment({ duration: 150 }))
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.body.duration).toBe(150)
  })

  it('RECHAZA una duración fuera de rango cuando sí se escribe un valor', () => {
    // El rango se sigue validando: un 0 o un 2000 descuadran la agenda de verdad.
    expect(CreateProductSchema.safeParse(appointment({ duration: 0 })).success).toBe(false)
    expect(CreateProductSchema.safeParse(appointment({ duration: 5000 })).success).toBe(false)
  })

  it('REGRESIÓN: un producto normal sin duración sigue siendo válido', () => {
    const body = { name: 'Café', sku: 'CAFE-01', categoryId: CATEGORY, price: 50, type: 'FOOD' }
    expect(CreateProductSchema.safeParse({ params, body }).success).toBe(true)
  })

  it('REGRESIÓN: el PATCH parcial sobre una fila legacy sigue funcionando', () => {
    // Renombrar un servicio viejo con duration=null no debe exigir arreglarla.
    const patch = { params: { ...params, productId: CATEGORY }, body: { name: 'Nuevo nombre' } }
    expect(UpdateProductSchema.safeParse(patch).success).toBe(true)
  })
})
