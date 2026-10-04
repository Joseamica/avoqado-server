// tests/integration/staffPay/liquidacion.test.ts — «Liquidar diferencia» (spec §6.4, §5.6, §9.2)
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { liquidarDiferencia, previewLiquidacion } from '@/services/dashboard/staffPay/liquidacion.service'
import { diferenciasDeClase } from '@/services/dashboard/staffPay/diferencias.service'
import { guardarAjusteDeClase } from '@/services/dashboard/staffPay/ajustesClase.service'
import { valorarClases } from '@/services/dashboard/staffPay/valoracion'
import { cerrarPeriodo, previewCierre } from '@/services/dashboard/staffPay/cierre.service'
import { fechaComoDbDate, venuePeriodRange } from '@/services/dashboard/staffPay/periodos'
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
// son las sedes donde el actor NO tiene staffpay:close.
jest.mock('@/services/dashboard/staffPay/acceso', () => ({
  ...jest.requireActual('@/services/dashboard/staffPay/acceso'),
  sedesConServicePay: jest.fn(async () => (global as any).__sedes),
  sedesLegibles: jest.fn(async () => ({ venueIds: (global as any).__sedes, parcial: false })),
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
    const globales = ['sedesConServicePay', 'sedesConPermiso', 'assertPermisoEnSedes', 'tienePermisoEn'] as const
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

  it('una cancelación que llega A MEDIA liquidación queda de un lado de la foto y nada se pierde', async () => {
    const id = await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    await cerrarAgosto()
    await prisma.classSessionPayState.update({ where: { classSessionId: id }, data: { payCountOverride: 9 } })
    const pv = await previewLiquidacion({ userId: m.owner, venueId: m.venueId, classSessionId: id, destinoFecha: DESTINO, ahora: AHORA })
    const [liq] = await Promise.allSettled([
      liquidarDiferencia({
        userId: m.owner,
        venueId: m.venueId,
        classSessionId: id,
        destinoFecha: DESTINO,
        ahora: AHORA,
        periodoOrigenId: pv.periodoOrigen!.id,
        huellaEsperada: pv.huella,
        solicitudId: `${m.key}-carrera`,
      }),
      prisma.classSession.update({ where: { id }, data: { status: 'CANCELLED' } }),
    ])
    if (liq.status === 'rejected') expect(liq.reason).toMatchObject({ code: 'HUELLA_CAMBIO' })
    // Invariante: lo pagado + lo pendiente = lo que corresponde hoy ($0, porque la clase se canceló).
    const pagado = await prisma.serviceEarning.aggregate({ where: { sourceId: id }, _sum: { amount: true } })
    const pend = (await diferenciasDeClase(prisma, { venueId: m.venueId, classSessionId: id }, { ahora: AHORA })).filas.reduce(
      (a, f) => a + Number(f.pendiente),
      0,
    )
    expect(Number(pagado._sum.amount) + pend).toBe(0)
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
    expect(await reconcile(id)).toBe(1)
    // Una solicitud NUEVA a ese destino ya cerrado sí recibe PERIODO_CERRADO.
    await expect(liquidar(id)).rejects.toMatchObject({ code: 'PERIODO_CERRADO' })
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
    expect(aj.status).toBe('fulfilled')
    if (liq.status === 'rejected') {
      // El ajuste ganó: la liquidación vio otra huella (ahora son +$80) y no escribió nada. Nunca 40P01.
      expect(liq.reason).toMatchObject({ code: 'HUELLA_CAMBIO', details: { preview: { total: '80.00' } } })
      expect(await reconcile(id)).toBe(0)
      expect(await pendientes(id)).toEqual({ [m.ana]: '80.00' })
    } else {
      // La liquidación ganó con lo que vio (+$40); el ajuste a 10 queda como el siguiente pendiente (+$40).
      expect(liq.value).toEqual({ lineas: [{ staffId: m.ana, amount: '40.00' }], yaLiquidada: false })
      expect(await reconcile(id)).toBe(1)
      expect(await pendientes(id)).toEqual({ [m.ana]: '40.00' })
    }
    // Quien llega segundo ve el estado del primero: la liquidación que esperó detrás del ajuste no paga con la foto vieja.
    expect(liq.status).toBe(primero === 'liquidacion' ? 'fulfilled' : 'rejected')
    expect(await prisma.classSessionPayState.findUniqueOrThrow({ where: { classSessionId: id } })).toMatchObject({ payCountOverride: 10 })
    // Lo congelado de agosto no se movió.
    const congelado = await prisma.serviceEarning.findFirstOrThrow({ where: { sourceId: id, concept: 'SERVICE' } })
    expect(congelado.amount.toFixed(2)).toBe('570.00')
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
