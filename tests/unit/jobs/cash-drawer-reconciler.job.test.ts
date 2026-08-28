/**
 * Fase 3 de la unificación de caja: NINGUNA venta en efectivo se queda sin anotar en el cajón.
 *
 * `postCashSaleToDrawer` corre DESPUÉS del commit del cobro y falla abierto: si el proceso muere
 * o la escritura truena, el Payment existe y el cajón no se entera — para siempre (auditoría
 * 27-ago, riesgo P0 #1). Este barrido repone lo que falte. No hay tabla nueva: el `Payment` ya es
 * la fuente de verdad y el `localId` (`srv-cash-sale:<paymentId>`) ya es determinista, así que
 * reponer es idempotente por construcción.
 *
 * Lo que estas pruebas protegen:
 *   1. 🔴 repone SÓLO ventas que ocurrieron DENTRO de una sesión de caja [openedAt, closedAt].
 *      Una venta hecha sin caja abierta NO se mete en la caja que se abra después: eso movería
 *      dinero histórico a un cierre ajeno y cambiaría un arqueo ya firmado.
 *   2. 🔴 barrer dos veces no duplica: el helper es idempotente (ALREADY_POSTED) y el barrido
 *      sólo cuenta como "repuesto" lo que de verdad creó.
 *   3. reembolsos en efectivo sin su PAY_OUT también se reponen.
 *   4. multi-tenant: la ventana se resuelve por venue, nunca cruza.
 *   5. lo que no se pudo reponer se REPORTA (log + ActivityLog sólo si hubo anomalía), no se esconde.
 */
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/observability/jobContext', () => ({ scheduleJob: jest.fn(() => ({ start: jest.fn(), stop: jest.fn() })) }))

import { logAction } from '@/services/dashboard/activity-log.service'
import { CashDrawerReconcilerJob } from '@/jobs/cash-drawer-reconciler.job'

const noopCron = { start: jest.fn(), stop: jest.fn() }
const t = (iso: string) => new Date(iso)

const pago = (over: Record<string, unknown> = {}) => ({
  id: 'pay-1',
  venueId: 'v1',
  orderId: 'o-1',
  status: 'COMPLETED',
  type: 'REGULAR',
  method: 'CASH',
  fundsFlow: 'CASH_DRAWER',
  tenderTypeId: null,
  tenderCountsAsCash: null,
  amount: 250,
  tipAmount: 0,
  processedById: 'staff-1',
  createdAt: t('2026-08-20T15:00:00Z'),
  ...over,
})
const sesion = (over: Record<string, unknown> = {}) => ({
  id: 's-1',
  venueId: 'v1',
  openedAt: t('2026-08-20T14:00:00Z'),
  closedAt: t('2026-08-20T22:00:00Z'),
  ...over,
})

function makeJob(over: Record<string, unknown> = {}) {
  const deps = {
    cron: noopCron as any,
    now: () => t('2026-08-21T00:00:00Z'),
    retryEntry: ((fn: () => Promise<unknown>) => fn()) as any,
    findUnpostedCashPayments: jest.fn().mockResolvedValue([]),
    findUnpostedCashRefunds: jest.fn().mockResolvedValue([]),
    findSessionsCovering: jest.fn().mockResolvedValue([]),
    postSale: jest.fn().mockResolvedValue('POSTED'),
    postRefund: jest.fn().mockResolvedValue('POSTED'),
    ...over,
  }
  return { job: new CashDrawerReconcilerJob(deps as any), deps }
}

beforeEach(() => jest.clearAllMocks())

