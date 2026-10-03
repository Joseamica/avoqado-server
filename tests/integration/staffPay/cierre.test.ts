// tests/integration/staffPay/cierre.test.ts
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { cerrarPeriodo, previewCierre } from '@/services/dashboard/staffPay/cierre.service'
import { borrarMundo, clase, confirmadas, crearMundo, crearSede, Mundo, tablaMindform, TZ } from './_mundo'
import { fechaComoDbDate, venuePeriodRange } from '@/services/dashboard/staffPay/periodos'
import { valorarClases } from '@/services/dashboard/staffPay/valoracion'

jest.mock('@/services/dashboard/staffPay/acceso', () => ({
  ...jest.requireActual('@/services/dashboard/staffPay/acceso'),
  sedesConServicePay: jest.fn(async () => (global as any).__sedes),
  tienePermisoEn: jest.fn(async () => true),
  assertPermisoEnSedes: jest.fn(async () => undefined),
}))
const acceso = jest.requireMock('@/services/dashboard/staffPay/acceso')

// Agosto 2026 ya terminó en CDMX el 1-sep 06:00 UTC.
const AHORA = new Date('2026-09-02T12:00:00Z')
let m: Mundo

async function mundoConAgosto(nombre: string) {
  const w = await crearMundo(nombre)
  ;(global as any).__sedes = [w.venueId]
  await tablaMindform(w)
  return w
}
const preview = (w: Mundo, extra: Partial<{ tamLote: number; ahora: Date; fecha: string }> = {}) =>
  previewCierre({
    userId: w.owner,
    venueId: w.venueId,
    fecha: extra.fecha ?? '2026-08-15',
    ahora: extra.ahora ?? AHORA,
    tamLote: extra.tamLote,
  })
const cerrar = async (
  w: Mundo,
  extra: Partial<{ huella: string; tamLote: number; alTerminarLote: (n: number) => void; confirmarHuerfanas: boolean }> = {},
) =>
  cerrarPeriodo({
    userId: w.owner,
    venueId: w.venueId,
    fecha: '2026-08-15',
    ahora: AHORA,
    confirmarHuerfanas: extra.confirmarHuerfanas ?? true,
    huellaEsperada: extra.huella ?? (await preview(w)).huella,
    tamLote: extra.tamLote,
    alTerminarLote: extra.alTerminarLote,
  })

afterEach(async () => borrarMundo(m))

