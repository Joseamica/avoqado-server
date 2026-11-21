// tests/unit/services/online-ordering/cardAlertPresence.test.ts
/**
 * D661: la caja actualizada que puede avisar los pedidos pagados en línea late con su propia cabecera, con su PROPIO mapa de
 * amortiguado (si compartiera el de folios, un latido le «comería» al otro, R11).
 * Ruling 7 (3B): el latido escribe `lastCardAlertPollAt` (cualquier sondeo: sólo decide si se puede prender el interruptor) y, si la
 * respuesta que recibió la caja fue RÁPIDA, también `cardAlertFastPollAt` (lo que decide si la tarjeta se ofrece). El amortiguado es
 * de 20 s como mucho (con sondeos cada 30 s, cada uno escribe y la tarjeta no parpadea), se mueve sólo si de verdad se escribió una
 * fila, y la hora es SIEMPRE la del servidor.
 */
import { prismaMock } from '@tests/__helpers__/setup'
import { CARD_ALERT_FAST_WINDOW_MS, CARD_ALERT_WRITE_DEBOUNCE_MS } from '@/services/online-ordering/constants'
import { CARD_ALERT_HEADER, __resetCardAlertPollDebounceForTests, touchCardAlertPoll } from '@/services/online-ordering/cardAlertPresence'

const T0 = new Date('2026-11-20T18:00:00.000Z')
const despues = (ms: number) => new Date(T0.getTime() + ms)
/** El reloj del servidor (la función ya no recibe hora de quien llama). */
const reloj = (d: Date) => jest.setSystemTime(d)

