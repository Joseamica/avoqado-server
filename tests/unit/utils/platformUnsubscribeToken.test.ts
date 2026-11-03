/**
 * La liga de baja de los correos de Avoqado: una firma sin estado, atada a UN correo. No expira (las ligas de los correos
 * viejos tienen que seguir sirviendo) y nada de lo demás (la baja de un cliente, la de un staff) abre este camino.
 */
import crypto from 'crypto'
import { signCustomerUnsubscribeToken } from '@/utils/customerActionToken'
import { platformUnsubscribeUrl, signPlatformUnsubscribeToken, verifyPlatformUnsubscribeToken } from '@/utils/platformUnsubscribeToken'
import { signUnsubscribeToken } from '@/utils/unsubscribeToken'

describe('signPlatformUnsubscribeToken / verifyPlatformUnsubscribeToken', () => {
  it('un token firmado se verifica y devuelve el correo', () => {
    const token = signPlatformUnsubscribeToken('ana@example.com')
    expect(verifyPlatformUnsubscribeToken(token)).toEqual({ email: 'ana@example.com' })
  })

  it('el correo se firma normalizado: mayúsculas y espacios no cambian a quién da de baja', () => {
    expect(verifyPlatformUnsubscribeToken(signPlatformUnsubscribeToken('  Ana@Example.COM '))).toEqual({ email: 'ana@example.com' })
  })

  it('un token alterado (cuerpo o firma) da null', () => {
    const token = signPlatformUnsubscribeToken('ana@example.com')
    const [body, sig] = token.split('.')

    const otro = Buffer.from(JSON.stringify({ v: 1, p: 'plat-unsub', em: 'victima@example.com' })).toString('base64url')
    expect(verifyPlatformUnsubscribeToken(`${otro}.${sig}`)).toBeNull()
    expect(verifyPlatformUnsubscribeToken(`${body}.${sig.slice(0, -2)}AA`)).toBeNull()
    expect(verifyPlatformUnsubscribeToken(`${body}.`)).toBeNull()
    expect(verifyPlatformUnsubscribeToken(`.${sig}`)).toBeNull()
  })

  it('basura, vacío y lo que no es texto dan null sin lanzar', () => {
    for (const malo of [undefined, null, '', 'x', 'a.b', 'a.b.c', '....', 42, ['a.b'], { token: 'x' }]) {
      expect(verifyPlatformUnsubscribeToken(malo as never)).toBeNull()
    }
  })

  it('🔴 una firma válida sobre otro propósito no abre este camino (llave y propósito separados)', () => {
    // Un token de baja de CLIENTE y uno de baja de STAFF, ambos bien firmados por el servidor, no valen aquí.
    expect(verifyPlatformUnsubscribeToken(signCustomerUnsubscribeToken({ customerId: 'c1', venueId: 'v1' }))).toBeNull()
    expect(verifyPlatformUnsubscribeToken(signUnsubscribeToken({ staffId: 's1', venueId: 'v1', category: 'INVENTORY' }))).toBeNull()

    // Y con la llave de ESTE camino pero un propósito distinto, tampoco.
    const llave = crypto.createHmac('sha256', 'test-access-token-secret').update('avoqado-platform-unsub-v1').digest()
    const cuerpo = Buffer.from(JSON.stringify({ v: 1, p: 'cust-unsub', em: 'ana@example.com' })).toString('base64url')
    const firma = crypto.createHmac('sha256', llave).update(cuerpo).digest('base64url')
    expect(verifyPlatformUnsubscribeToken(`${cuerpo}.${firma}`)).toBeNull()
  })

  it('una firma correcta sobre un cuerpo sin correo, o con un correo que no es texto, da null', () => {
    const llave = crypto.createHmac('sha256', 'test-access-token-secret').update('avoqado-platform-unsub-v1').digest()
    const firmar = (payload: unknown) => {
      const cuerpo = Buffer.from(JSON.stringify(payload)).toString('base64url')
      return `${cuerpo}.${crypto.createHmac('sha256', llave).update(cuerpo).digest('base64url')}`
    }
    expect(verifyPlatformUnsubscribeToken(firmar({ v: 1, p: 'plat-unsub' }))).toBeNull()
    expect(verifyPlatformUnsubscribeToken(firmar({ v: 1, p: 'plat-unsub', em: 42 }))).toBeNull()
    expect(verifyPlatformUnsubscribeToken(firmar({ v: 1, p: 'plat-unsub', em: '' }))).toBeNull()
    expect(verifyPlatformUnsubscribeToken(firmar({ v: 2, p: 'plat-unsub', em: 'ana@example.com' }))).toBeNull()
  })

  it('no expira: lo firmado hace años sigue valiendo', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01'))
    const token = signPlatformUnsubscribeToken('ana@example.com')
    jest.setSystemTime(new Date('2031-01-01'))
    expect(verifyPlatformUnsubscribeToken(token)).toEqual({ email: 'ana@example.com' })
    jest.useRealTimers()
  })
})

describe('platformUnsubscribeUrl', () => {
  it('apunta a la página pública de baja de Avoqado con el token que verifica', () => {
    const url = new URL(platformUnsubscribeUrl('Ana@example.com'))
    expect(url.pathname).toBe('/api/v1/public/avoqado/unsubscribe')
    expect(verifyPlatformUnsubscribeToken(url.searchParams.get('token'))).toEqual({ email: 'ana@example.com' })
  })
})
