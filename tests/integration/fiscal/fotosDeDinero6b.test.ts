/**
 * Plan 6b (spec §5.8, condición del founder 24-sep): encender el IVA por producto NO mueve un peso. Foto de cada número de dinero por los
 * servicios reales → extracción de la global → foto → encender pasando un producto de 16 % a 0 % → foto. Las tres, idénticas. Un número
 * que se mueva DETIENE el plan: se reporta, no se ajusta la prueba.
 */
jest.mock('@/mcp/planGate', () => ({ planGateMessage: jest.fn().mockResolvedValue(null) }))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({ venueFilter: (v: string) => ({ venueId: { in: [v] } }), requirePermission: jest.fn() }),
}))
// Antes del 2026-10-31 la observación de 30 días de los aparatos no se cumple: se da por cumplida (su valor real lo prueba la Tarea 3).
jest.mock('@/services/mobile/deviceRegistry.service', () => ({
  ...jest.requireActual('@/services/mobile/deviceRegistry.service'),
  OBSERVADOR_POS_DESDE: new Date('2026-08-01T00:00:00Z'),
}))
// El PAC y el almacenamiento, siempre dobles de prueba (Facturapi nunca real).
jest.mock('@/services/fiscal/fiscalProvider.factory', () => ({ resolveFiscalProvider: jest.fn() }))
jest.mock('@/services/storage.service', () => ({
  ...jest.requireActual('@/services/storage.service'),
  uploadFileToStorage: jest.fn(async () => 'https://test/file'),
}))
// Lo que el servicio móvil de órdenes toca fuera de la base (como `repartoDescuento.integration.test.ts`).
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() },
}))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn().mockResolvedValue({ notified: 0 }),
}))
jest.setTimeout(180_000)

import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { resolveScope } from '@/mcp/scope'
import { registerCommissionTools } from '@/mcp/tools/commissions'
import { registerCustomerTools } from '@/mcp/tools/customers'
import { registerLoyaltyTools } from '@/mcp/tools/loyalty'
import { registerPaymentTools } from '@/mcp/tools/payments'
import { registerProductTools } from '@/mcp/tools/products'
import { registerSalesTools } from '@/mcp/tools/sales'
import { registerShiftTools } from '@/mcp/tools/shifts'
import { getBusinessSummary } from '@/services/dashboard/accounting.dashboard.service'
import { updateProduct } from '@/services/dashboard/product.dashboard.service'
import { issueCfdiForOrder } from '@/services/fiscal/cfdi.service'
import { olvidarGlobalesEvaluadas } from '@/services/fiscal/cfdiCreditNote.service'
import { issueGlobalForEmisor } from '@/services/fiscal/cfdiGlobal.service'
import * as finalizadorCfdi from '@/services/fiscal/finalizadorCfdi'
import { resolveFiscalProvider } from '@/services/fiscal/fiscalProvider.factory'
import { redeemPointsToOrder } from '@/services/mobile/loyalty.mobile.service'
import { createOrderWithItems as crearEnMovil } from '@/services/mobile/order.mobile.service'
import { abrirTurnoDeCaja, cerrarTurnoDeCaja } from '@/services/shared/turnoDeCaja'
import { xmlDeLaFila } from '../../__helpers__/xml-del-pac'
import {
  asegurarBaseDePrueba,
  borrarMundoComisiones,
  categoria,
  cobro,
  crearMundoComisiones,
  despues,
  devolver,
  orden,
  planear,
  procesarEfectos,
  type MundoComisiones,
} from '../commission/_mundoComisiones'

/**
 * Lo que cambia solo con el reloj (fechas de consulta, `generatedAt`, los días que lleva un corte…) no es dinero: fuera. Todo lo demás se
 * compara completo. En las herramientas de esta foto la regla sólo quita tres campos: `date` (la fecha de una orden), `at` (la hora de un
 * cobro) y `daysSinceLastCloseout` (días desde el alta del negocio, que cambiaría si la corrida cruzara la medianoche UTC).
 */
const RELOJ = /(At|Date|fecha|timestamp|generated|daysSinceLastCloseout)$/i
const limpia = (v: unknown): unknown =>
  Prisma.Decimal.isDecimal(v)
    ? v.toString() // los importes de `Shift` vienen como Decimal: se comparan (y se leen en un fallo) como número, no como sus dígitos internos
    : Array.isArray(v)
      ? v.map(limpia)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v as object)
              .filter(([k]) => !RELOJ.test(k))
              .map(([k, x]) => [k, limpia(x)]),
          )
        : v

