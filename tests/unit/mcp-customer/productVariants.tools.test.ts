/**
 * Herramientas MCP de variantes (Tarea 14). Mismo arnés que `confirmation-identity.test.ts`: catálogo real (confirmación en
 * dos pasos, token y permisos de la conexión), servicios mockeados. Las ventas por talla contra Postgres real viven en
 * `tests/integration/product-variants/productVariants.mcp.integration.test.ts`.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Prisma } from '@prisma/client'
import { configureToolCatalog } from '@/mcp/catalog'
import { registerProductVariantTools } from '@/mcp/tools/productVariants'
import { BadRequestError, ConflictError } from '@/errors/AppError'
import type { McpScope } from '@/mcp/scope'

const mockGate = jest.fn()
const mockAudit = jest.fn()
const mockCreate = jest.fn()
const mockGetGroup = jest.fn()
const mockPreviewGroup = jest.fn()
const mockApplyGroup = jest.fn()
const mockCategories = jest.fn()
const mockGroups = jest.fn()
const mockProducts = jest.fn()
const mockVenue = jest.fn()
const mockQueryRaw = jest.fn()
const mockNoMaster = jest.fn()
const mockNotDemo = jest.fn()
const mockCategoryById = jest.fn()
const mockModifierGroups = jest.fn()
const mockNameFree = jest.fn()
jest.mock('@/mcp/planGate', () => ({ planGateMessage: (...a: unknown[]) => mockGate(...a) }))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...a) }))
jest.mock('@/services/product-variants/productGroup.service', () => ({
  createProductWithVariants: (...a: unknown[]) => mockCreate(...a),
  getProductGroup: (...a: unknown[]) => mockGetGroup(...a),
  assertNoMasterCatalog: (...a: unknown[]) => mockNoMaster(...a),
  assertNotDemoCategory: (...a: unknown[]) => mockNotDemo(...a),
  assertGroupNameFree: (...a: unknown[]) => mockNameFree(...a),
}))
jest.mock('@/services/product-variants/groupExisting.service', () => ({
  previewGroupExisting: (...a: unknown[]) => mockPreviewGroup(...a),
  applyGroupExisting: (...a: unknown[]) => mockApplyGroup(...a),
}))
const mockShopifyPreview = jest.fn()
const mockShopifyBatch = jest.fn()
jest.mock('@/services/product-variants/shopifyFamilies.service', () => ({
  listShopifyFamilyProposals: jest.fn(),
  previewAllShopifyProposals: jest.fn(),
  previewShopifyProposal: (...a: unknown[]) => mockShopifyPreview(...a),
  applyShopifyProposalsBatch: (...a: unknown[]) => mockShopifyBatch(...a),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    menuCategory: { findMany: (...a: unknown[]) => mockCategories(...a), findFirst: (...a: unknown[]) => mockCategoryById(...a) },
    modifierGroup: { findMany: (...a: unknown[]) => mockModifierGroups(...a) },
    productGroup: { findMany: (...a: unknown[]) => mockGroups(...a) },
    product: { findMany: (...a: unknown[]) => mockProducts(...a) },
    venue: { findUnique: (...a: unknown[]) => mockVenue(...a) },
    $queryRaw: (...a: unknown[]) => mockQueryRaw(...a),
  },
}))

const OWNER = { role: 'OWNER', corePermissions: ['*:*'], isSuperAdmin: false }

type Familia = { id: string; name: string; category: { name: string }; deletedAt?: Date | null }
let familias: Familia[] = []
const low = (x: string) => x.toLocaleLowerCase('es-MX')
/** Like the database: `equals` / `contains` without case, the optional category and id filters, and live vs archived. */
function buscarFamilias({
  where,
}: {
  where: {
    id?: string
    deletedAt?: null | { not: null }
    name: { equals?: string; contains?: string }
    category?: { name: { equals: string } }
  }
}) {
  return familias.filter(
    g =>
      (where.name.equals !== undefined ? low(g.name) === low(where.name.equals) : low(g.name).includes(low(where.name.contains!))) &&
      (!where.category || low(g.category.name) === low(where.category.name.equals)) &&
      (!where.id || g.id === where.id) &&
      (where.deletedAt === undefined || (where.deletedAt === null ? !g.deletedAt : !!g.deletedAt)),
  )
}
let server: McpServer
let client: Client

