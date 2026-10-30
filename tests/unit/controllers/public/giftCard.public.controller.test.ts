/**
 * 1b S6: el controller de la página pública del regalo. Responde `{ success: true, data }` sin caché y fuera de los
 * buscadores (S-11), también cuando falla, y no escribe el token en ningún log.
 */
import express from 'express'
import request from 'supertest'

const mockPagina = jest.fn()
jest.mock('@/services/giftCards/giftCardPublic.service', () => ({
  __esModule: true,
  getPaginaDelRegalo: (...args: unknown[]) => mockPagina(...args),
}))

import logger from '@/config/logger'
import { getPaginaDelRegalo } from '@/controllers/public/giftCard.public.controller'
import { GiftCardError } from '@/services/giftCards/giftCardErrors'

const TOKEN = 'Xk3pQ9vLmN2rT8wYz5aB7cD1eF4gH6jK0sU'

const app = express()
app.get('/gift-cards/:pageToken', getPaginaDelRegalo)
app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode ?? 500).json({ message: err.message, code: err.code }))

/** Todo lo que recibió el logger, como texto. */
const loQueSeLogueo = () =>
  (['info', 'warn', 'error', 'debug', 'log'] as const)
    .flatMap(m => ((logger as unknown as Record<string, jest.Mock>)[m]?.mock.calls ?? []).map(c => JSON.stringify(c)))
    .join('\n')

beforeEach(() => mockPagina.mockReset())

describe('getPaginaDelRegalo (controller)', () => {
  it('responde { success: true, data } con Cache-Control: no-store y X-Robots-Tag: noindex', async () => {
    const data = { disponible: true, codigo: 'K7QZ-ABCD-EFGH-JKMN-P', folio: 'JKMN' }
    mockPagina.mockResolvedValue(data)
    const res = await request(app).get(`/gift-cards/${TOKEN}`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true, data })
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers['x-robots-tag']).toBe('noindex')
    expect(mockPagina).toHaveBeenCalledWith(TOKEN)
  })

  it('{ disponible: false } también va con 200, sin caché ni índice', async () => {
    mockPagina.mockResolvedValue({ disponible: false })
    const res = await request(app).get('/gift-cards/abc')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true, data: { disponible: false } })
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers['x-robots-tag']).toBe('noindex')
  })

  it('un error va al manejador global, y también sale sin caché ni índice', async () => {
    mockPagina.mockRejectedValue(new GiftCardError('GIFT_CARD_KEYS_MISSING', 'Faltan las llaves.', 409))
    const res = await request(app).get(`/gift-cards/${TOKEN}`)
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('GIFT_CARD_KEYS_MISSING')
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers['x-robots-tag']).toBe('noindex')
  })

  it('🔴 ningún logger.* recibe el token, ni al responder ni al fallar', async () => {
    mockPagina.mockResolvedValue({ disponible: false })
    await request(app).get(`/gift-cards/${TOKEN}`)
    mockPagina.mockRejectedValue(new Error('se cayó la base'))
    await request(app).get(`/gift-cards/${TOKEN}`)
    expect(loQueSeLogueo()).not.toContain(TOKEN)
  })
})
