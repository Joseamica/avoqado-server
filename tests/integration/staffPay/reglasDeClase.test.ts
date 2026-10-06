// tests/integration/staffPay/reglasDeClase.test.ts — las dos reglas de clase de Mindform (spec fase 3 §6.6, decisión D4)
jest.mock('@/communication/rabbitmq/gcal-push-consumer', () => ({
  __esModule: true,
  publishPushNotification: jest.fn().mockResolvedValue(undefined),
}))

import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { ClaseValorada, valorarClases } from '@/services/dashboard/staffPay/valoracion'
import { anclarClases } from '@/services/dashboard/staffPay/cierre.service'
import { fechaComoDbDate, venuePeriodRange } from '@/services/dashboard/staffPay/periodos'
import { createClassSession, updateClassSession } from '@/services/dashboard/classSession.dashboard.service'
import { borrarMundo, clase, confirmadas, crearMundo, Mundo, periodoCerrado, tablaMindform, TZ } from './_mundo'

const AHORA = new Date('2026-09-02T12:00:00Z')
const AGOSTO = venuePeriodRange({ start: '2026-08-01', end: '2026-08-31' }, TZ)
const H = 3_600_000
const SEG = 1000
const DIA = (d: number) => `2026-08-${String(d).padStart(2, '0')}T14:00:00.000Z` // 08:00 en CDMX
const menos = (iso: string, ms: number) => new Date(new Date(iso).getTime() - ms).toISOString()
const pesos = (d: Prisma.Decimal | string | null | undefined) => (d == null ? null : new Prisma.Decimal(d).toFixed(2))

let m: Mundo
let versionId: string
beforeEach(async () => {
  m = await crearMundo('reglas')
  versionId = (await tablaMindform(m)).versionId
  // El sueldo base es la celda de 0 lugares. En la tabla real de Prado Norte vale 0; aquí 250 para verlo en los montos.
  await prisma.servicePayTableCell.updateMany({ where: { versionId, count: 0 }, data: { amount: new Prisma.Decimal(250) } })
})
afterEach(() => borrarMundo(m))

/** Prende las dos reglas en la versión: suplencia con menos de 3 h = +$100; cancelación con menos de 2 h = sueldo base. */
const prender = () =>
  prisma.servicePayTableVersion.update({
    where: { id: versionId },
    data: { coverBonusHours: 3, coverBonusAmount: new Prisma.Decimal(100), lateCancelHours: 2 },
  })

const vivo = async (id: string): Promise<ClaseValorada | undefined> =>
  (
    await valorarClases(
      prisma,
      { venueId: m.venueId, organizationId: m.orgId, tz: TZ, desde: AGOSTO.from, hasta: AGOSTO.to, ahora: AHORA, claseIds: [id] },
      { limite: 10 },
    )
  )[0]

describe('suplencia con poco aviso (D4-a)', () => {
  it('se le asignó con menos de N horas: su celda + el bono; exactamente N horas antes no cuenta', async () => {
    await prender()
    const tarde = await clase(m, {
      staffId: m.ana,
      inicioIso: DIA(4),
      reservas: confirmadas(8),
      originalStaffId: m.sofia,
      staffAssignedAt: menos(DIA(4), 3 * H - SEG),
    })
    const justo = await clase(m, {
      staffId: m.ana,
      inicioIso: DIA(5),
      reservas: confirmadas(8),
      originalStaffId: m.sofia,
      staffAssignedAt: menos(DIA(5), 3 * H),
    })
    const t = await vivo(tarde)
    expect(t).toMatchObject({
      estado: 'OK',
      bonoSuplencia: '100.00',
      canceladaTarde: false,
      regla: { tipo: 'SUPLENCIA', horas: 2, bono: '100.00' },
    })
    expect(pesos(t!.monto)).toBe('670.00') // 570 (Head Coach, 8 lugares) + 100
    const j = await vivo(justo)
    expect(j).toMatchObject({ estado: 'OK', bonoSuplencia: null, regla: null })
    expect(pesos(j!.monto)).toBe('570.00')
  })

  it('no es suplencia: Ana → Bea → Ana, ni una clase vieja sin coach original', async () => {
    await prender()
    const vuelve = await clase(m, {
      staffId: m.ana,
      inicioIso: DIA(4),
      reservas: confirmadas(8),
      originalStaffId: m.ana,
      staffAssignedAt: menos(DIA(4), H),
    })
    const vieja = await clase(m, { staffId: m.ana, inicioIso: DIA(5), reservas: confirmadas(8), staffAssignedAt: menos(DIA(5), H) })
    for (const id of [vuelve, vieja]) {
      const v = await vivo(id)
      expect(v).toMatchObject({ estado: 'OK', bonoSuplencia: null, regla: null })
      expect(pesos(v!.monto)).toBe('570.00')
    }
  })

  it('un monto acordado a mano manda: no se le suma el bono', async () => {
    await prender()
    const id = await clase(m, {
      staffId: m.ana,
      inicioIso: DIA(4),
      reservas: confirmadas(8),
      originalStaffId: m.sofia,
      staffAssignedAt: menos(DIA(4), H),
    })
    await prisma.classSessionPayState.create({
      data: { classSessionId: id, payAmountOverride: new Prisma.Decimal(500), overrideReason: 'Acordado' },
    })
    const v = await vivo(id)
    expect(v).toMatchObject({ estado: 'OK', bonoSuplencia: null, regla: null })
    expect(pesos(v!.monto)).toBe('500.00')
  })
})

