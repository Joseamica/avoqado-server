import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/services/online-ordering/presence.service', () => ({ __esModule: true, getAcceptingStatus: jest.fn() }))
jest.mock('@/services/online-ordering/cuentaConBeneficios', () => ({ __esModule: true, cuentaConBeneficios: jest.fn() }))

import { getInfo } from '@/controllers/public/onlineOrdering.public.controller'
import { getAcceptingStatus } from '@/services/online-ordering/presence.service'
import { cuentaConBeneficios } from '@/services/online-ordering/cuentaConBeneficios'

/** D16: `/info` dice si el negocio tiene algo de cuenta; la tienda esconde «Entrar» sólo con un `false` explícito. */
const res = () => {
  const r: any = {}
  r.status = jest.fn(() => r)
  r.json = jest.fn(() => r)
  return r
}
const call = async () => {
  const r = res()
  await getInfo({ publicVenue: { id: 'v1', slug: 'flautas' } } as any, r)
  return r.json.mock.calls[0][0]
}

beforeEach(() => {
  prismaMock.venue.findUnique.mockResolvedValue({ name: 'Flautas', timezone: 'America/Mexico_City' } as any)
  ;(getAcceptingStatus as jest.Mock).mockResolvedValue({
    status: 'OPEN',
    reason: null,
    config: {
      acceptsPayAtPickup: true,
      acceptsCardOnline: false,
      requiresAcceptance: false,
      minOrderAmount: 0,
      defaultPrepMinutes: 15,
      hours: null,
    },
  })
})

describe('GET /info cuentaConBeneficios (D16)', () => {
  it.each([true, false])('anuncia lo que decide la regla (%s), una sola vez y para ESTE negocio', async valor => {
    ;(cuentaConBeneficios as jest.Mock).mockResolvedValue(valor)
    const body = await call()
    expect(body.success).toBe(true)
    expect(body.data.cuentaConBeneficios).toBe(valor)
    expect(cuentaConBeneficios).toHaveBeenCalledTimes(1)
    expect(cuentaConBeneficios).toHaveBeenCalledWith('v1')
  })

  it('si la consulta falla, /info responde igual y SIN el campo (la tienda enseña «Entrar» como hoy)', async () => {
    ;(cuentaConBeneficios as jest.Mock).mockRejectedValue(new Error('se cayó la conexión'))
    const body = await call()
    expect(body.success).toBe(true)
    expect(body.data.status).toBe('OPEN')
    expect('cuentaConBeneficios' in body.data).toBe(false)
  })
})