async function connect(access: Record<string, unknown> = OWNER, profile: 'manual' | 'directory' = 'manual') {
  server = new McpServer({ name: 'variantes', version: '1' })
  const scope = {
    staffId: 'owner',
    activeOrg: 'org',
    allowedVenueIds: ['v1'],
    scopes: ['mcp:read', 'mcp:write'],
    perVenueAccess: new Map([['v1', access]]),
  } as unknown as McpScope
  configureToolCatalog(server, scope, profile)
  registerProductVariantTools(server, scope)
  client = new Client({ name: 't', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
}

const detalle = {
  id: 'g1',
  name: 'Playera',
  categoryId: 'cat1',
  type: 'REGULAR',
  options: [
    {
      id: 'o1',
      name: 'Talla',
      position: 0,
      values: [
        { id: 'v-s', value: 'S', position: 0 },
        { id: 'v-m', value: 'M', position: 1 },
      ],
    },
  ],
  variants: [
    {
      id: 'p1',
      name: 'Playera · S',
      sku: 'PLAYERA-S',
      gtin: null,
      price: 299,
      cost: 120,
      active: true,
      variantImageUrl: null,
      values: ['S'],
      stock: 5,
    },
    {
      id: 'p2',
      name: 'Playera · M',
      sku: 'PLAYERA-M',
      gtin: '7501',
      price: 299,
      cost: null,
      active: true,
      variantImageUrl: null,
      values: ['M'],
      stock: null,
    },
  ],
  archivedCount: 1,
}

beforeEach(async () => {
  jest.clearAllMocks()
  mockGate.mockResolvedValue(null)
  mockCategories.mockResolvedValue([{ id: 'cat1', name: 'Ropa' }])
  mockCreate.mockResolvedValue({ groupId: 'g1', productIds: ['p1', 'p2'], categoryId: 'cat1' })
  familias = [{ id: 'g1', name: 'Playera', category: { name: 'Ropa' } }]
  mockGroups.mockImplementation(async (q: Parameters<typeof buscarFamilias>[0]) => buscarFamilias(q))
  mockNoMaster.mockResolvedValue(undefined)
  mockNotDemo.mockResolvedValue(undefined)
  mockNameFree.mockResolvedValue(undefined)
  mockGetGroup.mockResolvedValue(detalle)
  mockVenue.mockResolvedValue({ timezone: 'America/Mexico_City' })
  mockQueryRaw.mockResolvedValue([])
  await connect()
})
afterEach(async () => {
  await client.close()
  await server.close()
})
const raw = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }) as Promise<any>
const call = async (name: string, args: Record<string, unknown>) => JSON.parse((await raw(name, args)).content[0].text)
const reconnect = async (access: Record<string, unknown>, profile: 'manual' | 'directory' = 'manual') => {
  await client.close()
  await server.close()
  await connect(access, profile)
}

