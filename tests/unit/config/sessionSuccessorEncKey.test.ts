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
    expect(env?.SESSION_SUCCESSOR_ENC_KEY).toBe(llaveMixta)
    exit.mockRestore()
  })

  it('ausente sigue siendo válida — la variable es OPCIONAL a propósito (un venue sin la llave no debe tumbar el arranque)', async () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

    const { env } = await loadEnv({ SESSION_SUCCESSOR_ENC_KEY: undefined })

    expect(exit).not.toHaveBeenCalled()
    expect(env?.SESSION_SUCCESSOR_ENC_KEY).toBeUndefined()
  })

  it('una longitud distinta de 64 (aunque sea hex válido) se sigue rechazando — el `.regex` no reemplaza al `.length`', async () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

    const { errors } = await loadEnv({ SESSION_SUCCESSOR_ENC_KEY: 'a'.repeat(63) })

    expect(exit).toHaveBeenCalledWith(1)
    expect(errors.some(e => e.includes('SESSION_SUCCESSOR_ENC_KEY'))).toBe(true)
    exit.mockRestore()
  })
})

/**
 * Aviso de arranque cuando la llave falta en un entorno desplegado.
 *
 * Por qué existe: la llave es OPCIONAL a propósito (arriba), y esa decisión es correcta —
 * tumbar TODA la API porque falta la config de una sola pieza es desproporcionado. Pero
 * "opcional" se convirtió en "silenciosa": el `/full-testing` del 2026-08-28 encontró que en
 * el entorno real la llave nunca se puso, así que la ventana de retransmisión de 60 s NO
 * EXISTÍA y cualquier reintento del refresco se leía como robo y REVOCABA la sesión. En un
 * POS con internet malo eso deja al cajero fuera a media venta — justo lo que esa pieza
 * existía para evitar. Nadie se enteró porque nada lo decía.
 *
 * Mismo patrón, y mismo razonamiento, que el guardia de `EXTERNAL_BANK_API_BASE` unas líneas
 * más abajo en `env.ts`: `logger.error` y NO `process.exit`, porque un error de arranque sí
 * entra a la alerta de Better Stack y eso es exactamente lo que faltaba.
 */
describe('SESSION_SUCCESSOR_ENC_KEY — aviso de arranque en entornos desplegados', () => {
  const mencionaLaLlave = (errores: string[]) => errores.filter(e => e.includes('SESSION_SUCCESSOR_ENC_KEY'))

  it('🔴 en producción SIN la llave avisa fuerte, y el aviso dice la consecuencia (la sesión del cajero se revoca)', async () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

    const { errors } = await loadEnv({ NODE_ENV: 'production', SESSION_SUCCESSOR_ENC_KEY: undefined })

    const avisos = mencionaLaLlave(errors)
    expect(avisos.length).toBeGreaterThan(0)
    // No basta con nombrar la variable: quien lea la alerta a las 3 AM tiene que entender
    // qué se rompe. Sin esto el aviso es tan inútil como el silencio que reemplaza.
    expect(avisos.join(' ')).toMatch(/retransmisi[oó]n|revoc/i)
    exit.mockRestore()
  })

  it('en staging SIN la llave también avisa — es un entorno desplegado con aparatos reales conectados', async () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

    const { errors } = await loadEnv({ NODE_ENV: 'staging', SESSION_SUCCESSOR_ENC_KEY: undefined })

    expect(mencionaLaLlave(errors).length).toBeGreaterThan(0)
    exit.mockRestore()
  })

  it('en producción CON la llave no avisa nada — el aviso que sale siempre es ruido que se aprende a ignorar', async () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

    const { errors } = await loadEnv({ NODE_ENV: 'production', SESSION_SUCCESSOR_ENC_KEY: 'a'.repeat(64) })

    expect(mencionaLaLlave(errors)).toEqual([])
    exit.mockRestore()
  })

  it('en development SIN la llave NO avisa — un dev local no despliega nada y no debe ver un error rojo al arrancar', async () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

    const { errors } = await loadEnv({ NODE_ENV: 'development', SESSION_SUCCESSOR_ENC_KEY: undefined })

    expect(mencionaLaLlave(errors)).toEqual([])
    exit.mockRestore()
  })
})
