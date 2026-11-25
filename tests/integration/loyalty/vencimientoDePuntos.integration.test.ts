/**
 * D27 (25-nov-2026) contra Postgres real: los puntos vencen por inactividad, una sola vez, con su movimiento y su registro, y una
 * devolución de una venta cuyos puntos ya vencieron no le quita los puntos nuevos al cliente. Promesa y mapa de entradas:
 * Avoqado/docs/audit/2026-11-25-defectos-lealtad-referidos/lealtad/promesa.md (workspace).
 *
 * El reloj se adelanta con el parámetro de las funciones (los movimientos se escriben con la hora real). Correr sólo en una base DESECHABLE:
 *   TZ=UTC npx jest --selectProjects=integration --runTestsByPath tests/integration/loyalty/vencimientoDePuntos.integration.test.ts --runInBand --ci
 */
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { broadcastToUser: jest.fn(), getBroadcastingService: jest.fn(() => null) },
}))
jest.mock('@/communication/sockets/managers/socketManager', () => {
  const sm = { getServer: jest.fn(), getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() }
  return { __esModule: true, default: sm, socketManager: sm }
})
jest.mock('@/services/tpv/digitalReceipt.tpv.service', () => ({ generateDigitalReceipt: jest.fn().mockResolvedValue(null) }))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({ notifyCustomerPassUpdated: jest.fn() }))
jest.mock('@/services/wallet/firstStampEmail.service', () => ({ sendFirstStampEmailIfDue: jest.fn() }))
jest.mock('@/services/access/basePlan.service', () => ({
  ...jest.requireActual('@/services/access/basePlan.service'),
  venueHasFeatureAccess: jest.fn().mockResolvedValue(true),
}))

import prisma from '@/utils/prismaClient'
import { PaymentEffectsJob } from '@/jobs/payment-effects.job'
import { adjustPoints, earnPoints, updateLoyaltyConfig } from '@/services/dashboard/loyalty.dashboard.service'
import { issueRefund } from '@/services/dashboard/refund.dashboard.service'
import { vencerPuntosDelCliente, vencerPuntosDelNegocio } from '@/services/loyalty/vencimientoDePuntos'
import { abrirTurno, sembrarCobro } from '../dashboard/sembrarCobroParaReembolso'
import { crearNegocioDePrueba, limpiarNegocioDePrueba } from '../giftCards/sembrarTarjetasDeRegalo'

const DIA = 86_400_000
let venueId: string
let staffId: string
let n = 0

/** Pasado mañana: con 1 día de vigencia, todo lo de hoy ya venció. */
const enDosDias = () => new Date(Date.now() + 2 * DIA)
const hoy = () => new Date()

const cliente = async () => {
  const i = ++n
  return (await prisma.customer.create({ data: { venueId, firstName: `Vence${i}`, phone: `+52556688${String(i).padStart(4, '0')}` } })).id
}
const saldo = async (customerId: string) => (await prisma.customer.findUniqueOrThrow({ where: { id: customerId } })).loyaltyPoints
const vencimientos = (customerId: string) => prisma.loyaltyTransaction.findMany({ where: { customerId, type: 'EXPIRE' } })
const sumaDelHistorial = async (customerId: string) =>
  (await prisma.loyaltyTransaction.aggregate({ where: { customerId }, _sum: { points: true } }))._sum.points ?? 0

async function ventaConPuntos(customerId: string, saleCents: number) {
  const { order, pago } = await sembrarCobro({ venueId, staffId, saleCents, tipCents: 0, commissionPercent: null })
  await prisma.order.update({ where: { id: order.id }, data: { customerId } })
  await earnPoints(venueId, customerId, saleCents / 100, order.id)
  return { orderId: order.id, pago }
}

async function correrElEfecto(refundPaymentId: string) {
  const job = new PaymentEffectsJob({ cron: { start: jest.fn(), stop: jest.fn() } })
  for (let i = 0; i < 20; i++) {
    await job.runNow()
    const fila = await prisma.paymentEffect.findFirstOrThrow({ where: { paymentId: refundPaymentId, kind: 'LOYALTY_POINTS_REVERSAL' } })
    if (fila.status === 'DONE') return
  }
  throw new Error('el efecto de puntos no terminó')
}

