// tests/integration/staffPay/participacion.cierre.test.ts — fase 3, B11 (diseño r5.2, r4.4, r4.7, r6.6.8): el alcance de un
// periodo con la participación por sede, sus permisos y el bloqueo SEDE_ACTIVA_SIN_PLAN. Antes del inicio de pago al
// personal rige D2 tal cual (nada se amplía ni se persiste por historia); desde el inicio, toda sede con ventana entra al
// alcance. Fechas de 2026 en UTC; CDMX = UTC−6.
import prisma from '@/utils/prismaClient'
import * as acceso from '@/services/dashboard/staffPay/acceso'
import { cerrarPeriodo, previewCierre } from '@/services/dashboard/staffPay/cierre.service'
import { pagoDeClase } from '@/services/dashboard/staffPay/ajustesClase.service'
import { activarPagoAlPersonal } from '@/services/dashboard/staffPay/activacion.service'
import { diferenciasDeClase } from '@/services/dashboard/staffPay/diferencias.service'
import { previewLiquidacion } from '@/services/dashboard/staffPay/liquidacion.service'
import { reciboDePersona } from '@/services/dashboard/staffPay/recibos.service'
import { reportePeriodo } from '@/services/dashboard/staffPay/reporte.service'
import { activarSede, desactivarSede } from '@/services/dashboard/staffPay/participacion'
import { fechaComoDbDate } from '@/services/dashboard/staffPay/periodos'
import { borrarMundo, clase, confirmadas, crearMundo, crearSede, Mundo, tablaFija, tablaMindform } from './_mundo'
import { activar, cobro, comision, esquema, sedeActiva } from './_ventas'

jest.mock('@/services/dashboard/staffPay/acceso', () => ({
  ...jest.requireActual('@/services/dashboard/staffPay/acceso'),
  sedesConServicePay: jest.fn(async () => (global as any).__sedes),
  tienePermisoEn: jest.fn(async () => true),
  sedesConPermiso: jest.fn(async (_u: string, venueIds: string[]) => venueIds),
  assertPermisoEnSedes: jest.fn(async () => undefined),
  assertPermisoEnTodasLasSedes: jest.fn(async () => undefined),
  sedesLegiblesDe: jest.fn(async (_u: string, venueIds: string[]) => ({ venueIds, parcial: false })),
}))

const OCT2 = new Date('2026-10-02T12:00:00Z')
const NOV2 = new Date('2026-11-02T12:00:00Z')
let m: Mundo
let A: string
let B: string

