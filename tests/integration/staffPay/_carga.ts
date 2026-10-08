// tests/integration/staffPay/_carga.ts — lo que la prueba de carga (`cierre.carga.test.ts`) necesita además del mundo desde la
// fase 3 B14 (diseño r5.7): las 4 ventanas alternadas por sede, la tabla con las dos reglas de clase, el ESPEJO en JS de lo que se
// siembra (para afirmar montos sin leerlos de la base), la organización de muchas sedes en dos zonas, las devoluciones pendientes y
// la medición de RESPUESTAS completas con el EXPLAIN de su consulta más cara. Sólo la usa la prueba de carga (MEDIR_CIERRE=1).
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import * as foto from '@/services/dashboard/staffPay/foto'
import * as reintento from '@/utils/serializableRetry'
import { fechaComoDbDate } from '@/services/dashboard/staffPay/periodos'
import { crearMundo, crearSede, Mundo, PN_C, PN_HC, tablaMindform } from './_mundo'

// ── Ventanas (r5.7: 4 por sede, activa / fuera / activa / fuera) ──

/** Las tres primeras ventanas de TODA sede, cerradas. La cuarta (`W4`) va abierta, cerrada el 30-ago o (todavía) sin crear. */
export const VENTANAS = [
  { desde: '2026-07-01', hasta: '2026-08-07' },
  { desde: '2026-08-11', hasta: '2026-08-17' },
  { desde: '2026-08-20', hasta: '2026-08-24' },
]
export const W4 = { desde: '2026-08-27', cierra: '2026-08-30' }
/** Los días de agosto con datos (1-30) que ninguna ventana cubre (con o sin W4: los dos cubren del 27 al 30). */
export const FUERA_AGOSTO = new Set([8, 9, 10, 18, 19, 25, 26])
export const activoEnAgosto = (dia: number) => !FUERA_AGOSTO.has(dia)
export type CuartaVentana = 'abierta' | 'cerrada' | 'sin'

/** Las ventanas de varias sedes en UNA escritura; `soloW4` crea sólo la cuarta (la sede pesada la recibe a media prueba). */
export async function ventanasAlternadas(m: Mundo, sedes: Array<{ venueId: string; w4: CuartaVentana }>, o: { soloW4?: boolean } = {}) {
  const filas = sedes.flatMap(s => [
    ...(o.soloW4 ? [] : VENTANAS.map(v => ({ venueId: s.venueId, desde: v.desde, hasta: v.hasta as string | null }))),
    ...(s.w4 === 'sin' ? [] : [{ venueId: s.venueId, desde: W4.desde, hasta: s.w4 === 'cerrada' ? W4.cierra : null }]),
  ])
  await prisma.staffPayVenueWindow.createMany({
    data: filas.map(f => ({
      organizationId: m.orgId,
      venueId: f.venueId,
      desde: fechaComoDbDate(f.desde),
      hasta: f.hasta ? fechaComoDbDate(f.hasta) : null,
      activadaPor: m.owner,
      desactivadaPor: f.hasta ? m.owner : null,
    })),
  })
}

// ── La tabla con las dos reglas de clase (Codex del Bloque D, DUDOSO: medir la valoración con D activo) ──

/** Sueldo base (celda de 0 lugares) y bono: la tabla de Prado Norte con una celda de 0 que no es $0, para que se vea el pago. */
export const BASE_HC = 250
export const BASE_C = 200
export const BONO = 100
export const REGLAS = { coverBonusHours: 24, coverBonusAmount: new Prisma.Decimal(BONO), lateCancelHours: 12 }

export async function tablaConReglas(m: Mundo, venueId = m.venueId) {
  const t = await prisma.servicePayTable.create({ data: { venueId, name: 'Todas las clases (con reglas)', productIds: [] } })
  const v = await prisma.servicePayTableVersion.create({
    data: { tableId: t.id, effectiveFrom: fechaComoDbDate('2026-01-01'), revision: 1, maxCount: 10, ...REGLAS },
  })
  const celdas = (montos: number[], base: number, payLevelId: string) =>
    montos.map((a, count) => ({ versionId: v.id, payLevelId, count, amount: new Prisma.Decimal(count === 0 ? base : a) }))
  await prisma.servicePayTableCell.createMany({ data: [...celdas(PN_HC, BASE_HC, m.hc), ...celdas(PN_C, BASE_C, m.coach)] })
}

