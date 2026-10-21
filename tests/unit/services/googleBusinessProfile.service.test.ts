/**
 * Perfil de Empresa de Google: cada llamada va a la API que de verdad la atiende (verificado contra la
 * documentación de Google el 1-oct-2026). Hasta ese día el servicio preguntaba las cuentas a la API de
 * sucursales y las reseñas a la de cuentas, así que ningún negocio pudo conectarse nunca.
 *
 * - cuentas   → mybusinessaccountmanagement.googleapis.com/v1/accounts
 * - sucursales → mybusinessbusinessinformation.googleapis.com/v1/accounts/{a}/locations  (devuelve `locations/{l}`)
 * - reseñas   → mybusiness.googleapis.com/v4/accounts/{a}/locations/{l}/reviews       (starRating es ONE…FIVE)
 * - respuesta → PUT mybusiness.googleapis.com/v4/accounts/{a}/locations/{l}/reviews/{r}/reply
 */
const venueFindUnique = jest.fn()
jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: { venue: { findUnique: (...a: unknown[]) => venueFindUnique(...a), update: jest.fn() } },
}))

import { fetchReviews, listLocations, postReviewResponse } from '../../../src/services/googleBusinessProfile.service'

const fetchMock = jest.fn()
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

beforeAll(() => {
  process.env.GOOGLE_CLIENT_ID = 'client-id.apps.googleusercontent.com'
  process.env.GOOGLE_CLIENT_SECRET = 'secret'
  process.env.GOOGLE_BP_REDIRECT_URI = 'https://api.avoqado.test/callback'
  global.fetch = fetchMock as unknown as typeof fetch
})

beforeEach(() => {
  fetchMock.mockReset()
  venueFindUnique.mockReset()
  // Token vigente: getAuthenticatedClient no refresca y no toca la red.
  venueFindUnique.mockResolvedValue({
    googleAccessToken: 'tok',
    googleRefreshToken: 'refresh',
    googleTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    googleBusinessProfileConnected: true,
    googlePlaceId: 'accounts/1/locations/9',
  })
})

describe('listLocations', () => {
  it('🔴 pide las cuentas a la API de cuentas y guarda la ruta completa accounts/…/locations/…', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ accounts: [{ name: 'accounts/1' }] }))
      .mockResolvedValueOnce(ok({ locations: [{ name: 'locations/9', title: 'Testarudo', metadata: { placeId: 'ChIJ' } }] }))

    const locations = await listLocations('tok')

    expect(fetchMock.mock.calls[0][0]).toBe('https://mybusinessaccountmanagement.googleapis.com/v1/accounts')
    expect(fetchMock.mock.calls[1][0]).toMatch(/^https:\/\/mybusinessbusinessinformation\.googleapis\.com\/v1\/accounts\/1\/locations\?/)
    expect(locations).toEqual([{ name: 'accounts/1/locations/9', title: 'Testarudo', placeId: 'ChIJ' }])
  })

  it('🔴 si la primera cuenta (la personal) no tiene sucursales, busca en la siguiente', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ accounts: [{ name: 'accounts/personal' }, { name: 'accounts/grupo' }] }))
      .mockResolvedValueOnce(ok({}))
      .mockResolvedValueOnce(ok({ locations: [{ name: 'locations/7', title: 'Sucursal' }] }))

    const locations = await listLocations('tok')

    expect(locations.map(l => l.name)).toEqual(['accounts/grupo/locations/7'])
  })

  it('sin cuentas devuelve lista vacía (el callback avisa no_locations)', async () => {
    fetchMock.mockResolvedValueOnce(ok({}))
    expect(await listLocations('tok')).toEqual([])
  })

  it('un error de Google sale con el mensaje de Google y su código', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({ error: { message: 'API disabled' } }) })
    await expect(listLocations('tok')).rejects.toMatchObject({ message: 'Google API error: API disabled', statusCode: 403 })
  })
})

describe('fetchReviews', () => {
  it('🔴 lee las reseñas de la API v4, convierte ONE…FIVE en número y recorre todas las páginas', async () => {
    fetchMock
      .mockResolvedValueOnce(
        ok({
          reviews: [
            {
              name: 'accounts/1/locations/9/reviews/r1',
              reviewId: 'r1',
              reviewer: { displayName: 'Ana' },
              starRating: 'FOUR',
              comment: 'Bien',
              createTime: '2026-09-01T00:00:00Z',
              updateTime: '2026-09-01T00:00:00Z',
              reviewReply: { comment: 'Gracias', updateTime: '2026-09-02T00:00:00Z' },
            },
          ],
          nextPageToken: 'p2',
        }),
      )
      .mockResolvedValueOnce(ok({ reviews: [{ reviewId: 'r2', reviewer: {}, starRating: 'FIVE', createTime: 'x', updateTime: 'x' }] }))

    const { reviews } = await fetchReviews('venue-1')

    expect(fetchMock.mock.calls[0][0]).toBe('https://mybusiness.googleapis.com/v4/accounts/1/locations/9/reviews?pageSize=50')
    expect(fetchMock.mock.calls[1][0]).toBe('https://mybusiness.googleapis.com/v4/accounts/1/locations/9/reviews?pageSize=50&pageToken=p2')
    expect(reviews.map(r => [r.reviewId, r.starRating])).toEqual([
      ['r1', 4],
      ['r2', 5],
    ])
    expect(reviews[0].reviewReply).toEqual({ comment: 'Gracias', updateTime: '2026-09-02T00:00:00Z' })
    expect(reviews[1].reviewer.displayName).toBe('Anonymous')
  })

  it('sigue exigiendo que el negocio tenga sucursal guardada', async () => {
    venueFindUnique.mockResolvedValue({
      googleAccessToken: 'tok',
      googleRefreshToken: 'refresh',
      googleTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      googleBusinessProfileConnected: true,
      googlePlaceId: null,
    })
    await expect(fetchReviews('venue-1')).rejects.toMatchObject({ statusCode: 400 })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('postReviewResponse', () => {
  it('🔴 contesta con PUT a la API v4 de reseñas', async () => {
    fetchMock.mockResolvedValueOnce(ok({ comment: 'Gracias' }))

    await postReviewResponse('venue-1', 'r1', 'Gracias')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://mybusiness.googleapis.com/v4/accounts/1/locations/9/reviews/r1/reply')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body)).toEqual({ comment: 'Gracias' })
  })
})
