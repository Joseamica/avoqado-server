import { readdirSync, readFileSync } from 'fs'
import path from 'path'
import { Prisma, PrismaClient } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { fechaComoDbDate } from '@/services/dashboard/staffPay/periodos'
import { borrarMundo, clase, crearMundo, Mundo, periodoCerrado } from './_mundo'

let m: Mundo
let periodId: string
beforeAll(async () => {
  m = await crearMundo('checks')
  periodId = (await periodoCerrado(m, '2026-08-01', '2026-08-31')).id
})
afterAll(() => borrarMundo(m))

const linea = (extra: Record<string, unknown>) =>
  prisma.serviceEarning.create({
    data: {
      organizationId: m.orgId,
      venueId: m.venueId,
      periodId,
      staffId: m.ana,
      amount: new Prisma.Decimal(10),
      descriptor: {},
      ...extra,
    } as any,
  })

describe('CHECK de ServiceEarning (spec §5.6)', () => {
  it.each([
    ['SERVICE sin sourceId', { concept: 'SERVICE', sourceType: 'CLASS_SESSION' }],
    ['SERVICE sin sourceType', { concept: 'SERVICE', sourceId: 'x' }],
    ['RECONCILE sin fuente', { concept: 'RECONCILE' }],
    ['MANUAL con fuente', { concept: 'MANUAL', sourceType: 'CLASS_SESSION', sourceId: 'x' }],
    ['SERVICE negativo', { concept: 'SERVICE', sourceType: 'CLASS_SESSION', sourceId: 'x', amount: new Prisma.Decimal(-1) }],
  ])('rechaza %s', async (_n, extra) => {
    await expect(linea(extra)).rejects.toThrow()
  })
  it('acepta un MANUAL sin fuente y un RECONCILE negativo con fuente', async () => {
    await expect(linea({ concept: 'MANUAL' })).resolves.toBeDefined()
    await expect(
      linea({ concept: 'RECONCILE', sourceType: 'CLASS_SESSION', sourceId: 'x', amount: new Prisma.Decimal(-40) }),
    ).resolves.toBeDefined()
  })
})

describe('CHECK e índices de la fase 3 (spec fase 3 §6.1, §6.4, §7.1)', () => {
  it('el inicio de pago al personal es una fecha civil (DATE, sin hora ni zona)', async () => {
    const [c] = await prisma.$queryRaw<Array<{ data_type: string }>>`
      SELECT data_type FROM information_schema.columns WHERE table_name = 'Organization' AND column_name = 'staffPayStartDate'`
    expect(c.data_type).toBe('date')
  })

  it('un SERVICE de comisión o de propina puede ser negativo (reverso, propina devuelta); uno de clase, no', async () => {
    const neg = (sourceType: string, sourceId: string, amount: number) =>
      linea({ concept: 'SERVICE', sourceType, sourceId: `${m.key}-${sourceId}`, amount: new Prisma.Decimal(amount) })
    await expect(neg('COMMISSION', 'c-neg', -36)).resolves.toBeDefined()
    await expect(neg('TIP', 'p-neg', -50)).resolves.toBeDefined()
    await expect(neg('CLASS_SESSION', 'k-neg', -1)).rejects.toThrow()
  })

  it('el reverso por anulación de una comisión es único por comisión y persona; los RECONCILE de clase no', async () => {
    const x = { concept: 'RECONCILE', sourceType: 'COMMISSION', sourceId: `${m.key}-c-anulada`, amount: new Prisma.Decimal(-90) }
    await linea(x)
    await expect(linea(x)).rejects.toThrow()
    const k = { concept: 'RECONCILE', sourceType: 'CLASS_SESSION', sourceId: `${m.key}-k-liq`, amount: new Prisma.Decimal(40) }
    await linea(k)
    await expect(linea(k)).resolves.toBeDefined()
  })

  it('a lo más UNA ventana de propinas abierta por organización; nunca termina antes de empezar ni sin quién la cerró', async () => {
    const ventana = (extra: Record<string, unknown> = {}) =>
      prisma.staffPayTipWindow.create({
        data: { organizationId: m.orgId, startsAt: new Date('2026-08-02T06:00:00Z'), startedById: m.owner, ...extra } as any,
      })
    await ventana()
    await expect(ventana()).rejects.toThrow()
    await expect(ventana({ endsAt: new Date('2026-08-01T06:00:00Z'), endedById: m.owner })).rejects.toThrow()
    await expect(ventana({ endsAt: new Date('2026-08-03T06:00:00Z') })).rejects.toThrow()
    await expect(ventana({ endsAt: new Date('2026-08-03T06:00:00Z'), endedById: m.owner })).resolves.toBeDefined()
  })
})

