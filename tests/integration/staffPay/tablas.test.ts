import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import * as activityAudit from '@/services/activityAudit.service'
import { crearTabla, publicarVersion, listarTablas, archivarTabla, historialDeTabla } from '@/services/dashboard/staffPay/tablas.service'
import { publicarVersionSchema } from '@/schemas/dashboard/staffPay.schema'
import * as controller from '@/controllers/dashboard/staffPay.dashboard.controller'

jest.mock('@/services/dashboard/staffPay/acceso', () => ({ sedesConServicePay: jest.fn(async () => (global as any).__sedes) }))

// Fecha fija coherente con las vigencias de 2026 de estas pruebas (rango de ±24 meses, full-testing A11).
const AHORA = new Date('2026-10-04T12:00:00Z')
const key = `tablas-${process.pid}-${Date.now()}`
let org: string, venue: string, product: string, hc: string, staff: string
const celdas = (max: number, monto: (n: number) => number) =>
  Array.from({ length: max + 1 }, (_, count) => ({ payLevelId: hc, count, amount: monto(count) }))

beforeAll(async () => {
  org = (await prisma.organization.create({ data: { name: key, slug: key, email: `${key}@example.test`, phone: '5500000000' } })).id
  venue = (await prisma.venue.create({ data: { organizationId: org, name: key, slug: key, timezone: 'America/Mexico_City' } })).id
  ;(global as any).__sedes = [venue]
  const cat = await prisma.menuCategory.create({ data: { venueId: venue, name: 'C', slug: `${key}-c`, availableDays: [] } })
  product = (
    await prisma.product.create({
      data: {
        venueId: venue,
        categoryId: cat.id,
        sku: `${key}-p`,
        name: 'Reformer',
        type: 'CLASS',
        price: new Prisma.Decimal(300),
        duration: 50,
        maxParticipants: 10,
        tags: [],
        allergens: [],
      },
    })
  ).id
  hc = (await prisma.staffPayLevel.create({ data: { organizationId: org, name: 'Head Coach' } })).id
  staff = (await prisma.staff.create({ data: { email: `${key}@example.test`, firstName: 'A', lastName: 'B', active: true } })).id
})
afterAll(async () => {
  if (!org) return
  await prisma.venue.deleteMany({ where: { organizationId: org } })
  await prisma.staffPayLevel.deleteMany({ where: { organizationId: org } })
  await prisma.staff.deleteMany({ where: { email: { startsWith: key } } })
  await prisma.organization.delete({ where: { id: org } })
})

describe('tablas — feature nueva', () => {
  it('publicar dos veces el mismo día crea revisiones 1 y 2; la vigente es la 2', async () => {
    const t = await crearTabla({ venueId: venue, organizationId: org, name: 'Todas', productIds: [], actorId: staff })
    await publicarVersion({
      venueId: venue,
      organizationId: org,
      tableId: t.id,
      effectiveFrom: '2026-09-01',
      countMode: 'BOOKED',
      maxCount: 2,
      cells: celdas(2, () => 400),
      actorId: staff,
      soloSimular: false,
      ahora: AHORA,
    })
    const r2 = await publicarVersion({
      venueId: venue,
      organizationId: org,
      tableId: t.id,
      effectiveFrom: '2026-09-01',
      countMode: 'BOOKED',
      maxCount: 2,
      cells: celdas(2, () => 450),
      actorId: staff,
      soloSimular: false,
      ahora: AHORA,
    })
    expect(r2.revision).toBe(2)
    const [vig] = await listarTablas(venue, '2026-09-10')
    expect(vig.vigente?.revision).toBe(2)
    expect(vig.vigente?.cells.every(c => c.amount === 450)).toBe(true)
    expect((await historialDeTabla(venue, t.id)).map(v => v.revision)).toEqual([2, 1])
  })
  it('simular no guarda la versión', async () => {
    const [t] = await listarTablas(venue, '2026-09-10')
    const antes = await prisma.servicePayTableVersion.count({ where: { tableId: t.id } })
    await publicarVersion({
      venueId: venue,
      organizationId: org,
      tableId: t.id,
      effectiveFrom: '2026-09-02',
      countMode: 'BOOKED',
      maxCount: 2,
      cells: celdas(2, () => 1),
      actorId: staff,
      soloSimular: true,
      ahora: AHORA,
    })
    expect(await prisma.servicePayTableVersion.count({ where: { tableId: t.id } })).toBe(antes)
  })
})

