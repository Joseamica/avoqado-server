/**
 * Llaves finas del CRM contra un Postgres de verdad (plan 2026-11-04, L2 y L11).
 *
 * El disparador de `PlatformAccess` vive en la base: en TODA escritura de la fila en la que `llavesVersion` no sube, apaga
 * las 8 llaves finas. Así, cualquier cosa que escriba la versión VIEJA del servidor (que no conoce `llavesVersion`) deja a
 * esa persona sin llaves finas, y lo que escribe el código nuevo (que siempre la sube) se queda como lo mandó. El mock de
 * Prisma de las pruebas unitarias no puede probar nada de esto. Los `UPDATE` crudos de aquí son los que hace la versión
 * vieja.
 *
 * También corre el archivo REAL de la migración sobre filas con la forma de antes, dentro de una transacción que siempre se
 * revierte: L2 traduce las llaves viejas y sus propios `UPDATE` no apagan nada (el disparador se crea al final).
 */
import fs from 'fs'
import path from 'path'
import { Client } from 'pg'
import cuid from 'cuid'
import { getCrmAccess, type CrmAccess } from '@/services/crm/access.service'
import { addTeamMember, updateTeamMember } from '@/services/crm/teamVenue.service'
import prisma from '@/utils/prismaClient'

const MIGRACION = fs.readFileSync(path.join(__dirname, '../../../prisma/migrations/20261104120000_crm_llaves_finas/migration.sql'), 'utf8')

const suffix = `llf${Date.now()}`
const FINAS = ['cerrar', 'bajas', 'plantillas', 'preparar', 'mandar', 'verCampanas', 'equipo', 'configurar'] as const
const TODAS_FINAS = Object.fromEntries(FINAS.map(campo => [campo, true])) as Record<(typeof FINAS)[number], true>
const NINGUNA_FINA = Object.fromEntries(FINAS.map(campo => [campo, false])) as Record<(typeof FINAS)[number], false>

/** Quien da y cambia llaves en estas pruebas: las tiene todas, así que sólo la base decide. */
const todas = (staffId: string): CrmAccess => ({
  staffId,
  isSuperadmin: false,
  ver: 'todos',
  editar: 'todos',
  contactar: true,
  campanas: true,
  exportar: true,
  ventas: true,
  admin: true,
  ...TODAS_FINAS,
})

