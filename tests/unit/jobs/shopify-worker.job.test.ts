import { ShopifyWorkerJob, type ShopifyWorkerDeps, type SucursalTomada } from '@/jobs/shopify-worker.job'

const INICIO = new Date('2030-01-01T00:10:00Z').getTime()
const sucursal = (id: string): SucursalTomada => ({
  id,
  venueId: `v-${id}`,
  generation: 1,
  status: 'ACTIVE',
  pausedFrom: null,
  workToken: `w-${id}`,
  webhooksAt: new Date(),
  requeuePending: false,
  applyRequestedAt: null,
  importError: null,
  importAttempts: 0,
  pendienteCuadre: true,
})
function base(over: Partial<ShopifyWorkerDeps> = {}): ShopifyWorkerDeps & { [k: string]: any } {
  return {
    now: () => new Date(INICIO),
    cron: { start: jest.fn(), stop: jest.fn() },
    entrada: jest.fn().mockResolvedValue(undefined),
    claimOutbox: jest.fn().mockResolvedValue({ kind: 'VACIO' }),
    runOutboxRow: jest.fn().mockResolvedValue('SENT'),
    claimEvent: jest.fn().mockResolvedValue({ kind: 'VACIO' }),
    processEvent: jest.fn().mockResolvedValue('PROCESSED'),
    tomarSucursal: jest.fn().mockResolvedValue(null),
    soltarSucursal: jest.fn().mockResolvedValue(undefined),
    unidad: jest.fn().mockResolvedValue({ ok: true }),
    seguirAvisos: jest.fn().mockResolvedValue(undefined),
    limpiar: jest.fn().mockResolvedValue(undefined),
    ...over,
  } as ShopifyWorkerDeps & { [k: string]: any }
}
const conCodigo = (code: string) => Object.assign(new Error(code), { code })

