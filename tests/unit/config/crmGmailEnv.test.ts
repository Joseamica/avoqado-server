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

// Minor 1 de la revisión final: el tope diario de las campañas también va por Ruling 3. «1,000» (con coma) o «mil» hacían
// `process.exit(1)` de toda la API; ahora valen el default de 300, el calentamiento seguro del subdominio.
describe('CRM_CAMPAIGN_DAILY_CAP mal escrito no tumba el arranque', () => {
  it.each([
    ['con coma de miles', '1,000'],
    ['con letras', 'mil'],
    ['negativo', '-5'],
    ['con decimales', '12.5'],
  ])('%s («%s») arranca con el default de 300', async (_caso, valor) => {
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const { env } = await loadEnv({ CRM_CAMPAIGN_DAILY_CAP: valor })
    expect(exit).not.toHaveBeenCalled()
    expect(env?.CRM_CAMPAIGN_DAILY_CAP).toBe(300)
    exit.mockRestore()
  })

  it('un número bien escrito se respeta, y sin variable queda en 300', async () => {
    expect((await loadEnv({ CRM_CAMPAIGN_DAILY_CAP: '1000' })).env?.CRM_CAMPAIGN_DAILY_CAP).toBe(1000)
    expect((await loadEnv({ CRM_CAMPAIGN_DAILY_CAP: undefined })).env?.CRM_CAMPAIGN_DAILY_CAP).toBe(300)
  })
})