// ── La sede pesada (organización A): qué es cada clase y cada venta `g` (las MISMAS reglas que la siembra en SQL) ──

export type TipoDeClase = 'NORMAL' | 'CANCELADA_TARDE' | 'CANCELADA_A_TIEMPO' | 'SUPLENCIA_TARDE' | 'SUPLENCIA_A_TIEMPO'
/** Por `g % 50` (pares = Ana, Head Coach; impares = una de las 200, Coach): de cada tipo hay de los dos niveles. */
const RESTOS: Array<[TipoDeClase, number[], string]> = [
  ['CANCELADA_TARDE', [7, 8], `"startsAt" - INTERVAL '2 hours'`],
  ['CANCELADA_A_TIEMPO', [17, 18], `"startsAt" - INTERVAL '72 hours'`],
  ['SUPLENCIA_TARDE', [3, 4], `"startsAt" - INTERVAL '3 hours'`],
  ['SUPLENCIA_A_TIEMPO', [13, 14], `"startsAt" - INTERVAL '48 hours'`],
]
export const tipoDeClase = (g: number): TipoDeClase => RESTOS.find(([, r]) => r.includes(g % 50))?.[0] ?? 'NORMAL'
/** El día de agosto (1-30) de la clase o la venta `g` (siembra: `inicio + (g % 30) días`). */
export const diaDe = (g: number) => 1 + (g % 30)
/** Lo que paga la clase `g` si participa (null: cancelada a tiempo, no se paga). */
export function montoClaseA(g: number): number | null {
  const tipo = tipoDeClase(g)
  const ana = g % 2 === 0
  if (tipo === 'CANCELADA_A_TIEMPO') return null
  if (tipo === 'CANCELADA_TARDE') return ana ? BASE_HC : BASE_C
  return (ana ? PN_HC[8] : PN_C[8]) + (tipo === 'SUPLENCIA_TARDE' ? BONO : 0)
}

/**
 * Las estampas de la fase 3 sobre las clases `prefijo<g>` ya sembradas (todas SCHEDULED, sin estampas): canceladas tarde (dentro de
 * las 12 h) y a tiempo (72 h), y suplencias avisadas tarde (3 h, bono) y a tiempo (48 h). La original de una suplencia es otra persona.
 */
export async function estamparClases(prefijo: string, n: number, ana: string, otra: string) {
  for (const [tipo, restos, cuando] of RESTOS) {
    const cancelada = tipo.startsWith('CANCELADA')
    await prisma.$executeRaw`
      UPDATE "ClassSession" cs SET
        status = ${Prisma.raw(cancelada ? `'CANCELLED'` : `cs.status`)},
        "cancelledAt" = ${Prisma.raw(cancelada ? `cs.${cuando}` : 'NULL')},
        "originalStaffId" = ${cancelada ? null : Prisma.sql`CASE WHEN cs."assignedStaffId" = ${ana} THEN ${otra} ELSE ${ana} END`},
        "staffAssignedAt" = ${Prisma.raw(cancelada ? 'NULL' : `cs.${cuando}`)}
      FROM generate_series(1, ${n}) g
      WHERE cs.id = ${prefijo}::text || g AND g % 50 = ANY(${restos}::int[])`
  }
}

export type Suma = { n: number; total: number }
const sumar = (gs: Iterable<number>, monto: (g: number) => number | null): Suma => {
  let n = 0
  let total = 0
  for (const g of gs) {
    const x = monto(g)
    if (x === null) continue
    n++
    total += x
  }
  return { n, total }
}
const rango = (n: number) => Array.from({ length: n }, (_, i) => i + 1)
/** Las clases pagables de agosto (monto no nulo) de la sede pesada con `cond(g, dia)`. */
export const clasesA = (n: number, cond: (g: number, dia: number) => boolean): Suma =>
  sumar(
    rango(n).filter(g => cond(g, diaDe(g))),
    montoClaseA,
  )
