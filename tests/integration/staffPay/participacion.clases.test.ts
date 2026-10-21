// tests/integration/staffPay/participacion.clases.test.ts — fase 3, B11 (diseño r6.1, r4.1, r5.5, r5.8.5): las CLASES con la
// participación por sede, conectada. `'real'` es el default de todo llamador: una clase sin ancla de una sede que no estaba
// activa ese día no se paga en ningún lado (cierre, diferencia, liquidación, reporte y recibo abiertos), no bloquea con
// EXCEPCIONES y su tarjeta dice FUERA_DEL_SOBRE. La rama de anclas no se toca (+$40).
// El escenario del diseño (B desde el 1-nov, clase del 20-oct) va corrido dos meses (B desde el 1-sep, clase del 20-ago):
// el reporte y el recibo abiertos leen el reloj REAL para saber qué clase ya terminó. Fechas de 2026 en UTC; CDMX = UTC−6.
import prisma from '@/utils/prismaClient'
import { cerrarPeriodo, previewCierre } from '@/services/dashboard/staffPay/cierre.service'
import { guardarAjusteDeClase, pagoDeClase } from '@/services/dashboard/staffPay/ajustesClase.service'
import { diferenciasDeClase, diferenciasDelPeriodo } from '@/services/dashboard/staffPay/diferencias.service'
import { liquidarDiferencia, previewLiquidacion } from '@/services/dashboard/staffPay/liquidacion.service'
import { reportePeriodo } from '@/services/dashboard/staffPay/reporte.service'
import { reciboDePersona } from '@/services/dashboard/staffPay/recibos.service'
import { desactivarSede } from '@/services/dashboard/staffPay/participacion'
import { borrarMundo, clase, confirmadas, crearMundo, crearSede, Mundo, tablaFija } from './_mundo'
import { activar, sedeActiva } from './_ventas'

jest.mock('@/services/dashboard/staffPay/acceso', () => ({
  ...jest.requireActual('@/services/dashboard/staffPay/acceso'),
  sedesConServicePay: jest.fn(async () => (global as any).__sedes),
  tienePermisoEn: jest.fn(async () => true),
  sedesConPermiso: jest.fn(async (_u: string, venueIds: string[]) => venueIds),
  assertPermisoEnSedes: jest.fn(async () => undefined),
  sedesLegiblesDe: jest.fn(async (_u: string, venueIds: string[]) => ({ venueIds, parcial: false })),
}))

const SEP2 = new Date('2026-09-02T12:00:00Z') // agosto ya terminó en CDMX
let m: Mundo
let A: string
let B: string
let nombreB: string
let n = 0

beforeEach(async () => {
  m = await crearMundo('part-clases')
  A = m.venueId
  B = (await crearSede(m.orgId, m.key, 'b')).venueId
  nombreB = `${m.key}-b`
  ;(global as any).__sedes = [A, B] // las dos con plan
  await tablaFija(m, A, 500, { lateCancelHours: 2 })
  await tablaFija(m, B, 500, { lateCancelHours: 2 })
  // Inicio 1-ago con SÓLO A activa; B se activa desde el 1-sep (su agosto queda fuera del sobre).
  await activar(m, { desde: '2026-08-01', sedes: [A], propinasDesde: null })
  await sedeActiva(m, B, '2026-09-01')
})
afterEach(() => borrarMundo(m))

const preview = (fecha: string, ahora: Date) => previewCierre({ userId: m.owner, venueId: A, fecha, ahora })
const cerrar = async (fecha: string, ahora: Date) =>
  cerrarPeriodo({
    userId: m.owner,
    venueId: A,
    fecha,
    ahora,
    confirmarHuerfanas: true,
    huellaEsperada: (await preview(fecha, ahora)).huella,
  })
const deB = (inicioIso: string, staffId: string | null = m.ana) => clase(m, { staffId, inicioIso, venueId: B, reservas: confirmadas(5) })

