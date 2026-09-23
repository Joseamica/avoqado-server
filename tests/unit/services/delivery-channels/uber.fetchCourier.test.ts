/**
 * Unit — Task 8 del KDS de Uber: `mapCourier` (el repartidor asignado a un pedido).
 *
 * Módulo PURO, sin DB/red — igual que el resto de `uber.mapper.ts`.
 */
import { mapCourier } from '@/services/delivery-channels/providers/uber-eats/uber.mapper'

describe('mapCourier — el repartidor asignado', () => {
  it('deliveries vacio o ausente devuelve null', () => {
    expect(mapCourier({ order: { deliveries: [] } })).toBeNull()
    expect(mapCourier({ order: {} })).toBeNull()
  })

  it('mapea nombre, telefono con codigo y placa cuando existen', () => {
    expect(
      mapCourier({
        order: {
          deliveries: [
            {
              first_name: 'Juan',
              phone: '+52…',
              phone_code: '684 18 235',
              vehicle: { make: 'Nissan', model: 'March', license_plate: 'ABC-123' },
            },
          ],
        },
      }),
    ).toEqual({
      name: 'Juan',
      phone: '+52…',
      phoneCode: '684 18 235',
      vehicle: { make: 'Nissan', model: 'March', licensePlate: 'ABC-123' },
      pictureUrl: undefined,
    })
  })

  it('campos ausentes NO rompen el mapeo', () => {
    expect(mapCourier({ order: { deliveries: [{}] } })).toEqual({
      name: undefined,
      phone: undefined,
      phoneCode: undefined,
      vehicle: undefined,
      pictureUrl: undefined,
    })
  })

  // Regresión: acepta también el objeto pelón sin el sobre `{order: …}`, igual que
  // `mapUberOrder` — un webhook puede traer el pedido embebido sin envolverlo.
  it('acepta el pedido sin el sobre `{order: …}`', () => {
    expect(mapCourier({ deliveries: [{ first_name: 'Ana' }] })?.name).toBe('Ana')
  })
})