/** Las ventas de agosto (comisión $9 + propina $15 cada una) con `cond(g, dia)`. */
export const ventasA = (n: number, cond: (g: number, dia: number) => boolean): number => rango(n).filter(g => cond(g, diaDe(g))).length

// ── Las devoluciones pendientes (r6.2): reembolsos con reverso de comisión de ventas ya congeladas o por congelar ──

/** 30 reembolsos (`<prefijo>rpay<k>` y su reverso `<prefijo>rcom<k>`) de las ventas `<prefijo>pay<100·k>`, el 1-sep. */
export const REEMBOLSOS = 30
/** g = 100·k: k par ⇒ la persona de `g % 200 = 0` (el vendedor medido); k impar ⇒ la de `g % 200 = 100`. Sus días: 1, 11 y 21. */
export const gDelReembolso = (k: number) => 100 * k
export async function sembrarReembolsos(prefijo: string, inicio: string) {
  await prisma.$executeRaw`
    INSERT INTO "Payment" (id, "venueId", "orderId", amount, "tipAmount", method, status, type, "feePercentage", "feeAmount",
                           "netAmount", "processorData", "createdAt", "updatedAt")
    SELECT ${prefijo}::text || 'rpay' || k, p."venueId", p."orderId", -300, -15, 'CASH', 'COMPLETED', 'REFUND', 0, 0, -315,
           jsonb_build_object('originalPaymentId', p.id), ${inicio}::timestamp + k * INTERVAL '1 minute', NOW()
    FROM generate_series(1, ${REEMBOLSOS}) k JOIN "Payment" p ON p.id = ${prefijo}::text || 'pay' || (100 * k)`
  await prisma.$executeRaw`
    INSERT INTO "CommissionCalculation" (id, "venueId", "staffId", "configId", "paymentId", "orderId", "baseAmount",
                                         "effectiveRate", "grossCommission", "netCommission", "calcType", status,
                                         "calculatedAt", "createdAt")
    SELECT ${prefijo}::text || 'rcom' || k, cc."venueId", cc."staffId", cc."configId", rf.id, cc."orderId", -300, 0.03, -9, -9,
           'PERCENTAGE', 'CALCULATED', rf."createdAt" + INTERVAL '5 seconds', NOW()
    FROM generate_series(1, ${REEMBOLSOS}) k
    JOIN "CommissionCalculation" cc ON cc.id = ${prefijo}::text || 'com' || (100 * k)
    JOIN "Payment" rf ON rf.id = ${prefijo}::text || 'rpay' || k`
}

// ── La organización de muchas sedes (B): GET /sedes con cientos de sedes y dos zonas (revisión de B13) ──

export const SEDES_B = 120
export const CLASES_B = 100
export const VENTAS_B = 100
/** Sede `i` (0 = la del mundo): impares en Tijuana; la cuarta ventana abierta en i % 4 ∈ {0, 1} y cerrada en {2, 3}. */
export const zonaDeB = (i: number) => (i % 2 ? 'America/Tijuana' : 'America/Mexico_City')
export const w4DeB = (i: number): CuartaVentana => (Math.floor(i / 2) % 2 ? 'cerrada' : 'abierta')
/** Clase o venta `g` (1-100) de una sede de B: `g % 3` = 0 Ana (Head Coach, $570 con 8 lugares); 1 Sofía, 2 Carla (Coach, $480). */
export const montoClaseB = (g: number) => (g % 3 === 0 ? PN_HC[8] : PN_C[8])
export const clasesB = (cond: (g: number, dia: number) => boolean): Suma =>
  sumar(
    rango(CLASES_B).filter(g => cond(g, diaDe(g))),
    montoClaseB,
  )
