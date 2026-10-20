import jwt from 'jsonwebtoken'
import { generateCustomerToken, generateOrderingCustomerToken, verifyCustomerToken, verifyOrderingCustomerToken } from '@/jwt.service'

const PHONE = '+525543453965'

describe('token de PEDIDOS (H1): otro tipo de token, no el de cliente', () => {
  it('lleva type customer_ordering y el teléfono verificado, con la vigencia del token de cliente; su verificador lo acepta', () => {
    const p = verifyOrderingCustomerToken(generateOrderingCustomerToken('c1', 'v1', PHONE))
    expect(p).toMatchObject({ sub: 'c1', venueId: 'v1', type: 'customer_ordering', verifiedPhone: PHONE })
    expect(p.exp! - p.iat!).toBe(2_592_000) // 30 días
  })

  it('🔴 verifyCustomerToken lo RECHAZA: reservas, apartados, perfil y portal no aceptan el token de pedidos', () => {
    expect(() => verifyCustomerToken(generateOrderingCustomerToken('c1', 'v1', PHONE))).toThrow('Token de cliente inválido.')
  })

  it('verifyOrderingCustomerToken rechaza el token de cliente general y uno de pedidos sin teléfono', () => {
    const general = generateCustomerToken('c1', 'v1')
    expect(verifyCustomerToken(general)).not.toHaveProperty('verifiedPhone') // el token general no cambia
    expect(() => verifyOrderingCustomerToken(general)).toThrow('Token de pedidos inválido.')
    const sinTelefono = jwt.sign({ sub: 'c1', venueId: 'v1', type: 'customer_ordering' }, process.env.ACCESS_TOKEN_SECRET!, {
      algorithm: 'HS256',
      expiresIn: 60,
    })
    expect(() => verifyOrderingCustomerToken(sinTelefono)).toThrow('Token de pedidos inválido.')
  })

  // Firmados con el MISMO secreto y con todos los demás reclamos del token de pedidos: sólo el `type` los distingue.
  const firmar = (claims: object) => jwt.sign(claims, process.env.ACCESS_TOKEN_SECRET!, { algorithm: 'HS256', expiresIn: 60 })

  it('🔴 un token SIN type (como uno viejo o del personal) no pasa por token de pedidos', () => {
    expect(() => verifyOrderingCustomerToken(firmar({ sub: 'c1', venueId: 'v1', verifiedPhone: PHONE }))).toThrow(
      'Token de pedidos inválido.',
    )
  })

  it('🔴 un token de consumidor (type consumer) no pasa por token de pedidos', () => {
    expect(() => verifyOrderingCustomerToken(firmar({ sub: 'c1', venueId: 'v1', type: 'consumer', verifiedPhone: PHONE }))).toThrow(
      'Token de pedidos inválido.',
    )
  })
})
