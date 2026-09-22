/**
 * MCP de clientes — `log_waste` (dos pasos) y `list_waste_reports` (spec v5 §4.7).
 *
 * Lo que se fija aquí, además del contrato del plan:
 *   · la vista previa es legible en español (artículo, cantidad con unidad, motivo, folio) y NO
 *     consulta existencias — `inventory:log-waste` no concede `inventory:read`;
 *   · confirmar escribe exactamente lo que el operador vio: el folio va atado a la vista previa;
 *   · resolver, no adivinar: un nombre ambiguo devuelve candidatos y no escribe;
 *   · una sola fila de auditoría por merma: la escribe el servicio (con `source: 'MCP'`);
 *   · el día que pide el operador es el día LOCAL del negocio, igual con el host en UTC
 *     (este archivo se corre también con `TZ=UTC`).
 */
import { Prisma, StaffRole } from '@prisma/client'
import { ForbiddenError } from '@/errors/AppError'
import { registerInventoryWasteTools } from '@/mcp/tools/inventoryWaste'
import { registerInventoryTools } from '@/mcp/tools/inventory'
import { prismaMock } from '@tests/__helpers__/setup'

const logWaste = jest.fn()
const recoverByKey = jest.fn()
const getWasteAccess = jest.fn()
const hasWastePermission = jest.fn()
const requireWastePermission = jest.fn()
jest.mock('@/services/shared/inventoryWaste.service', () => ({
  ...jest.requireActual('@/services/shared/inventoryWaste.service'),
  logWaste: (...a: unknown[]) => logWaste(...a),
  recoverByKey: (...a: unknown[]) => recoverByKey(...a),
  getWasteAccess: (...a: unknown[]) => getWasteAccess(...a),
  hasWastePermission: (...a: unknown[]) => hasWastePermission(...a),
  requireWastePermission: (...a: unknown[]) => requireWastePermission(...a),
}))
const findWasteItem = jest.fn()
const listWasteItems = jest.fn()
const listWasteReports = jest.fn()
jest.mock('@/services/shared/inventoryWasteRead.service', () => ({
  findWasteItem: (...a: unknown[]) => findWasteItem(...a),
  listWasteItems: (...a: unknown[]) => listWasteItems(...a),
  listWasteReports: (...a: unknown[]) => listWasteReports(...a),
}))
const venueHasFeatureAccess = jest.fn()
jest.mock('@/services/access/basePlan.service', () => ({
  ...jest.requireActual('@/services/access/basePlan.service'),
  venueHasFeatureAccess: (...a: unknown[]) => venueHasFeatureAccess(...a),
}))
const auditMcpWrite = jest.fn()
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => auditMcpWrite(...a) }))

const ambito = (scopes: string[], corePermissions: string[] = ['inventory:log-waste']) => ({
  staffId: 'staff-1',
  activeOrg: 'org-1',
  allowedVenueIds: ['venue-1'],
  scopes,
  perVenueAccess: new Map([
    [
      'venue-1',
      {
        userId: 'staff-1',
        venueId: 'venue-1',
        organizationId: 'org-1',
        role: StaffRole.MANAGER,
        corePermissions,
        whiteLabelEnabled: false,
        enabledFeatures: [],
        featureAccess: {},
        featureMetadata: {},
      },
    ],
  ]),
})

function tool(nombre: string, scopes: string[] = ['mcp:read', 'mcp:write'], corePermissions?: string[]) {
  let handler: ((input: Record<string, unknown>) => Promise<{ content: { text: string }[] }>) | undefined
  const server = {
    tool: (n: string, _d: string, _s: unknown, h: typeof handler) => {
      if (n === nombre) handler = h
    },
  }
  registerInventoryWasteTools(server as never, ambito(scopes, corePermissions) as never)
  if (!handler) throw new Error(`la tool ${nombre} no se registró`)
  return handler
}

