// tests/integration/staffPay/participacion.sedes.test.ts — activar y desactivar UNA sede, fase 3 B10-B11 (diseño r3.3, r4.6,
// r4.8, r5.3): los servicios (B11 los publica por ruta y MCP; sus pruebas, en `participacion.integracion*.test.ts`). Rangos de fechas por sede, candados, errores y
// ActivityLog. Fechas de 2026 en UTC; CDMX = UTC−6, Tijuana = UTC−7 hasta el 1-nov (a las 2:00) y UTC−8 después.
import { PrismaClient } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import * as acceso from '@/services/dashboard/staffPay/acceso'
import { ForbiddenError } from '@/errors/AppError'
import { activarSede, desactivarSede } from '@/services/dashboard/staffPay/participacion'
import { dbDateComoFecha, fechaComoDbDate } from '@/services/dashboard/staffPay/periodos'
import { crearSede } from './_mundo'
import { esperarDetenidaPor, prepararParticipacion, resultado } from './_participacion'

jest.mock('@/services/dashboard/staffPay/acceso', () => ({
  ...jest.requireActual('@/services/dashboard/staffPay/acceso'),
  sedesConServicePay: jest.fn(async () => (global as any).__sedes),
  assertPermisoEnSedes: jest.fn(async () => undefined),
}))

const p = prepararParticipacion('part-sedes')
const OCT20 = new Date('2026-10-20T18:00:00Z') // 12:00 del 20-oct en CDMX
const FUERA = (desde: string, hasta: string, message: string) => ({
  statusCode: 400,
  code: 'FECHA_FUERA_DE_RANGO',
  details: { desde, hasta },
  message,
})
const FUTURA = (dia: string) => `La fecha no puede ser futura: lo más adelante es hoy, ${dia}`

/** La organización activada desde el 1-sep (salvo `inicio: null`) y una sede B; las dos sedes con plan. */
async function preparar(o: { inicio?: string | null } = {}) {
  const m = p.m()
  const b = (await crearSede(m.orgId, m.key, 'b')).venueId
  ;(global as any).__sedes = [m.venueId, b]
  if (o.inicio !== null) {
    await prisma.organization.update({ where: { id: m.orgId }, data: { staffPayStartDate: fechaComoDbDate(o.inicio ?? '2026-09-01') } })
  }
  return { m, b }
}
const ventanaDirecta = (venueId: string, desde: string, organizationId = p.m().orgId) =>
  prisma.staffPayVenueWindow.create({ data: { organizationId, venueId, desde: fechaComoDbDate(desde), activadaPor: p.m().owner } })
const ventanasDe = async (venueId: string) =>
  (await prisma.staffPayVenueWindow.findMany({ where: { venueId }, orderBy: { desde: 'asc' }, take: 10 })).map(w => [
    dbDateComoFecha(w.desde),
    w.hasta ? dbDateComoFecha(w.hasta) : null,
    w.activadaPor,
    w.desactivadaPor,
  ])
const activar = (sedeId: string, o: { desde?: string; ahora?: Date; venueId?: string } = {}) =>
  activarSede({ userId: p.m().owner, venueId: o.venueId ?? p.m().venueId, sedeId, desde: o.desde, ahora: o.ahora ?? OCT20 })
const desactivar = (sedeId: string, o: { hasta?: string; ahora?: Date; venueId?: string } = {}) =>
  desactivarSede({ userId: p.m().owner, venueId: o.venueId ?? p.m().venueId, sedeId, hasta: o.hasta, ahora: o.ahora ?? OCT20 })
const logs = (action: string, venueId: string) =>
  prisma.activityLog.findMany({ where: { action, venueId }, select: { staffId: true, entity: true, entityId: true, data: true }, take: 10 })

