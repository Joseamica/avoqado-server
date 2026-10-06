// tests/integration/commission/reversos.integration.test.ts
/**
 * Fase 3 de pago por servicio, Bloque A — devoluciones y anulaciones de comisiones contra Postgres REAL, por el camino
 * durable (efecto + worker) y con la anulación única. Spec §6.4, §9-2…§9-6; casos 11-14 y 20 del §13.
 *
 * Correr: TZ=UTC TEST_DATABASE_URL="$PAGO_F3_DB" npx jest --selectProjects integration \
 *   --runTestsByPath tests/integration/commission/reversos.integration.test.ts --ci
 */
import { CommissionCalculation, Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { issueRefund } from '@/services/dashboard/refund.dashboard.service'
import * as calculo from '@/services/dashboard/commission/commission-calculation.service'
import { createCommissionForPayment, voidCommissionCalculation } from '@/services/dashboard/commission/commission-calculation.service'
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
