/**
 * IVA por producto, plan 6b (spec §5.1, §5.2, §5.2b, §5.7, D10, D12, D20): estado del negocio, revisiones para ENCENDER y el encendido
 * al guardar un producto (parte 2). Lo usan el guardado de producto del dashboard, el MCP `set_product_iva` y la ruta del estado.
 * Encendido es pegajoso: nada aquí lo apaga.
 */
import { Prisma, type Product } from '@prisma/client'
import { formatInTimeZone } from 'date-fns-tz'

import logger from '@/config/logger'
import { ConflictError, ForbiddenError, NotFoundError } from '@/errors/AppError'
import { isActiveSuperAdmin } from '@/mcp/scope'
import { resolveUserRoleForVenue } from '@/middlewares/checkPermission.middleware'
import { writeLegacyActivityAuditTx } from '@/services/activityAudit.service'
import { PresupuestoDeEspera, tomarCandado } from '@/utils/esperaDeCandados'
import prisma from '@/utils/prismaClient'
import { bloquearOrdenesParaFacturar, tomarAdmisionExclusiva } from './admisionIva'
import { avisosDeAparatos, bloqueosDeAparatos, revisarAparatos, type AvisoIva, type Bloqueo } from './aparatosIva.service'
import { extraccionesPendientes, folioDe } from './cfdi.service'
import { bloquearParaCambiarIva, negocioCambioDeOrganizacionError } from './exclusionContable'
import { TRATAMIENTOS_OFRECIDOS_V1, type IvaTratamiento } from './ivaTratamiento'
import { MENSAJES } from './normalizarIvaDeProducto'
import {
  aplicarSelladoHeredado,
  MOTIVO_SELLO_DISTINTO,
  planDeSelladoHeredado,
  SelloHeredadoDivergente,
  SIN_REPARAR,
  type NoSellable,
  type PlanDeSellado,
} from './sellosHeredados'

export type { AvisoIva, Bloqueo, CodigoBloqueo } from './aparatosIva.service'
type Db = Prisma.TransactionClient
const DIA_MS = 24 * 60 * 60 * 1000
/** Cuántos documentos se nombran por revisión; el resto se cuenta. */
const NOMBRADOS = 10
/** Cuántos avisos de aparatos lleva la respuesta del estado (Ruling CX-7); el resto se cuenta en `avisosTotal`. */
export const AVISOS_EN_PANTALLA = 20

/** La misma condición que el trigger `IVA_CONTABILIDAD_CON_HISTORIA` (migración `20260929000100_iva_regla_c`). */
export async function tieneContabilidad(db: Db, p: { venueId: string; organizationId: string }): Promise<boolean> {
  const [r] = await db.$queryRaw<Array<{ hay: boolean }>>`
    SELECT (EXISTS (SELECT 1 FROM "JournalEntry" WHERE "organizationId" = ${p.organizationId})
         OR EXISTS (SELECT 1 FROM "JournalEntry" WHERE "venueId" = ${p.venueId})
         OR EXISTS (SELECT 1 FROM "AccountingPeriodLock" WHERE "organizationId" = ${p.organizationId})) AS hay`
  return r?.hay === true
}

const contabilidadDe = async (db: Db, p: { venueId: string; organizationId: string }): Promise<Bloqueo[]> =>
  (await tieneContabilidad(db, p))
    ? [
        {
          codigo: 'CONTABILIDAD',
          mensaje: MENSAJES.IVA_CONTABILIDAD_CON_HISTORIA,
          comoArreglar: 'Escríbenos a hola@avoqado.io: la contabilidad todavía no maneja IVA distinto de 16 %.',
        },
      ]
    : []