describe('tablas — regresión', () => {
  it('rechaza ATTENDED en la fase 1 (spec §5.5)', async () => {
    const [t] = await listarTablas(venue, '2026-09-10')
    await expect(
      publicarVersion({
        venueId: venue,
        organizationId: org,
        tableId: t.id,
        effectiveFrom: '2026-09-03',
        countMode: 'ATTENDED',
        maxCount: 2,
        cells: celdas(2, () => 1),
        actorId: staff,
        soloSimular: false,
        ahora: AHORA,
      }),
    ).rejects.toThrow('todavía no está disponible')
  })
  it('rechaza celdas fuera de 0..maxCount, repetidas, o de un nivel de otra organización', async () => {
    const [t] = await listarTablas(venue, '2026-09-10')
    const base = {
      venueId: venue,
      organizationId: org,
      tableId: t.id,
      effectiveFrom: '2026-09-04',
      countMode: 'BOOKED' as const,
      maxCount: 2,
      actorId: staff,
      soloSimular: false,
      ahora: AHORA,
    }
    const antes = await prisma.servicePayTableVersion.count({ where: { tableId: t.id } })
    await expect(publicarVersion({ ...base, cells: [{ payLevelId: hc, count: 3, amount: 1 }] })).rejects.toThrow('fuera de la tabla')
    await expect(
      publicarVersion({
        ...base,
        cells: [
          { payLevelId: hc, count: 1, amount: 1 },
          { payLevelId: hc, count: 1, amount: 2 },
        ],
      }),
    ).rejects.toThrow('repetida')
    await expect(publicarVersion({ ...base, cells: [{ payLevelId: 'cxxxxxxxxxxxxxxxxxxxxxxxx', count: 1, amount: 1 }] })).rejects.toThrow(
      'Nivel no encontrado',
    )
    // Review Focus 5 también en el service (el MCP no pasa por el Zod de la ruta): techo absurdo y monto negativo.
    await expect(publicarVersion({ ...base, maxCount: 10_000, cells: [] })).rejects.toThrow('Máximo 500 lugares')
    await expect(publicarVersion({ ...base, cells: [{ payLevelId: hc, count: 1, amount: -5 }] })).rejects.toThrow('no puede ser negativo')
    expect(await prisma.servicePayTableVersion.count({ where: { tableId: t.id } })).toBe(antes)
  })
  it('rechaza un segundo «todas las clases» o el mismo producto en dos tablas específicas vigentes', async () => {
    await expect(crearTabla({ venueId: venue, organizationId: org, name: 'Otra', productIds: [], actorId: staff })).rejects.toThrow(
      'Ya existe una tabla para todas las clases',
    )
    await crearTabla({ venueId: venue, organizationId: org, name: 'Reformer', productIds: [product], actorId: staff })
    await expect(
      crearTabla({ venueId: venue, organizationId: org, name: 'Reformer 2', productIds: [product], actorId: staff }),
    ).rejects.toThrow('ya tiene una tabla')
  })
  it('archivar con fecha deja vigentes las clases anteriores', async () => {
    const t = await prisma.servicePayTable.findFirstOrThrow({ where: { venueId: venue, name: 'Reformer' } })
    await archivarTabla({ venueId: venue, tableId: t.id, archivedFrom: '2026-12-01', actorId: staff, ahora: AHORA })
    expect((await listarTablas(venue, '2026-11-30')).some(x => x.id === t.id)).toBe(true)
    expect((await listarTablas(venue, '2026-12-01')).some(x => x.id === t.id)).toBe(false)
  })
  it('el empate se rechaza también al publicar y al mover el archivo: la tabla de reemplazo no se traslapa con la archivada', async () => {
    const vieja = await prisma.servicePayTable.findFirstOrThrow({ where: { venueId: venue, name: 'Reformer' } })
    const base = {
      venueId: venue,
      organizationId: org,
      countMode: 'BOOKED' as const,
      maxCount: 2,
      actorId: staff,
      soloSimular: false,
      ahora: AHORA,
    }
    // Específica + «todas» NO es empate: la específica gana por precedencia.
    await publicarVersion({ ...base, tableId: vieja.id, effectiveFrom: '2026-09-01', cells: celdas(2, () => 500) })
    // La vieja está archivada desde el 1-dic: se puede crear su reemplazo desde ya.
    const nueva = await crearTabla({ venueId: venue, organizationId: org, name: 'Reformer nueva', productIds: [product], actorId: staff })
    await expect(publicarVersion({ ...base, tableId: nueva.id, effectiveFrom: '2026-11-01', cells: celdas(2, () => 600) })).rejects.toThrow(
      'chocaría con «Reformer»',
    )
    // También en la simulación (el aviso de efecto no puede «pasar» lo que guardar rechazaría).
    await expect(
      publicarVersion({ ...base, tableId: nueva.id, effectiveFrom: '2026-11-01', cells: celdas(2, () => 600), soloSimular: true }),
    ).rejects.toThrow('chocaría')
    const ok = await publicarVersion({ ...base, tableId: nueva.id, effectiveFrom: '2026-12-01', cells: celdas(2, () => 600) })
    expect(ok.revision).toBe(1)
    // Alargar el archivo de la vieja la volvería a traslapar con la nueva.
    await expect(
      archivarTabla({ venueId: venue, tableId: vieja.id, archivedFrom: '2027-01-01', actorId: staff, ahora: AHORA }),
    ).rejects.toThrow('chocaría con «Reformer nueva»')
    // Una versión de la nueva anterior a su primera fecha tampoco cabe.
    await expect(publicarVersion({ ...base, tableId: nueva.id, effectiveFrom: '2026-10-15', cells: celdas(2, () => 600) })).rejects.toThrow(
      'chocaría',
    )
    const especificas = (await listarTablas(venue, '2026-12-15')).filter(x => x.productIds.includes(product) && x.vigente)
    expect(especificas.map(x => x.name)).toEqual(['Reformer nueva'])
  })
  it('dos publicaciones simultáneas con la misma revisión dan un conflicto claro, no un 500 anónimo', async () => {
    const [t] = await listarTablas(venue, '2026-09-10')
    // La carrera real (doble clic) no es determinista: se reproduce su firma, un P2002 dentro de la transacción.
    const spy = jest
      .spyOn(activityAudit, 'writeLegacyActivityAuditTx')
      .mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' }))
    try {
      await expect(
        publicarVersion({
          venueId: venue,
          organizationId: org,
          tableId: t.id,
          effectiveFrom: '2026-09-05',
          countMode: 'BOOKED',
          maxCount: 2,
          cells: celdas(2, () => 1),
          actorId: staff,
          soloSimular: false,
          ahora: AHORA,
        }),
      ).rejects.toThrow('al mismo tiempo')
    } finally {
      spy.mockRestore()
    }
  })
})

