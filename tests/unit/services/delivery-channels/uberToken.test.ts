import { getUberAppToken, _resetUberTokenCacheForTests } from '@/services/delivery-channels/providers/uber-eats/uber.token'

// Spec paso 2 [api]: expires_in=2592000 SEGUNDOS (30 días). [doc]: 100 tokens/hora,
// el 101º invalida el más viejo ⇒ cache single-flight obligatorio, renovación anticipada.
describe('uber.token', () => {
  beforeEach(() => _resetUberTokenCacheForTests())

  it('pide UNA vez y reusa el token mientras no expira', async () => {
    let calls = 0
    const deps = {
      fetchToken: async () => { calls++; return { access_token: `tok-${calls}`, expires_in: 2592000 } },
      now: () => 1_000_000,
    }
    expect(await getUberAppToken(deps)).toBe('tok-1')
    expect(await getUberAppToken(deps)).toBe('tok-1')
    expect(calls).toBe(1)
  })

  it('single-flight: N llamadas concurrentes ⇒ UNA sola petición', async () => {
    let calls = 0
    const deps = {
      fetchToken: async () => { calls++; await new Promise(r => setTimeout(r, 10)); return { access_token: 'tok', expires_in: 2592000 } },
    }
    const [a, b, c] = await Promise.all([getUberAppToken(deps), getUberAppToken(deps), getUberAppToken(deps)])
    expect(calls).toBe(1)
    expect(a).toBe('tok'); expect(b).toBe('tok'); expect(c).toBe('tok')
  })

  it('renueva ANTICIPADO: a 24h del vencimiento pide uno nuevo', async () => {
    let calls = 0
    let t = 1_000_000_000
    const deps = {
      fetchToken: async () => { calls++; return { access_token: `tok-${calls}`, expires_in: 2592000 } },
      now: () => t,
    }
    await getUberAppToken(deps)
    t += (2592000 - 23 * 3600) * 1000
    expect(await getUberAppToken(deps)).toBe('tok-2')
    expect(calls).toBe(2)
  })

  it('respuesta inválida del proveedor ⇒ rechaza y NO la cachea', async () => {
    let calls = 0
    const deps = { fetchToken: async () => { calls++; return { access_token: '', expires_in: 2592000 } } }
    await expect(getUberAppToken(deps)).rejects.toThrow('inválida')
    await expect(getUberAppToken(deps)).rejects.toThrow('inválida')
    expect(calls).toBe(2)
  })

  it('si la petición falla, la siguiente REINTENTA (no cachea el error)', async () => {
    let calls = 0
    const deps = {
      fetchToken: async () => { calls++; if (calls === 1) throw new Error('red'); return { access_token: 'tok-ok', expires_in: 2592000 } },
    }
    await expect(getUberAppToken(deps)).rejects.toThrow('red')
    expect(await getUberAppToken(deps)).toBe('tok-ok')
  })
})
