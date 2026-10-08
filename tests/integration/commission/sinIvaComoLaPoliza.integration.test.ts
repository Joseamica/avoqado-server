// tests/integration/commission/sinIvaComoLaPoliza.integration.test.ts
/**
 * Fase 3 de Pago al personal, final-fix I1 (revisión final de la rama, `task-final-review-report.md`), contra Postgres REAL y
 * por el camino de la terminal (efecto durable + worker): la comisión «sin IVA» es EXACTAMENTE la venta neta de la póliza
 * contable de develop (`grossByRateFromOrder`), también con descuentos B2 dirigidos, cortesías del POS móvil, cargos no
 * gravables, ventas por peso y renglones sellados. Y los lectores de lo guardado (el reverso de una devolución y el KPI
 * «Calculado») heredan esa base sin volver a calcular el IVA.
 *
 * Correr: TZ=UTC TEST_DATABASE_URL="$PAGO_F3_DB" npx jest --selectProjects integration \
 *   --runTestsByPath tests/integration/commission/sinIvaComoLaPoliza.integration.test.ts --ci --runInBand
 */
import prisma from '@/utils/prismaClient'
import { createSplitCommissionForPayment, getVenueCommissionStats } from '@/services/dashboard/commission/commission-calculation.service'
import { resumenesCalculados } from '@/services/dashboard/commission/resumenesCalculados'
import {
  asegurarBaseDePrueba,
  borrarMundoComisiones,
  categoria,
  cobro,
  crearMundoComisiones,
  devolver,
  MundoComisiones,
  netoVivo,
  orden,
  planear,
  procesarEfectos,
  type VentaDePrueba,
  ventaNetaDeLaPoliza,
} from './_mundoComisiones'

let m: MundoComisiones
beforeAll(asegurarBaseDePrueba)
afterEach(async () => {
  const mundo = m
  m = undefined as unknown as MundoComisiones
  await borrarMundoComisiones(mundo)
})

/** Un cobro de la orden, congelado y materializado como lo hace la terminal; devuelve su fila de comisión. */
async function cobrar(orderId: string, monto: number) {
  const p = await cobro(m, orderId, monto)
  await planear(p)
  await procesarEfectos(m)
  return { p, fila: await prisma.commissionCalculation.findFirstOrThrow({ where: { venueId: m.venueId, paymentId: p } }) }
}

type Caso = [string, (cat: string) => VentaDePrueba, number, string]

