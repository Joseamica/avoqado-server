// tests/integration/staffPay/liquidacion.test.ts — «Liquidar diferencia» (spec §6.4, §5.6, §9.2)
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { liquidarDiferencia, previewLiquidacion } from '@/services/dashboard/staffPay/liquidacion.service'
import { diferenciasDeClase } from '@/services/dashboard/staffPay/diferencias.service'
import { guardarAjusteDeClase } from '@/services/dashboard/staffPay/ajustesClase.service'
import { valorarClases } from '@/services/dashboard/staffPay/valoracion'
import { cerrarPeriodo, previewCierre } from '@/services/dashboard/staffPay/cierre.service'
import { fechaComoDbDate, venuePeriodRange } from '@/services/dashboard/staffPay/periodos'
import * as periodosGuardados from '@/services/dashboard/staffPay/periodosGuardados'
import { ForbiddenError } from '@/errors/AppError'
import {
  barreraDeLaClase,
  barreraDelPeriodo,
  borrarMundo,
  clase,
  confirmadas,
  crearMundo,
  crearSede,
  Mundo,
  tablaMindform,
  TZ,
} from './_mundo'

// Los permisos de escribir se resuelven ANTES de la transacción con `sedesConPermiso` (regla del Bloque A); `__vetadas`
// son las sedes donde el actor NO tiene staffpay:close, y `__ilegibles` las que no puede leer (staffpay:read).
jest.mock('@/services/dashboard/staffPay/acceso', () => ({
  ...jest.requireActual('@/services/dashboard/staffPay/acceso'),
  sedesConServicePay: jest.fn(async () => (global as any).__sedes),
  sedesLegibles: jest.fn(async () => ({ venueIds: (global as any).__sedes, parcial: false })),
  sedesLegiblesDe: jest.fn(async (_u: string, venueIds: string[]) => {
    const legibles = venueIds.filter(v => !((global as any).__ilegibles ?? []).includes(v))
    return { venueIds: legibles, parcial: legibles.length < venueIds.length }
  }),
  sedesConPermiso: jest.fn(async (_u: string, venueIds: string[]) => venueIds.filter(v => !((global as any).__vetadas ?? []).includes(v))),
  tienePermisoEn: jest.fn(async () => true),
  assertPermisoEnSedes: jest.fn(async () => undefined),
}))
const acceso = jest.requireMock('@/services/dashboard/staffPay/acceso')

const AHORA = new Date('2026-09-02T12:00:00Z')
const DESTINO = '2026-09-10' // septiembre, abierto
let m: Mundo
let n = 0
const cerrarAgosto = async (w: Mundo = m) => {
  const p = await previewCierre({ userId: w.owner, venueId: w.venueId, fecha: '2026-08-15', ahora: AHORA })
  return (
    await cerrarPeriodo({
      userId: w.owner,
      venueId: w.venueId,
      fecha: '2026-08-15',
      ahora: AHORA,
      huellaEsperada: p.huella,
      confirmarHuerfanas: true,
    })
  ).periodId
}
const liquidar = async (classSessionId: string, extra: Partial<{ huella: string; solicitudId: string; origen: string; w: Mundo }> = {}) => {
  const w = extra.w ?? m
  const pv = await previewLiquidacion({ userId: w.owner, venueId: w.venueId, classSessionId, destinoFecha: DESTINO, ahora: AHORA })
  return liquidarDiferencia({
    userId: w.owner,
    venueId: w.venueId,
    classSessionId,
    destinoFecha: DESTINO,
    ahora: AHORA,
    periodoOrigenId: extra.origen ?? pv.periodoOrigen!.id,
    huellaEsperada: extra.huella ?? pv.huella,
    solicitudId: extra.solicitudId ?? `${m.key}-${++n}`,
  })
}
const pendientes = async (classSessionId: string) =>
  Object.fromEntries(
    (await diferenciasDeClase(prisma, { venueId: m.venueId, classSessionId }, { ahora: AHORA })).filas.map(f => [f.persona, f.pendiente]),
  )
const reconcile = (sourceId: string) => prisma.serviceEarning.count({ where: { sourceId, concept: 'RECONCILE' } })

beforeEach(async () => {
  m = await crearMundo('liquidacion')
  ;(global as any).__sedes = [m.venueId]
  ;(global as any).__vetadas = []
  ;(global as any).__ilegibles = []
  await tablaMindform(m)
})
afterEach(() => borrarMundo(m))