/** La fila de ajustes en la base: `cardAlertFastPollAt` puesto o no (la escritura que lo apaga es condicional). */
let marcaRapida: Date | null
beforeEach(() => {
  jest.useFakeTimers({ now: T0, doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'] })
  __resetCardAlertPollDebounceForTests()
  marcaRapida = null
  prismaMock.onlineOrderingSettings.updateMany.mockReset()
  prismaMock.onlineOrderingSettings.updateMany.mockImplementation((async (a: any) => {
    if (a.where.cardAlertFastPollAt && marcaRapida === null) return { count: 0 }
    if ('cardAlertFastPollAt' in a.data) marcaRapida = a.data.cardAlertFastPollAt
    return { count: 1 }
  }) as any)
})
afterEach(() => jest.useRealTimers())

const escrituras = () => (prismaMock.onlineOrderingSettings.updateMany.mock.calls as any[][]).map(c => c[0])

describe('touchCardAlertPoll (D661)', () => {
  it('la cabecera es x-online-orders-card-alert', () => {
    expect(CARD_ALERT_HEADER).toBe('x-online-orders-card-alert')
  })

  it('Ruling 7: el amortiguado no pasa de ~20 s y la ventana de la caja rápida es de 90 s (tres sondeos de 30 s)', () => {
    expect(CARD_ALERT_WRITE_DEBOUNCE_MS).toBeLessThanOrEqual(20_000)
    expect(CARD_ALERT_FAST_WINDOW_MS).toBe(90_000)
  })

  it('una respuesta LENTA escribe sólo lastCardAlertPollAt; una RÁPIDA, también cardAlertFastPollAt; las dos con la hora del servidor', async () => {
    await expect(touchCardAlertPoll('v1', false)).resolves.toBe(true)
    reloj(despues(5_000))
    await expect(touchCardAlertPoll('v2', true)).resolves.toBe(true)
    expect(escrituras()).toEqual([
      // B1: la lenta primero apaga la marca rápida si estuviera puesta (aquí no lo estaba: no escribió nada)…
      { where: { venueId: 'v1', cardAlertFastPollAt: { not: null } }, data: { cardAlertFastPollAt: null, lastCardAlertPollAt: T0 } },
      // …y escribe el latido de siempre.
      { where: { venueId: 'v1' }, data: { lastCardAlertPollAt: T0 } },
      { where: { venueId: 'v2' }, data: { lastCardAlertPollAt: despues(5_000), cardAlertFastPollAt: despues(5_000) } },
    ])
  })

  it('la hora nunca la pone quien llama: un tercer argumento se ignora y se escribe el reloj del servidor', async () => {
    const delCliente = new Date('2030-01-01T00:00:00.000Z')
    await (touchCardAlertPoll as (...a: unknown[]) => Promise<boolean>)('v1', true, delCliente)
    expect(escrituras()[0].data).toEqual({ lastCardAlertPollAt: T0, cardAlertFastPollAt: T0 })
  })

  it('amortiguado: dentro de 20 s no vuelve a escribir; a los 20 s sí (con sondeos cada 30 s, cada uno escribe)', async () => {
    await touchCardAlertPoll('v1', true)
    reloj(despues(CARD_ALERT_WRITE_DEBOUNCE_MS - 1))
    await expect(touchCardAlertPoll('v1', true)).resolves.toBe(false)
    expect(escrituras()).toHaveLength(1)
    reloj(despues(CARD_ALERT_WRITE_DEBOUNCE_MS))
    await expect(touchCardAlertPoll('v1', true)).resolves.toBe(true)
    reloj(despues(CARD_ALERT_WRITE_DEBOUNCE_MS + 30_000))
    await expect(touchCardAlertPoll('v1', true)).resolves.toBe(true)
    expect(escrituras()).toHaveLength(3)
  })

  it('una respuesta rápida justo después de una lenta escribe igual: el sondeo lento no retrasa la tarjeta', async () => {
    await touchCardAlertPoll('v1', false)
    reloj(despues(1_000))
    await expect(touchCardAlertPoll('v1', true)).resolves.toBe(true)
    expect(escrituras().at(-1).data).toEqual({ lastCardAlertPollAt: despues(1_000), cardAlertFastPollAt: despues(1_000) })
    expect(marcaRapida).toEqual(despues(1_000))
  })

  it('D661 · B1: una respuesta LENTA justo después de una rápida apaga la marca rápida EN SEGUIDA (el amortiguado no la retrasa): la caja ya duerme 10 min', async () => {
    await touchCardAlertPoll('v1', true)
    reloj(despues(2_000))
    await expect(touchCardAlertPoll('v1', false)).resolves.toBe(true)
    expect(escrituras().at(-1)).toEqual({
      where: { venueId: 'v1', cardAlertFastPollAt: { not: null } },
      data: { cardAlertFastPollAt: null, lastCardAlertPollAt: despues(2_000) },
    })
    expect(marcaRapida).toBeNull()
    // Otra lenta enseguida ya no tiene nada que apagar ni escribe el latido (amortiguado).
    reloj(despues(3_000))
    await expect(touchCardAlertPoll('v1', false)).resolves.toBe(false)
  })

  it('D661 · B1: la siguiente respuesta rápida tras apagarla escribe en seguida (el amortiguado de la rápida anterior no la frena)', async () => {
    await touchCardAlertPoll('v1', true)
    reloj(despues(2_000))
    await touchCardAlertPoll('v1', false)
    reloj(despues(4_000))
    await expect(touchCardAlertPoll('v1', true)).resolves.toBe(true)
    expect(marcaRapida).toEqual(despues(4_000))
  })

  it('cada negocio se amortigua aparte', async () => {
    await touchCardAlertPoll('v1', true)
    reloj(despues(1_000))
    await expect(touchCardAlertPoll('v2', true)).resolves.toBe(true)
    expect(escrituras()[1].where).toEqual({ venueId: 'v2' })
  })

  it('sin fila de ajustes (count 0) no se escribió nada: devuelve false y el siguiente sondeo lo vuelve a intentar', async () => {
    prismaMock.onlineOrderingSettings.updateMany.mockResolvedValueOnce({ count: 0 })
    await expect(touchCardAlertPoll('v1', true)).resolves.toBe(false)
    reloj(despues(1_000))
    await expect(touchCardAlertPoll('v1', true)).resolves.toBe(true)
    expect(escrituras()).toHaveLength(2)
  })

  it('R13: si la escritura falla, el siguiente latido sí escribe (el fallo no calla a la caja)', async () => {
    prismaMock.onlineOrderingSettings.updateMany.mockRejectedValueOnce(new Error('se cayó la base'))
    await expect(touchCardAlertPoll('v1', true)).rejects.toThrow('se cayó la base')
    reloj(despues(1_000))
    await expect(touchCardAlertPoll('v1', true)).resolves.toBe(true)
    expect(escrituras()).toHaveLength(2)
  })
})
