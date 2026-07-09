import {
  PrismaClient,
  SerializedItem,
  SerializedItemStatus,
  SerializedItemCustodyState,
  ItemCategory,
  Prisma,
  SimCustodyEnforcementMode,
  StaffRole,
} from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { moduleService, MODULE_CODES } from '../modules/module.service'
import { getMergedCategories } from '../dashboard/category-resolution.service'
import logger from '@/config/logger'
import { SimCustodyError } from '../../lib/sim-custody-error-codes'
import { buildCustodyDataForScanner } from './custodyAssignment.helper'

// ==========================================
// SERIAL NORMALIZATION
// Barcodes for the same physical item can arrive with different casing or
// surrounding whitespace depending on the capture path (bulk file import vs
// live barcode scanner). ICCIDs in particular carry a trailing hex check
// nibble that scanners may emit as 'f' while a bulk upload stored 'F'. Without
// normalization the case-sensitive unique lookup misses the existing item and
// the sale flow registers a DUPLICATE marked SOLD, leaving the real inventory
// item AVAILABLE forever (inventory inflation + phantom sales).
//
// Canonical form = trimmed + UPPERCASE (matches the dominant stored form).
// Apply at every public entry point that accepts a serial.
// ==========================================
export function normalizeSerial(serial: string): string {
  return serial.trim().toUpperCase()
}

function normalizeSerials(serials: string[]): string[] {
  return serials.map(normalizeSerial)
}

/**
 * Mexican ICCID format guard per ITU-T E.118: `8952` (MII 89 + country MX 52) +
 * 15-16 digits + optional trailing `F` (BCD padding). Verified against 1,021 real
 * ALTAN SIMs. Mirrors the TPV regex (SerializedInventoryViewModel.kt MX_ICCID_REGEX).
 * Defense-in-depth: the TPV validates first, this re-validates server-side.
 */
const MX_ICCID_REGEX = /^8952\d{15,16}F?$/
export function isValidMxIccid(raw: string): boolean {
  return MX_ICCID_REGEX.test(normalizeSerial(raw))
}

// ==========================================
// SCAN RESULT TYPES
// ==========================================
export type ScanStatus = 'available' | 'already_sold' | 'not_registered' | 'module_disabled'

export interface ScanResult {
  found: boolean
  item: (SerializedItem & { category: ItemCategory }) | null
  category: ItemCategory | null
  status: ScanStatus
  suggestedPrice: number | null
}

export interface RegisterBatchResult {
  created: number
  duplicates: string[]
  assignedToYou: number
}

// ==========================================
// ORDER ITEM DATA
// Data to create an OrderItem for a SerializedItem.
// CRITICAL: productName and productSku must be filled manually.
// ==========================================
export interface OrderItemData {
  productName: string // From ItemCategory.name
  productSku: string // From SerializedItem.serialNumber
  unitPrice: Prisma.Decimal
  quantity: number // Always 1 for serialized items
  total: Prisma.Decimal // Changed from subtotal to match Prisma schema
  taxAmount: Prisma.Decimal // Required by OrderItem schema
  productId: null // SerializedItems don't have a Product
}

// ==========================================
// SERIALIZED INVENTORY SERVICE
// Manages items with unique barcodes (SIMs, jewelry, electronics).
// IMPORTANT: SerializedItem does NOT have price - price is captured at sale.
// ==========================================
export class SerializedInventoryService {
  constructor(private db: PrismaClient = prisma) {}

