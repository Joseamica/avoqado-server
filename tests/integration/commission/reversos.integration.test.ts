// tests/integration/commission/reversos.integration.test.ts
/**
 * Fase 3 de pago por servicio, Bloque A — devoluciones y anulaciones de comisiones contra Postgres REAL, por el camino
 * durable (efecto + worker) y con la anulación única. Spec §6.4, §9-2…§9-6; casos 11-14 y 20 del §13.
 *
 * Correr: TZ=UTC TEST_DATABASE_URL="$PAGO_F3_DB" npx jest --selectProjects integration \
 *   --runTestsByPath tests/integration/commission/reversos.integration.test.ts --ci
 */
import { CommissionCalculation, Prisma, PrismaClient, TierPeriod } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { issueRefund } from '@/services/dashboard/refund.dashboard.service'
import * as calculo from '@/services/dashboard/commission/commission-calculation.service'
import {
  anularComision,
  createCommissionForPayment,
  voidCommissionCalculation,
} from '@/services/dashboard/commission/commission-calculation.service'
import { aggregateVenueCommissions, recalculateSummary } from '@/services/dashboard/commission/commission-aggregation.service'
import { activateReferralProgram } from '@/services/referrals/referralProgram.service'
import { captureReferral } from '@/services/referrals/referralCapture.service'
import { onOrderPaid } from '@/services/referrals/referralQualification.service'
import { runClaimedPaymentEffect } from '@/services/tpv/paymentEffects.service'
import { cleanupReferralFixtureData } from '@tests/__helpers__/referral-fixture-cleanup'
import {
  asegurarBaseDePrueba,
  barreraDeFila,
  borrarMundoComisiones,
  cobro,
  crearMundoComisiones,
  despues,
  devolver,
  MundoComisiones,
  netoVivo,
  orden,
  planear,
  procesarEfectos,
  snapshotViejo,
  sumadaAUnResumen,
  ventaConComision,
} from './_mundoComisiones'