export const ventasB = (cond: (g: number, dia: number) => boolean): number => rango(VENTAS_B).filter(g => cond(g, diaDe(g))).length

/**
 * B: `SEDES_B` sedes (la mitad en Tijuana), cada una con su tabla de Prado Norte, sus 4 ventanas alternadas, 100 clases de
 * agosto con 8 reservas y 100 ventas (cobro con propina de $15 + comisión de $9) de Ana, Sofía y Carla. El dueño es OWNER en
 * todas: los permisos de la pantalla de sedes son los REALES. Activada desde el 1-jul, propinas en el recibo.
 */
export async function crearMuchasSedes(): Promise<{ m: Mundo; sedes: string[] }> {
  const m = await crearMundo('cargasedes')
  const extra = []
  for (let i = 1; i < SEDES_B; i++) extra.push(await crearSede(m.orgId, m.key, `s${String(i).padStart(3, '0')}`))
  const sedes = [m.venueId, ...extra.map(x => x.venueId)]
  const productos = [m.productId, ...extra.map(x => x.productId)]
  await prisma.venue.updateMany({ where: { id: { in: sedes.filter((_, i) => i % 2) } }, data: { timezone: zonaDeB(1) } })
  await prisma.staffVenue.createMany({
    data: extra.map(x => ({ staffId: m.owner, venueId: x.venueId, role: 'OWNER' as const, active: true })),
  })
  for (const venueId of sedes) await tablaMindform(m, venueId)
  await prisma.organization.update({ where: { id: m.orgId }, data: { staffPayStartDate: fechaComoDbDate('2026-07-01') } })
  await prisma.staffPayTipWindow.create({
    data: { organizationId: m.orgId, startsAt: new Date('2026-07-01T06:00:00Z'), startedById: m.owner },
  })
  await ventanasAlternadas(
    m,
    sedes.map((venueId, i) => ({ venueId, w4: w4DeB(i) })),
  )
  const personas = [m.ana, m.sofia, m.carla]
  // Las ids llevan el índice de sede (1-based, como los arreglos de SQL): `cb007-042`, `bord007-042`, …
  await prisma.$executeRaw`
    INSERT INTO "ClassSession" (id, "venueId", "productId", "startsAt", "endsAt", duration, capacity, "assignedStaffId", status, "createdAt", "updatedAt")
    SELECT 'cb' || lpad(i::text, 3, '0') || '-' || lpad(g::text, 3, '0'), (${sedes}::text[])[i], (${productos}::text[])[i],
           '2026-08-01 12:00:00'::timestamp + (g % 30) * INTERVAL '1 day' + g * INTERVAL '1 minute',
           '2026-08-01 12:50:00'::timestamp + (g % 30) * INTERVAL '1 day' + g * INTERVAL '1 minute',
           50, 12, (${personas}::text[])[1 + g % 3], 'SCHEDULED', NOW(), NOW()
    FROM generate_series(1, ${sedes.length}) i CROSS JOIN generate_series(1, ${CLASES_B}) g`
  await prisma.$executeRaw`
    INSERT INTO "Reservation" (id, "venueId", "classSessionId", "productId", "confirmationCode", "cancelSecret", status, "startsAt", "endsAt", duration, "blockedEndsAt", "partySize", "confirmedAt", "createdAt", "updatedAt")
    SELECT cs.id || '-' || k, cs."venueId", cs.id, cs."productId", 'C' || cs.id || '-' || k, 's' || cs.id || '-' || k, 'CONFIRMED',
           cs."startsAt", cs."endsAt", 50, cs."endsAt", 1, cs."startsAt" - INTERVAL '1 day', NOW(), NOW()
    FROM "ClassSession" cs CROSS JOIN generate_series(1, 8) k WHERE cs."venueId" = ANY(${sedes}::text[])`
  const cfg = await prisma.commissionConfig.create({
    data: { venueId: m.venueId, orgId: m.orgId, name: 'Carga 3 %', defaultRate: 0.03, createdById: m.owner },
  })
  const id = (x: string) => Prisma.sql`${x}::text || lpad(i::text, 3, '0') || '-' || lpad(g::text, 3, '0')`
  await prisma.$executeRaw`
    INSERT INTO "Order" (id, "venueId", "orderNumber", subtotal, "taxAmount", total, "servedById", "createdAt", "updatedAt")
    SELECT ${id('bord')}, (${sedes}::text[])[i], ${id('B-CARGA-')}, 300, 0, 300, (${personas}::text[])[1 + g % 3],
           '2026-08-01 12:00:00'::timestamp + (g % 30) * INTERVAL '1 day' + g * INTERVAL '1 minute', NOW()
    FROM generate_series(1, ${sedes.length}) i CROSS JOIN generate_series(1, ${VENTAS_B}) g`
  await prisma.$executeRaw`
    INSERT INTO "Payment" (id, "venueId", "orderId", amount, "tipAmount", method, status, type, "feePercentage", "feeAmount",
                           "netAmount", "createdAt", "updatedAt")
    SELECT ${id('bpay')}, o."venueId", o.id, 300, 15, 'CASH', 'COMPLETED', 'REGULAR', 0, 0, 315, o."createdAt", NOW()
    FROM generate_series(1, ${sedes.length}) i CROSS JOIN generate_series(1, ${VENTAS_B}) g JOIN "Order" o ON o.id = ${id('bord')}`
  await prisma.$executeRaw`
    INSERT INTO "CommissionCalculation" (id, "venueId", "staffId", "configId", "paymentId", "orderId", "baseAmount",
                                         "effectiveRate", "grossCommission", "netCommission", "calcType", status,
                                         "calculatedAt", "createdAt")
    SELECT ${id('bcom')}, o."venueId", o."servedById", ${cfg.id}::text, ${id('bpay')}, o.id, 300, 0.03, 9, 9, 'PERCENTAGE', 'CALCULATED',
           o."createdAt" + INTERVAL '5 seconds', NOW()
    FROM generate_series(1, ${sedes.length}) i CROSS JOIN generate_series(1, ${VENTAS_B}) g JOIN "Order" o ON o.id = ${id('bord')}`
  return { m, sedes }
}