// Las herramientas se registran en un servidor falso y se llaman directo (como write-confirm-gating.test.ts).
const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const servidor = { tool: (n: string, _d: unknown, _s: unknown, h: never) => handlers.set(n, h) } as never
const llamar = async (n: string, a: Record<string, unknown>) => JSON.parse((await handlers.get(n)!(a, {})).content[0].text)

/** Los cobros caen el 1 de octubre (hora del negocio); la devolución, el 2: `DESDE`/`HASTA` los cubren y `DIAS` = cada día con movimiento. */
const DESDE = '2026-10-01'
const HASTA = '2026-10-02'
const DIAS = [DESDE, HASTA]
const DEVOLUCION_EL = new Date('2026-10-02T16:00:00Z')
/** «Hoy» de la factura global: octubre ya cerró. */
const GLOBAL_EN = new Date('2026-11-03T17:00:00Z')

async function foto(venueId: string, clienteEmail: string) {
  const r = (n: string, a: Record<string, unknown> = {}) => llamar(n, { venueId, ...a })
  const rango = { fromDate: DESDE, toDate: HASTA }
  const resumen = await getBusinessSummary(venueId, { from: DESDE, to: HASTA })
  return limpia({
    ventas: await Promise.all(DIAS.map(date => r('daily_sales', { date }))),
    porMetodo: await r('sales_by_payment_method', rango),
    propinas: await r('staff_tips', rango),
    comisiones: await r('staff_commission', rango),
    lealtad: await r('loyalty_status'),
    puntosDelCliente: await r('customer_history', { search: clienteEmail }),
    corte: await r('cash_closeout'),
    cobros: await r('list_payments', { ...rango, limit: 100 }), // el máximo del contrato (payments.ts:193)
    devoluciones: await r('list_refunds', { ...rango, limit: 100 }), // ídem (:297)
    productos: await r('product_sales', { ...rango, name: 'Café' }),
    cobro: { collection: resumen.collection, tips: resumen.tips, costs: resumen.costs, metrics: resumen.metrics },
    // Codex r1 P2-9: los números del TURNO, no sólo el corte.
    turnos: await prisma.shift.findMany({
      where: { venueId },
      orderBy: { id: 'asc' },
      take: 100,
      select: {
        id: true,
        status: true,
        startingCash: true,
        endingCash: true,
        cashDifference: true,
        cashDeclared: true,
        cardDeclared: true,
        totalSales: true,
        totalTips: true,
        totalCashTips: true,
        totalCashPayments: true,
        totalCardPayments: true,
      },
    }),
  })
}

// ─── Lo sembrado, en CENTAVOS: de aquí salen las cuentas de la siembra y lo que `esperarLoSembrado` exige ───────────────────────────────
/** Cada cuenta, con su descuento ya aplicado. El café vale $116 con IVA incluido (base $100). */
const CUENTA = {
  v0: 11_600, // efectivo, con propina
  v1: 10_440, // efectivo, descuento de RENGLÓN: 10 % al café ($11.60)
  v2: 20_880, // efectivo, descuento de CUENTA de $23.20 sobre dos cafés
  v3: 17_400, // efectivo, PROMOCIÓN: combo café + pan a $174
  v4: 10_440, // efectivo, LEALTAD: canje de 1,160 puntos ($11.60)
  t1: 23_200, // tarjeta, dos cafés, con propina y con la devolución parcial
  t2: 11_600, // tarjeta, un café: de este ticket sale la extracción de la global
}
const PROPINA = { v0: 1_000, t1: 2_000 }
const COMISION_DEL_PROCESADOR = { t1: 580, t2: 290 }
const DEVUELTO = 11_600 // un café de T1, con tarjeta
const FONDO = 50_000
const FALTANTE = 500 // el cajero cuenta $5 menos de lo esperado
const PUNTOS = { antes: 5_000, canjeados: 1_160 }

const suma = (...xs: number[]) => xs.reduce((s, x) => s + x, 0)
const EFECTIVO = suma(CUENTA.v0, CUENTA.v1, CUENTA.v2, CUENTA.v3, CUENTA.v4)
const TARJETA = suma(CUENTA.t1, CUENTA.t2)
const PROPINAS = suma(PROPINA.v0, PROPINA.t1)
const COMISIONES_DEL_PROCESADOR = suma(COMISION_DEL_PROCESADOR.t1, COMISION_DEL_PROCESADOR.t2)
const VENDIDO = EFECTIVO + TARJETA
/** La base de la comisión es la venta SIN IVA (a 16 %) y neta de lo devuelto; la comisión, el 10 % de esa base. */
const BASE_COMISION = Math.round((VENDIDO - DEVUELTO) / 1.16)

