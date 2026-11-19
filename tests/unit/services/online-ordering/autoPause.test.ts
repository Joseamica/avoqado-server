// D662 (founder, 18-nov, «como Uber Eats»): 2 pedidos seguidos de «Mi equipo» vencen sin respuesta ⇒ la tienda se pausa sola.
import { prismaMock } from '@tests/__helpers__/setup'
import { contarPedidoSinAtenderEnTx, marcarPedidoAtendido } from '@/services/online-ordering/autoPause'

const NOW = new Date('2026-11-18T20:00:00.000Z')
const DESDE = new Date('2026-11-18T19:00:00.000Z')
const settings = prismaMock.onlineOrderingSettings
const fila = (o: Record<string, unknown> = {}) => ({ missedOrdersSince: DESDE, autoPausedAt: null, manualPause: false, ...o }) as any

beforeEach(() => {
  settings.updateMany.mockResolvedValue({ count: 1 })
  settings.update.mockResolvedValue({} as any)
  settings.findUnique.mockResolvedValue(fila())
})

describe('contarPedidoSinAtenderEnTx', () => {
  it('toma primero el candado de la fila (sólo tienda encendida y en «Mi equipo») y cuenta los vencidos de «Mi equipo» desde la marca', async () => {
    prismaMock.onlineOrder.count.mockResolvedValue(1)
    await expect(contarPedidoSinAtenderEnTx(prismaMock as any, 'v1', NOW)).resolves.toBe(false)
    expect(settings.updateMany).toHaveBeenCalledWith({
      where: { venueId: 'v1', enabled: true, requiresAcceptance: true },
      data: { updatedAt: NOW },
    })
    expect(prismaMock.onlineOrder.count).toHaveBeenCalledWith({
      where: { venueId: 'v1', requiresAcceptance: true, status: 'EXPIRED', expiredAt: { gt: DESDE } },
    })
    expect(settings.updateMany.mock.invocationCallOrder[0]).toBeLessThan(settings.findUnique.mock.invocationCallOrder[0])
    expect(settings.update).not.toHaveBeenCalled()
  })

  it('el SEGUNDO vencido seguido pausa la tienda (con el candado de la admisión) y la cuenta vuelve a empezar desde ahí', async () => {
    prismaMock.onlineOrder.count.mockResolvedValue(2)
    await expect(contarPedidoSinAtenderEnTx(prismaMock as any, 'v1', NOW)).resolves.toBe(true)
    expect(prismaMock.$executeRaw).toHaveBeenCalled() // lockAdmission: un pedido que se cotizaba ya no entra después
    expect(prismaMock.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(settings.update.mock.invocationCallOrder[0])
    expect(settings.update).toHaveBeenCalledWith({ where: { venueId: 'v1' }, data: { autoPausedAt: NOW, missedOrdersSince: NOW } })
  })

  it('Codex r2 #10: una fila de antes de D662 (sin marca) empieza a contar con ESTE pedido, nunca con lo vencido antes', async () => {
    settings.findUnique.mockResolvedValue(fila({ missedOrdersSince: null }))
    await expect(contarPedidoSinAtenderEnTx(prismaMock as any, 'v1', NOW)).resolves.toBe(false)
    expect(prismaMock.onlineOrder.count).not.toHaveBeenCalled()
    expect(settings.update).toHaveBeenCalledWith({ where: { venueId: 'v1' }, data: { missedOrdersSince: new Date(NOW.getTime() - 1) } })
  })

  it('ya pausada (sola o por el gerente) no se vuelve a pausar', async () => {
    prismaMock.onlineOrder.count.mockResolvedValue(5)
    settings.findUnique.mockResolvedValue(fila({ manualPause: true }))
    await expect(contarPedidoSinAtenderEnTx(prismaMock as any, 'v1', NOW)).resolves.toBe(false)
    settings.findUnique.mockResolvedValue(fila({ autoPausedAt: DESDE }))
    await expect(contarPedidoSinAtenderEnTx(prismaMock as any, 'v1', NOW)).resolves.toBe(false)
    expect(settings.update).not.toHaveBeenCalled()
  })

  it('apagada o en «Nadie» no cuenta nada', async () => {
    settings.updateMany.mockResolvedValue({ count: 0 })
    await expect(contarPedidoSinAtenderEnTx(prismaMock as any, 'v1', NOW)).resolves.toBe(false)
    expect(prismaMock.onlineOrder.count).not.toHaveBeenCalled()
    expect(settings.update).not.toHaveBeenCalled()
  })
})

describe('marcarPedidoAtendido', () => {
  it('sólo mueve la marca hacia ADELANTE: una respuesta escrita tarde no borra un vencimiento posterior', async () => {
    await marcarPedidoAtendido('v1', NOW)
    expect(settings.updateMany).toHaveBeenCalledWith({
      where: { venueId: 'v1', OR: [{ missedOrdersSince: null }, { missedOrdersSince: { lt: NOW } }] },
      data: { missedOrdersSince: NOW },
    })
  })

  it('si la base falla, no tumba la aceptación (sólo se registra)', async () => {
    settings.updateMany.mockRejectedValue(new Error('db'))
    await expect(marcarPedidoAtendido('v1', NOW)).resolves.toBeUndefined()
  })
})
