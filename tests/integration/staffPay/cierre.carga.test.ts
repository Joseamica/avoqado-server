// tests/integration/staffPay/cierre.carga.test.ts — sólo con MEDIR_CIERRE=1 (siembra 50,000 clases + 20,000 de otros meses y,
// desde la fase 3, 50,000 ventas de agosto: cobro con propina + comisión; CON HISTORIAL, además julio cerrado con 50,000 ventas
// ya congeladas). Contra la base de la fase (`av-db-25-pago-f3`), NUNCA otra. Se corre así (una vez, con --runInBand):
//   MEDIR_CIERRE=1 TZ=UTC TEST_DATABASE_URL="$PAGO_F3_DB" \
//     npx jest --selectProjects integration --runTestsByPath tests/integration/staffPay/cierre.carga.test.ts --runInBand --ci
// EN FRÍO (el primer cierre de una organización: devengos y anclas vacíos y sin estadísticas): además MEDIR_EN_FRIO=1.
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { cerrarPeriodo, consultaIdsDelLote, previewCierre, TIMEOUT_CIERRE_MS } from '@/services/dashboard/staffPay/cierre.service'
import {
  AlcanceBarrido,
  comisionesBarribles,
  consultasDeVentas,
  LineaBarrible,
  propinasBarribles,
} from '@/services/dashboard/staffPay/fuentesVenta'
import { activarPagoAlPersonal, cambiarPropinas } from '@/services/dashboard/staffPay/activacion.service'
import { valoracionCte } from '@/services/dashboard/staffPay/valoracion'
import { fechaComoDbDate, venuePeriodRange } from '@/services/dashboard/staffPay/periodos'
import { consultasDelReporte, reportePeriodo } from '@/services/dashboard/staffPay/reporte.service'
import { consultaDePaginaDelRecibo, reciboDePersona } from '@/services/dashboard/staffPay/recibos.service'
import { diferenciasDelPeriodo, diferenciasSql, idsCandidatas, idsSinAncla } from '@/services/dashboard/staffPay/diferencias.service'
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
  // Activar y propinas (B2) lo piden ANTES de su transacción; la medición es la espera del candado, no el permiso.
  assertPermisoEnTodasLasSedes: jest.fn(async () => undefined),
}))

const N = 50_000
/** Clases de OTROS meses (julio y septiembre, misma sede): si el modo periodo recorriera la historia de la sede, se notaría. */
const OTROS_MESES = 10_000
/** Personas además de Ana (Codex R4-R1-12): el reporte tiene que tener páginas avanzadas que SÍ traigan filas. */
const OTRAS = 200
/** Spec fase 3 §6.5: comisiones y propinas de agosto, una de cada por venta, de las 200 personas (Ana conserva su recibo). */
const VENTAS = 50_000
const COMISION = 9
const PROPINA = 15
const describirSi = process.env.MEDIR_CIERRE === '1' ? describe : describe.skip
/** Sin historial de devengos ni anclas, y sin `ANALYZE` de esas tablas antes de cerrar: el primer cierre de todos (A13). */
const EN_FRIO = process.env.MEDIR_EN_FRIO === '1'
jest.setTimeout(30 * 60_000)

