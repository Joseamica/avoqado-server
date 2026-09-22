/**
 * MCP de clientes — la merma (spec v5 §4.7): `log_waste` en dos pasos y `list_waste_reports`.
 *
 * Las dos llaman a los MISMOS servicios que el POS y el dashboard (`logWaste`, `listWasteReports`):
 * el MCP no es una puerta trasera, sólo otra forma de llegar.
 *
 * 🔴 `log_waste` es una escritura que RESTA existencias, pedida por un LLM que interpreta a una
 * persona. Por eso:
 *   · exige `mcp:write` SIEMPRE (`requireWriteScopeAlways`), no el guard observador;
 *   · la primera llamada sólo arma una vista previa legible y emite el folio; la segunda escribe;
 *   · el folio va atado a lo que se previsualizó (`previewDigest`): confirmar con otra cantidad,
 *     otro motivo u otro artículo se rechaza, porque no es lo que el operador vio;
 *   · resuelve, no adivina: un nombre que coincide con varios artículos devuelve los candidatos.
 *
 * La vista previa NO calcula cuánto se descontaría: `inventory:log-waste` no concede
 * `inventory:read`, y enseñar el descuento sería una consulta de existencias disfrazada.
 *
 * Auditoría: `logWaste` escribe `INVENTORY_WASTE_LOGGED` dentro de su transacción con
 * `source: 'MCP'`. La tool NO llama `auditMcpWrite`: sería una segunda fila para la misma merma
 * (mismo criterio que `create_recipe` y `approve_overtime`, que marcan el canal en el asiento que
 * ya existe en vez de duplicar el evento).
 */
import { createHash, randomUUID } from 'crypto'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Prisma } from '@prisma/client'
import { fromZonedTime } from 'date-fns-tz'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import { ForbiddenError, ValidationError } from '@/errors/AppError'
import type { UserAccess } from '@/services/access/access.service'
import { getWasteAccess, hasWastePermission, logWaste, prepareWaste, recoverByKey } from '@/services/shared/inventoryWaste.service'
import type { WasteInput } from '@/services/shared/inventoryWaste.service'
import { findWasteItem, listWasteItems, listWasteReports } from '@/services/shared/inventoryWasteRead.service'
import type { WasteItem } from '@/services/shared/inventoryWasteRead.service'
import { isWasteReasonCode, WASTE_REASON_CODES, WASTE_REASONS } from '@/services/shared/wasteReasons'
import type { WasteReasonCode } from '@/services/shared/wasteReasons'
import { parseWasteSchema, WasteQuerySchema } from '@/schemas/mobile/inventoryWaste.mobile.schema'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { planGateMessage } from '../planGate'
import { requireWriteScopeAlways } from '../requireWriteScopeAlways'

const FEATURE = 'INVENTORY_TRACKING'
const PERMISSION = 'inventory:log-waste'
const DEFAULT_TZ = 'America/Mexico_City'
/** Cuántos candidatos se enseñan cuando un nombre es ambiguo. */
const CANDIDATE_CAP = 10
/** Página por defecto del listado: legible para un LLM. El tope (200) lo impone el servidor. */
const DEFAULT_PAGE_SIZE = 50

/** `UNSPECIFIED` es sólo del adaptador del dashboard; el servicio lo rechaza fuera de él. */
const MCP_REASON_CODES = WASTE_REASON_CODES.filter(code => code !== 'UNSPECIFIED') as [WasteReasonCode, ...WasteReasonCode[]]
const REASON_LIST = MCP_REASON_CODES.map(code => `${code} = ${WASTE_REASONS[code].label}`).join('; ')

/** Texto decimal estricto (como el contrato del POS): sin signo, exponente, hexadecimal ni miles. */
const STRICT_DECIMAL = /^\d+(?:\.\d+)?$/
const LOCAL_DAY = /^(\d{4})-(\d{2})-(\d{2})$/