const entrada = {
  venueId: 'venue-1',
  itemType: 'PRODUCT',
  itemId: 'p1',
  quantity: '2',
  unit: 'UNIT',
  reasonCode: 'DROPPED',
  confirm: false,
}
const RESUMEN = { reportId: 'r1', declared: '2', deducted: '2', unrecorded: '0' }
const json = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text)
/** Copia sin las llaves indicadas (para probar entradas a las que les falta algo). */
const sin = (o: Record<string, unknown>, ...llaves: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !llaves.includes(k)))

beforeEach(() => {
  jest.clearAllMocks()
  getWasteAccess.mockResolvedValue({})
  hasWastePermission.mockReturnValue(true)
  venueHasFeatureAccess.mockResolvedValue(true)
  recoverByKey.mockResolvedValue(null)
  findWasteItem.mockResolvedValue({ itemType: 'PRODUCT', itemId: 'p1', name: 'Taza', sku: 'T-1', unit: 'UNIT' })
  listWasteItems.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 10 })
  listWasteReports.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 50 })
  logWaste.mockResolvedValue(RESUMEN)
  prismaMock.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' })
})

describe('MCP log_waste', () => {
  it('🔴 sin mcp:write no registra nada', async () => {
    await expect(tool('log_waste', ['mcp:read'])(entrada)).rejects.toThrow(/mcp:write/)
    expect(logWaste).not.toHaveBeenCalled()
  })

  it('🔴 la vista previa devuelve un folio y NO calcula existencias', async () => {
    const out = json(await tool('log_waste')(entrada))
    expect(out.requiresConfirmation).toBe(true)
    expect(out.confirmationPayload.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/)
    expect(JSON.stringify(out)).not.toMatch(/deducted|unrecorded|currentStock/)
    expect(logWaste).not.toHaveBeenCalled()
  })

  it('🔴 confirmar sin el folio de la vista previa se rechaza', async () => {
    await expect(tool('log_waste')({ ...entrada, confirm: true })).rejects.toMatchObject({ code: 'INVALID_WASTE_KEY' })
    expect(logWaste).not.toHaveBeenCalled()
  })

  it('confirmar con el folio registra UNA vez, con source MCP', async () => {
    const previa = json(await tool('log_waste')(entrada))
    const out = json(await tool('log_waste')(previa.confirmationPayload))
    expect(out).toEqual({ ok: true, report: RESUMEN })
    expect(logWaste).toHaveBeenCalledTimes(1)
    expect(logWaste).toHaveBeenCalledWith(
      'venue-1',
      'staff-1',
      expect.objectContaining({ source: 'MCP', idempotencyKey: previa.confirmationPayload.idempotencyKey }),
    )
  })

  it('🔴 sin plan responde planRequired y no escribe', async () => {
    venueHasFeatureAccess.mockResolvedValue(false)
    const out = json(await tool('log_waste')(entrada))
    expect(out).toMatchObject({ ok: false, planRequired: true, featureCode: 'INVENTORY_TRACKING' })
    expect(logWaste).not.toHaveBeenCalled()
  })

  it('sin el permiso se rechaza aunque haya plan', async () => {
    hasWastePermission.mockReturnValue(false)
    await expect(tool('log_waste')(entrada)).rejects.toThrow(/permiso/)
  })

  it('🔴 al CONFIRMAR también se revalidan plan y permiso: perderlos entre los dos pasos no escribe', async () => {
    const previa = json(await tool('log_waste')(entrada))
    venueHasFeatureAccess.mockResolvedValue(false)
    expect(json(await tool('log_waste')(previa.confirmationPayload))).toMatchObject({ ok: false, planRequired: true })
    venueHasFeatureAccess.mockResolvedValue(true)
    hasWastePermission.mockReturnValue(false)
    await expect(tool('log_waste')(previa.confirmationPayload)).rejects.toMatchObject({ code: 'WASTE_PERMISSION_DENIED' })
    expect(logWaste).not.toHaveBeenCalled()
  })

  it('un folio ya aplicado se devuelve sin volver a registrar', async () => {
    recoverByKey.mockResolvedValue(RESUMEN)
    const out = json(await tool('log_waste')({ ...entrada, confirm: true, idempotencyKey: '3f0e5c1a-7c1d-4a55-9c3e-2b8f4d6a1e90' }))
    expect(out).toEqual({ ok: true, report: RESUMEN })
    expect(logWaste).not.toHaveBeenCalled()
  })

  // ── Lo que agrega esta tarea sobre el plan ────────────────────────────────────────────────

  it('🔴 la vista previa es legible en español: artículo, cantidad con unidad, motivo y folio', async () => {
    const out = json(await tool('log_waste')(entrada))
    const folio = out.confirmationPayload.idempotencyKey
    expect(out.ok).toBe(false) // convención del repo: la vista previa no es una escritura hecha
    expect(out.preview).toMatchObject({
      articulo: 'Taza',
      tipo: 'Producto',
      cantidad: '2 unidades',
      motivo: 'Se cayó / derramó',
      folio,
    })
    expect(out.message).toContain('«Taza»')
    expect(out.message).toContain('2 unidades')
    expect(out.message).toContain('Se cayó / derramó')
    expect(out.message).toContain(folio)
    expect(out.message).toMatch(/confirm/)
    // La vista previa confirma el artículo en ESE venue y nada más: ni existencia ni costo.
    expect(findWasteItem).toHaveBeenCalledWith('venue-1', 'PRODUCT', 'p1')
    expect(prismaMock.inventory.findFirst).not.toHaveBeenCalled()
  })

  it('una unidad sola se dice en singular, y un insumo se llama insumo', async () => {
    findWasteItem.mockResolvedValue({ itemType: 'RAW_MATERIAL', itemId: 'rm1', name: 'Aguacate', sku: 'AG', unit: 'KILOGRAM' })
    const out = json(
      await tool('log_waste')({
        ...entrada,
        itemType: 'RAW_MATERIAL',
        itemId: 'rm1',
        quantity: 1,
        unit: 'KILOGRAM',
        reasonCode: 'EXPIRED',
      }),
    )
    expect(out.preview).toMatchObject({ articulo: 'Aguacate', tipo: 'Insumo', cantidad: '1 kg', motivo: 'Caducó' })
  })

  it('sin unidad, la vista previa usa la del artículo y la deja en lo que se confirma', async () => {
    const sinUnidad = sin(entrada, 'unit')
    const out = json(await tool('log_waste')(sinUnidad))
    expect(out.requiresConfirmation).toBe(true)
    expect(out.confirmationPayload.unit).toBe('UNIT')
  })

  it('🔴 una unidad distinta a la del artículo no emite folio y dice cuál es la correcta', async () => {
    const out = json(await tool('log_waste')({ ...entrada, unit: 'KILOGRAM' }))
    expect(out).toMatchObject({ ok: false, code: 'UNIT_MISMATCH', expectedUnit: 'UNIT' })
    expect(out.confirmationPayload).toBeUndefined()
    expect(logWaste).not.toHaveBeenCalled()
  })

  it('🔴 un artículo que no existe EN ESE venue no emite folio', async () => {
    findWasteItem.mockResolvedValue(null)
    const out = json(await tool('log_waste')(entrada))
    expect(out.ok).toBe(false)
    expect(out.confirmationPayload).toBeUndefined()
    expect(logWaste).not.toHaveBeenCalled()
  })

  it('por nombre con UNA coincidencia arma la vista previa de ese artículo', async () => {
    listWasteItems.mockResolvedValue({
      items: [{ itemType: 'RAW_MATERIAL', itemId: 'rm1', name: 'Leche entera', sku: 'LE', unit: 'LITER' }],
      total: 1,
      page: 1,
      pageSize: 10,
    })
    const porNombre = sin(entrada, 'itemType', 'itemId', 'unit')
    const out = json(await tool('log_waste')({ ...porNombre, name: 'leche', quantity: '1.5' }))
    expect(listWasteItems).toHaveBeenCalledWith('venue-1', expect.objectContaining({ search: 'leche', page: 1 }))
    expect(out.confirmationPayload).toMatchObject({ itemType: 'RAW_MATERIAL', itemId: 'rm1', unit: 'LITER', quantity: '1.5' })
    expect(out.preview).toMatchObject({ articulo: 'Leche entera', cantidad: '1.5 L' })
  })

  it('🔴 resolver, no adivinar: un nombre ambiguo devuelve candidatos y no emite folio', async () => {
    listWasteItems.mockResolvedValue({
      items: [
        { itemType: 'RAW_MATERIAL', itemId: 'rm1', name: 'Leche entera', sku: 'LE', unit: 'LITER' },
        { itemType: 'RAW_MATERIAL', itemId: 'rm2', name: 'Leche de almendra', sku: 'LA', unit: 'LITER' },
      ],
      total: 2,
      page: 1,
      pageSize: 10,
    })
    const porNombre = sin(entrada, 'itemType', 'itemId')
    const out = json(await tool('log_waste')({ ...porNombre, name: 'leche' }))
    expect(out).toMatchObject({ ok: false, ambiguous: true })
    expect(out.candidates.map((c: { itemId: string }) => c.itemId)).toEqual(['rm1', 'rm2'])
    expect(out.confirmationPayload).toBeUndefined()
    expect(logWaste).not.toHaveBeenCalled()
  })

  it('por nombre sin coincidencias no emite folio', async () => {
    const porNombre = sin(entrada, 'itemType', 'itemId')
    const out = json(await tool('log_waste')({ ...porNombre, name: 'inexistente' }))
    expect(out.ok).toBe(false)
    expect(out.confirmationPayload).toBeUndefined()
  })

  it('🔴 confirmar con datos distintos a los de la vista previa se rechaza sin escribir', async () => {
    const previa = json(await tool('log_waste')(entrada))
    await expect(tool('log_waste')({ ...previa.confirmationPayload, quantity: '20' })).rejects.toMatchObject({
      code: 'WASTE_PREVIEW_MISMATCH',
    })
    expect(logWaste).not.toHaveBeenCalled()
  })

  it('🔴 confirmar sin el artículo exacto (sólo un nombre) se rechaza sin escribir', async () => {
    const previa = json(await tool('log_waste')(entrada))
    const sinArticulo = sin(previa.confirmationPayload, 'itemId', 'itemType')
    await expect(tool('log_waste')({ ...sinArticulo, name: 'Taza' })).rejects.toMatchObject({ code: 'INVALID_WASTE_PAYLOAD' })
    expect(logWaste).not.toHaveBeenCalled()
  })

  it('🔴 sin inventory:log-waste en el ámbito se rechaza antes de tocar nada', async () => {
    await expect(tool('log_waste', ['mcp:read', 'mcp:write'], ['inventory:read'])(entrada)).rejects.toThrow(/inventory:log-waste/)
    expect(getWasteAccess).not.toHaveBeenCalled()
    expect(logWaste).not.toHaveBeenCalled()
  })

  it('un acceso revocado desde que se conectó se rechaza (lo decide el servicio, con su código)', async () => {
    getWasteAccess.mockRejectedValue(new ForbiddenError('Ya no tienes acceso a este establecimiento.', 'WASTE_ACCESS_REVOKED'))
    await expect(tool('log_waste')(entrada)).rejects.toMatchObject({ code: 'WASTE_ACCESS_REVOKED' })
    expect(logWaste).not.toHaveBeenCalled()
  })

  it('🔴 venue fuera del ámbito se rechaza', async () => {
    await expect(tool('log_waste')({ ...entrada, venueId: 'venue-ajeno' })).rejects.toThrow(/scope|alcance/)
    expect(logWaste).not.toHaveBeenCalled()
  })

  it('🔴 una sola fila de auditoría por merma: la escribe el servicio, no la tool', async () => {
    const previa = json(await tool('log_waste')(entrada))
    await tool('log_waste')(previa.confirmationPayload)
    expect(logWaste).toHaveBeenCalledTimes(1)
    expect(auditMcpWrite).not.toHaveBeenCalled()
  })
})