describe('cancelación tardía (D4-b)', () => {
  it('cancelada con menos de N horas: la celda de 0 lugares de su nivel; exactamente N horas antes, no se paga', async () => {
    await prender()
    const tarde = await clase(m, {
      staffId: m.ana,
      inicioIso: DIA(4),
      reservas: confirmadas(8),
      status: 'CANCELLED',
      cancelledAt: menos(DIA(4), 2 * H - SEG),
    })
    const aTiempo = await clase(m, {
      staffId: m.ana,
      inicioIso: DIA(5),
      reservas: confirmadas(8),
      status: 'CANCELLED',
      cancelledAt: menos(DIA(5), 2 * H),
    })
    const t = await vivo(tarde)
    expect(t).toMatchObject({
      estado: 'OK',
      conteo: 0,
      conteoCalculado: 0,
      canceladaTarde: true,
      bonoSuplencia: null,
      regla: { tipo: 'CANCELACION_TARDIA', horas: 1 },
    })
    expect(pesos(t!.monto)).toBe('250.00')
    // En vivo, una cancelada que su versión no paga sigue sin aparecer, como en las fases 1 y 2.
    expect(await vivo(aTiempo)).toBeUndefined()
  })

  it('sin la celda de 0 lugares de su nivel es la excepción de siempre', async () => {
    await prender()
    await prisma.servicePayTableCell.deleteMany({ where: { versionId, count: 0, payLevelId: m.hc } })
    const id = await clase(m, { staffId: m.ana, inicioIso: DIA(4), status: 'CANCELLED', cancelledAt: menos(DIA(4), H) })
    expect(await vivo(id)).toMatchObject({ estado: 'EXCEPCION', motivo: 'SIN_MONTO_PARA_ESE_CONTEO', canceladaTarde: true, monto: null })
  })

  it('una suplencia con poco aviso que después se cancela tarde cobra sólo el sueldo base (sin bono)', async () => {
    await prender()
    const id = await clase(m, {
      staffId: m.ana,
      inicioIso: DIA(4),
      status: 'CANCELLED',
      cancelledAt: menos(DIA(4), H),
      originalStaffId: m.sofia,
      staffAssignedAt: menos(DIA(4), 2 * H),
    })
    const v = await vivo(id)
    expect(v).toMatchObject({ estado: 'OK', canceladaTarde: true, bonoSuplencia: null, regla: { tipo: 'CANCELACION_TARDIA', horas: 1 } })
    expect(pesos(v!.monto)).toBe('250.00')
  })
})

