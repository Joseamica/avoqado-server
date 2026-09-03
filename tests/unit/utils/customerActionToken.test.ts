import {
  signCustomerUnsubscribeToken,
  verifyCustomerUnsubscribeToken,
  signBirthdateCaptureToken,
  verifyBirthdateCaptureToken,
} from '@/utils/customerActionToken'
import { signUnsubscribeToken } from '@/utils/unsubscribeToken'
import crypto from 'crypto'

it('firma y verifica ida y vuelta (baja)', () => {
  const t = signCustomerUnsubscribeToken({ customerId: 'cust1', venueId: 'venueA' })
  expect(verifyCustomerUnsubscribeToken(t)).toEqual({ customerId: 'cust1', venueId: 'venueA' })
})

it('🔴 un token de STAFF no abre el camino de customer (llaves separadas)', () => {
  const staffToken = signUnsubscribeToken({ staffId: 'cust1', venueId: 'venueA', category: 'INVENTORY' })
  expect(verifyCustomerUnsubscribeToken(staffToken)).toBeNull()
})

it('un token de baja no vale como token de captura (purpose separado)', () => {
  const t = signCustomerUnsubscribeToken({ customerId: 'cust1', venueId: 'venueA' })
  expect(verifyBirthdateCaptureToken(t)).toBeNull()
})

it('captura: expira a los 30 días y el hash coincide con sha256 del token', () => {
  const { token, tokenHash, expiresAt } = signBirthdateCaptureToken({ customerId: 'cust1', venueId: 'venueA' })
  expect(tokenHash).toBe(crypto.createHash('sha256').update(token).digest('hex'))
  expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 3600 * 1000)
  const v = verifyBirthdateCaptureToken(token)
  expect(v).toEqual(expect.objectContaining({ customerId: 'cust1', venueId: 'venueA', tokenHash }))
})

it('captura vencida no verifica', () => {
  jest.useFakeTimers().setSystemTime(new Date('2026-01-01'))
  const { token } = signBirthdateCaptureToken({ customerId: 'cust1', venueId: 'venueA' })
  jest.setSystemTime(new Date('2026-02-15'))
  expect(verifyBirthdateCaptureToken(token)).toBeNull()
  jest.useRealTimers()
})

it('token alterado no verifica', () => {
  const t = signCustomerUnsubscribeToken({ customerId: 'cust1', venueId: 'venueA' })
  expect(verifyCustomerUnsubscribeToken(t.slice(0, -2) + 'xx')).toBeNull()
})
