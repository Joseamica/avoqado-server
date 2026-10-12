import prisma from '@/utils/prismaClient'
import { migrarSede } from '@/services/dashboard/rh/migracion'
import { archivarPuesto, editarPuesto } from '@/services/dashboard/rh/puestos.service'
import { terminarAsignacion } from '@/services/dashboard/rh/asignaciones.service'

jest.mock('@/services/modules/module.service', () => ({
  ...jest.requireActual('@/services/modules/module.service'),
  moduleService: { isModuleEnabled: jest.fn().mockResolvedValue(false) },
}))

// Migración de RH 1a (spec §8): idempotente, no destructiva y con el mismo candado por persona que la API.
const key = `rh1a-mig-${process.pid}-${Date.now()}`
const HISTORICOS = 5001
let orgId: string | undefined
let venueId: string | undefined // sede principal (restaurante)
let venueGrandeId: string | undefined // sede con 5,001 bajas
const staffIds: string[] = []
const st: Record<string, string> = {}
let coachId: string | undefined

async function persona(nombre: string, venue: string, role: 'WAITER' | 'CASHIER', active = true) {
  const id = (await prisma.staff.create({ data: { email: `${key}-${nombre}@example.test`, firstName: nombre, lastName: 'Prueba' } })).id
  staffIds.push(id)
  st[nombre] = id
  await prisma.staffVenue.create({ data: { staffId: id, venueId: venue, role, active } })
  return id
}

const migrados = (where: object) => ({ ...where, venueId, migrationKey: { not: null } })
const roles = async (v: string) =>
  (await prisma.staffVenue.findMany({ where: { venueId: v }, select: { id: true, role: true }, orderBy: { id: 'asc' }, take: 50 })).map(
    x => `${x.id}:${x.role}`,
  )

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: key, slug: key, email: `${key}@example.test`, phone: '5500000000' } })).id
  venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: key, slug: key, type: 'RESTAURANT' } })).id
  venueGrandeId = (await prisma.venue.create({ data: { organizationId: orgId, name: `${key}-g`, slug: `${key}-g`, type: 'RESTAURANT' } }))
    .id
})

afterAll(async () => {
  // Guarda: si beforeAll falló, nunca correr deleteMany({ venueId: undefined }) contra toda la base de pruebas.
  if (!venueId || !venueGrandeId) return
  for (const v of [venueId, venueGrandeId]) {
    await prisma.activityLog.deleteMany({ where: { venueId: v } })
    await prisma.staffAssignment.deleteMany({ where: { venueId: v } })
    await prisma.staffPosition.deleteMany({ where: { venueId: v } })
    await prisma.staffVenue.deleteMany({ where: { venueId: v } })
  }
  if (staffIds.length) await prisma.staff.deleteMany({ where: { id: { in: staffIds } } })
  await prisma.staff.deleteMany({ where: { email: { startsWith: `${key}-h-` } } })
  await prisma.venue.deleteMany({ where: { id: { in: [venueId, venueGrandeId] } } })
  if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } })
})

