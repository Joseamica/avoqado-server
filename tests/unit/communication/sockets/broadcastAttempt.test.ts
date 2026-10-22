import { BroadcastingService } from '@/communication/sockets/services/broadcasting.service'
import { SocketEventType } from '@/communication/sockets/types'

it.each([false, true])('D7: el emisor informa si el intento falló=%s para conservar el aviso pendiente', falla => {
  const emit = jest.fn(() => {
    if (falla) throw new Error('socket cerrado')
  })
  const service = new BroadcastingService(
    {} as any,
    {
      getVenueSockets: () => [{ emit }],
      filterSocketsByOptions: (sockets: any) => sockets,
    } as any,
  )
  expect(service.broadcastToVenue('venue', SocketEventType.ORDER_UPDATED, { orderId: 'order' })).toBe(!falla)
})