/** POS externo y aparatos: dependen sólo del negocio y de la fecha, no de la admisión ni del XML. */
async function posYAparatosDe(db: Db, venueId: string, ahora: Date): Promise<Bloqueo[]> {
  const desde = new Date(ahora.getTime() - 30 * DIA_MS)
  const bloqueos: Bloqueo[] = []
  // POS externo: sin tipo, sin latido y sin ventas RECIBIDAS (`syncedAt`, no la fecha que manda el POS) en 30 días.
  const venue = await db.venue.findUniqueOrThrow({ where: { id: venueId }, select: { posType: true, timezone: true } })
  const latido = await db.posConnectionStatus.findUnique({ where: { venueId }, select: { lastHeartbeatAt: true } })
  // ponytail: `Order` no tiene índice con `originSystem`/`syncedAt`: sin ventas del POS esta búsqueda recorre las órdenes del negocio. Techo: sólo
  // corre al encender y en el diagnóstico bajo demanda (`conRevision`), nunca en el GET. Subir a índice parcial
  // (`Order("venueId","syncedAt") WHERE "originSystem" = 'POS_SOFTRESTAURANT'`, migración aparte con visto bueno del founder) si se mide lento.
  const ventaPos = await db.order.findFirst({
    where: { venueId, originSystem: 'POS_SOFTRESTAURANT', syncedAt: { gte: desde } },
    select: { id: true },
  })
  if ((venue.posType && venue.posType !== 'NONE') || (latido?.lastHeartbeatAt && latido.lastHeartbeatAt >= desde) || ventaPos)
    bloqueos.push({
      codigo: 'POS_EXTERNO',
      mensaje: 'Este negocio recibe ventas de un POS externo, que calcula su propio IVA',
      comoArreglar: 'Pide a soporte desconectarlo. Esta revisión pasa 30 días después de su último latido o venta.',
    })
  bloqueos.push(...bloqueosDeAparatos(await revisarAparatos(venueId, ahora, db), venue.timezone))
  return bloqueos
}

/** T6-1: serie-folio; si no tiene, el UUID corto; si tampoco (un DRAFT/STAMPING aún sin timbrar), cuándo se creó. Nunca «anterior». */
function facturaEnVuelo(f: { serie: string | null; folio: string | null; uuid: string | null; createdAt: Date }, tz: string): string {
  if (f.serie || f.folio) return `La factura ${folioDe(f)}`
  if (f.uuid) return `La factura con UUID ${f.uuid.slice(0, 8)}…`
  return `Una factura creada el ${formatInTimeZone(f.createdAt, tz, "dd/MM/yyyy 'a las' HH:mm")}`
}