/** 1 día de vigencia y el reloj arrancado hace 10 días (como si el código nuevo llevara corriendo ese tiempo). */
const vigenciaDeUnDia = () =>
  prisma.loyaltyConfig.update({
    where: { venueId },
    data: { active: true, pointsExpireDays: 1, pointsExpireSince: new Date(Date.now() - 10 * DIA) },
  })

beforeAll(async () => {
  ;({ venueId, staffId } = await crearNegocioDePrueba('vencimiento-puntos'))
  await prisma.loyaltyConfig.create({ data: { venueId, active: true, pointsPerDollar: 1, pointsPerVisit: 0 } })
  await abrirTurno(venueId, staffId)
})

beforeEach(async () => {
  await vigenciaDeUnDia()
})

afterAll(async () => {
  if (!venueId) return // Sin negocio no se borra NADA: un filtro con `venueId` indefinido vaciaría tablas enteras.
  await prisma.activityLog.deleteMany({ where: { venueId } })
  await prisma.loyaltyTransaction.deleteMany({ where: { customer: { venueId } } })
  await limpiarNegocioDePrueba(venueId)
  await prisma.shift.deleteMany({ where: { venueId } })
  await prisma.customer.deleteMany({ where: { venueId } })
  await prisma.loyaltyConfig.deleteMany({ where: { venueId } })
  await prisma.$disconnect()
})

