import { getPosAppVersion } from '../../../src/controllers/public/posAppVersion.public.controller'
import { getPublicPolicy } from '../../../src/services/posAppVersion/policy.service'

jest.mock('../../../src/services/posAppVersion/policy.service', () => ({ getPublicPolicy: jest.fn() }))

const mockPolicy = getPublicPolicy as jest.Mock

function llamar(query: Record<string, unknown>) {
  const res: any = { setHeader: jest.fn(), json: jest.fn() }
  const next = jest.fn()
  return getPosAppVersion({ query } as any, res, next).then(() => ({ res, next, cuerpo: res.json.mock.calls[0]?.[0] }))
}

describe('GET /public/pos-app-version', () => {
  beforeEach(() => jest.clearAllMocks())

  it('DESKTOP da OK sin consultar la base', async () => {
    const { cuerpo } = await llamar({ platform: 'DESKTOP' })
    expect(cuerpo.data.status).toBe('OK')
    expect(mockPolicy).not.toHaveBeenCalled()
  })

  it('ANDROID 95 con obligatoria 100 da REQUIRED', async () => {
    mockPolicy.mockResolvedValue({
      levels: { required: { versionCode: 100, versionName: null }, recommended: null },
      message: null,
    })
    const { cuerpo } = await llamar({ platform: 'ANDROID', versionCode: 95 })
    expect(cuerpo.success).toBe(true)
    expect(cuerpo.data.status).toBe('REQUIRED')
    expect(cuerpo.data.required.versionCode).toBe(100)
    expect(typeof cuerpo.data.checkedAt).toBe('string')
  })

  it('pone Cache-Control: no-store', async () => {
    mockPolicy.mockResolvedValue(null)
    const { res } = await llamar({ platform: 'ANDROID', versionCode: 95 })
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store')
  })

  it('la fila vaciada (los dos niveles en null) da OK', async () => {
    mockPolicy.mockResolvedValue({ levels: { required: null, recommended: null }, message: null })
    const { cuerpo } = await llamar({ platform: 'ANDROID', versionCode: 1 })
    expect(cuerpo.data.status).toBe('OK')
    expect(cuerpo.data.required).toBeNull()
    expect(cuerpo.data.recommended).toBeNull()
  })

  it('sin política da OK y message null', async () => {
    mockPolicy.mockResolvedValue(null)
    const { cuerpo } = await llamar({ platform: 'ANDROID', versionCode: 1 })
    expect(cuerpo.data.status).toBe('OK')
    expect(cuerpo.data.message).toBeNull()
  })

  it('el message guardado sale en la respuesta', async () => {
    mockPolicy.mockResolvedValue({
      levels: { required: { versionCode: 100, versionName: null }, recommended: null },
      message: 'Actualiza por favor',
    })
    const { cuerpo } = await llamar({ platform: 'ANDROID', versionCode: 95 })
    expect(cuerpo.data.message).toBe('Actualiza por favor')
  })

  it('en iOS versionCode sale siempre null y no hay storeUrl', async () => {
    mockPolicy.mockResolvedValue({
      levels: {
        required: { versionCode: 7, versionName: '1.16.0' },
        recommended: { versionCode: 9, versionName: '1.17.0' },
      },
      message: null,
    })
    const { cuerpo } = await llamar({ platform: 'IOS', versionName: '1.15.0' })
    expect(cuerpo.data.status).toBe('REQUIRED')
    expect(cuerpo.data.required.versionCode).toBeNull()
    expect(cuerpo.data.required.versionName).toBe('1.16.0')
    expect(cuerpo.data.recommended.versionCode).toBeNull()
    expect(cuerpo.data).not.toHaveProperty('storeUrl')
    expect(JSON.stringify(cuerpo)).not.toContain('storeUrl')
  })

  it('un error del servicio va a next', async () => {
    mockPolicy.mockRejectedValue(new Error('boom'))
    const { next } = await llamar({ platform: 'ANDROID', versionCode: 1 })
    expect(next).toHaveBeenCalled()
  })
})