const c = (pesos: number) => Math.round(pesos * 100)
const enCentavos = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, c(v)]))
const pesos = (centavos: number) => centavos / 100

/** Lo que `sembrar()` deja en la base, en centavos, derivado de las cuentas de arriba (nada se lee de las herramientas que se prueban). */
const esperado = {
  // Por día: la devolución (2 de octubre) cuenta como un cobro negativo.
  porDia: {
    [DESDE]: { ventas: 7, centavos: VENDIDO, porMetodo: { CASH: EFECTIVO, CREDIT_CARD: TARJETA } },
    [HASTA]: { ventas: 1, centavos: -DEVUELTO, porMetodo: { CREDIT_CARD: -DEVUELTO } },
  } as Record<string, { ventas: number; centavos: number; porMetodo: Record<string, number> }>,
  cobros: 7,
  devoluciones: 1,
  filasDeCobros: 8, // las siete ventas y la devolución
  vendido: VENDIDO,
  devuelto: DEVUELTO,
  propinas: PROPINAS,
  conPropina: 2,
  comisionesDelProcesador: COMISIONES_DEL_PROCESADOR,
  // Efectivo y tarjeta: lo cobrado con propina y neto de la devolución (`grossCollected`) y las ventas netas (`netSales`).
  cobrado: { CASH: EFECTIVO + PROPINA.v0, CREDIT_CARD: TARJETA + PROPINA.t1 - DEVUELTO },
  cuantos: { CASH: 5, CREDIT_CARD: 3 }, // las dos ventas con tarjeta y la devolución
  netas: { CASH: EFECTIVO, CREDIT_CARD: TARJETA - DEVUELTO },
  // Comisión: siete ventas más el reverso de la devolución, de una sola persona.
  comision: { calculos: 8, base: BASE_COMISION, comision: Math.round(BASE_COMISION / 10) },
  puntosDelCliente: PUNTOS.antes - PUNTOS.canjeados,
  cuentaDelCanje: CUENTA.v4,
  // Corte de caja: el efectivo que debe haber (ventas en efectivo más su propina) y cuántos cobros lo forman.
  corte: { esperado: EFECTIVO + PROPINA.v0, cobros: 5 },
  // El café: nueve piezas en ocho renglones, a su precio NETO (`lineRevenueSql`). Desde el 24-oct (descuento en ligas, Tarea 0) el renglón
  // resta también su parte (`reparto.renglones`) de cada descuento que no es espejo: el de CUENTA de V2 ($23.20) y el canje de V4 ($11.60)
  // ya bajan el café, como el de renglón de V1. El combo de V3 aporta la mitad. Σ café + pan del combo (V3 / 2) = VENDIDO.
  cafe: { piezas: 9, renglones: 8, vendido: suma(11_600, CUENTA.v1, CUENTA.v2, CUENTA.v3 / 2, CUENTA.v4, CUENTA.t1, CUENTA.t2) },
  // El turno cerrado con conteo (la devolución, del día siguiente, ya no entró).
  turno: {
    startingCash: FONDO,
    totalSales: VENDIDO,
    totalTips: PROPINAS,
    totalCashTips: PROPINA.v0,
    totalCashPayments: EFECTIVO,
    totalCardPayments: TARJETA,
    endingCash: FONDO + EFECTIVO + PROPINA.v0 - FALTANTE,
    cashDifference: -FALTANTE,
  },
}