describe('CRM: el disparador de las llaves finas (L11)', () => {
  const staffIds: string[] = []
  const accessIds: string[] = []
  let actorId: string
  let equipoCreadoAqui: { organizationId: string; venueId: string } | null = null

  async function persona(nombre: string, emailVerified = true) {
    const { id } = await prisma.staff.create({
      data: { email: `${nombre}-${suffix}@test.mx`, firstName: nombre, lastName: 'Llaves', emailVerified },
    })
    staffIds.push(id)
    return id
  }

  /** Una fila escrita por el código nuevo (un INSERT no pasa por el disparador): «Ver» y «Editar» propios y las 8 finas. */
  async function filaConFinas(email: string, data: Record<string, unknown> = {}) {
    const fila = await prisma.platformAccess.create({
      data: { email, verScope: 'todos', editarScope: 'propios', contactar: true, ...TODAS_FINAS, createdById: actorId, ...data },
    })
    accessIds.push(fila.id)
    return fila
  }

  const leer = (id: string) => prisma.platformAccess.findUniqueOrThrow({ where: { id } })
  const finasDe = async (id: string) => {
    const fila = await leer(id)
    return Object.fromEntries(FINAS.map(campo => [campo, fila[campo]]))
  }

  beforeAll(async () => {
    actorId = await persona('actor')
  })

  afterAll(async () => {
    // Todo se borra por los ids que creó este archivo: un `where` con un valor undefined vaciaría la tabla.
    if (accessIds.length) await prisma.platformAccess.deleteMany({ where: { id: { in: accessIds } } })
    if (staffIds.length) await prisma.staffVenue.deleteMany({ where: { staffId: { in: staffIds } } })
    if (equipoCreadoAqui) {
      await prisma.crmTeam.deleteMany({ where: { venueId: equipoCreadoAqui.venueId } })
      await prisma.venue.deleteMany({ where: { id: equipoCreadoAqui.venueId } })
      await prisma.organization.deleteMany({ where: { id: equipoCreadoAqui.organizationId } })
    }
    if (staffIds.length) await prisma.staff.deleteMany({ where: { id: { in: staffIds } } })
  })

  it('cambiar_editar_sin_subir_la_version_apaga_las_finas', async () => {
    const fila = await filaConFinas(`editar-${suffix}@test.mx`)

    await prisma.$executeRaw`UPDATE "PlatformAccess" SET "editarScope" = 'todos', "updatedAt" = now() WHERE id = ${fila.id}`

    expect(await finasDe(fila.id)).toEqual(NINGUNA_FINA)
    expect((await leer(fila.id)).editarScope).toBe('todos')
  })

  it('baja_y_alta_viejas_apagan_las_finas', async () => {
    const fila = await filaConFinas(`baja-${suffix}@test.mx`)

    await prisma.$executeRaw`UPDATE "PlatformAccess" SET active = false, "staffId" = NULL WHERE id = ${fila.id}`
    expect(await finasDe(fila.id)).toEqual(NINGUNA_FINA)
    await prisma.$executeRaw`UPDATE "PlatformAccess" SET active = true WHERE id = ${fila.id}`
    expect(await finasDe(fila.id)).toEqual(NINGUNA_FINA)
  })

  it('el_reclamo_nuevo_conserva_las_finas', async () => {
    const ana = await persona('ana')
    const fila = await filaConFinas(`ana-${suffix}@test.mx`)

    const acceso = await getCrmAccess(ana)

    expect(acceso).toMatchObject({ staffId: ana, ...TODAS_FINAS })
    const guardada = await leer(fila.id)
    expect(guardada.staffId).toBe(ana)
    expect(guardada.llavesVersion).toBe(fila.llavesVersion + 1)
    expect(await finasDe(fila.id)).toEqual(TODAS_FINAS)
  })

  it('el_reclamo_viejo_sin_subir_la_version_apaga_las_finas', async () => {
    const beto = await persona('beto')
    const fila = await filaConFinas(`beto-${suffix}@test.mx`)

    // El `updateMany` del reclamo de la versión vieja: sólo `staffId`.
    await prisma.$executeRaw`UPDATE "PlatformAccess" SET "staffId" = ${beto}
      WHERE id = ${fila.id} AND active = true AND ("staffId" IS NULL OR "staffId" = ${beto})`

    expect((await leer(fila.id)).staffId).toBe(beto)
    expect(await finasDe(fila.id)).toEqual(NINGUNA_FINA)
  })

  it('alta_vieja_que_desliga_y_el_reclamo_de_otra_persona_quedan_sin_finas (r6-H1)', async () => {
    const antes = await persona('carla-antes')
    const despues = await persona('carla')
    const fila = await filaConFinas(`carla-${suffix}@test.mx`, { staffId: antes })

    // El `upsert` del alta vieja: los mismos 7 valores, activa y desligada.
    await prisma.$executeRaw`UPDATE "PlatformAccess" SET "verScope" = 'todos', "editarScope" = 'propios', contactar = true,
      campanas = false, exportar = false, ventas = false, admin = false, active = true, "staffId" = NULL, "updatedAt" = now()
      WHERE id = ${fila.id}`
    expect(await finasDe(fila.id)).toEqual(NINGUNA_FINA)

    // Quien tiene el correo hoy la reclama con el código nuevo: no revive nada.
    const acceso = await getCrmAccess(despues)
    expect(acceso).toMatchObject({ staffId: despues, ...NINGUNA_FINA })
    expect(await finasDe(fila.id)).toEqual(NINGUNA_FINA)
  })

  it('alta_vieja_sobre_una_fila_sin_reclamar_con_los_mismos_valores_apaga (r7-H1)', async () => {
    const fila = await filaConFinas(`dani-${suffix}@test.mx`)

    // Ningún valor cambia, pero el UPDATE pasa por el disparador igual.
    await prisma.$executeRaw`UPDATE "PlatformAccess" SET "verScope" = 'todos', "editarScope" = 'propios', contactar = true,
      campanas = false, exportar = false, ventas = false, admin = false, active = true, "staffId" = NULL
      WHERE id = ${fila.id}`

    expect(await finasDe(fila.id)).toEqual(NINGUNA_FINA)
  })

  it('dos_primeros_accesos_a_la_vez_conservan_las_finas (r8-H1)', async () => {
    const eva = await persona('eva')
    const fila = await filaConFinas(`eva-${suffix}@test.mx`)

    const [uno, dos] = await Promise.all([getCrmAccess(eva), getCrmAccess(eva)])

    expect(uno).toMatchObject({ staffId: eva, ...TODAS_FINAS })
    expect(dos).toMatchObject({ staffId: eva, ...TODAS_FINAS })
    expect(await finasDe(fila.id)).toEqual(TODAS_FINAS)
    expect((await leer(fila.id)).staffId).toBe(eva)
  })

  it('patch_viejo_con_los_mismos_7_valores_sobre_una_fila_reclamada_apaga (r9-H1)', async () => {
    const fede = await persona('fede')
    const fila = await filaConFinas(`fede-${suffix}@test.mx`, { staffId: fede })

    await prisma.$executeRaw`UPDATE "PlatformAccess" SET "verScope" = 'todos', "editarScope" = 'propios', contactar = true,
      campanas = false, exportar = false, ventas = false, admin = false, "updatedAt" = now()
      WHERE id = ${fila.id} AND active = true AND "verScope" = 'todos' AND "editarScope" = 'propios' AND contactar = true
        AND campanas = false AND exportar = false AND ventas = false AND admin = false`

    expect(await finasDe(fila.id)).toEqual(NINGUNA_FINA)
  })

  it('el_codigo_nuevo_sube_la_version_y_las_finas_quedan_como_las_mando', async () => {
    const gaby = await persona('gaby')
    const fila = await filaConFinas(`gaby-${suffix}@test.mx`, { staffId: gaby })
    const vistas = {
      ver: 'todos',
      editar: 'propios',
      cerrar: true,
      contactar: true,
      exportar: false,
      ventas: false,
      bajas: true,
      plantillas: true,
      preparar: true,
      mandar: true,
      verCampanas: true,
      equipo: true,
      configurar: true,
    } as const

    // Con `expectedKeys`: el cambio con CAS. Prende «Exportar» y apaga «Mandar campañas».
    await updateTeamMember(todas(actorId), fila.id, { ...vistas, exportar: true, mandar: false }, vistas)
    let guardada = await leer(fila.id)
    expect(guardada).toMatchObject({ exportar: true, ...TODAS_FINAS, mandar: false })
    // Espejo de L11: sin «Mandar campañas» ya no tiene las 4 de correo.
    expect(guardada).toMatchObject({ campanas: false, admin: false })
    expect(guardada.llavesVersion).toBeGreaterThan(fila.llavesVersion)

    // Sin `expectedKeys`: el cambio directo también sube la versión.
    await updateTeamMember(todas(actorId), fila.id, { ...vistas, exportar: false })
    guardada = await leer(fila.id)
    expect(guardada).toMatchObject({ exportar: false, ...TODAS_FINAS, campanas: true, admin: true })
  })

  it('volver_a_dar_de_alta_con_el_codigo_nuevo_conserva_lo_que_manda', async () => {
    // Hilda ya tiene cuenta activa: el alta le da su lugar en el venue del equipo, sin invitación ni correo.
    const hilda = await persona('hilda')
    const email = `hilda-${suffix}@test.mx`
    const yaHabiaEquipo = await prisma.crmTeam.findUnique({ where: { key: 'default' } })
    const fila = await filaConFinas(email, { staffId: hilda })

    await addTeamMember(todas(actorId), {
      email,
      firstName: 'Hilda',
      lastName: 'Llaves',
      keys: {
        ver: 'todos',
        editar: 'propios',
        cerrar: true,
        contactar: true,
        exportar: false,
        ventas: false,
        bajas: false,
        plantillas: true,
        preparar: false,
        mandar: false,
        verCampanas: false,
        equipo: false,
        configurar: false,
      },
    })
    if (!yaHabiaEquipo) {
      const equipo = await prisma.crmTeam.findUnique({ where: { key: 'default' } })
      if (equipo) equipoCreadoAqui = { organizationId: equipo.organizationId, venueId: equipo.venueId }
    }

    // El `upsert` cayó en su rama de UPDATE (la fila ya existía): subió la versión, así que lo que mandó se queda.
    const guardada = await leer(fila.id)
    expect(guardada).toMatchObject({ ...NINGUNA_FINA, cerrar: true, plantillas: true, campanas: false, admin: false, staffId: null })
    expect(guardada.llavesVersion).toBeGreaterThan(fila.llavesVersion)
  })
})

