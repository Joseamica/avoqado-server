// tests/integration/staffPay/participacion.escrituras.test.ts — fase 3, B11 (diseño r3.3, r4.6, r5.8.9, revisión de B10 #1):
// las escrituras públicas de la participación —activar la organización eligiendo sedes, «hoy» que cambia bajo el candado—,
// la huella del cierre frente a ellas y la carrera de activar una sede contra el cierre REAL de su periodo (SSI).
// Fechas de 2026 en UTC; CDMX = UTC−6.
import prisma from '@/utils/prismaClient'
import * as auditoria from '@/services/activityAudit.service'
import { cerrarPeriodo, previewCierre } from '@/services/dashboard/staffPay/cierre.service'
import { activarPagoAlPersonal } from '@/services/dashboard/staffPay/activacion.service'
import { activarSede, desactivarSede } from '@/services/dashboard/staffPay/participacion'
import { dbDateComoFecha } from '@/services/dashboard/staffPay/periodos'
import { barreraDeLaOrganizacion, CIERRE_EN_CURSO, conCandadoRetenido, crearSede } from './_mundo'
import { esperarDetenidaPor, prepararParticipacion, resultado } from './_participacion'
import { activar, cobro } from './_ventas'

jest.mock('@/services/dashboard/staffPay/acceso', () => ({
  ...jest.requireActual('@/services/dashboard/staffPay/acceso'),
  sedesConServicePay: jest.fn(async () => (global as any).__sedes),
  tienePermisoEn: jest.fn(async () => true),
  sedesConPermiso: jest.fn(async (_u: string, venueIds: string[]) => venueIds),
  assertPermisoEnSedes: jest.fn(async () => undefined),
  assertPermisoEnTodasLasSedes: jest.fn(async () => undefined),
  sedesLegiblesDe: jest.fn(async (_u: string, venueIds: string[]) => ({ venueIds, parcial: false })),
}))

const p = prepararParticipacion('part-escrituras')
const OCT2 = new Date('2026-10-02T12:00:00Z')
const OCT5 = new Date('2026-10-05T18:00:00Z')
const OCT20 = new Date('2026-10-20T18:00:00Z')
const NOV2 = new Date('2026-11-02T12:00:00Z')
let A: string
let B: string

beforeEach(async () => {
  A = p.m().venueId
  B = (await crearSede(p.m().orgId, p.m().key, 'b')).venueId
  ;(global as any).__sedes = [A, B]
})

const ventanasDe = async (venueId: string) =>
  (await prisma.staffPayVenueWindow.findMany({ where: { venueId }, orderBy: { desde: 'asc' }, take: 10 })).map(w => [
    dbDateComoFecha(w.desde),
    w.hasta ? dbDateComoFecha(w.hasta) : null,
  ])
const activarOrg = (sedes?: string[]) =>
  activarPagoAlPersonal({ userId: p.m().owner, venueId: A, periodicidad: 'MONTHLY', sedes, ahora: OCT5 })
const preview = (fecha: string, ahora: Date) => previewCierre({ userId: p.m().owner, venueId: A, fecha, ahora })
const cerrar = (fecha: string, ahora: Date, huellaEsperada: string) =>
  cerrarPeriodo({ userId: p.m().owner, venueId: A, fecha, ahora, confirmarHuerfanas: true, huellaEsperada })
const activarB = (o: { desde?: string; ahora: Date; fechaEsperada?: string }) =>
  activarSede({ userId: p.m().owner, venueId: A, sedeId: B, ...o })

