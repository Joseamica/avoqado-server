// tests/integration/staffPay/cierre.carga.test.ts — sólo con MEDIR_CIERRE=1 (siembra 50,000 clases + 20,000 de otros meses).
// Contra `av-db-25-pago-staff`, NUNCA otra base. Se corre así (una vez, con --runInBand):
//   MEDIR_CIERRE=1 TZ=UTC TEST_DATABASE_URL="$PAGO_DB" DATABASE_URL="$PAGO_DB" \
//     npx jest --selectProjects=integration --runTestsByPath tests/integration/staffPay/cierre.carga.test.ts --runInBand
// EN FRÍO (el primer cierre de una organización: devengos y anclas vacíos y sin estadísticas): además MEDIR_EN_FRIO=1, contra
// una base DESECHABLE recién migrada (`createdb av-db-25-pago-staff-carga` + `prisma migrate deploy`), que luego se borra.
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { cerrarPeriodo, consultaIdsDelLote, previewCierre, TIMEOUT_CIERRE_MS } from '@/services/dashboard/staffPay/cierre.service'
import { valoracionCte } from '@/services/dashboard/staffPay/valoracion'
import { fechaComoDbDate, venuePeriodRange } from '@/services/dashboard/staffPay/periodos'
import { consultasDelReporte, reportePeriodo } from '@/services/dashboard/staffPay/reporte.service'
import { consultaDePaginaDelRecibo, reciboDePersona } from '@/services/dashboard/staffPay/recibos.service'
// Las diferencias (`diferencias.service`) no existen hasta B1: su medición la agrega B5 a este archivo (Preflight-8).
import { borrarMundo, crearMundo, Mundo, periodoCerrado, tablaMindform, TZ } from './_mundo'

jest.mock('@/services/dashboard/staffPay/acceso', () => ({
  ...jest.requireActual('@/services/dashboard/staffPay/acceso'),
  sedesConServicePay: jest.fn(async () => (global as any).__sedes),
  sedesLegibles: jest.fn(async () => ({ venueIds: (global as any).__sedes, parcial: false })),
  sedesLegiblesDe: jest.fn(async (_u: string, venueIds: string[]) => ({ venueIds, parcial: false })),
  tienePermisoEn: jest.fn(async () => true),
  // El cierre y el recibo resuelven sus permisos ANTES de su transacción con `sedesConPermiso` (A8): sin esto llamarían al real.
  sedesConPermiso: jest.fn(async (_u: string, venueIds: string[]) => venueIds),
  assertPermisoEnSedes: jest.fn(async () => undefined),
}))

const N = 50_000
/** Clases de OTROS meses (julio y septiembre, misma sede): si el modo periodo recorriera la historia de la sede, se notaría. */
const OTROS_MESES = 10_000
/** Personas además de Ana (Codex R4-R1-12): el reporte tiene que tener páginas avanzadas que SÍ traigan filas. */
const OTRAS = 200
const describirSi = process.env.MEDIR_CIERRE === '1' ? describe : describe.skip
/** Sin historial de devengos ni anclas, y sin `ANALYZE` de esas tablas antes de cerrar: el primer cierre de todos (A13). */
const EN_FRIO = process.env.MEDIR_EN_FRIO === '1'
jest.setTimeout(30 * 60_000)