describe('create_product_with_variants', () => {
  const args = { venueId: 'v1', name: 'Playera', category: 'Ropa', options: [{ name: 'Talla', values: ['S', 'M'] }], price: 299 }
  const confirmar = async (extra: Record<string, unknown> = {}) => {
    const preview = await call('create_product_with_variants', args)
    return call('create_product_with_variants', {
      ...preview.confirmationArguments,
      ...extra,
      confirm: true,
      confirmationToken: preview.confirmationToken,
    })
  }

  it('sin confirm sólo muestra la vista previa con las combinaciones y no escribe', async () => {
    const r = await call('create_product_with_variants', args)
    expect(r).toMatchObject({
      requiresConfirmation: true,
      preview: {
        product: 'Playera',
        category: 'Ropa',
        combinations: [
          { name: 'Playera · S', price: 299 },
          { name: 'Playera · M', price: 299 },
        ],
      },
    })
    expect(r.expectedSourceFingerprint).toEqual(expect.any(String))
    expect(r.confirmationArguments.expectedSourceFingerprint).toBe(r.expectedSourceFingerprint)
    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('con la confirmación (y la huella de la vista previa) crea el padre y sus variantes, y audita', async () => {
    const r = await confirmar()
    expect(r).toMatchObject({ ok: true, groupId: 'g1', variantCount: 2 })
    expect(mockCreate).toHaveBeenCalledWith(
      'v1',
      expect.objectContaining({
        name: 'Playera',
        categoryId: 'cat1',
        options: [{ name: 'Talla', values: ['S', 'M'] }],
        variants: [
          { values: ['S'], price: 299 },
          { values: ['M'], price: 299 },
        ],
      }),
      { type: 'HUMAN', staffId: 'owner', impersonating: false },
    )
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ staffId: 'owner' }),
      expect.objectContaining({ action: 'PRODUCT_GROUP_CREATED', entity: 'ProductGroup', entityId: 'g1', venueId: 'v1' }),
    )
  })

  it('🔴 si la categoría resuelta cambia entre la vista previa y la confirmación, vuelve a pedir la vista previa', async () => {
    const preview = await call('create_product_with_variants', args)
    mockCategories.mockResolvedValue([{ id: 'cat-nueva', name: 'Ropa' }])
    const r = await call('create_product_with_variants', {
      ...preview.confirmationArguments,
      confirm: true,
      confirmationToken: preview.confirmationToken,
    })
    expect(r).toMatchObject({ ok: false, needsInput: true })
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('confirm sin token de la vista previa no escribe', async () => {
    const r = await call('create_product_with_variants', { ...args, confirm: true })
    expect(r).toMatchObject({ ok: false, needsInput: true })
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('🔴 auditoría A4: un gerente sin `menu:create` no puede crear (mismos permisos que el dashboard)', async () => {
    await reconnect({ role: 'MANAGER', corePermissions: ['menu:read'], isSuperAdmin: false })
    const r = await raw('create_product_with_variants', args)
    // I-5: un rechazo de permiso es una RESPUESTA ok:false («warn» en el log), no una excepción (que el log marca «error»): el
    // contenido es el JSON de la herramienta, no el texto de un error lanzado.
    expect(JSON.parse(r.content[0].text)).toMatchObject({ ok: false, error: 'Missing permission menu:create for venue v1' })
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('🔴 un negocio Gratis recibe el aviso de plan y no escribe', async () => {
    mockGate.mockResolvedValue('Las variantes de producto no está incluido en el plan actual…')
    const r = await call('create_product_with_variants', args)
    expect(r).toMatchObject({ ok: false, planRequired: true })
    expect(mockGate).toHaveBeenCalledWith('v1', 'PRODUCT_VARIANTS', expect.any(String))
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('cuenta las combinaciones ANTES de armarlas: más de 250 se rechaza en español', async () => {
    const valores = (n: number) => Array.from({ length: n }, (_, i) => `V${i}`)
    const r = await call('create_product_with_variants', {
      ...args,
      options: [
        { name: 'Talla', values: valores(100) },
        { name: 'Color', values: valores(100) },
        { name: 'Material', values: valores(100) },
      ],
    })
    expect(r).toMatchObject({ ok: false })
    expect(r.error).toMatch(/1000000 combinaciones|1,000,000 combinaciones|250/)
    expect(mockCategories).not.toHaveBeenCalled()
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('valores repetidos o vacíos se rechazan con el mensaje del servicio, sin escribir', async () => {
    const r = await call('create_product_with_variants', { ...args, options: [{ name: 'Talla', values: ['M', ' m '] }] })
    expect(r).toMatchObject({ ok: false })
    expect(r.error).toMatch(/repetido/)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('resolver, no adivinar: dos categorías con ese nombre devuelven sus ids; `categoryId` desempata', async () => {
    const dos = [
      { id: 'cat1', name: 'Ropa' },
      { id: 'cat2', name: 'ROPA' },
    ]
    mockCategories.mockImplementation(async ({ where }: { where: { id?: string } }) => dos.filter(c => !where.id || c.id === where.id))
    const r = await call('create_product_with_variants', args)
    expect(r).toMatchObject({
      ok: false,
      ambiguous: true,
      matches: [
        { categoryId: 'cat1', name: 'Ropa' },
        { categoryId: 'cat2', name: 'ROPA' },
      ],
    })
    expect(mockCreate).not.toHaveBeenCalled()
    const desempate = await call('create_product_with_variants', { ...args, categoryId: 'cat2' })
    expect(desempate).toMatchObject({ requiresConfirmation: true, preview: { category: 'ROPA' } })
    expect(mockCategories.mock.calls.at(-1)[0].where).toMatchObject({ venueId: { in: ['v1'] }, id: 'cat2' })
  })

  it('🔴 la vista previa corre los chequeos de sólo lectura del servicio: catálogo maestro', async () => {
    mockNoMaster.mockRejectedValue(
      new ConflictError(
        'Este negocio usa el catálogo maestro; las variantes todavía no están disponibles aquí.',
        'PRODUCT_VARIANTS_MASTER_CATALOG',
      ),
    )
    const r = await call('create_product_with_variants', args)
    expect(r).toMatchObject({ ok: false, code: 'PRODUCT_VARIANTS_MASTER_CATALOG' })
    expect(r.requiresConfirmation).toBeUndefined()
    expect(mockNoMaster).toHaveBeenCalledWith(expect.anything(), 'v1')
  })

  it('🔴 … y categoría de demostración', async () => {
    mockNotDemo.mockRejectedValue(new BadRequestError('Elige una categoría tuya: las de demostración se borran al empezar a vender.'))
    const r = await call('create_product_with_variants', args)
    expect(r).toMatchObject({ ok: false })
    expect(r.error).toMatch(/demostración/)
    expect(r.requiresConfirmation).toBeUndefined()
    expect(mockNotDemo).toHaveBeenCalledWith(expect.anything(), 'cat1')
  })

  it('una categoría que no existe se dice en español', async () => {
    mockCategories.mockResolvedValue([])
    const r = await call('create_product_with_variants', args)
    expect(r).toMatchObject({ ok: false })
    expect(r.error).toMatch(/categoría/)
  })

  // ── /full-testing 14-oct ──────────────────────────────────────────────────────────────────────────────────────────
  it('🔴 I-1: si ya hay una familia viva con ese nombre, la vista previa lo dice con su código y no ofrece confirmar', async () => {
    mockNameFree.mockRejectedValue(
      new ConflictError('Ya existe la familia «Playera». Ábrela para agregarle variantes.', 'PRODUCT_GROUP_NAME_TAKEN'),
    )
    const r = await call('create_product_with_variants', args)
    expect(r).toMatchObject({ ok: false, code: 'PRODUCT_GROUP_NAME_TAKEN' })
    expect(r.requiresConfirmation).toBeUndefined()
    expect(mockNameFree).toHaveBeenCalledWith(expect.anything(), 'v1', 'Playera')
  })

  it('🔴 I-1: repetir la MISMA confirmación no crea otra familia (el servicio responde 409 y se devuelve como ok:false)', async () => {
    expect(await confirmar()).toMatchObject({ ok: true })
    mockCreate.mockRejectedValue(
      new ConflictError('Ya existe la familia «Playera». Ábrela para agregarle variantes.', 'PRODUCT_GROUP_NAME_TAKEN'),
    )
    const otra = await confirmar()
    expect(otra).toMatchObject({ ok: false, code: 'PRODUCT_GROUP_NAME_TAKEN' })
    expect(mockAudit).toHaveBeenCalledTimes(1)
  })

  it('🔴 I-3: un precio en 0 o con más de 2 decimales se rechaza antes de la vista previa', async () => {
    for (const price of [0, 19.999]) {
      const r = await raw('create_product_with_variants', { ...args, price })
      expect(r.isError).toBe(true)
    }
    expect(mockCategories).not.toHaveBeenCalled()
  })

  it('🔴 I-5: un local fuera del alcance es una respuesta ok:false, no una excepción', async () => {
    const r = await raw('create_product_with_variants', { ...args, venueId: 'otro-local' })
    expect(JSON.parse(r.content[0].text)).toMatchObject({ ok: false, error: expect.stringMatching(/not in your scope/) })
  })

  it('🔴 I-7: el aviso de plan nombra la función en singular («… no está incluido» concuerda)', async () => {
    await call('create_product_with_variants', args)
    expect(mockGate).toHaveBeenCalledWith('v1', 'PRODUCT_VARIANTS', 'El uso de variantes de producto')
  })

  it('el error escrito para el operador (catálogo maestro) regresa con su código, no como error interno', async () => {
    mockCreate.mockRejectedValue(
      new ConflictError(
        'Este negocio usa el catálogo maestro; las variantes todavía no están disponibles aquí.',
        'PRODUCT_VARIANTS_MASTER_CATALOG',
      ),
    )
    const r = await confirmar()
    expect(r).toMatchObject({ ok: false, code: 'PRODUCT_VARIANTS_MASTER_CATALOG' })
    expect(r.error).toMatch(/catálogo maestro/)
    expect(mockAudit).not.toHaveBeenCalled()
  })
})

describe('group_products_as_variants', () => {
  const args = {
    venueId: 'v1',
    name: 'BODY HARBOR',
    options: [{ name: 'Talla', values: ['34', '36'] }],
    members: [
      { sku: 'BH-34', values: ['34'] },
      { sku: 'BH-36', values: ['36'] },
    ],
  }
  const pv = {
    fingerprint: 'huella-1',
    parent: {
      name: 'BODY HARBOR',
      categoryId: 'cat1',
      type: 'REGULAR',
      ivaTratamiento: 'IVA_0',
      description: null,
      imageUrl: 'https://img/bh.png',
      printStationId: null,
      satProductKey: '53102000',
      satUnitKey: 'H87',
      modifierGroupIds: ['mg2', 'mg1'],
    },
    warnings: [],
    options: [{ name: 'Talla', values: ['34', '36'] }],
    members: [
      {
        productId: 'p34',
        sku: 'BH-34',
        currentName: 'BODY HARBOR - Talla 34',
        newName: 'BODY HARBOR · 34',
        values: ['34'],
        changes: ['Nombre: «BODY HARBOR - Talla 34» → «BODY HARBOR · 34»'],
      },
      { productId: 'p36', sku: 'BH-36', currentName: 'BODY HARBOR - Talla 36', newName: 'BODY HARBOR · 36', values: ['36'], changes: [] },
    ],
  }
  beforeEach(() => {
    mockProducts.mockResolvedValue([
      { id: 'p34', sku: 'BH-34' },
      { id: 'p36', sku: 'BH-36' },
    ])
    mockPreviewGroup.mockResolvedValue(pv)
    mockApplyGroup.mockResolvedValue({ groupId: 'g9', productIds: ['p34', 'p36'], categoryId: 'cat1' })
    mockCategoryById.mockResolvedValue({ name: 'Ropa' })
    mockModifierGroups.mockResolvedValue([
      { id: 'mg1', name: 'Bordado' },
      { id: 'mg2', name: 'Empaque' },
    ])
  })
  const servicio = {
    name: 'BODY HARBOR',
    options: [{ name: 'Talla', values: ['34', '36'] }],
    members: [
      { productId: 'p34', values: ['34'] },
      { productId: 'p36', values: ['36'] },
    ],
  }

  it('sin confirm muestra «actual → nuevo» por producto y no agrupa', async () => {
    const r = await call('group_products_as_variants', args)
    expect(r).toMatchObject({
      requiresConfirmation: true,
      expectedSourceFingerprint: 'huella-1',
      preview: {
        product: 'BODY HARBOR',
        // Codex #6: las opciones que se van a escribir (están en la huella): lo que se confirma es lo que se vio.
        options: [{ name: 'Talla', values: ['34', '36'] }],
        members: [{ sku: 'BH-34', from: 'BODY HARBOR - Talla 34', to: 'BODY HARBOR · 34' }, { sku: 'BH-36' }],
      },
    })
    expect(mockPreviewGroup).toHaveBeenCalledWith('v1', servicio)
    expect(mockApplyGroup).not.toHaveBeenCalled()
  })

  it('🔴 la vista previa muestra el PADRE que resulta: categoría, IVA, claves SAT y extras (del negocio pedido)', async () => {
    const r = await call('group_products_as_variants', args)
    expect(r.preview.parent).toEqual({
      name: 'BODY HARBOR',
      category: 'Ropa',
      iva: 'tasa 0 %',
      satProductKey: '53102000',
      satUnitKey: 'H87',
      extrasCount: 2,
      extras: ['Empaque', 'Bordado'],
      hasImage: true,
    })
    expect(mockCategoryById.mock.calls[0][0].where).toMatchObject({ id: 'cat1', venueId: { in: ['v1'] } })
    expect(mockModifierGroups.mock.calls[0][0].where).toMatchObject({ id: { in: ['mg2', 'mg1'] }, venueId: { in: ['v1'] } })
  })

  it('con la confirmación agrupa con la huella que se vio y audita', async () => {
    const preview = await call('group_products_as_variants', args)
    const r = await call('group_products_as_variants', {
      ...preview.confirmationArguments,
      confirm: true,
      confirmationToken: preview.confirmationToken,
    })
    expect(r).toMatchObject({ ok: true, groupId: 'g9', variantCount: 2 })
    expect(mockApplyGroup).toHaveBeenCalledWith(
      'v1',
      { ...servicio, expectedFingerprint: 'huella-1' },
      {
        type: 'HUMAN',
        staffId: 'owner',
        impersonating: false,
      },
    )
    expect(mockAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'PRODUCT_GROUP_GROUPED_EXISTING', entity: 'ProductGroup', entityId: 'g9', venueId: 'v1' }),
    )
  })

  it('🔴 si los productos cambiaron desde la vista previa, pide repetirla (needsInput), no un error', async () => {
    const preview = await call('group_products_as_variants', args)
    mockApplyGroup.mockRejectedValue(
      new ConflictError('Los productos cambiaron desde la vista previa. Revisa y confirma de nuevo.', 'PRODUCT_GROUP_PREVIEW_STALE'),
    )
    const r = await call('group_products_as_variants', {
      ...preview.confirmationArguments,
      confirm: true,
      confirmationToken: preview.confirmationToken,
    })
    expect(r).toMatchObject({ ok: false, needsInput: true, code: 'PRODUCT_GROUP_PREVIEW_STALE' })
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('🔴 un producto ligado a Shopify ⇒ le dice al asistente que use group_shopify_family (no un error a secas)', async () => {
    mockPreviewGroup.mockRejectedValue(
      new ConflictError(
        '«BODY HARBOR - Talla 34» está ligado a Shopify; se agrupa desde la pestaña Desde Shopify.',
        'PRODUCT_GROUP_SHOPIFY_LINKED',
      ),
    )
    const r = await call('group_products_as_variants', args)
    expect(r).toMatchObject({ ok: false, code: 'PRODUCT_GROUP_SHOPIFY_LINKED', useTool: 'group_shopify_family' })
    expect(r.error).toContain('está ligado a Shopify')
    expect(r.message).toContain('shopify_family_proposals')
    expect(r.message).toContain('group_shopify_family')
    expect(mockApplyGroup).not.toHaveBeenCalled()
  })

  it('un SKU que no existe en el negocio se nombra y no se llama al servicio', async () => {
    mockProducts.mockResolvedValue([{ id: 'p34', sku: 'BH-34' }])
    const r = await call('group_products_as_variants', args)
    expect(r).toMatchObject({ ok: false })
    expect(r.error).toMatch(/BH-36/)
    expect(mockPreviewGroup).not.toHaveBeenCalled()
  })

  it('el SKU se busca SÓLO en el negocio pedido', async () => {
    await call('group_products_as_variants', args)
    expect(mockProducts.mock.calls[0][0].where).toMatchObject({ venueId: { in: ['v1'] }, sku: { in: ['BH-34', 'BH-36'] } })
  })

  it('🔴 sin `menu:update` no agrupa', async () => {
    await reconnect({ role: 'WAITER', corePermissions: ['menu:read', 'menu:create'], isSuperAdmin: false })
    const r = await raw('group_products_as_variants', args)
    expect(JSON.parse(r.content[0].text)).toMatchObject({ ok: false, error: 'Missing permission menu:update for venue v1' })
    expect(mockPreviewGroup).not.toHaveBeenCalled()
  })

  it('🔴 un negocio Gratis recibe el aviso de plan', async () => {
    mockGate.mockResolvedValue('Las variantes de producto no está incluido en el plan actual…')
    const r = await call('group_products_as_variants', args)
    expect(r).toMatchObject({ ok: false, planRequired: true })
    expect(mockPreviewGroup).not.toHaveBeenCalled()
  })

  it('un error del servicio escrito para el operador (IVA ya no ofrecido) se devuelve con su código', async () => {
    mockPreviewGroup.mockRejectedValue(
      new ConflictError('El IVA «8 %» ya no se ofrece; elige 16 %, tasa 0 % o exento.', 'PRODUCT_GROUP_IVA_NOT_OFFERED'),
    )
    const r = await call('group_products_as_variants', args)
    expect(r).toMatchObject({ ok: false, code: 'PRODUCT_GROUP_IVA_NOT_OFFERED' })
  })
})

describe('product_variants', () => {
  it('muestra opciones y cada variante con SKU, código, precio y existencia — sin un campo «variants»', async () => {
    const r = await call('product_variants', { venueId: 'v1', name: 'playera' })
    expect(r).toMatchObject({
      found: true,
      product: {
        name: 'Playera',
        category: 'Ropa',
        options: [{ name: 'Talla', values: ['S', 'M'] }],
        variantCount: 2,
        archivedVariantCount: 1,
        breakdown: [
          { name: 'Playera · S', values: ['S'], sku: 'PLAYERA-S', barcode: null, price: 299, cost: 120, stock: 5, active: true },
          { name: 'Playera · M', values: ['M'], sku: 'PLAYERA-M', barcode: '7501', price: 299, cost: null, stock: null, active: true },
        ],
      },
    })
    expect(r.sales).toBeUndefined()
    expect(JSON.stringify(r)).not.toMatch(/"variants"/)
    expect(mockGetGroup).toHaveBeenCalledWith('v1', 'g1')
    expect(mockGroups.mock.calls[0][0].where).toMatchObject({ venueId: { in: ['v1'] }, deletedAt: null })
    expect(mockQueryRaw).not.toHaveBeenCalled()
  })

  it('la lectura queda abierta aunque el plan no tenga variantes', async () => {
    mockGate.mockResolvedValue('Las variantes de producto no está incluido…')
    expect(await call('product_variants', { venueId: 'v1', name: 'Playera' })).toMatchObject({ found: true })
  })

  it('resolver, no adivinar: dos familias devuelven las opciones con su categoría; el nombre exacto sí resuelve', async () => {
    familias = [
      { id: 'g1', name: 'Playera', category: { name: 'Ropa' } },
      { id: 'g2', name: 'Playera básica', category: { name: 'Ropa' } },
    ]
    expect(await call('product_variants', { venueId: 'v1', name: 'play' })).toMatchObject({
      found: false,
      ambiguous: true,
      matches: [
        { name: 'Playera', category: 'Ropa' },
        { name: 'Playera básica', category: 'Ropa' },
      ],
    })
    expect(mockGetGroup).not.toHaveBeenCalled()
    mockGroups.mockClear()
    expect(await call('product_variants', { venueId: 'v1', name: ' playera ' })).toMatchObject({
      found: true,
      product: { name: 'Playera' },
    })
    expect(mockGetGroup).toHaveBeenCalledWith('v1', 'g1')
    // Primero el nombre exacto: con eso basta y no se busca por «contiene».
    expect(mockGroups).toHaveBeenCalledTimes(1)
    expect(mockGroups.mock.calls[0][0].where.name).toEqual({ equals: 'playera', mode: 'insensitive' })
  })

  it('homónimas en dos categorías: se muestran con su categoría y `category` desempata', async () => {
    familias = [
      { id: 'g1', name: 'Playera', category: { name: 'Ropa' } },
      { id: 'g2', name: 'Playera', category: { name: 'Niños' } },
    ]
    expect(await call('product_variants', { venueId: 'v1', name: 'Playera' })).toMatchObject({
      ambiguous: true,
      matches: [
        { name: 'Playera', category: 'Ropa' },
        { name: 'Playera', category: 'Niños' },
      ],
    })
    expect(await call('product_variants', { venueId: 'v1', name: 'Playera', category: 'niños' })).toMatchObject({ found: true })
    expect(mockGetGroup).toHaveBeenCalledWith('v1', 'g2')
  })

  it('🔴 Codex #10: homónimas en la MISMA categoría devuelven su groupId, y `groupId` (del negocio) elige una', async () => {
    familias = [
      { id: 'g1', name: 'Playera', category: { name: 'Ropa' } },
      { id: 'g2', name: 'Playera', category: { name: 'Ropa' } },
    ]
    expect(await call('product_variants', { venueId: 'v1', name: 'Playera' })).toMatchObject({
      ambiguous: true,
      matches: [
        { groupId: 'g1', name: 'Playera', category: 'Ropa' },
        { groupId: 'g2', name: 'Playera', category: 'Ropa' },
      ],
    })
    mockGroups.mockClear()
    expect(await call('product_variants', { venueId: 'v1', name: 'Playera', groupId: 'g2' })).toMatchObject({ found: true })
    expect(mockGetGroup).toHaveBeenCalledWith('v1', 'g2')
    expect(mockGroups.mock.calls[0][0].where).toMatchObject({ id: 'g2', venueId: { in: ['v1'] } })
  })

  it('Codex #9: sin fechas, una familia archivada no aparece (el catálogo de hoy)', async () => {
    familias = [{ id: 'g3', name: 'Sudadera', category: { name: 'Ropa' }, deletedAt: new Date('2025-04-01') }]
    expect(await call('product_variants', { venueId: 'v1', name: 'Sudadera' })).toMatchObject({ found: false })
    expect(mockGetGroup).not.toHaveBeenCalled()
  })

  it('🔴 Codex #9: con fechas, las ventas de una familia ARCHIVADA se consultan y se marca archived:true', async () => {
    familias = [{ id: 'g3', name: 'Sudadera', category: { name: 'Ropa' }, deletedAt: new Date('2025-04-01') }]
    mockGetGroup.mockResolvedValue({ ...detalle, id: 'g3', name: 'Sudadera', variants: [], archivedCount: 2 })
    const r = await call('product_variants', { venueId: 'v1', name: 'Sudadera', fromDate: '2025-03-01', toDate: '2025-03-31' })
    expect(r).toMatchObject({ found: true, product: { name: 'Sudadera', archived: true }, sales: { unitsSold: 0 } })
    expect(mockGetGroup).toHaveBeenCalledWith('v1', 'g3')
    expect(mockQueryRaw).toHaveBeenCalled()
  })

  it('Codex #9: con fechas, entre una viva y una archivada del mismo nombre gana la viva (sin ambigüedad)', async () => {
    familias = [
      { id: 'g3', name: 'Playera', category: { name: 'Ropa' }, deletedAt: new Date('2025-04-01') },
      { id: 'g1', name: 'Playera', category: { name: 'Ropa' } },
    ]
    const r = await call('product_variants', { venueId: 'v1', name: 'Playera', fromDate: '2025-03-01' })
    expect(r).toMatchObject({ found: true })
    expect(r.product.archived).toBeUndefined()
    expect(mockGetGroup).toHaveBeenCalledWith('v1', 'g1')
  })

  it('sin coincidencias lo dice', async () => {
    familias = []
    expect(await call('product_variants', { venueId: 'v1', name: 'Zapato' })).toMatchObject({ found: false })
  })

  describe('con rango de fechas: ventas por variante y total de la familia', () => {
    const fila = (productId: string, name: string, sku: string, units: string, revenue: string, lines: number, archived = false) => ({
      productId,
      name,
      sku,
      archived,
      units: new Prisma.Decimal(units),
      revenue: new Prisma.Decimal(revenue),
      lines: BigInt(lines),
    })

    it('🔴 el total de la familia cuadra al centavo con la suma de sus variantes (también las archivadas que vendieron)', async () => {
      mockQueryRaw.mockResolvedValue([
        fila('p1', 'Playera · S', 'PLAYERA-S', '3', '884.955', 2),
        fila('p2', 'Playera · M', 'PLAYERA-M', '4', '1312.25', 2),
        // 10.075 → 10.07 con el redondeo de product_sales (Math.round(n × 100) / 100); un redondeo «mitad arriba» daría 10.08.
        fila('p0', 'Playera · XS', 'PLAYERA-XS', '0.435', '10.075', 1, true),
      ])
      const r = await call('product_variants', { venueId: 'v1', name: 'Playera', fromDate: '2025-03-11', toDate: '2025-03-11' })
      const ventas = r.sales
      expect(ventas.timezone).toBe('America/Mexico_City')
      // Fechas del NEGOCIO: el 11 de marzo en Ciudad de México va de 06:00Z a 05:59:59.999Z del día siguiente.
      expect(ventas.window).toEqual({ start: '2025-03-11T06:00:00.000Z', end: '2025-03-12T05:59:59.999Z' })
      expect(ventas.byVariant).toEqual([
        { name: 'Playera · S', sku: 'PLAYERA-S', unitsSold: 3, revenue: 884.96, timesOrdered: 2 },
        { name: 'Playera · M', sku: 'PLAYERA-M', unitsSold: 4, revenue: 1312.25, timesOrdered: 2 },
        { name: 'Playera · XS', sku: 'PLAYERA-XS', unitsSold: 0.44, revenue: 10.07, timesOrdered: 1, archived: true },
      ])
      const cents = (n: number) => Math.round(n * 100)
      expect(cents(ventas.revenue)).toBe(ventas.byVariant.reduce((s: number, v: { revenue: number }) => s + cents(v.revenue), 0))
      expect(cents(ventas.revenue)).toBe(88496 + 131225 + 1007)
      expect(ventas.unitsSold).toBe(7.44)
      expect(ventas.timesOrdered).toBe(5)
      expect(JSON.stringify(r)).not.toMatch(/"variants"/)
    })

    it('una variante viva sin ventas aparece en cero', async () => {
      mockQueryRaw.mockResolvedValue([fila('p2', 'Playera · M', 'PLAYERA-M', '1', '299', 1)])
      const r = await call('product_variants', { venueId: 'v1', name: 'Playera', fromDate: '2025-03-11' })
      expect(r.sales.byVariant).toEqual([
        { name: 'Playera · S', sku: 'PLAYERA-S', unitsSold: 0, revenue: 0, timesOrdered: 0 },
        { name: 'Playera · M', sku: 'PLAYERA-M', unitsSold: 1, revenue: 299, timesOrdered: 1 },
      ])
      expect(r.sales).toMatchObject({ unitsSold: 1, revenue: 299, timesOrdered: 1 })
    })

    it('la consulta filtra por la familia, el negocio y la ventana con binds en UTC', async () => {
      await call('product_variants', { venueId: 'v1', name: 'Playera', fromDate: '2025-03-11', toDate: '2025-03-11' })
      const [strings, ...values] = mockQueryRaw.mock.calls[0]
      const sql = (strings as string[]).join('?')
      expect(sql).toMatch(/"productGroupId"\s*=/)
      expect(sql).toMatch(/o\."venueId"\s*=/)
      expect(values).toEqual(expect.arrayContaining(['g1', 'v1']))
    })

    it('🔴 las ventas piden lo mismo que el reporte de ventas: `reports:read`', async () => {
      await reconnect({ role: 'WAITER', corePermissions: ['menu:read'], isSuperAdmin: false })
      expect(await call('product_variants', { venueId: 'v1', name: 'Playera' })).toMatchObject({ found: true })
      const r = await raw('product_variants', { venueId: 'v1', name: 'Playera', fromDate: '2025-03-11' })
      expect(JSON.parse(r.content[0].text)).toMatchObject({ ok: false, error: 'Missing permission reports:read for venue v1' })
      expect(mockQueryRaw).not.toHaveBeenCalled()
    })

    it('🔴 y el mismo plan que el reporte de ventas (reportes avanzados)', async () => {
      mockGate.mockImplementation(async (_v: string, code: string) => (code === 'ADVANCED_REPORTS' ? 'Los reportes avanzados no…' : null))
      const r = await call('product_variants', { venueId: 'v1', name: 'Playera', toDate: '2025-03-11' })
      expect(r).toMatchObject({ ok: false, planRequired: true })
      expect(mockQueryRaw).not.toHaveBeenCalled()
    })

    it('una fecha que no es YYYY-MM-DD se rechaza antes de consultar', async () => {
      const r = await raw('product_variants', { venueId: 'v1', name: 'Playera', fromDate: 'hoy' })
      expect(r.isError).toBe(true)
      expect(mockQueryRaw).not.toHaveBeenCalled()
    })

    it.each(['2025-13-40', '2025-02-30'])('una fecha que no existe (%s) se rechaza en español antes de consultar', async fecha => {
      const r = await raw('product_variants', { venueId: 'v1', name: 'Playera', toDate: fecha })
      expect(r.isError).toBe(true)
      expect(JSON.stringify(r.content)).toMatch(/no existe/)
      expect(mockQueryRaw).not.toHaveBeenCalled()
    })

    it('la consulta lleva un tope de respaldo y, si se alcanza, lo dice en vez de truncar en silencio', async () => {
      await call('product_variants', { venueId: 'v1', name: 'Playera', fromDate: '2025-03-11' })
      expect((mockQueryRaw.mock.calls[0][0] as string[]).join('?')).toMatch(/LIMIT/)
      mockQueryRaw.mockResolvedValue(Array.from({ length: 1000 }, (_, i) => fila(`a${i}`, `Playera · A${i}`, `A${i}`, '1', '1', 1, true)))
      const r = await call('product_variants', { venueId: 'v1', name: 'Playera', fromDate: '2025-03-11' })
      expect(r.sales.incomplete).toBe(true)
      expect(r.sales.note).toMatch(/incomplet/)
    })

    it('sólo toDate: la ventana son los 30 días que terminan ESE día, no una ventana vacía', async () => {
      const r = await call('product_variants', { venueId: 'v1', name: 'Playera', toDate: '2025-03-31' })
      expect(r.sales.window).toEqual({ start: '2025-03-01T06:00:00.000Z', end: '2025-04-01T05:59:59.999Z' })
    })

    it('una fecha inicial posterior a la final se dice en español y no consulta', async () => {
      const r = await call('product_variants', { venueId: 'v1', name: 'Playera', fromDate: '2025-03-12', toDate: '2025-03-11' })
      expect(r).toMatchObject({ ok: false })
      expect(r.error).toMatch(/posterior/)
      expect(mockQueryRaw).not.toHaveBeenCalled()
    })
  })
})

describe('catálogo', () => {
  it('🔴 las tres son del modo libre: el catálogo certificado no las anuncia ni las ejecuta', async () => {
    await reconnect(OWNER, 'directory')
    const { tools } = await client.listTools()
    expect(tools.map(t => t.name)).toEqual([])
    expect((await raw('product_variants', { venueId: 'v1', name: 'Playera' })).isError).toBe(true)
    expect(mockGetGroup).not.toHaveBeenCalled()
  })

  it('lectura y escrituras declaran su efecto', async () => {
    const { tools } = await client.listTools()
    const hint = (n: string) => tools.find(t => t.name === n)?.annotations?.readOnlyHint
    expect([hint('product_variants'), hint('create_product_with_variants'), hint('group_products_as_variants')]).toEqual([
      true,
      false,
      false,
    ])
  })
})

describe('group_shopify_family (confirmación en dos pasos del catálogo)', () => {
  const spid = 'gid://shopify/Product/42'
  beforeEach(() => {
    mockShopifyPreview.mockResolvedValue({
      mode: 'CREATE',
      groupId: null,
      parent: { name: 'Sudadera', ivaTratamiento: 'IVA_16' },
      options: [{ name: 'Talla', values: ['S'] }],
      members: [{ productId: 'p1', sku: 'SUD-S', currentName: 'Sudadera · S', newName: 'Sudadera · S', values: ['S'], changes: [] }],
      skipped: [],
      warnings: [],
      fingerprint: 'huella-shopify',
    })
    mockShopifyBatch.mockResolvedValue({ applied: [{ shopifyProductId: spid, groupId: 'g7', mode: 'CREATE' }], skipped: [] })
  })

  it('🔴 la vista previa ata expectedItems al token: confirma exactamente esos pares, y otros pares piden otra vista previa', async () => {
    const preview = await call('group_shopify_family', { venueId: 'v1', shopifyProductId: spid })
    expect(preview).toMatchObject({
      requiresConfirmation: true,
      expectedItems: [{ shopifyProductId: spid, fingerprint: 'huella-shopify' }],
    })
    expect(preview.confirmationArguments.expectedItems).toEqual([{ shopifyProductId: spid, fingerprint: 'huella-shopify' }])
    const cambiado = await call('group_shopify_family', {
      ...preview.confirmationArguments,
      expectedItems: [{ shopifyProductId: spid, fingerprint: 'otra' }],
      confirm: true,
      confirmationToken: preview.confirmationToken,
    })
    expect(cambiado).toMatchObject({ ok: false, needsInput: true, field: 'confirmationToken' })
    expect(mockShopifyBatch).not.toHaveBeenCalled()
    const r = await call('group_shopify_family', {
      ...preview.confirmationArguments,
      confirm: true,
      confirmationToken: preview.confirmationToken,
    })
    expect(r).toMatchObject({ ok: true, applied: [{ groupId: 'g7' }] })
    expect(mockShopifyBatch).toHaveBeenCalledWith('v1', expect.objectContaining({ staffId: 'owner' }), [
      { shopifyProductId: spid, fingerprint: 'huella-shopify' },
    ])
    expect(mockAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'PRODUCT_GROUP_FROM_SHOPIFY', entityId: 'g7' }),
    )
  })

  it('🔴 sin `menu:update` no muestra ni agrupa', async () => {
    await reconnect({ role: 'WAITER', corePermissions: ['menu:read'], isSuperAdmin: false })
    const r = await call('group_shopify_family', { venueId: 'v1', shopifyProductId: spid })
    expect(r).toMatchObject({ ok: false, error: 'Missing permission menu:update for venue v1' })
    expect(mockShopifyPreview).not.toHaveBeenCalled()
  })
})
