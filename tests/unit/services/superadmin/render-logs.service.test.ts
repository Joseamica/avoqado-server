/**
 * Render Logs proxy — la ventana de búsqueda.
 *
 * Por qué existe (8-nov-2026): con el filtro «Error» y sin fecha, el SERVIDOR le pedía a Render buscar hacia
 * atrás en TODO el historial hasta juntar 100 errores (hay uno cada ~6 h). Tardaba 1–5 s y, cuando Render
 * andaba lento, más de 20 s: el 3-nov el SUPERADMIN se quedó en «Pidiendo logs…» 8 veces seguidas.
 * Ahora, sin fecha, se busca sólo en las últimas 24 h y la respuesta dice desde dónde seguir («Ver anteriores»).
 */
import axios from 'axios'

jest.mock('axios', () => ({
  __esModule: true,
  default: { get: jest.fn() },
  isAxiosError: (e: unknown) => (e as { isAxiosError?: boolean })?.isAxiosError === true,
}))

import { fetchRenderLogs } from '@/services/superadmin/render-logs.service'

const mockGet = (axios as unknown as { get: jest.Mock }).get
const AHORA = new Date('2026-11-08T18:00:00.000Z')
const HORA = 60 * 60 * 1000

function log(id: string, iso: string) {
  return { id, timestamp: iso, message: `m-${id}`, labels: [{ name: 'level', value: 'error' }] }
}

/** Contesta /services con un ownerId y /logs con lo que se le pase; devuelve los query params de /logs. */
function renderContesta(logs: { hasMore: boolean; nextEndTime?: string; logs: unknown[] }) {
  mockGet.mockImplementation(async (url: string) => {
    if (url.includes('/services/')) return { data: { ownerId: 'tea-x' } }
    return { data: logs }
  })
}

function colgado() {
  return Object.assign(new Error('timeout of 7000ms exceeded'), { isAxiosError: true, code: 'ECONNABORTED' })
}

function paramsDeLogs(): URLSearchParams {
  const call = mockGet.mock.calls.find(([url]) => (url as string).includes('/logs?'))
  return new URLSearchParams((call![0] as string).split('?')[1])
}

