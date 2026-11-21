// tests/unit/utils/conPlazo.test.ts
/**
 * D661 (Ruling 73): nuestro plazo duro sobre una promesa que puede no terminar nunca (el lector del cuerpo de stripe-node cuando la
 * conexión muere a medio cuerpo). Al cumplirse se rechaza con un error reconocible; antes, la promesa manda; el temporizador no queda vivo.
 */
import { PlazoAgotado, conPlazo } from '@/utils/conPlazo'

beforeEach(() => jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }))
afterEach(() => jest.useRealTimers())

describe('conPlazo', () => {
  it('una promesa que nunca termina se rechaza con PlazoAgotado al cumplirse el plazo, no antes', async () => {
    let desenlace: unknown = 'pendiente'
    conPlazo(new Promise<never>(() => {}), 15_000).then(
      () => (desenlace = 'resuelta'),
      e => (desenlace = e),
    )
    await jest.advanceTimersByTimeAsync(14_999)
    expect(desenlace).toBe('pendiente')
    await jest.advanceTimersByTimeAsync(1)
    expect(desenlace).toBeInstanceOf(PlazoAgotado)
    expect(desenlace).toMatchObject({ name: 'PlazoAgotado', ms: 15_000 })
    expect(jest.getTimerCount()).toBe(0)
  })

  it('antes del plazo manda la promesa (su valor o su error) y el temporizador se limpia', async () => {
    await expect(conPlazo(Promise.resolve('cs_1'), 15_000)).resolves.toBe('cs_1')
    expect(jest.getTimerCount()).toBe(0)
    const deStripe = Object.assign(new Error('se perdió la respuesta'), { type: 'StripeConnectionError' })
    await expect(conPlazo(Promise.reject(deStripe), 15_000)).rejects.toBe(deStripe)
    expect(jest.getTimerCount()).toBe(0)
  })

  it('el rechazo tardío de la promesa abandonada no queda sin atender (la carrera lo recibe)', async () => {
    let rechazar!: (e: Error) => void
    const tardia = new Promise<never>((_, r) => (rechazar = r))
    const avisos: unknown[] = []
    const alAviso = (e: unknown) => avisos.push(e)
    process.on('unhandledRejection', alAviso)
    try {
      const acotada = expect(conPlazo(tardia, 1_000)).rejects.toBeInstanceOf(PlazoAgotado)
      await jest.advanceTimersByTimeAsync(1_000)
      await acotada
      rechazar(new Error('el socket huérfano por fin murió'))
      await jest.advanceTimersByTimeAsync(0)
      await new Promise(r => setImmediate(r))
      expect(avisos).toEqual([])
    } finally {
      process.off('unhandledRejection', alAviso)
    }
  })
})
