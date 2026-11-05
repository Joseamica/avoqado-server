import { BroadcastingService } from '@/communication/sockets/services/broadcasting.service'
import { SocketEventType } from '@/communication/sockets/types'

const CLAVES = ['action', 'correlationId', 'timestamp', 'venueId']

function servicio() {
  const service = new BroadcastingService({} as any, {} as any)
  const venue = jest.spyOn(service, 'broadcastToVenue').mockReturnValue(true)
  const user = jest.spyOn(service, 'broadcastToUser').mockImplementation(() => undefined)
  return { service, venue, user }
}

const cuentaEnviada = (venue: jest.SpyInstance) =>
  venue.mock.calls.find(c => c[1] === SocketEventType.NOTIFICATION_COUNT_UPDATED)![2]

describe('NOTIFICATION_COUNT_UPDATED al negocio', () => {
  it('el aviso nuevo manda al negocio sólo action, venueId, correlationId y timestamp', () => {
    const { service, venue } = servicio()
    service.broadcastNewNotification({
      notificationId: 'n1',
      recipientId: 'u1',
      venueId: 'v1',
      title: 'Privado',
      message: 'secreto',
      priority: 'HIGH',
      metadata: { a: 1 },
    } as any)
    const p = cuentaEnviada(venue)
    expect(Object.keys(p).sort()).toEqual(CLAVES)
    expect(p.action).toBe('increment')
    expect(p.venueId).toBe('v1')
  })

  it('leído y borrado (sin leer) igual, con action decrement', () => {
    const { service, venue } = servicio()
    service.broadcastNotificationRead('n1', 'u1', 'v1')
    expect(Object.keys(cuentaEnviada(venue)).sort()).toEqual(CLAVES)
    expect(cuentaEnviada(venue).action).toBe('decrement')
    venue.mockClear()
    service.broadcastNotificationDeleted('n1', 'u1', 'v1', true)
    expect(Object.keys(cuentaEnviada(venue)).sort()).toEqual(CLAVES)
    expect(cuentaEnviada(venue).action).toBe('decrement')
  })

  it('al usuario le sigue llegando el aviso completo', () => {
    const { service, user } = servicio()
    service.broadcastNewNotification({ notificationId: 'n1', recipientId: 'u1', venueId: 'v1', title: 'Privado', message: 'm' } as any)
    expect(user).toHaveBeenCalledWith('u1', SocketEventType.NOTIFICATION_NEW, expect.objectContaining({ title: 'Privado' }), undefined)
  })
})
