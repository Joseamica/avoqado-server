import { esperarTurno, esRutaDeCobro } from '@/services/exports/exportSemaforo'

function reloj() {
  let t = 0
  return {
    ahora: () => t,
    dormir: async (ms: number) => {
      t += ms
    },
  }
}

describe('exportSemaforo', () => {
  it('reconoce rutas de cobro', () => {
    expect(esRutaDeCobro('/api/v1/mobile/venues/x/terminal-payment')).toBe(true)
    expect(esRutaDeCobro('/api/v1/tpv/venues/x/orders/y')).toBe(true)
    expect(esRutaDeCobro('/api/v1/mobile/venues/x/orders')).toBe(true)
    expect(esRutaDeCobro('/api/v1/dashboard/venues/x/payments/p1/refund')).toBe(true)
    expect(esRutaDeCobro('/api/v1/dashboard/notifications')).toBe(false)
    expect(esRutaDeCobro('/api/v1/dashboard/venues/x/exports/run1/status')).toBe(false)
    expect(esRutaDeCobro('/api/v1/dashboard/venues/x/exports/cobros')).toBe(false)
  })
  it('sin presión no espera ni avisa', async () => {
    const r = reloj()
    const alEsperar = jest.fn()
    const res = await esperarTurno({ ...r, alEsperar, medir: async () => ({ cobrosEnVuelo: 0, retrasoMs: 2 }) })
    expect(res).toEqual({ esperoMs: 0, forzado: false })
    expect(alEsperar).not.toHaveBeenCalled()
  })
  it('con un cobro en vuelo espera hasta que termina y avisa una sola vez', async () => {
    const r = reloj()
    const alEsperar = jest.fn()
    const lecturas = [1, 1, 0]
    const res = await esperarTurno({ ...r, alEsperar, medir: async () => ({ cobrosEnVuelo: lecturas.shift() ?? 0, retrasoMs: 0 }) })
    expect(res).toEqual({ esperoMs: 500, forzado: false })
    expect(alEsperar).toHaveBeenCalledTimes(1)
  })
  it('con event loop lento también espera', async () => {
    const r = reloj()
    const lecturas = [120, 0]
    const res = await esperarTurno({ ...r, medir: async () => ({ cobrosEnVuelo: 0, retrasoMs: lecturas.shift() ?? 0 }) })
    expect(res.esperoMs).toBe(250)
  })
  it('nunca muere de hambre: tras 30 s avanza forzado', async () => {
    const r = reloj()
    const res = await esperarTurno({ ...r, medir: async () => ({ cobrosEnVuelo: 5, retrasoMs: 0 }) })
    expect(res.forzado).toBe(true)
    expect(res.esperoMs).toBeGreaterThanOrEqual(30_000)
  })
  it('un fallo de alEsperar no detiene el exporte', async () => {
    const r = reloj()
    const lecturas = [1, 0]
    const res = await esperarTurno({
      ...r,
      alEsperar: async () => {
        throw new Error('db')
      },
      medir: async () => ({ cobrosEnVuelo: lecturas.shift() ?? 0, retrasoMs: 0 }),
    })
    expect(res.forzado).toBe(false)
  })
})