describe('ShopifyWorkerJob', () => {
  it('orden: entrada → buzón → eventos → sucursales → avisos (una unidad por reclamo, y se suelta)', async () => {
    const orden: string[] = []
    const d = base({
      entrada: jest.fn(async () => {
        orden.push('entrada')
      }),
      claimOutbox: jest.fn().mockResolvedValueOnce({ kind: 'FILA', id: 'o1', claimToken: 't' }).mockResolvedValue({ kind: 'VACIO' }),
      runOutboxRow: jest.fn(async () => {
        orden.push('buzon')
        return 'SENT' as const
      }),
      claimEvent: jest.fn().mockResolvedValueOnce({ kind: 'FILA', id: 'e1', claimToken: 'k' }).mockResolvedValue({ kind: 'VACIO' }),
      processEvent: jest.fn(async () => {
        orden.push('evento')
        return 'PROCESSED' as const
      }),
      tomarSucursal: jest.fn().mockResolvedValueOnce(sucursal('s1')).mockResolvedValue(null),
      unidad: jest.fn(async () => {
        orden.push('sucursal')
        return { ok: true }
      }),
      seguirAvisos: jest.fn(async () => {
        orden.push('avisos')
      }),
    })
    await new ShopifyWorkerJob(d).runOnce()
    expect(orden).toEqual(['entrada', 'buzon', 'evento', 'sucursal', 'avisos'])
    expect(d.soltarSucursal).toHaveBeenCalledWith('s1', 'w-s1', expect.any(Date), null, true)
    expect(d.seguirAvisos).toHaveBeenCalledWith(INICIO + 3_000) // R06: más que los 2 s que pide una petición
  })

  it('#12: una fila en cuarentena no detiene el buzón', async () => {
    const d = base({
      claimOutbox: jest
        .fn()
        .mockResolvedValueOnce({ kind: 'CUARENTENA', id: 'vieja' })
        .mockResolvedValueOnce({ kind: 'FILA', id: 'sana', claimToken: 't' })
        .mockResolvedValue({ kind: 'VACIO' }),
    })
    await new ShopifyWorkerJob(d).runOnce()
    expect(d.runOutboxRow).toHaveBeenCalledTimes(1)
    expect(d.runOutboxRow).toHaveBeenCalledWith('sana', 't', expect.any(Date), 7_000)
  })

  it('N12: varios eventos en cuarentena delante de uno sano no vacían la fase', async () => {
    const d = base({
      claimEvent: jest
        .fn()
        .mockResolvedValueOnce({ kind: 'CUARENTENA', id: 'a' })
        .mockResolvedValueOnce({ kind: 'CUARENTENA', id: 'b' })
        .mockResolvedValueOnce({ kind: 'FILA', id: 'sano', claimToken: 'k' })
        .mockResolvedValue({ kind: 'VACIO' }),
    })
    await new ShopifyWorkerJob(d).runOnce()
    expect(d.processEvent).toHaveBeenCalledTimes(1)
    expect(d.processEvent).toHaveBeenCalledWith('sano', 'k', INICIO + 5_000)
  })

  it('el buzón respeta su presupuesto y deja tiempo a las demás fases', async () => {
    let t = INICIO
    const d = base({
      now: () => new Date(t),
      claimOutbox: jest.fn(async () => ({ kind: 'FILA' as const, id: 'o', claimToken: 't' })),
      runOutboxRow: jest.fn(async () => {
        t += 4_000 // cada envío tarda 4 s
        return 'SENT' as const
      }),
      claimEvent: jest.fn().mockResolvedValueOnce({ kind: 'FILA', id: 'e1', claimToken: 'k' }).mockResolvedValue({ kind: 'VACIO' }),
    })
    await new ShopifyWorkerJob(d).runOnce()
    expect(d.runOutboxRow).toHaveBeenCalledTimes(2) // a los 0 y 4 s; a los 8 s ya se acabaron los 7 y no empieza otra
    expect((d.runOutboxRow as jest.Mock).mock.calls.map(c => c[3])).toEqual([7_000, 3_000]) // el corte = lo que queda
    expect(d.processEvent).toHaveBeenCalledWith('e1', 'k', INICIO + 8_000 + 5_000)
  })

  it('N17 (§11.6): cada unidad recibe el vencimiento absoluto de su fase; después del reclamo se recalcula y sin el mínimo no empieza', async () => {
    let t = INICIO
    const vences: number[] = []
    const d = base({
      now: () => new Date(t),
      tomarSucursal: jest.fn(async () => {
        t += 100 // el reclamo también cuesta
        return sucursal('s1')
      }),
      unidad: jest.fn(async (_s: SucursalTomada, vence: number) => {
        vences.push(vence)
        t += 2_900
        return { ok: true }
      }),
    })
    await new ShopifyWorkerJob(d).runOnce()
    expect(vences).toEqual([INICIO + 8_000, INICIO + 8_000]) // a los 6 s quedan 2 s; tras el reclamo, 1.9 s: se suelta sin unidad
    expect(d.soltarSucursal).toHaveBeenCalledTimes(3)
    expect((d.soltarSucursal as jest.Mock).mock.calls[2][3]).toBeNull()
  })

  it('R04: si la lectura de entrada falla, la vuelta no reclama nada; un reclamo que falla NO se reintenta y la vuelta sigue', async () => {
    const caida = base({ entrada: jest.fn().mockRejectedValue(conCodigo('P1001')) })
    await new ShopifyWorkerJob(caida).runOnce()
    expect(caida.claimOutbox).not.toHaveBeenCalled()
    expect(caida.claimEvent).not.toHaveBeenCalled()
    expect(caida.tomarSucursal).not.toHaveBeenCalled()

    const cortada = base({ claimOutbox: jest.fn().mockRejectedValue(conCodigo('P1008')) })
    await new ShopifyWorkerJob(cortada).runOnce()
    expect(cortada.claimOutbox).toHaveBeenCalledTimes(1) // un reclamo con efectos nunca se repite a ciegas
    expect(cortada.claimEvent).toHaveBeenCalled()
    expect(cortada.seguirAvisos).toHaveBeenCalled()
  })

  it('una vuelta a la vez en el mismo proceso: la que llega mientras corre otra no hace nada', async () => {
    let soltar!: () => void
    const d = base({
      claimOutbox: jest
        .fn()
        .mockImplementationOnce(() => new Promise(r => (soltar = () => r({ kind: 'VACIO' }))))
        .mockResolvedValue({ kind: 'VACIO' }),
    })
    const job = new ShopifyWorkerJob(d)
    const primera = job.runOnce()
    await job.runOnce()
    await new Promise(r => setImmediate(r))
    expect(d.entrada).toHaveBeenCalledTimes(1)
    expect(d.claimOutbox).toHaveBeenCalledTimes(1)
    soltar()
    await primera
    await job.runOnce()
    expect(d.entrada).toHaveBeenCalledTimes(2)
  })

  it('una unidad que truena suelta la sucursal con espera y el worker sigue con la siguiente', async () => {
    const d = base({
      tomarSucursal: jest.fn().mockResolvedValueOnce(sucursal('s1')).mockResolvedValueOnce(sucursal('s2')).mockResolvedValue(null),
      unidad: jest.fn().mockRejectedValueOnce(new Error('la base parpadeó')).mockResolvedValue({ ok: true }),
    })
    await new ShopifyWorkerJob(d).runOnce()
    expect(d.soltarSucursal).toHaveBeenNthCalledWith(1, 's1', 'w-s1', expect.any(Date), 60_000, true)
    expect(d.soltarSucursal).toHaveBeenNthCalledWith(2, 's2', 'w-s2', expect.any(Date), null, true)
  })
})