  /**
   * Scans a barcode and returns item information.
   *
   * @returns ScanResult with status:
   * - 'available': Item exists and is available for sale
   * - 'already_sold': Item exists but was already sold
   * - 'not_registered': Item doesn't exist in system
   * - 'module_disabled': Module is not enabled for this venue
   */
  async scan(venueId: string, serialNumber: string): Promise<ScanResult> {
    serialNumber = normalizeSerial(serialNumber)
    // Verify module is enabled
    const isEnabled = await moduleService.isModuleEnabled(venueId, MODULE_CODES.SERIALIZED_INVENTORY)

    if (!isEnabled) {
      return {
        found: false,
        item: null,
        category: null,
        status: 'module_disabled',
        suggestedPrice: null,
      }
    }

    // 1. Search for existing item at venue level.
    // Case-insensitive defense-in-depth: `serialNumber` is normalized upper-case
    // above, but a few legacy rows were stored lowercase (bulk-upload bug), which
    // made them wrongly "not_registered" and unsellable. Match case-insensitively
    // so the scan always finds the SIM. (Asana 1215767957979215, 2026-06-16.)
    const item = await this.db.serializedItem.findFirst({
      where: { venueId, serialNumber: { equals: serialNumber, mode: 'insensitive' } },
      include: { category: true },
    })

    if (item) {
      if (item.status === 'SOLD') {
        return {
          found: true,
          item,
          category: item.category,
          status: 'already_sold',
          suggestedPrice: null,
        }
      }

      return {
        found: true,
        item,
        category: item.category,
        status: 'available',
        suggestedPrice: item.category.suggestedPrice ? Number(item.category.suggestedPrice) : null,
      }
    }

    // 2. Fallback: search for org-level item
    const orgItem = await this.findOrgItem(venueId, serialNumber)

    if (orgItem) {
      if (orgItem.status === 'SOLD') {
        return {
          found: true,
          item: orgItem,
          category: orgItem.category,
          status: 'already_sold',
          suggestedPrice: null,
        }
      }

      return {
        found: true,
        item: orgItem,
        category: orgItem.category,
        status: 'available',
        suggestedPrice: orgItem.category.suggestedPrice ? Number(orgItem.category.suggestedPrice) : null,
      }
    }

    // 3. Item not found - try to categorize by pattern (venue + org categories)
    const matchedCategory = await this.findCategoryByPattern(venueId, serialNumber)

    return {
      found: false,
      item: null,
      category: matchedCategory,
      status: 'not_registered',
      suggestedPrice: matchedCategory?.suggestedPrice ? Number(matchedCategory.suggestedPrice) : null,
    }
  }

  /**
   * Registers a new item (inventory registration).
   */
  async register(data: {
    venueId: string
    categoryId: string
    serialNumber: string
    createdBy: string
  }): Promise<SerializedItem & { category: ItemCategory }> {
    return this.db.serializedItem.create({
      data: {
        venueId: data.venueId,
        categoryId: data.categoryId,
        serialNumber: normalizeSerial(data.serialNumber),
        createdBy: data.createdBy,
        status: 'AVAILABLE',
      },
      include: { category: true },
    })
  }

  /**
   * Registers multiple items in batch (bulk registration).
   *
   * @returns Object with count of created items and list of duplicate serial numbers
   */
  async registerBatch(data: {
    venueId: string
    categoryId: string
    serialNumbers: string[]
    createdBy: string
    scannerRole?: StaffRole
  }): Promise<RegisterBatchResult> {
    data = { ...data, serialNumbers: normalizeSerials(data.serialNumbers) }
    const custodyData = buildCustodyDataForScanner(data.scannerRole, data.createdBy)
    const eventType =
      custodyData.custodyState === 'PROMOTER_HELD'
        ? 'ASSIGNED_TO_PROMOTER'
        : custodyData.custodyState === 'SUPERVISOR_HELD'
          ? 'ASSIGNED_TO_SUPERVISOR'
          : null

    // Detect duplicates BEFORE the write transaction. Reading outside the
    // transaction is safe because uniqueness is enforced by the DB constraint:
    // any race with a concurrent insert of the same serial would surface as a
    // P2002 from createMany below, which we catch and treat as duplicates.
    const existing = await prisma.serializedItem.findMany({
      where: { venueId: data.venueId, serialNumber: { in: data.serialNumbers } },
      select: { serialNumber: true },
    })
    const existingSet = new Set(existing.map(e => e.serialNumber))
    const duplicates = data.serialNumbers.filter(sn => existingSet.has(sn))
    const toInsert = data.serialNumbers.filter(sn => !existingSet.has(sn))

    if (toInsert.length === 0) {
      return { created: 0, duplicates, assignedToYou: 0 }
    }

    // Single transaction with two bulk queries instead of N×3 sequential
    // queries. For an 80-SIM batch this drops from ~240 round trips to 2,
    // taking the duration from ~6s (over Prisma's 5s default) to ~200ms.
    // 30s timeout is belt-and-suspenders for very large batches (500+).
    const created = await this.db.$transaction(
      async tx => {
        const items = await tx.serializedItem.createManyAndReturn({
          data: toInsert.map(serialNumber => ({
            venueId: data.venueId,
            categoryId: data.categoryId,
            serialNumber,
            createdBy: data.createdBy,
            status: 'AVAILABLE' as const,
            ...custodyData,
          })),
          select: { id: true, serialNumber: true },
          skipDuplicates: true, // race with concurrent insert → silently skip
        })

        if (eventType && custodyData.custodyState && items.length > 0) {
          await tx.serializedItemCustodyEvent.createMany({
            data: items.map(item => ({
              serializedItemId: item.id,
              serialNumber: item.serialNumber,
              eventType,
              fromState: null,
              toState: custodyData.custodyState!,
              fromStaffId: null,
              toStaffId: data.createdBy,
              actorStaffId: data.createdBy,
            })),
          })
        }
        return items
      },
      { timeout: 30000 },
    )

    // If skipDuplicates ate any rows due to a race, surface them as duplicates
    // so the response stays consistent with the old behavior.
    const createdSerials = new Set(created.map(c => c.serialNumber))
    for (const sn of toInsert) {
      if (!createdSerials.has(sn)) duplicates.push(sn)
    }

    return { created: created.length, duplicates, assignedToYou: custodyData.custodyState ? created.length : 0 }
  }