describe('cerrar el periodo (spec §6.3)', () => {
  it('congela cada clase pagable, ancla también las excluidas y suma los recibos de lo persistido', async () => {
    m = await mundoConAgosto('cierre-feliz')
    const c8 = await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    const c9 = await clase(m, { staffId: m.ana, inicioIso: '2026-08-05T14:00:00Z', reservas: confirmadas(9) })
    const cs = await clase(m, { staffId: m.sofia, inicioIso: '2026-08-06T14:00:00Z', reservas: confirmadas(8) })
    const cx = await clase(m, { staffId: m.sofia, inicioIso: '2026-08-07T14:00:00Z', reservas: confirmadas(5) })
    await prisma.classSessionPayState.create({ data: { classSessionId: cx, payExcluded: true, overrideReason: 'clase de prueba' } })

    const p = await preview(m)
    expect(p).toMatchObject({ puedeCerrar: true, bloqueos: [], clases: 3, excluidas: 1, personas: 2, total: '1660.00' })
    const r = await cerrar(m, { huella: p.huella })
    expect(r).toMatchObject({ yaCerrado: false, personas: 2, total: '1660.00', huella: p.huella })

    const lineas = await prisma.serviceEarning.findMany({ where: { organizationId: m.orgId }, orderBy: { amount: 'asc' }, take: 10 })
    expect(lineas.map(l => [l.sourceId, l.staffId, l.amount.toFixed(2), l.concept])).toEqual([
      [cs, m.sofia, '480.00', 'SERVICE'],
      [c8, m.ana, '570.00', 'SERVICE'],
      [c9, m.ana, '610.00', 'SERVICE'],
    ])
    expect(lineas[0].descriptor).toMatchObject({ clase: 'Reformer', fecha: '2026-08-06', hora: '08:00', coach: 'Sofia QA' })
    const anclas = await prisma.classSessionPayState.findMany({ where: { classSessionId: { in: [c8, c9, cs, cx] } }, take: 10 })
    expect(anclas.every(a => a.originPeriodId === r.periodId && a.valuationDate !== null)).toBe(true)
    const recibos = await prisma.staffPayStatement.findMany({ where: { periodId: r.periodId }, orderBy: { total: 'asc' }, take: 10 })
    expect(recibos.map(x => [x.staffId, x.total.toFixed(2)])).toEqual([
      [m.sofia, '480.00'],
      [m.ana, '1180.00'],
    ])
    const periodo = await prisma.servicePayPeriod.findUniqueOrThrow({ where: { id: r.periodId } })
    expect(periodo).toMatchObject({ status: 'CLOSED', closedById: m.owner, closeFingerprint: p.huella })
    expect(await prisma.activityLog.count({ where: { action: 'SERVICE_PAY_PERIOD_CLOSED', entityId: r.periodId } })).toBe(1)
    // Lo congelado ya no entra en vivo: la valoración en vivo del periodo queda vacía (spec §6.2).
    const { from, to } = venuePeriodRange({ start: '2026-08-01', end: '2026-08-31' }, TZ)
    const vivo = await valorarClases(
      prisma,
      { venueId: m.venueId, organizationId: m.orgId, tz: TZ, desde: from, hasta: to, ahora: AHORA },
      { limite: 100 },
    )
    expect(vivo).toEqual([])
  })

  it('un segundo clic (o un reintento después del commit) devuelve el mismo cierre sin escribir nada', async () => {
    m = await mundoConAgosto('cierre-doble')
    await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    const p = await preview(m)
    const a = await cerrar(m, { huella: p.huella })
    const b = await cerrar(m, { huella: p.huella })
    expect(b).toMatchObject({ yaCerrado: true, periodId: a.periodId, total: a.total, huella: a.huella })
    expect(await prisma.serviceEarning.count({ where: { organizationId: m.orgId } })).toBe(1)
  })

  it('dos cierres concurrentes dejan un solo resultado', async () => {
    m = await mundoConAgosto('cierre-concurrente')
    await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    const p = await preview(m)
    const [a, b] = await Promise.all([cerrar(m, { huella: p.huella }), cerrar(m, { huella: p.huella })])
    expect(a.periodId).toBe(b.periodId)
    expect([a.yaCerrado, b.yaCerrado].sort()).toEqual([false, true])
    expect(await prisma.serviceEarning.count({ where: { organizationId: m.orgId } })).toBe(1)
    expect(await prisma.staffPayStatement.count({ where: { periodId: a.periodId } })).toBe(1)
  })

  it('si los números cambiaron desde el preview, rechaza con el preview nuevo y no escribe nada', async () => {
    m = await mundoConAgosto('cierre-huella')
    const id = await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    const viejo = await preview(m)
    await prisma.reservation.create({
      data: {
        venueId: m.venueId,
        classSessionId: id,
        productId: m.productId,
        confirmationCode: `${m.key}-tarde`,
        status: 'CONFIRMED',
        startsAt: new Date('2026-08-04T14:00:00Z'),
        endsAt: new Date('2026-08-04T14:50:00Z'),
        duration: 50,
        blockedEndsAt: new Date('2026-08-04T14:50:00Z'),
        partySize: 1,
        confirmedAt: new Date('2026-08-03T14:00:00Z'),
      },
    })
    await expect(cerrar(m, { huella: viejo.huella })).rejects.toMatchObject({
      code: 'HUELLA_CAMBIO',
      details: { preview: { total: '610.00' } },
    })
    expect(await prisma.serviceEarning.count({ where: { organizationId: m.orgId } })).toBe(0)
    // La transacción entera se revierte: ni el periodo que había creado queda guardado.
    expect(await prisma.servicePayPeriod.count({ where: { organizationId: m.orgId } })).toBe(0)
  })

  it('no cierra: periodo sin terminar, clase en curso (23:30 del 31) o excepciones; y el preview dice por qué', async () => {
    m = await mundoConAgosto('cierre-bloqueos')
    const enCurso = new Date('2026-09-01T06:30:00Z') // 00:30 del 1-sep en CDMX
    await clase(m, { staffId: m.ana, inicioIso: '2026-09-01T05:30:00Z', reservas: confirmadas(2) }) // 23:30 del 31-ago local
    await prisma.classSession.updateMany({ where: { venueId: m.venueId }, data: { endsAt: new Date('2026-09-01T07:00:00Z') } })
    const p = await preview(m, { ahora: enCurso })
    expect(p.puedeCerrar).toBe(false)
    expect(p.bloqueos).toEqual(expect.arrayContaining([{ codigo: 'CLASES_EN_CURSO', n: 1 }]))
    await expect(
      cerrarPeriodo({
        userId: m.owner,
        venueId: m.venueId,
        fecha: '2026-08-15',
        ahora: enCurso,
        confirmarHuerfanas: true,
        huellaEsperada: p.huella,
      }),
    ).rejects.toMatchObject({ code: 'CLASES_EN_CURSO' })

    const sinTerminar = await preview(m, { ahora: new Date('2026-08-20T12:00:00Z') })
    expect(sinTerminar.bloqueos).toEqual(expect.arrayContaining([{ codigo: 'NO_HA_TERMINADO', hasta: '2026-08-31' }]))

    await clase(m, { staffId: null, inicioIso: '2026-08-10T14:00:00Z', reservas: confirmadas(3) })
    const conExcepcion = await preview(m)
    expect(conExcepcion.bloqueos).toEqual(expect.arrayContaining([{ codigo: 'EXCEPCIONES', n: 1 }]))
    await expect(cerrar(m, { huella: conExcepcion.huella })).rejects.toMatchObject({ code: 'HAY_EXCEPCIONES' })
    expect(await prisma.serviceEarning.count({ where: { organizationId: m.orgId } })).toBe(0)
  })

  it('las reservas de clase sin horario se confirman explícitamente y sus IDs quedan en el ActivityLog', async () => {
    m = await mundoConAgosto('cierre-huerfanas')
    await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    const huerfana = await prisma.reservation.create({
      data: {
        venueId: m.venueId,
        productId: m.productId,
        confirmationCode: `${m.key}-huerfana`,
        status: 'CONFIRMED',
        startsAt: new Date('2026-08-09T14:00:00Z'),
        endsAt: new Date('2026-08-09T14:50:00Z'),
        duration: 50,
        blockedEndsAt: new Date('2026-08-09T14:50:00Z'),
        partySize: 1,
        confirmedAt: new Date('2026-08-08T14:00:00Z'),
      },
    })
    const p = await preview(m)
    expect(p.huerfanas).toBe(1)
    await expect(cerrar(m, { huella: p.huella, confirmarHuerfanas: false })).rejects.toMatchObject({ code: 'HUERFANAS_SIN_CONFIRMAR' })
    const r = await cerrar(m, { huella: p.huella, confirmarHuerfanas: true })
    const log = await prisma.activityLog.findFirstOrThrow({ where: { action: 'SERVICE_PAY_PERIOD_CLOSED', entityId: r.periodId } })
    expect((log.data as any).huerfanas).toEqual([huerfana.id])
  })

  it('quien sólo tiene un bono también recibe recibo', async () => {
    m = await mundoConAgosto('cierre-bono')
    await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    const periodo = await prisma.servicePayPeriod.create({
      data: {
        organizationId: m.orgId,
        periodStart: fechaComoDbDate('2026-08-01'),
        periodEnd: fechaComoDbDate('2026-08-31'),
        venueIds: [m.venueId],
      },
    })
    await prisma.serviceEarning.create({
      data: {
        organizationId: m.orgId,
        venueId: m.venueId,
        periodId: periodo.id,
        staffId: m.carla,
        concept: 'MANUAL',
        amount: new Prisma.Decimal(300),
        reason: 'Bono',
        descriptor: { motivo: 'Bono' },
      },
    })
    const r = await cerrar(m)
    const recibos = await prisma.staffPayStatement.findMany({ where: { periodId: r.periodId }, take: 10 })
    expect(recibos.find(x => x.staffId === m.carla)?.total.toFixed(2)).toBe('300.00')
    expect(r.total).toBe('870.00')
  })

  it('la huella es la misma con lotes de 1, 7 y 500, y un reintento forzado a media corrida da el mismo resultado', async () => {
    m = await mundoConAgosto('cierre-lotes')
    for (let d = 1; d <= 9; d++)
      await clase(m, {
        staffId: d % 2 ? m.ana : m.sofia,
        inicioIso: `2026-08-${String(d + 1).padStart(2, '0')}T14:00:00Z`,
        reservas: confirmadas(d),
      })
    const [h1, h7, h500] = await Promise.all([1, 7, 500].map(n => preview(m, { tamLote: n }).then(x => x.huella)))
    expect(new Set([h1, h7, h500]).size).toBe(1)
    let lotes = 0
    const r = await cerrar(m, {
      huella: h500,
      tamLote: 2,
      alTerminarLote: () => {
        lotes++
        if (lotes === 2) throw Object.assign(new Error('could not serialize access'), { code: 'P2034' })
      },
    })
    expect(r.huella).toBe(h500)
    expect(await prisma.serviceEarning.count({ where: { organizationId: m.orgId } })).toBe(9)
  })

  it('el índice único rechaza un segundo SERVICE de la misma clase y persona aunque falle el código', async () => {
    m = await mundoConAgosto('cierre-unico')
    const id = await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    const r = await cerrar(m)
    await expect(
      prisma.serviceEarning.create({
        data: {
          organizationId: m.orgId,
          venueId: m.venueId,
          periodId: r.periodId,
          staffId: m.ana,
          concept: 'SERVICE',
          sourceType: 'CLASS_SESSION',
          sourceId: id,
          amount: new Prisma.Decimal(570),
          descriptor: {},
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' })
  })

  it('una clase excluida sin tabla también se ancla: con periodo y fecha, sin versión (spec §5.4)', async () => {
    m = await crearMundo('cierre-sin-version')
    ;(global as any).__sedes = [m.venueId]
    const id = await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(3) })
    await prisma.classSessionPayState.create({ data: { classSessionId: id, payExcluded: true, overrideReason: 'sin tabla' } })
    const r = await cerrar(m)
    expect(r).toMatchObject({ personas: 0, total: '0.00' })
    expect(await prisma.classSessionPayState.findUniqueOrThrow({ where: { classSessionId: id } })).toMatchObject({
      originPeriodId: r.periodId,
      valuationDate: fechaComoDbDate('2026-08-04'),
      valuationVersionId: null,
      payExcluded: true,
    })
  })

  it('una clase cancelada del periodo no se paga ni se ancla; preview y cierre coinciden', async () => {
    m = await mundoConAgosto('cierre-cancelada')
    await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    const cancelada = await clase(m, { staffId: m.sofia, inicioIso: '2026-08-05T14:00:00Z', reservas: confirmadas(6), status: 'CANCELLED' })
    const p = await preview(m)
    expect(p).toMatchObject({ puedeCerrar: true, clases: 1, excluidas: 0, personas: 1, total: '570.00' })
    const r = await cerrar(m, { huella: p.huella })
    expect(r).toMatchObject({ yaCerrado: false, total: '570.00', huella: p.huella })
    expect(await prisma.serviceEarning.count({ where: { organizationId: m.orgId, sourceId: cancelada } })).toBe(0)
    expect(await prisma.classSessionPayState.findUnique({ where: { classSessionId: cancelada } })).toBeNull()
  })

  it('D2: una sede que activa el módulo después de guardar el periodo entra al cierre con la misma huella del preview', async () => {
    m = await mundoConAgosto('cierre-d2')
    await prisma.servicePayPeriod.create({
      data: {
        organizationId: m.orgId,
        periodStart: fechaComoDbDate('2026-08-01'),
        periodEnd: fechaComoDbDate('2026-08-31'),
        venueIds: [m.venueId],
      },
    })
    const bsf = await crearSede(m.orgId, m.key, 'bsf')
    await tablaMindform(m, bsf.venueId)
    await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    await clase(m, {
      staffId: m.sofia,
      inicioIso: '2026-08-05T14:00:00Z',
      reservas: confirmadas(8),
      venueId: bsf.venueId,
      productId: bsf.productId,
    })
    ;(global as any).__sedes = [m.venueId, bsf.venueId]
    const p = await preview(m)
    expect(p).toMatchObject({ periodo: { venueIds: [m.venueId, bsf.venueId].sort() }, total: '1050.00' })
    const r = await cerrar(m, { huella: p.huella })
    expect(r).toMatchObject({ huella: p.huella, total: '1050.00', venueIds: [m.venueId, bsf.venueId].sort() })
    const lineas = await prisma.serviceEarning.findMany({ where: { organizationId: m.orgId }, orderBy: { amount: 'asc' }, take: 10 })
    expect(lineas.map(l => [l.venueId, l.amount.toFixed(2)])).toEqual([
      [bsf.venueId, '480.00'],
      [m.venueId, '570.00'],
    ])
    expect((await prisma.servicePayPeriod.findUniqueOrThrow({ where: { id: r.periodId } })).venueIds).toEqual(
      [m.venueId, bsf.venueId].sort(),
    )
  })

  it('el preview de un periodo ya cerrado da lo guardado (YA_CERRADO), no lo que hoy se ve en vivo', async () => {
    m = await mundoConAgosto('cierre-preview-cerrado')
    await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    const r = await cerrar(m)
    // Una clase que llegó tarde (sin ancla) sí se vería en vivo; el periodo cerrado no la suma.
    await clase(m, { staffId: m.sofia, inicioIso: '2026-08-10T14:00:00Z', reservas: confirmadas(8) })
    expect(await preview(m)).toMatchObject({
      periodo: { id: r.periodId },
      puedeCerrar: false,
      bloqueos: [{ codigo: 'YA_CERRADO' }],
      clases: 1,
      personas: 1,
      totalServicios: '570.00',
      totalAjustes: '0.00',
      total: '570.00',
      huella: '',
    })
  })

  it('sin staffpay:close en todas las sedes, el preview dice SIN_PERMISO SIN ningún número y el cierre se rechaza', async () => {
    m = await mundoConAgosto('cierre-permiso')
    await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    acceso.tienePermisoEn.mockResolvedValueOnce(false)
    expect(await preview(m)).toMatchObject({
      bloqueos: [{ codigo: 'SIN_PERMISO' }],
      total: '0.00',
      clases: 0,
      huella: '',
      periodo: { venueIds: [] },
    })
    acceso.assertPermisoEnSedes.mockRejectedValueOnce(Object.assign(new Error('Necesitas cerrar en todas'), { statusCode: 403 }))
    await expect(cerrar(m)).rejects.toThrow('Necesitas cerrar en todas')
    // Ya cerrado por alguien con permiso: el retorno idempotente también exige el permiso.
    await cerrar(m)
    acceso.assertPermisoEnSedes.mockRejectedValueOnce(Object.assign(new Error('Necesitas cerrar en todas'), { statusCode: 403 }))
    await expect(cerrar(m)).rejects.toThrow('Necesitas cerrar en todas')
  })
})
