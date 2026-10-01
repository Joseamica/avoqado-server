/**
 * 🔴 Auditoría 2026-09-30: `/sdk/test-session` crea sesiones de checkout sin ninguna guardia. Es de la
 * herramienta de pruebas; en producción no debe existir, igual que el tablero de sesiones del SDK.
 */
jest.mock('@/controllers/sdk/tokenize.sdk.controller', () => ({ tokenizeCard: jest.fn(), chargeWithToken: jest.fn() }))

import express from 'express'
import request from 'supertest'
import { prismaMock } from '@tests/__helpers__/setup'
import tokenizeRoutes from '@/routes/sdk/tokenize.sdk.routes'

const ORIGINAL_ENV = process.env.NODE_ENV

function app() {
  const a = express()
  a.use(express.json())
  a.use('/sdk', tokenizeRoutes)
  return a
}

beforeEach(() => prismaMock.ecommerceMerchant.findFirst.mockReset().mockResolvedValue(null))
afterEach(() => {
  process.env.NODE_ENV = ORIGINAL_ENV
})

it('🔴 en producción la sesión de prueba no existe (404) y no toca la base', async () => {
  process.env.NODE_ENV = 'production'
  const res = await request(app()).post('/sdk/test-session').send({ amount: 10 })
  expect(res.status).toBe(404)
  expect(prismaMock.ecommerceMerchant.findFirst).not.toHaveBeenCalled()
})

it('fuera de producción sigue creando la sesión de prueba', async () => {
  process.env.NODE_ENV = 'test'
  prismaMock.ecommerceMerchant.findFirst.mockResolvedValue({ id: 'm-test' } as any)
  prismaMock.checkoutSession.create.mockReset().mockResolvedValue({ sessionId: 'cs_test_abc' } as any)

  const res = await request(app()).post('/sdk/test-session').send({ amount: 10 })

  expect(res.status).toBe(201)
  expect(res.body).toEqual({ success: true, sessionId: 'cs_test_abc' })
})