  /**
   * Marks an item as sold (called from OrderService).
   * PRICE is passed to OrderItem.unitPrice, NOT stored in SerializedItem.
   *
   * Plan §1.5 — SIM custody precheck is gated by Organization.simCustodyEnforcementMode:
   *   - OFF (default)  — legacy behavior, no custody check
   *   - WARN           — logs a warning, returns a deprecation hint (caller sets header)
   *   - ENFORCE        — throws SIM_NOT_ACCEPTED if the Promoter hasn't accepted the SIM
   *
   * Anti-drift (plan §1.2): when status→SOLD, custodyState→SOLD in the same UPDATE.
   *
   * @param staffId - Optional. When provided, the Promoter-ownership + custody
   *                  acceptance precheck runs (subject to enforcement mode).
   *                  When omitted, legacy callers (dashboard, reconciliation
   *                  scripts) skip the precheck entirely.
   */
  async markAsSold(
    venueId: string,
    serialNumber: string,
    orderItemId: string,
    tx?: Prisma.TransactionClient,
    opts?: { staffId?: string; appVersionCode?: number; minimumVersionWithMisSims?: number },
  ): Promise<{ item: SerializedItem; deprecationWarning: string | null }> {
    serialNumber = normalizeSerial(serialNumber)
    const client = tx || this.db

    // 1. Locate item (venue-level first, org-level fallback)
    const item =
      (await client.serializedItem.findUnique({
        where: { venueId_serialNumber: { venueId, serialNumber } },
      })) ?? (await this.findOrgItem(venueId, serialNumber, client))

    if (!item) {
      // Preserve legacy error surface: attempt update to trigger Prisma's not-found.
      const updated = await client.serializedItem.update({
        where: { venueId_serialNumber: { venueId, serialNumber } },
        data: { status: 'SOLD', custodyState: 'SOLD', soldAt: new Date(), orderItemId },
      })
      return { item: updated, deprecationWarning: null }
    }

    // 2. Custody precheck (plan §1.5 rollout-controlled)
    const deprecationWarning = await this.applyCustodyPrecheck(item, opts)

    // 3. Update — include sellingVenueId for org-level items
    const isOrgLevel = !item.venueId
    const updated = await client.serializedItem.update({
      where: { id: item.id },
      data: {
        status: 'SOLD',
        custodyState: 'SOLD', // anti-drift mirror
        soldAt: new Date(),
        orderItemId,
        ...(isOrgLevel ? { sellingVenueId: venueId } : {}),
      },
    })

    return { item: updated, deprecationWarning }
  }

  /**
   * Pre-flight check invoked BEFORE payment/order creation.
   *
   * Use this from TPV scan/sell endpoints to surface SIM_NOT_ACCEPTED to the
   * operator early (plan §3.3). Payment-post-hook callers go through
   * markAsSold() which runs the same precheck as defense-in-depth.
   */
  async ensureSellable(
    venueId: string,
    serialNumber: string,
    opts: { staffId: string; appVersionCode?: number; minimumVersionWithMisSims?: number },
  ): Promise<{ deprecationWarning: string | null }> {
    serialNumber = normalizeSerial(serialNumber)
    // Case-insensitive defense-in-depth (matches scan()): tolerate legacy
    // lowercase serials so a sellable SIM is never blocked at the sell gate.
    const item =
      (await this.db.serializedItem.findFirst({
        where: { venueId, serialNumber: { equals: serialNumber, mode: 'insensitive' } },
      })) ?? (await this.findOrgItem(venueId, serialNumber, this.db))
    if (!item) return { deprecationWarning: null }
    const deprecationWarning = await this.applyCustodyPrecheck(item, opts)
    return { deprecationWarning }
  }