describe('liquidar una diferencia (spec §6.4)', () => {
  it('liquidar deja el pendiente en $0; liquidar otra vez (aun con otra clave) no crea un segundo ajuste', async () => {
    const id = await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    await cerrarAgosto()
    await prisma.classSessionPayState.update({ where: { classSessionId: id }, data: { payCountOverride: 9 } })
    const r = await liquidar(id, { solicitudId: `${m.key}-fija` })
    expect(r).toEqual({ lineas: [{ staffId: m.ana, amount: '40.00' }], yaLiquidada: false })
    expect(await pendientes(id)).toEqual({ [m.ana]: '0.00' })
    expect(await liquidar(id, { solicitudId: `${m.key}-fija` })).toMatchObject({ yaLiquidada: true })
    expect(await liquidar(id)).toEqual({ lineas: [], yaLiquidada: true })
    expect(await reconcile(id)).toBe(1)
    const linea = await prisma.serviceEarning.findFirstOrThrow({ where: { sourceId: id, concept: 'RECONCILE' } })
    expect(linea.periodId).not.toBe((await prisma.classSessionPayState.findUniqueOrThrow({ where: { classSessionId: id } })).originPeriodId)
    // La línea lleva su sede, su foto y el periodo de origen en el descriptor (spec §5.6).
    expect(linea).toMatchObject({ venueId: m.venueId, payLevelId: m.hc, count: 9, clientKey: `${m.key}-fija:${m.ana}` })
    expect(linea.descriptor).toMatchObject({ clase: 'Reformer', fecha: '2026-08-04', sede: `${m.key}-pn`, coach: 'Ana QA' })
    expect(linea.descriptor).toMatchObject({ periodoOrigen: { start: '2026-08-01', end: '2026-08-31' } })
    const log = await prisma.activityLog.findFirstOrThrow({ where: { action: 'SERVICE_PAY_DIFFERENCE_SETTLED', entityId: id } })
    expect(log).toMatchObject({ staffId: m.owner, venueId: m.venueId })
  })

  it('sustitución A → B → C liquidada en dos tiempos: A en 0, B en 0, C con su monto', async () => {
    const id = await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    await cerrarAgosto()
    await prisma.classSession.update({ where: { id }, data: { assignedStaffId: m.sofia } })
    await liquidar(id)
    await prisma.classSession.update({ where: { id }, data: { assignedStaffId: m.carla } })
    await liquidar(id)
    const neto = await prisma.serviceEarning.groupBy({ by: ['staffId'], where: { sourceId: id }, _sum: { amount: true } })
    expect(Object.fromEntries(neto.map(x => [x.staffId, x._sum.amount!.toFixed(2)]))).toEqual({
      [m.ana]: '0.00',
      [m.sofia]: '0.00',
      [m.carla]: '480.00',
    })
    // La foto del −Ana lleva el nivel de SU primera línea (Head Coach), no el de la coach de hoy (Codex R1-5).
    const menosAna = await prisma.serviceEarning.findFirstOrThrow({ where: { sourceId: id, staffId: m.ana, concept: 'RECONCILE' } })
    expect(menosAna).toMatchObject({ payLevelId: m.hc, payLevelName: 'Head Coach' })
  })

  it('una clase que llegó tarde se ancla en su periodo de origen al liquidar y, movida a un periodo abierto, no se paga dos veces', async () => {
    const origen = await cerrarAgosto()
    const id = await clase(m, { staffId: m.ana, inicioIso: '2026-08-20T14:00:00Z', reservas: confirmadas(3) })
    await liquidar(id)
    expect(await prisma.classSessionPayState.findUniqueOrThrow({ where: { classSessionId: id } })).toMatchObject({ originPeriodId: origen })
    await prisma.classSession.update({
      where: { id },
      data: { startsAt: new Date('2026-09-05T14:00:00Z'), endsAt: new Date('2026-09-05T14:50:00Z') },
    })
    const sept = venuePeriodRange({ start: '2026-09-01', end: '2026-09-30' }, TZ)
    const vivo = await valorarClases(
      prisma,
      { venueId: m.venueId, organizationId: m.orgId, tz: TZ, desde: sept.from, hasta: sept.to, ahora: new Date('2026-10-02T12:00:00Z') },
      { limite: 10 },
    )
    expect(vivo.map(c => c.classSessionId)).not.toContain(id)
    expect(await pendientes(id)).toEqual({ [m.ana]: '0.00' })
  })

  it('se mostraron +$40 y ahora salen +$80: rechaza con un preview nuevo y no escribe nada', async () => {
    const id = await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    await cerrarAgosto()
    await prisma.classSessionPayState.update({ where: { classSessionId: id }, data: { payCountOverride: 9 } })
    const viejo = await previewLiquidacion({ userId: m.owner, venueId: m.venueId, classSessionId: id, destinoFecha: DESTINO, ahora: AHORA })
    expect(viejo.total).toBe('40.00')
    await prisma.classSessionPayState.update({ where: { classSessionId: id }, data: { payCountOverride: 10 } })
    await expect(liquidar(id, { huella: viejo.huella })).rejects.toMatchObject({
      code: 'HUELLA_CAMBIO',
      details: { preview: { total: '80.00' } },
    })
    expect(await reconcile(id)).toBe(0)
  })

  it('una clase sin ancla movida a un periodo abierto entre el preview y la confirmación se rechaza', async () => {
    const origen = await cerrarAgosto()
    const id = await clase(m, { staffId: m.ana, inicioIso: '2026-08-20T14:00:00Z', reservas: confirmadas(3) })
    const pv = await previewLiquidacion({ userId: m.owner, venueId: m.venueId, classSessionId: id, destinoFecha: DESTINO, ahora: AHORA })
    await prisma.classSession.update({
      where: { id },
      data: { startsAt: new Date('2026-09-01T14:00:00Z'), endsAt: new Date('2026-09-01T14:50:00Z') },
    })
    await expect(
      liquidarDiferencia({
        userId: m.owner,
        venueId: m.venueId,
        classSessionId: id,
        destinoFecha: DESTINO,
        ahora: AHORA,
        periodoOrigenId: origen,
        huellaEsperada: pv.huella,
        solicitudId: `${m.key}-mov`,
      }),
    ).rejects.toMatchObject({ code: 'ORIGEN_CAMBIO' })
    expect(await prisma.classSessionPayState.findUnique({ where: { classSessionId: id } })).toBeNull()
  })

  it('una clase en excepción no se liquida; «Ajustar monto» con coach la resuelve aunque a la versión anclada le falte la celda', async () => {
    const id = await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    await cerrarAgosto()
    await prisma.servicePayTableCell.deleteMany({ where: { payLevelId: m.hc, count: 9 } })
    await prisma.classSessionPayState.update({ where: { classSessionId: id }, data: { payCountOverride: 9 } })
    await expect(liquidar(id)).rejects.toMatchObject({ code: 'CLASE_EN_EXCEPCION' })
    await prisma.classSessionPayState.update({ where: { classSessionId: id }, data: { payAmountOverride: new Prisma.Decimal(600) } })
    expect(await liquidar(id)).toMatchObject({ lineas: [{ staffId: m.ana, amount: '30.00' }] })
  })

  it('una clase excluida por falta de tabla y rehabilitada después fija su versión UNA vez', async () => {
    await prisma.servicePayTable.updateMany({ where: { venueId: m.venueId }, data: { archivedFrom: fechaComoDbDate('2026-01-01') } })
    const id = await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    await prisma.classSessionPayState.create({ data: { classSessionId: id, payExcluded: true, overrideReason: 'sin tabla' } })
    await cerrarAgosto()
    expect(await prisma.classSessionPayState.findUniqueOrThrow({ where: { classSessionId: id } })).toMatchObject({
      valuationVersionId: null,
    })
    await prisma.servicePayTable.updateMany({ where: { venueId: m.venueId }, data: { archivedFrom: null } })
    await prisma.classSessionPayState.update({ where: { classSessionId: id }, data: { payExcluded: false } })
    await liquidar(id)
    const ancla = await prisma.classSessionPayState.findUniqueOrThrow({ where: { classSessionId: id } })
    expect(ancla.valuationVersionId).not.toBeNull()
    const v1 = ancla.valuationVersionId
    await liquidar(id)
    expect((await prisma.classSessionPayState.findUniqueOrThrow({ where: { classSessionId: id } })).valuationVersionId).toBe(v1)
  })

  it('una línea de una sede fuera del alcance del destino se rechaza con explicación', async () => {
    const bsf = await crearSede(m.orgId, m.key, 'bsf')
    ;(global as any).__sedes = [m.venueId, bsf.venueId]
    await tablaMindform(m, bsf.venueId)
    const id = await clase(m, {
      staffId: m.ana,
      inicioIso: '2026-08-04T14:00:00Z',
      reservas: confirmadas(8),
      venueId: bsf.venueId,
      productId: bsf.productId,
    })
    await cerrarAgosto()
    ;(global as any).__sedes = [m.venueId] // BSF apagó el módulo: septiembre nace sin BSF
    await prisma.classSessionPayState.update({ where: { classSessionId: id }, data: { payCountOverride: 9 } })
    const pv = await previewLiquidacion({ userId: m.owner, venueId: bsf.venueId, classSessionId: id, destinoFecha: DESTINO, ahora: AHORA })
    // El dashboard sabe que tiene que ofrecer «Sumar la sede y liquidar».
    expect(pv).toMatchObject({ sedeEnDestino: false, destino: { venueIds: [m.venueId] } })
    const pedir = (ampliarAlcance: boolean) =>
      liquidarDiferencia({
        userId: m.owner,
        venueId: bsf.venueId,
        classSessionId: id,
        destinoFecha: DESTINO,
        ahora: AHORA,
        periodoOrigenId: pv.periodoOrigen!.id,
        huellaEsperada: pv.huella,
        solicitudId: `${m.key}-bsf`,
        ampliarAlcance,
      })
    await expect(pedir(false)).rejects.toMatchObject({ code: 'SEDE_FUERA_DEL_PERIODO' })
    // Liquidar (y ampliar) pide staffpay:close en la sede de la clase Y en todas las del destino: sin PN, nadie suma BSF.
    ;(global as any).__vetadas = [m.venueId]
    await expect(pedir(true)).rejects.toBeInstanceOf(ForbiddenError)
    ;(global as any).__vetadas = []
    // La deuda de una sede apagada siempre tiene dónde caer: con ampliación explícita y permiso (spec §5.6, R1-1).
    expect(await pedir(true)).toMatchObject({ lineas: [{ staffId: m.ana, amount: '40.00' }] })
    const sept = await prisma.servicePayPeriod.findFirstOrThrow({ where: { organizationId: m.orgId, status: 'OPEN' } })
    expect(sept.venueIds).toContain(bsf.venueId)
    expect(await prisma.serviceEarning.findFirstOrThrow({ where: { sourceId: id, concept: 'RECONCILE' } })).toMatchObject({
      venueId: bsf.venueId,
      periodId: sept.id,
    })
  })

  it('una clave de solicitud usada para otra clase es un error, no el éxito de la otra (Codex R1-4)', async () => {
    const a = await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    const b = await clase(m, { staffId: m.ana, inicioIso: '2026-08-05T14:00:00Z', reservas: confirmadas(8) })
    await cerrarAgosto()
    await prisma.classSessionPayState.updateMany({ where: { classSessionId: { in: [a, b] } }, data: { payCountOverride: 9 } })
    await liquidar(a, { solicitudId: `${m.key}-misma` })
    await expect(liquidar(b, { solicitudId: `${m.key}-misma` })).rejects.toMatchObject({ code: 'CLAVE_REUTILIZADA' })
    await expect(liquidar(b, { solicitudId: 'con:dos-puntos' })).rejects.toThrow(/Clave de solicitud inválida/)
    expect(await pendientes(b)).toEqual({ [m.ana]: '40.00' })
  })

  it('la misma clave en OTRA organización no es «la misma operación»: cada negocio liquida lo suyo', async () => {
    const id = await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    await cerrarAgosto()
    await prisma.classSessionPayState.update({ where: { classSessionId: id }, data: { payCountOverride: 9 } })
    const clave = `${m.key}-compartida`
    expect(await liquidar(id, { solicitudId: clave })).toMatchObject({ yaLiquidada: false })
    const otro = await crearMundo('liquidacion-otra')
    try {
      ;(global as any).__sedes = [otro.venueId]
      await tablaMindform(otro)
      const suya = await clase(otro, { staffId: otro.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
      await cerrarAgosto(otro)
      await prisma.classSessionPayState.update({ where: { classSessionId: suya }, data: { payCountOverride: 10 } })
      expect(await liquidar(suya, { solicitudId: clave, w: otro })).toEqual({
        lineas: [{ staffId: otro.ana, amount: '80.00' }],
        yaLiquidada: false,
      })
      expect(await prisma.serviceEarning.count({ where: { organizationId: otro.orgId, concept: 'RECONCILE' } })).toBe(1)
    } finally {
      await borrarMundo(otro)
    }
  })

  it('sin staffpay:close en la sede de la clase no se liquida, y la repetición de una solicitud ya hecha tampoco regala montos', async () => {
    const id = await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    await cerrarAgosto()
    await prisma.classSessionPayState.update({ where: { classSessionId: id }, data: { payCountOverride: 9 } })
    ;(global as any).__vetadas = [m.venueId]
    await expect(liquidar(id, { solicitudId: `${m.key}-permiso` })).rejects.toBeInstanceOf(ForbiddenError)
    expect(await reconcile(id)).toBe(0)
    ;(global as any).__vetadas = []
    expect(await liquidar(id, { solicitudId: `${m.key}-permiso` })).toMatchObject({ yaLiquidada: false })
    ;(global as any).__vetadas = [m.venueId]
    await expect(liquidar(id, { solicitudId: `${m.key}-permiso` })).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('módulos y permisos se resuelven ANTES de la transacción: dentro no se llama al cliente global', async () => {
    // Con el pool lleno, una transacción que pide OTRA conexión para el módulo o el permiso espera a sí misma (timeout).
    // Caminos: un destino que se CREA, uno al que se le SUMA la sede (ampliar), la repetición idempotente y HUELLA_CAMBIO.
    const bsf = await crearSede(m.orgId, m.key, 'bsf')
    ;(global as any).__sedes = [m.venueId, bsf.venueId]
    await tablaMindform(m, bsf.venueId)
    const id = await clase(m, {
      staffId: m.ana,
      inicioIso: '2026-08-04T14:00:00Z',
      reservas: confirmadas(8),
      venueId: bsf.venueId,
      productId: bsf.productId,
    })
    await cerrarAgosto()
    ;(global as any).__sedes = [m.venueId]
    await prisma.classSessionPayState.update({ where: { classSessionId: id }, data: { payCountOverride: 9 } })
    const linea: string[] = []
    const real = prisma.$transaction.bind(prisma)
    const espia = jest.spyOn(prisma, '$transaction').mockImplementation(((fn: any, o: any) =>
      real(async (tx: any) => {
        linea.push('abre')
        try {
          return await fn(tx)
        } finally {
          linea.push('cierra')
        }
      }, o)) as any)
    const globales = ['sedesConServicePay', 'sedesConPermiso', 'assertPermisoEnSedes', 'tienePermisoEn', 'sedesLegiblesDe'] as const
    const originales = globales.map(g => acceso[g].getMockImplementation())
    globales.forEach((g, i) =>
      acceso[g].mockImplementation(async (...a: unknown[]) => {
        linea.push(g)
        return originales[i](...a)
      }),
    )
    try {
      const pv = await previewLiquidacion({
        userId: m.owner,
        venueId: bsf.venueId,
        classSessionId: id,
        destinoFecha: DESTINO,
        ahora: AHORA,
      })
      const pedir = (huellaEsperada: string) =>
        liquidarDiferencia({
          userId: m.owner,
          venueId: bsf.venueId,
          classSessionId: id,
          destinoFecha: DESTINO,
          ahora: AHORA,
          periodoOrigenId: pv.periodoOrigen!.id,
          huellaEsperada,
          solicitudId: `${m.key}-global`,
          ampliarAlcance: true,
        })
      await expect(pedir('0'.repeat(64))).rejects.toMatchObject({ code: 'HUELLA_CAMBIO' })
      expect(await pedir(pv.huella)).toMatchObject({ yaLiquidada: false })
      expect(await pedir(pv.huella)).toMatchObject({ yaLiquidada: true })
    } finally {
      espia.mockRestore()
      globales.forEach((g, i) => acceso[g].mockImplementation(originales[i]))
    }
    const dentro: string[] = []
    let abierta = 0
    for (const x of linea) {
      if (x === 'abre') abierta++
      else if (x === 'cierra') abierta--
      else if (abierta > 0) dentro.push(x)
    }
    expect(linea.filter(x => x === 'abre').length).toBeGreaterThanOrEqual(3)
    expect(dentro).toEqual([])
  })

  // Codex bloque B, P2: `Promise.allSettled` no garantizaba el cruce y `pagado + pendiente = 0` era circular (dos RECONCILE de
  // +$40 también daban 0). Se fuerzan los dos órdenes y se afirman valores. La cancelación es una escritura normal, sin los
  // candados del pago (como la de reservas). Con SERIALIZABLE la foto se toma en la PRIMERA sentencia de la transacción: una
  // barrera de la base (clase o periodo) sólo detiene a la liquidación DESPUÉS de su foto. Para el orden «la cancelación
  // primero» la barrera va antes de la transacción: en la resolución de permisos, que se hace afuera.
  it.each([
    ['la cancelación confirma mientras la liquidación espera el candado de la clase, ya con su foto', 'despues'],
    ['la cancelación confirma antes de que la liquidación abra su transacción', 'antes'],
  ] as const)('una cancelación que llega a media liquidación queda de un lado de la foto (%s)', async (_t, cuando) => {
    const id = await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    await cerrarAgosto()
    await prisma.classSessionPayState.update({ where: { classSessionId: id }, data: { payCountOverride: 9 } })
    const pv = await previewLiquidacion({ userId: m.owner, venueId: m.venueId, classSessionId: id, destinoFecha: DESTINO, ahora: AHORA })
    const cancelar = () => prisma.classSession.update({ where: { id }, data: { status: 'CANCELLED' } })
    const liquidacion = () => {
      const p = liquidarDiferencia({
        userId: m.owner,
        venueId: m.venueId,
        classSessionId: id,
        destinoFecha: DESTINO,
        ahora: AHORA,
        periodoOrigenId: pv.periodoOrigen!.id,
        huellaEsperada: pv.huella,
        solicitudId: `${m.key}-carrera`,
      })
      p.catch(() => undefined) // si algo falla antes del allSettled, que no quede un rechazo sin atender
      return p
    }
    let liq: Promise<unknown> | undefined
    if (cuando === 'despues') {
      const barrera = await barreraDeLaClase(id)
      try {
        liq = liquidacion()
        await barrera.esperarA(1) // ya tomó su foto y el destino; espera la clase
        await cancelar() // no toma candados del pago: confirma mientras tanto
      } finally {
        await barrera.soltar()
      }
    } else {
      let soltar!: () => void
      let detenida!: () => void
      const suelto = new Promise<void>(r => (soltar = r))
      const enEspera = new Promise<void>(r => (detenida = r))
      const original = acceso.sedesConPermiso.getMockImplementation()
      acceso.sedesConPermiso.mockImplementationOnce(async (...a: unknown[]) => {
        detenida()
        await suelto
        return original(...a)
      })
      liq = liquidacion()
      await enEspera
      await cancelar()
      soltar()
    }
    const [resultado] = await Promise.allSettled([liq!])
    const montos = async (concept: 'SERVICE' | 'RECONCILE') =>
      (await prisma.serviceEarning.findMany({ where: { sourceId: id, concept }, take: 5 })).map(e => e.amount.toFixed(2))
    expect(await montos('SERVICE')).toEqual(['570.00']) // lo congelado no se mueve
    if (cuando === 'despues') {
      // La liquidación quedó antes de la foto: paga +$40 una vez y la cancelación aparece como el nuevo negativo.
      expect(resultado).toEqual({ status: 'fulfilled', value: { lineas: [{ staffId: m.ana, amount: '40.00' }], yaLiquidada: false } })
      expect(await montos('RECONCILE')).toEqual(['40.00'])
      expect(await pendientes(id)).toEqual({ [m.ana]: '-610.00' })
    } else {
      // La cancelación quedó antes de la foto: la huella cambió (ahora son −$570) y no se escribe nada.
      expect(resultado).toMatchObject({ status: 'rejected', reason: { code: 'HUELLA_CAMBIO', details: { preview: { total: '-570.00' } } } })
      expect(await montos('RECONCILE')).toEqual([])
      expect(await pendientes(id)).toEqual({ [m.ana]: '-570.00' })
    }
  })

  it('repetir la MISMA solicitud después de que su destino se cerró la reconoce: yaLiquidada, sin líneas nuevas (Codex R2-R1-4)', async () => {
    const id = await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    await cerrarAgosto()
    await prisma.classSessionPayState.update({ where: { classSessionId: id }, data: { payCountOverride: 9 } })
    const pv = await previewLiquidacion({ userId: m.owner, venueId: m.venueId, classSessionId: id, destinoFecha: DESTINO, ahora: AHORA })
    const pedir = () =>
      liquidarDiferencia({
        userId: m.owner,
        venueId: m.venueId,
        classSessionId: id,
        destinoFecha: DESTINO,
        ahora: AHORA,
        periodoOrigenId: pv.periodoOrigen!.id,
        huellaEsperada: pv.huella,
        solicitudId: `${m.key}-sept`,
      })
    expect(await pedir()).toEqual({ lineas: [{ staffId: m.ana, amount: '40.00' }], yaLiquidada: false })
    // Se pierde la respuesta; mientras tanto septiembre termina y se cierra.
    const OCTUBRE = new Date('2026-10-02T12:00:00Z')
    const ps = await previewCierre({ userId: m.owner, venueId: m.venueId, fecha: DESTINO, ahora: OCTUBRE })
    await cerrarPeriodo({
      userId: m.owner,
      venueId: m.venueId,
      fecha: DESTINO,
      ahora: OCTUBRE,
      huellaEsperada: ps.huella,
      confirmarHuerfanas: true,
    })
    // La repetición idéntica NO recibe PERIODO_CERRADO: es la misma operación, ya registrada.
    expect(await pedir()).toEqual({ lineas: [{ staffId: m.ana, amount: '40.00' }], yaLiquidada: true })
    // También sin fecha (hoy ya es octubre) y con otra fecha DENTRO del periodo donde quedó (Codex bloque B, P1 (b) y (c)).
    const repetir = (destinoFecha?: string) =>
      liquidarDiferencia({
        userId: m.owner,
        venueId: m.venueId,
        classSessionId: id,
        destinoFecha,
        ahora: OCTUBRE,
        periodoOrigenId: pv.periodoOrigen!.id,
        huellaEsperada: pv.huella,
        solicitudId: `${m.key}-sept`,
      })
    expect(await repetir()).toEqual({ lineas: [{ staffId: m.ana, amount: '40.00' }], yaLiquidada: true })
    expect(await repetir('2026-09-30')).toEqual({ lineas: [{ staffId: m.ana, amount: '40.00' }], yaLiquidada: true })
    expect(await reconcile(id)).toBe(1)
    // Una solicitud NUEVA a ese destino ya cerrado sí recibe PERIODO_CERRADO.
    await expect(liquidar(id)).rejects.toMatchObject({ code: 'PERIODO_CERRADO' })
  })

  it('la MISMA clave pedida para OTRO destino explícito no es la misma operación: CLAVE_REUTILIZADA y no escribe (Codex bloque B, P1)', async () => {
    const id = await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    await cerrarAgosto()
    await prisma.classSessionPayState.update({ where: { classSessionId: id }, data: { payCountOverride: 9 } })
    const clave = `${m.key}-k`
    expect(await liquidar(id, { solicitudId: clave })).toEqual({ lineas: [{ staffId: m.ana, amount: '40.00' }], yaLiquidada: false })
    // Aparece otra diferencia (+$40) y se pide liquidarla en OCTUBRE con la misma clave: antes devolvía las líneas de
    // septiembre como `yaLiquidada` y lo nuevo quedaba sin pagar.
    await prisma.classSessionPayState.update({ where: { classSessionId: id }, data: { payCountOverride: 10 } })
    const OCT = '2026-10-10'
    const pv = await previewLiquidacion({ userId: m.owner, venueId: m.venueId, classSessionId: id, destinoFecha: OCT, ahora: AHORA })
    await expect(
      liquidarDiferencia({
        userId: m.owner,
        venueId: m.venueId,
        classSessionId: id,
        destinoFecha: OCT,
        ahora: AHORA,
        periodoOrigenId: pv.periodoOrigen!.id,
        huellaEsperada: pv.huella,
        solicitudId: clave,
      }),
    ).rejects.toMatchObject({
      code: 'CLAVE_REUTILIZADA',
      message: expect.stringMatching(/ya se usó para liquidar en el periodo del 2026-09-01 al 2026-09-30: usa otra clave/),
    })
    expect(await reconcile(id)).toBe(1)
    expect(await pendientes(id)).toEqual({ [m.ana]: '40.00' })
  })

  it('dos liquidaciones SIMULTÁNEAS de la misma clase con solicitudes distintas dejan UN juego de líneas (barrera real — Codex R2-R1-15)', async () => {
    const id = await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    await cerrarAgosto()
    await prisma.classSessionPayState.update({ where: { classSessionId: id }, data: { payCountOverride: 9 } })
    // El destino existe ANTES: las dos lo encuentran y se detienen en su candado (la barrera lo tiene).
    const sept = await prisma.servicePayPeriod.create({
      data: {
        organizationId: m.orgId,
        periodStart: fechaComoDbDate('2026-09-01'),
        periodEnd: fechaComoDbDate('2026-09-30'),
        venueIds: [m.venueId],
      },
    })
    const pv = await previewLiquidacion({ userId: m.owner, venueId: m.venueId, classSessionId: id, destinoFecha: DESTINO, ahora: AHORA })
    const pedir = (s: string) =>
      liquidarDiferencia({
        userId: m.owner,
        venueId: m.venueId,
        classSessionId: id,
        destinoFecha: DESTINO,
        ahora: AHORA,
        periodoOrigenId: pv.periodoOrigen!.id,
        huellaEsperada: pv.huella,
        solicitudId: `${m.key}-${s}`,
      })
    const barrera = await barreraDelPeriodo(sept.id)
    const carrera = Promise.allSettled([pedir('uno'), pedir('dos')])
    try {
      await barrera.esperarA(2)
    } finally {
      await barrera.soltar()
    }
    const resultados = await carrera
    // Exactamente UNA escribe; la otra termina en yaLiquidada o en HUELLA_CAMBIO (su huella ya no cuadra).
    const escribieron = resultados.filter(r => r.status === 'fulfilled' && !r.value.yaLiquidada)
    expect(escribieron).toHaveLength(1)
    for (const r of resultados) {
      if (r.status === 'rejected') expect(r.reason).toMatchObject({ code: 'HUELLA_CAMBIO' })
    }
    expect(await reconcile(id)).toBe(1)
    expect(await pendientes(id)).toEqual({ [m.ana]: '0.00' })
  })

  it('doble clic: la MISMA solicitud dos veces a la vez escribe una vez y la otra devuelve la misma operación', async () => {
    const id = await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    await cerrarAgosto()
    await prisma.classSessionPayState.update({ where: { classSessionId: id }, data: { payCountOverride: 9 } })
    const sept = await prisma.servicePayPeriod.create({
      data: {
        organizationId: m.orgId,
        periodStart: fechaComoDbDate('2026-09-01'),
        periodEnd: fechaComoDbDate('2026-09-30'),
        venueIds: [m.venueId],
      },
    })
    const pv = await previewLiquidacion({ userId: m.owner, venueId: m.venueId, classSessionId: id, destinoFecha: DESTINO, ahora: AHORA })
    const pedir = () =>
      liquidarDiferencia({
        userId: m.owner,
        venueId: m.venueId,
        classSessionId: id,
        destinoFecha: DESTINO,
        ahora: AHORA,
        periodoOrigenId: pv.periodoOrigen!.id,
        huellaEsperada: pv.huella,
        solicitudId: `${m.key}-doble`,
      })
    const barrera = await barreraDelPeriodo(sept.id)
    const carrera = Promise.allSettled([pedir(), pedir()])
    try {
      await barrera.esperarA(2)
    } finally {
      await barrera.soltar()
    }
    const resultados = await carrera
    const lineas = [{ staffId: m.ana, amount: '40.00' }]
    expect(
      resultados.map(r => (r.status === 'fulfilled' ? r.value : r.reason)).sort((a, b) => Number(a.yaLiquidada) - Number(b.yaLiquidada)),
    ).toEqual([
      { lineas, yaLiquidada: false },
      { lineas, yaLiquidada: true },
    ])
    expect(await reconcile(id)).toBe(1)
  })

  // Heredada de la revisión del Bloque A (A10): el ajuste de clase toma origen → clase; la liquidación, destino → clase.
  // La barrera tiene el candado de la CLASE: cuando se suelta, las dos ya tienen SU periodo. Si la liquidación bloqueara
  // también el origen (destino → clase → origen) habría ciclo y 40P01, que no se reintenta. Se prueban los dos órdenes.
  it.each([
    ['la liquidación llega primero al candado de la clase', 'liquidacion'],
    ['el ajuste llega primero al candado de la clase', 'ajuste'],
  ] as const)('ajuste tardío de la MISMA clase mientras se liquida: ningún bloqueo mutuo y el dinero cuadra (%s)', async (_t, primero) => {
    const id = await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    await cerrarAgosto()
    await prisma.classSessionPayState.update({ where: { classSessionId: id }, data: { payCountOverride: 9 } })
    const pv = await previewLiquidacion({ userId: m.owner, venueId: m.venueId, classSessionId: id, destinoFecha: DESTINO, ahora: AHORA })
    expect(pv.total).toBe('40.00')
    const liquidacion = () =>
      liquidarDiferencia({
        userId: m.owner,
        venueId: m.venueId,
        classSessionId: id,
        destinoFecha: DESTINO,
        ahora: AHORA,
        periodoOrigenId: pv.periodoOrigen!.id,
        huellaEsperada: pv.huella,
        solicitudId: `${m.key}-cruce`,
      })
    const ajuste = () =>
      guardarAjusteDeClase({
        venueId: m.venueId,
        classSessionId: id,
        payCountOverride: 10,
        payAmountOverride: null,
        payExcluded: false,
        reason: 'Eran diez',
        actorId: m.owner,
      })
    const barrera = await barreraDeLaClase(id)
    let carrera: Promise<[PromiseSettledResult<unknown>, PromiseSettledResult<unknown>]> | undefined
    try {
      const a = primero === 'liquidacion' ? liquidacion() : ajuste()
      a.catch(() => undefined) // si la barrera falla antes del allSettled, que no quede un rechazo sin atender
      await barrera.esperarA(1)
      const b = primero === 'liquidacion' ? ajuste() : liquidacion()
      carrera = (primero === 'liquidacion' ? Promise.allSettled([a, b]) : Promise.allSettled([b, a])) as typeof carrera
      await barrera.esperarA(2)
    } finally {
      await barrera.soltar()
    }
    const [liq, aj] = await carrera!
    // Nunca 40P01: el ajuste siempre se cumple, y la liquidación termina en uno de sus dos desenlaces correctos.
    expect(aj.status).toBe('fulfilled')
    if (liq.status === 'rejected') {
      // Vio el ajuste (ahora son +$80): rechaza con un preview nuevo y no escribe nada.
      expect(liq.reason).toMatchObject({ code: 'HUELLA_CAMBIO', details: { preview: { total: '80.00' } } })
      expect(await reconcile(id)).toBe(0)
    } else {
      // Pagó con la foto previa (+$40), que es lo que se confirmó; lo demás queda pendiente.
      expect(liq.value).toEqual({ lineas: [{ staffId: m.ana, amount: '40.00' }], yaLiquidada: false })
      expect(await reconcile(id)).toBe(1)
    }
    expect(await prisma.classSessionPayState.findUniqueOrThrow({ where: { classSessionId: id } })).toMatchObject({ payCountOverride: 10 })
    // El dinero cuadra: lo congelado de agosto no se movió y SERVICE + RECONCILE + lo pendiente = lo que corresponde hoy
    // (10 lugares de Head Coach = $650), sea cual sea el desenlace.
    const suma = async (concept: 'SERVICE' | 'RECONCILE') =>
      Number((await prisma.serviceEarning.aggregate({ where: { sourceId: id, concept }, _sum: { amount: true } }))._sum.amount ?? 0)
    expect(await suma('SERVICE')).toBe(570)
    expect((await suma('SERVICE')) + (await suma('RECONCILE')) + Number((await pendientes(id))[m.ana])).toBe(650)
  })

  // Ronda 1, Importante: `startsWith` viaja como `LIKE 'prefijo%'` SIN escapar (medido: el parámetro llega `x_cls_0001:%`),
  // y la clave admite «_», que en LIKE es comodín de un carácter.
  it('una clave con «_» no es comodín: no toma como suya la operación de una clave parecida', async () => {
    const a = await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    const b = await clase(m, { staffId: m.ana, inicioIso: '2026-08-05T14:00:00Z', reservas: confirmadas(8) })
    await cerrarAgosto()
    await prisma.classSessionPayState.updateMany({ where: { classSessionId: { in: [a, b] } }, data: { payCountOverride: 9 } })
    const mas40 = { lineas: [{ staffId: m.ana, amount: '40.00' }], yaLiquidada: false }
    expect(await liquidar(a, { solicitudId: 'x-cls-0001' })).toEqual(mas40)
    // Otra clase con una clave que, sin escapar, coincidiría con la de arriba: no es CLAVE_REUTILIZADA.
    expect(await liquidar(b, { solicitudId: 'x_cls_0001' })).toEqual(mas40)
    // La MISMA clase con otro pendiente y una clave que, sin escapar, sólo coincidiría con la suya: escribe la línea nueva
    // (sin escapar devolvía `yaLiquidada` con las líneas de OTRA operación y no pagaba lo nuevo).
    await prisma.classSessionPayState.update({ where: { classSessionId: a }, data: { payCountOverride: 10 } })
    expect(await liquidar(a, { solicitudId: 'x-cls_0001' })).toEqual(mas40)
    expect(await reconcile(a)).toBe(2)
    expect(await pendientes(a)).toEqual({ [m.ana]: '0.00' })
  })

  // Ronda 1, menor 2: la restricción única de `clientKey` es la red. Se fuerza de forma determinista: la «otra copia» de la
  // MISMA solicitud confirma su línea por otra conexión justo después del paso 0 (que ya no la vio) y antes del insert.
  it('red del índice único: la misma solicitud guardada entre el paso 0 y el insert se reconoce como ya liquidada', async () => {
    const id = await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    await cerrarAgosto()
    await prisma.classSessionPayState.update({ where: { classSessionId: id }, data: { payCountOverride: 9 } })
    const sept = await prisma.servicePayPeriod.create({
      data: {
        organizationId: m.orgId,
        periodStart: fechaComoDbDate('2026-09-01'),
        periodEnd: fechaComoDbDate('2026-09-30'),
        venueIds: [m.venueId],
      },
    })
    const pv = await previewLiquidacion({ userId: m.owner, venueId: m.venueId, classSessionId: id, destinoFecha: DESTINO, ahora: AHORA })
    const solicitudId = `${m.key}-red`
    const real = periodosGuardados.lockClase
    const espia = jest.spyOn(periodosGuardados, 'lockClase').mockImplementationOnce(async (tx, classSessionId) => {
      await prisma.serviceEarning.create({
        data: {
          organizationId: m.orgId,
          venueId: m.venueId,
          periodId: sept.id,
          staffId: m.ana,
          concept: 'RECONCILE',
          sourceType: 'CLASS_SESSION',
          sourceId: id,
          amount: new Prisma.Decimal(40),
          descriptor: {},
          clientKey: `${solicitudId}:${m.ana}`,
        },
      })
      return real(tx, classSessionId)
    })
    try {
      const r = await liquidarDiferencia({
        userId: m.owner,
        venueId: m.venueId,
        classSessionId: id,
        destinoFecha: DESTINO,
        ahora: AHORA,
        periodoOrigenId: pv.periodoOrigen!.id,
        huellaEsperada: pv.huella,
        solicitudId,
      })
      expect(r).toEqual({ lineas: [{ staffId: m.ana, amount: '40.00' }], yaLiquidada: true })
      expect(espia).toHaveBeenCalledTimes(1) // el segundo intento la reconoce en el paso 0, antes de cualquier candado
    } finally {
      espia.mockRestore()
    }
    expect(await reconcile(id)).toBe(1)
  })

  // Ronda 1, menor 3: el cruce real con el ajuste (`ajustesClase.service.ts`): una clase SIN ancla movida al periodo destino
  // hace que el ajuste tome destino → clase. La liquidación toma el MISMO orden; invertirlo (clase → destino) es un 40P01.
  it('clase sin ancla movida al periodo destino: el ajuste y la liquidación toman destino → clase, sin bloqueo mutuo', async () => {
    await cerrarAgosto()
    const id = await clase(m, { staffId: m.ana, inicioIso: '2026-08-20T14:00:00Z', reservas: confirmadas(3) })
    const pv = await previewLiquidacion({ userId: m.owner, venueId: m.venueId, classSessionId: id, destinoFecha: DESTINO, ahora: AHORA })
    expect(pv.total).toBe('430.00')
    await prisma.classSession.update({
      where: { id },
      data: { startsAt: new Date('2026-09-01T14:00:00Z'), endsAt: new Date('2026-09-01T14:50:00Z') },
    })
    const sept = await prisma.servicePayPeriod.create({
      data: {
        organizationId: m.orgId,
        periodStart: fechaComoDbDate('2026-09-01'),
        periodEnd: fechaComoDbDate('2026-09-30'),
        venueIds: [m.venueId],
      },
    })
    const barrera = await barreraDelPeriodo(sept.id)
    let carrera: Promise<[PromiseSettledResult<unknown>, PromiseSettledResult<unknown>]> | undefined
    try {
      const ajuste = guardarAjusteDeClase({
        venueId: m.venueId,
        classSessionId: id,
        payCountOverride: 4,
        payAmountOverride: null,
        payExcluded: false,
        reason: 'Eran cuatro',
        actorId: m.owner,
      })
      ajuste.catch(() => undefined) // si la barrera falla antes del allSettled, que no quede un rechazo sin atender
      await barrera.esperarA(1)
      const liquidacion = liquidarDiferencia({
        userId: m.owner,
        venueId: m.venueId,
        classSessionId: id,
        destinoFecha: DESTINO,
        ahora: AHORA,
        periodoOrigenId: pv.periodoOrigen!.id,
        huellaEsperada: pv.huella,
        solicitudId: `${m.key}-orden`,
      })
      carrera = Promise.allSettled([ajuste, liquidacion]) as typeof carrera
      await barrera.esperarA(2)
    } finally {
      await barrera.soltar()
    }
    const [aj, liq] = await carrera!
    expect(aj.status).toBe('fulfilled')
    expect(liq).toMatchObject({ status: 'rejected', reason: { code: 'ORIGEN_CAMBIO' } })
    expect(await reconcile(id)).toBe(0)
    expect(await prisma.classSessionPayState.findUniqueOrThrow({ where: { classSessionId: id } })).toMatchObject({
      payCountOverride: 4,
      originPeriodId: null,
    })
  })

  it('sin nada que pagar, anclar la clase o fijar su versión deja rastro (ActivityLog con lineas: [])', async () => {
    const origen = await cerrarAgosto()
    // Llegó tarde y está cancelada: le corresponde $0, no hay líneas, pero liquidar la ancla en su origen.
    const id = await clase(m, { staffId: m.ana, inicioIso: '2026-08-20T14:00:00Z', reservas: confirmadas(3), status: 'CANCELLED' })
    expect(await liquidar(id)).toEqual({ lineas: [], yaLiquidada: true })
    const ancla = await prisma.classSessionPayState.findUniqueOrThrow({ where: { classSessionId: id } })
    expect(ancla.originPeriodId).toBe(origen)
    const logs = () => prisma.activityLog.findMany({ where: { action: 'SERVICE_PAY_DIFFERENCE_SETTLED', entityId: id }, take: 5 })
    const [log] = await logs()
    expect(log).toMatchObject({ staffId: m.owner, venueId: m.venueId })
    expect(log.data).toMatchObject({ lineas: [], ancla: { periodoOrigen: origen, version: ancla.valuationVersionId } })
    // Repetir sin cambios no escribe nada, ni otro rastro.
    expect(await liquidar(id)).toEqual({ lineas: [], yaLiquidada: true })
    expect(await logs()).toHaveLength(1)
  })

  it('el preview sólo nombra las sedes del destino que quien lee puede ver; la huella sigue siendo la del alcance completo', async () => {
    const bsf = await crearSede(m.orgId, m.key, 'bsf')
    const id = await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    await cerrarAgosto()
    await prisma.classSessionPayState.update({ where: { classSessionId: id }, data: { payCountOverride: 9 } })
    await prisma.servicePayPeriod.create({
      data: {
        organizationId: m.orgId,
        periodStart: fechaComoDbDate('2026-09-01'),
        periodEnd: fechaComoDbDate('2026-09-30'),
        venueIds: [m.venueId, bsf.venueId],
      },
    })
    const ver = () => previewLiquidacion({ userId: m.owner, venueId: m.venueId, classSessionId: id, destinoFecha: DESTINO, ahora: AHORA })
    const completo = await ver()
    expect(completo.sedeEnDestino).toBe(true)
    expect([...completo.destino.venueIds].sort()).toEqual([m.venueId, bsf.venueId].sort())
    ;(global as any).__ilegibles = [bsf.venueId]
    const parcial = await ver()
    expect(parcial).toMatchObject({ sedeEnDestino: true, destino: { venueIds: [m.venueId] } })
    expect(parcial.huella).toBe(completo.huella)
    // Y esa huella confirma (la liquidación bloquea el alcance completo).
    const r = await liquidarDiferencia({
      userId: m.owner,
      venueId: m.venueId,
      classSessionId: id,
      destinoFecha: DESTINO,
      ahora: AHORA,
      periodoOrigenId: parcial.periodoOrigen!.id,
      huellaEsperada: parcial.huella,
      solicitudId: `${m.key}-parcial`,
    })
    expect(r).toEqual({ lineas: [{ staffId: m.ana, amount: '40.00' }], yaLiquidada: false })
  })

  it('una cancelación después de liquidar sale como un nuevo negativo', async () => {
    const id = await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    await cerrarAgosto()
    await prisma.classSessionPayState.update({ where: { classSessionId: id }, data: { payCountOverride: 9 } })
    await liquidar(id)
    await prisma.classSession.update({ where: { id }, data: { status: 'CANCELLED' } })
    expect(await pendientes(id)).toEqual({ [m.ana]: '-610.00' })
  })
})