/** Unidades que se dicen con abreviatura (invariable). */
const UNIT_ABBR: Record<string, string> = {
  GRAM: 'g',
  KILOGRAM: 'kg',
  MILLIGRAM: 'mg',
  POUND: 'lb',
  OUNCE: 'oz',
  TON: 't',
  MILLILITER: 'ml',
  LITER: 'L',
  METER: 'm',
  CENTIMETER: 'cm',
  MILLIMETER: 'mm',
}

/** Unidades que se dicen con palabra: [singular, plural]. */
const UNIT_WORDS: Record<string, [string, string]> = {
  UNIT: ['unidad', 'unidades'],
  PIECE: ['pieza', 'piezas'],
  DOZEN: ['docena', 'docenas'],
  CASE: ['caja', 'cajas'],
  BOX: ['caja', 'cajas'],
  BAG: ['bolsa', 'bolsas'],
  BOTTLE: ['botella', 'botellas'],
  CAN: ['lata', 'latas'],
  JAR: ['frasco', 'frascos'],
  CUP: ['taza', 'tazas'],
  TABLESPOON: ['cucharada', 'cucharadas'],
  TEASPOON: ['cucharadita', 'cucharaditas'],
  GALLON: ['galón', 'galones'],
  QUART: ['cuarto de galón', 'cuartos de galón'],
  PINT: ['pinta', 'pintas'],
  FLUID_OUNCE: ['onza líquida', 'onzas líquidas'],
  INCH: ['pulgada', 'pulgadas'],
  FOOT: ['pie', 'pies'],
}

function cantidadLegible(quantity: Prisma.Decimal, unit: string): string {
  const q = quantity.toString()
  const abbr = UNIT_ABBR[unit]
  if (abbr) return `${q} ${abbr}`
  const words = UNIT_WORDS[unit]
  if (words) return `${q} ${quantity.eq(1) ? words[0] : words[1]}`
  return `${q} ${unit}`
}

function unidadLegible(unit: string): string {
  return UNIT_ABBR[unit] ?? UNIT_WORDS[unit]?.[1] ?? unit
}

const COST_STATE_LABEL: Record<string, string> = {
  KNOWN: 'Con costo',
  PARTIAL: 'Costo parcial: una parte quedó sin valorar',
  UNKNOWN: 'Sin valorar: el artículo no tenía costo',
  NONE: 'Sin costo: no había existencia que descontar',
}

const SOURCE_LABEL: Record<string, string> = {
  POS: 'Punto de venta',
  DASHBOARD: 'Dashboard',
  MCP: 'Asistente (MCP)',
}

/**
 * La huella que ata el folio a la vista previa. `payloadHash` ya cubre al autor, el artículo, la
 * cantidad, la unidad, el motivo y la nota; aquí se le suman el venue y el folio. No es un secreto:
 * sirve para que una confirmación que DERIVÓ de la vista previa (otra cantidad, otro artículo) se
 * detecte en vez de escribirse.
 */
function previewDigest(venueId: string, payload: { idempotencyKey: string; payloadHash: string }): string {
  return createHash('sha256')
    .update(JSON.stringify(['log_waste', venueId, payload.idempotencyKey, payload.payloadHash]))
    .digest('hex')
    .slice(0, 32)
}

function wasteInput(
  fields: {
    itemType: WasteItem['itemType']
    itemId: string
    unit: string
    quantity: string | number
    reasonCode: WasteReasonCode
    note?: string
  },
  idempotencyKey: string,
): WasteInput {
  return {
    itemType: fields.itemType,
    itemId: fields.itemId,
    quantity: fields.quantity,
    unit: fields.unit,
    reasonCode: fields.reasonCode,
    note: fields.note,
    idempotencyKey,
    source: 'MCP',
  }
}

/** Un día local `AAAA-MM-DD` que exista en el calendario. Se valida por componentes (`Date.UTC`),
 *  nunca con `new Date('AAAA-MM-DD')`, que el runtime lee como medianoche UTC. */