  private async applyCustodyPrecheck(
    item: SerializedItem,
    opts?: { staffId?: string; appVersionCode?: number; minimumVersionWithMisSims?: number },
  ): Promise<string | null> {
    if (!opts?.staffId) return null // legacy caller, skip

    // Floor-version safeguard: old TPV clients always run in OFF mode.
    if (opts.appVersionCode !== undefined && opts.minimumVersionWithMisSims !== undefined) {
      if (opts.appVersionCode < opts.minimumVersionWithMisSims) {
        return null
      }
    }

    // Resolve enforcement mode via the item's organization.
    const organizationId = item.organizationId ?? (await this.resolveOrgIdFromVenue(item.venueId))
    if (!organizationId) return null

    const org = await this.db.organization.findUnique({
      where: { id: organizationId },
      select: { simCustodyEnforcementMode: true },
    })
    const mode: SimCustodyEnforcementMode = org?.simCustodyEnforcementMode ?? 'OFF'
    if (mode === 'OFF') return null

    // eSIMs are always sellable — exempt from ALL custody/approval gates
    // (business rule: "los eSIM sí se venden, no se deben restringir").
    // Detect by category name (e-sim / esim, case-insensitive) so it's robust
    // across orgs, not tied to a hardcoded category id.
    const category = await this.db.itemCategory.findUnique({
      where: { id: item.categoryId },
      select: { name: true },
    })
    if (category && /e-?sim/i.test(category.name)) {
      return null
    }

    // Owner-approval gate: a flagged SIM is NOT sellable regardless of custody
    // until the OWNER approves it (origin-based rule — non-Virtual stock needs
    // manual approval). Reuses SIM_NOT_ACCEPTED so the TPV handles it identically.
    if (item.requiresOwnerApproval) {
      if (mode === 'WARN') {
        logger.warn('sim requires owner approval (WARN mode)', {
          serialNumber: item.serialNumber,
          custodyState: item.custodyState,
          actorStaffId: opts.staffId,
        })
        return 'sim-requires-owner-approval'
      }
      throw new SimCustodyError('SIM_NOT_ACCEPTED')
    }

    const custodyOk = item.custodyState === 'PROMOTER_HELD' && item.assignedPromoterId === opts.staffId
    if (custodyOk) return null

    if (mode === 'WARN') {
      logger.warn('sim-custody precheck would fail (WARN mode)', {
        serialNumber: item.serialNumber,
        custodyState: item.custodyState,
        assignedPromoterId: item.assignedPromoterId,
        actorStaffId: opts.staffId,
      })
      return 'sim-custody-not-accepted'
    }
    throw new SimCustodyError('SIM_NOT_ACCEPTED')
  }

  private async resolveOrgIdFromVenue(venueId: string | null): Promise<string | null> {
    if (!venueId) return null
    const venue = await this.db.venue.findUnique({ where: { id: venueId }, select: { organizationId: true } })
    return venue?.organizationId ?? null
  }

  /**
   * Registers and sells in a single transaction (for unregistered items).
   */
  async registerAndSell(data: {
    venueId: string
    categoryId: string
    serialNumber: string
    orderItemId: string
    createdBy: string
  }): Promise<SerializedItem> {
    return this.db.serializedItem.create({
      data: {
        venueId: data.venueId,
        categoryId: data.categoryId,
        serialNumber: normalizeSerial(data.serialNumber),
        createdBy: data.createdBy,
        status: 'SOLD',
        soldAt: new Date(),
        orderItemId: data.orderItemId,
      },
    })
  }

  /**
   * Creates OrderItem data for a SerializedItem.
   * CRITICAL: Fills productName and productSku manually for receipts.
   *
   * @param serializedItem - Item with category included
   * @param price - Price entered by cashier
   * @returns Data ready to create OrderItem
   */
  buildOrderItemData(serializedItem: SerializedItem & { category: ItemCategory }, price: number): OrderItemData {
    return {
      // Snapshot fields - CRITICAL for receipts
      productName: serializedItem.category.name, // "Chip Telcel Negra"
      productSku: serializedItem.serialNumber, // "8952140012345678"
      unitPrice: new Prisma.Decimal(price),
      quantity: 1, // Always 1 for serialized items
      total: new Prisma.Decimal(price), // Fixed: was "subtotal" but OrderItem schema uses "total"
      taxAmount: new Prisma.Decimal(0), // No tax for serialized items
      // No productId - it's SerializedItem, not Product
      productId: null,
    }
  }