describe('reglas apagadas y versión anclada', () => {
  it('apagadas (de fábrica): ni bono ni sueldo base, exactamente como en la fase 2', async () => {
    const sup = await clase(m, {
      staffId: m.ana,
      inicioIso: DIA(4),
      reservas: confirmadas(8),
      originalStaffId: m.sofia,
      staffAssignedAt: menos(DIA(4), H),
    })
    const can = await clase(m, { staffId: m.ana, inicioIso: DIA(5), status: 'CANCELLED', cancelledAt: menos(DIA(5), H) })
    const v = await vivo(sup)
    expect(v).toMatchObject({ bonoSuplencia: null, canceladaTarde: false, regla: null })
    expect(pesos(v!.monto)).toBe('570.00')
    expect(await vivo(can)).toBeUndefined()
  })

  it('la versión anclada manda: cambiar la regla después no mueve una clase congelada (spec §13-9)', async () => {
    await prender()
    const sup = await clase(m, {
      staffId: m.ana,
      inicioIso: DIA(4),
      reservas: confirmadas(8),
      originalStaffId: m.sofia,
      staffAssignedAt: menos(DIA(4), H),
    })
    const can = await clase(m, { staffId: m.ana, inicioIso: DIA(5), status: 'CANCELLED', cancelledAt: menos(DIA(5), H) })
    const p = await periodoCerrado(m, '2026-08-01', '2026-08-31')
    await prisma.$transaction(tx =>
      anclarClases(tx, p.id, [
        { classSessionId: sup, fechaValoracion: '2026-08-04', tableVersionId: versionId },
        { classSessionId: can, fechaValoracion: '2026-08-05', tableVersionId: versionId },
      ]),
    )
    // «Después»: otra revisión del mismo día con otras reglas. El servicio no la deja publicar dentro de un periodo cerrado;
    // aquí se fuerza para probar que el ancla manda.
    const { tableId } = await prisma.servicePayTableVersion.findUniqueOrThrow({ where: { id: versionId }, select: { tableId: true } })
    const v2 = await prisma.servicePayTableVersion.create({
      data: {
        tableId,
        effectiveFrom: fechaComoDbDate('2026-01-01'),
        revision: 2,
        maxCount: 10,
        coverBonusHours: 3,
        coverBonusAmount: new Prisma.Decimal(300),
      },
    })
    const celdas = await prisma.servicePayTableCell.findMany({ where: { versionId }, take: 100 })
    await prisma.servicePayTableCell.createMany({
      data: celdas.map(c => ({ versionId: v2.id, payLevelId: c.payLevelId, count: c.count, amount: c.amount })),
    })

    const enPeriodo = await valorarClases(
      prisma,
      {
        venueId: m.venueId,
        organizationId: m.orgId,
        tz: TZ,
        desde: AGOSTO.from,
        hasta: AGOSTO.to,
        ahora: AHORA,
        modo: 'periodo',
        periodId: p.id,
        claseIds: [sup, can],
      },
      { limite: 10 },
    )
    const de = new Map(enPeriodo.map(c => [c.classSessionId, c]))
    expect(de.get(sup)).toMatchObject({ tableVersionId: versionId, bonoSuplencia: '100.00' })
    expect(pesos(de.get(sup)!.monto)).toBe('670.00')
    expect(de.get(can)).toMatchObject({ tableVersionId: versionId, estado: 'OK', canceladaTarde: true })
    expect(pesos(de.get(can)!.monto)).toBe('250.00')

    // Una clase SIN ancla del mismo mes sí ve la revisión nueva: +$300, y su cancelación tardía ya no se paga.
    const libre = await clase(m, {
      staffId: m.ana,
      inicioIso: DIA(6),
      reservas: confirmadas(8),
      originalStaffId: m.sofia,
      staffAssignedAt: menos(DIA(6), H),
    })
    const libreCancelada = await clase(m, { staffId: m.ana, inicioIso: DIA(7), status: 'CANCELLED', cancelledAt: menos(DIA(7), H) })
    expect(await vivo(libre)).toMatchObject({ tableVersionId: v2.id, bonoSuplencia: '300.00' })
    expect(await vivo(libreCancelada)).toBeUndefined()
  })
})

describe('de punta a punta con las estampas reales (D2a + D3a)', () => {
  it('creada con el servicio y sustituida con poco aviso: cobra la celda de la suplente + el bono', async () => {
    await prender()
    const inicio = new Date(Date.now() + 2 * H)
    const fin = new Date(inicio.getTime() + 50 * 60_000)
    const cs = await createClassSession(
      m.venueId,
      {
        productId: m.productId,
        startsAt: inicio.toISOString(),
        endsAt: fin.toISOString(),
        capacity: 10,
        assignedStaffId: m.ana,
        internalNotes: null,
      },
      m.owner,
    )
    await updateClassSession(m.venueId, cs.id, { assignedStaffId: m.sofia }, m.owner)
    const [v] = await valorarClases(
      prisma,
      {
        venueId: m.venueId,
        organizationId: m.orgId,
        tz: TZ,
        desde: new Date(inicio.getTime() - 1),
        hasta: new Date(inicio.getTime() + 1),
        ahora: new Date(fin.getTime() + H),
        claseIds: [cs.id],
      },
      { limite: 1 },
    )
    expect(v).toMatchObject({ staffId: m.sofia, estado: 'OK', conteo: 0, bonoSuplencia: '100.00', regla: { tipo: 'SUPLENCIA', horas: 1 } })
    expect(pesos(v.monto)).toBe('350.00') // celda de 0 lugares de Coach (250) + 100
  })
})