describe('D27 · vencimiento por inactividad', () => {
  it('sin actividad: vence TODO el saldo una sola vez, con su movimiento y su registro', async () => {
    const c = await cliente()
    await ventaConPuntos(c, 12000)
    expect(await saldo(c)).toBe(120)

    await expect(vencerPuntosDelCliente(venueId, c, enDosDias)).resolves.toEqual({ vencidos: 120 })
    await expect(vencerPuntosDelCliente(venueId, c, enDosDias)).resolves.toEqual({ vencidos: 0 })

    expect(await saldo(c)).toBe(0)
    const [expire, ...otros] = await vencimientos(c)
    expect(otros).toEqual([])
    expect(expire).toMatchObject({ points: -120, createdById: null })
    expect(await sumaDelHistorial(c)).toBe(0)
    const registro = await prisma.activityLog.findMany({ where: { venueId, action: 'LOYALTY_POINTS_EXPIRED', entityId: c } })
    expect(registro).toHaveLength(1)
    expect(registro[0].data).toMatchObject({ points: 120, newBalance: 0, loyaltyTransactionId: expire.id })
  })

  it('con actividad reciente (un ajuste hoy): no vence nada', async () => {
    const c = await cliente()
    await ventaConPuntos(c, 5000)
    // `adjustPoints` firma con el StaffVenue (createdById), como lo resuelve su controlador.
    const sv = await prisma.staffVenue.findFirstOrThrow({ where: { staffId, venueId }, select: { id: true } })
    await adjustPoints(venueId, c, 10, 'Bono', sv.id)
    await expect(vencerPuntosDelCliente(venueId, c, hoy)).resolves.toEqual({ vencidos: 0 })
    expect(await saldo(c)).toBe(60)
  })

  it('el reloj protege lo de antes: actividad de hace 5 días y ancla de hoy ⇒ hoy no vence; pasado mañana, sí', async () => {
    const c = await cliente()
    const { orderId } = await ventaConPuntos(c, 5000)
    await prisma.loyaltyTransaction.updateMany({ where: { orderId }, data: { createdAt: new Date(Date.now() - 5 * DIA) } })
    await prisma.loyaltyConfig.update({ where: { venueId }, data: { pointsExpireSince: new Date() } })
    await expect(vencerPuntosDelCliente(venueId, c, hoy)).resolves.toEqual({ vencidos: 0 })
    expect(await saldo(c)).toBe(50)
    await expect(vencerPuntosDelCliente(venueId, c, enDosDias)).resolves.toEqual({ vencidos: 50 })
  })

  it('dos vueltas a la vez sobre el mismo cliente: un solo vencimiento', async () => {
    const c = await cliente()
    await ventaConPuntos(c, 7000)
    const [a, b] = await Promise.all([vencerPuntosDelCliente(venueId, c, enDosDias), vencerPuntosDelCliente(venueId, c, enDosDias)])
    expect(a.vencidos + b.vencidos).toBe(70)
    expect(await vencimientos(c)).toHaveLength(1)
    expect(await saldo(c)).toBe(0)
  })

  it('una compra a la vez que la vuelta: o vence lo viejo y la compra nueva se queda, o la compra llega antes y no vence nada', async () => {
    const c = await cliente()
    const viejo = await ventaConPuntos(c, 4000)
    // Lo viejo, hace 5 días; el reloj es el REAL (hoy): con 1 día de vigencia, sólo lo viejo está vencido (Codex r4 #5).
    await prisma.loyaltyTransaction.updateMany({ where: { orderId: viejo.orderId }, data: { createdAt: new Date(Date.now() - 5 * DIA) } })
    const { order } = await sembrarCobro({ venueId, staffId, saleCents: 3000, tipCents: 0, commissionPercent: null })
    await prisma.order.update({ where: { id: order.id }, data: { customerId: c } })

    await Promise.all([vencerPuntosDelCliente(venueId, c, hoy), earnPoints(venueId, c, 30, order.id)])

    const final = await saldo(c)
    const expires = await vencimientos(c)
    if (expires.length === 1) {
      expect(expires[0].points).toBe(-40) // venció lo viejo, ANTES de la compra
      expect(final).toBe(30) // y la compra nueva se quedó entera
    } else {
      expect(expires).toHaveLength(0) // la compra llegó primero: es actividad de hoy
      expect(final).toBe(70)
    }
    expect(final).toBe(await sumaDelHistorial(c))
  })

  it('devolver una venta cuyos puntos ya vencieron NO le quita los puntos nuevos; la fila de la reversa queda', async () => {
    const c = await cliente()
    const viejo = await ventaConPuntos(c, 10000)
    await vencerPuntosDelCliente(venueId, c, enDosDias)
    expect(await saldo(c)).toBe(0)
    await ventaConPuntos(c, 3000) // la compra nueva, después del vencimiento
    expect(await saldo(c)).toBe(30)

    const r = await issueRefund({ venueId, paymentId: viejo.pago.id, amount: 10000, tipRefundCents: 0, reason: 'RETURNED_GOODS', staffId })
    await correrElEfecto(r.refundId)

    expect(await saldo(c)).toBe(30)
    const reversa = await prisma.loyaltyTransaction.findFirstOrThrow({ where: { orderId: viejo.orderId, refundPaymentId: r.refundId } })
    expect(reversa.points).toBe(0)
    expect(reversa.reason).toContain('ya habían vencido')
  })

  it('la hora de un movimiento es la de su INSERT, no la del inicio de su transacción (la reversa depende de esto)', async () => {
    // `reversaEnTx` compara EXPIRE.createdAt > EARN.createdAt. Es exacto porque Prisma pone la hora al escribir: el EARN y el EXPIRE se
    // escriben con el candado del cliente tomado, así que su hora sigue el orden de los candados (Codex r3 #2, r6 #1).
    const c = await cliente()
    const inicio = Date.now()
    const fila = await prisma.$transaction(
      async tx => {
        await tx.$executeRaw`SELECT pg_sleep(1)`
        return tx.loyaltyTransaction.create({ data: { customerId: c, type: 'ADJUST', points: 0, reason: 'FULLTEST hora del insert' } })
      },
      { timeout: 10_000 },
    )
    expect(fila.createdAt.getTime() - inicio).toBeGreaterThanOrEqual(900)
  })

  it('devolver la compra NUEVA (después del vencimiento) sí le quita sus puntos: el vencimiento no la perdona', async () => {
    const c = await cliente()
    await ventaConPuntos(c, 4000)
    await vencerPuntosDelCliente(venueId, c, enDosDias)
    const nueva = await ventaConPuntos(c, 3000)
    expect(await saldo(c)).toBe(30)

    const r = await issueRefund({ venueId, paymentId: nueva.pago.id, amount: 3000, tipRefundCents: 0, reason: 'RETURNED_GOODS', staffId })
    await correrElEfecto(r.refundId)
    expect(await saldo(c)).toBe(0)
  })

  it('un vencimiento viejo (parcial, de la versión anterior) NO perdona la devolución, aunque sea POSTERIOR a esa venta', async () => {
    const c = await cliente()
    const venta = await ventaConPuntos(c, 10000)
    // Lo que escribía la ruta vieja, DESPUÉS de la venta: un EXPIRE parcial (de otra compra), sin la marca de «todo el saldo».
    await prisma.loyaltyTransaction.create({ data: { customerId: c, type: 'EXPIRE', points: -1, reason: 'Expired 1 points (legacy)' } })
    await prisma.customer.update({ where: { id: c }, data: { loyaltyPoints: { decrement: 1 } } })
    expect(await saldo(c)).toBe(99)

    const r = await issueRefund({ venueId, paymentId: venta.pago.id, amount: 10000, tipRefundCents: 0, reason: 'RETURNED_GOODS', staffId })
    await correrElEfecto(r.refundId)
    // Sin la marca `wholeBalance`, la reversa quita lo de esa venta como siempre (topado al saldo).
    expect(await saldo(c)).toBe(0)
  })

  it('devolver ANTES de que venzan sigue quitando los puntos de esa venta (como siempre)', async () => {
    const c = await cliente()
    const venta = await ventaConPuntos(c, 10000)
    const r = await issueRefund({ venueId, paymentId: venta.pago.id, amount: 10000, tipRefundCents: 0, reason: 'RETURNED_GOODS', staffId })
    await correrElEfecto(r.refundId)
    expect(await saldo(c)).toBe(0)
  })

  it('el negocio: la primera vez sólo arranca el reloj (sin pisar uno puesto) y no vence a nadie', async () => {
    const c = await cliente()
    await ventaConPuntos(c, 2000)
    await prisma.loyaltyConfig.update({ where: { venueId }, data: { pointsExpireSince: null } })

    const r = await vencerPuntosDelNegocio(venueId, enDosDias)

    expect(r.anclaFijada).toBe(true)
    expect(r.customersAffected).toBe(0)
    expect((await prisma.loyaltyConfig.findUniqueOrThrow({ where: { venueId } })).pointsExpireSince).not.toBeNull()
    expect(await saldo(c)).toBe(20)
  })

  it('el negocio: una vuelta vence a todos los inactivos y la segunda ya no hace nada', async () => {
    const uno = await cliente()
    await ventaConPuntos(uno, 4400)
    const dos = await cliente()
    await ventaConPuntos(dos, 5500)
    const r = await vencerPuntosDelNegocio(venueId, enDosDias)
    expect(r.fallidos).toBe(0)
    expect(r.customersAffected).toBeGreaterThanOrEqual(2)
    expect(await saldo(uno)).toBe(0)
    expect(await saldo(dos)).toBe(0)
    const otra = await vencerPuntosDelNegocio(venueId, enDosDias)
    expect(otra.customersAffected).toBe(0)
  })

  it('updateLoyaltyConfig: prender la expiración arranca el reloj hoy', async () => {
    await prisma.loyaltyConfig.update({ where: { venueId }, data: { pointsExpireDays: null, pointsExpireSince: null } })
    const antes = Date.now()
    await updateLoyaltyConfig(venueId, { pointsExpireDays: 90 })
    const cfg = await prisma.loyaltyConfig.findUniqueOrThrow({ where: { venueId } })
    expect(cfg.pointsExpireDays).toBe(90)
    expect(cfg.pointsExpireSince!.getTime()).toBeGreaterThanOrEqual(antes - 1000)
  })
})