  /**
   * Gets available stock by category (merged: venue + org-level).
   */
  async getStockByCategory(venueId: string): Promise<Array<{ category: ItemCategory; available: number; sold: number }>> {
    // Get venue's org ID for merged lookup
    const venue = await this.db.venue.findUnique({
      where: { id: venueId },
      select: { organizationId: true },
    })

    const categories = await this.db.itemCategory.findMany({
      where: {
        active: true,
        OR: [{ venueId }, ...(venue ? [{ organizationId: venue.organizationId, venueId: null }] : [])],
      },
      orderBy: { sortOrder: 'asc' },
    })

    // Deduplicate: venue category overrides org category with same name
    const seen = new Map<string, (typeof categories)[0]>()
    for (const cat of categories) {
      const key = cat.name.toLowerCase()
      const existing = seen.get(key)
      // If venue-scoped, it always wins; org-level only added if no venue override
      if (!existing || cat.venueId) {
        seen.set(key, cat)
      }
    }
    const mergedCategories = Array.from(seen.values())

    // Single groupBy for all categories (avoids 2N queries)
    const categoryIds = mergedCategories.map(c => c.id)
    const countsByStatus = await this.db.serializedItem.groupBy({
      by: ['categoryId', 'status'],
      where: { categoryId: { in: categoryIds }, status: { in: ['AVAILABLE', 'SOLD'] } },
      _count: true,
    })

    const statsMap = new Map<string, { available: number; sold: number }>()
    for (const row of countsByStatus) {
      const existing = statsMap.get(row.categoryId) || { available: 0, sold: 0 }
      if (row.status === 'AVAILABLE') existing.available = row._count
      if (row.status === 'SOLD') existing.sold = row._count
      statsMap.set(row.categoryId, existing)
    }

    return mergedCategories.map(category => {
      const stats = statsMap.get(category.id) || { available: 0, sold: 0 }
      return { category, available: stats.available, sold: stats.sold }
    })
  }

  /**
   * Gets all categories for a venue (merged: venue + org-level).
   */
  async getCategories(venueId: string): Promise<ItemCategory[]> {
    // Use merged categories (venue + org) for backward compatibility
    const merged = await getMergedCategories(venueId)
    // Return as ItemCategory-compatible objects (strip extra fields)
    return merged.map(c => ({
      id: c.id,
      venueId: null, // org-level categories have null venueId
      organizationId: null,
      name: c.name,
      description: c.description,
      color: c.color,
      sortOrder: c.sortOrder,
      requiresPreRegistration: c.requiresPreRegistration,
      suggestedPrice: c.suggestedPrice !== null ? new Prisma.Decimal(c.suggestedPrice) : null,
      barcodePattern: c.barcodePattern,
      active: c.active,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    })) as ItemCategory[]
  }

  /**
   * Gets a single category by ID.
   */
  async getCategoryById(categoryId: string): Promise<ItemCategory | null> {
    return this.db.itemCategory.findUnique({
      where: { id: categoryId },
    })
  }

  /**
   * Creates a new category.
   */
  async createCategory(data: {
    venueId: string
    name: string
    description?: string
    color?: string
    sortOrder?: number
    requiresPreRegistration?: boolean
    suggestedPrice?: number
    barcodePattern?: string
  }): Promise<ItemCategory> {
    return this.db.itemCategory.create({
      data: {
        venueId: data.venueId,
        name: data.name,
        description: data.description,
        color: data.color,
        sortOrder: data.sortOrder ?? 0,
        requiresPreRegistration: data.requiresPreRegistration ?? true,
        suggestedPrice: data.suggestedPrice ? new Prisma.Decimal(data.suggestedPrice) : null,
        barcodePattern: data.barcodePattern,
      },
    })
  }

  /**
   * Updates a category.
   */
  async updateCategory(
    categoryId: string,
    data: Partial<{
      name: string
      description: string
      color: string
      sortOrder: number
      requiresPreRegistration: boolean
      suggestedPrice: number | null
      barcodePattern: string | null
      active: boolean
    }>,
  ): Promise<ItemCategory> {
    return this.db.itemCategory.update({
      where: { id: categoryId },
      data: {
        ...data,
        suggestedPrice:
          data.suggestedPrice !== undefined ? (data.suggestedPrice !== null ? new Prisma.Decimal(data.suggestedPrice) : null) : undefined,
      },
    })
  }