describirSi('cierre con 50,000 clases (spec §6.3 punto 3)', () => {
  let m: Mundo
  /** Las 200 personas además de Ana (ordenadas por correo): dan clases impares y hacen TODAS las ventas. */
  let otras: string[] = []
  let cfgId = ''

  /**
   * `VENTAS` ventas en `dias` días desde `inicio` (fase 3, B7), con ids `<prefijo>ord|pay|com<g>`: orden + cobro en efectivo
   * con propina de $15 + comisión de $9 de quien atendió (una de las 200, nunca Ana). En SQL por lotes, como las clases.
   */
  const sembrarVentas = async (prefijo: string, inicio: string, dias: number) => {
    await prisma.$executeRaw`
      INSERT INTO "Order" (id, "venueId", "orderNumber", subtotal, "taxAmount", total, "servedById", "createdAt", "updatedAt")
      SELECT ${prefijo}::text || 'ord' || g, ${m.venueId}::text, ${prefijo}::text || '-CARGA-' || g, 300, 0, 300,
             (${otras}::text[])[1 + (g % ${OTRAS})],
             ${inicio}::timestamp + (g % ${dias}) * INTERVAL '1 day' + (g % 600) * INTERVAL '1 minute', NOW()
      FROM generate_series(1, ${VENTAS}) g`
    await prisma.$executeRaw`
      INSERT INTO "Payment" (id, "venueId", "orderId", amount, "tipAmount", method, status, type, "feePercentage", "feeAmount",
                             "netAmount", "createdAt", "updatedAt")
      SELECT ${prefijo}::text || 'pay' || g, ${m.venueId}::text, o.id, 300, ${PROPINA}, 'CASH', 'COMPLETED', 'REGULAR', 0, 0,
             ${300 + PROPINA}, o."createdAt", NOW()
      FROM generate_series(1, ${VENTAS}) g JOIN "Order" o ON o.id = ${prefijo}::text || 'ord' || g`
    await prisma.$executeRaw`
      INSERT INTO "CommissionCalculation" (id, "venueId", "staffId", "configId", "paymentId", "orderId", "baseAmount",
                                           "effectiveRate", "grossCommission", "netCommission", "calcType", status,
                                           "calculatedAt", "createdAt")
      SELECT ${prefijo}::text || 'com' || g, ${m.venueId}::text, o."servedById", ${cfgId}::text, ${prefijo}::text || 'pay' || g,
             o.id, 300, 0.03, ${COMISION}, ${COMISION}, 'PERCENTAGE', 'CALCULATED', o."createdAt" + INTERVAL '5 seconds', NOW()
      FROM generate_series(1, ${VENTAS}) g JOIN "Order" o ON o.id = ${prefijo}::text || 'ord' || g`
  }
  const analizarVentas = async () => {
    for (const t of ['Order', 'Payment', 'CommissionCalculation']) await prisma.$executeRawUnsafe(`ANALYZE "${t}"`)
  }

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
    // Pendiente de la revisión de A12: clases de OTROS meses en la MISMA sede (uno anterior y uno posterior), todas de Ana.
    await sembrar('cjul', OTROS_MESES, '2026-07-01 12:00:00', 30, Prisma.sql`${m.ana}::text`)
    await sembrar('csep', OTROS_MESES, '2026-09-01 12:00:00', 20, Prisma.sql`${m.ana}::text`)
    // Fase 3 (B7): 50,000 ventas de agosto en la misma sede — orden + cobro con propina de $15 + comisión de $9 —, de las
    // 200 personas (Ana no vende: su recibo sigue siendo el de 25,000 clases). Activado desde el 1-jul, propinas en el recibo.
    const t1 = Date.now()
    cfgId = (
      await prisma.commissionConfig.create({
        data: { venueId: m.venueId, orgId: m.orgId, name: 'Carga 3 %', defaultRate: 0.03, createdById: m.owner },
      })
    ).id
    await sembrarVentas('v', '2026-08-01 12:00:00', 30)
    await prisma.organization.update({ where: { id: m.orgId }, data: { staffPayStartDate: fechaComoDbDate('2026-07-01') } })
    await prisma.staffPayTipWindow.create({
      data: { organizationId: m.orgId, startsAt: new Date('2026-07-01T06:00:00Z'), startedById: m.owner },
    })
    await analizarVentas()
    console.log(`siembra de ventas: ${VENTAS} cobros con propina + ${VENTAS} comisiones: ${Date.now() - t1} ms`)
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
    const alerta = barridos.filter(b =>
      /^Seq Scan on "?(Reservation|ClassSession|ClassSessionPayState|ServiceEarning|Payment|CommissionCalculation)"?$/.test(b),
    )
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
    // Fase 3 (revisiones de B3-B5): julio CERRADO con sus 50,000 ventas YA congeladas (comisión y propina de cada cobro).
    // `rangosBarribles` junta julio con agosto (cerrados contiguos): el cierre, el preview y la vista en vivo de agosto
    // recorren también lo cobrado en julio y lo descartan por el anti-join de lo congelado. Eso es lo que se mide aquí.
    const t = Date.now()
    await sembrarVentas('j', '2026-07-01 12:00:00', 30)
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
    await analizarVentas()
    console.log(`siembra del historial de ventas: julio cerrado con ${VENTAS} ventas congeladas: ${Date.now() - t} ms`)
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
    expect(abierto.tarjetas).toMatchObject({
      clases: N,
      comisiones: new Prisma.Decimal(COMISION).times(VENTAS).toFixed(2),
      propinas: new Prisma.Decimal(PROPINA).times(VENTAS).toFixed(2),
    })
    expect((await paginaAvanzada('reporte abierto (OFFSET 150)')).personas.items).toHaveLength(50)
    const sqlAbierto = await reporteDe(0)
    await explicar('reporte ABIERTO · COUNT(DISTINCT) de personas', sqlAbierto?.cuenta)
    await explicar('reporte ABIERTO · agregada por persona, página 1', sqlAbierto?.pagina)
    await explicar('reporte ABIERTO · página avanzada (OFFSET 150 LIMIT 50)', (await reporteDe(AVANZADA))?.pagina)

    // Revisiones de B3-B5: el recibo ABIERTO de alguien que VENDE. Sus propinas se filtran por persona DESPUÉS de calcular el
    // dueño de cada cobro de la sede (ningún índice lo sirve): se recorren los 50,000 cobros (y los de julio, con historial).
    // `otras[0]`: 125 clases impares de Coach ($480) + 250 ventas (g múltiplo de 200) de $9 + $15.
    const vendedor = otras[0]
    const reciboVendedor = await medir('recibo ABIERTO de un vendedor (página 1: 125 clases + 250 ventas)', () =>
      reciboDePersona({ userId: m.owner, venueId: m.venueId, staffId: vendedor, fecha: '2026-08-15', limit: 100 }),
    )
    expect(reciboVendedor).toMatchObject({
      total: new Prisma.Decimal(480 * (N / 2 / OTRAS)).plus((COMISION + PROPINA) * (VENTAS / OTRAS)).toFixed(2),
      totalesPorTipo: {
        CLASE: new Prisma.Decimal(480 * (N / 2 / OTRAS)).toFixed(2),
        COMISION: new Prisma.Decimal(COMISION * (VENTAS / OTRAS)).toFixed(2),
        PROPINA: new Prisma.Decimal(PROPINA * (VENTAS / OTRAS)).toFixed(2),
      },
    })
    expect(reciboVendedor.renglones).toHaveLength(100)
    await explicar(
      'recibo ABIERTO de un vendedor · página 1',
      await consultaDePaginaDelRecibo({ userId: m.owner, venueId: m.venueId, staffId: vendedor, fecha: '2026-08-15', limit: 100 }),
    )

    const p = await medir('previewCierre (recorre las 50,000 clases y las 100,000 ventas sin escribir)', () =>
      previewCierre({ userId: m.owner, venueId: m.venueId, fecha: '2026-08-15', ahora }),
    )
    expect(p).toMatchObject({ comisiones: VENTAS, propinas: VENTAS, reversos: 0, propinasSinDueno: { n: 0, total: '0.00' } })
    // El plan REAL del primer lote de cada fuente de ventas, tal como lo pide el cierre (B3).
    const alcanceVentas: AlcanceBarrido = {
      organizationId: m.orgId,
      periodo: { id: null, start: '2026-08-01', end: '2026-08-31' },
      sedes: [{ venueId: m.venueId, tz: TZ }],
      startDate: '2026-07-01',
    }
    const ventas = await consultasDeVentas(prisma, alcanceVentas)
    await explicar('ventas · ids del primer lote de comisiones', ventas.comisiones)
    await explicar('ventas · ids del primer lote de propinas', ventas.propinas)
    await explicar('ventas · reversos por anulación (primer lote)', ventas.reversos)
    // ¿El costo de un lote crece con el cursor, o cada lote recorre el rango entero? El mismo recorrido por lotes que hace
    // el cierre, por fuente, con el tiempo de cada lote (el primero, cada 20 y el último) y el total de la fuente.
    const recorrerFuente = async (
      nombre: string,
      leer: (db: typeof prisma, a: AlcanceBarrido, o: { despuesDe?: string; limite: number }) => Promise<LineaBarrible[]>,
    ) => {
      const t = Date.now()
      let despuesDe: string | undefined
      let n = 0
      let lineas = 0
      for (;;) {
        const tl = Date.now()
        const lote = await leer(prisma, alcanceVentas, { despuesDe, limite: 500 })
        if (!lote.length) break
        n++
        lineas += lote.length
        if (n === 1 || n % 20 === 0 || lote.length < 500) console.log(`${nombre} · lote ${n}: ${Date.now() - tl} ms`)
        despuesDe = lote[lote.length - 1].sourceId
      }
      console.log(`${nombre} · ${n} lotes, ${lineas} líneas: ${Date.now() - t} ms`)
      return lineas
    }
    expect(await recorrerFuente('recorrido de comisiones', comisionesBarribles)).toBe(VENTAS)
    expect(await recorrerFuente('recorrido de propinas', propinasBarribles)).toBe(VENTAS)

    // Revisión de B4: activar y cambiar las propinas usan el timeout POR DEFECTO de la transacción interactiva (10 s) y su
    // primera sentencia espera el candado de la organización que el cierre retiene todo el tiempo. Se lanzan las dos —en su
    // forma que no cambia nada: ya activado, ya encendidas— en cuanto el cierre termina su primer lote (ya tiene el candado).
    // Sólo se mide y se imprime: si truenan (P2028) no es esta prueba la que decide qué hacer.
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
      })
    } finally {
      clearInterval(muestreo)
    }
    const ms = Date.now() - t0
    console.log(
      `cierre de ${N} clases + ${VENTAS} comisiones + ${VENTAS} propinas: ${ms} ms · heap +${Math.round((process.memoryUsage().heapUsed - memAntes) / 1e6)} MB al terminar · pico +${Math.round((heapMax - memAntes) / 1e6)} MB · total $${r.total}`,
    )
    for (const linea of await Promise.all(cortas)) console.log(`OPERACIÓN CORTA · ${linea}`)
    expect(cortas).toHaveLength(2)
    expect(r.total).toBe(
      new Prisma.Decimal(570)
        .plus(480)
        .times(N / 2)
        .plus(new Prisma.Decimal(COMISION + PROPINA).times(VENTAS))
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
    expect(cerrado.tarjetas).toMatchObject({
      clases: N,
      comisiones: new Prisma.Decimal(COMISION).times(VENTAS).toFixed(2),
      propinas: new Prisma.Decimal(PROPINA).times(VENTAS).toFixed(2),
    })
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
    // Las diferencias del periodo cerrado (B1; medición de B5, Preflight-8), con la misma siembra.
    const difInput = { userId: m.owner, venueId: m.venueId, periodId: r.periodId }
    // (a) Sin ninguna diferencia (nada se ha corregido desde el cierre): la página recorre las 50,000 clases y vuelve vacía.
    const sinDif = await medir('diferencias del periodo (página SIN ninguna diferencia: recorre las 50,000)', () =>
      diferenciasDelPeriodo({ ...difInput, limit: 100 }),
    )
    expect(sinDif).toMatchObject({ items: [], nextCursor: null })
    // (b) 1,000 clases corregidas de 8 a 9 después del cierre: 1,000 diferencias de +$40 (Ana 570→610, coach 480→520).
    const corregidas = await prisma.$executeRaw`
      UPDATE "ClassSessionPayState" SET "payCountOverride" = 9
      WHERE "classSessionId" IN (SELECT 'carga' || g FROM generate_series(1, 1000) g)`
    expect(corregidas).toBe(1000) // las 1,000 clases están ancladas por el cierre: ninguna se saltó
    const dif = await medir('diferencias del periodo (página 1 de 1,000 clases con diferencia)', () =>
      diferenciasDelPeriodo({ ...difInput, limit: 100 }),
    )
    expect(dif.items).toHaveLength(100)
    expect(dif.items.every(i => i.pendiente === '40.00')).toBe(true)
    expect(dif.nextCursor).not.toBeNull()
    // (c) El tope de la página (100) se respeta aunque se pida más: nada viaja entero.
    const pedidoGrande = await medir('diferencias del periodo (limit 10,000 → tapa de 100)', () =>
      diferenciasDelPeriodo({ ...difInput, limit: 10_000 }),
    )
    expect(pedidoGrande.items).toHaveLength(100)
    // El plan REAL de un lote, tal como lo arma el service: ids candidatos (anclas ∪ sin ancla), los «sin ancla» y la valoración envuelta.
    const idsDif = (await prisma.$queryRaw<Array<{ id: string }>>(idsCandidatas(fp, null, 500, null))).map(x => x.id)
    await explicar('diferencias · ids candidatos del lote (anclas ∪ sin ancla)', idsCandidatas(fp, null, 500, null))
    await explicar('diferencias · clases sin ancla de la sede (una vez por página)', idsSinAncla(fp, null, 5000))
    await explicar('diferencias · valoración envuelta de un lote de 500 ids', diferenciasSql({ ...fp, claseIds: idsDif }, null, true))

    // Al final y no justo tras el cierre: si el cierre rebasa el presupuesto, que las demás mediciones sí queden impresas.
    expect(ms).toBeLessThan(TIMEOUT_CIERRE_MS / 2)
  })
})