export async function revisarEncendido(
  db: Db,
  p: { venueId: string; organizationId: string; plan: PlanDeSellado; ahora?: Date },
): Promise<Bloqueo[]> {
  const ahora = p.ahora ?? new Date()
  const bloqueos: Bloqueo[] = await contabilidadDe(db, p)

  // Documentos en vuelo de TODA la organización (la admisión es por organización). Codex código r1 #4 (Ruling CX-4): quien revisa esta
  // sucursal no necesariamente tiene acceso a las demás; lo de ESTA sucursal se nombra, lo de las otras sólo se cuenta (sin folio, UUID,
  // fecha ni nombre de la sucursal).
  // ponytail: la rama `cancelStatus: 'REQUESTED'` no tiene índice (la llave es (venueId, status)): lee los CFDI de la organización. Techo:
  // sólo corre al encender y en el diagnóstico bajo demanda (`conRevision`), nunca en el GET. Subir a índice parcial
  // (`Cfdi("venueId") WHERE "cancelStatus" = 'REQUESTED'`, migración aparte con visto bueno del founder) si el encendido se mide lento.
  const enVuelo: Prisma.CfdiWhereInput = {
    OR: [
      { status: { in: ['DRAFT', 'VALIDATING', 'STAMPING', 'CANCEL_REQUESTED'] } },
      { status: 'STAMP_FAILED', falloDefinitivo: false },
      { cancelStatus: 'REQUESTED' },
    ],
  }
  const propios = await db.cfdi.findMany({
    where: { venueId: p.venueId, ...enVuelo },
    select: { serie: true, folio: true, uuid: true, createdAt: true, venue: { select: { timezone: true } } },
    orderBy: { id: 'asc' },
    take: NOMBRADOS + 1, // uno de más sólo para saber si hay que contar el resto (T5-1)
  })
  for (const f of propios.slice(0, NOMBRADOS))
    bloqueos.push({
      codigo: 'DOCUMENTOS_EN_VUELO',
      mensaje: `${facturaEnVuelo(f, f.venue.timezone)} se está procesando o cancelando`,
      comoArreglar: 'Espera a que termine, o reintenta o cancela en Facturación, y vuelve a guardar.',
    })
  if (propios.length > NOMBRADOS) {
    const mas = (await db.cfdi.count({ where: { venueId: p.venueId, ...enVuelo } })) - NOMBRADOS
    bloqueos.push({
      codigo: 'DOCUMENTOS_EN_VUELO',
      mensaje: mas === 1 ? 'Y 1 factura más se está procesando o cancelando' : `Y ${mas} facturas más se están procesando o cancelando`,
      comoArreglar: 'Revisa Facturación y vuelve a guardar cuando terminen.',
    })
  }
  let ajenos = await db.cfdi.count({ where: { venue: { organizationId: p.organizationId }, venueId: { not: p.venueId }, ...enVuelo } })
  // Extracciones pendientes (C3). Las de esta sucursal se nombran por su nota; las de las demás se suman a `ajenos`. Los otros negocios van
  // por páginas de 200 (nunca un tope que deje alguno fuera, Codex 6b r1 P2-10). Ojo: `extraccionesPendientes` lee con el cliente global,
  // no con `db` (sólo ve lo ya confirmado).
  const propias = await extraccionesPendientes([p.venueId], { limit: 1 })
  if (propias.total > 0) {
    const e = propias.items[0] // puede faltar si cambió entre las dos lecturas
    bloqueos.push({
      codigo: 'DOCUMENTOS_EN_VUELO',
      mensaje: `Una venta de una factura global se está facturando aparte y le falta su factura${e ? ` (nota ${folioDe(e)})` : ''}`,
      comoArreglar: 'Termínala en Facturación (o pídesela a soporte) y vuelve a guardar.',
    })
  }
  for (let cursor = ''; ; ) {
    const pagina = await db.venue.findMany({
      where: { organizationId: p.organizationId, id: { gt: cursor, not: p.venueId } },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: 200,
    })
    const ids = pagina.map(v => v.id)
    if (ids.length > 0) ajenos += (await extraccionesPendientes(ids, { limit: 1 })).total
    if (pagina.length < 200) break
    cursor = pagina[pagina.length - 1].id
  }
  if (ajenos > 0)
    bloqueos.push({
      codigo: 'DOCUMENTOS_EN_VUELO',
      mensaje:
        ajenos === 1
          ? 'Hay 1 factura en proceso en otra sucursal de tu organización'
          : `Hay ${ajenos} facturas en proceso en otras sucursales de tu organización`,
      comoArreglar:
        ajenos === 1
          ? 'Quien la administra debe terminarla o cancelarla en Facturación; después vuelve a guardar.'
          : 'Quien las administra debe terminarlas o cancelarlas en Facturación; después vuelve a guardar.',
    })

  // Facturas viejas (D11, D21): la que no se puede sellar desde su XML detiene el encendido y se nombra.
  for (const n of p.plan.noSellables.slice(0, NOMBRADOS))
    bloqueos.push({
      codigo: 'FACTURA_VIEJA_SIN_SELLO',
      mensaje: `La factura ${n.folio}: ${n.motivo}`,
      comoArreglar: 'Escríbenos a soporte con ese folio: hay que revisarla a mano antes de encender.',
    })
  if (p.plan.noSellables.length > NOMBRADOS)
    bloqueos.push({
      codigo: 'FACTURA_VIEJA_SIN_SELLO',
      mensaje: `Y ${p.plan.noSellables.length - NOMBRADOS} facturas viejas más`,
      comoArreglar: 'Escríbenos a soporte: hay que revisarlas a mano antes de encender.',
    })

  bloqueos.push(...(await posYAparatosDe(db, p.venueId, ahora)))
  return bloqueos
}

