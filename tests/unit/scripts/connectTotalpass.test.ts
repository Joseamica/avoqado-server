import { prismaMock } from '@tests/__helpers__/setup'
import * as passIntegrations from '@/services/aggregators/passIntegrations.service'
import { normalizePlans } from '@/services/aggregators/passIntegrations.service'
import { main, parsePlanPairs } from '../../../scripts/aggregators/connect-totalpass'

describe('connect-totalpass — validación de argumentos', () => {
  // nuevo
  it('acepta pares <productId>=<planId> con planId numérico', () => {
    expect(parsePlanPairs(['prod_a=12', 'prod_b=7'])).toEqual([
      { productId: 'prod_a', planId: '12' },
      { productId: 'prod_b', planId: '7' },
    ])
  })

  // nuevo
  it.each([['prod_a'], ['prod_a=abc'], ['=12'], ['prod_a=12=3'], ['prod_a=-1']])('rechaza «%s»', arg => {
    expect(() => parsePlanPairs([arg])).toThrow(/no es un par válido/)
  })

  // nuevo
  it('rechaza un producto repetido y la lista vacía', () => {
    expect(() => parsePlanPairs(['p=1', 'p=2'])).toThrow(/repetido/)
    expect(() => parsePlanPairs([])).toThrow(/Falta al menos un par/)
  })
})

describe('connect-totalpass — planes', () => {
  // nuevo
  it('de los planes sólo conserva id (como texto), nombre y código', () => {
    expect(normalizePlans([{ id: 3, name: 'Gold', code: 'ABCD1234', placeApiKey: 'x' }, { name: 'sin id' }, null])).toEqual([
      { id: '3', name: 'Gold', code: 'ABCD1234' },
    ])
    expect(normalizePlans(undefined)).toEqual([])
  })
})

describe('connect-totalpass — consumidor del servicio', () => {
  let logSpy: jest.SpyInstance
  beforeAll(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined)
  })
  afterAll(() => logSpy.mockRestore())
  afterEach(() => jest.restoreAllMocks())

  // nuevo — el script ya no habla con TotalPass: conecta y liga por el mismo servicio que el dashboard
  it('conecta con la llave y liga cada <productId>=<planId> como plan externo, sin imprimir URLs', async () => {
    prismaMock.venue.findUnique.mockResolvedValueOnce({ id: 'vB', name: 'Estudio B' })
    const view = { externalPlaceName: 'Estudio Prueba', plans: [{ id: '305', name: 'TP1', code: 'B0KR5QWH' }], productLinks: [] }
    const connect = jest.spyOn(passIntegrations, 'connectTotalPass').mockResolvedValue(view as any)
    const link = jest.spyOn(passIntegrations, 'setPassProductLinks').mockResolvedValue({
      ...view,
      productLinks: [{ productId: 'p1', productName: 'Yoga', externalPlanId: '305', externalPlanName: 'TP1' }],
    } as any)
    await main(['vB', 'p1=305'], 'llave-de-B')
    expect(connect).toHaveBeenCalledWith('vB', 'llave-de-B', null)
    expect(link).toHaveBeenCalledWith('vB', 'TOTALPASS', [{ productId: 'p1', externalPlanId: '305' }], null)
    expect(JSON.stringify(logSpy.mock.calls)).not.toMatch(/https?:|llave-de-B/)
  })

  // nuevo
  it('venue inexistente ⇒ se detiene antes de conectar', async () => {
    prismaMock.venue.findUnique.mockResolvedValueOnce(null)
    const connect = jest.spyOn(passIntegrations, 'connectTotalPass')
    await expect(main(['vX', 'p1=305'], 'llave')).rejects.toThrow(/No existe el venue vX/)
    expect(connect).not.toHaveBeenCalled()
  })
})
