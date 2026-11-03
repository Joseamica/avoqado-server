/**
 * Ruling 3 (revisión de la Tarea 2): las variables del Gmail del vendedor son OPCIONALES y una mal escrita nunca tumba la
 * API. Antes `CRM_GMAIL_TOKEN_KEY` llevaba `.length(64)` y `CRM_GMAIL_REDIRECT_URI` `.url()`: una llave pegada en base64 o
 * una dirección sin `https://` hacían `process.exit(1)` de TODO (pagos, POS, órdenes). La validación vive donde se usan
 * (`gmailOAuth.service.ts`): ahí «Mi Gmail» dice «Falta configurar la app de Google».
 *
 * Mismo patrón seguro que `sessionSuccessorEncKey.test.ts`: `env.ts` corre `process.exit(1)` al importarse si el parseo
 * falla, así que se mockea `process.exit` ANTES de recargar el módulo.
 */
export {}
const ORIGINAL = process.env

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

describe('CRM_GMAIL_* mal escritas no tumban el arranque', () => {
  it.each([
    ['la llave en base64', { CRM_GMAIL_TOKEN_KEY: Buffer.from('ab'.repeat(32), 'hex').toString('base64') }],
    ['la llave de 64 caracteres no hex', { CRM_GMAIL_TOKEN_KEY: 'z'.repeat(64) }],
    ['la dirección de vuelta sin https://', { CRM_GMAIL_REDIRECT_URI: 'api.avoqado.io/api/v1/crm/gmail/callback' }],
  ])('con %s la API arranca (sin process.exit)', async (_caso, over) => {
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const { env } = await loadEnv(over)
    expect(exit).not.toHaveBeenCalled()
    expect(env).toBeDefined()
    exit.mockRestore()
  })
})
