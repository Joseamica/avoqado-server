/**
 * IVA por producto, bloque B4b (fallo 4 de la ronda 6; Codex r4 R4-2, r5 R5-4): el comprobador de congelados de antes de desplegar
 * llama a las MISMAS funciones del reporte —`recorrerLibros`, con la misma composición y los mismos lotes—, y su «0 rechazados» sólo
 * vale si procesó completo el mismo universo. Contra Postgres REAL, en la base propia del bloque.
 */
import { Prisma } from '@prisma/client'

import { LOTE_DE_ORDENES, getIncomeStatement } from '@/services/dashboard/accounting.dashboard.service'
import * as libros from '@/services/fiscal/librosDeOrdenes'
import type { ParteDelLibro } from '@/services/fiscal/libroDeLaOrden'
import prisma from '@/utils/prismaClient'
import { contarCongeladosRechazados } from '../../../scripts/fiscal/b4b-congelados-que-no-caben'
import { conProducto, limpiarNegocios, nuevoNegocio, type Negocio } from './exclusionContable.fixtures'

const database = new URL(process.env.TEST_DATABASE_URL ?? '')
if (!['localhost', '127.0.0.1'].includes(database.hostname) || !/^\/(avoqado_[a-z0-9]+_test_|av_db_25_iva_test)/.test(database.pathname)) {
  throw new Error(
    'Esta suite escribe negocios de prueba: exige una base local propia (avoqado_<x>_test_… o av_db_25_iva_test), nunca av-db-25.',
  )
}
jest.setTimeout(120_000)

const CUANDO = new Date('2026-06-15T18:00:00.000Z')
const JUNIO = { from: '2026-06-01', to: '2026-06-30' }
let n = 0
let x: Negocio
let cabe: string
let noCabe: string

/** Una orden de café $116 (16 %) + grano $100 (0 %), cobrada; devuelve su id y los de sus renglones. */
async function cafeYGrano(cafe: string, grano: string) {
  const o = await prisma.order.create({
    data: { venueId: x.venueId, orderNumber: `B4B-C-${++n}-${Date.now()}`, subtotal: 0, taxAmount: 0, total: 0 },
  })
  const items: string[] = []
  for (const [productId, precio] of [
    [cafe, '116.00'],
    [grano, '100.00'],
  ] as const) {
    items.push(
      (
        await prisma.orderItem.create({
          data: {
            orderId: o.id,
            productId,
            productName: 'P',
            quantity: 1,
            unitPrice: new Prisma.Decimal(precio),
            taxAmount: 0,
            total: new Prisma.Decimal(precio),
          },
        })
      ).id,
    )
  }
  return { id: o.id, items }
}
const cobro = (orderId: string, monto: string, minuto: number, processorData?: Prisma.InputJsonValue) =>
  prisma.payment.create({
    data: {
      venueId: x.venueId,
      orderId,
      createdAt: new Date(CUANDO.getTime() + minuto * 60_000),
      amount: new Prisma.Decimal(monto),
      tipAmount: new Prisma.Decimal('0'),
      netAmount: new Prisma.Decimal(monto),
      method: 'CREDIT_CARD',
      status: 'COMPLETED',
      type: Number(monto) < 0 ? 'REFUND' : 'REGULAR',
      splitType: 'FULLPAYMENT',
      source: 'TPV',
      feePercentage: 0,
      feeAmount: new Prisma.Decimal('0'),
      processorData,
    },
  })
const ajuste = (porTratamiento: Record<string, { baseCents: number; ivaCents: number }>) => ({
  provenance: 'PROVIDER_ADJUSTMENT',
  fiscalByRateCents: { v: 2, porTratamiento },
})

beforeAll(async () => {
  x = await nuevoNegocio({ contabilidad: false })
  const { categoryId, productId: cafe } = await conProducto(x)
  const grano = (
    await prisma.product.create({
      data: { venueId: x.venueId, categoryId, sku: `GRANO-${x.rfc}`, name: 'Grano', price: 100, ivaTratamiento: 'IVA_0' },
    })
  ).id
  // Cabe: un ajuste de $116 que es exactamente el café.
  const a = await cafeYGrano(cafe, grano)
  await cobro(a.id, '216.00', 0)
  await cobro(a.id, '-116.00', 1, ajuste({ IVA_16: { baseCents: 10000, ivaCents: 1600 } }))
  cabe = a.id
  // No cabe (el escenario R4-1): se devolvió a mano el grano y luego llega un congelado que pide $100 del 0 %.
  const b = await cafeYGrano(cafe, grano)
  await cobro(b.id, '216.00', 0)
  await cobro(b.id, '-100.00', 1, { provenance: 'MANUAL', refundedItems: [{ orderItemId: b.items[1], quantity: 1, amountCents: 10000 }] })
  await cobro(b.id, '-100.00', 2, ajuste({ IVA_0: { baseCents: 10000, ivaCents: 0 } }))
  noCabe = b.id
})
afterAll(() => limpiarNegocios())
afterEach(() => jest.restoreAllMocks())

/** Espía `recorrerLibros` (la de verdad corre) y anota qué movimientos salieron con `congeladoRechazado`. */
function anotarRechazos() {
  const real = libros.recorrerLibros
  const rechazados: string[] = []
  const espia = jest.spyOn(libros, 'recorrerLibros').mockImplementation((tx, q, cb) =>
    real(tx, q, (m, parte: ParteDelLibro) => {
      if (parte.congeladoRechazado) rechazados.push(m.id)
      cb(m, parte)
    }),
  )
  return { rechazados, espia }
}

it('🔴 el comprobador procesa todo su universo y cuenta EXACTAMENTE lo que rechaza el reporte, con la misma función', async () => {
  const delReporte = anotarRechazos()
  await getIncomeStatement(x.venueId, JUNIO)
  const vistosPorElReporte = [...delReporte.rechazados]
  jest.restoreAllMocks()

  const delComprobador = anotarRechazos()
  const r = await contarCongeladosRechazados({ venueIds: [x.venueId] })
  expect(r).toMatchObject({ ordenesEsperadas: 2, ordenesProcesadas: 2, congeladosRechazados: 1, ordenesConRechazo: [noCabe] })
  expect(delComprobador.rechazados).toEqual(vistosPorElReporte) // mismo movimiento, misma decisión
  expect(delComprobador.rechazados).toHaveLength(1)
  // Los mismos lotes que el reporte: nunca más de LOTE_DE_ORDENES órdenes por llamada.
  expect(delComprobador.espia.mock.calls.every(c => c[1].orderIds.length <= LOTE_DE_ORDENES)).toBe(true)
  expect(new Set(delComprobador.espia.mock.calls.flatMap(c => c[1].orderIds))).toEqual(new Set([cabe, noCabe]))
})

it('🔴 si una orden del universo no se procesó, no hay veredicto: un «0» a medias no vale', async () => {
  const real = libros.recorrerLibros
  jest
    .spyOn(libros, 'recorrerLibros')
    .mockImplementationOnce((tx, q, cb) => real(tx, { ...q, orderIds: q.orderIds.filter(id => id !== noCabe) }, cb))
  await expect(contarCongeladosRechazados({ venueIds: [x.venueId] })).rejects.toThrow(/no se procesó todo el universo/)
})
