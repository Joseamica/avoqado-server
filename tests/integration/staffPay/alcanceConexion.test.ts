// tests/integration/staffPay/alcanceConexion.test.ts — fase 3, B14-fix F1 (Codex participación r1 #1): una conexión MCP limitada
// a A no ve NADA de B aunque el usuario pueda leer B: el recibo (renglones, totales, totales por tipo y devoluciones pendientes),
// el reporte (tarjetas, personas y sus sedes) y las diferencias excluyen B en filas Y agregados, y dicen `parcial`. Sin el
// límite (el dashboard), las dos sedes como siempre. Servicios REALES contra la base; sólo plan y permisos simulados (el usuario
// lee y cierra A y B). Fechas de 2026 en UTC; CDMX = UTC−6.
import prisma from '@/utils/prismaClient'
import { cerrarPeriodo, previewCierre } from '@/services/dashboard/staffPay/cierre.service'
import { reciboDePersona } from '@/services/dashboard/staffPay/recibos.service'
import { reportePeriodo } from '@/services/dashboard/staffPay/reporte.service'
import { diferenciasDelPeriodo } from '@/services/dashboard/staffPay/diferencias.service'
import { borrarMundo, clase, confirmadas, crearMundo, crearSede, Mundo, tablaFija } from './_mundo'
import { activar, cobro, comision, esquema, reembolso } from './_ventas'

jest.mock('@/services/dashboard/staffPay/acceso', () => ({
  ...jest.requireActual('@/services/dashboard/staffPay/acceso'),
  sedesConServicePay: jest.fn(async () => (global as any).__sedes),
  tienePermisoEn: jest.fn(async () => true),
  sedesConPermiso: jest.fn(async (_u: string, venueIds: string[]) => venueIds),
  assertPermisoEnSedes: jest.fn(async () => undefined),
  sedesLegiblesDe: jest.fn(async (_u: string, venueIds: string[]) => ({ venueIds: [...new Set(venueIds)].sort(), parcial: false })),
}))

const OCT2 = new Date('2026-10-02T12:00:00Z')
const SEP = '2026-09-15'
const OCT = '2026-10-15'
let m: Mundo
let A: string
let B: string
let productoB: string

beforeEach(async () => {
  m = await crearMundo('alcance-conexion')
  A = m.venueId
  const b = await crearSede(m.orgId, m.key, 'b')
  B = b.venueId
  productoB = b.productId
  ;(global as any).__sedes = [A, B]
})
afterEach(() => borrarMundo(m))

const cerrar = async (fecha: string, ahora: Date) =>
  cerrarPeriodo({
    userId: m.owner,
    venueId: A,
    fecha,
    ahora,
    confirmarHuerfanas: true,
    huellaEsperada: (await previewCierre({ userId: m.owner, venueId: A, fecha, ahora })).huella,
  })

/**
 * El escenario de Codex: A y B activas desde el 1-sep. En septiembre Sofía vende en B (+$50 de comisión, congelada al cerrar
 * septiembre). En octubre vende en A ($30) y en B ($100) el 6-oct. El 1-nov se devuelve la venta de septiembre de B: −$50 que
 * se descontarán solos al cerrar noviembre (devolución pendiente del recibo de octubre).
 */
async function escenario() {
  await activar(m, { desde: '2026-09-01', sedes: [A, B], propinasDesde: null })
  const cfgA = await esquema(m, A, 'Esquema A')
  const cfgB = await esquema(m, B, 'Esquema B')
  const ventaB = await cobro(m, { iso: '2026-09-10T18:00:00Z', venueId: B })
  await comision(m, { configId: cfgB, staffId: m.sofia, iso: '2026-09-10T18:00:05Z', neto: 50, pago: ventaB, venueId: B })
  await cerrar(SEP, OCT2)
  const vA = await cobro(m, { iso: '2026-10-06T18:00:00Z', venueId: A })
  await comision(m, { configId: cfgA, staffId: m.sofia, iso: '2026-10-06T18:00:05Z', neto: 30, pago: vA, venueId: A })
  const vB = await cobro(m, { iso: '2026-10-06T19:00:00Z', venueId: B })
  await comision(m, { configId: cfgB, staffId: m.sofia, iso: '2026-10-06T19:00:05Z', neto: 100, pago: vB, venueId: B })
  const devolucion = await reembolso(m, ventaB, { iso: '2026-11-01T18:00:00Z', monto: 100 })
  await comision(m, { configId: cfgB, staffId: m.sofia, iso: '2026-11-01T18:00:05Z', neto: -50, pago: devolucion, venueId: B })
}

