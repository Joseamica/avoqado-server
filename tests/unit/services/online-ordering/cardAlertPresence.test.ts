// tests/unit/services/online-ordering/cardAlertPresence.test.ts
/**
 * D661: la caja actualizada que puede avisar los pedidos pagados en línea late con su propia cabecera. El latido se amortigua igual
 * que los de `presence.service` (la base se toca cada 30 s, no en cada sondeo) y con su PROPIO mapa: si compartiera el de folios,
 * un latido le «comería» al otro (R11).
 */
import { prismaMock } from '@tests/__helpers__/setup'
import { PRESENCE_WRITE_DEBOUNCE_MS } from '@/services/online-ordering/constants'
import { CARD_ALERT_HEADER, __resetCardAlertPollDebounceForTests, touchCardAlertPoll } from '@/services/online-ordering/cardAlertPresence'

const T0 = new Date('2026-11-20T18:00:00.000Z')
const despues = (ms: number) => new Date(T0.getTime() + ms)

beforeEach(() => {
  __resetCardAlertPollDebounceForTests()
  prismaMock.onlineOrderingSettings.updateMany.mockResolvedValue({ count: 1 })
})

describe('touchCardAlertPoll (D661)', () => {
  it('la cabecera es x-online-orders-card-alert', () => {
    expect(CARD_ALERT_HEADER).toBe('x-online-orders-card-alert')
  })

  it('escribe SÓLO lastCardAlertPollAt del negocio con la hora del latido', async () => {
    await expect(touchCardAlertPoll('v1', T0)).resolves.toBe(true)
    expect(prismaMock.onlineOrderingSettings.updateMany).toHaveBeenCalledWith({
      where: { venueId: 'v1' },
      data: { lastCardAlertPollAt: T0 },
    })
  })

  it('amortiguado: dentro de 30 s no vuelve a escribir; a los 30 s sí', async () => {
    await touchCardAlertPoll('v1', T0)
    await expect(touchCardAlertPoll('v1', despues(PRESENCE_WRITE_DEBOUNCE_MS - 1))).resolves.toBe(false)
    expect(prismaMock.onlineOrderingSettings.updateMany).toHaveBeenCalledTimes(1)
    await expect(touchCardAlertPoll('v1', despues(PRESENCE_WRITE_DEBOUNCE_MS))).resolves.toBe(true)
    expect(prismaMock.onlineOrderingSettings.updateMany).toHaveBeenCalledTimes(2)
  })

  it('cada negocio se amortigua aparte', async () => {
    await touchCardAlertPoll('v1', T0)
    await expect(touchCardAlertPoll('v2', despues(1_000))).resolves.toBe(true)
    expect(prismaMock.onlineOrderingSettings.updateMany).toHaveBeenLastCalledWith({
      where: { venueId: 'v2' },
      data: { lastCardAlertPollAt: despues(1_000) },
    })
  })

  it('R13: si la escritura falla, el siguiente latido sí escribe (el fallo no calla a la caja)', async () => {
    prismaMock.onlineOrderingSettings.updateMany.mockRejectedValueOnce(new Error('se cayó la base'))
    await expect(touchCardAlertPoll('v1', T0)).rejects.toThrow('se cayó la base')
    await expect(touchCardAlertPoll('v1', despues(1_000))).resolves.toBe(true)
    expect(prismaMock.onlineOrderingSettings.updateMany).toHaveBeenCalledTimes(2)
  })
})