describe('activarSede: desde qué día (B10, r3.3, r4.8)', () => {
  it('septiembre cerrado, hoy 20-oct: lo más atrás es el 1-oct y lo más adelante hoy; dentro abre la ventana y deja ActivityLog', async () => {
    const { m, b } = await preparar()
    await p.periodo('2026-09-01', '2026-09-30', [m.venueId], 'CLOSED')
    const septiembre = 'Septiembre ya se cerró; lo más atrás es el 1 oct 2026'
    await expect(activar(b, { desde: '2026-09-15' })).rejects.toMatchObject(FUERA('2026-10-01', '2026-10-20', septiembre))
    await expect(activar(b, { desde: '2026-08-20' })).rejects.toMatchObject(FUERA('2026-10-01', '2026-10-20', septiembre))
    await expect(activar(b, { desde: '2026-10-21' })).rejects.toMatchObject(FUERA('2026-10-01', '2026-10-20', FUTURA('20 oct 2026')))
    expect(await ventanasDe(b)).toEqual([])

    expect(await activar(b, { desde: '2026-10-01' })).toEqual({
      ventana: { venueId: b, desde: '2026-10-01', hasta: null },
      minimo: '2026-10-01',
      minimoEfectivo: '2026-10-01',
    })
    expect(await ventanasDe(b)).toEqual([['2026-10-01', null, m.owner, null]])
    const [w] = await prisma.staffPayVenueWindow.findMany({ where: { venueId: b }, select: { id: true }, take: 1 })
    expect(await logs('SERVICE_PAY_VENUE_ACTIVATED', b)).toEqual([
      {
        staffId: m.owner,
        entity: 'StaffPayVenueWindow',
        entityId: w.id,
        data: { desde: '2026-10-01', minimo: '2026-10-01', minimoEfectivo: '2026-10-01' },
      },
    ])
    // El permiso es el de cerrar periodos EN LA SEDE que se activa (no en la que pide).
    expect(acceso.assertPermisoEnSedes).toHaveBeenLastCalledWith(m.owner, [b], 'staffpay:close', expect.any(String))
  })

  it('antes del inicio, sin ningún cerrado: lo más atrás es el inicio', async () => {
    const { b } = await preparar()
    await expect(activar(b, { desde: '2026-08-31' })).rejects.toMatchObject(
      FUERA('2026-09-01', '2026-10-20', 'Es antes del inicio de pago al personal; lo más atrás es el 1 sep 2026'),
    )
    expect(await activar(b, { desde: '2026-09-01' })).toMatchObject({ ventana: { desde: '2026-09-01' }, minimo: '2026-09-01' })
  })

  it('cierre fuera de orden (agosto y octubre cerrados, septiembre abierto): el mínimo sale del MAYOR cerrado, el 1-nov', async () => {
    const { m, b } = await preparar()
    await p.periodo('2026-08-01', '2026-08-31', [m.venueId], 'CLOSED')
    await p.periodo('2026-09-01', '2026-09-30', [m.venueId], 'OPEN')
    await p.periodo('2026-10-01', '2026-10-31', [m.venueId], 'CLOSED')
    const ahora = new Date('2026-11-05T18:00:00Z')
    await expect(activar(b, { desde: '2026-09-15', ahora })).rejects.toMatchObject(
      FUERA('2026-11-01', '2026-11-05', 'Octubre ya se cerró; lo más atrás es el 1 nov 2026'),
    )
    expect(await activar(b, { desde: '2026-11-01', ahora })).toEqual({
      ventana: { venueId: b, desde: '2026-11-01', hasta: null },
      minimo: '2026-11-01',
      minimoEfectivo: '2026-11-01',
    })
  })

  it('el 1-nov: «desde el 2-nov» es futuro; por defecto hoy en la zona de la sede (en Tijuana el 1-nov dura 25 h)', async () => {
    const { m, b } = await preparar()
    const tij = (await crearSede(m.orgId, m.key, 'tij')).venueId
    await prisma.venue.update({ where: { id: tij }, data: { timezone: 'America/Tijuana' } })
    ;(global as any).__sedes = [m.venueId, b, tij]
    const nov1 = new Date('2026-11-01T18:00:00Z')
    await expect(activar(b, { desde: '2026-11-02', ahora: nov1 })).rejects.toMatchObject(
      FUERA('2026-09-01', '2026-11-01', FUTURA('1 nov 2026')),
    )
    // 23:30 del 1-nov en Tijuana (ya UTC−8) = 07:30Z del 2-nov = 01:30 del 2-nov en CDMX.
    const tarde = new Date('2026-11-02T07:30:00Z')
    expect(await activar(tij, { ahora: tarde })).toMatchObject({ ventana: { venueId: tij, desde: '2026-11-01' } })
    expect(await activar(b, { ahora: tarde })).toMatchObject({ ventana: { venueId: b, desde: '2026-11-02' } })
  })
})