// ── El tamaño de las tablas de la participación (revisión de B11: `Seq Scan` de `Organization` y `StaffPayVenueWindow` dentro de
// la valoración, con tablas de prueba de unas cuantas filas) ──

/**
 * Otras `organizaciones` activadas, con `ventanasPorOrg` ventanas cada una (en sedes inventadas: la tabla no tiene FK a `Venue`),
 * para medir la valoración con las dos tablas del EXISTS del tamaño de una plataforma 10× más grande que hoy. Se borran con
 * `borrarRelleno`; las ids llevan la llave del mundo.
 */
export async function rellenarParticipacion(key: string, organizaciones: number, ventanasPorOrg: number) {
  await prisma.$executeRaw`
    INSERT INTO "Organization" (id, name, slug, email, phone, "staffPayStartDate", "updatedAt")
    SELECT ${key}::text || '-rel-' || g, ${key}::text || '-rel-' || g, ${key}::text || '-rel-' || g,
           ${key}::text || '-rel-' || g || '@example.test', '5500000000', DATE '2026-07-01', NOW()
    FROM generate_series(1, ${organizaciones}) g`
  await prisma.$executeRaw`
    INSERT INTO "StaffPayVenueWindow" (id, "organizationId", "venueId", desde, hasta, "activadaPor", "desactivadaPor", "updatedAt")
    SELECT o.id || '-w' || k, o.id, o.id || '-sede' || k, DATE '2026-07-01' + (k - 1) * 7,
           CASE WHEN k < ${ventanasPorOrg} THEN DATE '2026-07-01' + (k - 1) * 7 + 3 END, 'relleno',
           CASE WHEN k < ${ventanasPorOrg} THEN 'relleno' END, NOW()
    FROM "Organization" o CROSS JOIN generate_series(1, ${ventanasPorOrg}::int) k WHERE o.id LIKE ${key}::text || '-rel-%'`
}
export async function borrarRelleno(key: string) {
  await prisma.$executeRaw`DELETE FROM "StaffPayVenueWindow" WHERE "organizationId" LIKE ${key}::text || '-rel-%'`
  await prisma.$executeRaw`DELETE FROM "Organization" WHERE id LIKE ${key}::text || '-rel-%'`
}

