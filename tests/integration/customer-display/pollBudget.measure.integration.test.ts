// tests/integration/customer-display/pollBudget.measure.integration.test.ts
import os from 'os'
import { monitorEventLoopDelay } from 'perf_hooks'
import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'
import { Prisma } from '@prisma/client'

/**
 * La medición del poll (spec §5.7.4, Task 13): FIJA lo que el spec promete contar —falla si alguien lo rompe— e IMPRIME lo
 * que sólo se puede observar (planes, latencias, la sonda de cobro, las huellas omitidas y el costo de `/settings` y de
 * `/promotions`). Las cuentas de sentencias y los planes son deterministas; las latencias dependen de la carga de la máquina
 * y se imprimen junto con `os.loadavg()`, sin afirmar umbrales.
 */

// 🔴 El MISMO cliente que el singleton (receta de `src/utils/prismaClient.ts`), más el evento `query`. Si esa receta cambia,
// se cambia aquí: medir con otro pool no mide nada.
jest.mock('@/utils/prismaClient', () => {
  const { PrismaClient } = jest.requireActual('@prisma/client')
  const { extensionResultadoGigante } = jest.requireActual('@/utils/queryResultGuard')
  const { extensionCancellableReads, extensionCancellableTransactions } = jest.requireActual('@/utils/requestCancellation')
  const base = process.env.DATABASE_URL as string
  const url = /[?&]connection_limit=/.test(base)
    ? base
    : `${base}${base.includes('?') ? '&' : '?'}connection_limit=${process.env.DATABASE_CONNECTION_LIMIT || '18'}`
  const cliente = new PrismaClient({
    datasources: { db: { url } },
    omit: { product: { createdById: true }, venue: { catalogGovernanceEnforcedAt: true } },
    log: [{ emit: 'event', level: 'query' }],
  })
  const sentencias: Array<{ query: string; params: string; duration: number; timestamp: Date }> = []
  cliente.$on('query', (e: { query: string; params: string; duration: number; timestamp: Date }) => sentencias.push(e))
  const extendido = cliente
    .$extends(extensionResultadoGigante)
    .$extends(extensionCancellableReads)
    .$extends(extensionCancellableTransactions)
  return { __esModule: true, default: extendido, sentencias, urlDeMedicion: url }
})
// Sin `Authorization`: el CUERPO del poll, aislado. Con `Authorization`: la cadena REAL de sesión y membresía.
jest.mock('@/middlewares/authenticateToken.middleware', () => {
  const real = jest.requireActual('@/middlewares/authenticateToken.middleware')
  return {
    ...real,
    authenticateTokenMiddleware: (req: Request, res: Response, next: NextFunction) => {
      if (req.headers.authorization) return real.authenticateTokenMiddleware(req, res, next)
      ;(req as any).authContext = { userId: 'medicion', venueId: req.params.venueId }
      next()
    },
  }
})
jest.mock('@/middlewares/validateVenueAccess.middleware', () => {
  const real = jest.requireActual('@/middlewares/validateVenueAccess.middleware')
  return {
    ...real,
    requireVenueMembership: (req: Request, res: Response, next: NextFunction) =>
      req.headers.authorization ? real.requireVenueMembership(req, res, next) : next(),
  }
})

import prisma from '@/utils/prismaClient'
import mobileRoutes from '@/routes/mobile.routes'
import { generateAccessToken } from '@/jwt.service'
import { invalidateCustomerDisplayCache } from '@/services/customer-display/customerDisplayDesign.service'
import { CACHE_MAX_ENTRIES, cache as cacheDeFichas } from '@/services/customer-display/customerDisplayCache'
import { readVenuePlanSnapshot, resetVenuePlanSnapshotsForTests } from '@/services/customer-display/venuePlanSnapshot'
import { buildPromotionCarousel, refreshCarousel, resetCarouselCacheForTests } from '@/services/customer-display/promotionCarousel.service'
import { listPromotionsForPos } from '@/services/promotions/promotionCatalog.service'
import { venueSignaturesSql } from '@/services/customer-display/venueSignatures'
import { POLL_WORK_MAX_IN_FLIGHT, REFRESH_COALESCE_MS, pollWorkLimiter } from '@/services/customer-display/pollWork'

type Sentencia = { query: string; params: string; duration: number; timestamp: Date }
const { sentencias, urlDeMedicion } = jest.requireMock('@/utils/prismaClient') as { sentencias: Sentencia[]; urlDeMedicion: string }
const suffix = `med-${Date.now()}`
const DISPOSITIVOS = 50
const RONDAS = 10
const VENUES_FRIOS = 6
const TABLETS_POR_VENUE_FRIO = 4
const OPCIONES_DE_LA_PROMO_GRANDE = 120 // > MAX_OPCIONES + 1 (51): mide si el `take` anidado llega a la base
/** Otro negocio en las mismas tablas: sin él el venue medido sería dueño de TODA la tabla y el plan no representaría a producción. */
const PRODUCTOS_DE_OTRO_NEGOCIO = 20_000
const PROMOS_DE_OTRO_NEGOCIO = 1_000
let orgId: string
let venueId: string
let staffId: string
let sesionId: string
let ruidoId: string
const frios: Array<{ id: string; tablets: string[] }> = []

const app = express()
app.use(express.json())
app.use('/api/v1/mobile', mobileRoutes)
// Sin X-Device-Platform: el registro pasivo de aparatos no corre y no ensucia la cuenta.
const pollDe = (venue: string, deviceUid: string) =>
  request(app).get(`/api/v1/mobile/venues/${venue}/display-mode-request`).set('x-device-id', deviceUid)
const poll = (i: number) => pollDe(venueId, `dev-${suffix}-${i}`)
const promotionsDe = (deviceUid?: string) => {
  const r = request(app).get(`/api/v1/mobile/venues/${venueId}/promotions`)
  return deviceUid ? r.set('x-device-id', deviceUid) : r
}
const settingsDe = (deviceUid?: string) => {
  const r = request(app).get(`/api/v1/mobile/venues/${venueId}/settings`)
  return deviceUid ? r.set('x-device-id', deviceUid) : r
}
const esperar = (ms: number) => new Promise(res => setTimeout(res, ms))
const carga = () =>
  `loadavg ${os
    .loadavg()
    .map(x => x.toFixed(1))
    .join(' / ')} (1/5/15 min)`
const imprimir = (titulo: string, cuerpo: unknown) =>
  process.stdout.write(`\n=== ${titulo} ===\n${typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo, null, 2)}\n`)
