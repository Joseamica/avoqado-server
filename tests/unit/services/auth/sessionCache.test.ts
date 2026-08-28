// tests/unit/services/auth/sessionCache.test.ts
//
// `sessionCache.ts` dejó de usar Redis (`.claude/rules/una-sola-instancia.md`: este server
// corre UNA sola instancia a propósito) — ahora es un `Map` en memoria del proceso. Las
// pruebas ya no mockean un cliente Redis; sólo mockean la base (`session.service`).
import { isSessionAliveCached, invalidateSession, _limpiarCacheDeSesiones, _tamanoCacheDeSesiones } from '@/services/auth/sessionCache'
import * as sessionService from '@/services/auth/session.service'

jest.mock('@/services/auth/session.service')

describe('sessionCache', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useRealTimers()
    _limpiarCacheDeSesiones()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('con la caché en frío consulta la base y devuelve lo que diga', async () => {
    ;(sessionService.isSessionAlive as jest.Mock).mockResolvedValue(false)
    await expect(isSessionAliveCached('s1')).resolves.toBe(false)
    expect(sessionService.isSessionAlive).toHaveBeenCalledWith('s1')
  })

  it('si la base falla, la petición falla — nunca se acepta por defecto', async () => {
    ;(sessionService.isSessionAlive as jest.Mock).mockRejectedValue(new Error('db down'))
    await expect(isSessionAliveCached('s1')).rejects.toThrow('db down')
  })

  it('con un tombstone ya en caché, ni siquiera se pregunta a la base', async () => {
    await invalidateSession('s1')
    // Si SÍ se preguntara, la base mentiría "viva" — la prueba lo cazaría.
    ;(sessionService.isSessionAlive as jest.Mock).mockResolvedValue(true)

    await expect(isSessionAliveCached('s1')).resolves.toBe(false)
    expect(sessionService.isSessionAlive).not.toHaveBeenCalled()
  })

  it('un "alive" tardío NUNCA pisa un tombstone escrito mientras la base respondía (race)', async () => {
    // Simula el entrelazado que describe la tarea: una lectura arranca, se queda esperando
    // a la base (el `await` es el único punto donde otra operación puede colarse en medio),
    // y MIENTRAS espera, la sesión se revoca. Cuando por fin la base contesta con el dato
    // viejo ("seguía viva"), ese cache-fill no puede pisar el tombstone que ya se escribió.
    let resolverBase!: (v: boolean) => void
    const promesaBase = new Promise<boolean>(resolve => {
      resolverBase = resolve
    })
    ;(sessionService.isSessionAlive as jest.Mock).mockReturnValue(promesaBase)

    const lecturaEnVuelo = isSessionAliveCached('s1') // arranca; se queda esperando a la base

    await invalidateSession('s1') // se revoca DURANTE la espera de la lectura de arriba

    resolverBase(true) // la base contesta tarde, con un dato ya obsoleto: "seguía viva"
    await expect(lecturaEnVuelo).resolves.toBe(true) // esa lectura puntual sí ve lo que leyó

    // Pero el cache-fill de esa lectura no pudo pisar el tombstone: la siguiente lectura
    // sigue viendo la sesión revocada, sin volver a tocar la base.
    ;(sessionService.isSessionAlive as jest.Mock).mockClear()
    await expect(isSessionAliveCached('s1')).resolves.toBe(false)
    expect(sessionService.isSessionAlive).not.toHaveBeenCalled()
  })

  it('una entrada cacheada caduca a los 60s y se vuelve a consultar la base', async () => {
    jest.useFakeTimers().setSystemTime(0)
    ;(sessionService.isSessionAlive as jest.Mock).mockResolvedValue(true)

    await expect(isSessionAliveCached('s1')).resolves.toBe(true)
    expect(sessionService.isSessionAlive).toHaveBeenCalledTimes(1)

    // Dentro del TTL: no vuelve a tocar la base.
    jest.setSystemTime(59_000)
    await expect(isSessionAliveCached('s1')).resolves.toBe(true)
    expect(sessionService.isSessionAlive).toHaveBeenCalledTimes(1)

    // Pasado el TTL de 60s: la entrada caducó, se vuelve a consultar.
    jest.setSystemTime(60_001)
    ;(sessionService.isSessionAlive as jest.Mock).mockResolvedValue(false)
    await expect(isSessionAliveCached('s1')).resolves.toBe(false)
    expect(sessionService.isSessionAlive).toHaveBeenCalledTimes(2)
  })

  it('purga las entradas ya vencidas cuando la caché supera el umbral, sin tocar las vigentes', async () => {
    jest.useFakeTimers().setSystemTime(0)
    ;(sessionService.isSessionAlive as jest.Mock).mockResolvedValue(true)

    for (let i = 0; i < 5001; i++) {
      await isSessionAliveCached(`vieja-${i}`)
    }
    expect(_tamanoCacheDeSesiones()).toBe(5001)

    // Pasa el TTL: esas 5001 entradas ya vencieron, pero nadie las ha vuelto a leer.
    jest.setSystemTime(61_000)

    // Una entrada nueva vuelve a cruzar el umbral y dispara el barrido.
    await isSessionAliveCached('nueva')

    expect(_tamanoCacheDeSesiones()).toBe(1)
  })
})
