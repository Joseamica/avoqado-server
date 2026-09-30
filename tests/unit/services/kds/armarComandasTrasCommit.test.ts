/** El gancho post-commit NUNCA lanza: el cobro ya está registrado y el barrido reintenta la comanda. */
jest.mock('@/services/kds/kitchenDisplayStations', () => ({
  estacionesDelNegocio: jest.fn().mockRejectedValue(new Error('db caída')),
}))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

import logger from '@/config/logger'
import { armarComandasTrasCommit } from '@/services/kds/kitchenTicketAuthoring.service'

it('si el armado truena, resuelve igual y deja el error en el log', async () => {
  await expect(armarComandasTrasCommit('venue-1', 'order-1', 'PAID')).resolves.toBeUndefined()
  expect(logger.error).toHaveBeenCalledWith(
    expect.stringContaining('[KDS]'),
    expect.objectContaining({ orderId: 'order-1', trigger: 'PAID' }),
  )
})
