/**
 * Política del host del proveedor bancario (`EXTERNAL_BANK_API_BASE`).
 *
 * Motivado por el incidente 2026-08-02/03 (venue Amaena): el proveedor migró su dominio de
 * producción a `quarkpayments.mx` y dejó en `prod.moneygiver.xyz` un 301 hacia
 * `prod.quarkpayments.mx`, que NO existe en DNS. Nadie se enteró durante ~1 mes.
 *
 * Dos agujeros de configuración quedaron a la vista y estos tests los fijan:
 *
 *  1. El default del schema era `https://api.qpaydev.xyz` — el entorno **DEV** del proveedor.
 *     Borrar la variable en Render mandaba PRODUCCIÓN a dev en silencio: las llamadas
 *     responden 200, pero contra datos que no son los del cliente. Un fallback tiene que
 *     fallar hacia el lado seguro.
 *  2. No había ninguna señal cuando prod apuntaba a un host que no debe atender producción.
 */

// A test file with no top-level import/export is a SCRIPT, not a module, so its
// top-level `const`s land in the global scope and collide across files — two
// suites both declaring `mockSend` broke the typecheck, not the tests. This
// keeps the file a module even when it needs no imports.
export {}
const ORIGINAL = process.env

/** Carga env.ts desde cero con el process.env dado y captura lo que loguea. */
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
  const mod = await import('@/config/env')
  return { env: mod.env, errors }
}

afterEach(() => {
  process.env = ORIGINAL
  jest.dontMock('@/config/logger')
})

describe('EXTERNAL_BANK_API_BASE', () => {
  it('el default NUNCA es un host de dev: sin la variable, cae a producción', async () => {
    const { env } = await loadEnv({ EXTERNAL_BANK_API_BASE: undefined })

    // El bug: default a qpaydev.xyz mandaba prod al ambiente dev del proveedor sin avisar.
    expect(env.EXTERNAL_BANK_API_BASE).not.toContain('qpaydev')
    expect(env.EXTERNAL_BANK_API_BASE).not.toContain('moneygiver')
    expect(env.EXTERNAL_BANK_API_BASE).toBe('https://api.quarkpayments.mx')
  })

  it('sigue siendo opcional: una variable faltante NO puede tumbar la API entera', async () => {
    // env.ts hace process.exit(1) si el parseo falla. Volverla `required` apagaría pagos,
    // POS y órdenes por la config de una sola feature.
    await expect(loadEnv({ EXTERNAL_BANK_API_BASE: undefined })).resolves.toBeDefined()
  })

  it('un valor explícito gana sobre el default', async () => {
    const { env } = await loadEnv({ EXTERNAL_BANK_API_BASE: 'https://api.otro-proveedor.mx' })
    expect(env.EXTERNAL_BANK_API_BASE).toBe('https://api.otro-proveedor.mx')
  })

  describe('guardia de arranque en producción', () => {
    it.each([
      ['https://api.qpaydev.xyz', 'DEV'],
      ['https://prod.moneygiver.xyz', 'RETIRADO'],
      ['https://cualquier-cosa.qpaydev.xyz', 'subdominio DEV'],
    ])('grita si prod apunta a %s (%s)', async base => {
      const { errors } = await loadEnv({ NODE_ENV: 'production', EXTERNAL_BANK_API_BASE: base })

      const hit = errors.find(e => e.includes('EXTERNAL_BANK_API_BASE'))
      expect(hit).toBeDefined()
      expect(hit).toContain(new URL(base).hostname)
    })

    it('se calla con el host bueno de producción', async () => {
      const { errors } = await loadEnv({ NODE_ENV: 'production', EXTERNAL_BANK_API_BASE: 'https://api.quarkpayments.mx' })
      expect(errors.find(e => e.includes('EXTERNAL_BANK_API_BASE'))).toBeUndefined()
    })

    it('NO grita fuera de producción — en dev apuntar a dev es lo correcto', async () => {
      const { errors } = await loadEnv({ NODE_ENV: 'development', EXTERNAL_BANK_API_BASE: 'https://api.qpaydev.xyz' })
      expect(errors.find(e => e.includes('EXTERNAL_BANK_API_BASE'))).toBeUndefined()
    })

    it('el guardia avisa, NUNCA mata el proceso (no es process.exit)', async () => {
      const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
      await loadEnv({ NODE_ENV: 'production', EXTERNAL_BANK_API_BASE: 'https://api.qpaydev.xyz' })
      expect(exit).not.toHaveBeenCalled()
      exit.mockRestore()
    })
  })
})