/** La foto no vale si no VIO el dinero sembrado: conteos e importes por familia, con los nombres de campo reales de cada herramienta. */
function esperarLoSembrado(f: any, e: typeof esperado) {
  // Cada día con movimiento (Codex r2: `ventas` es un arreglo, uno por día): su número de ventas, su total y su reparto por método.
  expect(
    DIAS.map((_, i) => ({
      ventas: f.ventas[i].completedCount,
      centavos: c(f.ventas[i].gross),
      porMetodo: enCentavos(f.ventas[i].byMethod),
    })),
  ).toEqual(DIAS.map(d => e.porDia[d]))
  // Cobros y devoluciones, tal como las listan `list_payments` y `list_refunds`.
  expect({
    cobros: f.cobros.summary.completed.count,
    vendido: c(f.cobros.summary.completed.gross),
    propinas: c(f.cobros.summary.completed.tips),
    comisionesDelProcesador: c(f.cobros.summary.completed.processorFees),
    devoluciones: f.cobros.summary.refunds.count,
    devuelto: c(f.cobros.summary.refunds.amount),
    filas: f.cobros.count,
  }).toEqual({
    cobros: e.cobros,
    vendido: e.vendido,
    propinas: e.propinas,
    comisionesDelProcesador: e.comisionesDelProcesador,
    devoluciones: e.devoluciones,
    devuelto: -e.devuelto,
    filas: e.filasDeCobros,
  })
  expect({
    devoluciones: f.devoluciones.summary.count,
    devuelto: c(f.devoluciones.summary.totalRefunded),
    metodo: f.devoluciones.refunds[0].method,
    estadoDeLaVenta: f.devoluciones.refunds[0].refundState,
  }).toEqual({ devoluciones: e.devoluciones, devuelto: e.devuelto, metodo: 'CREDIT_CARD', estadoDeLaVenta: 'PARTIAL' })
  // Propina: la sembrada, atribuida a quien cobró (una sola persona), en `staff_tips` y en el resumen del negocio.
  expect({
    total: c(f.propinas.total),
    conPropina: f.propinas.tippedPayments,
    quien: f.propinas.staff.map((s: { tips: number }) => c(s.tips)),
  }).toEqual({ total: e.propinas, conPropina: e.conPropina, quien: [e.propinas] })
  expect(f.cobro.tips.totalCents).toBe(e.propinas)
  // Efectivo y tarjeta.
  const porMetodo = (filas: Array<{ method: string; total: number; count: number }>, campo: 'total' | 'count') =>
    Object.fromEntries(filas.map(m => [m.method, campo === 'total' ? c(m.total) : m.count]))
  expect({
    cobrado: porMetodo(f.porMetodo.grossCollected.byMethod, 'total'),
    cuantos: porMetodo(f.porMetodo.grossCollected.byMethod, 'count'),
    netas: porMetodo(f.porMetodo.netSales.byMethod, 'total'),
  }).toEqual({ cobrado: e.cobrado, cuantos: e.cuantos, netas: e.netas })
  // Comisión neta (venta menos reverso).
  expect(f.comisiones.staff).toHaveLength(1)
  expect({
    calculos: f.comisiones.staff[0].count,
    base: c(f.comisiones.staff[0].totalBase),
    comision: c(f.comisiones.staff[0].totalCommission),
  }).toEqual(e.comision)
  // Lealtad: el programa sembrado y los puntos que le quedan al cliente tras el canje.
  expect(f.lealtad.program).toMatchObject({ active: true, redemptionRate: 0.01, minPointsToRedeem: 100 })
  expect(f.puntosDelCliente).toMatchObject({
    found: true,
    customer: { loyaltyPoints: e.puntosDelCliente },
    orderCount: 1,
    orders: [{ total: pesos(e.cuentaDelCanje) }],
  })
  // Corte de caja.
  expect({ esperado: c(f.corte.currentDrawer.expectedCash), cobros: f.corte.currentDrawer.cashTransactions }).toEqual(e.corte)
  // El café.
  expect({ piezas: f.productos.unitsSold, renglones: f.productos.timesOrdered, vendido: c(f.productos.revenue) }).toEqual(e.cafe)
  // Resumen del negocio, sus partes de cobro.
  expect(f.cobro).toEqual({
    collection: {
      cashCents: e.netas.CASH,
      electronicCents: e.netas.CREDIT_CARD,
      cashPct: Math.round((100 * e.netas.CASH) / (e.netas.CASH + e.netas.CREDIT_CARD)),
    },
    tips: { totalCents: e.propinas },
    costs: { processingFeesCents: e.comisionesDelProcesador },
    metrics: { salesCount: e.cobros, refundCount: e.devoluciones, averageTicketCents: Math.round(e.vendido / e.cobros) },
  })
  // El turno cerrado con conteo: sus totales son los sembrados.
  expect(f.turnos).toHaveLength(1)
  expect(f.turnos[0].status).toBe('CLOSED')
  const dinero = (k: string) => c(Number(f.turnos[0][k]))
  expect(Object.fromEntries(Object.keys(e.turno).map(k => [k, dinero(k)]))).toEqual(e.turno)
}

