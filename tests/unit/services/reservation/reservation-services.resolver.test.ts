import { reservationServiceIds, resolveServices, resolveServicesMany } from '@/services/reservation/reservation-services.resolver'

// Cliente Prisma falso: devuelve productos en orden ARBITRARIO a propósito,
// para probar que el resolvedor restaura el orden de reserva.
const fakeClient = (products: any[]) => ({
  product: { findMany: jest.fn(async () => products) },
})

describe('reservationServiceIds', () => {
  it('usa productIds cuando la cita es multi-servicio', () => {
    expect(reservationServiceIds({ productId: 'a', productIds: ['a', 'b', 'c'] })).toEqual(['a', 'b', 'c'])
  })

  it('cae al productId líder en filas legacy de un solo servicio', () => {
    expect(reservationServiceIds({ productId: 'a', productIds: [] })).toEqual(['a'])
  })

  it('devuelve [] para reservas de solo mesa (sin servicio)', () => {
    expect(reservationServiceIds({ productId: null, productIds: [] })).toEqual([])
  })
})

describe('resolveServices', () => {
  it('preserva el ORDEN DE RESERVA aunque la DB devuelva otro orden', async () => {
    const client = fakeClient([
      { id: 'c', name: 'Tercero', price: null, duration: 20 },
      { id: 'a', name: 'Primero', price: null, duration: 75 },
      { id: 'b', name: 'Segundo', price: null, duration: 25 },
    ])

    const services = await resolveServices({ productId: 'a', productIds: ['a', 'b', 'c'] }, client as any)

    expect(services.map(s => s.name)).toEqual(['Primero', 'Segundo', 'Tercero'])
  })

  it('omite ids que ya no existen en vez de meter undefined', async () => {
    const client = fakeClient([{ id: 'a', name: 'Primero', price: null, duration: 75 }])

    const services = await resolveServices({ productId: 'a', productIds: ['a', 'borrado'] }, client as any)

    expect(services).toHaveLength(1)
    expect(services[0].name).toBe('Primero')
  })

  it('no consulta la DB cuando no hay servicios', async () => {
    const client = fakeClient([])

    const services = await resolveServices({ productId: null, productIds: [] }, client as any)

    expect(services).toEqual([])
    expect(client.product.findMany).not.toHaveBeenCalled()
  })
})

describe('resolveServicesMany', () => {
  it('resuelve N reservas con UNA sola query', async () => {
    const client = fakeClient([
      { id: 'a', name: 'A', price: null, duration: 10 },
      { id: 'b', name: 'B', price: null, duration: 20 },
    ])

    const out = await resolveServicesMany(
      [
        { id: 'r1', productId: 'a', productIds: ['a', 'b'] },
        { id: 'r2', productId: 'b', productIds: [] },
      ],
      client as any,
    )

    expect(client.product.findMany).toHaveBeenCalledTimes(1)
    expect(out[0].services.map(s => s.name)).toEqual(['A', 'B'])
    expect(out[1].services.map(s => s.name)).toEqual(['B'])
  })
})
