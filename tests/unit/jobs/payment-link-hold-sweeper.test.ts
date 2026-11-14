/**
 * Liga por prenda (Task 6): el barrido que suelta las fichas de apartado vencidas (15 min) y cierra su intento en Stripe.
 * La regla es la hora: la ficha se suelta aunque Stripe no conteste. El intento se cancela con la cuenta CONGELADA de la ficha y
 * sólo si sigue cancelable; uno cobrado nunca se cancela (su cierre normal lo vende).
 */
import path from 'node:path'
import fs from 'node:fs'
import logger from '@/config/logger'
import { PaymentLinkHoldSweeperJob } from '../../../src/jobs/payment-link-hold-sweeper.job'

const AHORA = new Date('2026-11-13T18:00:00Z')
const noopCron = { start: jest.fn(), stop: jest.fn() }

const fichas = { findMany: jest.fn(), updateManyAndReturn: jest.fn(), updateMany: jest.fn() }
const retrieve = jest.fn()
const cancel = jest.fn()

const soltada = (id: string, o: Record<string, unknown> = {}) => ({
  id,
  venueId: 'cvenue0000000000000000001',
  stripePaymentIntentId: `pi_${id}`,
  stripeAccountId: 'acct_CONGELADA',
  ...o,
})

const makeJob = () =>
  new PaymentLinkHoldSweeperJob({
    cron: noopCron as any,
    prisma: { paymentLinkStockHold: fichas } as any,
    now: () => AHORA,
    retryEntry: ((fn: () => Promise<unknown>) => fn()) as any,
    stripe: { paymentIntents: { retrieve, cancel } } as any,
  })

/** Las vencidas que lee la entrada; el CAS devuelve las que de verdad soltó. */
function vencidas(filas: ReturnType<typeof soltada>[]) {
  fichas.findMany.mockResolvedValue(filas.map(f => ({ id: f.id })))
  fichas.updateManyAndReturn.mockResolvedValue(filas)
}

beforeEach(() => {
  fichas.findMany.mockReset().mockResolvedValue([])
  fichas.updateManyAndReturn.mockReset().mockResolvedValue([])
  fichas.updateMany.mockReset().mockResolvedValue({ count: 1 })
  retrieve.mockReset()
  cancel.mockReset()
})