export type EstadoIvaPorProducto = {
  encendido: boolean
  habilitadoAt: string | null
  /** La organización lleva contabilidad: el selector va deshabilitado con el texto del plan 4. */
  contabilidad: boolean
  /** Apagado: lo que HOY detendría el encendido (informativo; la decisión real se toma al guardar). Vacío si `revisado` es false. */
  bloqueos: Bloqueo[]
  /** Encendido: aparatos viejos (nunca bloquean una venta). A lo más `AVISOS_EN_PANTALLA`; si hay más, `avisosTotal` dice cuántos. */
  avisos: AvisoIva[]
  /** Codex código r1 #7 (Ruling CX-7): sólo cuando hay más avisos que los que trae `avisos`. */
  avisosTotal?: number
  /** Encendido: facturas viejas que la puesta al día no pudo sellar (para revisarlas a mano, D20). Vacío si `revisado` es false. */
  facturasSinSello: NoSellable[]
  /** false = no se corrió la revisión completa (el GET del dashboard): `bloqueos` y `facturasSinSello` vienen vacíos porque NO se calcularon. */
  revisado: boolean
}

/**
 * Informativo y sin candados; no llama al PAC (una heredada sin XML sale como «no se pudo leer» hasta que el guardado lo pida).
 * Sin `conRevision` (lo que usa el GET, que el dashboard pide en cada carga de Productos) no corre `revisarEncendido` ni el plan de heredadas:
 * esas consultas crecen con las ventas y las facturas del negocio y sólo hacen falta al guardar (Tarea 6) y en el diagnóstico del MCP.
 */
export async function estadoIvaPorProducto(
  venueId: string,
  ahora = new Date(),
  opts: { conRevision?: boolean } = {},
): Promise<EstadoIvaPorProducto> {
  const conRevision = opts.conRevision === true
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { organizationId: true, timezone: true, ivaPorProducto: { select: { habilitadoAt: true } } },
  })
  // Minor T5-3: un SUPERADMIN (que se salta la resolución de rol) con un negocio que no existe recibe 404, no el 500 de un P2025.
  if (!venue) throw new NotFoundError('Negocio no encontrado')
  const contabilidad = await tieneContabilidad(prisma, { venueId, organizationId: venue.organizationId })
  const plan = conRevision ? await planDeSelladoHeredado(venueId, { reparar: SIN_REPARAR }) : null // nunca llama al PAC
  if (venue.ivaPorProducto) {
    // ponytail: la comparación de versión es en memoria y recorre los aparatos que imprimen de UNA sede vistos en 30 días (por páginas de 200).
    // Techo: cientos de aparatos por sede; si una sede pasa de eso, filtrar la versión en SQL. La respuesta sí va acotada (Ruling CX-7).
    const avisos = avisosDeAparatos(await revisarAparatos(venueId, ahora), venue.timezone)
    return {
      encendido: true,
      habilitadoAt: venue.ivaPorProducto.habilitadoAt.toISOString(),
      contabilidad,
      bloqueos: [],
      avisos: avisos.slice(0, AVISOS_EN_PANTALLA),
      ...(avisos.length > AVISOS_EN_PANTALLA ? { avisosTotal: avisos.length } : {}),
      facturasSinSello: plan
        ? [
            ...plan.noSellables,
            ...plan.sellables.map(s => ({ cfdiId: s.cfdiId, folio: s.folio, motivo: 'Pendiente de sellar en la puesta al día' })),
          ]
        : [],
      revisado: conRevision,
    }
  }
  return {
    encendido: false,
    habilitadoAt: null,
    contabilidad,
    bloqueos: plan ? await revisarEncendido(prisma, { venueId, organizationId: venue.organizationId, plan, ahora }) : [],
    avisos: [],
    facturasSinSello: [],
    revisado: conRevision,
  }
}

// ─── Parte 2: encender al guardar (spec §5.2, §5.7, D10, D11, H14) ───────────────────────────────────────────────────────────────────

export type OrigenIva = 'DASHBOARD' | 'MCP' | 'MOVIL'
export const MENSAJE_ENCENDIDO_BLOQUEADO = 'Para vender productos con un IVA distinto de 16 % falta resolver esto:'
const bloqueado = (bloqueos: Bloqueo[]) => new ConflictError(MENSAJE_ENCENDIDO_BLOQUEADO, 'IVA_ENCENDIDO_BLOQUEADO', { bloqueos })