describe('clases fuera del sobre (B11, r4.1): $0 en todos lados', () => {
  it('la clase de $500 del 20-ago de B (activa desde el 1-sep): $0 en el reporte y el recibo abiertos, el cierre, la diferencia y la liquidación; EXCEPCIONES no cuenta la que no tiene coach', async () => {
    const a1 = await clase(m, { staffId: m.ana, inicioIso: '2026-08-10T15:00:00Z', reservas: confirmadas(5) })
    const x = await deB('2026-08-20T15:00:00Z')
    await deB('2026-08-21T15:00:00Z', null) // sin coach: si participara, bloquearía el cierre con EXCEPCIONES

    // Abiertos: sólo la de A.
    const rep = await reportePeriodo({ userId: m.owner, venueId: A, fecha: '2026-08-15', offset: 0, limit: 50 })
    expect(rep.tarjetas).toMatchObject({ total: '500.00', clases: 1, excepciones: 0 })
    const rec = await reciboDePersona({ userId: m.owner, venueId: A, staffId: m.ana, fecha: '2026-08-15', limit: 50 })
    expect(rec).toMatchObject({ total: '500.00', cantidad: 1, parcial: false })

    // El cierre: B en el alcance (tiene ventana), sin bloqueos, sólo la de A.
    const p = await preview('2026-08-15', SEP2)
    expect(p).toMatchObject({ puedeCerrar: true, bloqueos: [], clases: 1, totalServicios: '500.00', total: '500.00' })
    expect(p.periodo.venueIds).toEqual([A, B].sort())
    const r = await cerrar('2026-08-15', SEP2)
    expect(r).toMatchObject({ total: '500.00', personas: 1 })
    expect(await prisma.serviceEarning.count({ where: { sourceId: x } })).toBe(0)
    expect(await prisma.classSessionPayState.findUnique({ where: { classSessionId: x } })).toBeNull() // sin ancla
    expect(await prisma.classSessionPayState.findUniqueOrThrow({ where: { classSessionId: a1 } })).toMatchObject({
      originPeriodId: r.periodId,
    })

    // La diferencia de su periodo cerrado (B sí está en su alcance): ninguna fila.
    const dif = await diferenciasDeClase(prisma, { venueId: B, classSessionId: x }, { ahora: SEP2 })
    expect(dif.origen?.id).toBe(r.periodId)
    expect(dif.filas).toEqual([])
    const lista = await diferenciasDelPeriodo({ userId: m.owner, venueId: A, periodId: r.periodId, limit: 50 }, { ahora: SEP2 })
    expect(lista.items.filter(f => f.classSessionId === x)).toEqual([])
    // La liquidación de septiembre no la paga.
    const liq = await previewLiquidacion({ userId: m.owner, venueId: B, classSessionId: x, destinoFecha: '2026-09-15', ahora: SEP2 })
    expect(liq).toMatchObject({ filas: [], total: '0.00', bloqueada: false })
  })

  it('la tarjeta: FUERA_DEL_SOBRE (no SIN_TABLA) con lo que pagaría, la sede y la fecha, y sin «llegó tarde»; sin coach, montoSiEntrara null', async () => {
    const x = await deB('2026-08-20T15:00:00Z')
    const sinCoach = await deB('2026-08-21T15:00:00Z', null)
    await cerrar('2026-08-15', SEP2)
    const t = await pagoDeClase(B, x, prisma, { ahora: SEP2 })
    expect(t).toMatchObject({
      estado: 'FUERA_DEL_SOBRE',
      motivo: null,
      monto: null,
      montoSiEntrara: '500.00',
      sede: { nombre: nombreB, fecha: '2026-08-20' },
      llegoTarde: false,
      anclada: false,
      staffName: 'Ana QA',
    })
    expect(await pagoDeClase(B, sinCoach, prisma, { ahora: SEP2 })).toMatchObject({
      estado: 'FUERA_DEL_SOBRE',
      montoSiEntrara: null,
      llegoTarde: false,
    })
    // Una cancelada tarde de B (se pagaría con la regla) también está fuera del sobre: no «llega tarde».
    const canc = await clase(m, {
      staffId: m.ana,
      inicioIso: '2026-08-22T15:00:00Z',
      venueId: B,
      status: 'CANCELLED',
      cancelledAt: '2026-08-22T14:00:00Z',
    })
    expect(await pagoDeClase(B, canc, prisma, { ahora: SEP2 })).toMatchObject({
      estado: 'FUERA_DEL_SOBRE',
      montoSiEntrara: '500.00',
      llegoTarde: false,
    })
    // Las de A (activa) siguen como siempre: una que llega después del cierre, «llega tarde».
    const tarde = await clase(m, { staffId: m.ana, inicioIso: '2026-08-23T15:00:00Z', reservas: confirmadas(5) })
    expect(await pagoDeClase(A, tarde, prisma, { ahora: SEP2 })).toMatchObject({ estado: 'OK', monto: '500.00', llegoTarde: true })
  })

  it('D5-fix sigue: una cancelada tarde PAGABLE de una sede ACTIVA, creada después del cierre, llega tarde', async () => {
    await cerrar('2026-08-15', SEP2)
    const canc = await clase(m, {
      staffId: m.ana,
      inicioIso: '2026-08-25T15:00:00Z',
      status: 'CANCELLED',
      cancelledAt: '2026-08-25T14:00:00Z',
    })
    expect(await pagoDeClase(A, canc, prisma, { ahora: SEP2 })).toMatchObject({
      estado: 'OK',
      monto: '500.00',
      llegoTarde: true,
      regla: { tipo: 'CANCELACION_TARDIA', horas: 1 },
    })
  })
})

describe('la rama de anclas no se filtra (r4.1)', () => {
  it('una clase anclada en agosto que pasa de $500 a $540 da +$40 en septiembre aunque su sede ya no esté activa', async () => {
    const a1 = await clase(m, { staffId: m.ana, inicioIso: '2026-08-10T15:00:00Z', reservas: confirmadas(5) })
    const ago = await cerrar('2026-08-15', SEP2)
    // A deja de estar activa: su último día fue el 31-ago (lo más atrás que deja, agosto ya se cerró).
    await desactivarSede({ userId: m.owner, venueId: A, sedeId: A, hasta: '2026-08-31', ahora: SEP2 })
    await guardarAjusteDeClase({
      venueId: A,
      classSessionId: a1,
      payCountOverride: null,
      payAmountOverride: 540,
      payExcluded: false,
      reason: 'Monto acordado QA',
      actorId: m.owner,
    })
    const pv = await previewLiquidacion({ userId: m.owner, venueId: A, classSessionId: a1, destinoFecha: '2026-09-15', ahora: SEP2 })
    expect(pv).toMatchObject({ periodoOrigen: { id: ago.periodId }, total: '40.00', bloqueada: false })
    const r = await liquidarDiferencia({
      userId: m.owner,
      venueId: A,
      classSessionId: a1,
      destinoFecha: '2026-09-15',
      ahora: SEP2,
      periodoOrigenId: ago.periodId,
      huellaEsperada: pv.huella,
      solicitudId: `${m.key}-liq-${++n}`,
    })
    expect(r).toMatchObject({ yaLiquidada: false, lineas: [{ staffId: m.ana, amount: '40.00' }] })
  })
})