describe('desactivarSede: hasta qué día entra (B10, r3.3, r4.7)', () => {
  it('ventana desde el 1-sep y septiembre cerrado: «hasta el 20-sep» no (lo más atrás es el 30-sep); «hasta el 15-oct» sí, aun SIN plan; reactivar respeta el día siguiente', async () => {
    const { m, b } = await preparar()
    await ventanaDirecta(b, '2026-09-01')
    await p.periodo('2026-09-01', '2026-09-30', [m.venueId, b], 'CLOSED')
    ;(global as any).__sedes = [m.venueId] // B perdió el plan: desactivar es justo la salida
    await expect(desactivar(b, { hasta: '2026-09-20' })).rejects.toMatchObject(
      FUERA('2026-09-30', '2026-10-20', 'Septiembre ya se cerró; lo más atrás es el 30 sep 2026'),
    )
    await expect(desactivar(b, { hasta: '2026-10-21' })).rejects.toMatchObject(FUERA('2026-09-30', '2026-10-20', FUTURA('20 oct 2026')))

    // `minimo`: el de la organización; `minimoEfectivo`: lo que el diálogo deja elegir para ESTA sede (B11, revisión de B10 #3).
    expect(await desactivar(b, { hasta: '2026-10-15' })).toEqual({
      ventana: { venueId: b, desde: '2026-09-01', hasta: '2026-10-15' },
      minimo: '2026-10-01',
      minimoEfectivo: '2026-09-30',
    })
    expect(await ventanasDe(b)).toEqual([['2026-09-01', '2026-10-15', m.owner, m.owner]])
    const [w] = await prisma.staffPayVenueWindow.findMany({ where: { venueId: b }, select: { id: true }, take: 1 })
    expect(await logs('SERVICE_PAY_VENUE_DEACTIVATED', b)).toEqual([
      {
        staffId: m.owner,
        entity: 'StaffPayVenueWindow',
        entityId: w.id,
        data: { hasta: '2026-10-15', minimo: '2026-10-01', minimoEfectivo: '2026-09-30', borrada: false },
      },
    ])
    await expect(desactivar(b)).rejects.toMatchObject({ statusCode: 409, code: 'NO_ACTIVA' })

    // Recupera el plan y se reactiva: nunca encima de lo que ya tuvo.
    ;(global as any).__sedes = [m.venueId, b]
    await expect(activar(b, { desde: '2026-10-10' })).rejects.toMatchObject(
      FUERA('2026-10-16', '2026-10-20', 'La sede ya estuvo activa hasta el 15 oct 2026; lo más atrás es el 16 oct 2026'),
    )
    expect(await activar(b, { desde: '2026-10-16' })).toMatchObject({ ventana: { desde: '2026-10-16', hasta: null } })
    expect(await ventanasDe(b)).toEqual([
      ['2026-09-01', '2026-10-15', m.owner, m.owner],
      ['2026-10-16', null, m.owner, null],
    ])
  })

  it('«hasta» = un día antes de «desde» BORRA la ventana (nunca tocó un cerrado); más atrás, no', async () => {
    const { m, b } = await preparar()
    await p.periodo('2026-09-01', '2026-09-30', [m.venueId], 'CLOSED')
    const w = await ventanaDirecta(b, '2026-10-05')
    await expect(desactivar(b, { hasta: '2026-10-03' })).rejects.toMatchObject(
      FUERA('2026-10-04', '2026-10-20', 'La sede se activó el 5 oct 2026; lo más atrás es el 4 oct 2026 (así se borra la activación)'),
    )
    expect(await desactivar(b, { hasta: '2026-10-04' })).toEqual({ ventana: null, minimo: '2026-10-01', minimoEfectivo: '2026-10-04' })
    expect(await prisma.staffPayVenueWindow.count({ where: { venueId: b } })).toBe(0)
    expect(await logs('SERVICE_PAY_VENUE_DEACTIVATED', b)).toEqual([
      {
        staffId: m.owner,
        entity: 'StaffPayVenueWindow',
        entityId: w.id,
        data: { hasta: '2026-10-04', minimo: '2026-10-01', minimoEfectivo: '2026-10-04', borrada: true },
      },
    ])
  })
})

