/**
 * Tests for the external bank provider (QPay) API service — picks one
 * negocio's balance out of the broker account's full `negocios[]` list.
 *
 * The auth service is mocked entirely here: these tests are about the
 * negocio-matching/shape logic and the cache/401-retry behavior, not login.
 */
import nock from 'nock'

const TEST_BASE = 'https://external-bank-test.example.com'

const authHeaders = jest.fn().mockResolvedValue({ mgPlatform: 'MERCHANT', Authorization: 'Bearer fake-token' })
const invalidate = jest.fn()

jest.mock('@/services/externalBank/externalBankAuth.service', () => ({
  externalBankAuthService: {
    get baseURL() {
      return TEST_BASE
    },
    authHeaders: (...args: unknown[]) => authHeaders(...args),
    invalidate: (...args: unknown[]) => invalidate(...args),
  },
}))

import { externalBankApiService, ExternalBankApiService } from '@/services/externalBank/externalBankApi.service'
import { NotFoundError } from '@/errors/AppError'

const NEGOCIOS_FIXTURE = {
  idMoneyGiver: 'mg-broker',
  negocios: [
    {
      idNegocio: 'neg-1',
      nombre: 'Sucursal Centro',
      cuentaDispersion: { cuentaClabe: '012345678901234567', saldo: 1500.5, activo: true },
    },
    {
      idNegocio: 'neg-2',
      nombre: 'Sucursal Norte',
      cuentaDispersion: { cuentaClabe: '098765432109876543', saldo: 0, activo: false },
    },
  ],
}

beforeAll(() => {
  nock.disableNetConnect()
})
afterAll(() => {
  nock.cleanAll()
  nock.enableNetConnect()
})
afterEach(() => {
  nock.cleanAll()
  authHeaders.mockClear()
  invalidate.mockClear()
})

describe('ExternalBankApiService.getBalanceByIdNegocio', () => {
  it('finds the matching negocio and maps saldo/cuentaClabe/activo', async () => {
    nock(TEST_BASE).get('/api/auth').reply(200, NEGOCIOS_FIXTURE)
    const service = new ExternalBankApiService()

    const balance = await service.getBalanceByIdNegocio('neg-1')

    expect(balance).toMatchObject({
      idNegocio: 'neg-1',
      nombre: 'Sucursal Centro',
      cuentaClabe: '012345678901234567',
      saldo: 1500.5,
      activo: true,
    })
    expect(typeof balance.fetchedAt).toBe('string')
  })

  // QPay mixes casing across endpoints — defend the negocios[] parse too,
  // not just sign-in.
  it('finds the matching negocio when the response is PascalCase', async () => {
    nock(TEST_BASE)
      .get('/api/auth')
      .reply(200, {
        Negocios: [
          {
            IdNegocio: 'neg-1',
            Nombre: 'Sucursal Centro',
            CuentaDispersion: { CuentaClabe: '012345678901234567', Saldo: 1500.5, Activo: true },
          },
        ],
      })
    const service = new ExternalBankApiService()

    const balance = await service.getBalanceByIdNegocio('neg-1')

    expect(balance).toMatchObject({
      idNegocio: 'neg-1',
      nombre: 'Sucursal Centro',
      cuentaClabe: '012345678901234567',
      saldo: 1500.5,
      activo: true,
    })
  })

  it('maps a zero/false balance correctly (not treated as missing)', async () => {
    nock(TEST_BASE).get('/api/auth').reply(200, NEGOCIOS_FIXTURE)
    const service = new ExternalBankApiService()

    const balance = await service.getBalanceByIdNegocio('neg-2')

    expect(balance.saldo).toBe(0)
    expect(balance.activo).toBe(false)
  })

  it("throws NotFoundError when the idNegocio is not in the broker account's negocios[]", async () => {
    nock(TEST_BASE).get('/api/auth').reply(200, NEGOCIOS_FIXTURE)
    const service = new ExternalBankApiService()

    await expect(service.getBalanceByIdNegocio('neg-does-not-exist')).rejects.toThrow(NotFoundError)
  })

  it('caches getMe() — two balance lookups within the TTL make one HTTP call', async () => {
    const scope = nock(TEST_BASE).get('/api/auth').once().reply(200, NEGOCIOS_FIXTURE)
    const service = new ExternalBankApiService()

    await service.getBalanceByIdNegocio('neg-1')
    await service.getBalanceByIdNegocio('neg-2')

    expect(scope.isDone()).toBe(true)
  })

  it('forceRefresh bypasses the cache', async () => {
    nock(TEST_BASE).get('/api/auth').twice().reply(200, NEGOCIOS_FIXTURE)
    const service = new ExternalBankApiService()

    await service.getBalanceByIdNegocio('neg-1')
    await service.getBalanceByIdNegocio('neg-1', { forceRefresh: true })

    expect(nock.pendingMocks()).toHaveLength(0)
  })

  it('on 401, invalidates the auth cache and retries once', async () => {
    nock(TEST_BASE).get('/api/auth').reply(401, { message: 'expired' })
    nock(TEST_BASE).get('/api/auth').reply(200, NEGOCIOS_FIXTURE)
    const service = new ExternalBankApiService()

    const balance = await service.getBalanceByIdNegocio('neg-1')

    expect(balance.idNegocio).toBe('neg-1')
    expect(invalidate).toHaveBeenCalledTimes(1)
  })
})

describe('singleton export', () => {
  it('is an instance of ExternalBankApiService', () => {
    expect(externalBankApiService).toBeInstanceOf(ExternalBankApiService)
  })
})
