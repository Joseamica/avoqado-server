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
jest.mock('@/services/shared/cashDrawerPosting', () => ({
  postCashSaleToDrawer: jest.fn().mockResolvedValue('POSTED'),
  postCashRefundToDrawer: jest.fn().mockResolvedValue('POSTED'),
}))

import { logAction } from '@/services/dashboard/activity-log.service'
import { CashDrawerReconcilerJob, defaults } from '@/jobs/cash-drawer-reconciler.job'
import { prismaMock } from '../../__helpers__/setup'
import { postCashRefundToDrawer } from '@/services/shared/cashDrawerPosting'

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

  // 🔴 El repost REAL (no el mock inyectado por los demás casos): el cajón sólo ve
  // billetes, así que reponer un reembolso tiene que sacar venta + propina. El
  // `Payment` del reembolso guarda el split contable (`amount` = venta, `tipAmount` =
  // propina) y la venta original entró como la SUMA; pasar sólo `amount` deja el
  // esperado arriba por la propina — y como el repost es idempotente por `localId`,
  // ese faltante inventado ya no se puede corregir nunca.
  it('🔴 el repost de un reembolso saca del cajón venta + propina, no sólo la venta', async () => {
    ;(postCashRefundToDrawer as jest.Mock).mockClear()
    await defaults.postRefund({ id: 'ref-9', venueId: 'v-1', orderId: null, amount: -80, tipAmount: -20, method: 'CASH' } as never, 's-1')
    const arg = (postCashRefundToDrawer as jest.Mock).mock.calls[0][0]
    expect(Math.abs(Number(arg.amount))).toBeCloseTo(100, 2)
  })

  // 🔴 Un pago que nació en OTRO sistema de punto de venta no pudo entrar al cajón de
  // Avoqado: su efectivo lo recibió la caja de ese otro sistema. El fallback legacy
  // (`fundsFlow` nulo + method CASH) los daba por dinero del cajón, así que si su fecha caía
  // dentro de una sesión el barrido los reponía e inflaba el esperado — un faltante inventado
  // que se le carga al cajero. Medido en producción: 6,634 pagos de SoftRestaurant en esa
  // situación (hoy inertes, porque su venue no abre cajón y quedan fuera de la ventana de 7
  // días; el filtro cierra la puerta antes de que eso cambie).
  it('🔴 no repone pagos que nacieron en OTRO sistema de punto de venta', async () => {
    ;(prismaMock as any).$queryRaw = jest.fn().mockResolvedValue([])
    ;(prismaMock as any).payment = { findMany: jest.fn().mockResolvedValue([]) }
    await defaults.findUnpostedCashPayments(new Date('2026-08-20'), new Date('2026-08-27'), 200)

    // El filtro vive en el SQL, que es donde se acota el trabajo.
    const sql = ((prismaMock as any).$queryRaw as jest.Mock).mock.calls[0][0].join('?')
    expect(sql).toContain(`"originSystem" = 'AVOQADO'`)
    expect(sql).toContain('NOT EXISTS') // sin su movimiento de caja
    expect(sql).toContain('CashDrawerSession') // y dentro de una sesión: sólo lo reparable
  })

  // 🔴 El presupuesto del barrido (200 filas) se gastaba en casos IMPOSIBLES. El filtro de
  // "ya posteado" corría en JS DESPUÉS del `take`, y nada excluía los pagos que caen fuera de
  // toda sesión de caja — que nunca se pueden reponer y, por ser los más antiguos, encabezan
  // la fila para siempre. Medido en producción (28-ago): 467 candidatos en la ventana de 7
  // días, 466 sin evento y CERO reparables. Un pago que sí necesitara reposición quedaría
  // detrás de esos 466 y el barrido no lo alcanzaría nunca. Ahora las dos condiciones se
  // resuelven en SQL, así que el `take` sólo se gasta en lo que de verdad se puede reponer.
  it('🔴 el barrido sólo pide lo REPARABLE: sin evento y dentro de una sesión', async () => {
    ;(prismaMock as any).$queryRaw = jest.fn().mockResolvedValue([])
    ;(prismaMock as any).payment = { findMany: jest.fn() }

    const r = await defaults.findUnpostedCashPayments(new Date('2026-08-20'), new Date('2026-08-27'), 200)

    expect(r).toEqual([])
    // sin candidatos no se pide nada más: el barrido deja de traer 200 filas para descartarlas
    expect((prismaMock as any).payment.findMany).not.toHaveBeenCalled()
  })
})