describe('PaymentLinkHoldSweeperJob.runNow', () => {
  it('lee las vencidas ACTIVE con tope de 100, ordenadas por vencimiento e id, con reintento de conexión', async () => {
    const retryEntry = jest.fn((fn: () => Promise<unknown>, _opciones?: unknown) => fn())
    const job = new PaymentLinkHoldSweeperJob({
      cron: noopCron as any,
      prisma: { paymentLinkStockHold: fichas } as any,
      now: () => AHORA,
      retryEntry: retryEntry as any,
      stripe: { paymentIntents: { retrieve, cancel } } as any,
    })
    await job.runNow()
    expect(fichas.findMany).toHaveBeenCalledWith({
      where: { status: 'ACTIVE', expiresAt: { lte: AHORA } },
      select: { id: true },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      take: 100,
    })
    expect(retryEntry.mock.calls[0][1]).toMatchObject({ context: 'payment-link-hold-sweeper.findExpired' })
    // Sin vencidas no escribe nada.
    expect(fichas.updateManyAndReturn).not.toHaveBeenCalled()
  })

  it('suelta con CAS (sólo las que siguen ACTIVE y vencidas) como «vencida»', async () => {
    vencidas([soltada('h1', { stripePaymentIntentId: null, stripeAccountId: null })])
    const r = await makeJob().runNow()
    expect(fichas.updateManyAndReturn).toHaveBeenCalledWith({
      where: { id: { in: ['h1'] }, status: 'ACTIVE', expiresAt: { lte: AHORA } },
      data: { status: 'RELEASED', releasedReason: 'vencida' },
      select: { id: true, venueId: true, stripePaymentIntentId: true, stripeAccountId: true },
    })
    // Sin intento: nada que hacer en Stripe.
    expect(retrieve).not.toHaveBeenCalled()
    expect(r).toMatchObject({ released: 1 })
  })

  it.each(['requires_payment_method', 'requires_confirmation', 'requires_action'])(
    'intento en %s → se cancela con la cuenta CONGELADA y, confirmado, queda «intento_cancelado»',
    async estado => {
      vencidas([soltada('h1')])
      retrieve.mockResolvedValue({ id: 'pi_h1', status: estado })
      cancel.mockResolvedValue({ id: 'pi_h1', status: 'canceled' })
      const r = await makeJob().runNow()
      expect(retrieve).toHaveBeenCalledWith('pi_h1', undefined, { stripeAccount: 'acct_CONGELADA' })
      expect(cancel).toHaveBeenCalledWith('pi_h1', undefined, { stripeAccount: 'acct_CONGELADA' })
      expect(fichas.updateMany).toHaveBeenCalledWith({
        where: { id: 'h1', status: 'RELEASED', releasedReason: 'vencida' },
        data: { releasedReason: 'intento_cancelado' },
      })
      expect(r).toMatchObject({ released: 1, canceled: 1, errors: 0 })
    },
  )

  it('intento ya cobrado (succeeded) → NO se cancela; queda «intento_cobrado» (su cierre normal lo vende)', async () => {
    vencidas([soltada('h1')])
    retrieve.mockResolvedValue({ id: 'pi_h1', status: 'succeeded' })
    await makeJob().runNow()
    expect(cancel).not.toHaveBeenCalled()
    expect(fichas.updateMany).toHaveBeenCalledWith({
      where: { id: 'h1', status: 'RELEASED', releasedReason: 'vencida' },
      data: { releasedReason: 'intento_cobrado' },
    })
  })

  it('intento en processing → ni se cancela ni se marca: se queda «vencida» para revisarse después', async () => {
    vencidas([soltada('h1')])
    retrieve.mockResolvedValue({ id: 'pi_h1', status: 'processing' })
    await makeJob().runNow()
    expect(cancel).not.toHaveBeenCalled()
    expect(fichas.updateMany).not.toHaveBeenCalled()
  })

  it('intento ya cancelado en Stripe → sólo se marca «intento_cancelado»', async () => {
    vencidas([soltada('h1')])
    retrieve.mockResolvedValue({ id: 'pi_h1', status: 'canceled' })
    await makeJob().runNow()
    expect(cancel).not.toHaveBeenCalled()
    expect(fichas.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { releasedReason: 'intento_cancelado' } }))
  })

  it('cancelar responde sin «canceled» (pasó a processing) → no se marca', async () => {
    vencidas([soltada('h1')])
    retrieve.mockResolvedValue({ id: 'pi_h1', status: 'requires_action' })
    cancel.mockResolvedValue({ id: 'pi_h1', status: 'processing' })
    await makeJob().runNow()
    expect(fichas.updateMany).not.toHaveBeenCalled()
  })

  it('Stripe caído → la ficha igual queda soltada (la regla es la hora), se registra el error y sigue con las demás', async () => {
    vencidas([soltada('h1'), soltada('h2')])
    retrieve
      .mockRejectedValueOnce(Object.assign(new Error('stripe caído'), { type: 'StripeConnectionError' }))
      .mockResolvedValueOnce({ id: 'pi_h2', status: 'requires_payment_method' })
    cancel.mockResolvedValue({ id: 'pi_h2', status: 'canceled' })
    const r = await makeJob().runNow()
    // Las dos se soltaron en el CAS antes de hablar con Stripe.
    expect(fichas.updateManyAndReturn).toHaveBeenCalledTimes(1)
    expect(r).toMatchObject({ released: 2, canceled: 1, errors: 1 })
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('PaymentLinkHoldSweeper'),
      expect.objectContaining({ holdId: 'h1', paymentIntentId: 'pi_h1' }),
    )
    expect(fichas.updateMany).toHaveBeenCalledTimes(1)
    expect(fichas.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'h2' }) }))
  })

  it('una ficha que otro proceso ya soltó o consumió entre la lectura y el CAS no se toca en Stripe', async () => {
    fichas.findMany.mockResolvedValue([{ id: 'h1' }, { id: 'h2' }])
    fichas.updateManyAndReturn.mockResolvedValue([soltada('h2')])
    retrieve.mockResolvedValue({ id: 'pi_h2', status: 'processing' })
    await makeJob().runNow()
    expect(retrieve).toHaveBeenCalledTimes(1)
    expect(retrieve).toHaveBeenCalledWith('pi_h2', undefined, expect.anything())
  })

  it('no se encima: una segunda pasada mientras corre la primera no hace nada', async () => {
    let soltar!: () => void
    fichas.findMany.mockReturnValueOnce(new Promise(res => (soltar = () => res([])))) as any
    const job = makeJob()
    const primera = job.runNow()
    await expect(job.runNow()).resolves.toMatchObject({ skipped: true })
    soltar()
    await primera
    expect(fichas.findMany).toHaveBeenCalledTimes(1)
  })
})

describe('registro del barrido', () => {
  it('corre cada minuto en un segundo propio', () => {
    const { DATABASE_JOB_SCHEDULES } = jest.requireActual('../../../src/jobs/jobSchedules')
    expect(DATABASE_JOB_SCHEDULES.paymentLinkHoldSweeper).toMatch(/^\d{1,2} \* \* \* \* \*$/)
    const segundo = DATABASE_JOB_SCHEDULES.paymentLinkHoldSweeper.split(' ')[0]
    const otros = Object.entries(DATABASE_JOB_SCHEDULES as Record<string, string>)
      .filter(([k]) => k !== 'paymentLinkHoldSweeper')
      .flatMap(([, v]) => v.split(' ')[0].split(','))
    expect(otros).not.toContain(segundo)
  })

  it('arranca y se detiene con el servidor', () => {
    const fuente = fs.readFileSync(path.join(__dirname, '../../../src/server.ts'), 'utf8')
    expect(fuente).toMatch(/paymentLinkHoldSweeperJob\.start\(\)/)
    expect(fuente).toMatch(/paymentLinkHoldSweeperJob\.stop\(\)/)
  })
})