describe('ventanas de participación por sede (fase 3, B9; diseño r3.2)', () => {
  const MIGRACIONES = path.resolve(__dirname, '../../../prisma/migrations')
  class Revertir extends Error {}
  const d = (fecha: string) => fechaComoDbDate(fecha)
  const ventana = (venueId: string, desde: string, extra: Record<string, unknown> = {}, organizationId = m.orgId) =>
    prisma.staffPayVenueWindow.create({ data: { organizationId, venueId, desde: d(desde), activadaPor: m.owner, ...extra } as any })
  const otraOrg = async (s: string) =>
    prisma.organization.create({ data: { name: `${m.key}-${s}`, slug: `${m.key}-${s}`, email: `${m.key}-${s}@example.test`, phone: '1' } })

  it('una ventana nueva no se encima en una cerrada; la contigua sí entra (días inclusivos)', async () => {
    const v = `${m.key}-sede-traslape`
    await ventana(v, '2026-09-01', { hasta: d('2026-09-30'), desactivadaPor: m.owner })
    await expect(ventana(v, '2026-09-30')).rejects.toThrow(/StaffPayVenueWindow_sin_traslape/)
    await expect(ventana(v, '2026-09-15', { hasta: d('2026-09-20'), desactivadaPor: m.owner })).rejects.toThrow(
      /StaffPayVenueWindow_sin_traslape/,
    )
    await expect(ventana(v, '2026-10-01')).resolves.toBeDefined()
    await expect(ventana(v, '2027-01-01')).rejects.toThrow(/StaffPayVenueWindow_sin_traslape/) // la abierta no tiene fin
  })

  it('la misma sede no puede estar activa en dos organizaciones a la vez', async () => {
    const z = await otraOrg('z-traslape')
    try {
      const v = `${m.key}-sede-dos-orgs`
      await ventana(v, '2026-09-01')
      await expect(ventana(v, '2026-10-01', {}, z.id)).rejects.toThrow(/StaffPayVenueWindow_sin_traslape/)
      // Con la de A cerrada antes, Z sí puede abrir después.
      await prisma.staffPayVenueWindow.updateMany({
        where: { venueId: v },
        data: { hasta: d('2026-09-30'), desactivadaPor: m.owner },
      })
      await expect(ventana(v, '2026-10-01', {}, z.id)).resolves.toBeDefined()
    } finally {
      await prisma.organization.delete({ where: { id: z.id } })
    }
  })

  it('dos inserciones concurrentes encimadas: la segunda espera a la primera y, al confirmarse ésta, se rechaza', async () => {
    const v = `${m.key}-sede-concurrente`
    const url = process.env.DATABASE_URL
    const [uno, dos, observador] = [1, 2, 3].map(() => new PrismaClient({ datasources: { db: { url } } }))
    let soltar!: () => void
    const suelto = new Promise<void>(r => (soltar = r))
    let pidUno = 0
    let listo!: () => void
    const tomado = new Promise<void>(r => (listo = r))
    try {
      const primera = uno.$transaction(
        async t => {
          ;[{ pid: pidUno }] = await t.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
          await t.staffPayVenueWindow.create({
            data: { organizationId: m.orgId, venueId: v, desde: d('2026-09-01'), activadaPor: m.owner },
          })
          listo()
          await suelto
        },
        { timeout: 30_000 },
      )
      await Promise.race([tomado, primera]) // si la primera no pudo insertar, falla aquí en vez de colgarse
      const segunda = dos.staffPayVenueWindow
        .create({ data: { organizationId: m.orgId, venueId: v, desde: d('2026-09-10'), activadaPor: m.owner } })
        .then(
          () => null,
          (e: unknown) => e,
        )
      // La segunda queda DETENIDA por la primera (la restricción de exclusión espera a que se decida).
      for (let i = 0; ; i++) {
        const [{ n }] = await observador.$queryRaw<Array<{ n: number }>>`
          SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE pg_blocking_pids(pid) @> ARRAY[${pidUno}::int]`
        if (n > 0) break
        if (i > 1500) throw new Error('la segunda inserción nunca esperó a la primera')
        await new Promise(r => setTimeout(r, 10))
      }
      soltar()
      await primera
      expect(String(await segunda)).toMatch(/StaffPayVenueWindow_sin_traslape/)
      expect(await prisma.staffPayVenueWindow.count({ where: { venueId: v } })).toBe(1)
    } finally {
      soltar()
      await Promise.all([uno.$disconnect(), dos.$disconnect(), observador.$disconnect()])
    }
  })

  it('las dos CHECK: nunca termina antes de empezar, y cerrada ⇔ con quién la cerró', async () => {
    const v = `${m.key}-sede-checks`
    await expect(ventana(v, '2026-09-10', { hasta: d('2026-09-09'), desactivadaPor: m.owner })).rejects.toThrow(/StaffPayVenueWindow_rango/)
    await expect(ventana(v, '2026-09-10', { hasta: d('2026-09-20') })).rejects.toThrow(/StaffPayVenueWindow_cierre_completo/)
    await expect(ventana(v, '2026-09-10', { desactivadaPor: m.owner })).rejects.toThrow(/StaffPayVenueWindow_cierre_completo/)
    // Un solo día (hasta = desde) sí es una ventana válida.
    await expect(ventana(v, '2026-09-10', { hasta: d('2026-09-10'), desactivadaPor: m.owner })).resolves.toBeDefined()
  })

  it('borrar la organización borra sus ventanas', async () => {
    const z = await otraOrg('z-cascada')
    const v = `${m.key}-sede-cascada`
    await ventana(v, '2026-09-01', {}, z.id)
    await prisma.organization.delete({ where: { id: z.id } })
    expect(await prisma.staffPayVenueWindow.count({ where: { venueId: v } })).toBe(0)
  })

  it('la migración ABORTA si una organización ya activada no tiene ninguna ventana, y la nombra (sin backfill)', async () => {
    const carpeta = readdirSync(MIGRACIONES).find(x => x === '20261006000230_staff_pay_venue_windows')
    expect(carpeta).toBeDefined()
    const sql = readFileSync(path.join(MIGRACIONES, carpeta!, 'migration.sql'), 'utf8')
    const aborto = sql.split('-- ABORTO:INICIO')[1].split('-- ABORTO:FIN')[0].trim()
    expect(aborto).toMatch(/^DO \$\$/)
    const z = await otraOrg('z-activada')
    let error: unknown = null
    let conVentana: unknown = 'no corrió'
    // Ronda 1, F6: la base es compartida y puede traer otras organizaciones activadas sin ventanas (restos de otras
    // pruebas). Lo que el bloque DEBE decir se lee dentro de la MISMA transacción, con su misma regla: el total y las 20
    // primeras por id. Así la prueba no depende de que la de esta prueba salga entre las 20.
    let esperado: { total: number; nombradas: string[] } = { total: 0, nombradas: [] }
    try {
      // En transacciones que se revierten: la base de pruebas es compartida.
      await prisma
        .$transaction(async tx => {
          await tx.organization.update({ where: { id: z.id }, data: { staffPayStartDate: d('2026-09-01') } })
          const sinVentanas = Prisma.sql`FROM "Organization" org WHERE org."staffPayStartDate" IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM "StaffPayVenueWindow" w WHERE w."organizationId" = org.id)`
          const [{ total }] = await tx.$queryRaw<Array<{ total: number }>>`SELECT COUNT(*)::int AS total ${sinVentanas}`
          const primeras = await tx.$queryRaw<Array<{ id: string; name: string }>>`
            SELECT org.id, org.name ${sinVentanas} ORDER BY org.id LIMIT 20`
          esperado = { total, nombradas: primeras.map(o => `${o.id} («${o.name}»)`) }
          await tx.$executeRawUnsafe(aborto)
          throw new Revertir()
        })
        .catch(e => {
          if (!(e instanceof Revertir)) error = e
        })
      // Con al menos una ventana ya no la nombra (otra organización de otra prueba sí podría salir; ésta no).
      await prisma
        .$transaction(async tx => {
          await tx.organization.update({ where: { id: z.id }, data: { staffPayStartDate: d('2026-09-01') } })
          await tx.staffPayVenueWindow.create({
            data: { organizationId: z.id, venueId: `${m.key}-sede-aborto`, desde: d('2026-09-01'), activadaPor: m.owner },
          })
          await tx.$executeRawUnsafe(aborto)
          throw new Revertir()
        })
        .then(
          () => (conVentana = null),
          e => (conVentana = e instanceof Revertir ? null : e),
        )
    } finally {
      await prisma.organization.delete({ where: { id: z.id } })
    }
    // Aborta, con el total y las primeras 20 tal cual las lee su regla (la de esta prueba incluida si cabe, lo normal).
    expect(esperado.total).toBeGreaterThanOrEqual(1)
    expect(String(error)).toContain(`Pago al personal: ${esperado.total} organización(es) ya activadas sin ninguna sede activa`)
    for (const nombrada of esperado.nombradas) expect(String(error)).toContain(nombrada)
    if (esperado.nombradas.some(x => x.startsWith(z.id))) expect(String(error)).toContain(`${z.id} («${m.key}-z-activada»)`)
    expect(String(error)).toMatch(/nunca borres "staffPayStartDate"/)
    expect(String(conVentana ?? '')).not.toContain(z.id)
  })
})

