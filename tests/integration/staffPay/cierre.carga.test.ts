// tests/integration/staffPay/cierre.carga.test.ts — sólo con MEDIR_CIERRE=1. UNA sede pesada (diseño r5.7, fase 3 B14): 50,000 clases
// de agosto + 20,000 de otros meses, 50,000 ventas de agosto (cobro con propina + comisión), 4 ventanas alternadas (activa / fuera /
// activa / fuera), canceladas tarde y suplencias con una tabla que tiene las dos reglas, 30 devoluciones pendientes (60 renglones:
// pasan el tope de 50) y, CON HISTORIAL, julio cerrado con ~150,000 líneas (10,000 clases + 70,000 comisiones + 70,000 propinas).
// Mide las RESPUESTAS completas (vista previa de activar y desactivar, GET /sedes, recibo y reporte abiertos, vista previa del
// cierre y cierre) con el EXPLAIN de su consulta más cara. Las muchas sedes y las dos zonas van en `cierre.carga.sedes.test.ts`.
// Contra la base de la fase (`av-db-25-pago-f3`), o EN FRÍO contra una desechable creada sólo para eso. Se corre así (--runInBand):
//   MEDIR_CIERRE=1 TZ=UTC TEST_DATABASE_URL="$PAGO_F3_DB" \
//     npx jest --selectProjects integration --runTestsByPath tests/integration/staffPay/cierre.carga.test.ts --runInBand --ci
// EN FRÍO (el primer cierre de una organización: devengos y anclas vacíos y sin estadísticas): además MEDIR_EN_FRIO=1.
import { loadavg } from 'os'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { cerrarPeriodo, consultaIdsDelLote, previewCierre, TIMEOUT_CIERRE_MS } from '@/services/dashboard/staffPay/cierre.service'
import {
  AlcanceBarrido,
  comisionesBarribles,
  consultasDeVentas,
  LineaBarrible,
  propinasBarribles,
  propinasSinDueno,
} from '@/services/dashboard/staffPay/fuentesVenta'
import { Rangos, rangosConParticipacion } from '@/services/dashboard/staffPay/rangos'
import { activarPagoAlPersonal, cambiarPropinas } from '@/services/dashboard/staffPay/activacion.service'
import { valoracionCte } from '@/services/dashboard/staffPay/valoracion'
import { fechaComoDbDate, venuePeriodRange } from '@/services/dashboard/staffPay/periodos'
import { consultasDelReporte, reportePeriodo } from '@/services/dashboard/staffPay/reporte.service'
import { consultaDePaginaDelRecibo, reciboDePersona } from '@/services/dashboard/staffPay/recibos.service'
import { diferenciasDelPeriodo, diferenciasSql, idsCandidatas, idsSinAncla } from '@/services/dashboard/staffPay/diferencias.service'
import { estadoSedes } from '@/services/dashboard/staffPay/sedes.service'
import { vistaPreviaParticipacion } from '@/services/dashboard/staffPay/participacion.vistaPrevia'
import { devolucionesPendientes, TOPE_PENDIENTES } from '@/services/dashboard/staffPay/devolucionesPendientes'
import { enUnaFoto } from '@/services/dashboard/staffPay/foto'
import { TOPE_ESPERA_MAX_MS } from '@/utils/esperaDeCandados'
import { borrarMundo, crearMundo, Mundo, periodoCerrado, TZ } from './_mundo'
import {
  activoEnAgosto,
  borrarRelleno,
  clasesA,
  estamparClases,
  explicar,
  explicarLaMasCara,
  FUERA_AGOSTO,
  medir,
  Medida,
  REEMBOLSOS,
  rellenarParticipacion,
  resumen,
  sembrarReembolsos,
  Suma,
  tablaConReglas,
  ventasA,
  ventanasAlternadas,
} from './_carga'

jest.mock('@/services/dashboard/staffPay/acceso', () => ({
  ...jest.requireActual('@/services/dashboard/staffPay/acceso'),
  sedesConServicePay: jest.fn(async (org: string) => (global as any).__sedesPorOrg?.[org] ?? []),
  sedesLegibles: jest.fn(async (_u: string, org: string) => ({ venueIds: (global as any).__sedesPorOrg?.[org] ?? [], parcial: false })),
  sedesLegiblesDe: jest.fn(async (_u: string, venueIds: string[]) => ({ venueIds, parcial: false })),
  tienePermisoEn: jest.fn(async () => true),
  // El cierre y el recibo resuelven sus permisos ANTES de su transacción con `sedesConPermiso` (A8): sin esto llamarían al real.
  sedesConPermiso: jest.fn(async (_u: string, venueIds: string[]) => venueIds),
  assertPermisoEnSedes: jest.fn(async () => undefined),
  // Activar y propinas (B2) lo piden ANTES de su transacción; la medición es la espera del candado, no el permiso.
  assertPermisoEnTodasLasSedes: jest.fn(async () => undefined),
  // `permisosPorSede` (GET /sedes) es el REAL: el dueño es OWNER de la sede.
}))

const N = 50_000
/** Clases de OTROS meses (julio y septiembre, misma sede): si el modo periodo recorriera la historia de la sede, se notaría. */
const OTROS_MESES = 10_000
/** Personas además de Ana (Codex R4-R1-12): el reporte tiene que tener páginas avanzadas que SÍ traigan filas. */
const OTRAS = 200
/** Spec fase 3 §6.5: comisiones y propinas de agosto, una de cada por venta, de las 200 personas (Ana conserva su recibo). */
const VENTAS = 50_000
/** r5.7: con historial, julio cerrado con ~150,000 líneas: 10,000 clases + 70,000 comisiones + 70,000 propinas. */
const VENTAS_JULIO = 70_000
const COMISION = 9
const PROPINA = 15
const describirSi = process.env.MEDIR_CIERRE === '1' ? describe : describe.skip
/** Sin historial de devengos ni anclas, y sin `ANALYZE` de esas tablas antes de cerrar: el primer cierre de todos (A13). */
const EN_FRIO = process.env.MEDIR_EN_FRIO === '1'
/** El tope de las fotos de lectura (`enUnaFoto`, B13) y el de la vista previa del cierre, que corre el recorrido del cierre. */
const TOPE_FOTO_MS = 60_000
/** Revisión de B11: las tablas del EXISTS de la participación, 10× más grandes que hoy (organizaciones y sus ventanas). */
const RELLENO_ORGS = 2000
const RELLENO_VENTANAS = 5
jest.setTimeout(45 * 60_000)