const percentiles = (xs: number[]) => {
  const o = [...xs].sort((a, b) => a - b)
  const p = (q: number) => (o.length ? o[Math.min(o.length - 1, Math.floor(q * o.length))].toFixed(1) : 'sin datos')
  return { muestras: o.length, p50: p(0.5), p95: p(0.95), max: p(1) }
}
const omitidas = (respuestas: Array<{ body: any }>) => {
  const faltan = { customerDisplay: 0, settings: 0, promotions: 0 }
  for (const r of respuestas)
    for (const k of Object.keys(faltan) as Array<keyof typeof faltan>) if (!(k in (r.body?.data?.fingerprints ?? {}))) faltan[k] += 1
  return faltan
}
/** La tabla principal de cada sentencia (la de firmas es UNA sentencia cruda con subconsultas: se nombra aparte). */
const tablaDe = (sql: string) =>
  sql.includes('AS venue_at')
    ? 'firmas (cruda)'
    : (sql.match(/\b(?:FROM|UPDATE|INTO)\s+(?:"public"\.)?"(\w+)"/)?.[1] ?? sql.trim().replace(/\s+/g, ' ').slice(0, 40))
const porTabla = (xs: Sentencia[]) =>
  xs.reduce<Record<string, number>>((acc, s) => {
    const t = tablaDe(s.query)
    acc[t] = (acc[t] ?? 0) + 1
    return acc
  }, {})
/** Las dos consultas ligeras del carrusel, por su contenido (no por el orden en que terminan): las «por abrir» son las únicas
 * que ordenan las promociones por `validFrom`; las «vigentes», por `displayOrder` con tope (el catálogo de siempre no lo lleva). */
const esLigeraPorAbrir = (s: Sentencia) => /"Promotion"\."validFrom" ASC/.test(s.query) && s.query.includes('LIMIT')
const esLigeraVigentes = (s: Sentencia) =>
  /FROM "public"\."Promotion" WHERE/.test(s.query) && /"Promotion"\."displayOrder" ASC/.test(s.query) && s.query.includes('LIMIT')
/** Lo que pesa un trabajo para el proceso: tiempo de pared y CPU (incluye los hilos del motor de Prisma, que corren dentro). */
const medirCpu = async (trabajo: () => Promise<unknown>) => {
  const cpu0 = process.cpuUsage()
  const t0 = process.hrtime.bigint()
  await trabajo()
  const cpu = process.cpuUsage(cpu0)
  return { ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e6), cpuMs: Math.round((cpu.user + cpu.system) / 1e3) }
}
/** N peticiones que arrancan escalonadas `pasoMs` (como llegan en la calle), no todas en el mismo instante. */
const escalonadas = <T>(n: number, pasoMs: number, una: (i: number) => PromiseLike<T>) =>
  Promise.all(Array.from({ length: n }, async (_, i) => (await esperar(i * pasoMs), una(i))))
/**
 * Espera a que lo que arrancó un poll termine: el tope sin trabajos y ninguna sentencia nueva en `quieto` ms. Con la Mac
 * cargada un plazo fijo podía cortar la cuenta a la mitad; esto la deja determinista.
 */
const esperarQuietud = async (quieto = 500, maximo = 30_000) => {
  const hasta = Date.now() + maximo
  for (;;) {
    const n = sentencias.length
    await esperar(quieto)
    if ((sentencias.length === n && pollWorkLimiter.enVuelo === 0) || Date.now() > hasta) return
  }
}
/**
 * Corre `trabajo` mientras una sonda de cobro (`SELECT 1` por el MISMO pool, cada 5 ms) mide cuánto espera una consulta
 * cualquiera. La sonda vive en el mismo proceso: espera por el pool Y por el hilo. El retraso del hilo se mide aparte
 * (`monitorEventLoopDelay`) para saber cuál de los dos fue.
 */
