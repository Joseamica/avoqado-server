import '../../__helpers__/integration-setup'
import { Client } from 'pg'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { recordCouponRedemption } from '@/services/dashboard/coupon.dashboard.service'
import { updateCustomerMetrics } from '@/services/dashboard/customer.dashboard.service'
import { lockExistingOrderForPayment } from '@/services/shared/paymentShiftClaim'
import { settleStandalonePaymentInTx } from '@/services/tpv/payment.tpv.service'
import { withDeadlockRetry } from '@/utils/serializableRetry'
import { aTiempo, esperarBloqueado } from '@tests/__helpers__/candadosDePostgres'

let orgId: string | undefined, venueId: string | undefined, otroVenueId: string | undefined
let customerId: string
let secuencia = 0
beforeAll(async () => {
  const sello = `${Date.now()}`
  orgId = (
    await prisma.organization.create({ data: { name: `Cupón S2 ${sello}`, email: `cupon-s2-${sello}@test.com`, phone: '5550000000' } })
  ).id
  venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: 'Cupón S2', slug: `cupon-s2-${sello}` } })).id
  otroVenueId = (await prisma.venue.create({ data: { organizationId: orgId, name: 'Otro S2', slug: `otro-cupon-s2-${sello}` } })).id
  customerId = (await prisma.customer.create({ data: { venueId, firstName: 'Clienta cupón' } })).id
})
afterAll(async () => {
  if (!venueId || !otroVenueId || !orgId) return
  const venues = [venueId, otroVenueId]
  await prisma.couponRedemption.deleteMany({ where: { order: { venueId: { in: venues } } } })
  await prisma.customerOrderMetric.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.activityLog.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.payment.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.order.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.discount.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.customer.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.venue.deleteMany({ where: { id: { in: venues } } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
  await prisma.$disconnect()
})
async function venta(status: 'PENDING' | 'CANCELLED' | 'DELETED' = 'PENDING', negocio = venueId!) {
  return prisma.order.create({
    data: {
      venueId: negocio,
      orderNumber: `CUP-S2-${++secuencia}`,
      status,
      source: 'WEB',
      originSystem: 'AVOQADO',
      subtotal: 100,
      total: 100,
      taxAmount: 0,
      remainingBalance: 100,
    },
  })
}
async function beneficio(negocio = venueId!) {
  const discount = await prisma.discount.create({
    data: { venueId: negocio, name: 'Último uso S2', type: 'FIXED_AMOUNT', value: 10, scope: 'ORDER', maxTotalUses: 1 },
  })
  return prisma.couponCode.create({ data: { discountId: discount.id, code: `S2-${discount.id}`, maxUses: 1 } })
}
async function foto(orderId: string, coupon: { id: string; discountId: string }) {
  const [order, code, discount, redemptions] = await Promise.all([
    prisma.order.findUniqueOrThrow({ where: { id: orderId } }),
    prisma.couponCode.findUniqueOrThrow({ where: { id: coupon.id } }),
    prisma.discount.findUniqueOrThrow({ where: { id: coupon.discountId } }),
    prisma.couponRedemption.findMany({ where: { couponCodeId: coupon.id }, orderBy: { id: 'asc' }, take: 10 }),
  ])
  return { order, code, discount, redemptions }
}
const capturar = <T>(p: Promise<T>) =>
  p.then(
    value => ({ status: 'fulfilled' as const, value }),
    reason => ({ status: 'rejected' as const, reason }),
  )
const errorAnulada = { statusCode: 400, code: 'ORDER_CANCELLED_NO_EDIT', message: 'Esta cuenta está cancelada, abre una nueva.' }

// Recoge participantes y cleanup aun con un fallo primario, y propaga después de finally (incluido rechazo falsy).
async function carrera(
  cuerpo: (registrar: <T>(p: Promise<T>) => ReturnType<typeof capturar<T>>) => Promise<void>,
  limpiar: () => Promise<unknown>,
) {
  const participantes: Array<Promise<PromiseSettledResult<unknown>>> = []
  let fallo: unknown,
    huboFallo = false
  const secundarios: unknown[] = []
  try {
    await cuerpo(p => {
      const r = capturar(p)
      participantes.push(r)
      return r
    })
  } catch (error) {
    huboFallo = true
    fallo = error
  } finally {
    const limpieza = await Promise.allSettled([limpiar()])
    const resultados = await Promise.all(participantes)
    secundarios.push(...limpieza.flatMap(r => (r.status === 'rejected' ? [r.reason] : [])))
    if (huboFallo) secundarios.push(...resultados.flatMap(r => (r.status === 'rejected' ? [r.reason] : [])))
  }
  if (secundarios.length) {
    const Constructor = (globalThis as unknown as { AggregateError: new (errors: unknown[], message: string) => Error }).AggregateError
    throw new Constructor([...(huboFallo ? [fallo] : []), ...secundarios], 'Carrera de cupón: participantes recogidos')
  }
  if (huboFallo) throw fallo
}

describe('R13: canje público protegido contra cuentas anuladas (PostgreSQL real)', () => {
  it.each(['CANCELLED', 'DELETED'] as const)('%s sin Payment conserva cuenta, canje y los dos contadores', async status => {
    const order = await venta(status),
      coupon = await beneficio(),
      antes = await foto(order.id, coupon)
    expect(await prisma.payment.count({ where: { orderId: order.id } })).toBe(0)
    await expect(recordCouponRedemption(venueId!, coupon.id, order.id, 10, customerId)).rejects.toMatchObject(errorAnulada)
    expect(await foto(order.id, coupon)).toEqual(antes)
  })

  it('viva conserva el retorno, el último cupo y el duplicado sin volver a consumir', async () => {
    const order = await venta(),
      coupon = await beneficio()
    const result = await recordCouponRedemption(venueId!, coupon.id, order.id, 10, customerId)
    expect(result).toMatchObject({ orderId: order.id, amountSaved: 10, couponCode: { id: coupon.id }, customer: { id: customerId } })
    const despues = await foto(order.id, coupon)
    expect(despues.code.currentUses).toBe(1)
    expect(despues.discount.currentUses).toBe(1)
    expect(despues.redemptions).toHaveLength(1)
    expect(despues.order).toEqual(order)
    await expect(recordCouponRedemption(venueId!, coupon.id, order.id, 10)).rejects.toMatchObject({
      statusCode: 400,
      message: 'This order already has a coupon redemption',
    })
    expect(await foto(order.id, coupon)).toEqual(despues)
  })

  it('dos solicitudes concurrentes dejan un canje y un incremento por contador', async () => {
    const order = await venta(),
      coupon = await beneficio()
    const results = await Promise.all([
      capturar(recordCouponRedemption(venueId!, coupon.id, order.id, 10)),
      capturar(recordCouponRedemption(venueId!, coupon.id, order.id, 10)),
    ])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(r => r.status === 'rejected')).toMatchObject({
      reason: { statusCode: 400, message: 'This order already has a coupon redemption' },
    })
    const despues = await foto(order.id, coupon)
    expect(despues.redemptions).toHaveLength(1)
    expect([despues.code.currentUses, despues.discount.currentUses]).toEqual([1, 1])
  })

  it('si el último incremento SQL falla, revierte canje y los dos contadores', async () => {
    const order = await venta(),
      coupon = await beneficio()
    // Fallo real en la ÚLTIMA escritura: integer de PostgreSQL agotado, sin simular resultados ni cambiar schema.
    await prisma.discount.update({ where: { id: coupon.discountId }, data: { currentUses: 2_147_483_647, maxTotalUses: null } })
    const antes = await foto(order.id, coupon)
    await expect(recordCouponRedemption(venueId!, coupon.id, order.id, 10)).rejects.toThrow(/out of range/i)
    expect(await foto(order.id, coupon)).toEqual(antes)
  })

  it('ausente y otro venue mantienen NotFound y ambos contadores intactos', async () => {
    const order = await venta('PENDING', otroVenueId!),
      coupon = await beneficio(),
      antes = await foto(order.id, coupon)
    for (const orderId of [orgId!, order.id])
      await expect(recordCouponRedemption(venueId!, coupon.id, orderId, 10)).rejects.toMatchObject({
        statusCode: 404,
        message: 'Order not found',
      })
    await expect(recordCouponRedemption(otroVenueId!, coupon.id, order.id, 10)).rejects.toMatchObject({
      statusCode: 404,
      message: 'El cupón no existe',
    })
    expect(await foto(order.id, coupon)).toEqual(antes)
  })

  it('Payment real y conciliación real reabren la cuenta; después admite el canje', async () => {
    const order = await venta('CANCELLED'),
      coupon = await beneficio()
    await withDeadlockRetry(
      async tx => {
        await lockExistingOrderForPayment(tx, { venueId: venueId!, orderId: order.id })
        const payment = await tx.payment.create({
          data: {
            venueId: venueId!,
            orderId: order.id,
            amount: 10,
            tipAmount: 0,
            feePercentage: 0,
            feeAmount: 0,
            netAmount: 10,
            method: 'CASH',
            status: 'COMPLETED',
            type: 'REGULAR',
          },
        })
        await settleStandalonePaymentInTx(tx, venueId!, order.id, payment)
      },
      { etiqueta: 'testR13Reapertura' },
    )
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).not.toMatch(/CANCELLED|DELETED/)
    expect(await prisma.payment.count({ where: { orderId: order.id, status: 'COMPLETED' } })).toBe(1)
    await expect(recordCouponRedemption(venueId!, coupon.id, order.id, 10)).resolves.toMatchObject({ orderId: order.id, amountSaved: 10 })
  })

  it.each(['CANCELLED', 'DELETED'] as const)('relee %s después de esperar el candado y no consume nada', async status => {
    const order = await venta(),
      coupon = await beneficio(),
      antes = await foto(order.id, coupon)
    const db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
    await db.connect()
    let abierta = false
    try {
      await db.query('BEGIN')
      abierta = true
      const pid = (await db.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid
      await db.query('UPDATE "Order" SET status=$1::"OrderStatus" WHERE id=$2', [status, order.id])
      await carrera(
        async registrar => {
          const result = registrar(recordCouponRedemption(venueId!, coupon.id, order.id, 10))
          expect(await esperarBloqueado(prisma, { bloqueadoPor: [pid], consulta: /FOR NO KEY UPDATE/, ms: 3000 })).not.toBeNull()
          await db.query('COMMIT')
          abierta = false
          expect(await result).toMatchObject({ status: 'rejected', reason: errorAnulada })
        },
        async () => {
          if (abierta) {
            await db.query('ROLLBACK')
            abierta = false
          }
        },
      )
      expect(await foto(order.id, coupon)).toEqual({ ...antes, order: { ...antes.order, status } })
    } finally {
      if (abierta) await db.query('ROLLBACK')
      await db.end()
    }
  })

  it('redeemedAt se obtiene tras la espera real, no del inicio de la transacción', async () => {
    const order = await venta(),
      coupon = await beneficio()
    const db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
    await db.connect()
    let abierta = false
    try {
      await db.query('BEGIN')
      abierta = true
      const pid = (await db.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid
      await db.query('SELECT id FROM "Order" WHERE id=$1 FOR UPDATE', [order.id])
      await carrera(
        async registrar => {
          const result = registrar(recordCouponRedemption(venueId!, coupon.id, order.id, 10))
          expect(await esperarBloqueado(prisma, { bloqueadoPor: [pid], consulta: /FOR NO KEY UPDATE/, ms: 3000 })).not.toBeNull()
          const liberadoDesde = Date.now()
          await db.query('COMMIT')
          abierta = false
          const r = await result
          if (r.status === 'rejected') throw r.reason
          expect(r.value.redeemedAt.getTime()).toBeGreaterThanOrEqual(liberadoDesde)
        },
        async () => {
          if (abierta) {
            await db.query('ROLLBACK')
            abierta = false
          }
        },
      )
    } finally {
      if (abierta) await db.query('ROLLBACK')
      await db.end()
    }
  })

  it('canje real y métricas Customer/FK Order terminan sin ciclo ni retry', async () => {
    const order = await venta(),
      coupon = await beneficio()
    const original = prisma.$transaction.bind(prisma) as (...args: any[]) => Promise<any>
    let avisar: (pid: number) => void = () => undefined,
      soltar: () => void = () => undefined
    const pid = new Promise<number>(r => {
        avisar = r
      }),
      liberacion = new Promise<void>(r => {
        soltar = r
      })
    const spy = jest.spyOn(prisma, '$transaction').mockImplementationOnce(((fn: (tx: any) => Promise<unknown>, options: object) =>
      original(async (tx: any) => {
        const [{ pid: actual }] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`
        const proxy = new Proxy(tx, {
          get(target, prop) {
            if (prop !== 'customerOrderMetric') return Reflect.get(target, prop)
            return new Proxy(tx.customerOrderMetric, {
              get(model, operation) {
                const real = Reflect.get(model, operation)
                if (operation !== 'findUnique') return typeof real === 'function' ? real.bind(model) : real
                return async (...args: unknown[]) => {
                  avisar(Number(actual))
                  await liberacion
                  return real.apply(model, args)
                }
              },
            })
          },
        })
        return fn(proxy)
      }, options)) as never)
    ;(logger.warn as jest.Mock).mockClear()
    try {
      await carrera(
        async registrar => {
          const metrics = registrar(updateCustomerMetrics(customerId, 100, order.id, venueId!))
          const pidMetrics = await aTiempo(pid, 3000, 'Customer bloqueado por métricas')
          const redemption = registrar(recordCouponRedemption(venueId!, coupon.id, order.id, 10, customerId))
          const wait = await esperarBloqueado(prisma, { bloqueadoPor: [pidMetrics], consulta: /INSERT[\s\S]*"CouponRedemption"/, ms: 3000 })
          expect(wait).not.toBeNull()
          soltar()
          expect(await aTiempo(metrics, 8000, 'métricas con FK Order')).toMatchObject({ status: 'fulfilled' })
          expect(await aTiempo(redemption, 8000, 'canje con FK Customer')).toMatchObject({ status: 'fulfilled' })
          expect(spy).toHaveBeenCalledTimes(2)
          expect((logger.warn as jest.Mock).mock.calls.some(([message]) => /interbloqueo|deadlock/i.test(String(message)))).toBe(false)
        },
        async () => {
          soltar()
        },
      )
    } finally {
      soltar()
      spy.mockRestore()
    }
    expect(await prisma.customerOrderMetric.count({ where: { orderId: order.id, customerId } })).toBe(1)
    expect(await prisma.couponRedemption.count({ where: { orderId: order.id, customerId } })).toBe(1)
  })
})