// ── Medir una RESPUESTA completa: su tiempo, el de sus fotos y transacciones, y cada consulta cruda que corrió dentro ──

export interface Consulta {
  ms: number
  sql: Prisma.Sql
  /** La transacción (foto o escritura) en la que corrió, en orden de apertura. */
  tx: number
}
export interface Medida<T> {
  valor: T
  ms: number
  /** Duración de cada transacción (fotos de lectura y transacciones SERIALIZABLE) que abrió la respuesta. */
  txMs: number[]
  /** Lo que corrió con el cliente global ANTES de abrir la primera transacción (permisos, módulos); sin transacción, todo. */
  antesMs: number
  consultas: Consulta[]
}
const esPlantilla = (x: unknown): x is TemplateStringsArray => Array.isArray(x) && 'raw' in (x as object)

/**
 * Corre `fn` (una respuesta del servicio, tal como la llama la ruta) y mide, sin tocar `src`: cada `enUnaFoto` y cada
 * `withSerializableRetry` reciben un `tx` envuelto que cronometra sus `$queryRaw`. Lo que corre con el cliente global antes de la foto
 * (permisos, módulos) queda en `antesMs`. Las consultas de modelo (`tx.x.findMany`) no se cronometran: son búsquedas por llave.
 */
export async function medir<T>(fn: () => Promise<T>): Promise<Medida<T>> {
  const consultas: Consulta[] = []
  const txMs: number[] = []
  let primera: number | null = null
  let abiertas = 0
  const envolver = (tx: object, n: number) =>
    new Proxy(tx, {
      get(t, p) {
        const v = Reflect.get(t, p, t)
        if (typeof v !== 'function') return v
        if (p !== '$queryRaw') return v.bind(t)
        return async (...args: unknown[]) => {
          const sql = esPlantilla(args[0]) ? Prisma.sql(args[0], ...(args.slice(1) as any[])) : (args[0] as Prisma.Sql)
          const t0 = Date.now()
          const r = await v.apply(t, args)
          consultas.push({ ms: Date.now() - t0, sql, tx: n })
          return r
        }
      },
    })
  const conTx =
    <R>(f: (tx: any) => Promise<R>) =>
    async (tx: object) => {
      const n = ++abiertas
      const t0 = Date.now()
      primera ??= t0
      try {
        return await f(envolver(tx, n))
      } finally {
        txMs[n - 1] = Date.now() - t0
      }
    }
  const realFoto = foto.enUnaFoto
  const realRetry = reintento.withSerializableRetry
  const espiaFoto = jest.spyOn(foto, 'enUnaFoto').mockImplementation(((f: any, o: any) => realFoto(conTx(f), o)) as any)
  const espiaRetry = jest.spyOn(reintento, 'withSerializableRetry').mockImplementation(((f: any, o: any) => realRetry(conTx(f), o)) as any)
  const t0 = Date.now()
  try {
    const valor = await fn()
    const fin = Date.now()
    return { valor, ms: fin - t0, txMs, antesMs: (primera ?? fin) - t0, consultas }
  } finally {
    espiaFoto.mockRestore()
    espiaRetry.mockRestore()
  }
}