const conSonda = async <T>(trabajo: () => Promise<T>) => {
  const sonda: number[] = []
  const errores: string[] = []
  const hilo = monitorEventLoopDelay({ resolution: 10 })
  hilo.enable()
  let corriendo = true
  const sondear = (async () => {
    while (corriendo) {
      const inicio = process.hrtime.bigint()
      try {
        await prisma.$queryRaw`SELECT 1` // lo que espera CUALQUIER consulta del proceso —un cobro— por una conexión
      } catch (error) {
        errores.push((error as { code?: string }).code ?? String(error)) // P2024 = el pool se agotó
      }
      sonda.push(Number(process.hrtime.bigint() - inicio) / 1e6)
      await esperar(5)
    }
  })()
  try {
    const resultado = await trabajo()
    return {
      resultado,
      sonda,
      errores,
      retrasoDelHiloMs: {
        p50: +(hilo.percentile(50) / 1e6).toFixed(1),
        p99: +(hilo.percentile(99) / 1e6).toFixed(1),
        max: +(hilo.max / 1e6).toFixed(1),
      },
    }
  } finally {
    corriendo = false
    hilo.disable()
    await sondear
  }
}
/** Las líneas de un `EXPLAIN` que importan para el reporte: los Seq Scan, las tablas tocadas y el tiempo de ejecución. */
const resumenDelPlan = (lineas: string[]) => ({
  seqScans: lineas.filter(l => l.includes('Seq Scan on')).map(l => l.trim().replace(/\s+\(cost.*$/, '')),
  indices: [...new Set(lineas.flatMap(l => [...l.matchAll(/using "?(\w+)"? on/gi)].map(m => m[1])))],
  ejecucion: lineas.find(l => l.startsWith('Execution Time'))?.trim(),
})
const explicar = async (sql: string, params: unknown[], forzarIndices = false): Promise<string[]> =>
  prisma.$transaction(async tx => {
    if (forzarIndices) await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off')
    const filas = await tx.$queryRawUnsafe<Array<Record<string, string>>>(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, ...params)
    return filas.map(f => Object.values(f)[0])
  })
/**
 * Los parámetros de una sentencia tal como los anunció el evento `query` (JSON). Una fecha llega como texto: se castea a
 * `timestamp` en el texto (las columnas son `timestamp without time zone` con UTC; la zona del texto se ignora, como al escribir).
 */
const sentenciaParaExplicar = (s: Sentencia): { sql: string; params: unknown[] } => {
  const params = JSON.parse(s.params) as unknown[]
  let sql = s.query
  params.forEach((p, i) => {
    if (typeof p === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(p))
      sql = sql.replace(new RegExp(`\\$${i + 1}(?!\\d)`, 'g'), `$${i + 1}::timestamp`)
  })
  return { sql, params }
}

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `Org ${suffix}`, email: `${suffix}@example.test`, phone: '0000000000' },
      select: { id: true },
    })
  ).id
  // Exento (heredado): pasa `checkFeatureAccess('PROMOTIONS')` de /promotions y los dos grants salen en `true`.
  venueId = (
    await prisma.venue.create({
      data: { organizationId: orgId, name: `V ${suffix}`, slug: `v-${suffix}`, timezone: 'America/Mexico_City', seatCapExempt: true },
      select: { id: true },
    })
  ).id
  await prisma.venueSettings.create({ data: { venueId } })
  const categoria = await prisma.menuCategory.create({ data: { venueId, name: 'Todo', slug: `todo-${suffix}` }, select: { id: true } })
  // 5,000 productos (ids de Prisma: se crean en bloque y se vuelven a leer)
  for (let i = 0; i < 5_000; i += 1_000) {
    await prisma.product.createMany({
      data: Array.from({ length: 1_000 }, (_, j) => ({
        venueId,
        categoryId: categoria.id,
        sku: `S${i + j}-${suffix}`,
        name: `Producto ${i + j}`,
        price: '50.00',
      })),
    })
  }
  const productos = await prisma.product.findMany({ where: { venueId }, select: { id: true }, orderBy: { id: 'asc' }, take: 5_000 })
  // 500 promociones publicadas: la mitad combos de 2 grupos × 2 opciones, la otra mitad descuentos; horarios variados
  await prisma.promotion.createMany({
    data: Array.from({ length: 500 }, (_, i) => ({
      venueId,
      name: `Promo ${i}`,
      type: (i % 2 ? 'COMBO' : 'DISCOUNT') as 'COMBO' | 'DISCOUNT',
      pricingMode: 'FIXED_TOTAL' as const,
      priceCents: 8_000,
      status: 'PUBLISHED' as const,
      displayOrder: i % 7,
      ...(i % 3 === 0 ? { timeFrom: '18:00', timeUntil: '22:00' } : {}),
    })),
  })
  const combos = await prisma.promotion.findMany({
    where: { venueId, type: 'COMBO' },
    select: { id: true },
    orderBy: { id: 'asc' },
    take: 500,
  })
  await prisma.promotionGroup.createMany({
    data: combos.flatMap(p => [0, 1].map(g => ({ promotionId: p.id, name: `G${g}`, displayOrder: g }))),
  })
  const grupos = await prisma.promotionGroup.findMany({
    where: { promotion: { venueId } },
    select: { id: true },
    orderBy: { id: 'asc' },
    take: 1_000,
  })
  await prisma.promotionOption.createMany({
    data: grupos.flatMap((g, i) => [0, 1].map(o => ({ groupId: g.id, productId: productos[(i * 2 + o) % productos.length].id }))),
  })
  // Una promoción GRANDE, primera en el carrusel: un grupo con 120 opciones. La lectura completa pide `take: 51` anidado; sin
  // `relationJoins` Prisma lo aplica en memoria (nota 4 de la revisión de la Task 6): aquí se ve cuántas filas trae la base.
  const grande = await prisma.promotion.create({
    data: {
      venueId,
      name: 'Promo grande',
      type: 'COMBO',
      pricingMode: 'FIXED_TOTAL',
      priceCents: 9_900,
      status: 'PUBLISHED',
      displayOrder: -1,
    },
    select: { id: true },
  })
  const grupoGrande = await prisma.promotionGroup.create({ data: { promotionId: grande.id, name: 'Elige' }, select: { id: true } })
  await prisma.promotionOption.createMany({
    data: productos.slice(4_000, 4_000 + OPCIONES_DE_LA_PROMO_GRANDE).map(p => ({ groupId: grupoGrande.id, productId: p.id })),
  })
  // 3 emisores
  for (let e = 0; e < 3; e++) {
    await prisma.fiscalEmisor.create({
      data: { venueId, rfc: `MED0101010${e}A`, legalName: `Emisor ${e}`, regimenFiscal: '601', lugarExpedicion: '06600' },
    })
  }
  // 50 tablets v2 y una sin versión
  await prisma.terminal.createMany({
    data: Array.from({ length: DISPOSITIVOS }, (_, i) => ({
      venueId,
      name: `Caja ${i}`,
      type: 'POS_ANDROID' as const,
      deviceUid: `dev-${suffix}-${i}`,
      customerDisplayDesignVersion: 2,
      customerDisplayInstallationId: `inst-${i}`,
    })),
  })
  await prisma.terminal.create({ data: { venueId, name: 'Vieja', type: 'POS_ANDROID', deviceUid: `dev-${suffix}-vieja` } })

  // La sesión REAL de un POS para el costo HTTP completo: persona activa, su sucursal y una sesión viva (token con `sid`).
  staffId = (
    await prisma.staff.create({
      data: { email: `staff-${suffix}@example.test`, firstName: 'Caja', lastName: 'Medición' },
      select: { id: true },
    })
  ).id
  await prisma.staffVenue.create({ data: { staffId, venueId, role: 'CASHIER' } })
  sesionId = (
    await prisma.session.create({ data: { staffId, venueId, deviceId: `dev-${suffix}-0`, authMethod: 'PIN' }, select: { id: true } })
  ).id

  // Los venues FRÍOS: 3 exentos (con carrusel de 20 promociones) y 3 en FREE (sin `PROMOTIONS`: la constante).
  for (let v = 0; v < VENUES_FRIOS; v++) {
    const exento = v < VENUES_FRIOS / 2
    const id = (
      await prisma.venue.create({
        data: {
          organizationId: orgId,
          name: `F${v} ${suffix}`,
          slug: `f${v}-${suffix}`,
          timezone: 'America/Mexico_City',
          seatCapExempt: exento,
        },
        select: { id: true },
      })
    ).id
    await prisma.venueSettings.create({ data: { venueId: id } })
    if (exento) {
      await prisma.promotion.createMany({
        data: Array.from({ length: 20 }, (_, i) => ({
          venueId: id,
          name: `P${i}`,
          type: 'DISCOUNT' as const,
          pricingMode: 'FIXED_TOTAL' as const,
          status: 'PUBLISHED' as const,
        })),
      })
    }
    const tablets = Array.from({ length: TABLETS_POR_VENUE_FRIO }, (_, i) => `frio-${v}-${i}-${suffix}`)
    await prisma.terminal.createMany({
      data: tablets.map((deviceUid, i) => ({
        venueId: id,
        name: `Caja ${i}`,
        type: 'POS_ANDROID' as const,
        deviceUid,
        customerDisplayDesignVersion: 2,
        customerDisplayInstallationId: `inst-${deviceUid}`,
      })),
    })
    frios.push({ id, tablets })
  }
  // OTRO negocio en las mismas tablas (20,000 productos, 1,000 combos con 4,000 opciones): con el venue medido como dueño
  // de casi toda la tabla, un Seq Scan es lo correcto y el plan no dice nada de producción.
  ruidoId = (
    await prisma.venue.create({
      data: { organizationId: orgId, name: `Ruido ${suffix}`, slug: `ruido-${suffix}`, timezone: 'America/Mexico_City' },
      select: { id: true },
    })
  ).id
  const categoriaRuido = await prisma.menuCategory.create({
    data: { venueId: ruidoId, name: 'Todo', slug: `todo-ruido-${suffix}` },
    select: { id: true },
  })
  for (let i = 0; i < PRODUCTOS_DE_OTRO_NEGOCIO; i += 5_000) {
    await prisma.product.createMany({
      data: Array.from({ length: 5_000 }, (_, j) => ({
        venueId: ruidoId,
        categoryId: categoriaRuido.id,
        sku: `R${i + j}-${suffix}`,
        name: `R ${i + j}`,
        price: '30.00',
      })),
    })
  }
  const productosRuido = await prisma.product.findMany({
    where: { venueId: ruidoId },
    select: { id: true },
    orderBy: { id: 'asc' },
    take: PRODUCTOS_DE_OTRO_NEGOCIO,
  })
  await prisma.promotion.createMany({
    data: Array.from({ length: PROMOS_DE_OTRO_NEGOCIO }, (_, i) => ({
      venueId: ruidoId,
      name: `R${i}`,
      type: 'COMBO' as const,
      pricingMode: 'FIXED_TOTAL' as const,
      status: 'PUBLISHED' as const,
    })),
  })
  const promosRuido = await prisma.promotion.findMany({
    where: { venueId: ruidoId },
    select: { id: true },
    orderBy: { id: 'asc' },
    take: PROMOS_DE_OTRO_NEGOCIO,
  })
  await prisma.promotionGroup.createMany({
    data: promosRuido.flatMap(p => [0, 1].map(g => ({ promotionId: p.id, name: `G${g}`, displayOrder: g }))),
  })
  const gruposRuido = await prisma.promotionGroup.findMany({
    where: { promotion: { venueId: ruidoId } },
    select: { id: true },
    orderBy: { id: 'asc' },
    take: PROMOS_DE_OTRO_NEGOCIO * 2,
  })
  await prisma.promotionOption.createMany({
    data: gruposRuido.flatMap((g, i) =>
      [0, 1].map(o => ({ groupId: g.id, productId: productosRuido[(i * 2 + o) % productosRuido.length].id })),
    ),
  })

  // Estadísticas frescas: sin esto el planificador decide con las de antes de insertar y el plan no representa nada.
  await prisma.$executeRawUnsafe(
    'ANALYZE "Promotion", "PromotionGroup", "PromotionOption", "Product", "Terminal", "FiscalEmisor", "MerchantFiscalConfig", "Venue", "VenueSettings"',
  )
}, 300_000)