/**
 * L2: el archivo REAL de la migración sobre filas con la forma de antes. Dentro de UNA transacción que siempre se revierte
 * (BEGIN…ROLLBACK), la tabla vuelve a como estaba antes de la migración —sin las 9 columnas ni el disparador— y se corre
 * el archivo completo, como `prisma migrate deploy`. `pg.Client` usa el protocolo simple, que acepta varias sentencias.
 * El DDL toma ACCESS EXCLUSIVE sobre la tabla hasta el ROLLBACK. Es seguro porque en el CI cada proceso tiene su propia base
 * (`CI_DB_POR_PROCESO`, que también reescribe `TEST_DATABASE_URL`) y dentro del proceso las pruebas van en serie; con varios
 * procesos sobre UNA sola base, el candado frenaría a los demás archivos que tocan `PlatformAccess` hasta el ROLLBACK.
 */
describe('CRM: la migración de las llaves finas (L2)', () => {
  async function enTransaccionDesechable<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: process.env.TEST_DATABASE_URL })
    await client.connect()
    try {
      await client.query('BEGIN')
      return await fn(client)
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      await client.end()
    }
  }

  it('traduce_las_llaves_viejas_y_sus_update_no_apagan_nada', async () => {
    const ids = { admin: cuid(), campanas: cuid(), editor: cuid(), nada: cuid() }

    const filas = await enTransaccionDesechable(async client => {
      await client.query(`
        DROP TRIGGER IF EXISTS "PlatformAccess_llaves_finas_por_version" ON "PlatformAccess";
        DROP FUNCTION IF EXISTS "platformAccessLlavesFinasPorVersion"();
        ALTER TABLE "PlatformAccess" DROP COLUMN "cerrar", DROP COLUMN "bajas", DROP COLUMN "plantillas",
          DROP COLUMN "preparar", DROP COLUMN "mandar", DROP COLUMN "verCampanas", DROP COLUMN "equipo",
          DROP COLUMN "configurar", DROP COLUMN "llavesVersion";
      `)
      const vieja = (id: string, nombre: string, llaves: string) =>
        client.query(
          `INSERT INTO "PlatformAccess" (id, email, "verScope", "editarScope", contactar, campanas, exportar, ventas, admin,
             active, "createdById", "createdAt", "updatedAt")
           SELECT $1, $2, x."verScope", x."editarScope", x.contactar, x.campanas, x.exportar, x.ventas, x.admin, true,
             'cstaffmig0000000000000001', now(), now()
           FROM json_populate_record(NULL::"PlatformAccess", $3::json) x`,
          [id, `${nombre}-${suffix}@test.mx`, llaves],
        )
      const nada = { verScope: null, editarScope: null, contactar: false, campanas: false, exportar: false, ventas: false, admin: false }
      // Hoy `admin` también entra a campañas: lleva las 7 (L2), aunque su `campanas` esté apagada.
      await vieja(ids.admin, 'mig-admin', JSON.stringify({ ...nada, admin: true }))
      // Rafa, la única fila de producción hoy: sólo `campanas`.
      await vieja(ids.campanas, 'mig-campanas', JSON.stringify({ ...nada, campanas: true }))
      // Quien edita también cierra.
      await vieja(ids.editor, 'mig-editor', JSON.stringify({ ...nada, verScope: 'propios', editarScope: 'propios', contactar: true }))
      await vieja(ids.nada, 'mig-nada', JSON.stringify(nada))

      await client.query(MIGRACION)

      const { rows } = await client.query(`SELECT * FROM "PlatformAccess" WHERE id = ANY($1)`, [Object.values(ids)])
      const porId = (id: string) => rows.find(row => row.id === id)
      const despues = { admin: porId(ids.admin), campanas: porId(ids.campanas), editor: porId(ids.editor), nada: porId(ids.nada) }

      // Y el disparador que dejó el archivo ya trabaja: un UPDATE viejo sobre la fila del admin le apaga las finas.
      await client.query(`UPDATE "PlatformAccess" SET contactar = true WHERE id = $1`, [ids.admin])
      const { rows: tocada } = await client.query(`SELECT * FROM "PlatformAccess" WHERE id = $1`, [ids.admin])
      return { ...despues, adminTocada: tocada[0] }
    })

    const finas = (row: Record<string, unknown>) => Object.fromEntries(FINAS.map(campo => [campo, row[campo]]))
    const correo = { plantillas: true, preparar: true, mandar: true, verCampanas: true }
    const administracion = { equipo: true, configurar: true, bajas: true }

    expect(finas(filas.admin)).toEqual({ ...NINGUNA_FINA, ...correo, ...administracion })
    expect(filas.admin).toMatchObject({ campanas: true, admin: true })
    expect(finas(filas.campanas)).toEqual({ ...NINGUNA_FINA, ...correo })
    expect(filas.campanas).toMatchObject({ campanas: true, admin: false })
    expect(finas(filas.editor)).toEqual({ ...NINGUNA_FINA, cerrar: true })
    expect(filas.editor).toMatchObject({ campanas: false, admin: false })
    expect(finas(filas.nada)).toEqual(NINGUNA_FINA)
    expect(filas.nada).toMatchObject({ campanas: false, admin: false, llavesVersion: 0 })
    expect(finas(filas.adminTocada)).toEqual(NINGUNA_FINA)
    // El espejo viejo se queda como lo escribió quien escribió: la versión vieja lo sigue leyendo.
    expect(filas.adminTocada).toMatchObject({ campanas: true, admin: true })
  })
})
