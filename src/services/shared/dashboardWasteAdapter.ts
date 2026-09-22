/**
 * Adaptador de la merma del DASHBOARD al libro de merma (spec §4.5).
 *
 * Las dos rutas `adjust-stock` del dashboard web conservan su contrato (forma de entrada y de
 * salida), pero una merma — `SPOILAGE` de insumo o `LOSS` de producto, con cantidad NEGATIVA — ya
 * no escribe el movimiento suelto: entra por aquí a `logWaste`, el mismo motor que usa el POS. Así
 * las dos mermas viven en el mismo libro y la del dashboard deja de rechazarse cuando supera la
 * existencia (decisión del founder: se descuenta lo que haya y se marca el excedente).
 *
 * Traducción del contrato viejo:
 * - `quantity` negativa → cantidad declarada POSITIVA; el tope sigue siendo 999 999 999.999
 *   (`prepareWaste` con `source: 'DASHBOARD'`).
 * - `reasonCode` del cuerpo, o `UNSPECIFIED` si no viene (el dashboard de hoy no lo manda).
 * - `reason` ÍNTEGRA a `note` (sin tope, puede faltar); `reference`, `unitCost` y `supplier` se
 *   conservan. `unitCost: 0` es un costo conocido; ausente = sin costo recibido.
 * - Folio del cuerpo, o uno generado por el servidor (el dashboard de hoy no lo manda).
 *
 * Devuelve el resumen del folio (`waste`) y el artículo después de la merma (`item`: la fila del
 * insumo, o el `Inventory` del producto), que es lo que las rutas ya respondían: así el controlador
 * sólo arma la respuesta y no lee la base. El artículo se lee dentro de la transacción de la merma,
 * antes del COMMIT: o sale la respuesta, o no queda nada aplicado.
 *
 * 🔴 UN SOLO candado de permiso (Rulings 18 y 20): aquí NO se evalúa el permiso. Lo decide
 * `checkPermission('inventory:adjust')` de la ruta, que respeta el PIN de gerente; una segunda
 * evaluación que no lo conoce contestaría 403 con el PIN ya gastado. Tampoco se aplica la
 * activación white-label ni `Staff.active`: las rutas hermanas de inventario del dashboard no lo
 * hacen, y un candado sólo aquí haría que dos rutas contestaran distinto al mismo usuario.
 */
import { randomUUID } from 'crypto'
import { Inventory, Prisma, RawMaterial, WasteItemType } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import AppError, { ConflictError, UnauthorizedError } from '../../errors/AppError'
import { MASTER_ADMIN_PRINCIPAL_ID } from '../../lib/authPrincipals'
import { logWaste, normalizeWasteKey, WasteSummary } from './inventoryWaste.service'
import { WasteReasonCode } from './wasteReasons'

export interface DashboardWasteInput {
  /** Negativa en el contrato viejo; se toma su valor absoluto. */
  quantity: number
  reason?: string
  reference?: string
  unitCost?: number
  supplier?: string
  reasonCode?: WasteReasonCode
  idempotencyKey?: string
}

/**
 * ¿Hay un autor humano con fila en `Staff`? `reportedByStaffId` es una llave a `Staff`: el acceso
 * de emergencia (`MASTER_ADMIN`, principal sintético) no la tiene, y el adaptador no inventa un
 * autor. Las rutas mandan a esos principales por el camino viejo (movimiento sin folio), que los
 * lectores de merma ya cuentan.
 */
export function canRecordDashboardWaste(staffId: string | undefined): staffId is string {
  return Boolean(staffId) && staffId !== MASTER_ADMIN_PRINCIPAL_ID
}

/**
 * La unidad con la que se registra. Un reintento con el MISMO folio reusa la del reporte ya
 * aplicado: el contrato viejo no manda unidad, y si el artículo cambió de unidad entre medio, la
 * huella del reintento no coincidiría y un reintento legítimo saldría como folio reutilizado.
 *
 * Las validaciones de artículo son las MISMAS del camino viejo, con sus mensajes y códigos HTTP
 * (`rawMaterial.service.adjustStock`, `productInventory.service.adjustInventoryStock`): el
 * dashboard los muestra tal cual.
 */
