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
  borrarMundoComisiones,
  cobro,
  crearMundoComisiones,
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
