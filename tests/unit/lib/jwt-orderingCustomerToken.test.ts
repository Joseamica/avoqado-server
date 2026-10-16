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
    expect(() => verifyCustomerToken(generateOrderingCustomerToken('c1', 'v1', PHONE))).toThrow()
  })

  it('verifyOrderingCustomerToken rechaza el token de cliente general y uno de pedidos sin teléfono', () => {
    const general = generateCustomerToken('c1', 'v1')
    expect(verifyCustomerToken(general)).not.toHaveProperty('verifiedPhone') // el token general no cambia
    expect(() => verifyOrderingCustomerToken(general)).toThrow()
    const sinTelefono = jwt.sign({ sub: 'c1', venueId: 'v1', type: 'customer_ordering' }, process.env.ACCESS_TOKEN_SECRET!, {
      algorithm: 'HS256',
      expiresIn: 60,
    })
    expect(() => verifyOrderingCustomerToken(sinTelefono)).toThrow()
  })
})
