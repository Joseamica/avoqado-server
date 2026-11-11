/**
 * El barrido de comandas (spec 2026-09-27 §2): arma las ventas/rondas con marca de más de 30 s; a los 15 min hace un
 * último intento y, si truena, se rinde con una alerta 🚨 (hz:ce654971:D5); un armado (o un rendirse) que truena no
 * detiene a los demás.
 */
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/observability/jobContext', () => ({ scheduleJob: jest.fn(() => ({ start: jest.fn(), stop: jest.fn() })) }))

import logger from '@/config/logger'
import { KitchenTicketsReconciliationJob } from '@/jobs/kitchen-tickets-reconciliation.job'
import { scheduleJob } from '@/observability/jobContext'

const NOW = new Date('2026-09-27T12:00:00Z')
const hace = (ms: number) => new Date(NOW.getTime() - ms)

function armar(pendientes: Array<{ id: string; venueId: string; kitchenPendingAt: Date }>) {
  const prisma = { order: { findMany: jest.fn().mockResolvedValue(pendientes), updateMany: jest.fn().mockResolvedValue({ count: 1 }) } }
  const author = jest.fn().mockResolvedValue({ ticketIds: ['k1'] })
  const job = new KitchenTicketsReconciliationJob({
    prisma: prisma as any,
    cron: { start: jest.fn(), stop: jest.fn() },
    now: () => NOW,
    author: author as any,
  })
  return { job, prisma, author }
}

beforeEach(() => jest.clearAllMocks())

it('pide sólo marcas de más de 30 s, acotadas, y arma cada una', async () => {
  const { job, prisma, author } = armar([{ id: 'o1', venueId: 'v1', kitchenPendingAt: hace(60_000) }])
  const r = await job.runNow()
  expect(prisma.order.findMany).toHaveBeenCalledWith(
    expect.objectContaining({ where: { kitchenPendingAt: { not: null, lt: hace(30_000) } }, take: 50 }),
  )
  expect(author).toHaveBeenCalledWith({ venueId: 'v1', orderId: 'o1', trigger: 'SWEEP' })
  expect(r).toEqual(expect.objectContaining({ scanned: 1, armadas: 1 }))
})

// hz:ce654971:D5 (Codex r4 B11): a los 15 min se rendía SIN llamar al autor. Tras una caída de 16 min, una cuenta con su pieza
// todavía elegible (el autor decide con su ventana de 12 h) se abandonaba sin un solo intento. Ahora hace un ÚLTIMO intento.
it('🔴 a los 15 min hace un último intento: si arma, cuenta como armada y no hay alerta', async () => {
  const marca = hace(16 * 60_000)
  const { job, prisma, author } = armar([{ id: 'o1', venueId: 'v1', kitchenPendingAt: marca }])
  const r = await job.runNow()
  expect(author).toHaveBeenCalledWith({ venueId: 'v1', orderId: 'o1', trigger: 'SWEEP' })
  // Esa misma marca vieja se limpia pase lo que pase (acotada al venue y a su valor): una marca que el autor no limpió no se
  // reintenta cada minuto para siempre, y la de una ronda nueva (otro valor) se conserva.
  expect(prisma.order.updateMany).toHaveBeenCalledWith({
    where: { id: 'o1', venueId: 'v1', kitchenPendingAt: marca },
    data: { kitchenPendingAt: null },
  })
  expect(logger.error).not.toHaveBeenCalledWith(expect.stringContaining('🚨 [KDS]'), expect.anything())
  expect(r).toEqual(expect.objectContaining({ armadas: 1, rendidas: 0 }))
})

it('a los 15 min, si el último intento truena, se rinde: alerta 🚨 y limpia la marca, acotado al venue', async () => {
  const marca = hace(16 * 60_000)
  const { job, prisma, author } = armar([{ id: 'o1', venueId: 'v1', kitchenPendingAt: marca }])
  author.mockRejectedValueOnce(new Error('lock timeout'))
  const r = await job.runNow()
  expect(author).toHaveBeenCalledTimes(1)
  expect(prisma.order.updateMany).toHaveBeenCalledWith({
    where: { id: 'o1', venueId: 'v1', kitchenPendingAt: marca },
    data: { kitchenPendingAt: null },
  })
  expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('🚨 [KDS]'), expect.anything())
  expect(r).toEqual(expect.objectContaining({ armadas: 0, rendidas: 1 }))
})