describe('sede principal: dos corridas, edición humana y archivado', () => {
  let rolesAntes: string[] = []

  beforeAll(async () => {
    const v = venueId!
    await persona('ana', v, 'WAITER')
    await persona('beto', v, 'CASHIER')
    await persona('caro', v, 'WAITER', false) // baja: no se migra
    await persona('dani', v, 'WAITER') // ya tiene un puesto puesto a mano
    // Puestos manuales que chocan con los nombres del giro (caso 5): «Mesero» y «Mesero (WAITER)» ocupados; «cajero» en minúsculas.
    for (const name of ['Mesero', 'Mesero (WAITER)', 'cajero']) {
      await prisma.staffPosition.create({ data: { venueId: v, name, suggestedRole: 'WAITER' } })
    }
    coachId = (await prisma.staffPosition.create({ data: { venueId: v, name: 'Coach', suggestedRole: 'WAITER' } })).id
    // Caso 4: asignación a mano ANTES de la primera corrida.
    await prisma.staffAssignment.create({
      data: { venueId: v, staffId: st.dani, positionId: coachId, effectiveFrom: new Date('2026-01-01T00:00:00Z') },
    })
    rolesAntes = await roles(v)
  })

  it('1 y 5: crea un puesto por rol en uso (con «(ROL)» y «… 2» si el nombre está ocupado) y una asignación por activo', async () => {
    expect(await migrarSede(venueId!)).toEqual({ puestosCreados: 2, asignacionesCreadas: 2 })

    const puestos = await prisma.staffPosition.findMany({
      where: migrados({}),
      select: { name: true, suggestedRole: true, migrationKey: true },
      orderBy: { migrationKey: 'asc' },
      take: 10,
    })
    expect(puestos).toEqual([
      { name: 'Cajero (CASHIER)', suggestedRole: 'CASHIER', migrationKey: `role:${venueId}:CASHIER` },
      { name: 'Mesero (WAITER) 2', suggestedRole: 'WAITER', migrationKey: `role:${venueId}:WAITER` },
    ])

    const asign = await prisma.staffAssignment.findMany({
      where: migrados({}),
      select: { staffId: true, relation: true, effectiveTo: true, position: { select: { suggestedRole: true } } },
      orderBy: { staffId: 'asc' },
      take: 10,
    })
    expect(asign).toHaveLength(2)
    expect(new Set(asign.map(a => a.staffId))).toEqual(new Set([st.ana, st.beto]))
    for (const a of asign) expect(a).toMatchObject({ relation: null, effectiveTo: null })
    expect(asign.find(a => a.staffId === st.ana)?.position.suggestedRole).toBe('WAITER')
    expect(asign.find(a => a.staffId === st.beto)?.position.suggestedRole).toBe('CASHIER')
  })

  it('1: la segunda corrida no crea nada', async () => {
    expect(await migrarSede(venueId!)).toEqual({ puestosCreados: 0, asignacionesCreadas: 0 })
    expect(await prisma.staffPosition.count({ where: migrados({}) })).toBe(2)
    expect(await prisma.staffAssignment.count({ where: migrados({}) })).toBe(2)
  })

  it('4: quien ya tenía un puesto puesto a mano no recibe otro; la baja no recibe ninguno', async () => {
    const dani = await prisma.staffAssignment.findMany({ where: { venueId, staffId: st.dani }, select: { positionId: true }, take: 10 })
    expect(dani).toEqual([{ positionId: coachId }])
    expect(await prisma.staffAssignment.count({ where: { venueId, staffId: st.caro } })).toBe(0)
  })

  it('2: renombrar un puesto migrado y volver a correr no crea otro', async () => {
    const mesero = await prisma.staffPosition.findUniqueOrThrow({ where: { migrationKey: `role:${venueId}:WAITER` } })
    await editarPuesto({ venueId: venueId!, actorId: st.ana, positionId: mesero.id, name: 'Anfitrión de piso' })
    const total = await prisma.staffPosition.count({ where: { venueId } })

    expect(await migrarSede(venueId!)).toEqual({ puestosCreados: 0, asignacionesCreadas: 0 })
    expect(await prisma.staffPosition.count({ where: { venueId } })).toBe(total)
    expect((await prisma.staffPosition.findUniqueOrThrow({ where: { id: mesero.id } })).name).toBe('Anfitrión de piso')
  })

  it('3: archivar el puesto de CASHIER y terminar su asignación: no se recrea nada, ni para alguien nuevo con ese rol', async () => {
    const cajero = await prisma.staffPosition.findUniqueOrThrow({ where: { migrationKey: `role:${venueId}:CASHIER` } })
    const deBeto = await prisma.staffAssignment.findFirstOrThrow({ where: { venueId, staffId: st.beto } })
    await terminarAsignacion({ venueId: venueId!, assignmentId: deBeto.id, actorId: st.ana }) // la API nunca borra
    await archivarPuesto({ venueId: venueId!, actorId: st.ana, positionId: cajero.id })
    await persona('eva', venueId!, 'CASHIER') // alta posterior con el rol cuyo puesto se archivó
    const [puestos, asignaciones] = await Promise.all([
      prisma.staffPosition.count({ where: { venueId } }),
      prisma.staffAssignment.count({ where: { venueId } }),
    ])

    expect(await migrarSede(venueId!)).toEqual({ puestosCreados: 0, asignacionesCreadas: 0 })
    expect(await prisma.staffPosition.count({ where: { venueId } })).toBe(puestos)
    expect(await prisma.staffAssignment.count({ where: { venueId } })).toBe(asignaciones)
    expect(await prisma.staffAssignment.count({ where: { venueId, staffId: st.eva } })).toBe(0)
    expect((await prisma.staffAssignment.findUniqueOrThrow({ where: { id: deBeto.id } })).effectiveTo).not.toBeNull()
  })

  it('6: ningún StaffVenue.role cambió', async () => {
    const despues = await roles(venueId!)
    // «eva» se dio de alta en el caso 3: se compara sólo lo que existía antes.
    expect(despues.filter(r => rolesAntes.some(a => a.split(':')[0] === r.split(':')[0]))).toEqual(rolesAntes)
  })
})