describe('CHECK de las reglas de clase (spec fase 3 §7.3)', () => {
  let tableId: string
  let rev = 0
  beforeAll(async () => {
    tableId = (await prisma.servicePayTable.create({ data: { venueId: m.venueId, name: 'Reglas', productIds: [] } })).id
  })
  const version = (reglas: Record<string, unknown>) =>
    prisma.servicePayTableVersion.create({
      data: { tableId, effectiveFrom: fechaComoDbDate('2026-01-01'), revision: ++rev, maxCount: 10, ...reglas } as any,
    })
  const bono = (x: string) => new Prisma.Decimal(x)

  it.each([
    ['horas de suplencia sin bono', { coverBonusHours: 3 }, 'suplencia'],
    ['bono de suplencia sin horas', { coverBonusAmount: bono('100') }, 'suplencia'],
    ['suplencia con 0 horas', { coverBonusHours: 0, coverBonusAmount: bono('100') }, 'suplencia'],
    ['suplencia con 169 horas', { coverBonusHours: 169, coverBonusAmount: bono('100') }, 'suplencia'],
    ['bono de $0', { coverBonusHours: 3, coverBonusAmount: bono('0') }, 'suplencia'],
    ['bono de más de $100,000', { coverBonusHours: 3, coverBonusAmount: bono('100000.01') }, 'suplencia'],
    ['cancelación con 0 horas', { lateCancelHours: 0 }, 'cancelacion'],
    ['cancelación con 169 horas', { lateCancelHours: 169 }, 'cancelacion'],
  ])('rechaza %s', async (_n, reglas, regla) => {
    // El nombre del CHECK: que el rechazo venga de la base y no de otro error (un campo desconocido también rechazaría).
    await expect(version(reglas)).rejects.toThrow(`ServicePayTableVersion_${regla}_valida`)
  })

  it('acepta las reglas apagadas y en sus dos límites', async () => {
    await expect(version({})).resolves.toBeDefined()
    await expect(version({ coverBonusHours: 1, coverBonusAmount: bono('0.01'), lateCancelHours: 168 })).resolves.toBeDefined()
    await expect(version({ coverBonusHours: 168, coverBonusAmount: bono('100000'), lateCancelHours: 1 })).resolves.toBeDefined()
  })
})