describe('activar la organización eligiendo sedes (B11, r3.3)', () => {
  it('sólo las elegidas reciben su ventana desde el inicio; las demás se activan después', async () => {
    expect(await activarOrg([B])).toEqual({ startDate: '2026-10-01', yaActivado: false })
    expect(await ventanasDe(B)).toEqual([['2026-10-01', null]])
    expect(await ventanasDe(A)).toEqual([])
    const log = await prisma.activityLog.findFirstOrThrow({ where: { action: 'SERVICE_PAY_ACTIVATED', entityId: p.m().orgId } })
    expect(log.data).toMatchObject({ startDate: '2026-10-01', sedes: [B] })
  })

  it('sin elegir, todas las que tienen el plan (como B9)', async () => {
    await activarOrg()
    expect([await ventanasDe(A), await ventanasDe(B)]).toEqual([[['2026-10-01', null]], [['2026-10-01', null]]])
  })

  it('FALTA_SEDE (lista vacía), SEDE_SIN_PLAN y una sede de otra organización: nada escrito', async () => {
    await expect(activarOrg([])).rejects.toMatchObject({ statusCode: 400, code: 'FALTA_SEDE' })
    ;(global as any).__sedes = [A]
    await expect(activarOrg([A, B])).rejects.toMatchObject({
      statusCode: 409,
      code: 'SEDE_SIN_PLAN',
      message: expect.stringMatching(/^La sede .+-b no tiene Pago al personal en su plan/),
    })
    const ajena = (await crearSede(await p.otraOrg('z'), p.m().key, 'z')).venueId
    await expect(activarOrg([ajena])).rejects.toMatchObject({ statusCode: 404, message: 'Sede no encontrada' })
    expect(await prisma.organization.findUniqueOrThrow({ where: { id: p.m().orgId }, select: { staffPayStartDate: true } })).toEqual({
      staffPayStartDate: null,
    })
    expect(await prisma.staffPayVenueWindow.count({ where: { organizationId: p.m().orgId } })).toBe(0)
  })
})