describirSi('cierre con 50,000 clases (spec §6.3 punto 3)', () => {
  let m: Mundo

  /** Siembra `n` clases (con 8 reservas CONFIRMED cada una) en SQL por lotes: con Prisma, 400,000 reservas tardarían minutos. */
  const sembrar = async (prefijo: string, n: number, inicio: string, dias: number, asignado: Prisma.Sql) => {
    await prisma.$executeRaw`
      INSERT INTO "ClassSession" (id, "venueId", "productId", "startsAt", "endsAt", duration, capacity, "assignedStaffId", status, "createdAt", "updatedAt")
      SELECT ${prefijo}::text || g, ${m.venueId}::text, ${m.productId}::text,
             ${inicio}::timestamp + (g % ${dias}) * INTERVAL '1 day' + (g % 600) * INTERVAL '1 minute',
             ${inicio}::timestamp + INTERVAL '50 minutes' + (g % ${dias}) * INTERVAL '1 day' + (g % 600) * INTERVAL '1 minute',
             50, 12, ${asignado}, 'SCHEDULED', NOW(), NOW()
      FROM generate_series(1, ${n}) g`
    await prisma.$executeRaw`
      INSERT INTO "Reservation" (id, "venueId", "classSessionId", "productId", "confirmationCode", "cancelSecret", status, "startsAt", "endsAt", duration, "blockedEndsAt", "partySize", "confirmedAt", "createdAt", "updatedAt")
      SELECT cs.id || '-' || k, ${m.venueId}::text, cs.id, ${m.productId}::text, 'C' || cs.id || '-' || k, 's' || cs.id || '-' || k, 'CONFIRMED',
             cs."startsAt", cs."endsAt", 50, cs."endsAt", 1, cs."startsAt" - INTERVAL '1 day', NOW(), NOW()
      FROM generate_series(1, ${n}) g CROSS JOIN generate_series(1, 8) k JOIN "ClassSession" cs ON cs.id = ${prefijo}::text || g`
  }

  beforeAll(async () => {
    m = await crearMundo('carga')
    ;(global as any).__sedes = [m.venueId]
    await tablaMindform(m)
    // Codex R4-R1-12: 200 personas más (nivel Coach) además de Ana. Ana conserva las 25,000 clases pares (su recibo
    // sigue siendo el de 25,000 renglones); las impares se reparten entre las 200 (125 cada una). El total no cambia.
    await prisma.staff.createMany({
      data: Array.from({ length: OTRAS }, (_, i) => ({
        email: `${m.key}-p${String(i).padStart(3, '0')}@example.test`,
        firstName: 'Persona',
        lastName: String(i).padStart(3, '0'),
        active: true,
      })),
    })
    const otras = (
      await prisma.staff.findMany({
        where: { email: { startsWith: `${m.key}-p` } },
        select: { id: true },
        orderBy: { email: 'asc' },
        take: OTRAS,
      })
    ).map(x => x.id)
    await prisma.staffPayLevelAssignment.createMany({
      data: otras.map(staffId => ({
        organizationId: m.orgId,
        staffId,
        payLevelId: m.coach,
        effectiveFrom: fechaComoDbDate('2026-01-01'),
        revision: 1,
      })),
    })
    // 50,000 clases de agosto 2026 con 8 reservas cada una.
    const t0 = Date.now()
    await sembrar(
      'carga',
      N,
      '2026-08-01 12:00:00',
      30,
      Prisma.sql`CASE WHEN g % 2 = 0 THEN ${m.ana}::text ELSE (${otras}::text[])[1 + ((g - 1) / 2) % ${OTRAS}] END`,
    )
    // Pendiente de la revisión de A12: clases de OTROS meses en la MISMA sede (uno anterior y uno posterior), todas de Ana.
    await sembrar('cjul', OTROS_MESES, '2026-07-01 12:00:00', 30, Prisma.sql`${m.ana}::text`)
    await sembrar('csep', OTROS_MESES, '2026-09-01 12:00:00', 20, Prisma.sql`${m.ana}::text`)
    // Estadísticas como las tendría una tabla con autovacuum al día; sin esto el plan se mide con estadísticas de tabla vacía.
    await prisma.$executeRawUnsafe('ANALYZE "ClassSession"')
    await prisma.$executeRawUnsafe('ANALYZE "Reservation"')
    console.log(
      `siembra: ${N} clases de agosto + ${2 * OTROS_MESES} de julio y septiembre, 8 reservas cada una, ${OTRAS + 1} personas: ${Date.now() - t0} ms`,
    )
  })
  afterAll(() => borrarMundo(m))

  const ahora = new Date('2026-09-02T12:00:00Z')
  const filtroAgosto = () => {
    const { from, to } = venuePeriodRange({ start: '2026-08-01', end: '2026-08-31' }, TZ)
    return { venueId: m.venueId, organizationId: m.orgId, tz: TZ, desde: from, hasta: to, ahora }
  }
  const medir = async <T>(nombre: string, fn: () => Promise<T>): Promise<T> => {
    const t = Date.now()
    const r = await fn()
    console.log(`${nombre}: ${Date.now() - t} ms`)
    return r
  }
  // Codex R3-R1-12: el plan REAL de cada consulta pesada, tal como la arma el service (no una copia del SQL).
  const explicar = async (nombre: string, sql: Prisma.Sql | null | undefined) => {
    if (!sql) throw new Error(`${nombre}: no hay consulta que medir`)
    const planDe = await prisma.$queryRaw<Array<{ 'QUERY PLAN': string }>>`EXPLAIN (ANALYZE, BUFFERS) ${sql}`
    const texto = planDe.map(x => x['QUERY PLAN']).join('\n')
    console.log(`── EXPLAIN ${nombre}\n${texto}`)
    const tiempo = /Execution Time: ([\d.]+) ms/.exec(texto)?.[1]
    const barridos = [
      ...new Set(
        [
          ...texto.matchAll(
            /(Seq Scan on "?\w+"?|Index (?:Only )?Scan(?: Backward)? using "?\w+"? on "?\w+"?|Bitmap Index Scan on "?\w+"?)/g,
          ),
        ].map(x => x[1]),
      ),
    ]
    const alerta = barridos.filter(b => /^Seq Scan on "?(Reservation|ClassSession|ClassSessionPayState|ServiceEarning)"?$/.test(b))
    console.log(
      `RESUMEN ${nombre}: ${tiempo} ms · ${barridos.join(' | ')}${alerta.length ? `\n🔎 REVISAR ${nombre}: ${alerta.join(', ')} (un Seq Scan es lo correcto si el periodo es la mayor parte de la tabla)` : ''}`,
    )
  }
  const valoracionDe = (filtro: Parameters<typeof valoracionCte>[0], despuesDe?: string) =>
    Prisma.sql`${valoracionCte(filtro)} SELECT * FROM valoradas WHERE true ${
      despuesDe ? Prisma.sql`AND "classSessionId" > ${despuesDe}` : Prisma.empty
    } ORDER BY "classSessionId" ASC LIMIT 500`

  /**
   * Estado normal de la tabla de devengos desde el segundo mes de uso: ya tiene un mes cerrado (10,000 renglones y 10,000 anclas
   * de julio) y estadísticas al día. Con MEDIR_EN_FRIO=1 no se siembra: es el primer cierre de todos.
   */
  let julioId = ''
  const sembrarHistorial = async () => {
    const julio = await periodoCerrado(m, '2026-07-01', '2026-07-31')
    julioId = julio.id
    await prisma.$executeRaw`
      INSERT INTO "ServiceEarning" (id, "organizationId", "venueId", "periodId", "staffId", concept, "sourceType", "sourceId", "occurredAt", "payLevelId", "payLevelName", count, amount, descriptor, "createdAt")
      SELECT 'hist' || cs.id, ${m.orgId}::text, cs."venueId", ${julio.id}::text, ${m.ana}::text, 'SERVICE', 'CLASS_SESSION', cs.id, cs."startsAt", ${m.hc}::text, 'Head Coach', 8, 570, '{}'::jsonb, NOW()
      FROM "ClassSession" cs WHERE cs."venueId" = ${m.venueId}::text AND cs.id LIKE 'cjul%'`
    await prisma.$executeRaw`
      INSERT INTO "ClassSessionPayState" ("classSessionId", "originPeriodId", "valuationDate", "payExcluded", "updatedAt")
      SELECT cs.id, ${julio.id}::text, cs."startsAt"::date, false, NOW()
      FROM "ClassSession" cs WHERE cs."venueId" = ${m.venueId}::text AND cs.id LIKE 'cjul%'`
    await prisma.$executeRawUnsafe('ANALYZE "ServiceEarning"')
    await prisma.$executeRawUnsafe('ANALYZE "ClassSessionPayState"')
  }

  it('mide el EXPLAIN de la valoración y el tiempo y la memoria del cierre completo', async () => {
    const f = filtroAgosto()
    // EN FRÍO: devengos y anclas vacíos y sin estadísticas. Si no, el estado normal desde el segundo mes de uso.
    console.log(`── ESCENARIO: ${EN_FRIO ? 'EN FRÍO (sin historial ni estadísticas de devengos y anclas)' : 'CON HISTORIAL'}`)
    if (!EN_FRIO) await sembrarHistorial()
    // Un lote del recorrido del cierre, tal como lo arma el service: primero los ids por llave, luego la valoración de ésos.
    const loteVivo = async (nombre: string, despuesDe?: string) => {
      const idsSql = consultaIdsDelLote(f, despuesDe, 500)
      await explicar(`${nombre} · ids del lote`, idsSql)
      const ids = (await prisma.$queryRaw<Array<{ id: string }>>(idsSql)).map(x => x.id)
      await explicar(`${nombre} · valoración de esos ids`, valoracionDe({ ...f, claseIds: ids }))
    }
    await loteVivo('valoración EN VIVO · primer lote (500 ids)')
    await loteVivo('valoración EN VIVO · lote con cursor (classSessionId > carga3)', 'carga3')

    const reporteDe = (offset: number) =>
      consultasDelReporte({ userId: m.owner, venueId: m.venueId, fecha: '2026-08-15', offset, limit: 50 })
    // Codex R4-R1-12: la página avanzada cae DENTRO de las 201 personas (OFFSET 150 LIMIT 50) y se afirma que trae filas.
    const AVANZADA = 150
    const paginaAvanzada = (titulo: string) =>
      medir(titulo, () => reportePeriodo({ userId: m.owner, venueId: m.venueId, fecha: '2026-08-15', offset: AVANZADA, limit: 50 }))
    // Codex R2-R1-12: la página 1 del reporte ABIERTO (fuente UNION ALL agrupada y paginada en SQL) antes de cerrar.
    const abierto = await medir('reporte abierto (página 1)', () =>
      reportePeriodo({ userId: m.owner, venueId: m.venueId, fecha: '2026-08-15', offset: 0, limit: 50 }),
    )
    expect(abierto.personas).toMatchObject({ total: OTRAS + 1 })
    expect(abierto.tarjetas.clases).toBe(N)
    expect((await paginaAvanzada('reporte abierto (OFFSET 150)')).personas.items).toHaveLength(50)
    const sqlAbierto = await reporteDe(0)
    await explicar('reporte ABIERTO · COUNT(DISTINCT) de personas', sqlAbierto?.cuenta)
    await explicar('reporte ABIERTO · agregada por persona, página 1', sqlAbierto?.pagina)
    await explicar('reporte ABIERTO · página avanzada (OFFSET 150 LIMIT 50)', (await reporteDe(AVANZADA))?.pagina)

    const p = await medir('previewCierre (recorre las 50,000 clases sin escribir)', () =>
      previewCierre({ userId: m.owner, venueId: m.venueId, fecha: '2026-08-15', ahora }),
    )
    // El heap máximo DURANTE el cierre (no la diferencia antes/después, que el GC vuelve ruido).
    global.gc?.()
    const memAntes = process.memoryUsage().heapUsed
    let heapMax = memAntes
    const muestreo = setInterval(() => (heapMax = Math.max(heapMax, process.memoryUsage().heapUsed)), 100)
    const t0 = Date.now()
    let r: Awaited<ReturnType<typeof cerrarPeriodo>>
    try {
      // `alTerminarLote` es el gancho de las pruebas: deja ver si el costo por lote crece (cuadrático) o se queda plano.
      let ultimo = t0
      r = await cerrarPeriodo({
        userId: m.owner,
        venueId: m.venueId,
        fecha: '2026-08-15',
        ahora,
        huellaEsperada: p.huella,
        confirmarHuerfanas: true,
        alTerminarLote: n => {
          if (n % 10 === 0 || n === 1) {
            const ahoraMs = Date.now()
            console.log(`lote ${n}: +${ahoraMs - t0} ms acumulados · ${ahoraMs - ultimo} ms desde la marca anterior`)
            ultimo = ahoraMs
          }
        },
      })
    } finally {
      clearInterval(muestreo)
    }
    const ms = Date.now() - t0
    console.log(
      `cierre de ${N} clases: ${ms} ms · heap +${Math.round((process.memoryUsage().heapUsed - memAntes) / 1e6)} MB al terminar · pico +${Math.round((heapMax - memAntes) / 1e6)} MB · total $${r.total}`,
    )
    expect(r.total).toBe(
      new Prisma.Decimal(570)
        .plus(480)
        .times(N / 2)
        .toFixed(2),
    )

    // Modo PERIODO (pendiente de la revisión de A12): ya con las 50,000 ancladas, el EXPLAIN de la valoración con
    // `modo: 'periodo'` — tiene que entrar por el índice de originPeriodId y NO recorrer los 70,000 ClassSession de la sede.
    await prisma.$executeRawUnsafe('ANALYZE "ClassSessionPayState"')
    await prisma.$executeRawUnsafe('ANALYZE "ServiceEarning"')
    const fp = { ...f, modo: 'periodo' as const, periodId: r.periodId }
    await explicar('valoración modo PERIODO · primer lote (LIMIT 500)', valoracionDe(fp))
    await explicar('valoración modo PERIODO · lote con cursor (classSessionId > carga3)', valoracionDe(fp, 'carga3'))
    await explicar('valoración modo PERIODO · de UNA persona (Ana)', valoracionDe({ ...fp, staffId: m.ana }))

    // ¿Y un periodo CHICO entre mucha historia? El de agosto abarca 50,000 de las 60,000 anclas: ahí recorrer la tabla es lo
    // correcto. Estos dos son la prueba de que el modo periodo entra por el índice de originPeriodId cuando el periodo es poco.
    const rango = (start: string, end: string) => {
      const { from: desde, to: hasta } = venuePeriodRange({ start, end }, TZ)
      return { ...f, desde, hasta, modo: 'periodo' as const }
    }
    if (julioId)
      await explicar(
        'valoración modo PERIODO · periodo de julio (10,000 anclas de 60,000)',
        valoracionDe({ ...rango('2026-07-01', '2026-07-31'), periodId: julioId }),
      )
    const chico = await periodoCerrado(m, '2026-09-01', '2026-09-30')
    await prisma.$executeRaw`
      INSERT INTO "ClassSessionPayState" ("classSessionId", "originPeriodId", "valuationDate", "payExcluded", "updatedAt")
      SELECT cs.id, ${chico.id}::text, cs."startsAt"::date, false, NOW()
      FROM "ClassSession" cs WHERE cs."venueId" = ${m.venueId}::text AND cs.id LIKE 'csep%' ORDER BY cs.id LIMIT 200`
    await prisma.$executeRawUnsafe('ANALYZE "ClassSessionPayState"')
    await explicar(
      'valoración modo PERIODO · periodo chico (200 anclas de 60,200)',
      valoracionDe({ ...rango('2026-09-01', '2026-09-30'), periodId: chico.id }),
    )

    // Codex R1-12 / R2-R1-12: también la página 1 del reporte cerrado y la PRIMERA página de un recibo con 25,000
    // renglones (el recibo ya no tiene tope: se pagina y su total lo suma la base). Las diferencias las mide B5.
    const cerrado = await medir('reporte cerrado (página 1)', () =>
      reportePeriodo({ userId: m.owner, venueId: m.venueId, fecha: '2026-08-15', offset: 0, limit: 50 }),
    )
    expect(cerrado.personas).toMatchObject({ total: OTRAS + 1 })
    expect((await paginaAvanzada('reporte cerrado (OFFSET 150)')).personas.items).toHaveLength(50)
    const sqlCerrado = await reporteDe(0)
    await explicar('reporte CERRADO · tarjetas con COUNT(DISTINCT) de personas', sqlCerrado?.cuenta)
    await explicar('reporte CERRADO · agregada por persona, página 1', sqlCerrado?.pagina)
    await explicar('reporte CERRADO · página avanzada (OFFSET 150 LIMIT 50)', (await reporteDe(AVANZADA))?.pagina)
    const recibo1 = await medir('recibo de Ana, página 1 de 25,000 renglones', () =>
      reciboDePersona({ userId: m.owner, venueId: m.venueId, staffId: m.ana, fecha: '2026-08-15', limit: 100 }),
    )
    expect(recibo1.renglones).toHaveLength(100)
    expect(recibo1.siguiente).not.toBeNull()
    expect(recibo1).toMatchObject({ cantidad: N / 2, total: new Prisma.Decimal(570).times(N / 2).toFixed(2) })
    // Codex R3-R1-12: la página AVANZADA del recibo por cursor (renglón 24,001 de 25,000), con su tiempo y su plan.
    // El cursor lleva la llave de SU recibo (`C.<llave>.<instante>|<id>`): se toma de la `siguiente` de la página 1.
    const llave = /^C\.([0-9a-f]{12})\./.exec(recibo1.siguiente!)![1]
    const [hondo] = await prisma.$queryRaw<Array<{ instante: Date; id: string }>>`
      SELECT COALESCE("occurredAt", "createdAt") AS instante, id FROM "ServiceEarning"
      WHERE "periodId" = ${r.periodId} AND "staffId" = ${m.ana}
      ORDER BY 1, 2 OFFSET 24000 LIMIT 1`
    const cursorHondo = `C.${llave}.${hondo.instante.toISOString()}|${hondo.id}`
    const avanzada = await medir('recibo de Ana, página avanzada por cursor (renglón 24,001)', () =>
      reciboDePersona({ userId: m.owner, venueId: m.venueId, staffId: m.ana, fecha: '2026-08-15', cursor: cursorHondo, limit: 100 }),
    )
    expect(avanzada.renglones).toHaveLength(100)
    await explicar(
      'recibo · página avanzada por cursor',
      await consultaDePaginaDelRecibo({
        userId: m.owner,
        venueId: m.venueId,
        staffId: m.ana,
        fecha: '2026-08-15',
        cursor: cursorHondo,
        limit: 100,
      }),
    )
    // ← B5 (Preflight-8) agrega aquí la medición de las diferencias.

    // Al final y no justo tras el cierre: si el cierre rebasa el presupuesto, que las demás mediciones sí queden impresas.
    expect(ms).toBeLessThan(TIMEOUT_CIERRE_MS / 2)
  })
})
