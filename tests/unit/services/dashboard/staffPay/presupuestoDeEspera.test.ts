/**
 * Fase 3 B9 (diseño r7.2, Codex r7 #19): UN presupuesto de espera de candados por transacción, compartido por todas sus
 * adquisiciones. Contra Postgres lo prueba `tests/integration/staffPay/participacion.test.ts` (4 s + 4 s + 3 s ⇒ 409 antes de
 * 10 s; dos sedes de 4 s ⇒ 409 a los ~6 s); aquí, la aritmética y el contrato de `tomarCandado`.
 */
import { Prisma } from '@prisma/client'
import { PresupuestoDeEspera, tomarCandado } from '@/utils/esperaDeCandados'

const txFalsa = () => {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ previo: '0' }]),
    $executeRawUnsafe: jest.fn().mockResolvedValue(0),
  }
  return tx as unknown as Prisma.TransactionClient & { $queryRaw: jest.Mock; $executeRawUnsafe: jest.Mock }
}
const vencido = () =>
  new Prisma.PrismaClientKnownRequestError('lock timeout', { code: 'P2010', clientVersion: '6', meta: { code: '55P03' } })

describe('PresupuestoDeEspera', () => {
  it('el tope sale del timeout real de la transacción: 6 s de 10 s y 30 s del cierre de 120 s', () => {
    expect(PresupuestoDeEspera.para(10_000).restanteMs()).toBe(6_000)
    expect(PresupuestoDeEspera.para(120_000).restanteMs()).toBe(30_000)
    expect(PresupuestoDeEspera.para(5_000).restanteMs()).toBe(3_000)
  })

  it('descuenta lo esperado y nunca baja de 0', () => {
    const p = new PresupuestoDeEspera(6_000)
    p.descontar(4_500)
    expect(p.restanteMs()).toBe(1_500)
    p.descontar(-10)
    expect(p.restanteMs()).toBe(1_500)
    p.descontar(9_000)
    expect(p.restanteMs()).toBe(0)
  })
})

/**
 * B9 ronda 1, F3 (ruling del controlador): el presupuesto también respeta el reloj de SU transacción.
 * `restanteMs = min(tope − esperado, timeout − transcurrido − 1 s)`: sigue midiendo la espera (no un plazo desde la
 * entrada), pero una espera nunca empuja la transacción más allá de su timeout (P2028).
 */
describe('el presupuesto respeta el reloj de su transacción (F3)', () => {
  let reloj = 0
  beforeEach(() => {
    reloj = 1_000_000
    jest.spyOn(Date, 'now').mockImplementation(() => reloj)
  })
  afterEach(() => jest.restoreAllMocks())

  it('un cierre que ya consumió 100 s de sus 120 ⇒ le quedan 19 s de espera aunque el presupuesto diga 30', async () => {
    const p = PresupuestoDeEspera.para(120_000)
    reloj += 100_000
    expect(p.restanteMs()).toBe(19_000)
    const tx = txFalsa()
    await tomarCandado(tx, async () => 'tomado', { presupuesto: p })
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(`SET LOCAL lock_timeout = '19000ms'`)
  })

  it('una transacción corta que ya consumió 9,5 s de sus 10 ⇒ 409 SIN intentar', async () => {
    const p = PresupuestoDeEspera.para(10_000)
    reloj += 9_500
    expect(p.restanteMs()).toBe(0)
    const tx = txFalsa()
    const tomar = jest.fn()
    await expect(tomarCandado(tx, tomar, { presupuesto: p })).rejects.toMatchObject({ statusCode: 409, code: 'OPERACION_EN_CURSO' })
    expect(tomar).not.toHaveBeenCalled()
    expect(tx.$executeRawUnsafe).not.toHaveBeenCalled()
  })

  it('con holgura en el reloj manda la espera: 4,5 s esperados a los 5 s de una tx de 10 ⇒ quedan 1,5 s', () => {
    const p = PresupuestoDeEspera.para(10_000)
    p.descontar(4_500)
    reloj += 5_000
    expect(p.restanteMs()).toBe(1_500)
  })

  it('un presupuesto creado sin timeout (pruebas, barreras) sólo mide la espera', () => {
    const p = new PresupuestoDeEspera(6_000)
    reloj += 3_600_000
    expect(p.restanteMs()).toBe(6_000)
  })
})

describe('tomarCandado({ presupuesto })', () => {
  it('pone lock_timeout = lo que queda, descuenta lo que tardó y restaura el valor previo', async () => {
    const tx = txFalsa()
    const p = new PresupuestoDeEspera(6_000)
    p.descontar(4_000)
    let reloj = 1_000_000
    const ahora = jest.spyOn(Date, 'now').mockImplementation(() => reloj)
    try {
      const r = await tomarCandado(
        tx,
        async () => {
          reloj += 1_200 // la adquisición tardó 1,2 s
          return 'tomado'
        },
        { presupuesto: p },
      )
      expect(r).toBe('tomado')
    } finally {
      ahora.mockRestore()
    }
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(`SET LOCAL lock_timeout = '2000ms'`)
    expect(p.restanteMs()).toBe(800)
    expect(JSON.stringify(tx.$queryRaw.mock.calls.at(-1))).toContain('set_config')
  })

  it('sin presupuesto contesta 409 SIN intentar (lock_timeout = 0 sería «sin tope»)', async () => {
    const tx = txFalsa()
    const tomar = jest.fn()
    const p = new PresupuestoDeEspera(6_000)
    p.descontar(6_000)
    await expect(tomarCandado(tx, tomar, { presupuesto: p })).rejects.toMatchObject({ statusCode: 409, code: 'OPERACION_EN_CURSO' })
    expect(tomar).not.toHaveBeenCalled()
    expect(tx.$executeRawUnsafe).not.toHaveBeenCalled()
  })

  it('55P03 ⇒ 409 con el código y el mensaje de ese candado; cualquier otro error pasa tal cual', async () => {
    const tx = txFalsa()
    const p = new PresupuestoDeEspera(6_000)
    await expect(
      tomarCandado(tx, () => Promise.reject(vencido()), { presupuesto: p, codigo: 'OPERACION_EN_CURSO', mensaje: 'Otra operación' }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'OPERACION_EN_CURSO', message: 'Otra operación' })
    const otro = new Error('se cayó la base')
    await expect(tomarCandado(tx, () => Promise.reject(otro), { presupuesto: p })).rejects.toBe(otro)
  })
})