const receptor = { rfc: 'EKU9003173C9', razonSocial: 'ESCUELA KEMPER URGATE', regimenFiscal: '601', codigoPostal: '64000', usoCfdi: 'G03' }
const valid = () => ({
  providerInvoiceId: randomUUID(),
  uuid: randomUUID(),
  serie: 'F',
  folio: String(Math.floor(Math.random() * 1e6)),
  totalCents: 0,
  stampedAt: new Date(),
  status: 'valid' as const,
})
const provider = {
  name: 'facturapi',
  createInvoice: jest.fn(),
  createGlobalInvoice: jest.fn(),
  createCreditNote: jest.fn(),
  cancelInvoice: jest.fn(),
  findByExternalId: jest.fn(),
  getInvoice: jest.fn(),
  downloadXml: jest.fn(),
  downloadPdf: jest.fn(),
}

let mundo: MundoComisiones | undefined

/** Un negocio APAGADO con emisor fiscal, sembrado por los servicios reales hasta una factura global timbrada. */
async function sembrar() {
  asegurarBaseDePrueba()
  olvidarGlobalesEvaluadas()
  finalizadorCfdi.olvidarReparaciones() // la reparación compartida recuerda en memoria del proceso
  jest.mocked(resolveFiscalProvider).mockReturnValue(provider as never)
  for (const f of Object.values(provider)) if (typeof f === 'function') (f as jest.Mock).mockReset()
  provider.createInvoice.mockImplementation(async () => valid())
  provider.createGlobalInvoice.mockImplementation(async () => valid())
  provider.createCreditNote.mockImplementation(async () => valid())
  provider.findByExternalId.mockResolvedValue(null)
  provider.getInvoice.mockResolvedValue(null)
  provider.downloadXml.mockImplementation(async (id: string) => xmlDeLaFila(prisma, id))
  provider.downloadPdf.mockResolvedValue(Buffer.from('%PDF'))

  // 1 · el negocio: comisión de 10 % SIN IVA (si dependiera del IVA vivo, esta prueba lo atrapa); el café al 16 % lo deja APAGADO.
  const m = (mundo = await crearMundoComisiones('fotos6b', { includeTax: false }))
  const { venueId } = m
  // Existe desde antes de la siembra (el corte de caja cuenta desde el alta) y con los permisos de plan de un negocio de la casa.
  await prisma.venue.update({ where: { id: venueId }, data: { createdAt: new Date('2026-09-29T00:00:00Z'), seatCapExempt: true } })
  const categoryId = await categoria(m)
  const producto = (name: string, sku: string) =>
    prisma.product.create({ data: { venueId, categoryId, name, sku: `${m.key}-${sku}`, price: 116 } }).then(p => p.id)
  const cafeId = await producto('Café en grano', 'cafe') // 16 %: el producto que la prueba pasa a 0 %
  const panId = await producto('Pan dulce', 'pan')
  const clienteEmail = `cliente-${m.key}@example.test`
  const ana = m.ana

  // Emisor fiscal (CSD activo) y un comercio dentro de la global; el efectivo no entra a ella.
  const fiscalEmisorId = (
    await prisma.fiscalEmisor.create({
      data: {
        venueId,
        rfc: 'AAA010101AAA',
        legalName: m.key,
        regimenFiscal: '601',
        lugarExpedicion: '01000',
        csdStatus: 'ACTIVE',
        globalPeriodicity: 'MENSUAL',
      },
    })
  ).id
  await prisma.paymentProvider.create({ data: { id: m.key, code: m.key, name: m.key, type: 'PAYMENT_PROCESSOR', countryCode: ['MX'] } })
  await prisma.merchantAccount.create({ data: { id: m.key, providerId: m.key, externalMerchantId: m.key, credentialsEncrypted: {} } })
  await prisma.merchantFiscalConfig.create({
    data: { merchantAccountId: m.key, fiscalEmisorId, facturacionEnabled: true, autofacturaEnabled: true, includeInGlobal: true },
  })

  // 2 · lealtad: programa activo y un cliente con puntos.
  await prisma.loyaltyConfig.create({
    data: { venueId, active: true, pointsPerDollar: 1, pointsPerVisit: 0, redemptionRate: 0.01, minPointsRedeem: 100 },
  })
  const cliente = await prisma.customer.create({
    data: { venueId, firstName: 'Cliente', lastName: 'Fotos', email: clienteEmail, loyaltyPoints: PUNTOS.antes },
  })

  // 3 · turno y caja: abre antes de las ventas (con la hora del día de la siembra) y cierra con conteo después.
  const apertura = await abrirTurnoDeCaja({
    venueId,
    staffId: ana,
    staffName: 'ana QA',
    startingCash: pesos(FONDO),
    source: 'CAJA_MOVIL',
    now: () => new Date('2026-10-01T14:50:00Z'),
  })

  // 4 · las ventas ----------------------------------------------------------------------------------------------------------------------
  const cobros: Record<string, string> = {}
  /** Los servicios móviles dejan la cuenta abierta: se cobra en efectivo (con la hora del cobro) y se cierra. */
  async function cobrarEnEfectivo(clave: keyof typeof CUENTA, orderId: string) {
    const cuenta = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { total: true } })
    expect(c(Number(cuenta.total))).toBe(CUENTA[clave]) // la cuenta que armó el servicio es la que esta prueba sembró a mano
    const cuando = despues()
    cobros[clave] = await cobro(m, orderId, Number(cuenta.total), { createdAt: cuando })
    await prisma.order.update({
      where: { id: orderId },
      data: { status: 'COMPLETED', paymentStatus: 'PAID', paidAmount: cuenta.total, remainingBalance: 0, createdAt: cuando },
    })
  }
  /** Una venta de `orden()` con el café en grano en cada renglón (ella crea un producto por renglón: aquí se re-apunta al café). */
  async function ventaDeCafe(centavos: number[]) {
    const orderId = await orden(m, {
      subtotal: pesos(suma(...centavos)),
      renglones: centavos.map(precio => ({ categoryId, precio: pesos(precio) })),
    })
    await prisma.orderItem.updateMany({ where: { orderId }, data: { productId: cafeId, productName: 'Café en grano' } })
    return orderId
  }
  async function cobrarConTarjeta(clave: 't1' | 't2', orderId: string) {
    const cuando = despues()
    const propina = clave === 't1' ? PROPINA.t1 : 0
    cobros[clave] = (
      await prisma.payment.create({
        data: {
          venueId,
          orderId,
          amount: new Prisma.Decimal(pesos(CUENTA[clave])),
          tipAmount: new Prisma.Decimal(pesos(propina)),
          method: 'CREDIT_CARD',
          status: 'COMPLETED',
          type: 'REGULAR',
          splitType: 'FULLPAYMENT',
          source: 'TPV',
          merchantAccountId: m.key,
          processedById: ana,
          feePercentage: 0,
          feeAmount: new Prisma.Decimal(pesos(COMISION_DEL_PROCESADOR[clave])),
          netAmount: new Prisma.Decimal(pesos(CUENTA[clave] + propina - COMISION_DEL_PROCESADOR[clave])),
          createdAt: cuando,
        },
      })
    ).id
    await prisma.order.update({ where: { id: orderId }, data: { createdAt: cuando } })
  }
  const movil = (items: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) =>
    crearEnMovil(venueId, { staffId: ana, items, source: 'AVOQADO_ANDROID', ...extra } as never)

  // V0 · efectivo con propina de $10.
  const v0 = await ventaDeCafe([CUENTA.v0])
  const pagoV0 = despues()
  cobros.v0 = await cobro(m, v0, pesos(CUENTA.v0), { propina: pesos(PROPINA.v0), createdAt: pagoV0 })
  await prisma.order.update({ where: { id: v0 }, data: { createdAt: pagoV0 } })
  // V1 · efectivo con descuento de RENGLÓN: 10 % al café.
  const diez = await prisma.discount.create({ data: { venueId, name: '10 % café', type: 'PERCENTAGE', value: 10, scope: 'ITEM' } })
  await cobrarEnEfectivo('v1', (await movil([{ productId: cafeId, quantity: 1, discountId: diez.id }])).id)
  // V2 · efectivo con descuento de CUENTA de $23.20 sobre dos cafés.
  await cobrarEnEfectivo('v2', (await movil([{ productId: cafeId, quantity: 2 }], { discount: 2320 })).id)
  // V3 · efectivo con una PROMOCIÓN: combo café + pan a $174.
  const combo = await prisma.promotion.create({
    data: {
      venueId,
      name: `Combo ${m.key}`,
      type: 'BUNDLE',
      pricingMode: 'FIXED_TOTAL',
      priceCents: CUENTA.v3,
      status: 'PUBLISHED',
      daysOfWeek: [],
      groups: {
        create: [
          { name: 'Café', displayOrder: 0, options: { create: [{ productId: cafeId }] } },
          { name: 'Pan', displayOrder: 1, options: { create: [{ productId: panId }] } },
        ],
      },
    },
    include: { groups: { include: { options: true }, orderBy: { displayOrder: 'asc' } } },
  })
  const selections = combo.groups.map(g => ({ groupId: g.id, optionId: g.options[0].id }))
  await cobrarEnEfectivo(
    'v3',
    (await movil([{ quantity: 1, promotionRef: { promotionId: combo.id, promotionInstanceId: randomUUID(), selections } }])).id,
  )
  // V4 · efectivo con LEALTAD: canje de 1,160 puntos ($11.60) del cliente.
  const v4 = (await movil([{ productId: cafeId, quantity: 1 }], { customerId: cliente.id })).id
  await redeemPointsToOrder(venueId, v4, cliente.id, PUNTOS.canjeados, m.owner)
  await cobrarEnEfectivo('v4', v4)
  // T1 · tarjeta: dos cafés con propina y comisión del procesador. T2 · tarjeta: un café; de ESTE ticket sale la extracción de la global.
  const t1 = await ventaDeCafe([11_600, 11_600])
  await cobrarConTarjeta('t1', t1)
  const t2 = await ventaDeCafe([CUENTA.t2])
  await cobrarConTarjeta('t2', t2)

  // 5 · la comisión de cada cobro (la que congela la terminal) y el turno: todo lo del día entra al turno y cierra con $5 de faltante.
  for (const pago of Object.values(cobros)) await planear(pago)
  await prisma.payment.updateMany({ where: { venueId }, data: { shiftId: apertura.shiftId } })
  await prisma.order.updateMany({ where: { venueId }, data: { shiftId: apertura.shiftId } })
  const conteo = FONDO + EFECTIVO + PROPINA.v0 - FALTANTE
  await cerrarTurnoDeCaja({
    venueId,
    staffId: m.owner,
    staffName: 'owner QA',
    source: 'CAJA_MOVIL',
    yaCerrado: { cashDrawerSessionId: apertura.cashDrawerSessionId },
    conteo: new Prisma.Decimal(pesos(conteo)),
  })
  // La gaveta se cierra con el mismo conteo (el gesto que llama a `cerrarTurnoDeCaja` ya la cerró).
  await prisma.cashDrawerSession.update({
    where: { id: apertura.cashDrawerSessionId },
    data: { status: 'CLOSED', closedAt: new Date(), closedByStaffId: m.owner, closedByName: 'owner QA', actualAmount: pesos(conteo) },
  })

  // 6 · devolución parcial (un café de T1, con tarjeta, al día siguiente) con su reverso de comisión procesado. Va en T1 y no en T2:
  //     la guarda R4 de F6 detiene extraer un ticket con devolución sin su nota timbrada contra la global (Ruling PF-m6).
  const reembolso = await devolver(m, cobros.t1, pesos(DEVUELTO), 0, DEVOLUCION_EL)
  await prisma.payment.update({ where: { id: reembolso }, data: { method: 'CREDIT_CARD', merchantAccountId: m.key } })
  await procesarEfectos(m)

  // 7 · la factura global de octubre (con el doble del PAC), que incluye T1 y T2.
  const global = await issueGlobalForEmisor({ emisorId: fiscalEmisorId, now: GLOBAL_EN, sandbox: true })
  expect(global.status).toBe('STAMPED')

  /**
   * La extracción de T2 por el servicio de C3 (nota de egreso contra la global) y, con ella, la factura del cliente: así sale en el
   * negocio de verdad. Una extracción SIN su factura quedaría «pendiente» y detendría el encendido a propósito (documentos en vuelo).
   */
  const extraer = async () => {
    const r = await issueCfdiForOrder({ orderId: t2, receptor, sandbox: true, expectedVenueId: venueId }, {
      resolveProvider: () => provider as never,
    } as never)
    expect(r.status).toBe('STAMPED')
    expect(await prisma.cfdi.count({ where: { orderId: t2, idempotencyKey: { startsWith: 'cfdi-extraccion-' }, status: 'STAMPED' } })).toBe(
      1,
    )
    expect(await prisma.cfdi.count({ where: { orderId: t2, type: 'INGRESO', isGlobal: false, status: 'STAMPED' } })).toBe(1)
  }

  const scope = await resolveScope(m.owner, m.orgId)
  for (const registrar of [
    registerSalesTools,
    registerShiftTools,
    registerCommissionTools,
    registerLoyaltyTools,
    registerPaymentTools,
    registerProductTools,
    registerCustomerTools,
  ])
    registrar(servidor, scope)

  return {
    venueId,
    cafeId,
    clienteEmail,
    duenio: { type: 'HUMAN' as const, staffId: m.owner, impersonating: false as const },
    extraer,
    esperado,
  }
}