it('un armado que truena no detiene a los demás', async () => {
  const { job, author } = armar([
    { id: 'o1', venueId: 'v1', kitchenPendingAt: hace(60_000) },
    { id: 'o2', venueId: 'v1', kitchenPendingAt: hace(60_000) },
  ])
  author.mockRejectedValueOnce(new Error('lock timeout'))
  const r = await job.runNow()
  expect(author).toHaveBeenCalledTimes(2)
  expect(r).toEqual(expect.objectContaining({ armadas: 1, fallidas: 1 }))
})

it('un rendirse que truena tampoco detiene a los demás', async () => {
  const marca = hace(16 * 60_000)
  const { job, prisma, author } = armar([
    { id: 'o1', venueId: 'v1', kitchenPendingAt: marca },
    { id: 'o2', venueId: 'v1', kitchenPendingAt: hace(60_000) },
  ])
  author.mockRejectedValueOnce(new Error('lock timeout'))
  prisma.order.updateMany.mockRejectedValueOnce(new Error('db down'))
  const r = await job.runNow()
  expect(author).toHaveBeenCalledTimes(2)
  expect(author).toHaveBeenLastCalledWith({ venueId: 'v1', orderId: 'o2', trigger: 'SWEEP' })
  expect(r).toEqual(expect.objectContaining({ armadas: 1, fallidas: 1, rendidas: 0 }))
})

it('dos pasadas encimadas: la segunda no hace nada', async () => {
  const { job, prisma } = armar([])
  let soltar!: () => void
  prisma.order.findMany.mockReturnValueOnce(new Promise(r => (soltar = () => r([]))))
  const primera = job.runNow()
  expect(await job.runNow()).toEqual(expect.objectContaining({ skipped: 1 }))
  soltar()
  await primera
})

/**
 * El tick que recibe el cron. Devuelve su promesa para que el aviso de «hilo retenido» vea este barrido en
 * `jobsEnVuelo` mientras trabaja (tests/unit/observability/jobContextRegistro.test.ts); descartarla lo dejaba
 * invisible. La promesa es NUEVA en cada tick y nunca rechaza: así el envoltorio de jobs conserva el contrato de
 * errores (tests/unit/observability/contratoDeErroresDeJobs.test.ts).
 */
describe('el tick del cron', () => {
  const tickCon = (findMany: jest.Mock) => {
    new KitchenTicketsReconciliationJob({ prisma: { order: { findMany, updateMany: jest.fn() } } as any, now: () => NOW })
    return (scheduleJob as jest.Mock).mock.calls.at(-1)[2] as () => unknown
  }

  it('🔴 devuelve su promesa y sigue pendiente mientras el barrido trabaja', async () => {
    let soltar: (filas: unknown[]) => void = () => undefined
    const tick = tickCon(jest.fn(() => new Promise(res => (soltar = res))))

    const promesa = tick()
    expect(promesa).toBeInstanceOf(Promise)
    let termino = false
    void (promesa as Promise<void>).then(() => (termino = true))
    await new Promise(res => setImmediate(res))
    expect(termino).toBe(false)

    soltar([])
    await promesa
    expect(termino).toBe(true)
  })

  it('🔴 un barrido que truena queda en el log y la promesa del tick NO rechaza', async () => {
    const tick = tickCon(jest.fn().mockRejectedValue(new Error('la base no contestó')))

    await expect(tick()).resolves.toBeUndefined()
    expect(logger.error).toHaveBeenCalledWith(
      'Kitchen tickets reconciliation sweep failed',
      expect.objectContaining({ error: expect.any(Error) }),
    )
  })
})
