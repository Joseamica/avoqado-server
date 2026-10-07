// tests/integration/staffPay/acceso.feature.c3.test.ts
// Pago al personal por plan (fase 3, Bloque C). C3: la migración 20261006090000_service_pay_feature_grants. Quien tenía el
// MÓDULO SERVICE_PAY prendido (propio o heredado de la organización) recibe un acceso de FUNCIÓN que no vence, y el módulo
// desaparece (spec fase 3 §10, Codex r2-8; pre-flight filas 17-18). Corre el archivo REAL de la migración y compara contra lo
// que contestaba el resolver de módulos ANTES de migrar (`moduleService.venuesWithModule`, module.service.ts:139-185).
import fs from 'fs'
import path from 'path'
import { Client } from 'pg'
import { ModuleScope } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { ModuleCode, moduleService } from '@/services/modules/module.service'
import { organizacionDeLaSedeActivada, venueHasServicePayAccess } from '@/services/dashboard/staffPay/acceso'

const MIGRACION = path.join(__dirname, '../../../prisma/migrations/20261006090000_service_pay_feature_grants/migration.sql')

/**
 * El archivo REAL, por el protocolo simple (como `prisma migrate deploy`): varias sentencias en un solo envío. `zona` fija la
 * zona horaria de la sesión que migra: la migración no puede depender de ella (las columnas son timestamp sin zona en UTC).
 */
async function migrar(zona?: string) {
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await client.connect()
  try {
    if (zona) await client.query(`SET TIME ZONE '${zona}'`)
    await client.query(fs.readFileSync(MIGRACION, 'utf8'))
  } finally {
    await client.end()
  }
}

const stamp = `${Date.now()}${process.pid}`
const orgs: string[] = []

const crearModulo = (active = true, scope: ModuleScope = 'BOTH') =>
  prisma.module.upsert({
    where: { code: 'SERVICE_PAY' },
    update: { active, scope },
    create: { code: 'SERVICE_PAY', name: 'Pago por servicio', defaultConfig: {}, scope, active },
  })
const crearOrg = async (key: string) => {
  const id = (await prisma.organization.create({ data: { name: key, email: `${key}@example.test`, phone: '5550000000' } })).id
  orgs.push(id)
  return id
}
const crearSede = async (organizationId: string, key: string, data: Record<string, unknown> = {}) =>
  (await prisma.venue.create({ data: { name: key, slug: key, organizationId, ...data } })).id
/** Lo que contestaba el resolver de módulos (el código ya no es un `ModuleCode`: C2 lo sacó de `MODULE_CODES`). */
const conElModulo = async (venueIds: string[]) => [...(await moduleService.venuesWithModule(venueIds, 'SERVICE_PAY' as ModuleCode))].sort()
const accesos = (venueIds: string[]) =>
  prisma.capabilityGrant.findMany({
    where: { venueId: { in: venueIds }, featureCode: 'SERVICE_PAY' },
    select: {
      id: true,
      venueId: true,
      sourceId: true,
      contractId: true,
      paymentPeriodId: true,
      revokedAt: true,
      startsAt: true,
      endsAt: true,
    },
    orderBy: { venueId: 'asc' },
  })

afterAll(async () => {
  await prisma.capabilityGrant.deleteMany({ where: { venue: { organizationId: { in: orgs } } } })
  await prisma.venue.deleteMany({ where: { organizationId: { in: orgs } } })
  await prisma.organization.deleteMany({ where: { id: { in: orgs } } })
})

