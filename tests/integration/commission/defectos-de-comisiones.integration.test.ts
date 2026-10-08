// tests/integration/commission/defectos-de-comisiones.integration.test.ts
/**
 * Medición de los defectos del módulo de comisiones (spec de pago por servicio §11; fase 3 §5), contra Postgres REAL,
 * reescrita para el diseño de la fase 3 (Tarea A4). Cada prueba afirma el comportamiento CORRECTO.
 *
 *   H2a  `applyClawbacksToSummary` recortaba la deuda a 0. No tenía llamadores: se BORRÓ.
 *   H2b  el clawback capturado en el dashboard no descontaba nada. Ahora ANULA la comisión, con sus reversos, con la
 *        operación única; el siguiente sobre de Pago al personal le resta lo que ya se le pagó (Bloque B).
 *   H2c  anular una comisión ya sumada la dejaba en el resumen. Ahora el resumen se recalcula.
 *
 * Lo que ya no se mide aquí:
 *   H1, H5  se fueron con el flujo de pagos viejo (fase 3, E1a): sus rutas responden 410 MOVIDO_A_PAGO_AL_PERSONAL. La prueba
 *           vive en tests/unit/routes/commissionRoutes.retiradas.test.ts; el sobre paga cada fila una sola vez (índice único
 *           de ServiceEarning, Bloque B).
 *   H3      el agregador suma antes de marcar: queda documentado (spec §5); ya no mueve dinero porque el sobre lee filas.
 *
 * Correr: TZ=UTC TEST_DATABASE_URL="$PAGO_F3_DB" npx jest --selectProjects integration \
 *   --runTestsByPath tests/integration/commission/defectos-de-comisiones.integration.test.ts --ci
 */
import { ClawbackReason } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import * as clawbacks from '@/services/dashboard/commission/commission-clawback.service'
import { voidCommissionCalculation } from '@/services/dashboard/commission/commission-calculation.service'
import {
  asegurarBaseDePrueba,
  borrarMundoComisiones,
  crearMundoComisiones,
  devolver,
  MundoComisiones,
  netoVivo,
  procesarEfectos,
  sumadaAUnResumen,
  ventaConComision,
} from './_mundoComisiones'

jest.mock('@/services/shared/cashDrawerPosting', () => ({ postCashRefundToDrawer: jest.fn().mockResolvedValue(undefined) }))

let m: MundoComisiones
beforeAll(asegurarBaseDePrueba)
beforeEach(async () => {
  m = await crearMundoComisiones('defectos')
})
afterEach(() => borrarMundoComisiones(m))

const resumenNeto = async (id: string) => (await prisma.commissionSummary.findUniqueOrThrow({ where: { id } })).netAmount.toFixed(2)

describe('H2 · la deuda de un clawback ya no se pierde', () => {
  it('H2a: las funciones que la perdían ya no existen', () => {
    expect((clawbacks as unknown as Record<string, unknown>).applyClawbacksToSummary).toBeUndefined()
    expect((clawbacks as unknown as Record<string, unknown>).createRefundClawback).toBeUndefined()
  })

  it('🔴 H2b: el clawback sobre una comisión cuyo resumen ya se PAGÓ la anula con su reverso y no crea CommissionClawback', async () => {
    const { orderId, pago, comision } = await ventaConComision(m)
    const resumen = await sumadaAUnResumen(m, comision.id, comision.staffId, 10, 'PAID')
    await devolver(m, pago, 40)
    await procesarEfectos(m)

    const r = await clawbacks.createClawback(comision.id, m.venueId, { reason: ClawbackReason.REFUND }, m.owner)

    expect(r).toMatchObject({ voided: true, calculationId: comision.id })
    expect(r.anuladas).toHaveLength(2)
    expect(await prisma.commissionClawback.count({ where: { calculation: { venueId: m.venueId } } })).toBe(0)
    expect(await netoVivo({ venueId: m.venueId, orderId })).toBe('0.00')
    // El resumen PAGADO por el flujo viejo no se reescribe: lo que ya se pagó lo descuenta el siguiente sobre (Bloque B).
    expect(await resumenNeto(resumen)).toBe('10.00')
  })

  it('🔴 H2b: con motivo CORRECTION también anula (antes creaba un CommissionClawback que nadie aplicaba)', async () => {
    const { comision } = await ventaConComision(m)
    await sumadaAUnResumen(m, comision.id, comision.staffId, 10)
    const r = await clawbacks.createClawback(comision.id, m.venueId, { reason: ClawbackReason.CORRECTION, notes: 'Otra persona' }, m.owner)
    expect(r).toEqual({ voided: true, calculationId: comision.id, anuladas: [comision.id] })
    expect(await prisma.commissionClawback.count({ where: { calculation: { venueId: m.venueId } } })).toBe(0)
  })

  it('🔴 H2c: anular con un clawback una comisión ya sumada y sin pagar la quita del resumen', async () => {
    const { comision } = await ventaConComision(m)
    const resumen = await sumadaAUnResumen(m, comision.id, comision.staffId, 10)
    await clawbacks.createClawback(comision.id, m.venueId, { reason: ClawbackReason.REFUND }, m.owner)
    expect(await resumenNeto(resumen)).toBe('0.00')
  })

  it('🔴 H2c por la otra entrada (anular desde Comisiones): el resumen queda en $0 y sin cobros', async () => {
    const { comision } = await ventaConComision(m)
    const resumen = await sumadaAUnResumen(m, comision.id, comision.staffId, 10)
    await voidCommissionCalculation(comision.id, m.venueId, m.owner, 'Venta capturada por error')
    const s = await prisma.commissionSummary.findUniqueOrThrow({ where: { id: resumen } })
    expect([s.totalCommissions.toFixed(2), s.netAmount.toFixed(2), s.paymentCount]).toEqual(['0.00', '0.00', 0])
  })
})
