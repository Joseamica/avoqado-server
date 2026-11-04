import { ExportRunnerJob } from '@/jobs/export-runner.job'
import { getContext } from '@/observability/executionContext'

const cronFalso = () => ({ start: jest.fn(), stop: jest.fn() })

describe('ExportRunnerJob', () => {
  it('procesa uno a la vez hasta vaciar la fila', async () => {
    const ids = ['r1', 'r2']
    const procesados: string[] = []
    const job = new ExportRunnerJob({
      cron: cronFalso(),
      cronLimpieza: cronFalso(),
      servicio: {
        reclamarSiguiente: async () => (ids.length ? { runId: ids.shift()!, attempt: 1, venueId: 'v1' } : null),
        procesar: async (id: string, attempt: number) => {
          procesados.push(`${id}#${attempt}`)
        },
        barrerAvisos: async () => 0,
        expirarVencidos: async () => 0,
      } as any,
    })
    expect(await job.tick()).toBe(2)
    expect(procesados).toEqual(['r1#1', 'r2#1']) // con SU intento (Codex r1 #4)
  })
  it('🔴 con la fila siempre llena, el aviso pendiente sale en la PRIMERA vuelta: barre al empezar y tras cada pedido (Codex r2 B1)', async () => {
    const orden: string[] = []
    let quedan = 3
    const job = new ExportRunnerJob({
      cron: cronFalso(),
      cronLimpieza: cronFalso(),
      servicio: {
        reclamarSiguiente: async () => (quedan-- > 0 ? { runId: `r${3 - quedan}`, attempt: 1, venueId: 'v1' } : null),
        procesar: async (id: string) => {
          orden.push(id)
        },
        barrerAvisos: async () => {
          orden.push('barrer')
          return 1
        },
        expirarVencidos: async () => 0,
      } as any,
    })
    await job.tick()
    expect(orden).toEqual(['barrer', 'r1', 'barrer', 'r2', 'barrer', 'r3', 'barrer'])
  })
  it('cada vuelta barre la bandeja de avisos, también con la fila vacía; un error ahí no tumba el job (Codex r1 #6)', async () => {
    const barrer = jest.fn().mockResolvedValueOnce(2).mockRejectedValueOnce(new Error('db'))
    const job = new ExportRunnerJob({
      cron: cronFalso(),
      cronLimpieza: cronFalso(),
      servicio: {
        reclamarSiguiente: async () => null,
        procesar: async () => {},
        barrerAvisos: barrer,
        expirarVencidos: async () => 0,
      } as any,
    })
    await expect(job.tick()).resolves.toBe(0)
    await expect(job.tick()).resolves.toBe(0)
    expect(barrer).toHaveBeenCalledTimes(2)
  })
  it('candado demo, capa 3: cada pedido se procesa con SU negocio en el contexto', async () => {
    const vistos: Array<string | undefined> = []
    const cola = [
      { runId: 'r1', attempt: 1, venueId: 'v1' },
      { runId: 'r2', attempt: 1, venueId: 'v2' },
    ]
    const job = new ExportRunnerJob({
      cron: cronFalso(),
      cronLimpieza: cronFalso(),
      servicio: {
        reclamarSiguiente: async () => cola.shift() ?? null,
        procesar: async () => {
          vistos.push(getContext()?.venueId)
        },
        barrerAvisos: async () => 0,
        expirarVencidos: async () => 0,
      } as any,
    })
    await job.tick()
    expect(vistos).toEqual(['v1', 'v2'])
  })
  it('un tick no se encima con otro', async () => {
    let soltar!: () => void
    let avisarQueEmpezo!: () => void
    const empezo = new Promise<void>(r => {
      avisarQueEmpezo = r
    })
    const job = new ExportRunnerJob({
      cron: cronFalso(),
      cronLimpieza: cronFalso(),
      servicio: {
        reclamarSiguiente: jest.fn().mockResolvedValueOnce({ runId: 'r1', attempt: 1, venueId: 'v1' }).mockResolvedValue(null),
        procesar: () =>
          new Promise<void>(r => {
            soltar = r
            avisarQueEmpezo()
          }),
        barrerAvisos: async () => 0,
        expirarVencidos: async () => 0,
      } as any,
    })
    const primero = job.tick()
    await empezo // sin esto, `soltar` puede seguir sin asignar: prueba intermitente
    expect(await job.tick()).toBe(0)
    soltar()
    expect(await primero).toBe(1)
  })
  it('un error al reclamar no tumba el job', async () => {
    const job = new ExportRunnerJob({
      cron: cronFalso(),
      cronLimpieza: cronFalso(),
      servicio: {
        reclamarSiguiente: async () => {
          throw new Error('P2002')
        },
        procesar: async () => {},
        barrerAvisos: async () => 0,
        expirarVencidos: async () => 0,
      } as any,
    })
    await expect(job.tick()).resolves.toBe(0)
  })
})