describe('final-fix I1 · «Lo cobrado» sin IVA = la venta neta de la póliza de develop (Postgres real)', () => {
  it.each<Caso>([
    [
      '🔴 B2 de $100 dirigido al exento: $116 al 16 % + $100 exento, paga $116 ⇒ $100 (la rama daba $107.41)',
      cat => ({
        subtotal: 216,
        discountAmount: 100,
        renglones: [
          { categoryId: cat, precio: 116 },
          { categoryId: cat, precio: 100, tratamiento: 'EXENTO' },
        ],
        dirigidos: [{ monto: 100, renglon: 1 }],
      }),
      116,
      '100.00',
    ],
    [
      '🔴 cortesía del POS móvil de $116 al 16 % + $100 exento, paga $100 ⇒ $100 (la rama daba $92.59)',
      cat => ({
        subtotal: 100,
        renglones: [
          { categoryId: cat, precio: 116, cortesia: true },
          { categoryId: cat, precio: 100, tratamiento: 'EXENTO' },
        ],
      }),
      100,
      '100.00',
    ],
    [
      '🔴 cargo NO gravable de $10 sobre $116 al 16 %, paga $126 ⇒ $110 (la rama daba $108.62)',
      cat => ({ subtotal: 116, renglones: [{ categoryId: cat, precio: 116 }], cargos: [{ monto: 10, gravable: false }] }),
      126,
      '110.00',
    ],
    [
      '🔴 peso: $116/kg × 0.5 kg al 16 % + $100 exento, paga $158 ⇒ $150 (la rama daba $146.30)',
      cat => ({
        subtotal: 158,
        renglones: [
          { categoryId: cat, precio: 116, kilos: 0.5 },
          { categoryId: cat, precio: 100, tratamiento: 'EXENTO' },
        ],
      }),
      158,
      '150.00',
    ],
    [
      '🔴 renglón SELLADO exento con su producto al 16 %, paga $116 ⇒ $116 (la rama daba $100)',
      cat => ({ subtotal: 116, renglones: [{ categoryId: cat, precio: 116, sellado: 'EXENTO' }] }),
      116,
      '116.00',
    ],
    [
      'regresión: cargo GRAVABLE de $11.60 sobre $116 al 16 %, paga $127.60 ⇒ $110',
      cat => ({ subtotal: 116, renglones: [{ categoryId: cat, precio: 116 }], cargos: [{ monto: 11.6, gravable: true }] }),
      127.6,
      '110.00',
    ],
  ])('%s', async (_n, venta, monto, base) => {
    m = await crearMundoComisiones('i1', { includeTax: false })
    const orderId = await orden(m, venta(await categoria(m)))
    const { p, fila } = await cobrar(orderId, monto)
    expect(fila.baseAmount.toFixed(2)).toBe(base)
    expect(fila.baseAmount.toFixed(2)).toBe(await ventaNetaDeLaPoliza(p))
    // El IVA que guarda la fila es el de la póliza: base + IVA = lo cobrado.
    expect(fila.baseAmount.plus(fila.taxAmount).toFixed(2)).toBe(monto.toFixed(2))
  })

  it('🔴 la dividida entre dos personas reparte la MISMA base de la póliza: B2 dirigido ⇒ $50 y $50', async () => {
    m = await crearMundoComisiones('i1-dividida', { includeTax: false })
    const cat = await categoria(m)
    const orderId = await orden(m, {
      subtotal: 216,
      discountAmount: 100,
      renglones: [
        { categoryId: cat, precio: 116 },
        { categoryId: cat, precio: 100, tratamiento: 'EXENTO' },
      ],
      dirigidos: [{ monto: 100, renglon: 1 }],
    })
    const p = await cobro(m, orderId, 116)
    await createSplitCommissionForPayment(p, [m.ana, m.bea])
    const filas = await prisma.commissionCalculation.findMany({ where: { venueId: m.venueId, paymentId: p }, take: 10 })
    expect(filas.map(f => f.baseAmount.toFixed(2))).toEqual(['50.00', '50.00'])
    expect(await ventaNetaDeLaPoliza(p)).toBe('100.00')
  })
})

describe('final-fix I1 · los lectores de lo guardado heredan la base de la póliza (reverso, KPI «Calculado», resumen)', () => {
  it('🔴 B2 dirigido: devolver la mitad revierte $50 de base y $5 de comisión; el KPI y el resumen dicen $5', async () => {
    m = await crearMundoComisiones('i1-reverso', { includeTax: false })
    const cat = await categoria(m)
    const orderId = await orden(m, {
      subtotal: 216,
      discountAmount: 100,
      renglones: [
        { categoryId: cat, precio: 116 },
        { categoryId: cat, precio: 100, tratamiento: 'EXENTO' },
      ],
      dirigidos: [{ monto: 100, renglon: 1 }],
    })
    const { p, fila } = await cobrar(orderId, 116)
    expect([fila.baseAmount.toFixed(2), fila.netCommission.toFixed(2)]).toEqual(['100.00', '10.00'])
    const dev = await devolver(m, p, 58)
    await procesarEfectos(m)
    const reverso = await prisma.commissionCalculation.findFirstOrThrow({ where: { venueId: m.venueId, paymentId: dev } })
    expect([reverso.baseAmount.toFixed(2), reverso.taxAmount.toFixed(2), reverso.netCommission.toFixed(2)]).toEqual([
      '-50.00',
      '-8.00',
      '-5.00',
    ])
    expect(await netoVivo({ venueId: m.venueId, orderId })).toBe('5.00')
    expect((await getVenueCommissionStats(m.venueId)).totalCalculated.toFixed(2)).toBe('5.00')
    const { filas } = await resumenesCalculados(m.venueId, { periodStart: new Date('2026-01-01T06:00:00Z') })
    expect(filas.map(f => [f.totalSales.toFixed(2), f.netAmount.toFixed(2)])).toEqual([['50.00', '5.00']])
  })
})