describe('fronteras en la zona de la sede (horas de reloj, cruzando la medianoche local)', () => {
  // Clases a la 01:00 de CDMX: la suplencia y la cancelación caen el día local anterior. Cuenta el tiempo transcurrido.
  it('suplencia de 3 h: un minuto antes del límite sí, justo en el límite y un minuto después no', async () => {
    await prender()
    const asignada = async (dia: number, hhmm: string) =>
      clase(m, {
        staffId: m.ana,
        inicioIso: `2026-08-${dia}T01:00:00-06:00`,
        reservas: confirmadas(8),
        originalStaffId: m.sofia,
        staffAssignedAt: `2026-08-${dia - 1}T${hhmm}:00-06:00`,
      })
    const dentro = await asignada(11, '22:01') // 2 h 59 min antes
    const justo = await asignada(12, '22:00') // 3 h exactas
    const fuera = await asignada(13, '21:59') // 3 h 1 min antes
    expect(await vivo(dentro)).toMatchObject({ bonoSuplencia: '100.00', regla: { tipo: 'SUPLENCIA', horas: 2, bono: '100.00' } })
    expect(pesos((await vivo(dentro))!.monto)).toBe('670.00')
    for (const id of [justo, fuera]) {
      const v = await vivo(id)
      expect(v).toMatchObject({ estado: 'OK', bonoSuplencia: null, regla: null })
      expect(pesos(v!.monto)).toBe('570.00')
    }
  })

  it('cancelación de 2 h: un minuto antes del límite se paga, justo en el límite y un minuto después no', async () => {
    await prender()
    const cancelada = async (dia: number, hhmm: string) =>
      clase(m, {
        staffId: m.ana,
        inicioIso: `2026-08-${dia}T01:00:00-06:00`,
        reservas: confirmadas(8),
        status: 'CANCELLED',
        cancelledAt: `2026-08-${dia - 1}T${hhmm}:00-06:00`,
      })
    const dentro = await cancelada(15, '23:01') // 1 h 59 min antes
    const justo = await cancelada(16, '23:00') // 2 h exactas
    const fuera = await cancelada(17, '22:59') // 2 h 1 min antes
    expect(await vivo(dentro)).toMatchObject({
      estado: 'OK',
      conteo: 0,
      canceladaTarde: true,
      regla: { tipo: 'CANCELACION_TARDIA', horas: 1 },
    })
    expect(pesos((await vivo(dentro))!.monto)).toBe('250.00')
    expect(await vivo(justo)).toBeUndefined()
    expect(await vivo(fuera)).toBeUndefined()
  })
})

describe('ajustes a mano sobre una cancelada tarde (resolución 12)', () => {
  it('el conteo corregido se ignora: vale la celda de 0 lugares', async () => {
    await prender()
    const id = await clase(m, { staffId: m.ana, inicioIso: DIA(4), status: 'CANCELLED', cancelledAt: menos(DIA(4), H) })
    await prisma.classSessionPayState.create({ data: { classSessionId: id, payCountOverride: 8, overrideReason: 'Corrección' } })
    const v = await vivo(id)
    expect(v).toMatchObject({ estado: 'OK', canceladaTarde: true, payCountOverride: 8, conteo: 0, conteoCalculado: 0, tieneAjuste: true })
    expect(pesos(v!.monto)).toBe('250.00')
  })

  it('el monto acordado manda, y la regla sigue diciendo por qué se paga', async () => {
    await prender()
    const id = await clase(m, { staffId: m.ana, inicioIso: DIA(4), status: 'CANCELLED', cancelledAt: menos(DIA(4), H) })
    await prisma.classSessionPayState.create({
      data: { classSessionId: id, payAmountOverride: new Prisma.Decimal(500), overrideReason: 'Acordado' },
    })
    const v = await vivo(id)
    expect(v).toMatchObject({ estado: 'OK', canceladaTarde: true, bonoSuplencia: null, regla: { tipo: 'CANCELACION_TARDIA', horas: 1 } })
    expect(pesos(v!.monto)).toBe('500.00')
  })

  it('excluida a mano: no se paga aunque se haya cancelado tarde', async () => {
    await prender()
    const id = await clase(m, { staffId: m.ana, inicioIso: DIA(4), status: 'CANCELLED', cancelledAt: menos(DIA(4), H) })
    await prisma.classSessionPayState.create({ data: { classSessionId: id, payExcluded: true, overrideReason: 'No vino' } })
    expect(await vivo(id)).toMatchObject({ estado: 'EXCLUIDA', monto: null, bonoSuplencia: null, regla: null })
  })
})