function assertLocalDay(value: string, campo: string): void {
  const m = LOCAL_DAY.exec(value)
  const y = m ? Number(m[1]) : NaN
  const mo = m ? Number(m[2]) : NaN
  const d = m ? Number(m[3]) : NaN
  const probe = new Date(Date.UTC(y, mo - 1, d))
  const real = !!m && probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d
  if (!real) {
    throw new ValidationError(`${campo} debe ser un día real con formato AAAA-MM-DD (día local del negocio).`, 'INVALID_WASTE_PAYLOAD')
  }
}

/**
 * Día local del negocio → instante ISO CON zona, que es lo único que acepta el lector. El texto
 * se interpreta en la zona del VENUE (`fromZonedTime` con una cadena), así que el resultado no
 * depende de la zona del host: medianoche de CDMX es 06:00Z con el servidor en UTC o en CDMX.
 */
function venueDayStart(day: string, tz: string): string {
  return fromZonedTime(`${day}T00:00:00.000`, tz).toISOString()
}

function venueDayEnd(day: string, tz: string): string {
  return fromZonedTime(`${day}T23:59:59.999`, tz).toISOString()
}

async function venueTimezone(venueId: string): Promise<string> {
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
  return venue?.timezone || DEFAULT_TZ
}

function num(value: Prisma.Decimal | null): number | null {
  return value === null ? null : Number(value.toString())
}

type WasteReportRow = Awaited<ReturnType<typeof listWasteReports>>['items'][number]

function reportRow(r: WasteReportRow) {
  const author = r.reportedByStaff ? `${r.reportedByStaff.firstName ?? ''} ${r.reportedByStaff.lastName ?? ''}`.trim() : ''
  return {
    reportId: r.id,
    createdAt: r.createdAt.toISOString(),
    itemType: r.itemType,
    itemId: r.rawMaterialId ?? r.productId,
    item: r.rawMaterial?.name ?? r.product?.name ?? null,
    sku: r.rawMaterial?.sku ?? r.product?.sku ?? null,
    unit: r.unit,
    reasonCode: r.reasonCode,
    // Sólo salen folios aplicados, que siempre traen motivo; el `null` es de las lápidas.
    reason: r.reasonCode && isWasteReasonCode(r.reasonCode) ? WASTE_REASONS[r.reasonCode].label : r.reasonCode,
    declared: num(r.declaredQuantity),
    deducted: num(r.deductedQuantity),
    withoutStock: num(r.unrecordedQuantity),
    // PESOS 1:1. `null` = sin valorar, que NO es cero.
    costPesos: num(r.costImpact),
    costState: COST_STATE_LABEL[r.costState] ?? r.costState,
    unitCostPesos: num(r.unitCostSnapshot),
    note: r.note,
    reference: r.reference,
    supplier: r.supplier,
    source: SOURCE_LABEL[r.source] ?? r.source,
    reportedBy: author || null,
    occurredOnDeviceAt: r.clientOccurredAt?.toISOString() ?? null,
  }
}