describe('MCP list_waste_reports', () => {
  const lector = (scopes: string[] = ['mcp:read', 'mcp:write'], perms: string[] = ['inventory:read']) =>
    tool('list_waste_reports', scopes, perms)

  it('🔴 un día local del negocio se convierte a los instantes de ESA zona (CDMX, UTC−6)', async () => {
    await lector()({ venueId: 'venue-1', fromDate: '2026-03-10', toDate: '2026-03-10' })
    expect(listWasteReports).toHaveBeenCalledWith(
      'venue-1',
      expect.objectContaining({ startDate: '2026-03-10T06:00:00.000Z', endDate: '2026-03-11T05:59:59.999Z' }),
    )
  })

  it('🔴 en una zona con cambio de horario, el inicio y el fin toman el desfase de CADA instante', async () => {
    // 8-mar-2026: Tijuana pasa de UTC−8 a UTC−7 a las 2:00 locales.
    prismaMock.venue.findUnique.mockResolvedValue({ timezone: 'America/Tijuana' })
    await lector()({ venueId: 'venue-1', fromDate: '2026-03-08', toDate: '2026-03-08' })
    expect(listWasteReports).toHaveBeenCalledWith(
      'venue-1',
      expect.objectContaining({ startDate: '2026-03-08T08:00:00.000Z', endDate: '2026-03-09T06:59:59.999Z' }),
    )
  })

  it('sin fechas no filtra por fecha', async () => {
    await lector()({ venueId: 'venue-1' })
    const query = listWasteReports.mock.calls[0][1]
    expect(query.startDate).toBeUndefined()
    expect(query.endDate).toBeUndefined()
  })

  it('🔴 un día que no existe (30 de febrero) se rechaza sin consultar', async () => {
    await expect(lector()({ venueId: 'venue-1', fromDate: '2026-02-30' })).rejects.toMatchObject({ code: 'INVALID_WASTE_PAYLOAD' })
    expect(listWasteReports).not.toHaveBeenCalled()
  })

  it('un inicio posterior al final se rechaza', async () => {
    await expect(lector()({ venueId: 'venue-1', fromDate: '2026-03-12', toDate: '2026-03-10' })).rejects.toMatchObject({
      code: 'INVALID_WASTE_PAYLOAD',
    })
    expect(listWasteReports).not.toHaveBeenCalled()
  })

  it('🔴 sin inventory:read se rechaza y no consulta', async () => {
    await expect(lector(['mcp:read', 'mcp:write'], ['inventory:log-waste'])({ venueId: 'venue-1' })).rejects.toThrow(/inventory:read/)
    expect(listWasteReports).not.toHaveBeenCalled()
  })

  it('una conexión de sólo lectura (sin mcp:write) sí puede listar: leer no es escribir', async () => {
    const out = json(await lector(['mcp:read'])({ venueId: 'venue-1' }))
    expect(out.ok).toBe(true)
    expect(listWasteReports).toHaveBeenCalledTimes(1)
  })

  it('🔴 sin plan responde planRequired y no consulta', async () => {
    venueHasFeatureAccess.mockResolvedValue(false)
    const out = json(await lector()({ venueId: 'venue-1' }))
    expect(out).toMatchObject({ ok: false, planRequired: true, featureCode: 'INVENTORY_TRACKING' })
    expect(listWasteReports).not.toHaveBeenCalled()
  })

  it('🔴 venue fuera del ámbito se rechaza', async () => {
    await expect(lector()({ venueId: 'venue-ajeno' })).rejects.toThrow(/scope|alcance/)
    expect(listWasteReports).not.toHaveBeenCalled()
  })

  it('🔴 un tamaño de página hostil lo recorta el servidor a 200', async () => {
    await lector()({ venueId: 'venue-1', pageSize: 10_000 })
    expect(listWasteReports).toHaveBeenCalledWith('venue-1', expect.objectContaining({ pageSize: 200 }))
  })

  it('devuelve cada folio legible, con costos en PESOS y la paginación completa', async () => {
    listWasteReports.mockResolvedValue({
      items: [
        {
          id: 'r1',
          itemType: 'RAW_MATERIAL',
          rawMaterialId: 'rm1',
          productId: null,
          unit: 'KILOGRAM',
          reasonCode: 'EXPIRED',
          declaredQuantity: new Prisma.Decimal('2.5'),
          deductedQuantity: new Prisma.Decimal('2'),
          unrecordedQuantity: new Prisma.Decimal('0.5'),
          costImpact: new Prisma.Decimal('87.55'),
          costState: 'PARTIAL',
          unitCostSnapshot: null,
          note: null,
          reference: null,
          supplier: null,
          source: 'POS',
          createdAt: new Date('2026-03-10T18:00:00.000Z'),
          clientOccurredAt: null,
          reportedByStaffId: 'staff-9',
          reportedByStaff: { firstName: 'Ana', lastName: 'López' },
          rawMaterial: { name: 'Aguacate', sku: 'AG' },
          product: null,
        },
        {
          id: 'r2',
          itemType: 'PRODUCT',
          rawMaterialId: null,
          productId: 'p1',
          unit: 'UNIT',
          reasonCode: 'DROPPED',
          declaredQuantity: new Prisma.Decimal('3'),
          deductedQuantity: new Prisma.Decimal('0'),
          unrecordedQuantity: new Prisma.Decimal('3'),
          costImpact: null,
          costState: 'NONE',
          unitCostSnapshot: null,
          note: 'Se rompieron',
          reference: null,
          supplier: null,
          source: 'MCP',
          createdAt: new Date('2026-03-10T17:00:00.000Z'),
          clientOccurredAt: null,
          reportedByStaffId: 'staff-1',
          reportedByStaff: { firstName: 'Luis', lastName: 'Pérez' },
          rawMaterial: null,
          product: { name: 'Taza', sku: 'T-1' },
        },
      ],
      total: 51,
      page: 1,
      pageSize: 50,
    })
    const out = json(await lector()({ venueId: 'venue-1' }))
    expect(out).toMatchObject({ ok: true, total: 51, page: 1, pageSize: 50, totalPages: 2, hasMore: true })
    expect(out.reports[0]).toMatchObject({
      reportId: 'r1',
      item: 'Aguacate',
      itemType: 'RAW_MATERIAL',
      itemId: 'rm1',
      reason: 'Caducó',
      declared: 2.5,
      deducted: 2,
      withoutStock: 0.5,
      costPesos: 87.55,
      reportedBy: 'Ana López',
      source: 'Punto de venta',
    })
    expect(out.reports[0].costState).toMatch(/parcial/i)
    // Un costo desconocido NO es cero: se dice «sin valorar», nunca 0.
    expect(out.reports[1]).toMatchObject({ reportId: 'r2', item: 'Taza', costPesos: null, note: 'Se rompieron' })
    expect(out.reports[1].costState).toMatch(/sin/i)
  })
})

describe('registro en el catálogo de inventario', () => {
  it('registerInventoryTools publica log_waste y list_waste_reports, y adjust_stock sigue ahí', () => {
    const nombres: string[] = []
    registerInventoryTools({ tool: (n: string) => nombres.push(n) } as never, ambito(['mcp:read', 'mcp:write']) as never)
    expect(nombres).toEqual(expect.arrayContaining(['log_waste', 'list_waste_reports', 'adjust_stock']))
    expect(nombres.filter(n => n === 'log_waste')).toHaveLength(1)
  })
})
