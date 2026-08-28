// tests/unit/services/auth/redisClient.test.ts
//
// Cubre los dos hallazgos de la ronda de revisión de Task 4:
// - [Crítico] un 'alive' tardío no puede pisar un tombstone ya escrito.
// - [Importante] con Redis caído (no ausente), un segundo intento inmediato no debe abrir
//   un cliente nuevo — el cooldown es lo que evita la tormenta de reconexión.
jest.mock('redis')
jest.mock('@/config/env', () => ({ REDIS_URL: 'redis://localhost:6379' }))

type FakeRedisClient = {
  isOpen: boolean
  on: jest.Mock
  connect: jest.Mock
  get: jest.Mock
  setEx: jest.Mock
  eval: jest.Mock
}

/**
 * Cliente falso con un almacén en memoria. `eval` implementa el MISMO guard que el script
 * Lua real (`LUA_SET_UNLESS_REVOKED` en `redisClient.ts`): "si el valor actual es 'revoked',
 * no escribas nada". Un EVAL de Lua corre como una unidad indivisible dentro de Redis — esta
 * implementación síncrona en JS es la forma estándar de simular esa atomicidad en una prueba
 * unitaria sin levantar un Redis real. `setEx` (el método RAW del cliente) es deliberadamente
 * INCONDICIONAL, igual que el SETEX real — si `redisClient.ts` volviera a llamarlo directo
 * para el cache-fill de 'alive', la prueba del Crítico lo cazaría.
 */
function makeFakeClient(): FakeRedisClient {
  const store: Record<string, string> = {}
  return {
    isOpen: true,
    on: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
    get: jest.fn(async (key: string) => store[key] ?? null),
    setEx: jest.fn(async (key: string, _ttlSeconds: number, value: string) => {
      store[key] = value
      return 'OK'
    }),
    eval: jest.fn(async (_script: string, opts: { keys?: string[]; arguments?: string[] }) => {
      const key = opts.keys?.[0] as string
      const value = opts.arguments?.[0] as string
      if (store[key] === 'revoked') return 0
      store[key] = value
      return 1
    }),
  }
}

/**
 * `redisClient.ts` guarda estado de módulo a propósito (una sola conexión compartida entre
 * llamadas: `client`, `connecting`, y ahora `lastFailureAt` para el cooldown). Eso es exactamente
 * lo que las pruebas necesitan AISLAR entre sí — sin esto, el cliente "vivo" de una prueba se
 * cuela en la siguiente y el escenario que se quiere provocar (conexión fría, o una falla
 * reciente) nunca ocurre. `jest.resetModules()` + reimportar TANTO 'redis' como
 * '@/services/auth/redisClient' desde el MISMO registro fresco asegura que el mock de
 * `createClient` que la prueba controla sea el mismo que `redisClient.ts` usa por dentro.
 */
async function loadFreshRedisClient() {
  jest.resetModules()
  const redisPkg = await import('redis')
  const redisClient = await import('@/services/auth/redisClient')
  return { createClient: redisPkg.createClient as jest.Mock, redisClient }
}

describe('redisClient', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('[Crítico] un alive tardío NUNCA pisa un tombstone ya escrito', async () => {
    const { createClient: freshCreateClient, redisClient } = await loadFreshRedisClient()
    const fake = makeFakeClient()
    freshCreateClient.mockReturnValue(fake)

    await redisClient.setTombstone('sess:s1', 60) // el tombstone ya quedó escrito
    await redisClient.setEx('sess:s1', 'alive', 60) // "llega DESPUÉS" del tombstone

    await expect(redisClient.get('sess:s1')).resolves.toBe('revoked')
  })

  it('[Importante] con Redis caído, un intento inmediato subsecuente NO abre un cliente nuevo (cooldown)', async () => {
    const { createClient: freshCreateClient, redisClient } = await loadFreshRedisClient()
    const failing = {
      isOpen: false,
      on: jest.fn(),
      connect: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    }
    freshCreateClient.mockReturnValue(failing)

    await expect(redisClient.get('sess:s1')).rejects.toThrow()
    expect(freshCreateClient).toHaveBeenCalledTimes(1)

    await expect(redisClient.get('sess:s1')).rejects.toThrow()
    expect(freshCreateClient).toHaveBeenCalledTimes(1) // sigue en 1: el cooldown evitó un 2º intento
  })
})
