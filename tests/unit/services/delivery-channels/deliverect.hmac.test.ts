import crypto from 'crypto'
import {
  verifyDeliverectHmac,
  DELIVERECT_HMAC_HEADER,
} from '../../../../src/services/delivery-channels/providers/deliverect/deliverect.hmac'

describe('verifyDeliverectHmac', () => {
  const secret = 'test-secret'
  const body = Buffer.from(JSON.stringify({ channelOrderId: 'abc123' }))
  // Doc: https://developers.deliverect.com/reference/hmac-authentication — hex, NOT base64.
  const validSig = crypto.createHmac('sha256', secret).update(body).digest('hex')

  it('acepta firma válida (hex, spec §10.1.1)', () => {
    expect(verifyDeliverectHmac(body, validSig, secret)).toBe(true)
  })

  it('rechaza firma inválida', () => {
    expect(verifyDeliverectHmac(body, 'aaaa' + validSig.slice(4), secret)).toBe(false)
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

  it('exporta el nombre del header documentado (spec §10.1.1: x-server-authorization-hmac-sha256)', () => {
    expect(DELIVERECT_HMAC_HEADER).toBe('x-server-authorization-hmac-sha256')
  })

  // ============================================================
  // FIX C1 (audit, spec §10.1.1): el código asumía header
  // `x-deliverect-hmac-sha256` + base64 — la doc real usa
  // `x-server-authorization-hmac-sha256` + hex. Con el valor viejo, TODO
  // webhook auténtico se rechazaba (401). timingSafeEqual no salva comparar
  // la representación equivocada.
  // ============================================================
  describe('encoding documentado (Fix C1)', () => {
    it('rechaza la firma correcta codificada en base64 (encoding viejo, ya no es el esperado)', () => {
      const base64Sig = crypto.createHmac('sha256', secret).update(body).digest('base64')
      expect(verifyDeliverectHmac(body, base64Sig, secret)).toBe(false)
    })

    it('el header exportado YA NO es el nombre viejo asumido por el scaffold', () => {
      expect(DELIVERECT_HMAC_HEADER).not.toBe('x-deliverect-hmac-sha256')
    })
  })
})