/** Una línea por respuesta (se busca con `MEDICIÓN` en la salida): total, transacciones, consultas y las tres más caras. */
export function resumen(nombre: string, m: Medida<unknown>, topeMs: number) {
  const caras = [...m.consultas].sort((a, b) => b.ms - a.ms).slice(0, 3)
  console.log(
    `MEDICIÓN ${nombre}: ${Math.round(m.ms)} ms (tope ${topeMs / 1000} s; ${Math.round((100 * m.ms) / topeMs)} %) · ` +
      `transacciones ${m.txMs.map(Math.round).join(' + ') || '—'} ms · antes de la primera ${Math.round(m.antesMs)} ms · ` +
      `${m.consultas.length} consultas crudas · las más caras ${caras.map(c => `${Math.round(c.ms)}`).join(' / ') || '—'} ms` +
      caras.map((c, i) => `\n   ${i + 1}. ${Math.round(c.ms)} ms · ${firma(c.sql)}`).join(''),
  )
}

/** Toda tabla grande que no debería recorrerse entera; y las dos chicas de la participación (revisión de B11). */
const GRANDES = /^Seq Scan on "?(Reservation|ClassSession|ClassSessionPayState|ServiceEarning|Payment|CommissionCalculation|Order)"?$/
const DE_LA_PARTICIPACION = /^Seq Scan on "?(StaffPayVenueWindow|Organization)"?$/

/** Lo que deja un EXPLAIN: su tiempo de ejecución y cada forma de leer una tabla que aparece en el plan. */
export type Plan = { ms: number; barridos: string[] }

/** Codex R3-R1-12: el plan REAL de una consulta tal como la arma el service (no una copia del SQL). */
export async function explicar(nombre: string, sql: Prisma.Sql | null | undefined): Promise<Plan> {
  if (!sql) throw new Error(`${nombre}: no hay consulta que medir`)
  const planDe = await prisma.$queryRaw<Array<{ 'QUERY PLAN': string }>>`EXPLAIN (ANALYZE, BUFFERS) ${sql}`
  const texto = planDe.map(x => x['QUERY PLAN']).join('\n')
  console.log(`── EXPLAIN ${nombre}\n${texto}`)
  const tiempo = Number(/Execution Time: ([\d.]+) ms/.exec(texto)?.[1] ?? NaN)
  const barridos = [
    ...new Set(
      [
        ...texto.matchAll(
          /(Seq Scan on "?\w+"?|Index (?:Only )?Scan(?: Backward)? using "?\w+"? on "?\w+"?|Bitmap Index Scan on "?\w+"?)/g,
        ),
      ].map(x => x[1]),
    ),
  ]
  const alerta = barridos.filter(b => GRANDES.test(b))
  const participacion = barridos.filter(b => DE_LA_PARTICIPACION.test(b))
  console.log(
    `RESUMEN ${nombre}: ${tiempo} ms · ${barridos.join(' | ')}` +
      (alerta.length
        ? `\n🔎 REVISAR ${nombre}: ${alerta.join(', ')} (un Seq Scan es lo correcto si el periodo es la mayor parte de la tabla)`
        : '') +
      (participacion.length ? `\n🪟 PARTICIPACIÓN ${nombre}: ${participacion.join(', ')}` : ''),
  )
  return { ms: tiempo, barridos }
}

/** Para reconocer una consulta en la salida: su principio y su final (el SELECT que la distingue), en una línea. */
export const firma = (sql: Prisma.Sql) => {
  const t = sql.sql.replace(/\s+/g, ' ').trim()
  return t.length <= 260 ? t : `${t.slice(0, 80)} … ${t.slice(-180)}`
}

/** El EXPLAIN de la consulta cruda más cara de una respuesta (la que más tardó DENTRO de ella). */
export async function explicarLaMasCara(nombre: string, m: Medida<unknown>): Promise<Plan | null> {
  const cara = [...m.consultas].sort((a, b) => b.ms - a.ms)[0]
  if (!cara) {
    console.log(`── ${nombre}: sin consultas crudas dentro de una foto`)
    return null
  }
  console.log(`FIRMA ${nombre} · la más cara: ${firma(cara.sql)}`)
  return explicar(`${nombre} · su consulta más cara (${Math.round(cara.ms)} ms dentro de la respuesta)`, cara.sql)
}