describe('CashDrawerReconcilerJob.runNow', () => {
  it('🔴 repone una venta en efectivo sin evento que ocurrió DENTRO de una sesión', async () => {
    const { job, deps } = makeJob({
      findUnpostedCashPayments: jest.fn().mockResolvedValue([pago()]),
      findSessionsCovering: jest.fn().mockResolvedValue([sesion()]),
    })
    const r = await job.runNow()
    expect(deps.postSale).toHaveBeenCalledTimes(1)
    expect(deps.postSale).toHaveBeenCalledWith(expect.objectContaining({ id: 'pay-1', venueId: 'v1', amount: 250 }), 's-1')
    expect(r).toMatchObject({ scanned: 1, reposted: 1, outsideDrawer: 0, errors: 0 })
  })

  it('🔴 una venta hecha SIN caja abierta NO se mete en una sesión posterior — se reporta como "fuera de caja"', async () => {
    const { job, deps } = makeJob({
      findUnpostedCashPayments: jest.fn().mockResolvedValue([pago({ createdAt: t('2026-08-20T10:00:00Z') })]), // antes de openedAt
      findSessionsCovering: jest.fn().mockResolvedValue([]),
    })
    const r = await job.runNow()
    expect(deps.postSale).not.toHaveBeenCalled()
    expect(r).toMatchObject({ reposted: 0, outsideDrawer: 1 })
  })

  it('🔴 barrer dos veces no duplica: ALREADY_POSTED no cuenta como repuesto', async () => {
    const { job, deps } = makeJob({
      findUnpostedCashPayments: jest.fn().mockResolvedValue([pago()]),
      findSessionsCovering: jest.fn().mockResolvedValue([sesion()]),
      postSale: jest.fn().mockResolvedValue('ALREADY_POSTED'),
    })
    const r = await job.runNow()
    expect(deps.postSale).toHaveBeenCalledTimes(1)
    expect(r).toMatchObject({ reposted: 0, alreadyPosted: 1 })
  })

  it('repone el PAY_OUT de un reembolso en efectivo sin evento', async () => {
    const { job, deps } = makeJob({
      findUnpostedCashRefunds: jest.fn().mockResolvedValue([pago({ id: 'ref-1', type: 'REFUND', amount: -80 })]),
      findSessionsCovering: jest.fn().mockResolvedValue([sesion()]),
    })
    const r = await job.runNow()
    expect(deps.postRefund).toHaveBeenCalledWith(expect.objectContaining({ id: 'ref-1', type: 'REFUND', amount: -80 }), 's-1')
    expect(r).toMatchObject({ reposted: 1 })
  })

  it('🔴 multi-tenant: la sesión se busca por el venue DEL PAGO', async () => {
    const { job, deps } = makeJob({
      findUnpostedCashPayments: jest.fn().mockResolvedValue([pago({ venueId: 'v2' })]),
      findSessionsCovering: jest.fn().mockResolvedValue([sesion({ venueId: 'v2', id: 's-v2' })]),
    })
    await job.runNow()
    expect(deps.findSessionsCovering).toHaveBeenCalledWith('v2', expect.anything())
    expect(deps.postSale).toHaveBeenCalledWith(expect.anything(), 's-v2')
  })

  it('un fallo en un pago no tumba el barrido: sigue con los demás y lo cuenta', async () => {
    const { job, deps } = makeJob({
      findUnpostedCashPayments: jest.fn().mockResolvedValue([pago({ id: 'pay-a' }), pago({ id: 'pay-b' })]),
      findSessionsCovering: jest.fn().mockResolvedValue([sesion()]),
      postSale: jest.fn().mockRejectedValueOnce(new Error('db')).mockResolvedValueOnce('POSTED'),
    })
    const r = await job.runNow()
    expect(deps.postSale).toHaveBeenCalledTimes(2)
    expect(r).toMatchObject({ reposted: 1, errors: 1 })
  })

  it('🔴 sólo escribe ActivityLog cuando REPUSO algo (anomalía), nunca en un barrido vacío', async () => {
    const { job: vacio } = makeJob()
    await vacio.runNow()
    expect(logAction).not.toHaveBeenCalled()

    const { job: conRepuesto } = makeJob({
      findUnpostedCashPayments: jest.fn().mockResolvedValue([pago()]),
      findSessionsCovering: jest.fn().mockResolvedValue([sesion()]),
    })
    await conRepuesto.runNow()
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'CASH_DRAWER_EVENT_REPOSTED', venueId: 'v1' }))
  })

  it('no corre dos veces a la vez', async () => {
    const lento = jest.fn().mockImplementation(() => new Promise(res => setTimeout(() => res([]), 30)))
    const { job } = makeJob({ findUnpostedCashPayments: lento })
    const [a, b] = await Promise.all([job.runNow(), job.runNow()])
    expect([a.skipped, b.skipped].filter(Boolean)).toHaveLength(1)
  })
})