/**
 * Revisión final, I-1: cuánto espera el encendido la admisión EXCLUSIVA. Mientras espera, Postgres forma detrás a TODA admisión compartida
 * de la organización que llegue después (la cola es justa): facturación, cancelaciones, notas y el POS. Con el tope, sale de la cola con
 * un 409 claro y los libera; sin él, una global o una nota larga (hasta 60 s) frenaba a toda la organización y el dueño veía un 500.
 */
export const ESPERA_ADMISION_EXCLUSIVA_MS = 5_000
export const IVA_ENCENDIDO_OCUPADO = 'IVA_ENCENDIDO_OCUPADO'
export const MENSAJE_ENCENDIDO_OCUPADO = 'Hay facturas o ventas en proceso en tu organización; vuelve a intentar en un momento.'

/** Decisión del founder (12-oct): el primer encendido sólo lo hace el dueño o un administrador de la sede (o un SUPERADMIN activo). */
export const ROLES_DE_LA_SEDE_QUE_ENCIENDEN = ['OWNER', 'ADMIN'] as const
export const MENSAJE_ENCENDIDO_SOLO_DUENO =
  'Es el primer producto con un IVA distinto de 16 %: encenderlo pausa la contabilidad automática de toda la organización, así que sólo lo puede hacer el dueño o un administrador.'

/**
 * Decisión del founder (12-oct): el PRIMER encendido pausa la contabilidad de TODA la organización (marca pegajosa): sólo dueño o
 * administrador de la sede, o un SUPERADMIN activo de la plataforma. Cambiar el IVA de un negocio YA encendido no pasa por aquí.
 */
export async function exigirQuienEnciende(venueId: string, staffId: string | null): Promise<void> {
  // Codex r2 N4: el SUPERADMIN se reconoce como en el resto de la plataforma (`isActiveSuperAdmin`, `src/mcp/scope.ts`), aunque no
  // tenga `StaffVenue` en esta sede; `resolveUserRoleForVenue` sólo mira la sede y al OWNER de su organización.
  if (staffId && (await isActiveSuperAdmin(staffId))) return
  const { role } = staffId ? await resolveUserRoleForVenue({ userId: staffId, targetVenueId: venueId }) : { role: null }
  if (!role || !(ROLES_DE_LA_SEDE_QUE_ENCIENDEN as readonly string[]).includes(role))
    throw new ForbiddenError(MENSAJE_ENCENDIDO_SOLO_DUENO, 'IVA_ENCENDIDO_SOLO_DUENO')
}

/**
 * FUERA de la transacción del guardado (D11: el XML se lee fuera del candado). ¿Este guardado ENCIENDE? Sólo si pide un tratamiento
 * ofrecido distinto de 16 % y del actual, en un negocio apagado. Si sí, el plan de sellado de las facturas viejas; si no, `null`.
 * Revisión final, I-1 (paso 2) y Codex código r1 #6 (Ruling CX-6): antes de pedir nada al PAC y sin candados, TODO lo que se comprueba
 * leyendo (contabilidad, documentos en vuelo, heredadas no sellables por su contenido, POS externo, aparatos y fecha, y el ajuste de Uber
 * del producto: el trigger lo rechazaría al final). Con algo, 409 con todo eso, sin exclusiva ni PAC. Una heredada SIN XML no bloquea
 * aquí: se le pide al PAC después. La revisión definitiva (`encenderBajoCandados`) vuelve a mirarlo todo bajo los candados.
 */
