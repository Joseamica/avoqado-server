import crypto from 'crypto'
import {
  verifyDeliverectHmac,
  DELIVERECT_HMAC_HEADER,
} from '../../../../src/services/delivery-channels/providers/deliverect/deliverect.hmac'

describe('verifyDeliverectHmac', () => {
  const secret = 'test-secret'
  const body = Buffer.from(JSON.stringify({ channelOrderId: 'abc123' }))
  const validSig = crypto.createHmac('sha256', secret).update(body).digest('base64')

  it('acepta firma válida', () => {
    expect(verifyDeliverectHmac(body, validSig, secret)).toBe(true)
  })

  it('rechaza firma inválida', () => {
    expect(verifyDeliverectHmac(body, 'AAAA' + validSig.slice(4), secret)).toBe(false)
  })

  it('rechaza header ausente', () => {
    expect(verifyDeliverectHmac(body, undefined, secret)).toBe(false)
  })

  it('rechaza firma de otro body (replay con payload alterado)', () => {
    expect(verifyDeliverectHmac(Buffer.from('{"otro":1}'), validSig, secret)).toBe(false)
  })

  it('no truena con firma de longitud distinta (timingSafeEqual lanza si length difiere)', () => {
    expect(verifyDeliverectHmac(body, 'corta', secret)).toBe(false)
  })

  it('exporta el nombre del header', () => {
    expect(DELIVERECT_HMAC_HEADER).toBe('x-deliverect-hmac-sha256')
  })
})