/** Borra lo de ESTE negocio (y sólo de él), en el orden que piden las llaves. */
async function limpiar() {
  if (!mundo) return
  const v = { venueId: mundo.venueId }
  const ordenes = (await prisma.order.findMany({ where: v, select: { id: true }, take: 100 })).map(o => o.id)
  await prisma.orderItemSelloIva.deleteMany({ where: { cfdi: v } })
  await prisma.cfdiGlobalOrden.deleteMany({ where: { cfdi: v } })
  await prisma.cfdi.deleteMany({ where: v })
  await prisma.orderDiscount.deleteMany({ where: { orderId: { in: ordenes } } })
  await prisma.loyaltyTransaction.deleteMany({ where: { orderId: { in: ordenes } } })
  await prisma.orderPromotion.deleteMany({ where: { orderId: { in: ordenes } } })
  await prisma.orderAction.deleteMany({ where: { orderId: { in: ordenes } } })
  await prisma.orderItem.deleteMany({ where: { orderId: { in: ordenes } } })
  await prisma.cashDrawerEvent.deleteMany({ where: v })
  await prisma.paymentEffect.deleteMany({ where: v })
  await prisma.commissionClawback.deleteMany({ where: { calculation: v } })
  await prisma.commissionCalculation.deleteMany({ where: v })
  await prisma.payment.deleteMany({ where: v })
  await prisma.cashDrawerSession.deleteMany({ where: v })
  await prisma.shift.deleteMany({ where: v })
  await prisma.order.deleteMany({ where: { id: { in: ordenes } } })
  await prisma.customer.deleteMany({ where: v })
  await prisma.loyaltyConfig.deleteMany({ where: v })
  await prisma.promotion.deleteMany({ where: v })
  await prisma.discount.deleteMany({ where: v })
  await prisma.merchantFiscalConfig.deleteMany({ where: { fiscalEmisor: v } })
  await prisma.fiscalEmisor.deleteMany({ where: v })
  await prisma.merchantAccount.deleteMany({ where: { id: mundo.key } })
  await prisma.paymentProvider.deleteMany({ where: { id: mundo.key } })
  await borrarMundoComisiones(mundo)
}