describe('C3 — migración: del módulo SERVICE_PAY a la función del plan (spec fase 3 §10, Codex r2-8)', () => {
  it('cada sede con el módulo (propio o heredado, respetando el apagado de la sede) recibe el acceso; el módulo desaparece; dos veces no duplica', async () => {
    const key = `pf3m${stamp}`
    const modulo = await crearModulo()
    const orgCon = await crearOrg(`${key}-con`)
    const orgSin = await crearOrg(`${key}-sin`)
    const orgOff = await crearOrg(`${key}-off`)
    const propia = await crearSede(orgSin, `${key}-propia`) // fila de la sede prendida; su organización no lo tiene
    const apagada = await crearSede(orgCon, `${key}-apagada`) // la organización lo tiene; la sede lo apagó: manda la sede
    const heredada = await crearSede(orgCon, `${key}-heredada`) // sin fila propia: hereda de la organización
    const ajena = await crearSede(orgSin, `${key}-ajena`) // nada
    const deOrgApagada = await crearSede(orgOff, `${key}-orgoff`) // la organización tiene la fila, pero apagada
    await prisma.organizationModule.createMany({
      data: [
        { organizationId: orgCon, moduleId: modulo.id, enabled: true, enabledBy: 'qa' },
        { organizationId: orgOff, moduleId: modulo.id, enabled: false, enabledBy: 'qa' },
      ],
    })
    await prisma.venueModule.createMany({
      data: [
        { venueId: propia, moduleId: modulo.id, enabled: true, enabledBy: 'qa' },
        { venueId: apagada, moduleId: modulo.id, enabled: false, enabledBy: 'qa' },
      ],
    })
    const todas = [propia, apagada, heredada, ajena, deOrgApagada]
    // El oráculo: el resolver de módulos se lo daba exactamente a éstas.
    await expect(conElModulo(todas)).resolves.toEqual([propia, heredada].sort())

    await migrar()
    await migrar()

    const migrados = await accesos(todas)
    expect(migrados.map(a => a.venueId)).toEqual([propia, heredada].sort())
    for (const a of migrados) {
      expect(a).toMatchObject({ sourceId: 'MODULO_SERVICE_PAY', contractId: null, paymentPeriodId: null, revokedAt: null })
      expect(a.endsAt.getUTCFullYear()).toBe(9999)
      expect(a.id).toMatch(/^c[0-9a-z]{24}$/) // formato cuid, como el resto del catálogo (CLAUDE.md del server)
    }
    expect(await prisma.module.findUnique({ where: { code: 'SERVICE_PAY' } })).toBeNull()
    expect(await prisma.venueModule.count({ where: { moduleId: modulo.id } })).toBe(0)
    expect(await prisma.organizationModule.count({ where: { moduleId: modulo.id } })).toBe(0)
    // El resolver de C2 lo ve: la sede que heredaba conserva pago al personal; la que lo había apagado, no.
    await expect(venueHasServicePayAccess(heredada)).resolves.toBe(true)
    await expect(venueHasServicePayAccess(propia)).resolves.toBe(true)
    await expect(venueHasServicePayAccess(apagada)).resolves.toBe(false)
    await expect(venueHasServicePayAccess(deOrgApagada)).resolves.toBe(false)
    // Pre-flight fila 17: con el plan, pero SIN activar (dinero da 403 not_activated hasta que el dueño active).
    await expect(organizacionDeLaSedeActivada(heredada)).resolves.toBe(false)
    await expect(organizacionDeLaSedeActivada(propia)).resolves.toBe(false)
  })

  it('un módulo apagado globalmente (Module.active = false) no le daba acceso a nadie: no deja ninguno', async () => {
    const key = `pf3i${stamp}`
    const modulo = await crearModulo(false)
    const orgId = await crearOrg(key)
    const venueId = await crearSede(orgId, key)
    const heredada = await crearSede(orgId, `${key}-h`)
    await prisma.venueModule.create({ data: { venueId, moduleId: modulo.id, enabled: true, enabledBy: 'qa' } })
    await prisma.organizationModule.create({ data: { organizationId: orgId, moduleId: modulo.id, enabled: true, enabledBy: 'qa' } })
    await expect(conElModulo([venueId, heredada])).resolves.toEqual([])
    await migrar()
    expect(await prisma.capabilityGrant.count({ where: { venueId: { in: [venueId, heredada] }, featureCode: 'SERVICE_PAY' } })).toBe(0)
    expect(await prisma.module.findUnique({ where: { code: 'SERVICE_PAY' } })).toBeNull()
    expect(await prisma.venueModule.count({ where: { moduleId: modulo.id } })).toBe(0)
    expect(await prisma.organizationModule.count({ where: { moduleId: modulo.id } })).toBe(0)
  })

  it.each([
    ['VENUE_ONLY' as const, 'la fila propia, sí; la de la organización no se hereda'],
    ['ORGANIZATION_ONLY' as const, 'ni la fila propia ni la de la organización le daban acceso a una sede'],
  ])('módulo con scope %s: %s (la misma regla que el resolver de módulos)', async scope => {
    const key = `pf3s${scope === 'VENUE_ONLY' ? 'v' : 'o'}${stamp}`
    const modulo = await crearModulo(true, scope)
    const orgId = await crearOrg(key)
    const propia = await crearSede(orgId, `${key}-propia`)
    const heredada = await crearSede(orgId, `${key}-heredada`)
    await prisma.organizationModule.create({ data: { organizationId: orgId, moduleId: modulo.id, enabled: true, enabledBy: 'qa' } })
    await prisma.venueModule.create({ data: { venueId: propia, moduleId: modulo.id, enabled: true, enabledBy: 'qa' } })
    const antes = await conElModulo([propia, heredada])
    expect(antes).toEqual(scope === 'VENUE_ONLY' ? [propia] : [])
    await migrar()
    expect((await accesos([propia, heredada])).map(a => a.venueId)).toEqual(antes)
    expect(await prisma.module.findUnique({ where: { code: 'SERVICE_PAY' } })).toBeNull()
  })

  it('las demos (LIVE_DEMO) y las de prueba (TRIAL) no reciben el acceso: ya tienen el plan por exención y su limpieza las borra (pre-flight fila 18)', async () => {
    const key = `pf3d${stamp}`
    const modulo = await crearModulo()
    const orgId = await crearOrg(key) // como la organización compartida de demos, con el módulo prendido
    const real = await crearSede(orgId, `${key}-real`) // hereda: sí
    const demoHeredada = await crearSede(orgId, `${key}-demoh`, { status: 'LIVE_DEMO' })
    const demoPropia = await crearSede(orgId, `${key}-demop`, { status: 'LIVE_DEMO' })
    const pruebaHeredada = await crearSede(orgId, `${key}-pruebah`, { status: 'TRIAL' })
    const pruebaPropia = await crearSede(orgId, `${key}-pruebap`, { status: 'TRIAL' })
    const demos = [demoHeredada, demoPropia, pruebaHeredada, pruebaPropia]
    await prisma.organizationModule.create({ data: { organizationId: orgId, moduleId: modulo.id, enabled: true, enabledBy: 'qa' } })
    await prisma.venueModule.createMany({
      data: [demoPropia, pruebaPropia].map(venueId => ({ venueId, moduleId: modulo.id, enabled: true, enabledBy: 'qa' })),
    })
    // Antes, el módulo se lo daba a todas.
    await expect(conElModulo([real, ...demos])).resolves.toEqual([real, ...demos].sort())

    await migrar()

    expect((await accesos([real, ...demos])).map(a => a.venueId)).toEqual([real])
    // No pierden nada: la exención de demo les sigue dando el plan.
    for (const v of demos) await expect(venueHasServicePayAccess(v).then(tiene => ({ v, tiene }))).resolves.toEqual({ v, tiene: true })
    // Y la limpieza de demos las puede borrar (un acceso con onDelete: Restrict lo impediría; liveDemoCleanup.service.ts).
    await expect(prisma.venue.deleteMany({ where: { id: { in: demos } } })).resolves.toEqual({ count: demos.length })
  })

  it('las fechas no dependen de la zona horaria de la sesión que migra: el acceso vale desde ya', async () => {
    const key = `pf3z${stamp}`
    const modulo = await crearModulo()
    const venueId = await crearSede(await crearOrg(key), key)
    await prisma.venueModule.create({ data: { venueId, moduleId: modulo.id, enabled: true, enabledBy: 'qa' } })
    const antes = Date.now()
    await migrar('Asia/Tokyo') // UTC+9: con un now() a secas el acceso empezaría 9 horas en el futuro
    const [a] = await accesos([venueId])
    expect(a.startsAt.getTime()).toBeGreaterThanOrEqual(antes - 60_000)
    expect(a.startsAt.getTime()).toBeLessThanOrEqual(Date.now() + 60_000)
    await expect(venueHasServicePayAccess(venueId)).resolves.toBe(true)
  })

  it('es idempotente: correrla otra vez con el módulo vuelto a sembrar no duplica el acceso ni truena', async () => {
    const key = `pf3r${stamp}`
    const venueId = await crearSede(await crearOrg(key), key)
    const sembrar = async () => {
      const modulo = await crearModulo()
      await prisma.venueModule.create({ data: { venueId, moduleId: modulo.id, enabled: true, enabledBy: 'qa' } })
    }
    await sembrar()
    await migrar()
    const primero = await accesos([venueId])
    expect(primero).toHaveLength(1)
    await sembrar()
    await migrar()
    expect(await accesos([venueId])).toEqual(primero)
    expect(await prisma.module.findUnique({ where: { code: 'SERVICE_PAY' } })).toBeNull()
  })
})