describe('«hoy» que vio el dueño (`fechaEsperada`): si bajo el candado ya es otro día ⇒ 409 FECHA_CAMBIO', () => {
  it('activar y desactivar una sede', async () => {
    await activar(p.m(), { desde: '2026-10-01', sedes: [A], propinasDesde: null })
    await expect(activarB({ ahora: OCT20, fechaEsperada: '2026-10-19' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'FECHA_CAMBIO',
      details: { hoy: '2026-10-20' },
    })
    expect(await ventanasDe(B)).toEqual([])
    expect(await activarB({ ahora: OCT20, fechaEsperada: '2026-10-20' })).toMatchObject({
      ventana: { desde: '2026-10-20' },
      minimoEfectivo: '2026-10-01',
    })
    const desactivar = (fechaEsperada: string) =>
      desactivarSede({ userId: p.m().owner, venueId: A, sedeId: B, ahora: new Date('2026-10-25T18:00:00Z'), fechaEsperada })
    await expect(desactivar('2026-10-24')).rejects.toMatchObject({ statusCode: 409, code: 'FECHA_CAMBIO' })
    expect(await ventanasDe(B)).toEqual([['2026-10-20', null]])
    expect(await desactivar('2026-10-25')).toMatchObject({ ventana: { hasta: '2026-10-25' } })
  })
})

describe('la huella del cierre frente a las escrituras de ventanas (r4.6, r5.8.9)', () => {
  it('desactivar entre la vista previa y el confirmar ⇒ HUELLA_CAMBIO, sin escribir nada', async () => {
    await activar(p.m(), { desde: '2026-10-01', sedes: [A, B], propinasDesde: '2026-10-01T06:00:00Z' })
    await cobro(p.m(), { iso: '2026-10-10T18:00:00Z', propina: 40, servedById: p.m().carla, venueId: B })
    const pv = await preview('2026-10-15', NOV2)
    expect(pv).toMatchObject({ propinas: 1, totalVentas: '40.00' })
    await desactivarSede({ userId: p.m().owner, venueId: A, sedeId: B, hasta: '2026-10-05', ahora: NOV2 })
    await expect(cerrar('2026-10-15', NOV2, pv.huella)).rejects.toMatchObject({ statusCode: 409, code: 'HUELLA_CAMBIO' })
    expect(await prisma.serviceEarning.count({ where: { organizationId: p.m().orgId } })).toBe(0)
  })

  it('activar una sede sin ventas que ya estaba en el alcance (tiene el plan) NO cambia la huella', async () => {
    await activar(p.m(), { desde: '2026-10-01', sedes: [A], propinasDesde: null })
    const antes = await preview('2026-10-15', NOV2)
    expect(antes.periodo.venueIds).toEqual([A, B].sort())
    await activarB({ desde: '2026-10-01', ahora: NOV2 })
    expect((await preview('2026-10-15', NOV2)).huella).toBe(antes.huella)
    expect((await cerrar('2026-10-15', NOV2, antes.huella)).yaCerrado).toBe(false)
  })

  it('con el candado del cierre retenido, activar una sede contesta 409 CIERRE_EN_CURSO sin escribir', async () => {
    await activar(p.m(), { desde: '2026-10-01', sedes: [A], propinasDesde: null })
    const r = await conCandadoRetenido(await barreraDeLaOrganizacion(p.m().orgId), () => activarB({ ahora: OCT20 }))
    expect(r.error).toMatchObject(CIERRE_EN_CURSO)
    expect(r.ms).toBeLessThan(10_000)
    expect(await ventanasDe(B)).toEqual([])
  }, 40_000)
})

describe('activar una sede contra el cierre REAL de su periodo (revisión de B10 #1: SSI)', () => {
  it('el cierre de septiembre llega primero: activar «desde el 15-sep» espera, ve el ciclo, se repite y contesta 400; ninguna ventana dentro de septiembre', async () => {
    await activar(p.m(), { desde: '2026-09-01', sedes: [A], propinasDesde: null })
    const pv = await preview('2026-09-15', OCT2)
    const pausa = p.pausarDespuesDe('bloquearSedesDeLaOrganizacion') // el cierre, con su candado de periodos tomado
    const cierre = resultado(cerrar('2026-09-15', OCT2, pv.huella))
    const pid = await pausa.hasta(cierre)
    expect(pid).not.toBeNull()
    const intentos = jest.spyOn(prisma, '$transaction')
    p.espiar(intentos)
    let termino = false
    const act = resultado(activarB({ desde: '2026-09-15', ahora: OCT2 })).finally(() => (termino = true))
    expect(await esperarDetenidaPor(pid, () => !termino)).toBe(true)
    pausa.soltar()
    expect((await cierre).error).toBeNull()
    const r = await act
    expect(r.error).toMatchObject({ statusCode: 400, code: 'FECHA_FUERA_DE_RANGO', details: { desde: '2026-10-01' } })
    expect(await ventanasDe(B)).toEqual([])
    // Al menos un reintento: el primero vio el septiembre de antes (su foto es de antes de esperar).
    expect(intentos.mock.calls.length).toBeGreaterThanOrEqual(2)
  }, 60_000)

  it('activar llega primero: el cierre espera; al confirmar activar, el cierre ve el ciclo, se repite y pide revisar (HUELLA_CAMBIO); la ventana nunca queda dentro de un septiembre cerrado sin contarla', async () => {
    await activar(p.m(), { desde: '2026-09-01', sedes: [A], propinasDesde: '2026-09-01T06:00:00Z' })
    await cobro(p.m(), { iso: '2026-09-20T18:00:00Z', propina: 30, servedById: p.m().carla, venueId: B })
    const pv = await preview('2026-09-15', OCT2)
    expect(pv).toMatchObject({ propinas: 0 })
    // Pausa a activar después de escribir su ventana (con sus candados tomados), en su ActivityLog.
    const real = auditoria.writeLegacyActivityAuditTx
    let soltar!: () => void
    const suelto = new Promise<void>(res => (soltar = res))
    let avisar!: (pid: number) => void
    const llego = new Promise<number>(res => (avisar = res))
    const espia = jest.spyOn(auditoria, 'writeLegacyActivityAuditTx')
    p.espiar(espia)
    espia.mockImplementationOnce((async (tx: any, ...resto: any[]) => {
      const r = await (real as any)(tx, ...resto)
      const [{ pid }] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`
      avisar(pid)
      await suelto
      return r
    }) as any)
    try {
      const act = resultado(activarB({ desde: '2026-09-15', ahora: OCT2 }))
      const pid = await Promise.race([llego, act.then(() => null)])
      expect(pid).not.toBeNull()
      let termino = false
      const cierre = resultado(cerrar('2026-09-15', OCT2, pv.huella)).finally(() => (termino = true))
      expect(await esperarDetenidaPor(pid, () => !termino)).toBe(true)
      soltar()
      expect((await act).error).toBeNull()
      expect((await cierre).error).toMatchObject({ statusCode: 409, code: 'HUELLA_CAMBIO' })
    } finally {
      soltar()
    }
    expect(await ventanasDe(B)).toEqual([['2026-09-15', null]])
    expect(await prisma.servicePayPeriod.count({ where: { organizationId: p.m().orgId, status: 'CLOSED' } })).toBe(0)
    // Con la vista previa nueva, septiembre se cierra contando la ventana de B: la propina del 20-sep entra.
    const nueva = await preview('2026-09-15', OCT2)
    expect(nueva).toMatchObject({ propinas: 1, totalVentas: '30.00' })
    expect((await cerrar('2026-09-15', OCT2, nueva.huella)).total).toBe('30.00')
  }, 60_000)
})