afterAll(async () => {
  if (!venueId) return // sin esta guarda, un id undefined vaciaría tablas enteras (8-oct)
  const todos = [venueId, ...frios.map(f => f.id), ...(ruidoId ? [ruidoId] : [])]
  await prisma.promotion.deleteMany({ where: { venueId: { in: todos } } })
  await prisma.product.deleteMany({ where: { venueId: { in: todos } } })
  await prisma.menuCategory.deleteMany({ where: { venueId: { in: todos } } })
  await prisma.fiscalEmisor.deleteMany({ where: { venueId } })
  await prisma.terminal.deleteMany({ where: { venueId: { in: todos } } })
  if (staffId) await prisma.staff.deleteMany({ where: { id: staffId } }) // en cascada: su sucursal y su sesión
  await prisma.venue.deleteMany({ where: { id: { in: todos } } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
  await prisma.$disconnect()
}, 120_000)

const enFrio = async () => {
  resetVenuePlanSnapshotsForTests()
  resetCarouselCacheForTests()
  const ids = await prisma.terminal.findMany({
    where: { venueId: { in: [venueId, ...frios.map(f => f.id)] } },
    select: { id: true },
    take: 200,
  })
  for (const { id } of ids) invalidateCustomerDisplayCache(id)
}

it('🔴 el cliente de la medición usa el pool REAL (Codex r1 #11): la URL lleva el connection_limit y el pool no abre más', async () => {
  const limite = process.env.DATABASE_CONNECTION_LIMIT || '18'
  expect(new URL(urlDeMedicion).searchParams.get('connection_limit')).toBe(limite)
  // La URL sola no basta: un cliente armado sin ella usaría el default de Prisma (núcleos × 2 + 1 = 21 en esta Mac).
  // Tres oleadas de consultas lentas: el número de conexiones distintas que se ven es el tamaño REAL del pool.
  const pids = await Promise.all(
    Array.from(
      { length: Number(limite) * 3 },
      () => prisma.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid, pg_sleep(0.3)::text AS s`,
    ),
  )
  const conexiones = new Set(pids.map(([f]) => f.pid)).size
  imprimir('pool de la medición', { connection_limit: limite, conexionesDistintasVistas: conexiones })
  expect(conexiones).toBeLessThanOrEqual(Number(limite))
}, 60_000)

it('cuerpo del poll EN FRÍO: cuántas sentencias le cuesta el primer poll a un venue grande (se imprime el desglose)', async () => {
  await enFrio()
  sentencias.length = 0
  const r = await poll(0)
  expect(r.status).toBe(200)
  await esperarQuietud() // lo que no alcanzó el plazo termina para llenar su caché
  imprimir('cuerpo del poll EN FRÍO — sentencias', {
    total: sentencias.length,
    tope: POLL_WORK_MAX_IN_FLIGHT,
    porTabla: porTabla(sentencias),
    cada_una: sentencias.map(s => ({ ms: s.duration, sql: s.query.slice(0, 140) })),
  })
  imprimir('huellas entregadas en frío (las que faltan no alcanzaron los 150 ms)', { carga: carga(), ...r.body.data.fingerprints })

  // R3: cuántas de esas son del PLAN (se mide solo, en frío, con la misma lectura que usa el poll).
  resetVenuePlanSnapshotsForTests()
  sentencias.length = 0
  await readVenuePlanSnapshot(venueId)
  await esperarQuietud(300)
  imprimir('el PLAN en frío (lo que el poll paga una vez por venue cada 60 s)', {
    total: sentencias.length,
    porTabla: porTabla(sentencias),
  })
}, 120_000)

it('🔴 cuerpo del poll EN CALIENTE (sin sesión ni membresía): DOS sentencias, la terminal y la de firmas — spec §5.7.4', async () => {
  await poll(0) // calienta
  await esperarQuietud()
  sentencias.length = 0
  const r = await poll(0)
  // La ficha y las promociones salen de la caché; la de firmas corre SIEMPRE (con carga pudo no caber en 150 ms y
  // omitirse: se imprime, no se afirma). Se espera a que su evento llegue antes de contar.
  expect(r.body.data.fingerprints).toMatchObject({ customerDisplay: expect.any(String), promotions: expect.any(String) })
  imprimir('huellas en caliente', { carga: carga(), ...r.body.data.fingerprints })
  await esperarQuietud()
  expect(sentencias.map(s => tablaDe(s.query))).toEqual(['Terminal', 'firmas (cruda)'])
}, 60_000)

it('🔴 cuerpo del poll de un aparato SIN versión: UNA sentencia, como hoy (decisión 1)', async () => {
  sentencias.length = 0
  const r = await pollDe(venueId, `dev-${suffix}-vieja`)
  expect(r.status).toBe(200)
  expect(r.body.data.fingerprints).toEqual({})
  await esperarQuietud()
  expect(sentencias).toHaveLength(1)
})

it('🔴 con el tope LLENO, el poll no arranca trabajo de base fuera de él: sólo la sentencia de la terminal (Codex r1 #2)', async () => {
  // El plan en caché y el carrusel NO: la huella de promociones tendría que construir el carrusel, y no hay lugar.
  await readVenuePlanSnapshot(venueId)
  resetCarouselCacheForTests()
  const liberar: Array<() => void> = []
  for (let i = 0; i < POLL_WORK_MAX_IN_FLIGHT; i++) pollWorkLimiter.intentar(() => new Promise<void>(res => liberar.push(res)))
  try {
    expect(pollWorkLimiter.enVuelo).toBe(POLL_WORK_MAX_IN_FLIGHT)
    sentencias.length = 0
    const r = await poll(0)
    expect(r.status).toBe(200)
    await esperar(1_000)
    expect(r.body.data.fingerprints).not.toHaveProperty('promotions')
    expect(r.body.data.fingerprints).not.toHaveProperty('settings')
    expect(sentencias.map(s => tablaDe(s.query))).toEqual(['Terminal'])
  } finally {
    for (const soltar of liberar) soltar()
  }
  await esperarQuietud()
})

it('el costo HTTP COMPLETO de un poll en caliente, con el token REAL de POS, su sesión y su membresía (se imprime)', async () => {
  expect(process.env.ACCESS_TOKEN_SECRET).toBeTruthy()
  await poll(0) // el CUERPO en caliente: lo que se mide abajo es lo que agregan la sesión y la membresía
  await esperarQuietud()
  const token = generateAccessToken(staffId, orgId, venueId, 'CASHIER', false, { sid: sesionId, pos: true })
  const conSesion = () => poll(0).set('authorization', `Bearer ${token}`)
  sentencias.length = 0
  expect((await conSesion()).status).toBe(200) // la PRIMERA, con las cachés de la sesión frías
  await esperarQuietud()
  const primera = { total: sentencias.length, porTabla: porTabla(sentencias) }
  sentencias.length = 0
  const r = await conSesion()
  expect(r.status).toBe(200)
  await esperarQuietud()
  imprimir('poll HTTP COMPLETO — sentencias', {
    primeraConLaSesionFria: primera,
    enCaliente: { total: sentencias.length, porTabla: porTabla(sentencias), cada_una: sentencias.map(s => s.query.slice(0, 120)) },
  })
}, 60_000)

it(`latencia con ${DISPOSITIVOS} aparatos a la vez: la ronda FRÍA, ${RONDAS} CALIENTES y 3 ESCALONADAS, con las huellas omitidas (se imprime)`, async () => {
  await enFrio()
  const ronda = async (paso = 0) => {
    const tiempos: number[] = []
    const respuestas = await escalonadas(DISPOSITIVOS, paso, async i => {
      const inicio = process.hrtime.bigint()
      const r = await poll(i)
      tiempos.push(Number(process.hrtime.bigint() - inicio) / 1e6)
      expect(r.status).toBe(200)
      return r
    })
    return { tiempos, respuestas }
  }
  const cargaFria = carga()
  const fria = await ronda()
  await esperarQuietud()
  const calientes = { tiempos: [] as number[], respuestas: [] as Array<{ body: any }>, porRonda: [] as Array<ReturnType<typeof omitidas>> }
  const cargaCaliente = carga()
  for (let i = 0; i < RONDAS; i++) {
    const r = await ronda()
    calientes.tiempos.push(...r.tiempos)
    calientes.respuestas.push(...r.respuestas)
    calientes.porRonda.push(omitidas(r.respuestas))
  }
  const cargaEscalonada = carga()
  // Como llegan en la calle: cada tablet a su ritmo. 10 ms entre una y otra = 50 en medio segundo.
  const escalonadasPorRonda: Array<ReturnType<typeof omitidas> & { p95: string }> = []
  for (let i = 0; i < 3; i++) {
    const r = await ronda(10)
    escalonadasPorRonda.push({ ...omitidas(r.respuestas), p95: percentiles(r.tiempos).p95 })
    await esperarQuietud(300)
  }
  imprimir('latencia del poll (ms), ronda FRÍA', {
    medidoConCarga: cargaFria,
    ...percentiles(fria.tiempos),
    huellasOmitidas: omitidas(fria.respuestas),
  })
  imprimir('latencia del poll (ms), rondas CALIENTES (los 50 en el mismo instante)', {
    medidoConCarga: `${cargaCaliente} → ${carga()}`,
    ...percentiles(calientes.tiempos),
    huellasOmitidas: omitidas(calientes.respuestas),
    omitidasPorRonda:
      calientes.porRonda.map(o => `${o.customerDisplay}/${o.settings}/${o.promotions}`).join(' · ') + ' (ficha/ajustes/promos)',
  })
  imprimir('rondas ESCALONADAS (10 ms entre tablets): ¿la sincronización avanza?', {
    medidoConCarga: cargaEscalonada,
    porRonda: escalonadasPorRonda,
  })
  // Y UN poll a la vez (el mismo aparato, en caliente): lo que cuesta un poll sin la cola de los otros 49.
  await poll(0)
  await esperarQuietud(300)
  const solos: number[] = []
  for (let i = 0; i < 20; i++) {
    const inicio = process.hrtime.bigint()
    expect((await poll(0)).status).toBe(200)
    solos.push(Number(process.hrtime.bigint() - inicio) / 1e6)
  }
  imprimir('latencia de UN poll en caliente, uno a la vez (ms)', { medidoConCarga: carga(), ...percentiles(solos) })
}, 300_000)

it(`🔴 ${VENUES_FRIOS} venues FRÍOS a la vez con el pool real: el tope nunca pasa de ${POLL_WORK_MAX_IN_FLIGHT}; la sonda de cobro y las huellas omitidas se imprimen`, async () => {
  await enFrio()
  let maxEnVuelo = 0
  const vigia = setInterval(() => (maxEnVuelo = Math.max(maxEnVuelo, pollWorkLimiter.enVuelo)), 1)
  const todas = () => frios.flatMap(f => f.tablets.map(t => () => pollDe(f.id, t)))
  try {
    const cargaAntes = carga()
    const { resultado, sonda, errores, retrasoDelHiloMs } = await conSonda(async () => {
      const respuestas = await Promise.all(todas().map(p => p()))
      await esperarQuietud(300) // lo omitido termina para llenar su caché (la sonda sigue corriendo: el tope dice cuándo)
      const segunda = await Promise.all(todas().map(p => p()))
      return { respuestas, segunda }
    })
    for (const r of [...resultado.respuestas, ...resultado.segunda]) expect(r.status).toBe(200)
    expect(maxEnVuelo).toBeLessThanOrEqual(POLL_WORK_MAX_IN_FLIGHT) // invariante duro (Codex r1 #2)
    await esperarQuietud(300)
    // Y escalonadas (10 ms entre tablets, el orden barajado cada vuelta): ¿avanza cuando no llegan todas en el mismo instante?
    const escalonadasPorRonda: Array<ReturnType<typeof omitidas>> = []
    for (let i = 0; i < 3; i++) {
      const orden = todas().sort(() => Math.random() - 0.5)
      const r = await escalonadas(orden.length, 10, j => orden[j]())
      escalonadasPorRonda.push(omitidas(r))
      await esperarQuietud(300)
    }
    expect(maxEnVuelo).toBeLessThanOrEqual(POLL_WORK_MAX_IN_FLIGHT)
    const free = (rs: Array<{ body: any }>) => [
      ...new Set(rs.slice(-TABLETS_POR_VENUE_FRIO * 3).map(r => r.body.data.fingerprints.promotions ?? 'omitida')),
    ]
    imprimir('venues FRÍOS a la vez', {
      medidoConCarga: `${cargaAntes} → ${carga()}`,
      venues: VENUES_FRIOS,
      polls: resultado.respuestas.length,
      connection_limit: new URL(urlDeMedicion).searchParams.get('connection_limit'),
      maxEnVuelo,
      sondaDeCobroMs: percentiles(sonda),
      retrasoDelHiloMs,
      erroresDeLaSonda: errores, // P2024 = pool agotado
      huellasOmitidasEnFrio: omitidas(resultado.respuestas),
      huellasOmitidasEnElSiguientePoll: omitidas(resultado.segunda), // ¿la sincronización AVANZA?
      promocionesDeLosFreeEnElSiguientePoll: free(resultado.segunda),
      escalonadasPorRonda,
    })
  } finally {
    clearInterval(vigia)
  }
}, 180_000)

it('cuánto cuesta un /settings de una tablet v2 (Android lo pide en cada ON_RESUME, también al volver de la app de cobro): se imprime', async () => {
  sentencias.length = 0
  const r = await settingsDe(`dev-${suffix}-0`)
  expect(r.status).toBe(200)
  expect(r.body.data.componentsStatus).toMatchObject({ customerDisplay: 'ok' })
  expect(r.body.data.fingerprints).toEqual({ settings: expect.stringMatching(/^[0-9a-f]{32}$/) })
  await esperarQuietud()
  const primera = { total: sentencias.length, porTabla: porTabla(sentencias) }
  sentencias.length = 0
  expect((await settingsDe(`dev-${suffix}-0`)).status).toBe(200)
  await esperarQuietud()
  const segunda = { total: sentencias.length, porTabla: porTabla(sentencias), cada_una: sentencias.map(s => s.query.slice(0, 120)) }
  // Lo que agrega F0-B a una tablet v2: la MISMA ruta para un aparato del negocio SIN versión (sin huella ni bloque).
  expect((await settingsDe(`dev-${suffix}-vieja`)).status).toBe(200)
  await esperarQuietud()
  sentencias.length = 0
  expect((await settingsDe(`dev-${suffix}-vieja`)).status).toBe(200)
  await esperarQuietud()
  imprimir('/settings de una tablet v2 (cuerpo) — sentencias', {
    medidoConCarga: carga(),
    primera,
    segunda,
    elMismoAparatoSinVersion: { total: sentencias.length, porTabla: porTabla(sentencias) },
    bytesDeLaRespuesta: JSON.stringify(r.body).length,
    tiempoDeUnaEnCaliente: await medirCpu(() => settingsDe(`dev-${suffix}-0`).then(x => x.body)),
  })
}, 60_000)

it('cuánto cuestan el GET de la ficha y el acuse (los dos la recalculan con refresh, fuera del tope): se imprime', async () => {
  const dev = `dev-${suffix}-1`
  sentencias.length = 0
  const ficha = await request(app).get(`/api/v1/mobile/venues/${venueId}/customer-display`).set('x-device-id', dev)
  expect(ficha.status).toBe(200)
  await esperarQuietud(300)
  const get = { total: sentencias.length, porTabla: porTabla(sentencias) }
  sentencias.length = 0
  const ahora = new Date().toISOString()
  const acuse = await request(app).put(`/api/v1/mobile/venues/${venueId}/customer-display/ack`).set('x-device-id', dev).send({
    installationId: 'inst-1',
    fingerprint: ficha.body.data.ficha.fingerprint,
    seq: 1,
    storedAt: ahora,
    shownAt: ahora,
    surface: 'presentation',
    imagesReady: 0,
    imagesPending: 0,
    imagesFailed: 0,
    unsupportedSchema: false,
  })
  expect(acuse.status).toBe(200)
  expect(acuse.body.data).toMatchObject({ accepted: true, current: true })
  await esperarQuietud(300)
  imprimir('GET /customer-display y PUT /customer-display/ack — sentencias', {
    get,
    ack: { total: sentencias.length, porTabla: porTabla(sentencias) },
  })
}, 60_000)

it('🔴 la consulta del aparato que /promotions y /settings pagan con X-Device-ID aunque no sea una tablet v2: +1 sentencia, y nada más', async () => {
  // Un deviceUid que NO está en el negocio: aísla el binding (con un aparato real, /settings además lee SUS ajustes).
  const contar = async (hacer: () => request.Test) => {
    expect((await hacer()).status).toBe(200) // calienta lo que tenga caché
    await esperarQuietud(300)
    sentencias.length = 0
    expect((await hacer()).status).toBe(200)
    await esperarQuietud(300)
    return sentencias.length
  }
  const promociones = {
    sinCabecera: await contar(() => promotionsDe()),
    conCabecera: await contar(() => promotionsDe(`no-existe-${suffix}`)),
  }
  const ajustes = { sinCabecera: await contar(() => settingsDe()), conCabecera: await contar(() => settingsDe(`no-existe-${suffix}`)) }
  imprimir('el binding de X-Device-ID (sentencias por petición)', { promociones, ajustes })
  expect(promociones.conCabecera - promociones.sinCabecera).toBe(1)
  expect(ajustes.conCabecera - ajustes.sinCabecera).toBe(1)
}, 60_000)

it('qué pesa cada parte de /promotions: el catálogo de siempre contra el carrusel nuevo (se imprime)', async () => {
  const veces = 3
  const catalogo: Array<{ ms: number; cpuMs: number }> = []
  const carrusel: Array<{ ms: number; cpuMs: number }> = []
  for (let i = 0; i < veces; i++) {
    catalogo.push(await medirCpu(() => listPromotionsForPos(venueId)))
    carrusel.push(await medirCpu(() => buildPromotionCarousel(venueId)))
  }
  imprimir('/promotions por partes (en serie, una a la vez)', {
    medidoConCarga: carga(),
    catalogoDeSiempre: catalogo,
    carruselNuevo: carrusel,
  })
}, 120_000)

it(`la ventana de ${REFRESH_COALESCE_MS} ms del carrusel: cuántas construcciones con refrescos A LA VEZ y EN SERIE (se imprime)`, async () => {
  await esperarQuietud(300)
  sentencias.length = 0
  const inicioJuntos = Date.now()
  await Promise.all(Array.from({ length: DISPOSITIVOS }, () => refreshCarousel(venueId)))
  const msJuntos = Date.now() - inicioJuntos
  await esperarQuietud(300)
  const aLaVez = sentencias.filter(esLigeraPorAbrir).length
  await esperar(REFRESH_COALESCE_MS + 100)
  sentencias.length = 0
  const inicio = Date.now()
  for (let i = 0; i < 10; i++) await refreshCarousel(venueId) // diez tablets, cada una cuando la anterior ya recibió el suyo
  const ms = Date.now() - inicio
  await esperarQuietud(300)
  const enSerie = sentencias.filter(esLigeraPorAbrir).length
  imprimir('la ventana del carrusel', {
    medidoConCarga: carga(),
    aLaVez: { refrescos: DISPOSITIVOS, ms: msJuntos, construcciones: aLaVez },
    enSerie: {
      refrescos: 10,
      ms,
      construcciones: enSerie,
      loQueDiceElRuling: `≤ ${1 + Math.floor(ms / REFRESH_COALESCE_MS)} (1 por venue cada ${REFRESH_COALESCE_MS} ms)`,
    },
  })
  expect(aLaVez).toBe(1) // los refrescos simultáneos se unen: lo que la ventana SÍ garantiza
}, 120_000)

it(`/promotions de los ${DISPOSITIVOS} aparatos v2 a la vez (tras una edición): construcciones del carrusel, la sonda y el hilo (se imprime)`, async () => {
  resetCarouselCacheForTests()
  sentencias.length = 0
  const una = await promotionsDe(`dev-${suffix}-0`)
  expect(una.status).toBe(200)
  expect(una.body.data.carouselStatus).toBe('ok')
  await esperarQuietud()
  const costoDeUna = { total: sentencias.length, porTabla: porTabla(sentencias), bytes: JSON.stringify(una.body).length }

  resetCarouselCacheForTests()
  sentencias.length = 0
  const cargaAntes = carga()
  const inicio = Date.now()
  const { resultado, sonda, errores, retrasoDelHiloMs } = await conSonda(() =>
    Promise.all(Array.from({ length: DISPOSITIVOS }, (_, i) => promotionsDe(`dev-${suffix}-${i}`))),
  )
  const ms = Date.now() - inicio
  for (const r of resultado) expect(r.status).toBe(200)
  await esperarQuietud()
  imprimir(`/promotions: ${DISPOSITIVOS} tablets v2 a la vez`, {
    medidoConCarga: `${cargaAntes} → ${carga()}`,
    costoDeUnaPeticion: costoDeUna,
    loteMs: ms,
    construccionesDelCarrusel: sentencias.filter(esLigeraPorAbrir).length,
    carruselOk: resultado.filter(r => r.body.data.carouselStatus === 'ok').length,
    sentenciasDelLote: { total: sentencias.length, porTabla: porTabla(sentencias) },
    sondaDeCobroMs: percentiles(sonda),
    retrasoDelHiloMs,
    erroresDeLaSonda: errores,
  })
}, 300_000)

it(`/settings de los ${DISPOSITIVOS} aparatos v2 a la vez (la ficha se reconstruye fuera del tope en cada uno): la sonda (se imprime)`, async () => {
  sentencias.length = 0
  const cargaAntes = carga()
  const inicio = Date.now()
  const { resultado, sonda, errores, retrasoDelHiloMs } = await conSonda(() =>
    Promise.all(Array.from({ length: DISPOSITIVOS }, (_, i) => settingsDe(`dev-${suffix}-${i}`))),
  )
  const ms = Date.now() - inicio
  for (const r of resultado) expect(r.status).toBe(200)
  await esperarQuietud()
  imprimir(`/settings: ${DISPOSITIVOS} tablets v2 a la vez`, {
    medidoConCarga: `${cargaAntes} → ${carga()}`,
    loteMs: ms,
    sentenciasDelLote: {
      total: sentencias.length,
      porPeticion: (sentencias.length / DISPOSITIVOS).toFixed(1),
      porTabla: porTabla(sentencias),
    },
    sondaDeCobroMs: percentiles(sonda),
    retrasoDelHiloMs,
    erroresDeLaSonda: errores,
    componentesFallidos: resultado.filter(r => r.body.data.componentsStatus.customerDisplay !== 'ok').length,
  })
}, 300_000)

it(`invalidar la ficha de UNA terminal recorre la caché entera (≤ ${CACHE_MAX_ENTRIES}): cuánto cuesta (se imprime)`, () => {
  const falsas = Array.from({ length: CACHE_MAX_ENTRIES }, (_, i) => `falsa-${i}-${suffix}:${venueId}`)
  for (const k of falsas) cacheDeFichas.set(k, { hasta: Date.now() + 60_000, valor: {} as never })
  try {
    const N = 2_000
    const inicio = process.hrtime.bigint()
    for (let i = 0; i < N; i++) invalidateCustomerDisplayCache(`no-esta-${i}`)
    const microsegundos = Number(process.hrtime.bigint() - inicio) / 1e3 / N
    imprimir('invalidar con la caché llena', {
      medidoConCarga: carga(),
      entradas: cacheDeFichas.size,
      microsegundosPorInvalidacion: microsegundos.toFixed(1),
    })
  } finally {
    for (const k of falsas) cacheDeFichas.delete(k)
  }
})

it('EXPLAIN (ANALYZE, BUFFERS) de la sentencia de firmas, de las consultas del carrusel y de la del aparato (se imprimen)', async () => {
  // 🔴 `Prisma.sql` compone la sentencia con sus `$1`; el `.sql` de un `Prisma.Sql` trae `?`, que Postgres rechaza (Codex r1 #11).
  const plan = await prisma.$queryRaw<Array<Record<string, string>>>(Prisma.sql`EXPLAIN (ANALYZE, BUFFERS) ${venueSignaturesSql(venueId)}`)
  const lineas = plan.map(f => Object.values(f)[0])
  imprimir('plan — firmas del venue', lineas.join('\n'))
  const firmas = venueSignaturesSql(venueId)
  const firmasForzadas = await explicar(firmas.text, firmas.values, true)
  imprimir('plan — firmas del venue, resumen', { natural: resumenDelPlan(lineas), conSeqScanApagado: resumenDelPlan(firmasForzadas) })

  // El carrusel SOLO (sin el catálogo de siempre que /promotions también lee): sus sentencias no se mezclan con otras.
  await esperarQuietud(300)
  sentencias.length = 0
  await refreshCarousel(venueId)
  await esperarQuietud()
  const ligeras = [sentencias.find(esLigeraVigentes), sentencias.find(esLigeraPorAbrir)]
  expect(ligeras.every(Boolean)).toBe(true)
  for (const [n, s] of (ligeras as Sentencia[]).entries()) {
    const nombre = n === 0 ? 'vigentes por fecha' : 'por abrir en 24 h'
    // El texto del evento ya trae `$1…$n` (el de Postgres): aquí `$queryRawUnsafe` sí sirve.
    const { sql, params } = sentenciaParaExplicar(s)
    const natural = await explicar(sql, params)
    imprimir(`plan — carrusel, consulta ligera «${nombre}»`, natural.join('\n'))
    imprimir(`plan — carrusel, consulta ligera «${nombre}», resumen`, {
      natural: resumenDelPlan(natural),
      conSeqScanApagado: resumenDelPlan(await explicar(sql, params, true)),
      sql: s.query,
    })
  }

  // La lectura COMPLETA y sus anidadas: ¿el `take` de grupos (21) y opciones (51) llega a la base o se aplica en memoria?
  const completa = sentencias.find(s => /"Promotion"\."id" IN/.test(s.query) && s.query.includes('LIMIT'))
  const anidadas = sentencias.filter(s => ['PromotionGroup', 'PromotionOption', 'Product'].includes(tablaDe(s.query)))
  const filasDe = async (s: Sentencia) => {
    const { sql, params } = sentenciaParaExplicar(s)
    const lineasDe = await explicar(sql, params)
    return {
      tabla: tablaDe(s.query),
      conLimit: /\bLIMIT\b/.test(s.query),
      conVentana: /ROW_NUMBER|OVER\s*\(/i.test(s.query),
      raiz: lineasDe[0].trim(),
      ...resumenDelPlan(lineasDe),
      sql: s.query.slice(0, 220),
    }
  }
  const detalleAnidadas: unknown[] = []
  for (const s of anidadas) detalleAnidadas.push(await filasDe(s))
  imprimir('la lectura completa del carrusel y sus anidadas', {
    completa: completa ? await filasDe(completa) : 'no apareció',
    anidadas: detalleAnidadas,
    opcionesDeLaPromoGrande: OPCIONES_DE_LA_PROMO_GRANDE,
  })

  // La del aparato (binding) y el tamaño de `Terminal.config` que el poll lee en cada vuelta (nota M3 de la Task 7).
  const ajustes = (await settingsDe(`dev-${suffix}-0`)).body.data.settings
  const terminal0 = await prisma.terminal.findFirstOrThrow({ where: { venueId, deviceUid: `dev-${suffix}-0` }, select: { id: true } })
  await prisma.terminal.update({ where: { id: terminal0.id }, data: { config: { settings: ajustes } } })
  const [{ bytes }] = await prisma.$queryRaw<
    Array<{ bytes: number }>
  >`SELECT pg_column_size(config)::int AS bytes FROM "Terminal" WHERE id = ${terminal0.id}`
  await esperarQuietud()
  sentencias.length = 0
  await poll(0)
  await esperarQuietud()
  const binding = sentencias.find(s => tablaDe(s.query) === 'Terminal')
  expect(binding).toBeDefined()
  const { sql, params } = sentenciaParaExplicar(binding as Sentencia)
  imprimir('plan — la terminal del poll (con TODOS los ajustes escritos en config)', {
    jsonDeLosAjustesBytes: JSON.stringify({ settings: ajustes }).length,
    pgColumnSizeDeConfig: bytes,
    natural: (await explicar(sql, params)).map(l => l.trim()),
    conSeqScanApagado: resumenDelPlan(await explicar(sql, params, true)),
  })
}, 120_000)