export function registerInventoryWasteTools(server: McpServer, scope: McpScope): void {
  const guard = createGuard(scope)

  /** Plan y permiso completo (activación white-label + permiso, leído ahora). `null` = pasa. */
  async function writeGates(venueId: string, access: UserAccess) {
    const gate = await planGateMessage(venueId, FEATURE, 'Registrar merma')
    if (gate) return text({ ok: false, planRequired: true, featureCode: FEATURE, error: gate })
    if (!hasWastePermission(access, PERMISSION)) {
      throw new ForbiddenError(
        'No tienes permiso para registrar merma en este local, o el inventario no está habilitado para tu usuario. Pídeselo a tu administrador.',
        'WASTE_PERMISSION_DENIED',
      )
    }
    return null
  }

  server.tool(
    'log_waste',
    'Registra una MERMA en un local que puedas operar: un producto o insumo que se tiró, se echó a perder, se rompió, se cayó o caducó. ' +
      'Se descuenta de la existencia hasta donde alcance y lo que no haya queda anotado como «sin existencia»: la merma nunca se rechaza por falta de existencia y el inventario nunca queda negativo. ' +
      'Indica el artículo por nombre (name) o con itemType + itemId; si el nombre coincide con varios, te devuelve los candidatos para que el operador elija — no escojas tú. ' +
      `Motivos (reasonCode): ${REASON_LIST} (OTHER exige nota). ` +
      'Funciona en DOS pasos: la primera llamada sólo devuelve una vista previa (artículo, cantidad con unidad, motivo) y un folio, sin mover nada. Enséñasela al operador y, sólo con su confirmación expresa, vuelve a llamar con los datos de confirmationPayload tal cual (incluyen confirm:true, el folio y su huella). ' +
      'Repetir la confirmación con el mismo folio no duplica la merma. No se puede deshacer desde aquí. ' +
      'Escribe: requiere el permiso inventory:log-waste y una conexión con permiso de escritura. PREMIUM (INVENTORY_TRACKING).',
    {
      venueId: z.string().min(1).describe('Local donde se registra la merma (debe estar en tu alcance)'),
      name: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe('Nombre (o parte) o SKU del producto o insumo — alternativa a itemType + itemId, sólo para la vista previa'),
      itemType: z
        .enum(['RAW_MATERIAL', 'PRODUCT'])
        .optional()
        .describe('RAW_MATERIAL = insumo; PRODUCT = producto con inventario por cantidad'),
      itemId: z.string().min(1).max(100).optional().describe('Id del artículo (de los candidatos o de confirmationPayload)'),
      quantity: z
        .union([z.number().finite().positive(), z.string().regex(STRICT_DECIMAL, 'La cantidad debe ser un número decimal positivo.')])
        .describe('Cantidad mermada, en la unidad del artículo, con hasta 3 decimales (ej. 2 o 0.25)'),
      unit: z
        .string()
        .min(1)
        .max(64)
        .optional()
        .describe('Unidad del artículo; si la omites en la vista previa se usa la suya. Debe coincidir con la del artículo'),
      reasonCode: z.enum(MCP_REASON_CODES).describe('Motivo de la merma (ver la lista en la descripción)'),
      note: z.string().max(280).optional().describe('Nota libre, hasta 280 caracteres (obligatoria con OTHER)'),
      idempotencyKey: z.string().uuid().optional().describe('Folio que dio la vista previa — sólo al confirmar'),
      previewDigest: z.string().max(128).optional().describe('Huella que dio la vista previa — sólo al confirmar'),
      confirm: z.boolean().optional().describe('true sólo tras la confirmación expresa del operador, con los datos de confirmationPayload'),
    },
    async args => {
      const { venueId } = args
      guard.venueFilter(venueId) // lanza si el venue no está en el alcance
      requireWriteScopeAlways(scope, PERMISSION, 'descuenta existencias del inventario')
      guard.requirePermission(PERMISSION, venueId) // el rol conectado en ESE venue
      const confirm = args.confirm === true

      if (confirm && !args.idempotencyKey) {
        throw new ValidationError(
          'Para confirmar usa el folio (idempotencyKey) que dio la vista previa; si no la tienes, pídela primero.',
          'INVALID_WASTE_KEY',
        )
      }
      if (typeof args.quantity === 'string' && !STRICT_DECIMAL.test(args.quantity)) {
        throw new ValidationError('La cantidad debe ser un número decimal positivo, como 2 o 2.5.', 'INVALID_WASTE_PAYLOAD')
      }

      // Membresía vigente y cuenta activa, leídas AHORA: el token puede ser más viejo que una baja.
      const access = await getWasteAccess(scope.staffId, venueId)

      if (confirm) {
        if (!args.itemType || !args.itemId || !args.unit) {
          throw new ValidationError(
            'Confirma con los datos de confirmationPayload tal cual: falta el artículo exacto (itemType, itemId y unit).',
            'INVALID_WASTE_PAYLOAD',
          )
        }
        const input = wasteInput(
          {
            itemType: args.itemType,
            itemId: args.itemId,
            unit: args.unit,
            quantity: args.quantity,
            reasonCode: args.reasonCode,
            note: args.note,
          },
          args.idempotencyKey as string,
        )
        const payload = prepareWaste(scope.staffId, input)

        // El mismo folio con los mismos datos ya aplicado: se devuelve tal cual, sin registrar otra vez.
        const recovered = await recoverByKey(venueId, payload.idempotencyKey, scope.staffId, payload.payloadHash)
        if (recovered) return text({ ok: true, report: recovered })

        if (args.previewDigest !== previewDigest(venueId, payload)) {
          throw new ValidationError(
            'Estos datos no son los de la vista previa que vio el operador (artículo, cantidad, unidad, motivo o nota cambiaron). Pide una vista previa nueva y confírmala tal cual.',
            'WASTE_PREVIEW_MISMATCH',
          )
        }

        const blocked = await writeGates(venueId, access)
        if (blocked) return blocked
        return text({ ok: true, report: await logWaste(venueId, scope.staffId, input) })
      }

      // ── Vista previa ──────────────────────────────────────────────────────────────────────
      const blocked = await writeGates(venueId, access)
      if (blocked) return blocked

      let item: WasteItem | null = null
      const name = args.name?.trim()
      if (args.itemId) {
        if (!args.itemType) {
          return text({
            ok: false,
            error: 'Indica itemType (RAW_MATERIAL = insumo, PRODUCT = producto) junto con itemId, o busca el artículo por name.',
          })
        }
        item = await findWasteItem(venueId, args.itemType, args.itemId)
      } else if (name) {
        const found = await listWasteItems(venueId, { page: 1, pageSize: CANDIDATE_CAP, search: name })
        const matches = args.itemType ? found.items.filter(i => i.itemType === args.itemType) : found.items
        const more = found.total > found.items.length
        if (matches.length === 1 && !more) {
          item = matches[0]
        } else if (matches.length > 0 || more) {
          return text({
            ok: false,
            ambiguous: true,
            totalMatches: found.total,
            error: `"${name}" coincide con varios artículos. Pregúntale al operador cuál es y vuelve a llamar con su itemType e itemId; no elijas tú.`,
            candidates: matches.map(i => ({ itemType: i.itemType, itemId: i.itemId, name: i.name, sku: i.sku, unit: i.unit })),
          })
        }
      } else {
        return text({ ok: false, error: 'Indica el artículo: su nombre (name) o itemType + itemId.' })
      }

      if (!item) {
        // Resolver, no adivinar: no se ofrece otro artículo en su lugar.
        return text({
          ok: false,
          notFound: true,
          error:
            'No encontré ese artículo en este negocio entre los que admiten merma (insumos activos y productos con inventario por cantidad). No registres otro en su lugar.',
        })
      }

      if (args.unit && args.unit !== item.unit) {
        return text({
          ok: false,
          code: 'UNIT_MISMATCH',
          expectedUnit: item.unit,
          error: `«${item.name}» se lleva en ${unidadLegible(item.unit)} (${item.unit}), no en ${args.unit}. Vuelve a pedir la vista previa con unit "${item.unit}", convirtiendo la cantidad si hace falta.`,
        })
      }

      // `prepareWaste` valida cantidad, motivo y nota ANTES de emitir un folio.
      const payload = prepareWaste(
        scope.staffId,
        wasteInput(
          {
            itemType: item.itemType,
            itemId: item.itemId,
            unit: item.unit,
            quantity: args.quantity,
            reasonCode: args.reasonCode,
            note: args.note,
          },
          randomUUID(),
        ),
      )
      const cantidad = cantidadLegible(payload.quantity, payload.unit)
      const motivo = WASTE_REASONS[payload.reasonCode].label
      const tipo = item.itemType === 'PRODUCT' ? 'Producto' : 'Insumo'
      const nota = payload.note ? `, nota: «${payload.note}»` : ''

      return text({
        ok: false,
        requiresConfirmation: true,
        preview: {
          articulo: item.name,
          sku: item.sku ?? null,
          tipo,
          cantidad,
          motivo,
          nota: payload.note,
          folio: payload.idempotencyKey,
        },
        message:
          `Vas a registrar una merma de ${cantidad} de «${item.name}» (${tipo.toLowerCase()}), motivo: ${motivo}${nota}. ` +
          'Se descuenta de la existencia hasta donde alcance; lo que no haya queda anotado como «sin existencia». No se puede deshacer. ' +
          `Folio: ${payload.idempotencyKey}. Confirma con el operador y, sólo con su sí, vuelve a llamar con los datos de confirmationPayload tal cual (confirm:true).`,
        confirmationPayload: {
          venueId,
          itemType: item.itemType,
          itemId: item.itemId,
          quantity: payload.quantity.toString(),
          unit: payload.unit,
          reasonCode: payload.reasonCode,
          ...(payload.note !== null ? { note: payload.note } : {}),
          idempotencyKey: payload.idempotencyKey,
          previewDigest: previewDigest(venueId, payload),
          confirm: true,
        },
      })
    },
  )

  server.tool(
    'list_waste_reports',
    'Lista las mermas registradas (folios) de un local que puedas ver: qué artículo, cuánto se declaró, cuánto se descontó de la existencia y cuánto quedó «sin existencia», el motivo, el costo en pesos (MXN) cuando se conoce — «sin valorar» cuando no, que NO es cero —, quién la registró, por dónde (punto de venta, dashboard o asistente) y cuándo. ' +
      'Incluye las declaraciones que no pudieron descontar nada. Más recientes primero, paginado (hasta 200 por página) con el total. ' +
      'fromDate / toDate son días LOCALES del negocio (AAAA-MM-DD, inclusivos). ' +
      'No incluye las bajas automáticas por caducidad ni las mermas antiguas previas a los folios: para el historial completo de movimientos usa get_inventory_movements. ' +
      'Responde «¿qué mermas hubo esta semana?», «¿quién tiró qué?». Requiere inventory:read. PREMIUM (INVENTORY_TRACKING).',
    {
      venueId: z.string().min(1).describe('Local cuyas mermas quieres ver (debe estar en tu alcance)'),
      fromDate: z.string().regex(LOCAL_DAY, 'Usa AAAA-MM-DD.').optional().describe('Primer día local, AAAA-MM-DD (inclusivo)'),
      toDate: z
        .string()
        .regex(LOCAL_DAY, 'Usa AAAA-MM-DD.')
        .optional()
        .describe('Último día local, AAAA-MM-DD (inclusivo, el día completo)'),
      search: z.string().max(200).optional().describe('Filtra por nombre o SKU del artículo'),
      page: z.number().int().positive().optional().describe('Página, desde 1 (default 1)'),
      pageSize: z.number().int().positive().optional().describe('Folios por página (default 50; el servidor recorta a 200)'),
    },
    async ({ venueId, fromDate, toDate, search, page, pageSize }) => {
      guard.venueFilter(venueId) // lanza si el venue no está en el alcance
      guard.requirePermission('inventory:read', venueId) // el mismo candado que la ruta del dashboard
      const gate = await planGateMessage(venueId, FEATURE, 'Consultar las mermas')
      if (gate) return text({ ok: false, planRequired: true, featureCode: FEATURE, error: gate })

      if (fromDate !== undefined) assertLocalDay(fromDate, 'fromDate')
      if (toDate !== undefined) assertLocalDay(toDate, 'toDate')
      const tz = await venueTimezone(venueId)
      const query = parseWasteSchema(WasteQuerySchema, {
        page: page ?? 1,
        pageSize: pageSize ?? DEFAULT_PAGE_SIZE,
        search,
        startDate: fromDate !== undefined ? venueDayStart(fromDate, tz) : undefined,
        endDate: toDate !== undefined ? venueDayEnd(toDate, tz) : undefined,
      })

      const result = await listWasteReports(venueId, query)
      const totalPages = result.pageSize > 0 ? Math.ceil(result.total / result.pageSize) : 0
      return text({
        ok: true,
        venueId,
        timezone: tz,
        fromDate: fromDate ?? null,
        toDate: toDate ?? null,
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
        totalPages,
        hasMore: result.page * result.pageSize < result.total,
        reports: result.items.map(reportRow),
      })
    },
  )
}