  /**
   * Gets item by serial number.
   *
   * Falls back to org-level pool when venue-scoped unique lookup misses, so
   * SIMs in custody (venueId=NULL after assignment to Supervisor/Promoter)
   * remain findable. Mirrors the venue→org pattern in scan()/markAsSold().
   */
  async getItemBySerialNumber(venueId: string, serialNumber: string): Promise<(SerializedItem & { category: ItemCategory }) | null> {
    serialNumber = normalizeSerial(serialNumber)
    return (
      (await this.db.serializedItem.findUnique({
        where: { venueId_serialNumber: { venueId, serialNumber } },
        include: { category: true },
      })) ?? (await this.findOrgItem(venueId, serialNumber))
    )
  }

  /**
   * Lists items with pagination and filters.
   */
  async listItems(options: {
    venueId: string
    categoryId?: string
    status?: SerializedItemStatus
    skip?: number
    take?: number
  }): Promise<{ items: (SerializedItem & { category: ItemCategory })[]; total: number }> {
    const where: Prisma.SerializedItemWhereInput = {
      venueId: options.venueId,
      ...(options.categoryId && { categoryId: options.categoryId }),
      ...(options.status && { status: options.status }),
    }

    const [items, total] = await Promise.all([
      this.db.serializedItem.findMany({
        where,
        include: { category: true },
        orderBy: { createdAt: 'desc' },
        skip: options.skip,
        take: options.take,
      }),
      this.db.serializedItem.count({ where }),
    ])

    return { items, total }
  }

  /**
   * Org-level pool scope: venue-scoped items (venueId in allowedVenueIds) UNION
   * org-level items (organizationId=orgId, venueId=null). PlayTelecom registers
   * its SIM pool at the org level, so venueId=null items must always be INCLUDED
   * for org-aware reads — never filtered out.
   */
  private orgPoolWhere(orgId: string, allowedVenueIds: string[]): Prisma.SerializedItemWhereInput {
    return { OR: [{ venueId: { in: allowedVenueIds } }, { organizationId: orgId }] }
  }

  /**
   * Lists items across an organization's venues PLUS the org-level pool
   * (venueId=null), with pagination and filters. Org-aware counterpart of
   * listItems().
   */
  async listOrgItems(opts: {
    orgId: string
    allowedVenueIds: string[]
    categoryId?: string
    status?: SerializedItemStatus
    custodyState?: SerializedItemCustodyState
    assignedPromoterId?: string
    skip?: number
    take?: number
  }): Promise<{ items: (SerializedItem & { category: ItemCategory })[]; total: number }> {
    const where: Prisma.SerializedItemWhereInput = {
      ...this.orgPoolWhere(opts.orgId, opts.allowedVenueIds),
      ...(opts.categoryId ? { categoryId: opts.categoryId } : {}),
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.custodyState ? { custodyState: opts.custodyState } : {}),
      ...(opts.assignedPromoterId ? { assignedPromoterId: opts.assignedPromoterId } : {}),
    }

    const [items, total] = await Promise.all([
      this.db.serializedItem.findMany({
        where,
        include: { category: true },
        orderBy: { createdAt: 'desc' },
        skip: opts.skip,
        take: opts.take ?? 50,
      }),
      this.db.serializedItem.count({ where }),
    ])