describe('fetchRenderLogs — ventana de búsqueda', () => {
  const envOriginal = { ...process.env }

  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers({ now: AHORA })
    process.env.RENDER_API_KEY = 'rnd_prueba'
    process.env.RENDER_SERVICE_ID = 'srv-prueba'
  })

  afterEach(() => {
    jest.useRealTimers()
    process.env = { ...envOriginal }
  })

  it('sin fecha, busca sólo en las últimas 24 h', async () => {
    renderContesta({ hasMore: false, logs: [] })

    const res = await fetchRenderLogs({ level: 'error' })

    const q = paramsDeLogs()
    expect(q.get('startTime')).toBe(new Date(AHORA.getTime() - 24 * HORA).toISOString())
    expect(q.get('endTime')).toBeNull()
    expect(q.get('level')).toBe('error')
    expect(res.windowStart).toBe(new Date(AHORA.getTime() - 24 * HORA).toISOString())
  })

  it('sin fecha y sin más en la ventana, «Ver anteriores» sigue desde el inicio de la ventana', async () => {
    renderContesta({ hasMore: false, logs: [log('a', '2026-11-08T12:00:00.000Z')] })

    const res = await fetchRenderLogs({ level: 'error' })

    expect(res.olderEndTime).toBe(res.windowStart)
  })

  it('con más logs dentro de la ventana, «Ver anteriores» sigue desde el más viejo que devolvió Render', async () => {
    renderContesta({ hasMore: true, nextEndTime: '2026-11-08T17:59:00.000Z', logs: [log('a', '2026-11-08T17:59:00.000Z')] })

    const res = await fetchRenderLogs({})

    expect(res.olderEndTime).toBe('2026-11-08T17:59:00.000Z')
  })

  it('con sólo endTime (página anterior), la ventana son las 24 h antes de ese punto', async () => {
    renderContesta({ hasMore: false, logs: [] })

    const res = await fetchRenderLogs({ level: 'error', endTime: '2026-11-07T18:00:00.000Z' })

    const q = paramsDeLogs()
    expect(q.get('endTime')).toBe('2026-11-07T18:00:00.000Z')
    expect(q.get('startTime')).toBe('2026-11-06T18:00:00.000Z')
    expect(res.olderEndTime).toBe('2026-11-06T18:00:00.000Z')
  })

  it('con un rango elegido por el operador, respeta su inicio y no ofrece ir más atrás de él', async () => {
    renderContesta({ hasMore: false, logs: [] })

    const res = await fetchRenderLogs({ startTime: '2026-11-01T06:00:00.000Z', endTime: '2026-11-02T06:00:00.000Z' })

    expect(paramsDeLogs().get('startTime')).toBe('2026-11-01T06:00:00.000Z')
    expect(res.olderEndTime).toBeUndefined()
  })

  it('no pide a Render más atrás de los ~7 días que guarda (medido el 8-nov)', async () => {
    renderContesta({ hasMore: false, logs: [] })

    const res = await fetchRenderLogs({ endTime: '2026-11-01T20:00:00.000Z' })

    const limite = new Date(AHORA.getTime() - 7 * 24 * HORA).toISOString()
    expect(paramsDeLogs().get('startTime')).toBe(limite)
    expect(res.olderEndTime).toBeUndefined()
  })

  it('un límite hostil se acota a 100', async () => {
    renderContesta({ hasMore: false, logs: [] })

    await fetchRenderLogs({ limit: 5000 })
    expect(paramsDeLogs().get('limit')).toBe('100')

    jest.clearAllMocks()
    renderContesta({ hasMore: false, logs: [] })
    await fetchRenderLogs({ limit: Number.NaN })
    expect(paramsDeLogs().get('limit')).toBe('100')
  })

  it('si Render se cuelga una vez, reintenta y contesta (medido: la misma consulta después tarda 0.4 s)', async () => {
    let intentos = 0
    mockGet.mockImplementation(async (url: string) => {
      if (url.includes('/services/')) return { data: { ownerId: 'tea-x' } }
      intentos++
      if (intentos === 1) throw colgado()
      return { data: { hasMore: false, logs: [log('a', '2026-11-08T12:00:00.000Z')] } }
    })

    const res = await fetchRenderLogs({ level: 'error' })

    expect(intentos).toBe(2)
    expect(res.logs.map(l => l.id)).toEqual(['a'])
  })

  it('si Render se cuelga las dos veces, responde 504 con un mensaje claro en vez de un error genérico', async () => {
    mockGet.mockImplementation(async (url: string) => {
      if (url.includes('/services/')) return { data: { ownerId: 'tea-x' } }
      throw colgado()
    })

    await expect(fetchRenderLogs({ level: 'error' })).rejects.toMatchObject({
      statusCode: 504,
      message: expect.stringContaining('Render tardó demasiado'),
    })
  })

  it('un error de Render que no es cuelgue no se reintenta', async () => {
    let intentos = 0
    mockGet.mockImplementation(async (url: string) => {
      if (url.includes('/services/')) return { data: { ownerId: 'tea-x' } }
      intentos++
      throw Object.assign(new Error('Request failed with status code 400'), {
        isAxiosError: true,
        response: { status: 400, data: { message: 'invalid startTime' } },
      })
    })

    await expect(fetchRenderLogs({})).rejects.toBeDefined()
    expect(intentos).toBe(1)
  })

  it('en el peor caso (ownerId + 2 cuelgues) el SERVIDOR se rinde antes que el navegador (20 s)', async () => {
    // Módulo nuevo para que el ownerId no venga en caché de otra prueba.
    let fresco!: typeof fetchRenderLogs
    let getFresco!: jest.Mock
    jest.isolateModules(() => {
      getFresco = (jest.requireMock('axios') as { default: { get: jest.Mock } }).default.get
      fresco = require('@/services/superadmin/render-logs.service').fetchRenderLogs
    })
    getFresco.mockImplementation(async (url: string) => {
      if (url.includes('/services/')) return { data: { ownerId: 'tea-x' } }
      throw colgado()
    })

    await expect(fresco({ level: 'error' })).rejects.toMatchObject({ statusCode: 504 })

    const timeouts = getFresco.mock.calls.map(([, cfg]) => (cfg as { timeout: number }).timeout)
    expect(timeouts).toHaveLength(3)
    expect(timeouts.reduce((a, b) => a + b, 0)).toBeLessThan(20_000)
  })

  // Regresión: lo que ya hacía.
  it('sigue apagado con mensaje si falta la llave de Render', async () => {
    delete process.env.RENDER_API_KEY

    const res = await fetchRenderLogs({})

    expect(res.enabled).toBe(false)
    expect(mockGet).not.toHaveBeenCalled()
  })

  it('sigue filtrando por texto del lado del servidor', async () => {
    renderContesta({
      hasMore: false,
      logs: [log('a', '2026-11-08T12:00:00.000Z'), { ...log('b', '2026-11-08T11:00:00.000Z'), message: 'Money watchdog' }],
    })

    const res = await fetchRenderLogs({ search: 'watchdog' })

    expect(res.logs.map(l => l.id)).toEqual(['b'])
  })
})