const pesos = (x: number) => x.toFixed(2)
const mas = (a: Suma, b: Suma): Suma => ({ n: a.n + b.n, total: a.total + b.total })
const entre = (de: number, a: number) => (_g: number, dia: number) => dia >= de && dia <= a
const enDias = (dias: number[]) => (_g: number, dia: number) => dias.includes(dia)
/** Lo que entra / queda fuera, como lo contestan las vistas previas y la pantalla de sedes (ventas netas: comisión $9 + propina $15). */
const cuenta = (clases: Suma, ventas: number) => ({
  clases: { n: clases.n, total: pesos(clases.total), pendientesDeValoracion: 0 },
  comisiones: { n: ventas, total: pesos(COMISION * ventas) },
  propinas: { n: ventas, total: pesos(PROPINA * ventas) },
})

describirSi('cierre con 50,000 clases (spec §6.3 punto 3; fase 3 B14, r5.7)', () => {
  let m: Mundo
  /** Las 200 personas además de Ana (ordenadas por correo): dan clases impares y hacen TODAS las ventas. */
  let otras: string[] = []
  let cfgId = ''

  /**
   * `n` ventas en `dias` días desde `inicio` (fase 3, B7), con ids `<prefijo>ord|pay|com<g>`: orden + cobro en efectivo
   * con propina de $15 + comisión de $9 de quien atendió (una de las 200, nunca Ana). En SQL por lotes, como las clases.
   */
  const sembrarVentas = async (prefijo: string, inicio: string, dias: number, n = VENTAS) => {
    await prisma.$executeRaw`
      INSERT INTO "Order" (id, "venueId", "orderNumber", subtotal, "taxAmount", total, "servedById", "createdAt", "updatedAt")
      SELECT ${prefijo}::text || 'ord' || g, ${m.venueId}::text, ${prefijo}::text || '-CARGA-' || g, 300, 0, 300,
             (${otras}::text[])[1 + (g % ${OTRAS})],
             ${inicio}::timestamp + (g % ${dias}) * INTERVAL '1 day' + (g % 600) * INTERVAL '1 minute', NOW()
      FROM generate_series(1, ${n}) g`
    await prisma.$executeRaw`
      INSERT INTO "Payment" (id, "venueId", "orderId", amount, "tipAmount", method, status, type, "feePercentage", "feeAmount",
                             "netAmount", "createdAt", "updatedAt")
      SELECT ${prefijo}::text || 'pay' || g, ${m.venueId}::text, o.id, 300, ${PROPINA}, 'CASH', 'COMPLETED', 'REGULAR', 0, 0,
             ${300 + PROPINA}, o."createdAt", NOW()
      FROM generate_series(1, ${n}) g JOIN "Order" o ON o.id = ${prefijo}::text || 'ord' || g`
    await prisma.$executeRaw`
      INSERT INTO "CommissionCalculation" (id, "venueId", "staffId", "configId", "paymentId", "orderId", "baseAmount",
                                           "effectiveRate", "grossCommission", "netCommission", "calcType", status,
                                           "calculatedAt", "createdAt")
      SELECT ${prefijo}::text || 'com' || g, ${m.venueId}::text, o."servedById", ${cfgId}::text, ${prefijo}::text || 'pay' || g,
             o.id, 300, 0.03, ${COMISION}, ${COMISION}, 'PERCENTAGE', 'CALCULATED', o."createdAt" + INTERVAL '5 seconds', NOW()
      FROM generate_series(1, ${n}) g JOIN "Order" o ON o.id = ${prefijo}::text || 'ord' || g`
  }
  const analizar = async (...tablas: string[]) => {
    for (const t of tablas) await prisma.$executeRawUnsafe(`ANALYZE "${t}"`)
  }
  const analizarVentas = () => analizar('Order', 'Payment', 'CommissionCalculation')

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
    ;(global as any).__sedesPorOrg = { ...(global as any).__sedesPorOrg, [m.orgId]: [m.venueId] }
    // B14 (Codex del Bloque D, DUDOSO): la tabla de Prado Norte con las dos reglas de clase (suplencia y cancelación tardía).
    await tablaConReglas(m)
    // Codex R4-R1-12: 200 personas más (nivel Coach) además de Ana. Ana conserva las 25,000 clases pares; las impares se reparten
    // entre las 200 (125 cada una). El total no cambia.
    await prisma.staff.createMany({
      data: Array.from({ length: OTRAS }, (_, i) => ({
        email: `${m.key}-p${String(i).padStart(3, '0')}@example.test`,
        firstName: 'Persona',
        lastName: String(i).padStart(3, '0'),
        active: true,
      })),
    })
    otras = (
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
    // B14: de cada 50, 2 canceladas tarde, 2 canceladas a tiempo, 2 suplencias avisadas tarde y 2 a tiempo (Ana y una de las 200).
    await estamparClases('carga', N, m.ana, otras[0])
    // Pendiente de la revisión de A12: clases de OTROS meses en la MISMA sede (uno anterior y uno posterior), todas de Ana.
    await sembrar('cjul', OTROS_MESES, '2026-07-01 12:00:00', 30, Prisma.sql`${m.ana}::text`)
    await sembrar('csep', OTROS_MESES, '2026-09-01 12:00:00', 20, Prisma.sql`${m.ana}::text`)
    // Fase 3 (B7): 50,000 ventas de agosto en la misma sede — orden + cobro con propina de $15 + comisión de $9 —, de las
    // 200 personas (Ana no vende: su recibo sigue siendo el de sus clases). Activado desde el 1-jul, propinas en el recibo.
    const t1 = Date.now()
    cfgId = (
      await prisma.commissionConfig.create({
        data: { venueId: m.venueId, orgId: m.orgId, name: 'Carga 3 %', defaultRate: 0.03, createdById: m.owner },
      })
    ).id
    await sembrarVentas('v', '2026-08-01 12:00:00', 30)
    // B14 (r6.2): 30 reembolsos el 1-sep de ventas de agosto (días 1, 11 y 21, siempre activos): pendientes desde que agosto cierra.
    await sembrarReembolsos('v', '2026-09-01 13:00:00')
    await prisma.organization.update({ where: { id: m.orgId }, data: { staffPayStartDate: fechaComoDbDate('2026-07-01') } })
    // B14 (r5.7): las 3 primeras ventanas alternadas; la cuarta (abierta desde el 27-ago) se abre tras medir la vista previa de
    // activar, que exige una sede sin ventana abierta.
    await ventanasAlternadas(m, [{ venueId: m.venueId, w4: 'sin' }])
    await prisma.staffPayTipWindow.create({
      data: { organizationId: m.orgId, startsAt: new Date('2026-07-01T06:00:00Z'), startedById: m.owner },
    })
    await analizarVentas()
    console.log(`siembra de ventas: ${VENTAS} cobros con propina + ${VENTAS} comisiones + ${REEMBOLSOS} reembolsos: ${Date.now() - t1} ms`)
    // Estadísticas como las tendría una tabla con autovacuum al día; sin esto el plan se mide con estadísticas de tabla vacía.
    await analizar('ClassSession', 'Reservation', 'StaffPayVenueWindow')
    console.log(
      `siembra: ${N} clases de agosto + ${2 * OTROS_MESES} de julio y septiembre, 8 reservas cada una, ${OTRAS + 1} personas: ${Date.now() - t0} ms`,
    )
  })
  afterAll(async () => {
    await borrarRelleno(m.key)
    await borrarMundo(m)
  })

  const ahora = new Date('2026-09-02T12:00:00Z')
  const filtroAgosto = () => {
    const { from, to } = venuePeriodRange({ start: '2026-08-01', end: '2026-08-31' }, TZ)
    return { venueId: m.venueId, organizationId: m.orgId, tz: TZ, desde: from, hasta: to, ahora }
  }
  const medirTiempo = async <T>(nombre: string, fn: () => Promise<T>): Promise<T> => {
    const t = Date.now()
    const r = await fn()
    console.log(`${nombre}: ${Date.now() - t} ms`)
    return r
  }
  const valoracionDe = (filtro: Parameters<typeof valoracionCte>[0], despuesDe?: string) =>
    Prisma.sql`${valoracionCte(filtro)} SELECT * FROM valoradas WHERE true ${
      despuesDe ? Prisma.sql`AND "classSessionId" > ${despuesDe}` : Prisma.empty
    } ORDER BY "classSessionId" ASC LIMIT 500`

  /**
   * Estado normal de la tabla de devengos desde el segundo mes de uso: julio cerrado con ~150,000 líneas (r5.7: 10,000 clases y
   * sus anclas, 70,000 comisiones y 70,000 propinas congeladas) y estadísticas al día, más 30 reembolsos el 1-sep de ventas de julio
   * (pendientes desde ya). Con MEDIR_EN_FRIO=1 no se siembra: es el primer cierre de todos.
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
    // Fase 3 (revisiones de B3-B5): julio CERRADO con sus ventas YA congeladas (comisión y propina de cada cobro).
    // `rangosConParticipacion` junta julio con agosto (cerrados contiguos): el cierre, el preview y la vista en vivo de agosto
    // recorren también lo cobrado en julio y lo descartan por el anti-join de lo congelado. Eso es lo que se mide aquí.
    const t = Date.now()
    await sembrarVentas('j', '2026-07-01 12:00:00', 30, VENTAS_JULIO)
    await prisma.$executeRaw`
      INSERT INTO "ServiceEarning" (id, "organizationId", "venueId", "periodId", "staffId", concept, "sourceType", "sourceId", "occurredAt", amount, descriptor, "createdAt")
      SELECT 'hcom' || cc.id, ${m.orgId}::text, cc."venueId", ${julio.id}::text, cc."staffId", 'SERVICE', 'COMMISSION', cc.id,
             cc."calculatedAt", cc."netCommission", '{}'::jsonb, NOW()
      FROM "CommissionCalculation" cc WHERE cc."venueId" = ${m.venueId}::text AND cc.id LIKE 'jcom%'`
    await prisma.$executeRaw`
      INSERT INTO "ServiceEarning" (id, "organizationId", "venueId", "periodId", "staffId", concept, "sourceType", "sourceId", "occurredAt", amount, descriptor, "createdAt")
      SELECT 'htip' || p.id, ${m.orgId}::text, p."venueId", ${julio.id}::text, o."servedById", 'SERVICE', 'TIP', p.id,
             p."createdAt", p."tipAmount", '{}'::jsonb, NOW()
      FROM "Payment" p JOIN "Order" o ON o.id = p."orderId" WHERE p."venueId" = ${m.venueId}::text AND p.id LIKE 'jpay%'`
    // B14 (r6.2): 30 reembolsos de ventas de julio YA congeladas (60 renglones pendientes: pasa el tope de 50).
    await sembrarReembolsos('j', '2026-09-01 12:00:00')
    await analizarVentas()
    console.log(`siembra del historial: julio cerrado con ${OTROS_MESES + 2 * VENTAS_JULIO} líneas: ${Date.now() - t} ms`)
    await analizar('ServiceEarning', 'ClassSessionPayState')
  }

  it('mide las respuestas completas, sus EXPLAIN y el tiempo y la memoria del cierre', async () => {
    const f = filtroAgosto()
    // EN FRÍO: devengos y anclas vacíos y sin estadísticas. Si no, el estado normal desde el segundo mes de uso.
    console.log(`── ESCENARIO: ${EN_FRIO ? 'EN FRÍO (sin historial ni estadísticas de devengos y anclas)' : 'CON HISTORIAL'}`)
    console.log(
      `── carga de la Mac al empezar: ${loadavg()
        .map(x => x.toFixed(1))
        .join(' / ')}`,
    )
    if (!EN_FRIO) await sembrarHistorial()

    // ── El espejo: lo que cada respuesta debe contestar, calculado de las reglas de la siembra (no leído de la base) ──
    const activo = (_g: number, dia: number) => activoEnAgosto(dia)
    const pagables = clasesA(N, activo)
    const ventasActivas = ventasA(VENTAS, activo)
    const totalCierre = pagables.total + (COMISION + PROPINA) * ventasActivas
    /** Las clases de Ana del 1-sep (`csep`, g % 20 = 0): terminaron antes de `ahora`; las del 2-sep, no. */
    const sep1: Suma = { n: OTROS_MESES / 20, total: (570 * OTROS_MESES) / 20 }
    const enFuera = (_g: number, dia: number) => FUERA_AGOSTO.has(dia)
    const pendientesAntes = EN_FRIO ? 0 : 2 * REEMBOLSOS
    const porReembolso = COMISION + PROPINA

    // ── B14 · vista previa de ACTIVAR (sólo W1-W3: la sede no tiene ventana abierta), desde su mínimo efectivo (25-ago) ──
    const vpActivar = await medir(() =>
      vistaPreviaParticipacion({ userId: m.owner, venueId: m.venueId, sedeId: m.venueId, accion: 'activar', fecha: '2026-08-25', ahora }),
    )
    resumen('vista previa de ACTIVAR la sede desde el 25-ago', vpActivar, TOPE_FOTO_MS)
    await explicarLaMasCara('vista previa de ACTIVAR', vpActivar)
    expect(vpActivar.valor).toEqual({
      accion: 'activar',
      fecha: '2026-08-25',
      minimo: '2026-08-25',
      maximo: '2026-09-02',
      zona: TZ,
      entran: cuenta(mas(clasesA(N, entre(25, 30)), sep1), ventasA(VENTAS, entre(25, 30))),
      quedanFuera: cuenta(clasesA(N, enDias([8, 9, 10, 18, 19])), ventasA(VENTAS, enDias([8, 9, 10, 18, 19]))),
    })
    // La cuarta ventana, abierta desde el 27-ago (la sede queda ACTIVA hoy).
    await ventanasAlternadas(m, [{ venueId: m.venueId, w4: 'abierta' }], { soloW4: true })
    await analizar('StaffPayVenueWindow')

    // ── B14 · vista previa de DESACTIVAR hasta el 26-ago (el día antes de W4: borra la activación) ──
    const vpDesactivar = await medir(() =>
      vistaPreviaParticipacion({
        userId: m.owner,
        venueId: m.venueId,
        sedeId: m.venueId,
        accion: 'desactivar',
        fecha: '2026-08-26',
        ahora,
      }),
    )
    resumen('vista previa de DESACTIVAR la sede hasta el 26-ago', vpDesactivar, TOPE_FOTO_MS)
    await explicarLaMasCara('vista previa de DESACTIVAR', vpDesactivar)
    expect(vpDesactivar.valor).toMatchObject({
      accion: 'desactivar',
      fecha: '2026-08-26',
      minimo: '2026-08-26',
      dejanDeEntrar: cuenta(mas(clasesA(N, entre(27, 30)), sep1), ventasA(VENTAS, entre(27, 30))),
    })

    // ── B14 · GET /sedes (`estadoSedes`) con la sede pesada: lo que quedó fuera desde su mínimo efectivo (25 y 26 de agosto) ──
    const sedes = await medir(() => estadoSedes({ userId: m.owner, venueId: m.venueId, ahora }))
    resumen('GET /sedes (estadoSedes) · 1 sede pesada', sedes, TOPE_FOTO_MS)
    await explicarLaMasCara('GET /sedes · 1 sede pesada', sedes)
    expect(sedes.valor.sedes).toEqual([
      expect.objectContaining({
        venueId: m.venueId,
        estado: 'ACTIVA',
        desde: '2026-08-27',
        hasta: null,
        minimo: null,
        puedeActivar: false,
        puedeDesactivar: true,
        fueraEstePeriodo: cuenta(clasesA(N, entre(25, 26)), ventasA(VENTAS, entre(25, 26))),
      }),
    ])

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
      medirTiempo(titulo, () => reportePeriodo({ userId: m.owner, venueId: m.venueId, fecha: '2026-08-15', offset: AVANZADA, limit: 50 }))
    // Codex R2-R1-12: la página 1 del reporte ABIERTO (fuente UNION ALL agrupada y paginada en SQL) antes de cerrar. No abre foto:
    // sus consultas van con el cliente global y sus planes salen abajo (la cuenta de personas y la página).
    const abierto = await medir(() => reportePeriodo({ userId: m.owner, venueId: m.venueId, fecha: '2026-08-15', offset: 0, limit: 50 }))
    resumen('reporte ABIERTO (página 1)', abierto, TOPE_FOTO_MS)
    expect(abierto.valor.personas).toMatchObject({ total: OTRAS + 1 })
    expect(abierto.valor.tarjetas).toMatchObject({
      total: pesos(totalCierre),
      clases: pagables.n,
      comisiones: pesos(COMISION * ventasActivas),
      propinas: pesos(PROPINA * ventasActivas),
    })
    expect((await paginaAvanzada('reporte abierto (OFFSET 150)')).personas.items).toHaveLength(50)
    const sqlAbierto = await reporteDe(0)
    await explicar('reporte ABIERTO · COUNT(DISTINCT) de personas', sqlAbierto?.cuenta)
    await explicar('reporte ABIERTO · agregada por persona, página 1', sqlAbierto?.pagina)
    await explicar('reporte ABIERTO · página avanzada (OFFSET 150 LIMIT 50)', (await reporteDe(AVANZADA))?.pagina)

    // Revisión de B11: dentro de la valoración, el EXISTS de la participación lee `Organization` y `StaffPayVenueWindow`; con
    // tablas de prueba de unas cuantas filas el plan las recorre enteras por cada clase. ¿Escala? La MISMA valoración de agosto (lo
    // que cuenta el reporte abierto, sede por sede) con las tablas de hoy y con 2,000 organizaciones y 10,000 ventanas más.
    const conteoAgosto = Prisma.sql`${valoracionCte(f)}
      SELECT COUNT(*) FILTER (WHERE estado = 'OK')::int AS ok, SUM(monto) FILTER (WHERE estado = 'OK') AS total FROM valoradas`
    const conTablasDeHoy = await explicar('valoración de agosto entera (el conteo del reporte) · tablas de hoy', conteoAgosto)
    await rellenarParticipacion(m.key, RELLENO_ORGS, RELLENO_VENTANAS)
    await analizar('Organization', 'StaffPayVenueWindow')
    const conTablasGrandes = await explicar(
      `valoración de agosto entera (el conteo del reporte) · con ${RELLENO_ORGS} organizaciones y ${RELLENO_ORGS * RELLENO_VENTANAS} ventanas más`,
      conteoAgosto,
    )
    const abiertoGrandes = await medir(() =>
      reportePeriodo({ userId: m.owner, venueId: m.venueId, fecha: '2026-08-15', offset: 0, limit: 50 }),
    )
    resumen(`reporte ABIERTO (página 1) · con ${RELLENO_ORGS} organizaciones más`, abiertoGrandes, TOPE_FOTO_MS)
    expect(abiertoGrandes.valor.tarjetas).toMatchObject({ total: pesos(totalCierre), clases: pagables.n })
    await borrarRelleno(m.key)
    await analizar('Organization', 'StaffPayVenueWindow')
    console.log(
      `ESCALA DE LA PARTICIPACIÓN: valoración de agosto ${conTablasDeHoy.ms} ms con las tablas de hoy → ${conTablasGrandes.ms} ms 10× más grandes`,
    )
    // Con tablas grandes, el EXISTS entra por índice (la llave de la organización y las ventanas de la sede): no las recorre.
    expect(conTablasGrandes.barridos).not.toContain('Seq Scan on "StaffPayVenueWindow"')
    expect(conTablasGrandes.barridos).not.toContain('Seq Scan on "Organization"')

    // Revisiones de B3-B5: el recibo ABIERTO de alguien que VENDE y da clases. Sus propinas se filtran por persona DESPUÉS de
    // calcular el dueño de cada cobro de la sede (ningún índice lo sirve). B12-B14: con sus devoluciones pendientes.
    // `otras[0]`: 125 clases impares de Coach + 250 ventas (g múltiplo de 200), las de los días activos.
    const vendedor = otras[0]
    const clasesVendedor = clasesA(N, (g, dia) => g % 2 === 1 && Math.floor((g - 1) / 2) % OTRAS === 0 && activoEnAgosto(dia))
    const ventasVendedor = ventasA(VENTAS, (g, dia) => g % OTRAS === 0 && activoEnAgosto(dia))
    const recibo = await medir(() =>
      reciboDePersona({ userId: m.owner, venueId: m.venueId, staffId: vendedor, fecha: '2026-08-15', limit: 100 }),
    )
    resumen('recibo ABIERTO de quien vende y da clases (página 1)', recibo, TOPE_FOTO_MS)
    // B14: la orden de cada línea, por llave (`ordenDe`): nunca un recorrido de TODAS las órdenes por cada propina de la persona.
    expect((await explicarLaMasCara('recibo ABIERTO', recibo))?.barridos).not.toContain('Seq Scan on "Order"')
    expect(recibo.valor).toMatchObject({
      total: pesos(clasesVendedor.total + (COMISION + PROPINA) * ventasVendedor),
      totalesPorTipo: {
        CLASE: pesos(clasesVendedor.total),
        COMISION: pesos(COMISION * ventasVendedor),
        PROPINA: pesos(PROPINA * ventasVendedor),
      },
      // k par ⇒ g = 100·k múltiplo de 200 ⇒ el vendedor: la mitad de los reembolsos de julio (con historial).
      pendientes: { n: pendientesAntes / 2, total: pesos((-porReembolso * pendientesAntes) / 4), truncado: false },
    })
    expect(recibo.valor.renglones).toHaveLength(100)
    await explicar(
      'recibo ABIERTO · página 1',
      await consultaDePaginaDelRecibo({ userId: m.owner, venueId: m.venueId, staffId: vendedor, fecha: '2026-08-15', limit: 100 }),
    )

    const preview = await medir(() => previewCierre({ userId: m.owner, venueId: m.venueId, fecha: '2026-08-15', ahora }))
    resumen('previewCierre (con porSede y pendientes)', preview, TIMEOUT_CIERRE_MS)
    await explicarLaMasCara('previewCierre', preview)
    const p = preview.valor
    expect(p).toMatchObject({
      puedeCerrar: true,
      clases: pagables.n,
      comisiones: ventasActivas,
      propinas: ventasActivas,
      reversos: 0,
      personas: OTRAS + 1,
      totalServicios: pesos(pagables.total),
      total: pesos(totalCierre),
      propinasSinDueno: { n: 0, total: '0.00' },
      pendientes: { n: pendientesAntes, total: pesos((-porReembolso * pendientesAntes) / 2) },
    })
    expect(p.porSede).toEqual([
      expect.objectContaining({
        venueId: m.venueId,
        estado: 'ACTIVA',
        entra: cuenta(pagables, ventasActivas),
        fuera: cuenta(clasesA(N, enFuera), ventasA(VENTAS, enFuera)),
        pendientes: { n: pendientesAntes, total: pesos((-porReembolso * pendientesAntes) / 2) },
      }),
    ])
    // El plan REAL del primer lote de cada fuente de ventas, tal como lo pide el cierre (B3).
    const alcanceVentas: AlcanceBarrido = {
      organizationId: m.orgId,
      periodo: { id: null, start: '2026-08-01', end: '2026-08-31' },
      sedes: [{ venueId: m.venueId, tz: TZ }],
      startDate: '2026-07-01',
    }
    const ventas = await consultasDeVentas(prisma, alcanceVentas)
    // B11: los rangos (periodo y participación), una vez por recorrido, como el cierre.
    const rangos = await rangosConParticipacion(prisma, alcanceVentas)
    await explicar('ventas · ids del primer lote de comisiones', ventas.comisiones)
    await explicar('ventas · ids del primer lote de propinas', ventas.propinas)
    await explicar('ventas · reversos por anulación (primer lote)', ventas.reversos)
    // B7 r1: la cuenta de propinas sin dueño del preview (antes de congelar). Con historial tardaba 102-132 s por un mal plan.
    await explicar('ventas · propinas sin dueño (la cuenta del preview)', ventas.sinDueno)
    expect(await medirTiempo('propinasSinDueno (antes de congelar)', () => propinasSinDueno(prisma, alcanceVentas, rangos))).toMatchObject({
      n: 0,
    })
    // ¿El costo de un lote crece con el cursor, o cada lote recorre el rango entero? El mismo recorrido por lotes que hace
    // el cierre, por fuente, con el tiempo de cada lote (el primero, cada 20 y el último) y el total de la fuente.
    const recorrerFuente = async (
      nombre: string,
      leer: (db: typeof prisma, a: AlcanceBarrido, rg: Rangos, o: { despuesDe?: string; limite: number }) => Promise<LineaBarrible[]>,
    ) => {
      const t = Date.now()
      let despuesDe: string | undefined
      let mitad: string | undefined
      let n = 0
      let lineas = 0
      for (;;) {
        const tl = Date.now()
        const lote = await leer(prisma, alcanceVentas, rangos, { despuesDe, limite: 500 })
        if (!lote.length) break
        n++
        lineas += lote.length
        if (n === 1 || n % 20 === 0 || lote.length < 500) console.log(`${nombre} · lote ${n}: ${Date.now() - tl} ms`)
        despuesDe = lote[lote.length - 1].sourceId
        if (n === 50) mitad = despuesDe
      }
      console.log(`${nombre} · ${n} lotes, ${lineas} líneas: ${Date.now() - t} ms`)
      return { lineas, mitad: mitad! }
    }
    const rc = await recorrerFuente('recorrido de comisiones', comisionesBarribles)
    const rp = await recorrerFuente('recorrido de propinas', propinasBarribles)
    expect([rc.lineas, rp.lineas]).toEqual([ventasActivas, ventasActivas])
    // B7 r1: el lote 51 de cada fuente (a medio cursor), su plan y su tiempo completo (ids + detalle + rangos).
    const aMedias = await consultasDeVentas(prisma, alcanceVentas, 500, { comisiones: rc.mitad, propinas: rp.mitad })
    await explicar('ventas · ids del lote 51 de comisiones (a medio cursor)', aMedias.comisiones)
    await explicar('ventas · ids del lote 51 de propinas (a medio cursor)', aMedias.propinas)
    await medirTiempo('lote 51 de propinas completo', () =>
      propinasBarribles(prisma, alcanceVentas, rangos, { despuesDe: rp.mitad, limite: 500 }),
    )
    await medirTiempo('lote 51 de comisiones completo', () =>
      comisionesBarribles(prisma, alcanceVentas, rangos, { despuesDe: rc.mitad, limite: 500 }),
    )

    // Revisión de B4: activar y cambiar las propinas esperan el candado de la organización que el cierre retiene todo el
    // tiempo. Se lanzan las dos —en su forma que no cambia nada: ya activado, ya encendidas— en cuanto el cierre termina su
    // primer lote (ya tiene el candado). Desde B9 esperan su presupuesto (6 s de 10 s) y contestan 409 CIERRE_EN_CURSO.
    const operacionCorta = (nombre: string, fn: () => Promise<unknown>) => {
      const t = Date.now()
      return fn().then(
        () => `${nombre}: OK en ${Date.now() - t} ms`,
        (e: any) =>
          `${nombre}: FALLÓ en ${Date.now() - t} ms · ${e?.code ?? e?.constructor?.name} · ${String(e?.message ?? e)
            .replace(/\s+/g, ' ')
            .slice(-300)}`,
      )
    }
    let cortas: Promise<string>[] = []
    // El heap máximo DURANTE el cierre (no la diferencia antes/después, que el GC vuelve ruido).
    global.gc?.()
    const memAntes = process.memoryUsage().heapUsed
    let heapMax = memAntes
    const muestreo = setInterval(() => (heapMax = Math.max(heapMax, process.memoryUsage().heapUsed)), 100)
    let ultimo = Date.now()
    const t0 = ultimo
    let cierre!: Medida<Awaited<ReturnType<typeof cerrarPeriodo>>>
    try {
      // `alTerminarLote` es el gancho de las pruebas: deja ver si el costo por lote crece (cuadrático) o se queda plano.
      cierre = await medir(() =>
        cerrarPeriodo({
          userId: m.owner,
          venueId: m.venueId,
          fecha: '2026-08-15',
          ahora,
          huellaEsperada: p.huella,
          confirmarHuerfanas: true,
          alTerminarLote: n => {
            if (n === 1) {
              cortas = [
                operacionCorta('activarPagoAlPersonal durante el cierre (ya activado)', () =>
                  activarPagoAlPersonal({ userId: m.owner, venueId: m.venueId, periodicidad: 'MONTHLY' }),
                ),
                operacionCorta('cambiarPropinas durante el cierre (ya encendidas)', () =>
                  cambiarPropinas({ userId: m.owner, venueId: m.venueId, encender: true }),
                ),
              ]
            }
            if (n % 10 === 0 || n === 1) {
              const ahoraMs = Date.now()
              console.log(`lote ${n}: +${ahoraMs - t0} ms acumulados · ${ahoraMs - ultimo} ms desde la marca anterior`)
              ultimo = ahoraMs
            }
          },
        }),
      )
    } finally {
      clearInterval(muestreo)
    }
    const r = cierre.valor
    const ms = Math.round(cierre.ms)
    resumen('cierre', cierre, TIMEOUT_CIERRE_MS)
    console.log(
      `cierre de ${pagables.n} clases + ${ventasActivas} comisiones + ${ventasActivas} propinas: ${ms} ms · heap +${Math.round((process.memoryUsage().heapUsed - memAntes) / 1e6)} MB al terminar · pico +${Math.round((heapMax - memAntes) / 1e6)} MB · total $${r.total}`,
    )
    // r5.7: el cálculo medido más el presupuesto de espera del cierre (30 s) tiene que caber en su timeout (120 s).
    console.log(
      `MARGEN DEL CIERRE: ${ms} ms medidos + ${TOPE_ESPERA_MAX_MS} ms de espera = ${ms + TOPE_ESPERA_MAX_MS} de ${TIMEOUT_CIERRE_MS} ms`,
    )
    const lineasCortas = await Promise.all(cortas)
    for (const linea of lineasCortas) console.log(`OPERACIÓN CORTA · ${linea}`)
    expect(lineasCortas).toHaveLength(2)
    for (const linea of lineasCortas) expect(linea).toMatch(/FALLÓ en \d+ ms · CIERRE_EN_CURSO/)
    expect(r.total).toBe(pesos(totalCierre))

    // B12-B14 (r6.2): las devoluciones pendientes DESPUÉS de cerrar agosto: las de agosto ya congelado se suman (60 renglones más).
    const pendientes = await medir(() => enUnaFoto(tx => devolucionesPendientes(tx, { organizationId: m.orgId, sedes: [m.venueId] })))
    resumen(`devolucionesPendientes tras cerrar (${pendientesAntes + 2 * REEMBOLSOS} renglones)`, pendientes, TOPE_FOTO_MS)
    await explicarLaMasCara('devolucionesPendientes', pendientes)
    expect(pendientes.valor).toMatchObject({
      n: pendientesAntes + 2 * REEMBOLSOS,
      total: pesos(-porReembolso * (pendientesAntes / 2 + REEMBOLSOS)),
      truncado: true,
    })
    expect(pendientes.valor.items).toHaveLength(TOPE_PENDIENTES)

    // Modo PERIODO (pendiente de la revisión de A12): ya con las ancladas, el EXPLAIN de la valoración con `modo: 'periodo'` —
    // tiene que entrar por el índice de originPeriodId y NO recorrer todos los ClassSession de la sede.
    await analizar('ClassSessionPayState', 'ServiceEarning')
    const fp = { ...f, modo: 'periodo' as const, periodId: r.periodId }
    await explicar('valoración modo PERIODO · primer lote (LIMIT 500)', valoracionDe(fp))
    await explicar('valoración modo PERIODO · lote con cursor (classSessionId > carga3)', valoracionDe(fp, 'carga3'))
    await explicar('valoración modo PERIODO · de UNA persona (Ana)', valoracionDe({ ...fp, staffId: m.ana }))

    // ¿Y un periodo CHICO entre mucha historia? El de agosto abarca la mayor parte de las anclas: ahí recorrer la tabla es lo
    // correcto. Estos dos son la prueba de que el modo periodo entra por el índice de originPeriodId cuando el periodo es poco.
    const rangoCivil = (start: string, end: string) => {
      const { from: desde, to: hasta } = venuePeriodRange({ start, end }, TZ)
      return { ...f, desde, hasta, modo: 'periodo' as const }
    }
    if (julioId)
      await explicar(
        'valoración modo PERIODO · periodo de julio (10,000 anclas)',
        valoracionDe({ ...rangoCivil('2026-07-01', '2026-07-31'), periodId: julioId }),
      )
    const chico = await periodoCerrado(m, '2026-09-01', '2026-09-30')
    await prisma.$executeRaw`
      INSERT INTO "ClassSessionPayState" ("classSessionId", "originPeriodId", "valuationDate", "payExcluded", "updatedAt")
      SELECT cs.id, ${chico.id}::text, cs."startsAt"::date, false, NOW()
      FROM "ClassSession" cs WHERE cs."venueId" = ${m.venueId}::text AND cs.id LIKE 'csep%' ORDER BY cs.id LIMIT 200`
    await analizar('ClassSessionPayState')
    await explicar(
      'valoración modo PERIODO · periodo chico (200 anclas)',
      valoracionDe({ ...rangoCivil('2026-09-01', '2026-09-30'), periodId: chico.id }),
    )

    // Codex R1-12 / R2-R1-12: también la página 1 del reporte cerrado y la PRIMERA página del recibo de Ana (el recibo ya no tiene
    // tope: se pagina y su total lo suma la base). Las diferencias las mide B5.
    const cerrado = await medirTiempo('reporte cerrado (página 1)', () =>
      reportePeriodo({ userId: m.owner, venueId: m.venueId, fecha: '2026-08-15', offset: 0, limit: 50 }),
    )
    expect(cerrado.personas).toMatchObject({ total: OTRAS + 1 })
    expect(cerrado.tarjetas).toMatchObject({
      clases: pagables.n,
      comisiones: pesos(COMISION * ventasActivas),
      propinas: pesos(PROPINA * ventasActivas),
    })
    expect((await paginaAvanzada('reporte cerrado (OFFSET 150)')).personas.items).toHaveLength(50)
    const sqlCerrado = await reporteDe(0)
    await explicar('reporte CERRADO · tarjetas con COUNT(DISTINCT) de personas', sqlCerrado?.cuenta)
    await explicar('reporte CERRADO · agregada por persona, página 1', sqlCerrado?.pagina)
    await explicar('reporte CERRADO · página avanzada (OFFSET 150 LIMIT 50)', (await reporteDe(AVANZADA))?.pagina)
    const ana = clasesA(N, (g, dia) => g % 2 === 0 && activoEnAgosto(dia))
    const recibo1 = await medirTiempo(`recibo de Ana, página 1 de ${ana.n} renglones`, () =>
      reciboDePersona({ userId: m.owner, venueId: m.venueId, staffId: m.ana, fecha: '2026-08-15', limit: 100 }),
    )
    expect(recibo1.renglones).toHaveLength(100)
    expect(recibo1.siguiente).not.toBeNull()
    expect(recibo1).toMatchObject({ cantidad: ana.n, total: pesos(ana.total) })
    // Codex R3-R1-12: la página AVANZADA del recibo por cursor (1,000 renglones antes del final), con su tiempo y su plan.
    // El cursor lleva la llave de SU recibo (`C.<llave>.<instante>|<id>`): se toma de la `siguiente` de la página 1.
    const llave = /^C\.([0-9a-f]{12})\./.exec(recibo1.siguiente!)![1]
    const [hondo] = await prisma.$queryRaw<Array<{ instante: Date; id: string }>>`
      SELECT COALESCE("occurredAt", "createdAt") AS instante, id FROM "ServiceEarning"
      WHERE "periodId" = ${r.periodId} AND "staffId" = ${m.ana}
      ORDER BY 1, 2 OFFSET ${ana.n - 1000} LIMIT 1`
    const cursorHondo = `C.${llave}.${hondo.instante.toISOString()}|${hondo.id}`
    const avanzada = await medirTiempo(`recibo de Ana, página avanzada por cursor (renglón ${ana.n - 999})`, () =>
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
    // Las diferencias del periodo cerrado (B1; medición de B5, Preflight-8), con la misma siembra.
    const difInput = { userId: m.owner, venueId: m.venueId, periodId: r.periodId }
    // (a) Sin ninguna diferencia (nada se ha corregido desde el cierre): la página recorre todas las clases y vuelve vacía. Las de
    // los días fuera (sin ancla) no son diferencias: siguen fuera de la participación.
    const sinDif = await medirTiempo('diferencias del periodo (página SIN ninguna diferencia: recorre todas)', () =>
      diferenciasDelPeriodo({ ...difInput, limit: 100 }),
    )
    expect(sinDif).toMatchObject({ items: [], nextCursor: null })
    // (b) 1,000 clases ancladas y no canceladas, corregidas de 8 a 9 después del cierre: 1,000 diferencias de +$40 (Ana
    // 570→610, coach 480→520; con bono de suplencia, 670→710 y 580→620).
    const corregidas = await prisma.$executeRaw`
      UPDATE "ClassSessionPayState" SET "payCountOverride" = 9
      WHERE "classSessionId" IN (
        SELECT ps."classSessionId" FROM "ClassSessionPayState" ps JOIN "ClassSession" cs ON cs.id = ps."classSessionId"
        WHERE ps."originPeriodId" = ${r.periodId} AND cs.status <> 'CANCELLED'
        ORDER BY ps."classSessionId" LIMIT 1000)`
    expect(corregidas).toBe(1000)
    const dif = await medirTiempo('diferencias del periodo (página 1 de 1,000 clases con diferencia)', () =>
      diferenciasDelPeriodo({ ...difInput, limit: 100 }),
    )
    expect(dif.items).toHaveLength(100)
    expect(dif.items.every(i => i.pendiente === '40.00')).toBe(true)
    expect(dif.nextCursor).not.toBeNull()
    // (c) El tope de la página (100) se respeta aunque se pida más: nada viaja entero.
    const pedidoGrande = await medirTiempo('diferencias del periodo (limit 10,000 → tapa de 100)', () =>
      diferenciasDelPeriodo({ ...difInput, limit: 10_000 }),
    )
    expect(pedidoGrande.items).toHaveLength(100)
    // El plan REAL de un lote, tal como lo arma el service: ids candidatos (anclas ∪ sin ancla), los «sin ancla» y la valoración envuelta.
    const idsDif = (await prisma.$queryRaw<Array<{ id: string }>>(idsCandidatas(fp, null, 500, null))).map(x => x.id)
    await explicar('diferencias · ids candidatos del lote (anclas ∪ sin ancla)', idsCandidatas(fp, null, 500, null))
    await explicar('diferencias · clases sin ancla de la sede (una vez por página)', idsSinAncla(fp, null, 5000))
    await explicar('diferencias · valoración envuelta de un lote de 500 ids', diferenciasSql({ ...fp, claseIds: idsDif }, null, true))
    console.log(
      `── carga de la Mac al terminar: ${loadavg()
        .map(x => x.toFixed(1))
        .join(' / ')}`,
    )

    // Al final y no justo tras el cierre: si el cierre rebasa el presupuesto, que las demás mediciones sí queden impresas.
    expect(ms).toBeLessThan(TIMEOUT_CIERRE_MS / 2)
    expect(ms + TOPE_ESPERA_MAX_MS).toBeLessThan(TIMEOUT_CIERRE_MS)
    for (const x of [vpActivar, vpDesactivar, sedes, abierto, recibo, pendientes]) expect(x.ms).toBeLessThan(TOPE_FOTO_MS)
    expect(preview.ms).toBeLessThan(TIMEOUT_CIERRE_MS)
  })
})
