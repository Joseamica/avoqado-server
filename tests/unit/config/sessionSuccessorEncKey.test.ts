/**
 * `SESSION_SUCCESSOR_ENC_KEY` (Parte A, Task 9) cifra el sucesor del refresh token durante la
 * ventana de retransmisión de 60s (`successorCrypto.ts`). El validador original sólo contaba
 * caracteres: `.length(64, ...)` deja pasar un valor de 64 chars con una letra fuera de
 * [0-9a-f]. Zod lo acepta, el servidor arranca normal, y `Buffer.from(hex, 'hex')` trunca en
 * el primer byte inválido — produce una llave de longitud arbitraria en vez de fallar. La
 * primera vez que algo intenta cifrar con ella, `crypto.createCipheriv` lanza SIN captura:
 * se rompe TODA la rotación de refresh de la plataforma, no sólo la retransmisión.
 *
 * Sigue el mismo patrón seguro que `externalBankHost.test.ts`: `env.ts` corre `process.exit(1)`
 * al importarse si el parseo falla, así que la única forma de probar esta rama sin matar al
 * worker de Jest es mockear `process.exit` ANTES de forzar la recarga del módulo.
 */

export {} // mantiene el archivo como módulo — ver la nota en externalBankHost.test.ts
const ORIGINAL = process.env

/**
 * Carga env.ts desde cero con el process.env dado y captura lo que loguea.
 *
 * Con `process.exit` mockeado como no-op (necesario para no matar al worker de Jest), un
 * parseo fallido NO detiene el módulo en el sitio real: `env.ts` sigue ejecutando después del
 * `if (!parsed.success) { ...; process.exit(1) }` y revienta más abajo al desreferenciar
 * `env.NODE_ENV` sobre `parsed.data` (`undefined`). En producción esto nunca pasa —
 * `process.exit(1)` sí mata el proceso ahí mismo. Para cuando esa excepción ocurre, lo que
 * importa ya sucedió: `errors` tiene el mensaje de Zod y `exit` ya se llamó — por eso el catch
 * de aquí abajo, en vez de dejar que la excepción se escape hacia cada test.
 */
async function loadEnv(overrides: Record<string, string | undefined>) {
  jest.resetModules()
  process.env = { ...ORIGINAL, ...overrides } as NodeJS.ProcessEnv
  const errors: string[] = []
  jest.doMock('@/config/logger', () => ({
    __esModule: true,
    default: {
      error: (m: string) => errors.push(String(m)),
      warn: (m: string) => errors.push(String(m)),
      info: () => {},
      debug: () => {},
    },
  }))
  try {
    const mod = await import('@/config/env')
    return { env: mod.env as typeof mod.env | undefined, errors }
  } catch {
    return { env: undefined, errors }
  }
}

afterEach(() => {
  process.env = ORIGINAL
  jest.dontMock('@/config/logger')
})

describe('SESSION_SUCCESSOR_ENC_KEY', () => {
  it('🔴 [Auditoría Task 9, hallazgo crítico] 64 caracteres que NO son hex se RECHAZAN — antes pasaban por sólo contar longitud', async () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

    const { errors } = await loadEnv({ SESSION_SUCCESSOR_ENC_KEY: 'z'.repeat(64) })

    // El mensaje del propio schema promete "hex de 32 bytes" — si esto no truena, la promesa
    // era falsa y Buffer.from(hex, 'hex') iba a truncar en silencio la primera 'z'.
    expect(exit).toHaveBeenCalledWith(1)
    expect(errors.some(e => e.includes('SESSION_SUCCESSOR_ENC_KEY'))).toBe(true)
    exit.mockRestore()
  })

  it('64 caracteres hex válidos, mezclando mayúsculas y minúsculas, arrancan sin llamar a process.exit', async () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

    const llaveMixta = 'A'.repeat(32) + 'b'.repeat(32) // 64 chars, hex válido, case mixto
    const { env } = await loadEnv({ SESSION_SUCCESSOR_ENC_KEY: llaveMixta })

    expect(exit).not.toHaveBeenCalled()
    expect(env.SESSION_SUCCESSOR_ENC_KEY).toBe(llaveMixta)
    exit.mockRestore()
  })

  it('ausente sigue siendo válida — la variable es OPCIONAL a propósito (un venue sin la llave no debe tumbar el arranque)', async () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

    const { env } = await loadEnv({ SESSION_SUCCESSOR_ENC_KEY: undefined })

    expect(exit).not.toHaveBeenCalled()
    expect(env.SESSION_SUCCESSOR_ENC_KEY).toBeUndefined()
  })

  it('una longitud distinta de 64 (aunque sea hex válido) se sigue rechazando — el `.regex` no reemplaza al `.length`', async () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

    const { errors } = await loadEnv({ SESSION_SUCCESSOR_ENC_KEY: 'a'.repeat(63) })

    expect(exit).toHaveBeenCalledWith(1)
    expect(errors.some(e => e.includes('SESSION_SUCCESSOR_ENC_KEY'))).toBe(true)
    exit.mockRestore()
  })
})