beforeEach(async () => {
  m = await crearMundo('part-alcance')
  A = m.venueId
  B = (await crearSede(m.orgId, m.key, 'b')).venueId
  ;(global as any).__sedes = [A, B]
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
const totalDe = async (periodId: string, staffId: string) =>
  (await prisma.staffPayStatement.findUnique({ where: { periodId_staffId: { periodId, staffId } } }))?.total.toFixed(2) ?? null

describe('Codex r5-14: sólo A seleccionada al activar (B11)', () => {
  it('B con $500 de clase y $100 de comisión el 20-oct, activada desde el 1-nov: el cierre de octubre del 2-nov paga $0 de B', async () => {
    await tablaFija(m, A, 500)
    await tablaFija(m, B, 500)
    // Activar el 5-oct (mensual ⇒ desde el 1-oct) eligiendo SÓLO A: B tiene el plan pero no recibe ventana.
    expect(
      await activarPagoAlPersonal({
        userId: m.owner,
        venueId: A,
        periodicidad: 'MONTHLY',
        sedes: [A],
        ahora: new Date('2026-10-05T18:00:00Z'),
      }),
    ).toEqual({ startDate: '2026-10-01', yaActivado: false })
    expect(await prisma.staffPayVenueWindow.count({ where: { venueId: B } })).toBe(0)
    const cB = await clase(m, { staffId: m.ana, inicioIso: '2026-10-20T15:00:00Z', venueId: B, reservas: confirmadas(5) })
    const cfgB = await esquema(m, B, 'Esquema B')
    const com = await comision(m, { configId: cfgB, staffId: m.sofia, iso: '2026-10-20T18:00:00Z', neto: 100, venueId: B })
    await activarSede({ userId: m.owner, venueId: A, sedeId: B, ahora: new Date('2026-11-01T18:00:00Z') }) // desde hoy, 1-nov
    const p = await preview('2026-10-15', NOV2)
    expect(p).toMatchObject({ puedeCerrar: true, clases: 0, comisiones: 0, total: '0.00' })
    expect(p.periodo.venueIds).toEqual([A, B].sort())
    const r = await cerrar('2026-10-15', NOV2)
    expect(r.total).toBe('0.00')
    expect(await prisma.serviceEarning.count({ where: { sourceId: { in: [cB, com.id] } } })).toBe(0)
    expect(await pagoDeClase(B, cB, prisma, { ahora: NOV2 })).toMatchObject({ estado: 'FUERA_DEL_SOBRE', montoSiEntrara: '500.00' })
  })
})

describe('caso agosto (r5.2): un periodo que termina antes del inicio conserva el alcance de la fase 2 (D2)', () => {
  const preparar = async () => {
    await tablaMindform(m, A)
    await tablaMindform(m, B)
    // Inicio 1-sep con las dos sedes activas desde ese día; agosto quedó ABIERTO y guardado sólo con A.
    await activar(m, { desde: '2026-09-01', sedes: [A, B], propinasDesde: null })
    await prisma.servicePayPeriod.create({
      data: {
        organizationId: m.orgId,
        periodStart: fechaComoDbDate('2026-08-01'),
        periodEnd: fechaComoDbDate('2026-08-31'),
        venueIds: [A],
      },
    })
    await clase(m, { staffId: m.ana, inicioIso: '2026-08-20T15:00:00Z', reservas: confirmadas(8) }) // A: Head Coach, $570
    return clase(m, { staffId: m.sofia, inicioIso: '2026-08-20T17:00:00Z', venueId: B, reservas: confirmadas(8) }) // B: Coach, $480
  }

  it('(a) B tiene el plan: A $570 + B $480 = $1,050, como en la fase 2', async () => {
    await preparar()
    const r = await cerrar('2026-08-15', OCT2)
    expect(r).toMatchObject({ total: '1050.00', venueIds: [A, B].sort() })
  })

  it('(b) B perdió el plan el 1-oct (su ventana sigue desde el 1-sep): agosto paga $570, se guarda SIN B, y después no hay diferencia ni liquidación por la clase de B', async () => {
    const cB = await preparar()
    ;(global as any).__sedes = [A]
    const p = await preview('2026-08-15', OCT2)
    // B no está en el alcance de agosto (D2): ni la paga, ni la bloquea por estar activa sin plan.
    expect(p).toMatchObject({ puedeCerrar: true, bloqueos: [], clases: 1, total: '570.00' })
    expect(p.periodo.venueIds).toEqual([A])
    const r = await cerrar('2026-08-15', OCT2)
    expect(r).toMatchObject({ total: '570.00', venueIds: [A] })
    expect((await prisma.servicePayPeriod.findUniqueOrThrow({ where: { id: r.periodId } })).venueIds).toEqual([A])
    expect(await diferenciasDeClase(prisma, { venueId: B, classSessionId: cB }, { ahora: OCT2 })).toEqual({ origen: null, filas: [] })
    expect(
      await previewLiquidacion({ userId: m.owner, venueId: B, classSessionId: cB, destinoFecha: '2026-10-15', ahora: OCT2 }),
    ).toMatchObject({ periodoOrigen: null, filas: [], total: '0.00' })
  })
})

describe('permisos (r4.4, r4.9.9): las sedes con ventana entran a la preparación de permisos', () => {
  it('B activa del 1 al 15-oct con $60, sin plan desde el 16 y octubre sin fila: quien tiene permiso en B cierra y ve sus $60; el recibo no sale parcial', async () => {
    await activar(m, { desde: '2026-10-01', sedes: [A], propinasDesde: '2026-10-01T06:00:00Z' })
    await sedeActiva(m, B, '2026-10-01', '2026-10-15')
    ;(global as any).__sedes = [A] // sin plan desde el 16
    await cobro(m, { iso: '2026-10-10T18:00:00Z', propina: 60, servedById: m.carla, venueId: B })
    // Recibo abierto (octubre todavía sin fila): B se lee porque su ventana la mete al alcance y a las candidatas.
    const rec = await reciboDePersona({ userId: m.owner, venueId: A, staffId: m.carla, fecha: '2026-10-15', limit: 50 })
    expect(rec).toMatchObject({ total: '60.00', parcial: false })
    expect(acceso.sedesLegiblesDe).toHaveBeenLastCalledWith(m.owner, expect.arrayContaining([A, B]))
    const r = await cerrar('2026-10-15', NOV2)
    expect(r).toMatchObject({ total: '60.00', venueIds: [A, B].sort() })
    // La preparación de permisos del cierre incluyó a B (sin eso, `exigirPermisoEnSedes` lo negaría).
    expect(acceso.sedesConPermiso).toHaveBeenLastCalledWith(m.owner, expect.arrayContaining([B]), 'staffpay:close')
    expect(await totalDe(r.periodId, m.carla)).toBe('60.00')
  })
})

describe('bloqueo SEDE_ACTIVA_SIN_PLAN (r3.4, r4.7)', () => {
  it('con otra sede con plan ⇒ «desactívala con su último día»; sin ninguna ⇒ «renueva el plan»; desactivar sin plan lo libera', async () => {
    await activar(m, { desde: '2026-09-01', sedes: [A, B], propinasDesde: null })
    ;(global as any).__sedes = [A] // B perdió el plan; su ventana sigue abierta
    expect(await preview('2026-09-15', OCT2)).toMatchObject({
      puedeCerrar: false,
      bloqueos: [{ codigo: 'SEDE_ACTIVA_SIN_PLAN', venueIds: [B], otrasConPlan: true }],
    })
    await expect(cerrar('2026-09-15', OCT2)).rejects.toMatchObject({
      statusCode: 409,
      code: 'SEDE_ACTIVA_SIN_PLAN',
      message: expect.stringMatching(/^Desactiva la sede .+ indicando su último día/),
    })
    ;(global as any).__sedes = [] // ninguna sede tiene el plan
    expect(await preview('2026-09-15', OCT2)).toMatchObject({
      bloqueos: [{ codigo: 'SEDE_ACTIVA_SIN_PLAN', venueIds: [A, B].sort(), otrasConPlan: false }],
    })
    await expect(cerrar('2026-09-15', OCT2)).rejects.toMatchObject({
      code: 'SEDE_ACTIVA_SIN_PLAN',
      message: expect.stringMatching(/^Renueva el plan para cerrar; desactivar las sedes .+ no lo libera/),
      details: { otrasConPlan: false },
    })
    ;(global as any).__sedes = [A]
    // Desactivar no pide el plan: es la salida.
    await desactivarSede({ userId: m.owner, venueId: A, sedeId: B, hasta: '2026-09-30', ahora: OCT2 })
    expect(await preview('2026-09-15', OCT2)).toMatchObject({ puedeCerrar: true, bloqueos: [] })
    expect((await cerrar('2026-09-15', OCT2)).venueIds).toEqual([A, B].sort())
  })

  it('también bloquea el cierre de un periodo atrasado DESDE el inicio: agosto (inicio el 1-ago), todavía abierto, cuando ya es octubre', async () => {
    await activar(m, { desde: '2026-08-01', sedes: [A, B], propinasDesde: null })
    ;(global as any).__sedes = [A]
    expect(await preview('2026-08-15', OCT2)).toMatchObject({
      puedeCerrar: false,
      bloqueos: [{ codigo: 'SEDE_ACTIVA_SIN_PLAN', venueIds: [B], otrasConPlan: true }],
    })
    await expect(cerrar('2026-08-15', OCT2)).rejects.toMatchObject({ code: 'SEDE_ACTIVA_SIN_PLAN' })
  })

  it('NO bloquea un periodo que termina ANTES del inicio (D2): agosto con inicio el 1-sep, aunque B siga activa sin el plan', async () => {
    await activar(m, { desde: '2026-09-01', sedes: [A, B], propinasDesde: null })
    ;(global as any).__sedes = [A] // B perdió el plan; su ventana sigue abierta desde el 1-sep
    // Agosto rige D2 (guardadas ∪ con el plan): B no está en su alcance, así que su ventana abierta no lo bloquea.
    const p = await preview('2026-08-15', OCT2)
    expect(p).toMatchObject({ puedeCerrar: true, bloqueos: [], periodo: { venueIds: [A] } })
    expect((await cerrar('2026-08-15', OCT2)).venueIds).toEqual([A])
    // Septiembre (desde el inicio) sí: ahí B entra por su historia.
    expect((await preview('2026-09-15', OCT2)).bloqueos).toEqual([{ codigo: 'SEDE_ACTIVA_SIN_PLAN', venueIds: [B], otrasConPlan: true }])
  })
})

describe('un periodo que CRUZA el inicio (revisión de B11 #2): 409 en español, no un 500', () => {
  it('el reporte, el recibo y la vista previa del cierre dicen qué pasó', async () => {
    await activar(m, { desde: '2026-09-01', sedes: [A], propinasDesde: null })
    // Datos de antes del candado de periodicidad: un inicio a media quincena del mes (mensual) que ningún periodo respeta.
    await prisma.organization.update({ where: { id: m.orgId }, data: { staffPayStartDate: fechaComoDbDate('2026-09-16') } })
    const cruza = {
      statusCode: 409,
      code: 'STAFF_PAY_PERIODO_CRUZA_EL_INICIO',
      message: expect.stringMatching(/^El periodo cruza el inicio de pago al personal; /),
    }
    await expect(reportePeriodo({ userId: m.owner, venueId: A, fecha: '2026-09-10', offset: 0, limit: 50 })).rejects.toMatchObject(cruza)
    await expect(reciboDePersona({ userId: m.owner, venueId: A, staffId: m.carla, fecha: '2026-09-10', limit: 50 })).rejects.toMatchObject(
      cruza,
    )
    await expect(preview('2026-09-10', OCT2)).rejects.toMatchObject(cruza)
    // B13 (revisión de B12 #2): el cierre MISMO, con una huella cualquiera; el helper `cerrar` truena antes, en su vista previa.
    await expect(
      cerrarPeriodo({
        userId: m.owner,
        venueId: A,
        fecha: '2026-09-10',
        ahora: OCT2,
        confirmarHuerfanas: true,
        huellaEsperada: 'f'.repeat(64),
      }),
    ).rejects.toMatchObject(cruza)
  })
})