jest.mock('@/services/shared/cashDrawerPosting', () => ({ postCashRefundToDrawer: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({ generateAndStoreReceipt: jest.fn().mockResolvedValue(undefined) }))

let m: MundoComisiones
beforeAll(asegurarBaseDePrueba)
beforeEach(async () => {
  m = await crearMundoComisiones('reversos')
})
afterEach(() => borrarMundoComisiones(m))

describe('A2 · el reverso de una devolución es durable (spec §9-2, §9-3; Codex r1-2, r1-3, r2-1)', () => {
  it('🔴 la devolución del dashboard —y la de las apps, que pasan por el mismo servicio— deja el reverso en cola dentro de su transacción', async () => {
    const { orderId, pago } = await ventaConComision(m)
    const r = await issueRefund({ venueId: m.venueId, paymentId: pago, amount: 10_000, reason: 'RETURNED_GOODS', staffId: m.owner })
    // Al volver, el reverso ya es una obligación guardada con la devolución: si el proceso muere aquí, el worker lo crea.
    const enCola = await prisma.paymentEffect.findMany({
      where: { venueId: m.venueId, paymentId: r.refundId, kind: 'COMMISSION' },
      take: 10,
    })
    expect(enCola.map(e => e.status)).toEqual(['PENDING'])
    expect(Number((enCola[0].payload as { netCommission: string | number }).netCommission)).toBe(-10)
    await procesarEfectos(m)
    expect(await netoVivo({ venueId: m.venueId, orderId })).toBe('0.00')
  })

  it('🔴 una fila ya ANULADA cuenta como materializada: su efecto pendiente no revive la comisión (Codex r1-3, caso 13)', async () => {
    const orderId = await orden(m, { subtotal: 100 })
    const pago = await cobro(m, orderId, 100)
    await planear(pago) // el efecto queda PENDING
    // El camino directo viejo (o un reintento manual) materializó la fila antes que el worker, y alguien la anuló.
    const [directa] = await createCommissionForPayment(pago)
    await voidCommissionCalculation(directa.calculationId, m.venueId, m.owner, 'Venta capturada por error')
    await procesarEfectos(m)
    const filas = await prisma.commissionCalculation.findMany({ where: { venueId: m.venueId, paymentId: pago }, take: 10 })
    expect(filas.map(f => f.status)).toEqual(['VOIDED'])
    expect(await netoVivo({ venueId: m.venueId, orderId })).toBe('0.00')
  })

  it('🔴 un reverso EN COLA no revive cuando su comisión original ya se anuló (Codex r2-1)', async () => {
    const { orderId, pago, comision } = await ventaConComision(m)
    const devolucion = await devolver(m, pago, 40) // el reverso queda en cola
    await voidCommissionCalculation(comision.id, m.venueId, m.owner, 'Venta capturada por error')
    await procesarEfectos(m) // el worker ve la original anulada
    expect(await prisma.commissionCalculation.count({ where: { venueId: m.venueId, paymentId: devolucion } })).toBe(0)
    const efecto = await prisma.paymentEffect.findFirstOrThrow({ where: { venueId: m.venueId, paymentId: devolucion, kind: 'COMMISSION' } })
    expect(efecto.status).toBe('DONE')
    expect(await netoVivo({ venueId: m.venueId, orderId })).toBe('0.00')
  })

  it('🔴 si el cálculo del reverso falla, la devolución NO se cae: queda una obligación visible para revisión', async () => {
    const { pago } = await ventaConComision(m)
    const falla = jest.spyOn(calculo, 'createRefundCommission').mockRejectedValueOnce(new Error('cálculo forzado a fallar'))
    const aviso = jest.spyOn(logger, 'warn')
    try {
      const r = await issueRefund({ venueId: m.venueId, paymentId: pago, amount: 4_000, reason: 'RETURNED_GOODS', staffId: m.owner })
      expect(await prisma.payment.findUniqueOrThrow({ where: { id: r.refundId } })).toMatchObject({ type: 'REFUND', status: 'COMPLETED' })
      const revision = await prisma.paymentEffect.findFirstOrThrow({
        where: { venueId: m.venueId, paymentId: r.refundId, kind: 'COMMISSION' },
      })
      expect([revision.dedupeKey, revision.lastError]).toEqual([
        `commission:${r.refundId}:policy-error:v1`,
        'COMMISSION_SNAPSHOT_REQUIRES_REVIEW',
      ])
      // La reconciliación del referido sigue en la MISMA transacción.
      expect(await prisma.paymentEffect.count({ where: { venueId: m.venueId, paymentId: r.refundId, kind: 'REFERRAL' } })).toBe(1)
      // Ronda 1: queda rastro de POR QUÉ —nombre y código del error— pero nunca su mensaje (podría traer datos de tarjeta).
      const llamadas = aviso.mock.calls as unknown as Array<[string, { refundPaymentId?: string } | undefined]>
      const rastro = llamadas.find(([, meta]) => meta?.refundPaymentId === r.refundId)
      expect(rastro?.[1]).toEqual({ refundPaymentId: r.refundId, originalPaymentId: pago, errorName: 'Error', errorCode: undefined })
      expect(JSON.stringify(rastro)).not.toContain('forzado')
    } finally {
      falla.mockRestore()
      aviso.mockRestore()
    }
  })

  describe('🔴 una comisión original anulada A MEDIAS: el reverso de la parte viva SÍ nace (Ronda 1 de A2)', () => {
    /** Otra fila de comisión del mismo cobro, como la deja el camino directo (otra persona, o la misma rehecha a mano). */
    const copia = (fila: CommissionCalculation, cambios: Partial<Prisma.CommissionCalculationUncheckedCreateInput>) => {
      return prisma.commissionCalculation.create({
        data: { ...fila, id: undefined, status: 'CALCULATED', voidedAt: null, voidedBy: null, voidReason: null, ...cambios },
      })
    }

    it('dos personas: se anula la de Ana y el reverso de Bea se crea (sólo el de Ana se da por atendido)', async () => {
      const { orderId, pago, comision } = await ventaConComision(m)
      await copia(comision, { staffId: m.bea })
      const devolucion = await devolver(m, pago, 40) // dos reversos en cola: Ana y Bea
      await voidCommissionCalculation(comision.id, m.venueId, m.owner, 'Venta capturada por error')
      await procesarEfectos(m)
      const reversos = await prisma.commissionCalculation.findMany({ where: { venueId: m.venueId, paymentId: devolucion }, take: 10 })
      expect(reversos.map(r => [r.staffId, r.netCommission.toFixed(2)])).toEqual([[m.bea, '-4.00']])
      expect(await netoVivo({ venueId: m.venueId, orderId, staffId: m.bea })).toBe('6.00')
      expect(await netoVivo({ venueId: m.venueId, orderId, staffId: m.ana })).toBe('0.00')
    })

    it('misma persona y esquema: una fila anulada y otra viva ⇒ el reverso se crea contra la viva', async () => {
      const { orderId, pago, comision } = await ventaConComision(m)
      await voidCommissionCalculation(comision.id, m.venueId, m.owner, 'Se rehízo a mano')
      const anulada = await prisma.commissionCalculation.findUniqueOrThrow({ where: { id: comision.id } })
      await copia(anulada, {})
      const devolucion = await devolver(m, pago, 40)
      await procesarEfectos(m)
      const reversos = await prisma.commissionCalculation.findMany({ where: { venueId: m.venueId, paymentId: devolucion }, take: 10 })
      expect(reversos.map(r => r.netCommission.toFixed(2))).toEqual(['-4.00'])
      expect(await netoVivo({ venueId: m.venueId, orderId })).toBe('6.00')
    })
  })
})

describe('A3 · los reversos parciales cuadran al centavo (spec §9-4; Codex r1-4 y plan r1-1, r1-2, r1-3; caso 14)', () => {
  const reversosDe = (orderId: string, pago: string) =>
    prisma.commissionCalculation.findMany({
      where: { venueId: m.venueId, orderId, NOT: { paymentId: pago } },
      orderBy: { calculatedAt: 'asc' },
      take: 10,
    })

  it('🔴 tres devoluciones en cola de una comisión de $0.02, procesadas al final: se revierte exactamente $0.02', async () => {
    const { orderId, pago, comision } = await ventaConComision(m, 0.21)
    expect(comision.netCommission.toFixed(2)).toBe('0.02')
    for (let i = 0; i < 3; i++) await devolver(m, pago, 0.07)
    await procesarEfectos(m)
    const filas = await reversosDe(orderId, pago)
    expect(filas.map(r => r.netCommission.toFixed(2))).toEqual(['-0.01', '0.00', '-0.01'])
    expect(filas.map(r => r.baseAmount.toFixed(2))).toEqual(['-0.07', '-0.07', '-0.07'])
    expect(await netoVivo({ venueId: m.venueId, orderId })).toBe('0.00')
  })

  it('🔴 tres devoluciones procesadas una por una: también exactamente $0.02', async () => {
    const { orderId, pago } = await ventaConComision(m, 0.21)
    for (let i = 0; i < 3; i++) {
      await devolver(m, pago, 0.07)
      await procesarEfectos(m)
    }
    expect(await netoVivo({ venueId: m.venueId, orderId })).toBe('0.00')
  })

  it.each([
    ['la de fecha MÁS NUEVA se confirma primero', true],
    ['la de fecha más vieja se confirma primero', false],
  ])(
    '🔴 dos devoluciones del 50 %% de una comisión de $0.03 a la vez (%s): se revierte exactamente $0.03 (plan r1-1)',
    async (_n, laNuevaPrimero) => {
      const { orderId, pago, comision } = await ventaConComision(m, 0.3)
      expect(comision.netCommission.toFixed(2)).toBe('0.03')
      const vieja = despues()
      const nueva = despues()
      // Las dos esperan el candado de la orden; se confirma primero la que llegó primero, sin importar su fecha.
      const barrera = await barreraDeFila('Order', orderId)
      let primera!: Promise<string>
      let segunda!: Promise<string>
      try {
        primera = devolver(m, pago, 0.15, 0, laNuevaPrimero ? nueva : vieja)
        await barrera.esperarA(1)
        segunda = devolver(m, pago, 0.15, 0, laNuevaPrimero ? vieja : nueva)
        await barrera.esperarA(2)
      } finally {
        await barrera.soltar()
      }
      const [r1, r2] = await Promise.all([primera, segunda])
      await procesarEfectos(m)
      const neto = async (paymentId: string) =>
        (await prisma.commissionCalculation.findFirstOrThrow({ where: { venueId: m.venueId, paymentId } })).netCommission.toFixed(2)
      expect([await neto(r1), await neto(r2)]).toEqual(['-0.02', '-0.01'])
      expect(await netoVivo({ venueId: m.venueId, orderId })).toBe('0.00')
    },
  )

  it('con más de 500 reversos todavía en cola (worker detenido), el siguiente descuenta lo justo: nada se trunca (plan r1-2)', async () => {
    const { orderId, pago, comision } = await ventaConComision(m, 50.2)
    expect(comision.netCommission.toFixed(2)).toBe('5.02')
    // 501 devoluciones de $0.10 cuyo reverso de $0.01 sigue en cola, como lo deja `createRefundCommission`.
    const devoluciones = await prisma.payment.createManyAndReturn({
      data: Array.from({ length: 501 }, () => ({
        venueId: m.venueId,
        orderId,
        amount: -0.1,
        tipAmount: 0,
        method: 'CASH' as const,
        status: 'COMPLETED' as const,
        type: 'REFUND' as const,
        processedById: m.owner,
        feePercentage: 0,
        feeAmount: 0,
        netAmount: -0.1,
        processorData: { originalPaymentId: pago },
      })),
      select: { id: true },
    })
    await prisma.paymentEffect.createMany({
      data: devoluciones.map(d => ({
        venueId: m.venueId,
        paymentId: d.id,
        orderId,
        kind: 'COMMISSION',
        dedupeKey: `commission:${d.id}:${m.configId}:${comision.staffId}:v1`,
        payload: {
          venueId: m.venueId,
          staffId: comision.staffId,
          paymentId: d.id,
          orderId,
          shiftId: null,
          configId: m.configId,
          baseAmount: '-0.10',
          tipAmount: '0',
          discountAmount: '0',
          taxAmount: '0',
          effectiveRate: '0.1',
          grossCommission: '-0.01',
          netCommission: '-0.01',
          calcType: 'PERCENTAGE',
          tier: null,
          tierName: null,
          status: 'CALCULATED',
          calculatedAt: new Date().toISOString(),
        },
      })),
    })
    const ultima = await devolver(m, pago, 0.1)
    const plan = await prisma.paymentEffect.findFirstOrThrow({ where: { venueId: m.venueId, paymentId: ultima, kind: 'COMMISSION' } })
    const payload = plan.payload as { netCommission: string; baseAmount: string }
    // 5.02 en total − 501 × 0.01 en cola = 0.01; con un tope de 500 filas leería 5.00 y descontaría 0.02 ($5.03 de $5.02).
    expect([Number(payload.netCommission), Number(payload.baseAmount)]).toEqual([-0.01, -0.1])
  }, 120_000)

  describe('Ronda 1 · las ramas nuevas del reverso acumulado', () => {
    const filasDe = (paymentId: string) => prisma.commissionCalculation.findMany({ where: { venueId: m.venueId, paymentId }, take: 10 })
    const reversoEnCola = async (paymentId: string) =>
      (
        await prisma.paymentEffect.findFirstOrThrow({
          where: { venueId: m.venueId, paymentId, kind: 'COMMISSION', NOT: { dedupeKey: { endsWith: ':policy-error:v1' } } },
        })
      ).payload as { netCommission: string }

    it('volver a correr una devolución cuyo reverso sigue EN COLA no crea nada (rama `enCola`)', async () => {
      const { orderId, pago } = await ventaConComision(m)
      const devolucion = await devolver(m, pago, 40)
      expect(await calculo.createRefundCommission(devolucion, pago)).toEqual([])
      expect(await filasDe(devolucion)).toHaveLength(0)
      expect(await prisma.paymentEffect.count({ where: { venueId: m.venueId, paymentId: devolucion, kind: 'COMMISSION' } })).toBe(1)
      await procesarEfectos(m)
      expect(await netoVivo({ venueId: m.venueId, orderId })).toBe('6.00')
    })

    it('tras un `policy-error`, la siguiente devolución absorbe su parte y volver a correr la fallida da 0', async () => {
      const { pago } = await ventaConComision(m)
      const falla = jest.spyOn(calculo, 'createRefundCommission').mockRejectedValueOnce(new Error('cálculo forzado a fallar'))
      let fallida: string
      try {
        fallida = await devolver(m, pago, 40)
      } finally {
        falla.mockRestore()
      }
      expect(await prisma.paymentEffect.count({ where: { venueId: m.venueId, paymentId: fallida, kind: 'COMMISSION' } })).toBe(1)
      const siguiente = await devolver(m, pago, 60)
      // Con TODA la venta devuelta, lo que debe quedar revertido son los $10 completos; nadie había revertido nada.
      expect((await reversoEnCola(siguiente)).netCommission).toBe('-10')
      expect(await calculo.createRefundCommission(fallida, pago)).toEqual([])
      expect(await filasDe(fallida)).toHaveLength(0)
    })

    it('un reverso ANULADO cuenta como «ya revertido»: anularlo es decidir que esa parte no se revierte', async () => {
      const { orderId, pago } = await ventaConComision(m)
      const primera = await devolver(m, pago, 40)
      await procesarEfectos(m)
      const [reverso] = await filasDe(primera)
      await voidCommissionCalculation(reverso.id, m.venueId, m.owner, 'La devolución se compensó a mano')
      const segunda = await devolver(m, pago, 60)
      await procesarEfectos(m)
      expect((await filasDe(segunda)).map(r => r.netCommission.toFixed(2))).toEqual(['-6.00'])
      expect(await netoVivo({ venueId: m.venueId, orderId })).toBe('4.00')
    })

    it('🔴 un reverso en cola con montos de punto flotante cuenta lo que guardaría el worker (ROUND a 2 decimales)', async () => {
      const { orderId, pago, comision } = await ventaConComision(m, 0.3)
      expect(comision.netCommission.toFixed(2)).toBe('0.03')
      // Como lo dejaba el cálculo binario anterior: la mitad de $0.03 es -0.015, que el worker guarda como -0.02.
      const vieja = await prisma.payment.create({
        data: {
          venueId: m.venueId,
          orderId,
          amount: -0.15,
          tipAmount: 0,
          method: 'CASH',
          status: 'COMPLETED',
          type: 'REFUND',
          processedById: m.owner,
          feePercentage: 0,
          feeAmount: 0,
          netAmount: -0.15,
          processorData: { originalPaymentId: pago },
          createdAt: despues(),
        },
      })
      await prisma.paymentEffect.create({
        data: {
          venueId: m.venueId,
          paymentId: vieja.id,
          orderId,
          kind: 'COMMISSION',
          dedupeKey: `commission:${vieja.id}:${m.configId}:${comision.staffId}:v1`,
          payload: {
            venueId: m.venueId,
            staffId: comision.staffId,
            paymentId: vieja.id,
            orderId,
            shiftId: null,
            configId: m.configId,
            baseAmount: -0.15,
            tipAmount: 0,
            discountAmount: 0,
            taxAmount: 0,
            effectiveRate: '0.1',
            grossCommission: -0.015,
            netCommission: -0.015,
            calcType: 'PERCENTAGE',
            tier: null,
            tierName: null,
            status: 'CALCULATED',
            calculatedAt: vieja.createdAt.toISOString(),
          },
        },
      })
      const nueva = await devolver(m, pago, 0.15)
      await procesarEfectos(m)
      expect((await filasDe(vieja.id)).map(r => r.netCommission.toFixed(2))).toEqual(['-0.02'])
      // Sin ROUND contaría 0.015 y revertiría otros 0.015 (= -0.02 guardado): $0.04 de $0.03.
      expect((await filasDe(nueva)).map(r => r.netCommission.toFixed(2))).toEqual(['-0.01'])
      expect(await netoVivo({ venueId: m.venueId, orderId })).toBe('0.00')
    })
  })
})

describe('A3 Ronda 1 · el reverso espera a que exista la comisión original (hueco de A2)', () => {
  it('🔴 con la comisión original en DEAD_LETTER, el reverso no se materializa ni gasta intentos; cuando la original llega, se aplica', async () => {
    const orderId = await orden(m, { subtotal: 100 })
    const pago = await cobro(m, orderId, 100)
    await planear(pago)
    const comisionOriginal = { venueId: m.venueId, paymentId: pago, kind: 'COMMISSION' }
    await prisma.paymentEffect.updateMany({
      where: comisionOriginal,
      data: { status: 'DEAD_LETTER', attempts: 6, lastError: 'PAYMENT_EFFECT_EXECUTION_FAILED' },
    })
    const devolucion = await devolver(m, pago, 40) // su reverso nace del snapshot de la original en DEAD_LETTER
    const enCola = await prisma.paymentEffect.findFirstOrThrow({ where: { venueId: m.venueId, paymentId: devolucion, kind: 'COMMISSION' } })

    await procesarEfectos(m)
    // Nada se descuenta: la persona nunca cobró esa comisión.
    expect(await prisma.commissionCalculation.count({ where: { venueId: m.venueId, orderId } })).toBe(0)
    const esperando = await prisma.paymentEffect.findUniqueOrThrow({ where: { id: enCola.id } })
    expect([esperando.status, esperando.attempts, esperando.claimToken]).toEqual(['PENDING', enCola.attempts, null])
    expect(esperando.lastError).toBe('COMMISSION_AWAITS_ORIGINAL')
    expect(esperando.nextAttemptAt.getTime()).toBeGreaterThan(Date.now())

    // Alguien reintenta la original: se materializa y, en la siguiente pasada, el reverso se aplica.
    await prisma.paymentEffect.updateMany({ where: comisionOriginal, data: { status: 'PENDING', attempts: 0, nextAttemptAt: new Date() } })
    await procesarEfectos(m)
    expect((await prisma.paymentEffect.findUniqueOrThrow({ where: { id: enCola.id } })).status).toBe('DONE')
    expect(await netoVivo({ venueId: m.venueId, orderId })).toBe('6.00')
  })

  it('🔴 a las 24 h la espera escala a COMMISSION_AWAITS_ORIGINAL_OVERDUE con UN aviso; la siguiente pasada no lo repite (Ronda 2)', async () => {
    const orderId = await orden(m, { subtotal: 100 })
    const pago = await cobro(m, orderId, 100)
    await planear(pago)
    await prisma.paymentEffect.updateMany({
      where: { venueId: m.venueId, paymentId: pago, kind: 'COMMISSION' },
      data: { status: 'DEAD_LETTER', attempts: 6, lastError: 'PAYMENT_EFFECT_EXECUTION_FAILED' },
    })
    const devolucion = await devolver(m, pago, 40)
    const enCola = await prisma.paymentEffect.findFirstOrThrow({ where: { venueId: m.venueId, paymentId: devolucion, kind: 'COMMISSION' } })
    // El reverso nació hace 25 h: ya pasó el umbral de 24 h.
    await prisma.paymentEffect.update({ where: { id: enCola.id }, data: { createdAt: new Date(Date.now() - 25 * 3_600_000) } })
    const aviso = jest.spyOn(logger, 'warn')
    try {
      const avisosDelEfecto = () =>
        (aviso.mock.calls as unknown as Array<[string, { effectId?: string } | undefined]>).filter(
          ([, meta]) => meta?.effectId === enCola.id,
        )

      await procesarEfectos(m)
      const vencido = await prisma.paymentEffect.findUniqueOrThrow({ where: { id: enCola.id } })
      expect([vencido.status, vencido.attempts, vencido.lastError]).toEqual([
        'PENDING',
        enCola.attempts,
        'COMMISSION_AWAITS_ORIGINAL_OVERDUE',
      ])
      expect(vencido.nextAttemptAt.getTime()).toBeGreaterThan(Date.now())
      expect(await prisma.commissionCalculation.count({ where: { venueId: m.venueId, orderId } })).toBe(0)
      const [[, meta]] = avisosDelEfecto()
      expect(avisosDelEfecto()).toHaveLength(1)
      // Ids y motivo; nada de montos ni datos de personas.
      expect(meta).toEqual({
        effectId: enCola.id,
        venueId: m.venueId,
        paymentId: devolucion,
        orderId,
        motivo: 'COMMISSION_AWAITS_ORIGINAL_OVERDUE',
      })

      await procesarEfectos(m)
      const sigue = await prisma.paymentEffect.findUniqueOrThrow({ where: { id: enCola.id } })
      expect([sigue.status, sigue.attempts, sigue.lastError]).toEqual(['PENDING', enCola.attempts, 'COMMISSION_AWAITS_ORIGINAL_OVERDUE'])
      expect(avisosDelEfecto()).toHaveLength(1)
    } finally {
      aviso.mockRestore()
    }
  })
})

describe('A4 · una sola operación de anulación (spec §6.4, §9-5; Codex r1-1, r2-1, r2-28 y plan r1-5)', () => {
  /** Espera a ver una sesión detenida por el candado de la sesión `pid` (o a que `seguir()` diga que ya no hace falta). */
  async function detenidaPor(observador: PrismaClient, pid: number, seguir: () => boolean = () => true): Promise<void> {
    const limite = Date.now() + 15_000
    while (seguir()) {
      const [{ n }] = await observador.$queryRaw<Array<{ n: number }>>`
        SELECT COUNT(*)::int AS n FROM pg_stat_activity a WHERE pg_blocking_pids(a.pid) @> ARRAY[${pid}::int]`
      if (n > 0) return
      if (Date.now() > limite) throw new Error(`Ninguna sesión quedó detenida por la sesión ${pid}`)
      await new Promise(r => setTimeout(r, 10))
    }
  }

  it('🔴 anular una comisión anula también su reverso ya materializado: el neto de la venta queda en $0 (caso 11)', async () => {
    const { orderId, pago, comision } = await ventaConComision(m)
    const devolucion = await devolver(m, pago, 40)
    await procesarEfectos(m)
    const reverso = await prisma.commissionCalculation.findFirstOrThrow({ where: { venueId: m.venueId, paymentId: devolucion } })
    expect(reverso.netCommission.toFixed(2)).toBe('-4.00')

    const r = await anularComision({
      calculationId: comision.id,
      venueId: m.venueId,
      actorId: m.owner,
      motivo: 'Venta capturada por error',
    })

    expect([...r.anuladas].sort()).toEqual([comision.id, reverso.id].sort())
    expect(await netoVivo({ venueId: m.venueId, orderId })).toBe('0.00')
    const rastro = await prisma.activityLog.findFirstOrThrow({
      where: { venueId: m.venueId, action: 'COMMISSION_CALCULATION_VOIDED', entityId: comision.id },
    })
    expect(rastro.staffId).toBe(m.owner)
    expect([...(rastro.data as { anuladas: string[] }).anuladas].sort()).toEqual([comision.id, reverso.id].sort())
  })

  it('devolver DESPUÉS de anular no crea reverso: el neto sigue en $0 (caso 11, el otro orden)', async () => {
    const { orderId, pago, comision } = await ventaConComision(m)
    await anularComision({ calculationId: comision.id, venueId: m.venueId, actorId: m.owner, motivo: 'Venta capturada por error' })
    await devolver(m, pago, 40)
    await procesarEfectos(m)
    expect(await netoVivo({ venueId: m.venueId, orderId })).toBe('0.00')
  })

  it('🔴 devolución EN COLA + anulación antes del worker: el reverso no nace y el neto queda en $0 (caso 20)', async () => {
    const { orderId, pago, comision } = await ventaConComision(m)
    await devolver(m, pago, 40)
    await anularComision({ calculationId: comision.id, venueId: m.venueId, actorId: m.owner, motivo: 'Venta capturada por error' })
    await procesarEfectos(m)
    expect(await netoVivo({ venueId: m.venueId, orderId })).toBe('0.00')
  })

  it('anular dos veces no repite nada', async () => {
    const { comision } = await ventaConComision(m)
    await anularComision({ calculationId: comision.id, venueId: m.venueId, actorId: m.owner, motivo: 'Una' })
    expect(await anularComision({ calculationId: comision.id, venueId: m.venueId, actorId: m.owner, motivo: 'Otra' })).toEqual({
      anuladas: [],
    })
    expect(await prisma.activityLog.count({ where: { venueId: m.venueId, action: 'COMMISSION_CALCULATION_VOIDED' } })).toBe(1)
  })

  it('una comisión de otra sede no se puede anular desde ésta', async () => {
    const { comision } = await ventaConComision(m)
    const otra = await crearMundoComisiones('otra-sede')
    try {
      await expect(
        anularComision({ calculationId: comision.id, venueId: otra.venueId, actorId: otra.owner, motivo: 'X' }),
      ).rejects.toMatchObject({
        statusCode: 404,
      })
    } finally {
      await borrarMundoComisiones(otra)
    }
  })

  it('🔴 la anulación espera al worker que está creando el reverso: el candado de la orden no la deja colarse (contrato de A2)', async () => {
    const { orderId, pago, comision } = await ventaConComision(m)
    const devolucion = await devolver(m, pago, 40) // el reverso queda en cola
    // El worker crea el reverso y se queda DENTRO de su transacción (con el candado de la orden) hasta que la prueba lo suelte.
    const real = calculo.applyFrozenCommissionInTx
    let avisarPid!: (pid: number) => void
    const workerDentro = new Promise<number>(r => (avisarPid = r))
    let soltarWorker!: () => void
    const suelto = new Promise<void>(r => (soltarWorker = r))
    const pausa = jest.spyOn(calculo, 'applyFrozenCommissionInTx').mockImplementation(async (tx, effect) => {
      const hecho = await real(tx, effect)
      const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
      avisarPid(pid)
      await suelto
      return hecho
    })
    const observador = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } })
    let mirando = true
    try {
      const worker = procesarEfectos(m)
      const pidWorker = await workerDentro
      const anulacion = anularComision({
        calculationId: comision.id,
        venueId: m.venueId,
        actorId: m.owner,
        motivo: 'Venta capturada por error',
      })
      // Con el candado, la anulación queda detenida por el worker; sin él, termina sin esperarlo (y no ve el reverso).
      await Promise.race([anulacion.catch(() => undefined), detenidaPor(observador, pidWorker, () => mirando)])
      mirando = false
      soltarWorker()
      await Promise.all([worker, anulacion])
    } finally {
      mirando = false
      soltarWorker()
      pausa.mockRestore()
      await observador.$disconnect()
    }
    const reverso = await prisma.commissionCalculation.findFirstOrThrow({ where: { venueId: m.venueId, paymentId: devolucion } })
    expect(reverso.status).toBe('VOIDED')
    expect(await netoVivo({ venueId: m.venueId, orderId })).toBe('0.00')
  })

  it('🔴 anulación y agregador a la vez: el bloqueo mutuo se resuelve solo y el resumen queda en $0 (plan r1-5)', async () => {
    const { orderId, pago, comision } = await ventaConComision(m)
    const resumen = await sumadaAUnResumen(m, comision.id, comision.staffId, 10)
    const devolucion = await devolver(m, pago, 40)
    await procesarEfectos(m)
    // El reverso queda por agregar en el periodo EN CURSO: el agregador lo quiere marcar mientras la anulación lo anula.
    const { id: reversoId } = await prisma.commissionCalculation.findFirstOrThrow({ where: { venueId: m.venueId, paymentId: devolucion } })
    await prisma.commissionCalculation.update({ where: { id: reversoId }, data: { calculatedAt: new Date() } })

    // Orden FORZADO (Ronda 1): (1) la anulación toma sus filas —el reverso incluido— y se detiene justo antes de pedir el
    // resumen; (2) el agregador toma el resumen y se queda esperando el reverso; (3) la anulación pide el resumen: bloqueo
    // mutuo. Postgres revisa UNA vez por espera, a los `deadlock_timeout` de cada sesión; el agregador corre con uno de una
    // hora (la base de pruebas es superusuario, aquí y en CI), así que la víctima es SIEMPRE la anulación, que repite su
    // operación completa. Si la víctima fuera el agregador, su reintento relee fuera de la transacción (H3, aparcado) y el
    // resumen dependería del reloj; ese reintento se prueba aparte, con el 40P01 inyectado.
    let avisarPid!: (pid: number) => void
    const anulacionDentro = new Promise<number>(r => (avisarPid = r))
    let soltar!: () => void
    const suelta = new Promise<void>(r => (soltar = r))
    const original = prisma.$transaction.bind(prisma)
    const espia = jest
      .spyOn(prisma, '$transaction')
      // 1.ª: el primer intento de la anulación, detenido antes del candado del resumen.
      .mockImplementationOnce(((fn: any, opts: any) =>
        original(
          async (tx: any) => {
            let detenida = false
            const envuelto = new Proxy(tx, {
              get(t, p) {
                if (p !== '$queryRaw') return typeof t[p] === 'function' ? t[p].bind(t) : t[p]
                return async (q: any, ...v: unknown[]) => {
                  if (!detenida && String(q?.sql ?? '').includes('FROM "CommissionSummary"')) {
                    detenida = true
                    const [{ pid }] = await t.$queryRaw`SELECT pg_backend_pid() AS pid`
                    avisarPid(pid)
                    await suelta
                  }
                  return t.$queryRaw(q, ...v)
                }
              },
            })
            return fn(envuelto)
          },
          { ...opts, timeout: 30_000 },
        )) as any)
      // 2.ª: la del agregador, que nunca revisa el bloqueo mutuo dentro de la prueba.
      .mockImplementationOnce(((fn: any, opts: any) =>
        original(
          async (tx: any) => {
            await tx.$executeRawUnsafe(`SET LOCAL deadlock_timeout = '1h'`)
            return fn(tx)
          },
          { ...opts, timeout: 30_000 },
        )) as any)
    const observador = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } })
    try {
      const anulacion = anularComision({
        calculationId: comision.id,
        venueId: m.venueId,
        actorId: m.owner,
        motivo: 'Venta capturada por error',
      })
      const pidAnulacion = await Promise.race([
        anulacionDentro,
        anulacion.then(() => Promise.reject(new Error('La anulación terminó sin pedir el candado del resumen'))),
      ])
      const agregacion = aggregateVenueCommissions(m.venueId, TierPeriod.MONTHLY)
      await detenidaPor(observador, pidAnulacion) // el agregador ya tiene el resumen y espera el reverso
      soltar()
      const desenlaces = await Promise.allSettled([anulacion, agregacion])
      expect(desenlaces.map(d => d.status)).toEqual(['fulfilled', 'fulfilled'])
      // La anulación abortó y repitió su transacción completa (3.ª llamada, ya sin espía).
      expect(espia).toHaveBeenCalledTimes(3)
    } finally {
      soltar()
      espia.mockRestore()
      await observador.$disconnect()
    }
    expect(await netoVivo({ venueId: m.venueId, orderId })).toBe('0.00')
    const s = await prisma.commissionSummary.findUniqueOrThrow({ where: { id: resumen } })
    expect([s.netAmount.toFixed(2), s.paymentCount]).toEqual(['0.00', 0])
  })

  describe('🔴 las dos repiten su operación COMPLETA cuando Postgres las elige víctima (deterministas: el choque real cae del lado que sea)', () => {
    const bloqueoMutuo = () => Object.assign(new Error('deadlock detected'), { code: '40P01' })

    it('la anulación', async () => {
      const { comision } = await ventaConComision(m)
      const tx = jest.spyOn(prisma, '$transaction').mockRejectedValueOnce(bloqueoMutuo())
      try {
        const r = await anularComision({
          calculationId: comision.id,
          venueId: m.venueId,
          actorId: m.owner,
          motivo: 'Venta capturada por error',
        })
        expect(r.anuladas).toEqual([comision.id])
        expect(tx).toHaveBeenCalledTimes(2)
      } finally {
        tx.mockRestore()
      }
    })

    it('el agregador: la segunda pasada vuelve a leer y suma una sola vez', async () => {
      const { comision } = await ventaConComision(m)
      await prisma.commissionCalculation.update({ where: { id: comision.id }, data: { calculatedAt: new Date() } })
      const tx = jest.spyOn(prisma, '$transaction').mockRejectedValueOnce(bloqueoMutuo())
      try {
        const r = await aggregateVenueCommissions(m.venueId, TierPeriod.MONTHLY)
        expect([r.summariesCreated, r.calculationsAggregated]).toEqual([1, 1])
        expect(tx).toHaveBeenCalledTimes(2)
      } finally {
        tx.mockRestore()
      }
      const fila = await prisma.commissionCalculation.findUniqueOrThrow({ where: { id: comision.id }, include: { summary: true } })
      expect([fila.status, fila.summary?.netAmount.toFixed(2)]).toEqual(['AGGREGATED', '10.00'])
    })
  })

  describe('Ronda 1 · lo que la anulación no puede romper', () => {
    const pagoViejo = (resumen: string, staffId: string, status: 'PENDING' | 'APPROVED' | 'PROCESSING' | 'CANCELLED') =>
      prisma.commissionPayout.create({
        data: { venueId: m.venueId, staffId, summaryId: resumen, amount: 10, paymentMethod: 'CASH', status },
      })

    it.each(['PENDING', 'APPROVED', 'PROCESSING'] as const)(
      '🔴 si su resumen tiene un pago %s del flujo viejo, la anulación se rechaza y no cambia nada',
      async status => {
        const { pago, comision } = await ventaConComision(m)
        const resumen = await sumadaAUnResumen(m, comision.id, comision.staffId, 10)
        await prisma.commissionSummary.update({ where: { id: resumen }, data: { status: 'APPROVED' } })
        const devolucion = await devolver(m, pago, 40)
        await procesarEfectos(m)
        await pagoViejo(resumen, comision.staffId, status)
        const antes = await prisma.commissionSummary.findUniqueOrThrow({ where: { id: resumen } })

        await expect(
          anularComision({ calculationId: comision.id, venueId: m.venueId, actorId: m.owner, motivo: 'Venta capturada por error' }),
        ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('pago de comisiones en curso') })

        const filas = await prisma.commissionCalculation.findMany({ where: { venueId: m.venueId }, orderBy: { id: 'asc' }, take: 10 })
        expect(filas.map(f => [f.paymentId, f.status])).toEqual(
          expect.arrayContaining([
            [pago, 'AGGREGATED'],
            [devolucion, 'CALCULATED'],
          ]),
        )
        expect(filas.every(f => f.voidedAt === null)).toBe(true)
        expect(await prisma.commissionSummary.findUniqueOrThrow({ where: { id: resumen } })).toEqual(antes)
        expect(
          await prisma.activityLog.count({
            where: { venueId: m.venueId, action: { in: ['COMMISSION_CALCULATION_VOIDED', 'COMMISSION_SUMMARY_RECALCULATED'] } },
          }),
        ).toBe(0)
      },
    )

    it('🔴 un pago que se está creando EN ESE MOMENTO también la detiene: la anulación espera a que confirme y lo ve', async () => {
      const { comision } = await ventaConComision(m)
      const resumen = await sumadaAUnResumen(m, comision.id, comision.staffId, 10)
      // Otro cliente inserta el pago del flujo viejo y se queda sin confirmar (la llave foránea le da el resumen en KEY SHARE).
      const url = process.env.DATABASE_URL
      const otro = new PrismaClient({ datasources: { db: { url } } })
      const observador = new PrismaClient({ datasources: { db: { url } } })
      let avisarPid!: (pid: number) => void
      const insertado = new Promise<number>(r => (avisarPid = r))
      let confirmar!: () => void
      const confirma = new Promise<void>(r => (confirmar = r))
      const pago = otro.$transaction(
        async t => {
          await t.commissionPayout.create({
            data: {
              venueId: m.venueId,
              staffId: comision.staffId,
              summaryId: resumen,
              amount: 10,
              paymentMethod: 'CASH',
              status: 'PENDING',
            },
          })
          const [{ pid }] = await t.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
          avisarPid(pid)
          await confirma
        },
        { timeout: 30_000 },
      )
      try {
        const pidPago = await insertado
        const anulacion = anularComision({
          calculationId: comision.id,
          venueId: m.venueId,
          actorId: m.owner,
          motivo: 'Venta capturada por error',
        })
        await detenidaPor(observador, pidPago)
        confirmar()
        await pago
        await expect(anulacion).rejects.toMatchObject({ statusCode: 400 })
      } finally {
        confirmar()
        await Promise.allSettled([pago])
        await Promise.all([otro.$disconnect(), observador.$disconnect()])
      }
      expect((await prisma.commissionCalculation.findUniqueOrThrow({ where: { id: comision.id } })).status).toBe('AGGREGATED')
    })

    it('sin `db`, el recálculo y su auditoría van en la misma transacción: si la auditoría falla, el resumen no cambia', async () => {
      const { comision } = await ventaConComision(m)
      const resumen = await sumadaAUnResumen(m, comision.id, comision.staffId, 10)
      await prisma.commissionCalculation.update({ where: { id: comision.id }, data: { netCommission: 7 } }) // ya no cuadra
      const antes = await prisma.commissionSummary.findUniqueOrThrow({ where: { id: resumen } })
      const original = prisma.$transaction.bind(prisma)
      const espia = jest.spyOn(prisma, '$transaction').mockImplementationOnce(((fn: any, opts: any) =>
        original(
          async (tx: any) =>
            fn(
              new Proxy(tx, {
                get: (t, p) =>
                  p === 'activityLog'
                    ? { create: () => Promise.reject(new Error('auditoría caída')) }
                    : typeof t[p] === 'function'
                      ? t[p].bind(t)
                      : t[p],
              }),
            ),
          opts,
        )) as any)
      try {
        await expect(recalculateSummary(resumen, m.venueId)).rejects.toThrow('auditoría caída')
      } finally {
        espia.mockRestore()
      }
      expect(await prisma.commissionSummary.findUniqueOrThrow({ where: { id: resumen } })).toEqual(antes)
    })

    it('un pago CANCELADO no la detiene', async () => {
      const { comision } = await ventaConComision(m)
      const resumen = await sumadaAUnResumen(m, comision.id, comision.staffId, 10)
      await pagoViejo(resumen, comision.staffId, 'CANCELLED')
      const r = await anularComision({
        calculationId: comision.id,
        venueId: m.venueId,
        actorId: m.owner,
        motivo: 'Venta capturada por error',
      })
      expect(r.anuladas).toEqual([comision.id])
      expect((await prisma.commissionSummary.findUniqueOrThrow({ where: { id: resumen } })).netAmount.toFixed(2)).toBe('0.00')
    })

    it('🔴 recalcular un resumen mientras el agregador lo está sumando no pierde lo que el agregador acaba de marcar', async () => {
      const primera = await ventaConComision(m)
      const resumen = await sumadaAUnResumen(m, primera.comision.id, primera.comision.staffId, 10)
      const segunda = await ventaConComision(m)
      await prisma.commissionCalculation.update({ where: { id: segunda.comision.id }, data: { calculatedAt: new Date() } })

      // El agregador ya sumó la segunda al resumen (`increment`) y la marcó con su `summaryId`, y se detiene ANTES de su
      // COMMIT (justo antes de ligar los bonos). Sin el candado del resumen, el recálculo leería el resumen y sus filas
      // sin la segunda y, al escribir totales absolutos, borraría lo que el agregador acaba de sumar.
      let avisarPid!: (pid: number) => void
      const agregadorDentro = new Promise<number>(r => (avisarPid = r))
      let soltar!: () => void
      const suelto = new Promise<void>(r => (soltar = r))
      const original = prisma.$transaction.bind(prisma)
      const espia = jest.spyOn(prisma, '$transaction').mockImplementationOnce(((fn: any, opts: any) =>
        original(
          async (tx: any) => {
            const bonos = new Proxy(tx.milestoneAchievement, {
              get(d, p) {
                const f = d[p]
                if (p !== 'updateMany') return typeof f === 'function' ? f.bind(d) : f
                return async (args: unknown) => {
                  const [{ pid }] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`
                  avisarPid(pid)
                  await suelto
                  return f.call(d, args)
                }
              },
            })
            return fn(
              new Proxy(tx, { get: (t, p) => (p === 'milestoneAchievement' ? bonos : typeof t[p] === 'function' ? t[p].bind(t) : t[p]) }),
            )
          },
          { ...opts, timeout: 30_000 },
        )) as any)
      const observador = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } })
      try {
        const agregacion = aggregateVenueCommissions(m.venueId, TierPeriod.MONTHLY)
        const pidAgregador = await agregadorDentro
        const recalculo = recalculateSummary(resumen, m.venueId) // como el botón «Recalcular» del dashboard
        await detenidaPor(observador, pidAgregador)
        soltar()
        await Promise.all([agregacion, recalculo])
      } finally {
        soltar()
        espia.mockRestore()
        await observador.$disconnect()
      }
      const s = await prisma.commissionSummary.findUniqueOrThrow({ where: { id: resumen } })
      expect([s.totalCommissions.toFixed(2), s.netAmount.toFixed(2), s.paymentCount]).toEqual(['20.00', '20.00', 2])
    })
  })
})

describe('A6 F2 · el reverso no cambia si la comisión original está en cola o materializada (Codex bloque A r1 [P2])', () => {
  /**
   * `venta` + $0.20 de propina al 10 % con propina; se devuelven SÓLO $0.05 de propina. Devuelve el neto del reverso. Los
   * $2.10 de Codex no reproducen contra Postgres (Prisma guarda 2.3); $32.20 sí (32.40000000000001), ver basePorCobro.
   */
  async function reversoDeLaPropina(venta: number, originalMaterializada: boolean, conSnapshotViejo = false): Promise<string> {
    await prisma.commissionConfig.update({ where: { id: m.configId }, data: { includeTips: true } })
    const orderId = await orden(m, { subtotal: venta })
    const pago = await cobro(m, orderId, venta, { propina: 0.2 })
    await planear(pago)
    if (conSnapshotViejo) await snapshotViejo(m, pago, { baseAmount: venta + 0.2 })
    if (originalMaterializada) await procesarEfectos(m)
    const devolucion = await devolver(m, pago, 0, 0.05)
    await procesarEfectos(m)
    return netoVivo({ venueId: m.venueId, paymentId: devolucion })
  }

  it.each([
    [2.1, 'en cola', false],
    [2.1, 'materializada', true],
    [32.2, 'en cola', false],
    [32.2, 'materializada', true],
  ])('🔴 $%d + $0.20 con la original %s: devolver $0.05 de propina revierte −$0.01', async (venta, _, materializada) => {
    expect(await reversoDeLaPropina(venta, materializada)).toBe('-0.01')
  })

  it('🔴 con un snapshot VIEJO en cola (base 32.400000000000006) también es −$0.01', async () => {
    expect(await reversoDeLaPropina(32.2, false, true)).toBe('-0.01')
  })
})

describe('A6 F4 · la devolución revierte el referido sólo por su efecto durable (Codex bloque A r1, punto b)', () => {
  /** Reclama y corre el efecto como el worker; correrlo otra vez simula la reentrega tras morir entre el consumidor y DONE. */
  async function correrEfecto(id: string, vez: number): Promise<void> {
    const e = await prisma.paymentEffect.findUniqueOrThrow({ where: { id } })
    const claimToken = `prueba-f4-${vez}-${id}`
    const leaseUntil = new Date(Date.now() + 60_000)
    await prisma.paymentEffect.update({ where: { id }, data: { status: 'PROCESSING', claimToken, leaseUntil } })
    const hecho = await runClaimedPaymentEffect({
      id,
      venueId: e.venueId,
      paymentId: e.paymentId,
      orderId: e.orderId,
      kind: 'REFERRAL',
      dedupeKey: e.dedupeKey,
      payload: e.payload as Prisma.InputJsonValue,
      attempts: e.attempts + 1,
      claimToken,
      leaseUntil,
    })
    expect(hecho).toBe(true)
  }

  it('🔴 sin enganche post-commit: al volver la devolución el referido sigue calificado y su efecto, corrido DOS veces, lo revierte UNA', async () => {
    const { orderId, pago } = await ventaConComision(m)
    try {
      await activateReferralProgram({
        venueId: m.venueId,
        newCustomerDiscountPercent: 10,
        tier1ReferralsRequired: 1,
        tier2ReferralsRequired: 2,
        tier3ReferralsRequired: 3,
        tiers: [
          { tierLevel: 1, rewardType: 'PERCENT_COUPON', rewardPercent: 15 },
          { tierLevel: 2, rewardType: 'PERCENT_COUPON', rewardPercent: 20 },
          { tierLevel: 3, rewardType: 'PERCENT_COUPON', rewardPercent: 25 },
        ],
        rewardCouponExpiryDays: 90,
        codePrefix: 'TESTSMOKE',
      })
      const codigo = `TESTSMOKE-F4${process.pid}`
      const referidor = await prisma.customer.create({
        data: { venueId: m.venueId, firstName: 'Jose', lastName: 'F4', phone: '5599999401', referralCode: codigo },
      })
      const nuevo = await prisma.customer.create({ data: { venueId: m.venueId, firstName: 'María', lastName: 'F4', phone: '5599999402' } })
      const mesero = await prisma.staffVenue.findFirstOrThrow({ where: { venueId: m.venueId, staffId: m.ana }, select: { id: true } })
      const ref = await captureReferral({
        venueId: m.venueId,
        referralCode: codigo,
        newCustomerId: nuevo.id,
        capturedByStaffVenueId: mesero.id,
      })
      await prisma.order.update({ where: { id: orderId }, data: { customerId: nuevo.id } })
      await prisma.referral.update({ where: { id: ref.id }, data: { qualifyingOrderId: orderId } })
      await onOrderPaid({ orderId, venueId: m.venueId })
      expect((await prisma.referral.findUniqueOrThrow({ where: { id: ref.id } })).status).toBe('QUALIFIED')

      const r = await issueRefund({ venueId: m.venueId, paymentId: pago, amount: 10_000, reason: 'RETURNED_GOODS', staffId: m.owner })
      // La única vía es la obligación durable que la devolución encoló en su transacción: nada la adelanta después del commit.
      expect((await prisma.referral.findUniqueOrThrow({ where: { id: ref.id } })).status).toBe('QUALIFIED')
      const efecto = await prisma.paymentEffect.findFirstOrThrow({ where: { venueId: m.venueId, paymentId: r.refundId, kind: 'REFERRAL' } })
      await correrEfecto(efecto.id, 1)
      await correrEfecto(efecto.id, 2)

      const anulado = await prisma.referral.findUniqueOrThrow({ where: { id: ref.id } })
      expect([anulado.status, anulado.voidReason]).toEqual(['VOID', 'ORDER_REFUNDED'])
      const despuesDe = await prisma.customer.findUniqueOrThrow({ where: { id: referidor.id } })
      expect([despuesDe.referralCount, despuesDe.referralTier]).toEqual([0, null])
      expect(await prisma.activityLog.count({ where: { venueId: m.venueId, action: 'REFERRAL_TIER_REVERSED' } })).toBe(1)
      const premio = await prisma.discount.findUniqueOrThrow({ where: { id: anulado.rewardDiscountId! } })
      expect([premio.active, premio.deactivatedReason]).toEqual([false, 'TIER_REVERSED_BY_REFUND'])
    } finally {
      await prisma.order.update({ where: { id: orderId }, data: { customerId: null } })
      await cleanupReferralFixtureData(prisma, m.venueId)
    }
  })
})