afterAll(limpiar)

it('§5.8: sembrar todo, extraer de la global y encender con un producto de 16 % a 0 % no mueve un peso', async () => {
  const sembrado = await sembrar()
  const f0 = await foto(sembrado.venueId, sembrado.clienteEmail)
  // Codex r1 P2-9: la foto no vale si no VIO el dinero sembrado. Cada herramienta respondió bien y trae lo esperado de su familia.
  // Codex r2 (P2-9): `ventas` es un ARRAY (una respuesta de `daily_sales` por día): se revisa CADA elemento, no sólo el primer nivel.
  for (const [familia, v] of Object.entries(f0 as Record<string, any>))
    for (const [i, r] of (familia === 'ventas' ? (v as any[]) : [v]).entries())
      expect({ familia, i, error: r?.error ?? (r?.ok === false ? 'ok:false' : null) }).toEqual({ familia, i, error: null })
  esperarLoSembrado(f0, sembrado.esperado)
  expect(await prisma.venueIvaPorProducto.count({ where: { venueId: sembrado.venueId } })).toBe(0) // el negocio sigue APAGADO
  await sembrado.extraer() // la extracción de un ticket de la global (C3), con el proveedor falso
  const f1 = await foto(sembrado.venueId, sembrado.clienteEmail)
  expect(f1).toEqual(f0) // la extracción no mueve ni caja ni cobros
  await updateProduct(sembrado.venueId, sembrado.cafeId, { ivaTratamiento: 'IVA_0' } as never, sembrado.duenio)
  expect(await prisma.venueIvaPorProducto.count({ where: { venueId: sembrado.venueId } })).toBe(1)
  expect((await prisma.product.findUniqueOrThrow({ where: { id: sembrado.cafeId } })).ivaTratamiento).toBe('IVA_0')
  const f2 = await foto(sembrado.venueId, sembrado.clienteEmail)
  expect(f2).toEqual(f0) // 🔴 si falla: DETENER el plan y reportar qué número se movió
})