describe('ShopifyWorkerJob · requisitos del ledger para B8', () => {
  it('BR-5/S7: un evento que truena cuesta sólo ese evento; un reclamo de eventos que truena termina SU fase y la vuelta sigue', async () => {
    const d = base({
      claimEvent: jest
        .fn()
        .mockResolvedValueOnce({ kind: 'FILA', id: 'e1', claimToken: 'k1' })
        .mockResolvedValueOnce({ kind: 'FILA', id: 'e2', claimToken: 'k2' })
        .mockRejectedValueOnce(conCodigo('P2028'))
        .mockResolvedValue({ kind: 'FILA', id: 'nunca', claimToken: 'x' }),
      processEvent: jest.fn().mockRejectedValueOnce(conCodigo('40P01')).mockResolvedValue('FAILED'),
      tomarSucursal: jest.fn().mockResolvedValueOnce(sucursal('s1')).mockResolvedValue(null),
    })
    await new ShopifyWorkerJob(d).runOnce()
    expect((d.processEvent as jest.Mock).mock.calls.map(c => c[0])).toEqual(['e1', 'e2'])
    expect(d.claimEvent).toHaveBeenCalledTimes(3) // el que tronó no se repite
    expect(d.unidad).toHaveBeenCalledTimes(1)
    expect(d.seguirAvisos).toHaveBeenCalled()
  })

  it('una fila que truena cuesta sólo esa fila (la fase sigue con la siguiente)', async () => {
    const d = base({
      claimOutbox: jest
        .fn()
        .mockResolvedValueOnce({ kind: 'FILA', id: 'o1', claimToken: 't1' })
        .mockResolvedValueOnce({ kind: 'FILA', id: 'o2', claimToken: 't2' })
        .mockResolvedValue({ kind: 'VACIO' }),
      runOutboxRow: jest.fn().mockRejectedValueOnce(conCodigo('P2034')).mockResolvedValue('CONTEXTO_CAMBIO'),
    })
    await new ShopifyWorkerJob(d).runOnce()
    expect((d.runOutboxRow as jest.Mock).mock.calls.map(c => c[0])).toEqual(['o1', 'o2'])
    expect(d.claimEvent).toHaveBeenCalled()
  })

  it('tomar una sucursal que truena termina la fase de sucursales; soltar que truena no detiene la vuelta', async () => {
    const tomarCae = base({ tomarSucursal: jest.fn().mockRejectedValue(conCodigo('P2024')) })
    await new ShopifyWorkerJob(tomarCae).runOnce()
    expect(tomarCae.tomarSucursal).toHaveBeenCalledTimes(1)
    expect(tomarCae.seguirAvisos).toHaveBeenCalled()

    const soltarCae = base({
      tomarSucursal: jest.fn().mockResolvedValueOnce(sucursal('s1')).mockResolvedValueOnce(sucursal('s2')).mockResolvedValue(null),
      soltarSucursal: jest.fn().mockRejectedValueOnce(conCodigo('P1017')).mockResolvedValue(undefined),
    })
    await new ShopifyWorkerJob(soltarCae).runOnce()
    expect(soltarCae.unidad).toHaveBeenCalledTimes(2)
    expect(soltarCae.seguirAvisos).toHaveBeenCalled()
  })

  it('U4: una sucursal sin avance o que falló no vuelve en la misma vuelta (no gira la fase); una que avanzó sí', async () => {
    const cola = [sucursal('quieta'), sucursal('rota'), sucursal('avanza')]
    const excluidas: string[][] = []
    const d = base({
      tomarSucursal: jest.fn(async (_now: Date, excluir: string[]) => {
        excluidas.push([...excluir]) // la lista en ESE momento
        return cola.shift() ?? null
      }),
      unidad: jest
        .fn()
        .mockResolvedValueOnce({ ok: true, sinAvance: true })
        .mockResolvedValueOnce({ ok: false, esperaMs: 120_000, sinAvance: true, motivo: 'HTTP_5XX' })
        .mockResolvedValue({ ok: true }),
    })
    await new ShopifyWorkerJob(d).runOnce()
    expect(excluidas).toEqual([[], ['quieta'], ['quieta', 'rota'], ['quieta', 'rota']])
    expect((d.soltarSucursal as jest.Mock).mock.calls.map(c => [c[0], c[3]])).toEqual([
      ['quieta', null],
      ['rota', 120_000], // R2: la espera de la unidad va a nextWorkAt
      ['avanza', null],
    ])
  })

  it('U4: el retraso se revisa sólo en la PRIMERA unidad de cada sucursal en la vuelta', async () => {
    const cola = [sucursal('s1'), sucursal('s1'), sucursal('s2'), sucursal('s1')]
    const d = base({ tomarSucursal: jest.fn(async () => cola.shift() ?? null) })
    await new ShopifyWorkerJob(d).runOnce()
    expect((d.unidad as jest.Mock).mock.calls.map(c => [c[0].id, c[2]])).toEqual([
      ['s1', true],
      ['s1', false],
      ['s2', true],
      ['s1', false],
    ])
    // La vuelta siguiente del MISMO job la vuelve a revisar.
    const dos = base({
      tomarSucursal: jest
        .fn()
        .mockResolvedValueOnce(sucursal('s1'))
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(sucursal('s1'))
        .mockResolvedValue(null),
    })
    const job = new ShopifyWorkerJob(dos)
    await job.runOnce()
    await job.runOnce()
    expect((dos.unidad as jest.Mock).mock.calls.map(c => c[2])).toEqual([true, true])
  })

  it('N18: una sucursal que no alcanzó a empezar se suelta SIN turno (conserva su lugar); las demás, con turno', async () => {
    let t = INICIO
    const d = base({
      now: () => new Date(t),
      tomarSucursal: jest
        .fn()
        .mockResolvedValueOnce(sucursal('corta'))
        .mockResolvedValueOnce(sucursal('sigue'))
        .mockImplementationOnce(async () => {
          t += 6_000 // el reclamo se come el margen: quedan 1.9 s
          return sucursal('tarde')
        })
        .mockResolvedValue(null),
      unidad: jest
        .fn()
        .mockResolvedValueOnce({ ok: true, sinAvance: true, sinTurno: true })
        .mockImplementationOnce(async () => {
          t += 100
          return { ok: true }
        }),
    })
    await new ShopifyWorkerJob(d).runOnce()
    expect((d.soltarSucursal as jest.Mock).mock.calls.map(c => [c[0], c[4]])).toEqual([
      ['corta', false],
      ['sigue', true],
      ['tarde', false],
    ])
  })

  it('K19: la limpieza se decide con la hora de ARRANQUE de la vuelta, aunque las fases la empujen pasado el segundo 30', async () => {
    let t = new Date('2030-01-01T00:07:21Z').getTime()
    const d = base({
      now: () => new Date(t),
      claimOutbox: jest.fn(async () => {
        t += 20_000 // el buzón y lo demás se llevan la vuelta: ya es 00:07:41
        return { kind: 'VACIO' as const }
      }),
    })
    await new ShopifyWorkerJob(d).runOnce()
    expect(d.limpiar).toHaveBeenCalledTimes(1)

    t = new Date('2030-01-01T00:07:51Z').getTime() // la segunda vuelta del minuto 7: no
    const otra = base({ now: () => new Date(t) })
    await new ShopifyWorkerJob(otra).runOnce()
    expect(otra.limpiar).not.toHaveBeenCalled()
  })
})