describe('B14-fix F1: con el alcance de la conexión, B no aporta filas ni agregados', () => {
  it('recibo abierto de octubre: sin los $100 ni la devolución pendiente de −$50 de B; sin el límite, los dos', async () => {
    await escenario()
    const recibo = (soloSedes?: string[]) =>
      reciboDePersona({ userId: m.owner, venueId: A, staffId: m.sofia, fecha: OCT, limit: 50, soloSedes })
    const todo = await recibo()
    expect(todo).toMatchObject({ total: '130.00', cantidad: 2, totalesPorTipo: { COMISION: '130.00' }, parcial: false })
    expect(todo.pendientes).toMatchObject({ n: 1, total: '-50.00' })

    const soloA = await recibo([A])
    expect(soloA.renglones.map(r => [r.tipo, r.monto])).toEqual([['COMISION', '30.00']])
    expect(soloA).toMatchObject({ total: '30.00', cantidad: 1, totalesPorTipo: { COMISION: '30.00' }, parcial: true })
    expect(soloA.pendientes).toEqual({ n: 0, total: '0.00', porDestino: [], items: [], truncado: false })
    expect(JSON.stringify(soloA)).not.toContain(B)
  })

  it('reporte abierto de octubre: tarjetas, personas y sus sedes sólo de A; sin el límite, A y B', async () => {
    await escenario()
    const reporte = (soloSedes?: string[]) => reportePeriodo({ userId: m.owner, venueId: A, fecha: OCT, offset: 0, limit: 50, soloSedes })
    const todo = await reporte()
    expect(todo).toMatchObject({ parcial: false, venueIds: [A, B].sort(), tarjetas: { total: '130.00', comisiones: '130.00' } })
    const soloA = await reporte([A])
    expect(soloA).toMatchObject({ parcial: true, venueIds: [A], tarjetas: { total: '30.00', comisiones: '30.00', personas: 1 } })
    expect(soloA.personas.items).toEqual([expect.objectContaining({ staffId: m.sofia, venueIds: [A], total: '30.00' })])
  })

  it('diferencias de septiembre cerrado: sólo las de A; sin el límite, las de A y B', async () => {
    await tablaFija(m, A, 500)
    await tablaFija(m, B, 500)
    await activar(m, { desde: '2026-09-01', sedes: [A, B], propinasDesde: null })
    const sep = await cerrar(SEP, OCT2)
    // Dos clases que llegaron DESPUÉS del cierre (una por sede): cada una es una diferencia de $500 pendiente.
    const enA = await clase(m, { staffId: m.ana, inicioIso: '2026-09-20T15:00:00Z', reservas: confirmadas(5) })
    const enB = await clase(m, {
      staffId: m.ana,
      inicioIso: '2026-09-21T15:00:00Z',
      venueId: B,
      productId: productoB,
      reservas: confirmadas(5),
    })
    const diferencias = (soloSedes?: string[]) =>
      diferenciasDelPeriodo({ userId: m.owner, venueId: A, periodId: sep.periodId, limit: 50, soloSedes })
    const todo = await diferencias()
    expect(todo.items.map(f => [f.classSessionId, f.pendiente]).sort()).toEqual(
      [
        [enA, '500.00'],
        [enB, '500.00'],
      ].sort(),
    )
    expect(todo.parcial).toBe(false)
    const soloA = await diferencias([A])
    expect(soloA.items.map(f => [f.classSessionId, f.venueId, f.pendiente])).toEqual([[enA, A, '500.00']])
    expect(soloA.parcial).toBe(true)
    expect(await prisma.serviceEarning.count({ where: { organizationId: m.orgId, venueId: B } })).toBe(0) // sólo se leyó
  })
})
