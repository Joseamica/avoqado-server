/**
 * El barrido de comandas (spec 2026-09-27 §2): arma las ventas/rondas con marca de más de 30 s, se rinde a los
 * 15 min con una alerta 🚨, y un armado (o un rendirse) que truena no detiene a los demás.
 */
jest.mock('@/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }))
jest.mock('@/observability/jobContext', () => ({ scheduleJob: jest.fn(() => ({ start: jest.fn(), stop: jest.fn() })) }))

import logger from '@/config/logger'
import { KitchenTicketsReconciliationJob } from '@/jobs/kitchen-tickets-reconciliation.job'

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

it('a los 15 min se rinde: alerta 🚨 y limpia la marca sin armar, acotado al venue', async () => {
  const marca = hace(16 * 60_000)
  const { job, prisma, author } = armar([{ id: 'o1', venueId: 'v1', kitchenPendingAt: marca }])
  const r = await job.runNow()
  expect(author).not.toHaveBeenCalled()
  expect(prisma.order.updateMany).toHaveBeenCalledWith({
    where: { id: 'o1', venueId: 'v1', kitchenPendingAt: marca },
    data: { kitchenPendingAt: null },
  })
  expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('🚨 [KDS]'), expect.anything())
  expect(r.rendidas).toBe(1)
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
  prisma.order.updateMany.mockRejectedValueOnce(new Error('db down'))
  const r = await job.runNow()
  expect(author).toHaveBeenCalledTimes(1)
  expect(author).toHaveBeenCalledWith({ venueId: 'v1', orderId: 'o2', trigger: 'SWEEP' })
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