export async function prepararEncendido(
  venueId: string,
  pedido: unknown,
  producto: Pick<Product, 'ivaTratamiento' | 'ajusteDeliveryAlgunaVez'>,
  staffId: string | null,
  ahora = new Date(),
): Promise<PlanDeSellado | null> {
  if (typeof pedido !== 'string' || pedido === 'IVA_16' || pedido === producto.ivaTratamiento) return null
  if (!(TRATAMIENTOS_OFRECIDOS_V1 as readonly string[]).includes(pedido)) return null // el normalizador responde el 400
  const venue = await prisma.venue.findUniqueOrThrow({
    where: { id: venueId },
    select: { organizationId: true, ivaPorProducto: { select: { venueId: true } } },
  })
  if (venue.ivaPorProducto) return null
  await exigirQuienEnciende(venueId, staffId) // Paso 4b: ANTES de cualquier efecto (el plan puede pedir el XML al PAC)
  // El plan sólo LEYENDO: anota las que no traen XML (se le pedirán al PAC) en vez de pedirlo.
  const sinXml = new Set<string>()
  const previo = await planDeSelladoHeredado(venueId, { reparar: async cfdiId => void sinXml.add(cfdiId) })
  const bloqueos = await revisarEncendido(prisma, {
    venueId,
    organizationId: venue.organizationId,
    plan: { ...previo, noSellables: previo.noSellables.filter(n => !sinXml.has(n.cfdiId)) },
    ahora,
  })
  if (producto.ajusteDeliveryAlgunaVez)
    bloqueos.push({
      codigo: 'AJUSTE_DE_DELIVERY',
      mensaje: 'Este producto ya tuvo ajustes de delivery (Uber) y no puede cambiar de IVA',
      comoArreglar: 'Crea un producto nuevo con el IVA correcto.',
    })
  if (bloqueos.length > 0) throw bloqueado(bloqueos)
  // D11 ampliada (founder, 12-oct): la tasa única del XML. Si a ninguna le faltaba, el plan de lectura YA es el plan.
  return sinXml.size > 0 ? planDeSelladoHeredado(venueId) : previo
}

/**
 * DENTRO de la transacción del guardado, ANTES de cualquier otro candado (D10). Si otro guardado encendió mientras esperaba la admisión,
 * devuelve `false` y el guardado sigue como en un negocio encendido. Si una revisión falla: 409 con TODOS los bloqueos y nada a medias.
 * (La admisión compartida que toma `bloquearOrdenesParaFacturar` sobre la llave que ya tenemos en exclusiva no espera: es la misma sesión.)
 */