    return { items, total }
  }

  /**
   * Gets available stock by category across an organization's venues PLUS the
   * org-level pool (venueId=null). Org-aware counterpart of getStockByCategory().
   */
  async getOrgStockByCategory(
    orgId: string,
    allowedVenueIds: string[],
  ): Promise<Array<{ category: ItemCategory; available: number; sold: number }>> {
    const categories = await this.db.itemCategory.findMany({
      where: { active: true, OR: [{ organizationId: orgId }, { venue: { organizationId: orgId } }] },
      orderBy: { sortOrder: 'asc' },
    })

    // Deduplicate: venue category overrides org category with same name
    const seen = new Map<string, (typeof categories)[number]>()
    for (const cat of categories) {
      const key = cat.name.toLowerCase()
      const existing = seen.get(key)
      if (!existing || cat.venueId) seen.set(key, cat)
    }
    const mergedCategories = Array.from(seen.values())

    const categoryIds = mergedCategories.map(c => c.id)
    if (categoryIds.length === 0) return []

    const countsByStatus = await this.db.serializedItem.groupBy({
      by: ['categoryId', 'status'],
      where: {
        ...this.orgPoolWhere(orgId, allowedVenueIds),
        categoryId: { in: categoryIds },
        status: { in: ['AVAILABLE', 'SOLD'] },
      },
      _count: true,
    })

    const statsMap = new Map<string, { available: number; sold: number }>()
    for (const row of countsByStatus) {
      const existing = statsMap.get(row.categoryId) || { available: 0, sold: 0 }
      if (row.status === 'AVAILABLE') existing.available = row._count as unknown as number
      if (row.status === 'SOLD') existing.sold = row._count as unknown as number
      statsMap.set(row.categoryId, existing)
    }

    return mergedCategories.map(category => {
      const stats = statsMap.get(category.id) || { available: 0, sold: 0 }
      return { category, available: stats.available, sold: stats.sold }
    })
  }

  /**
   * Marks an item as returned (reverses sale).
   *
   * Plan §1.2 anti-drift: custodyState was 'SOLD' after the original sale.
   * Reverting status → 'RETURNED' also resets custodyState back up the chain
   * to 'ADMIN_HELD'. No promoter/supervisor retains custody after a return
   * (business assumption — refund triage happens at the org level).
   */
  async markAsReturned(venueId: string, serialNumber: string): Promise<SerializedItem> {
    serialNumber = await this.resolveStoredSerial(venueId, serialNumber)
    return this.db.serializedItem.update({
      where: { venueId_serialNumber: { venueId, serialNumber } },
      data: {
        status: 'RETURNED',
        orderItemId: null,
        custodyState: 'ADMIN_HELD',
        assignedSupervisorId: null,
        assignedSupervisorAt: null,
        assignedPromoterId: null,
        assignedPromoterAt: null,
        promoterAcceptedAt: null,
        promoterRejectedAt: null,
      },
    })
  }

  /**
   * Marks an item as damaged.
   *
   * Plan §1.2 anti-drift: damaged items are removed from the sellable chain.
   * custodyState moves to 'ADMIN_HELD' with the custody assignments cleared,
   * mirroring a `STAFF_TERMINATED`/`DAMAGED_SIM` collect-to-admin path.
   */
  async markAsDamaged(venueId: string, serialNumber: string): Promise<SerializedItem> {
    serialNumber = await this.resolveStoredSerial(venueId, serialNumber)
    return this.db.serializedItem.update({
      where: { venueId_serialNumber: { venueId, serialNumber } },
      data: {
        status: 'DAMAGED',
        custodyState: 'ADMIN_HELD',
        assignedSupervisorId: null,
        assignedSupervisorAt: null,
        assignedPromoterId: null,
        assignedPromoterAt: null,
        promoterAcceptedAt: null,
        promoterRejectedAt: null,
      },
    })
  }

  /**
   * Resolve the actually-stored serial within a venue, tolerant of legacy
   * lower-cased rows. normalizeSerial() upper-cases (the canonical form for all
   * new items), but a handful of legacy items predate that and are stored
   * lower-cased; the search path already matches case variants, so the
   * return/damage mutators must too — otherwise those legacy items can never be
   * returned/damaged. Falls back to the normalized serial when nothing matches,
   * so a genuinely-missing item still surfaces the same P2025 not-found on update.
   */
  private async resolveStoredSerial(venueId: string, serialNumber: string): Promise<string> {
    const normalized = normalizeSerial(serialNumber)
    const trimmed = serialNumber.trim()
    const variants = Array.from(new Set([normalized, trimmed, trimmed.toLowerCase()]))
    const item = await this.db.serializedItem.findFirst({
      where: { venueId, serialNumber: { in: variants } },
      select: { serialNumber: true },
    })
    return item?.serialNumber ?? normalized
  }

  /**
   * Registers multiple items at org level (shared across all venues in the org).
   */
  async registerBatchOrg(data: {
    organizationId: string
    categoryId: string
    serialNumbers: string[]
    createdBy: string
    registeredFromVenueId?: string
    scannerRole?: StaffRole
  }): Promise<RegisterBatchResult> {
    data = { ...data, serialNumbers: normalizeSerials(data.serialNumbers) }
    const custodyData = buildCustodyDataForScanner(data.scannerRole, data.createdBy)
    const eventType =
      custodyData.custodyState === 'PROMOTER_HELD'
        ? 'ASSIGNED_TO_PROMOTER'
        : custodyData.custodyState === 'SUPERVISOR_HELD'
          ? 'ASSIGNED_TO_SUPERVISOR'
          : null

    // Detect duplicates BEFORE the write transaction. Single query covers both
    // org-level rows (organizationId set, venueId null) AND legacy venue-level
    // rows owned by venues in this org. Two findMany calls instead of 2N
    // sequential findFirst calls inside the loop.
    const [existingOrg, existingVenueScoped] = await Promise.all([
      prisma.serializedItem.findMany({
        where: { organizationId: data.organizationId, serialNumber: { in: data.serialNumbers } },
        select: { serialNumber: true },
      }),
      prisma.serializedItem.findMany({
        where: {
          serialNumber: { in: data.serialNumbers },
          venue: { organizationId: data.organizationId },
        },
        select: { serialNumber: true },
      }),
    ])
    const existingSet = new Set([...existingOrg.map(e => e.serialNumber), ...existingVenueScoped.map(e => e.serialNumber)])
    const duplicates = data.serialNumbers.filter(sn => existingSet.has(sn))
    const toInsert = data.serialNumbers.filter(sn => !existingSet.has(sn))

    if (toInsert.length === 0) {
      return { created: 0, duplicates, assignedToYou: 0 }
    }

    // Bulk insert + bulk custody events in a single short transaction.
    // Drops 80-SIM batch from ~6s (240 round trips) to ~200ms (2 queries).
    const created = await this.db.$transaction(
      async tx => {
        const items = await tx.serializedItem.createManyAndReturn({
          data: toInsert.map(serialNumber => ({
            organizationId: data.organizationId,
            venueId: null,
            categoryId: data.categoryId,
            serialNumber,
            createdBy: data.createdBy,
            registeredFromVenueId: data.registeredFromVenueId || null,
            status: 'AVAILABLE' as const,
            ...custodyData,
          })),
          select: { id: true, serialNumber: true },
          skipDuplicates: true,
        })

        if (eventType && custodyData.custodyState && items.length > 0) {
          await tx.serializedItemCustodyEvent.createMany({
            data: items.map(item => ({
              serializedItemId: item.id,
              serialNumber: item.serialNumber,
              eventType,
              fromState: null,
              toState: custodyData.custodyState!,
              fromStaffId: null,
              toStaffId: data.createdBy,
              actorStaffId: data.createdBy,
            })),
          })
        }
        return items
      },
      { timeout: 30000 },
    )

    // Surface any race-condition skips as duplicates (consistency with old API).
    const createdSerials = new Set(created.map(c => c.serialNumber))
    for (const sn of toInsert) {
      if (!createdSerials.has(sn)) duplicates.push(sn)
    }

    return { created: created.length, duplicates, assignedToYou: custodyData.custodyState ? created.length : 0 }
  }

  /**
   * Finds an org-level item by serial number for a venue's organization.
   */
  private async findOrgItem(
    venueId: string,
    serialNumber: string,
    client?: Prisma.TransactionClient,
  ): Promise<(SerializedItem & { category: ItemCategory }) | null> {
    serialNumber = normalizeSerial(serialNumber)
    const db = client || this.db
    const venue = await db.venue.findUnique({
      where: { id: venueId },
      select: { organizationId: true },
    })
    if (!venue) return null

    return db.serializedItem.findFirst({
      where: {
        organizationId: venue.organizationId,
        venueId: null,
        // Case-insensitive defense-in-depth (matches scan()/ensureSellable()):
        // tolerate legacy lowercase serials. (Asana 1215767957979215.)
        serialNumber: { equals: serialNumber, mode: 'insensitive' },
      },
      include: { category: true },
    })
  }

  /**
   * Finds category by barcode pattern match (searches venue + org categories).
   */
  private async findCategoryByPattern(venueId: string, serialNumber: string): Promise<ItemCategory | null> {
    // Get venue's org ID for org-level category search
    const venue = await this.db.venue.findUnique({
      where: { id: venueId },
      select: { organizationId: true },
    })

    const categories = await this.db.itemCategory.findMany({
      where: {
        active: true,
        barcodePattern: { not: null },
        OR: [{ venueId }, ...(venue ? [{ organizationId: venue.organizationId, venueId: null }] : [])],
      },
    })

    for (const category of categories) {
      if (category.barcodePattern) {
        try {
          const regex = new RegExp(category.barcodePattern)
          if (regex.test(serialNumber)) {
            return category
          }
        } catch {
          // Invalid regex pattern for category - skip silently
        }
      }
    }

    return null
  }
}

// Export singleton instance
export const serializedInventoryService = new SerializedInventoryService()
