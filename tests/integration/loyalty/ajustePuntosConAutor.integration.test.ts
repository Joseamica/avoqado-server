/**
 * D33 (hz:be99f328:D33) contra Postgres real: «Ajustar puntos» queda en la bitácora con la PERSONA que lo hizo.
 *
 * El panel y el MCP le pasan a `adjustPoints` la ficha persona-sucursal (`StaffVenue.id`, la que pide `LoyaltyTransaction`),
 * y el servicio audita con ese mismo id. Antes la llave foránea de `ActivityLog.staffId` (que apunta a `Staff`) lo tiraba y
 * el asiento quedaba sin autor. La llave real es lo que se prueba aquí: un mock no la tiene.
 *
 * Correr sólo en una base DESECHABLE:
 *   TZ=UTC npx jest --selectProjects=integration --runTestsByPath tests/integration/loyalty/ajustePuntosConAutor.integration.test.ts --runInBand --ci
 */
// El setup de integración cambia la bitácora por un doble: aquí se prueba la de verdad, con su llave foránea.
jest.unmock('@/services/dashboard/activity-log.service')
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { broadcastToUser: jest.fn(), getBroadcastingService: jest.fn(() => null) },
}))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({ notifyCustomerPassUpdated: jest.fn() }))

import prisma from '@/utils/prismaClient'
import { adjustPoints } from '@/services/dashboard/loyalty.dashboard.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { crearNegocioDePrueba, limpiarNegocioDePrueba } from '../giftCards/sembrarTarjetasDeRegalo'

let venueId: string
let staffId: string
let staffVenueId: string

/** `adjustPoints` audita sin esperar (fire-and-forget): se espera a que aparezca el asiento. */
async function asiento(action: string, entityId: string) {
  for (let i = 0; i < 50; i++) {
    const fila = await prisma.activityLog.findFirst({ where: { venueId, action, entityId } })
    if (fila) return fila
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`no apareció el asiento ${action}`)
}

beforeAll(async () => {
  ;({ venueId, staffId } = await crearNegocioDePrueba('ajuste-puntos-autor'))
  staffVenueId = (await prisma.staffVenue.findFirstOrThrow({ where: { venueId, staffId } })).id
  await prisma.loyaltyConfig.create({ data: { venueId, active: true, pointsPerDollar: 1, pointsPerVisit: 0 } })
})

afterAll(async () => {
  if (venueId) {
    await prisma.activityLog.deleteMany({ where: { venueId } })
    await limpiarNegocioDePrueba(venueId)
  }
  await prisma.$disconnect()
})

describe('D33 · la bitácora del ajuste de puntos lleva a la persona', () => {
  it('ajustar con la ficha de sucursal deja el asiento firmado por su Staff, sin «desconocido»', async () => {
    const customerId = (await prisma.customer.create({ data: { venueId, firstName: 'Autor', phone: '+525566770001' } })).id

    await adjustPoints(venueId, customerId, 25, 'Bono por la espera', staffVenueId)

    const fila = await asiento('LOYALTY_POINTS_ADJUSTED', customerId)
    expect(fila.staffId).toBe(staffId)
    expect(fila.data).toEqual({ points: 25, newBalance: 25 })
    // Un solo asiento por ajuste: ni uno firmado más otro sin actor.
    expect(await prisma.activityLog.count({ where: { venueId, action: 'LOYALTY_POINTS_ADJUSTED', entityId: customerId } })).toBe(1)
    // El movimiento de puntos sigue apuntando a la ficha de sucursal, como pide su tabla.
    const movimiento = await prisma.loyaltyTransaction.findFirstOrThrow({ where: { customerId, type: 'ADJUST' } })
    expect(movimiento.createdById).toBe(staffVenueId)
  })

  it('un id que no es de nadie sigue quedando sin actor y con el id en los datos, como antes', async () => {
    await logAction({ staffId: 'cnoexisteninguno0000000000', venueId, action: 'D33_PRUEBA_DESCONOCIDO', entityId: 'x-1' })

    const fila = await asiento('D33_PRUEBA_DESCONOCIDO', 'x-1')
    expect(fila.staffId).toBeNull()
    expect(fila.data).toEqual({ unknownStaffId: 'cnoexisteninguno0000000000' })
  })
})