export async function encenderBajoCandados(
  tx: Db,
  p: { venueId: string; productId: string | null; plan: PlanDeSellado; staffId: string | null; origen: OrigenIva; ahora?: Date },
): Promise<boolean> {
  const [venue] = await tx.$queryRaw<Array<{ organizationId: string }>>`SELECT "organizationId" FROM "Venue" WHERE id = ${p.venueId}`
  if (!venue) throw new ConflictError('Negocio no encontrado')
  try {
    await tomarCandado(tx, () => tomarAdmisionExclusiva(tx, venue.organizationId), {
      presupuesto: new PresupuestoDeEspera(ESPERA_ADMISION_EXCLUSIVA_MS),
      codigo: IVA_ENCENDIDO_OCUPADO,
      mensaje: MENSAJE_ENCENDIDO_OCUPADO,
    })
  } catch (e) {
    if (e instanceof ConflictError && e.code === IVA_ENCENDIDO_OCUPADO)
      logger.warn(`[IVA] ${IVA_ENCENDIDO_OCUPADO}: el encendido no obtuvo la admisión exclusiva en ${ESPERA_ADMISION_EXCLUSIVA_MS} ms`, {
        venueId: p.venueId,
        organizationId: venue.organizationId,
      })
    throw e
  }
  await bloquearParaCambiarIva(tx, { venueId: p.venueId }) // organización → negocio (el negocio queda FOR SHARE)
  // Codex 6b r1 P1-2: `bloquearParaCambiarIva` sólo compara SUS dos lecturas. Si el negocio se trasladó entre la lectura de arriba y la
  // suya, tendríamos la admisión exclusiva de A y revisaríamos B. Con el negocio ya bloqueado, su organización es la definitiva.
  // (Codex r2 N2: la fila NO se llama `bloqueado`, que es la función de arriba.)
  const [venueBloqueado] = await tx.$queryRaw<
    Array<{ organizationId: string }>
  >`SELECT "organizationId" FROM "Venue" WHERE id = ${p.venueId}`
  if (venueBloqueado?.organizationId !== venue.organizationId) throw negocioCambioDeOrganizacionError()
  if (await tx.venueIvaPorProducto.findUnique({ where: { venueId: p.venueId }, select: { venueId: true } })) return false
  await exigirQuienEnciende(p.venueId, p.staffId) // Paso 4b: la comprobación definitiva, bajo los candados
  // Ruling T6-a: las órdenes de las facturas viejas POR ID del manifiesto, sin `venueId`: una orden que el job de PlayTelecom movió a
  // otra sede sigue siendo de su factura, y `aplicarSelladoHeredado` nunca sella renglones de una orden sin su candado.
  // Codex código r1 #1 (Ruling CX-1): `soloOrganizacion`: con la exclusiva de A, jamás se pide la admisión de B (el encendido de B, con la
  // suya, podría estar pidiendo la de A). Una orden que se fue a otra organización desde el plan ⇒ 409 de reintento, y el plan nuevo la
  // marca como no sellable (`MOTIVO_ORDEN_EN_OTRA_ORGANIZACION`).
  const ordenes = [...new Set(p.plan.sellables.map(s => s.orderId))].sort()
  await bloquearOrdenesParaFacturar(tx, ordenes, undefined, {
    productosExtra: p.productId ? [p.productId] : [],
    paraEscribir: true,
    soloOrganizacion: venue.organizationId,
  })
  const bloqueos = await revisarEncendido(tx, { venueId: p.venueId, organizationId: venue.organizationId, plan: p.plan, ahora: p.ahora })
  if (bloqueos.length > 0) throw bloqueado(bloqueos)
  let sellado: Awaited<ReturnType<typeof aplicarSelladoHeredado>>
  try {
    sellado = await aplicarSelladoHeredado(tx, p.plan, { staffId: p.staffId, origen: 'ENCENDIDO' })
  } catch (e) {
    // Contrato T4 (Review Focus 6): unos renglones pudieron sellarse ya. Después de esto no corre NINGUNA consulta: el 409 sale de la
    // transacción y la revierte entera (nada a medias, nunca un 500).
    if (!(e instanceof SelloHeredadoDivergente)) throw e
    throw bloqueado([
      {
        codigo: 'FACTURA_VIEJA_SIN_SELLO',
        mensaje: `La factura ${e.folio}: ${MOTIVO_SELLO_DISTINTO}`,
        comoArreglar: 'Escríbenos a soporte con ese folio: hay que revisarla a mano antes de encender.',
      },
    ])
  }
  if (sellado.cambiaron.length > 0)
    throw bloqueado(
      sellado.cambiaron.map(c => ({
        codigo: 'DOCUMENTOS_EN_VUELO' as const,
        mensaje: `La factura ${c.folio}: ${c.motivo}`,
        comoArreglar: 'Vuelve a guardar.',
      })),
    )
  await tx.venueIvaPorProducto.create({ data: { venueId: p.venueId, habilitadoPorStaffId: p.staffId } })
  await writeLegacyActivityAuditTx(tx, {
    staffId: p.staffId,
    venueId: p.venueId,
    action: 'IVA_POR_PRODUCTO_ACTIVADO',
    entity: 'VenueIvaPorProducto',
    entityId: p.venueId,
    data: { origen: p.origen, productoId: p.productId, facturasSelladas: sellado.sellados.map(s => s.folio) },
  })
  return true
}

/** H14 (spec §5.7): antes → después, autor y origen, en la MISMA transacción del cambio. Un alta a 16 % no es un cambio. */
export async function registrarCambioDeIva(
  tx: Pick<Db, 'activityLog'>,
  p: {
    venueId: string
    productId: string
    producto: string
    antes: IvaTratamiento | null
    despues: IvaTratamiento
    staffId: string | null
    origen: OrigenIva
  },
): Promise<void> {
  if ((p.antes ?? 'IVA_16') === p.despues) return
  await writeLegacyActivityAuditTx(tx, {
    staffId: p.staffId,
    venueId: p.venueId,
    action: 'PRODUCT_IVA_CHANGED',
    entity: 'Product',
    entityId: p.productId,
    data: { producto: p.producto, antes: { ivaTratamiento: p.antes }, despues: { ivaTratamiento: p.despues }, origen: p.origen },
  })
}
