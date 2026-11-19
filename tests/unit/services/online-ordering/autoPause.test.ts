// D662 (founder, 18-nov, «como Uber Eats»): 2 pedidos seguidos de «Mi equipo» vencen sin respuesta ⇒ la tienda se pausa sola.
import { prismaMock } from '@tests/__helpers__/setup'
import { contarPedidoSinAtenderEnTx, reiniciarPedidosSinAtenderEnTx } from '@/services/online-ordering/autoPause'

const NOW = new Date('2026-11-18T20:00:00.000Z')
const LIMITE = { acceptDeadlineAt: new Date(NOW.getTime() - 5_000) }
const settings = prismaMock.onlineOrderingSettings
const fila = (o: Record<string, unknown> = {}) => ({ missedOrdersInARow: 0, autoPausedAt: null, lastAnsweredAt: null, ...o }) as any

beforeEach(() => {
  settings.updateMany.mockResolvedValue({ count: 1 })
  settings.update.mockResolvedValue({} as any)
})

describe('contarPedidoSinAtenderEnTx', () => {
  it('primero el candado de la fila (sólo tienda encendida y en «Mi equipo»); el primero sólo suma', async () => {
    settings.findUnique.mockResolvedValue(fila())
    await expect(contarPedidoSinAtenderEnTx(prismaMock as any, 'v1', LIMITE, NOW)).resolves.toBe(false)
    expect(settings.updateMany).toHaveBeenCalledWith({
      where: { venueId: 'v1', enabled: true, requiresAcceptance: true },
      data: { updatedAt: NOW },
    })
    expect(settings.updateMany.mock.invocationCallOrder[0]).toBeLessThan(settings.findUnique.mock.invocationCallOrder[0])
    expect(settings.update).toHaveBeenCalledWith({ where: { venueId: 'v1' }, data: { missedOrdersInARow: 1 } })
  })

  it('el SEGUNDO seguido pausa la tienda y la cuenta vuelve a 0', async () => {
    settings.findUnique.mockResolvedValue(fila({ missedOrdersInARow: 1 }))
    await expect(contarPedidoSinAtenderEnTx(prismaMock as any, 'v1', LIMITE, NOW)).resolves.toBe(true)
    expect(settings.update).toHaveBeenCalledWith({ where: { venueId: 'v1' }, data: { missedOrdersInARow: 0, autoPausedAt: NOW } })
  })

  it('Codex r7 #7: con la pausa del gerente puesta igual se pausa sola (al quitar la del gerente sigue hasta «Reanudar»)', async () => {
    settings.findUnique.mockResolvedValue(fila({ missedOrdersInARow: 1, manualPause: true }))
    await expect(contarPedidoSinAtenderEnTx(prismaMock as any, 'v1', LIMITE, NOW)).resolves.toBe(true)
    expect(settings.update).toHaveBeenCalledWith({ where: { venueId: 'v1' }, data: { missedOrdersInARow: 0, autoPausedAt: NOW } })
  })

  it('ya pausada sola no se vuelve a pausar: sólo vuelve a 0', async () => {
    settings.findUnique.mockResolvedValue(fila({ missedOrdersInARow: 1, autoPausedAt: new Date(NOW.getTime() - 60_000) }))
    await expect(contarPedidoSinAtenderEnTx(prismaMock as any, 'v1', LIMITE, NOW)).resolves.toBe(false)
    expect(settings.update).toHaveBeenCalledWith({ where: { venueId: 'v1' }, data: { missedOrdersInARow: 0 } })
  })

  it('Codex r7 #5: un pedido cuya hora LÍMITE fue antes de la última respuesta no suma (el barrido lo procesó tarde)', async () => {
    settings.findUnique.mockResolvedValue(
      fila({ missedOrdersInARow: 1, lastAnsweredAt: new Date(LIMITE.acceptDeadlineAt.getTime() + 1_000) }),
    )
    await expect(contarPedidoSinAtenderEnTx(prismaMock as any, 'v1', LIMITE, NOW)).resolves.toBe(false)
    expect(settings.update).not.toHaveBeenCalled()
  })

  it('apagada o en «Nadie» no cuenta nada', async () => {
    settings.updateMany.mockResolvedValue({ count: 0 })
    await expect(contarPedidoSinAtenderEnTx(prismaMock as any, 'v1', LIMITE, NOW)).resolves.toBe(false)
    expect(settings.findUnique).not.toHaveBeenCalled()
    expect(settings.update).not.toHaveBeenCalled()
  })
})

describe('reiniciarPedidosSinAtenderEnTx', () => {
  it('Codex r4 #1: vuelve a 0 SIEMPRE (espera un +1 sin confirmar) y la hora de la respuesta sólo avanza', async () => {
    await reiniciarPedidosSinAtenderEnTx(prismaMock as any, 'v1', NOW)
    expect(settings.updateMany).toHaveBeenNthCalledWith(1, { where: { venueId: 'v1' }, data: { missedOrdersInARow: 0 } })
    expect(settings.updateMany).toHaveBeenNthCalledWith(2, {
      where: { venueId: 'v1', OR: [{ lastAnsweredAt: null }, { lastAnsweredAt: { lt: NOW } }] },
      data: { lastAnsweredAt: NOW },
    })
  })
})