describe('activar y desactivar una sede: los rechazos (B10)', () => {
  it('YA_ACTIVA, NO_ACTIVA, NO_ACTIVADO y SEDE_SIN_PLAN (sólo al activar), sin escribir nada', async () => {
    const { m, b } = await preparar()
    await expect(desactivar(b)).rejects.toMatchObject({ statusCode: 409, code: 'NO_ACTIVA' })
    ;(global as any).__sedes = [m.venueId]
    await expect(activar(b)).rejects.toMatchObject({ statusCode: 409, code: 'SEDE_SIN_PLAN' })
    expect(await ventanasDe(b)).toEqual([])
    ;(global as any).__sedes = [m.venueId, b]
    await activar(b, { desde: '2026-10-01' })
    await expect(activar(b)).rejects.toMatchObject({ statusCode: 409, code: 'YA_ACTIVA' })
    expect(await ventanasDe(b)).toEqual([['2026-10-01', null, m.owner, null]])

    await prisma.organization.update({ where: { id: m.orgId }, data: { staffPayStartDate: null } })
    await expect(activar(m.venueId)).rejects.toMatchObject({ statusCode: 409, code: 'NO_ACTIVADO' })
    await expect(desactivar(b)).rejects.toMatchObject({ statusCode: 409, code: 'NO_ACTIVADO' })
    expect(
      await prisma.activityLog.count({ where: { action: { startsWith: 'SERVICE_PAY_VENUE_' }, venueId: { in: [m.venueId, b] } } }),
    ).toBe(1)
  })

  it('sin el permiso en la sede, o con una sede de otra organización: error y nada escrito', async () => {
    const { m, b } = await preparar()
    const negar = () =>
      (acceso.assertPermisoEnSedes as jest.Mock).mockImplementationOnce(async () => {
        throw new ForbiddenError('Para activar o desactivar una sede necesitas el permiso de cerrar periodos en esa sede')
      })
    negar()
    await expect(activar(b)).rejects.toMatchObject({ statusCode: 403 })
    await ventanaDirecta(b, '2026-09-01')
    negar()
    await expect(desactivar(b)).rejects.toMatchObject({ statusCode: 403 })
    expect(await ventanasDe(b)).toEqual([['2026-09-01', null, m.owner, null]])

    const z = await p.otraOrg('z')
    const ajena = (await crearSede(z, m.key, 'z')).venueId
    ;(global as any).__sedes = [m.venueId, b, ajena]
    await expect(activar(ajena)).rejects.toMatchObject({ statusCode: 404, message: 'Sede no encontrada' })
    await expect(desactivar(b, { venueId: ajena })).rejects.toMatchObject({ statusCode: 404, message: 'Sede no encontrada' })
    expect(await prisma.staffPayVenueWindow.count({ where: { venueId: ajena } })).toBe(0)
    expect(await ventanasDe(b)).toEqual([['2026-09-01', null, m.owner, null]])
  })

  it('un traslape que aun así llega al EXCLUDE (la sede tiene días en OTRA organización) es 409, nunca 500', async () => {
    const { b } = await preparar()
    await ventanaDirecta(b, '2026-10-01', await p.otraOrg('z'))
    await expect(activar(b, { desde: '2026-10-05' })).rejects.toMatchObject({ statusCode: 409, code: 'VENTANA_SE_CRUZA' })
  })
})

describe('activarSede lee el mínimo DENTRO de su transacción, después de los candados (B10, r4.6)', () => {
  it('un cierre (SERIALIZABLE, que lee las ventanas) que confirma septiembre mientras activar espera su candado manda: 400, ninguna ventana', async () => {
    const { m, b } = await preparar()
    const sep = await p.periodo('2026-09-01', '2026-09-30', [m.venueId], 'OPEN')
    // Un cierre como el de B11: toma el candado de periodos de la organización, LEE las ventanas de la organización (su
    // alcance) y deja septiembre CLOSED; confirma sólo cuando activar ya espera ese candado. Activar tomó su foto antes de
    // esperar: si leyó el mínimo con su transacción, SSI ve el ciclo y la repite (40001) con la foto nueva; si lo leyó por
    // fuera, nada lo detiene y abriría [15-sep, ∞) sobre un septiembre cerrado.
    const cierre = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } })
    let soltar!: () => void
    const suelto = new Promise<void>(r => (soltar = r))
    let avisar!: (pid: number) => void
    const tomado = new Promise<number>(r => (avisar = r))
    const tx = cierre.$transaction(
      async t => {
        const [{ pid }] = await t.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
        await t.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`avoqado:service-pay-periods:v1:${m.orgId}`}, 0))::text`
        await t.$queryRaw`SELECT COUNT(*)::int AS n FROM "StaffPayVenueWindow" WHERE "organizationId" = ${m.orgId}`
        await t.servicePayPeriod.update({
          where: { id: sep.id },
          data: { status: 'CLOSED', closedAt: new Date(), closedById: m.owner, closeFingerprint: 'manual' },
        })
        avisar(pid)
        await suelto
      },
      { isolationLevel: 'Serializable', maxWait: 10_000, timeout: 60_000 },
    )
    try {
      const pid = await tomado
      const intentos = jest.spyOn(prisma, '$transaction')
      p.espiar(intentos)
      let termino = false
      const op = resultado(activar(b, { desde: '2026-09-15' })).finally(() => (termino = true))
      expect(await esperarDetenidaPor(pid, () => !termino)).toBe(true)
      soltar()
      await tx
      const r = await op
      expect(r.error).toMatchObject(FUERA('2026-10-01', '2026-10-20', 'Septiembre ya se cerró; lo más atrás es el 1 oct 2026'))
      expect(await ventanasDe(b)).toEqual([])
      // El primer intento vio el septiembre de antes (su foto es de antes de esperar); SSI lo repitió con la foto nueva (al
      // menos una vez: el número exacto de reintentos no es parte del contrato).
      expect(intentos.mock.calls.length).toBeGreaterThanOrEqual(2)
    } finally {
      soltar()
      await tx.catch(() => undefined)
      await cierre.$disconnect()
    }
  }, 60_000)
})