describe('reglas de clase de la versión (spec fase 3 §6.6, §7.3)', () => {
  let n = 0
  /** Tabla propia sobre un producto nuevo: no choca con las tablas de las demás pruebas del archivo. */
  const tablaPropia = async () => {
    const cat = await prisma.menuCategory.findFirstOrThrow({ where: { venueId: venue } })
    const p = await prisma.product.create({
      data: {
        venueId: venue,
        categoryId: cat.id,
        sku: `${key}-reglas-${++n}`,
        name: `Barre ${n}`,
        type: 'CLASS',
        price: new Prisma.Decimal(300),
        duration: 50,
        maxParticipants: 10,
        tags: [],
        allergens: [],
      },
    })
    return (await crearTabla({ venueId: venue, organizationId: org, name: `Barre ${n}`, productIds: [p.id], actorId: staff })).id
  }
  const publicar = (tableId: string, reglas: Record<string, unknown> = {}, effectiveFrom = '2026-09-01') =>
    publicarVersion({
      venueId: venue,
      organizationId: org,
      tableId,
      effectiveFrom,
      countMode: 'BOOKED',
      maxCount: 2,
      cells: celdas(2, () => 400),
      actorId: staff,
      soloSimular: false,
      ahora: AHORA,
      ...reglas,
    })
  const reglasDe = async (versionId: string) => {
    const v = await prisma.servicePayTableVersion.findUniqueOrThrow({
      where: { id: versionId },
      select: { coverBonusHours: true, coverBonusAmount: true, lateCancelHours: true },
    })
    return { ...v, coverBonusAmount: v.coverBonusAmount?.toFixed(2) ?? null }
  }

  it('publicar con las dos reglas las guarda en la versión, las lista, las audita y quedan en el historial', async () => {
    const t = await tablaPropia()
    const r = await publicar(t, { coverBonusHours: 3, coverBonusAmount: 100, lateCancelHours: 2 })
    expect(await reglasDe(r.versionId!)).toEqual({ coverBonusHours: 3, coverBonusAmount: '100.00', lateCancelHours: 2 })
    const lista = (await listarTablas(venue, '2026-09-10')).find(x => x.id === t)!
    expect(lista.vigente!.reglas).toEqual({ coverBonusHours: 3, coverBonusAmount: 100, lateCancelHours: 2 })
    expect((await historialDeTabla(venue, t))[0]).toMatchObject({ coverBonusHours: 3, coverBonusAmount: 100, lateCancelHours: 2 })
    const log = await prisma.activityLog.findFirstOrThrow({
      where: { action: 'SERVICE_PAY_TABLE_VERSION_PUBLISHED', entityId: r.versionId },
    })
    expect(log.data).toMatchObject({ reglas: { coverBonusHours: 3, coverBonusAmount: '100.00', lateCancelHours: 2 } })
  })

  it('lo que no se manda se hereda de la versión que rige (una pantalla vieja no apaga nada); null la apaga', async () => {
    const t = await tablaPropia()
    await publicar(t, { coverBonusHours: 3, coverBonusAmount: 100, lateCancelHours: 2 }, '2026-09-01')
    const sinMandar = await publicar(t, {}, '2026-09-15')
    expect(await reglasDe(sinMandar.versionId!)).toEqual({ coverBonusHours: 3, coverBonusAmount: '100.00', lateCancelHours: 2 })
    const sinCancelacion = await publicar(t, { lateCancelHours: null }, '2026-09-20')
    expect(await reglasDe(sinCancelacion.versionId!)).toEqual({ coverBonusHours: 3, coverBonusAmount: '100.00', lateCancelHours: null })
    const apagada = await publicar(t, { coverBonusHours: null, coverBonusAmount: null }, '2026-09-25')
    expect(await reglasDe(apagada.versionId!)).toEqual({ coverBonusHours: null, coverBonusAmount: null, lateCancelHours: null })
  })

  it('publicar sólo una celda conserva las reglas, por la ruta real: leer la tabla, cambiar una celda y publicar (Codex plan r1, P0)', async () => {
    const t = await tablaPropia()
    await publicar(t, { coverBonusHours: 3, coverBonusAmount: 100.5, lateCancelHours: 2 }, '2026-09-01')
    // GET …/tables, como lo lee el dashboard: las reglas vienen anidadas en `vigente.reglas`.
    const getRes = { json: jest.fn() }
    await controller.listTables(
      { params: { venueId: venue }, query: { fecha: '2026-09-10' }, authContext: { userId: staff } } as any,
      getRes as any,
      jest.fn(),
    )
    const tabla = JSON.parse(JSON.stringify(getRes.json.mock.calls[0][0])).find((x: { id: string }) => x.id === t)
    expect(tabla.vigente.reglas).toEqual({ coverBonusHours: 3, coverBonusAmount: 100.5, lateCancelHours: 2 })
    expect(tabla.vigente).not.toHaveProperty('coverBonusHours')
    const celdasNuevas = tabla.vigente.cells.map((c: { count: number; amount: number }) => (c.count === 2 ? { ...c, amount: 450 } : c))
    const postear = async (extra: Record<string, unknown>, effectiveFrom: string) => {
      const body = publicarVersionSchema.parse({
        effectiveFrom,
        countMode: tabla.vigente.countMode,
        maxCount: tabla.vigente.maxCount,
        cells: celdasNuevas,
        ...extra,
      })
      const res = { json: jest.fn() }
      const next = jest.fn()
      await controller.publishVersion(
        { params: { venueId: venue, tableId: t }, body, authContext: { userId: staff } } as any,
        res as any,
        next,
      )
      expect(next).not.toHaveBeenCalled()
      return res.json.mock.calls[0][0].versionId as string
    }
    // Una pantalla que sólo manda celdas (sin las llaves de las reglas): se heredan, no se borran.
    const soloCelda = await postear({}, '2026-09-15')
    expect(await reglasDe(soloCelda)).toEqual({ coverBonusHours: 3, coverBonusAmount: '100.50', lateCancelHours: 2 })
    // Una pantalla que reenvía `vigente.reglas` tal como llegó: también las conserva.
    const reenviadas = await postear({ ...tabla.vigente.reglas }, '2026-09-20')
    expect(await reglasDe(reenviadas)).toEqual({ coverBonusHours: 3, coverBonusAmount: '100.50', lateCancelHours: 2 })
    const vigente = (await listarTablas(venue, '2026-09-25')).find(x => x.id === t)!.vigente!
    expect(vigente.reglas).toEqual({ coverBonusHours: 3, coverBonusAmount: 100.5, lateCancelHours: 2 })
    expect(vigente.cells.find(c => c.count === 2)!.amount).toBe(450)
  })

  it.each([
    [{ coverBonusHours: 0, coverBonusAmount: 100 }, /de 1 a 168/],
    [{ coverBonusHours: 169, coverBonusAmount: 100 }, /de 1 a 168/],
    [{ coverBonusHours: 2.5, coverBonusAmount: 100 }, /de 1 a 168/],
    [{ lateCancelHours: 0 }, /de 1 a 168/],
    [{ lateCancelHours: 200 }, /de 1 a 168/],
    [{ coverBonusHours: 3, coverBonusAmount: 0 }, /mayor a \$0/],
    [{ coverBonusHours: 3, coverBonusAmount: 100_000.01 }, /100,000/],
    [{ coverBonusHours: 3, coverBonusAmount: 10.005 }, /2 decimales/],
    [{ coverBonusHours: 3 }, /las horas y el bono/],
    [{ coverBonusAmount: 100 }, /las horas y el bono/],
  ])('rechaza %j en español, sin guardar nada', async (reglas, mensaje) => {
    const t = await tablaPropia()
    await expect(publicar(t, reglas)).rejects.toThrow(mensaje)
    expect(await prisma.servicePayTableVersion.count({ where: { tableId: t } })).toBe(0)
  })

  it('la ruta valida la forma en español, acepta null para apagar y lleva las reglas hasta el servicio', async () => {
    const base = { effectiveFrom: '2026-09-01', countMode: 'BOOKED', maxCount: 2, cells: celdas(2, () => 400) }
    expect(publicarVersionSchema.safeParse({ ...base, coverBonusHours: 0 }).error?.issues[0].message).toBe('Mínimo 1 hora')
    expect(publicarVersionSchema.safeParse({ ...base, lateCancelHours: 169 }).error?.issues[0].message).toBe(
      'Máximo 168 horas (una semana)',
    )
    expect(publicarVersionSchema.safeParse({ ...base, coverBonusAmount: 0 }).error?.issues[0].message).toBe('El bono debe ser mayor a $0')
    expect(publicarVersionSchema.safeParse({ ...base, coverBonusHours: null, coverBonusAmount: null, lateCancelHours: null }).success).toBe(
      true,
    )

    const t = await tablaPropia()
    const body = publicarVersionSchema.parse({ ...base, coverBonusHours: 4, coverBonusAmount: 150, lateCancelHours: 6 })
    const res = { json: jest.fn() }
    const next = jest.fn()
    await controller.publishVersion(
      { params: { venueId: venue, tableId: t }, body, authContext: { userId: staff } } as any,
      res as any,
      next,
    )
    expect(next).not.toHaveBeenCalled()
    expect(await reglasDe(res.json.mock.calls[0][0].versionId)).toEqual({
      coverBonusHours: 4,
      coverBonusAmount: '150.00',
      lateCancelHours: 6,
    })
  })
})
