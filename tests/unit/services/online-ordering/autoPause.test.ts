// D662 (founder, 18-nov, «como Uber Eats»): 2 pedidos seguidos de «Mi equipo» vencen sin respuesta ⇒ la tienda se pausa sola.
import { prismaMock } from '@tests/__helpers__/setup'
import { contarPedidoSinAtenderEnTx, reiniciarPedidosSinAtenderEnTx } from '@/services/online-ordering/autoPause'

const NOW = new Date('2026-11-18T20:00:00.000Z')
const settings = prismaMock.onlineOrderingSettings

beforeEach(() => {
  settings.updateMany.mockResolvedValue({ count: 1 })
  settings.update.mockResolvedValue({} as any)
})

describe('contarPedidoSinAtenderEnTx', () => {
  it('el +1 toma el candado de la fila (sólo tienda encendida y en «Mi equipo»); con 1 no pausa', async () => {
    settings.findUnique.mockResolvedValue({ missedOrdersInARow: 1, autoPausedAt: null, manualPause: false } as any)
    await expect(contarPedidoSinAtenderEnTx(prismaMock as any, 'v1', NOW)).resolves.toBe(false)
    expect(settings.updateMany).toHaveBeenCalledWith({
      where: { venueId: 'v1', enabled: true, requiresAcceptance: true },
      data: { missedOrdersInARow: { increment: 1 } },
    })
    expect(settings.updateMany.mock.invocationCallOrder[0]).toBeLessThan(settings.findUnique.mock.invocationCallOrder[0])
    expect(settings.update).not.toHaveBeenCalled()
  })

  it('el SEGUNDO seguido pausa la tienda y la cuenta vuelve a 0', async () => {
    settings.findUnique.mockResolvedValue({ missedOrdersInARow: 2, autoPausedAt: null, manualPause: false } as any)
    await expect(contarPedidoSinAtenderEnTx(prismaMock as any, 'v1', NOW)).resolves.toBe(true)
    expect(settings.update).toHaveBeenCalledWith({ where: { venueId: 'v1' }, data: { missedOrdersInARow: 0, autoPausedAt: NOW } })
  })

  it('ya pausada (sola o por el gerente) no se vuelve a pausar: sólo vuelve a 0', async () => {
    settings.findUnique.mockResolvedValue({ missedOrdersInARow: 2, autoPausedAt: null, manualPause: true } as any)
    await expect(contarPedidoSinAtenderEnTx(prismaMock as any, 'v1', NOW)).resolves.toBe(false)
    expect(settings.update).toHaveBeenLastCalledWith({ where: { venueId: 'v1' }, data: { missedOrdersInARow: 0 } })
    settings.findUnique.mockResolvedValue({ missedOrdersInARow: 2, autoPausedAt: new Date(NOW.getTime() - 60_000), manualPause: false } as any)
    await expect(contarPedidoSinAtenderEnTx(prismaMock as any, 'v1', NOW)).resolves.toBe(false)
    expect(settings.update).toHaveBeenLastCalledWith({ where: { venueId: 'v1' }, data: { missedOrdersInARow: 0 } })
  })

  it('apagada o en «Nadie» no cuenta nada', async () => {
    settings.updateMany.mockResolvedValue({ count: 0 })
    await expect(contarPedidoSinAtenderEnTx(prismaMock as any, 'v1', NOW)).resolves.toBe(false)
    expect(settings.findUnique).not.toHaveBeenCalled()
    expect(settings.update).not.toHaveBeenCalled()
  })
})

describe('reiniciarPedidosSinAtenderEnTx', () => {
  it('vuelve a 0 en la transacción que recibe, sin escribir si ya está en 0', async () => {
    await reiniciarPedidosSinAtenderEnTx(prismaMock as any, 'v1')
    expect(settings.updateMany).toHaveBeenCalledWith({
      where: { venueId: 'v1', missedOrdersInARow: { gt: 0 } },
      data: { missedOrdersInARow: 0 },
    })
  })
})