describe('sede con 5,001+ bajas históricas', () => {
  it('7: una activa con asignación manual no recibe otra; la revisión es por persona, sin tope global', async () => {
    const v = venueGrandeId!
    const historico = (await prisma.staffPosition.create({ data: { venueId: v, name: 'Histórico', suggestedRole: 'WAITER' } })).id
    // 5,001 bajas, cada una con su asignación terminada, ANTES (por id y por fecha de alta) de la asignación manual:
    // una búsqueda global con tope de 5,000 filas no llegaría a verla.
    const ids = Array.from({ length: HISTORICOS }, (_, i) => `${key}-h-${String(i).padStart(5, '0')}`)
    for (let i = 0; i < ids.length; i += 1000) {
      const lote = ids.slice(i, i + 1000)
      await prisma.staff.createMany({ data: lote.map(id => ({ id, email: `${id}@example.test`, firstName: 'Baja', lastName: id })) })
      await prisma.staffVenue.createMany({ data: lote.map(id => ({ staffId: id, venueId: v, role: 'WAITER' as const, active: false })) })
      await prisma.staffAssignment.createMany({
        data: lote.map(id => ({
          staffId: id,
          venueId: v,
          positionId: historico,
          effectiveFrom: new Date('2025-01-01T00:00:00Z'),
          effectiveTo: new Date('2025-06-30T00:00:00Z'),
        })),
      })
    }
    const fer = await persona('fer', v, 'WAITER')
    const gus = await persona('gus', v, 'CASHIER') // activa sin puesto: sí recibe el suyo
    await prisma.staffAssignment.create({
      data: { id: `zz-${key}-manual`, venueId: v, staffId: fer, positionId: historico, effectiveFrom: new Date('2026-01-01T00:00:00Z') },
    })
    const porRol = () =>
      prisma.staffVenue.groupBy({
        by: ['role', 'active'],
        where: { venueId: v },
        _count: true,
        orderBy: [{ role: 'asc' }, { active: 'asc' }],
      })
    const rolesAntes = await porRol()

    expect(await migrarSede(v)).toEqual({ puestosCreados: 2, asignacionesCreadas: 1 })
    expect(await prisma.staffAssignment.count({ where: { venueId: v, staffId: fer } })).toBe(1)
    expect(await prisma.staffAssignment.count({ where: { venueId: v, staffId: gus, migrationKey: { not: null } } })).toBe(1)
    expect(await prisma.staffAssignment.count({ where: { venueId: v } })).toBe(HISTORICOS + 2)
    expect(await porRol()).toEqual(rolesAntes)
  })
})