async function resolveUnit(venueId: string, itemType: WasteItemType, itemId: string, idempotencyKey: string): Promise<string> {
  const existing = await prisma.inventoryWasteReport.findUnique({
    where: { venueId_idempotencyKey: { venueId, idempotencyKey } },
    select: { status: true, unit: true },
  })
  if (existing?.status === 'VOIDED') {
    throw new ConflictError('Este folio fue anulado.', 'WASTE_VOIDED')
  }
  if (existing) {
    if (existing.unit === null) throw new Error('Reporte de merma aplicado sin unidad.')
    return existing.unit
  }

  if (itemType === 'RAW_MATERIAL') {
    const item = await prisma.rawMaterial.findFirst({ where: { id: itemId, venueId }, select: { unit: true } })
    if (!item) throw new AppError(`Raw material with ID ${itemId} not found`, 404)
    return item.unit
  }

  const item = await prisma.product.findFirst({
    where: { id: itemId, venueId },
    select: { unit: true, trackInventory: true, inventoryMethod: true, inventory: { select: { id: true } } },
  })
  if (!item) throw new AppError(`Product with ID ${itemId} not found`, 404)
  if (!item.trackInventory || item.inventoryMethod !== 'QUANTITY') {
    throw new AppError(`Product ${itemId} does not use QUANTITY tracking`, 400)
  }
  if (!item.inventory) throw new AppError(`Product ${itemId} has no inventory record`, 404)
  return item.unit ?? 'UNIT'
}

/** Lo que responde el adaptador: el resumen del folio y el artículo ya releído. */
export interface DashboardWasteResult<Item> {
  waste: WasteSummary
  item: Item
}

export async function adaptDashboardWaste(
  venueId: string,
  staffId: string | undefined,
  itemType: 'RAW_MATERIAL',
  itemId: string,
  input: DashboardWasteInput,
): Promise<DashboardWasteResult<RawMaterial>>
export async function adaptDashboardWaste(
  venueId: string,
  staffId: string | undefined,
  itemType: 'PRODUCT',
  itemId: string,
  input: DashboardWasteInput,
): Promise<DashboardWasteResult<Inventory>>
export async function adaptDashboardWaste(
  venueId: string,
  staffId: string | undefined,
  itemType: WasteItemType,
  itemId: string,
  input: DashboardWasteInput,
): Promise<DashboardWasteResult<RawMaterial | Inventory>> {
  if (!canRecordDashboardWaste(staffId)) throw new UnauthorizedError()

  const idempotencyKey = normalizeWasteKey(input.idempotencyKey ?? randomUUID())
  const unit = await resolveUnit(venueId, itemType, itemId, idempotencyKey)

  // La fila que respondía la ruta se lee DENTRO de la transacción de logWaste, después de los efectos
  // y antes del COMMIT, acotada al venue (Codex P2-2): leerla después dejaba una ventana en que la
  // merma ya estaba confirmada y la ruta contestaba error, y el dashboard de hoy reintenta SIN folio.
  // La alerta de existencia baja tampoco va aquí: la evalúa logWaste después del COMMIT (Opus I1).
  return logWaste(
    venueId,
    staffId,
    {
      itemType,
      itemId,
      quantity: new Prisma.Decimal(input.quantity).abs(),
      unit,
      reasonCode: input.reasonCode ?? 'UNSPECIFIED',
      note: input.reason,
      reference: input.reference,
      unitCost: input.unitCost,
      supplier: input.supplier,
      idempotencyKey,
      source: 'DASHBOARD',
    },
    async (tx, waste): Promise<DashboardWasteResult<RawMaterial | Inventory>> => ({
      waste,
      item:
        itemType === 'RAW_MATERIAL'
          ? await tx.rawMaterial.findFirstOrThrow({ where: { id: itemId, venueId } })
          : await tx.inventory.findFirstOrThrow({ where: { venueId, productId: itemId } }),
    }),
  )
}