describe('backfill de la migración de reglas de clase (spec fase 3 §7.2)', () => {
  const MIGRACIONES = path.resolve(__dirname, '../../../prisma/migrations')
  class Revertir extends Error {}

  it('estampa sólo lo vacío: con coach (original y createdAt) y canceladas (updatedAt); repetirlo no cambia nada', async () => {
    const carpeta = readdirSync(MIGRACIONES).find(d => d.endsWith('_service_pay_reglas_de_clase'))
    expect(carpeta).toBeDefined()
    const sql = readFileSync(path.join(MIGRACIONES, carpeta!, 'migration.sql'), 'utf8')
    const backfill = sql
      .split('-- BACKFILL:INICIO')[1]
      .split('-- BACKFILL:FIN')[0]
      .split(';')
      .map(s => s.trim())
      .filter(s => s.includes('UPDATE'))
    expect(backfill).toHaveLength(2)

    // `clase()` crea sin estampas: igual que una clase de antes de la migración.
    const conCoach = await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z' })
    const cancelada = await clase(m, { staffId: m.sofia, inicioIso: '2026-08-05T14:00:00Z', status: 'CANCELLED' })
    const sinCoach = await clase(m, { staffId: null, inicioIso: '2026-08-06T14:00:00Z' })
    const yaEstampada = await clase(m, {
      staffId: m.ana,
      inicioIso: '2026-08-07T14:00:00Z',
      originalStaffId: m.carla,
      staffAssignedAt: '2026-08-07T12:00:00Z',
    })
    const ids = [conCoach, cancelada, sinCoach, yaEstampada]
    type Fila = {
      id: string
      createdAt: Date
      updatedAt: Date
      originalStaffId: string | null
      staffAssignedAt: Date | null
      cancelledAt: Date | null
    }
    let filas: Fila[] = []
    await prisma
      .$transaction(
        async tx => {
          // Dos veces: la segunda no cambia nada. Se revierte al final porque la base de pruebas es compartida.
          for (const s of [...backfill, ...backfill]) await tx.$executeRawUnsafe(s)
          filas = await tx.classSession.findMany({
            where: { id: { in: ids } },
            select: { id: true, createdAt: true, updatedAt: true, originalStaffId: true, staffAssignedAt: true, cancelledAt: true },
            take: ids.length,
          })
          throw new Revertir()
        },
        { timeout: 60_000 },
      )
      .catch(e => {
        if (!(e instanceof Revertir)) throw e
      })
    const de = new Map(filas.map(f => [f.id, f]))
    expect(de.get(conCoach)).toMatchObject({ originalStaffId: m.ana, staffAssignedAt: de.get(conCoach)!.createdAt, cancelledAt: null })
    expect(de.get(cancelada)).toMatchObject({ originalStaffId: m.sofia, cancelledAt: de.get(cancelada)!.updatedAt })
    expect(de.get(sinCoach)).toMatchObject({ originalStaffId: null, staffAssignedAt: null, cancelledAt: null })
    expect(de.get(yaEstampada)).toMatchObject({ originalStaffId: m.carla, staffAssignedAt: new Date('2026-08-07T12:00:00Z') })
    // Fuera de la transacción revertida no cambió nada.
    expect(await prisma.classSession.findUniqueOrThrow({ where: { id: conCoach }, select: { originalStaffId: true } })).toEqual({
      originalStaffId: null,
    })
  })
})
