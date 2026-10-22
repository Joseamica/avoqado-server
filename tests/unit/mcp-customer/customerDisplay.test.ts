/**
 * Las CUATRO tools del MCP para la pantalla del cliente (1 lectura + 3 escrituras), llamando a sus manejadores REALES.
 *
 * 🔴 Lo que estas pruebas fijan, y ninguna es cosmética:
 *
 *  1. Leer exige `customer-display:read` y escribir `customer-display:update` — el MISMO gate que las rutas del dashboard.
 *  2. Escribir es de DOS PASOS: la primera llamada no guarda nada y enseña el cambio en español (`antes → después`).
 *  3. `requireWriteScopeAlways` corta una conexión de sólo lectura aunque la bandera de despliegue esté apagada.
 *  4. Se valida ANTES de pedir confirmación, con las MISMAS reglas que el dashboard (esquema estricto + vista previa del
 *     servidor, plan incluido): nunca se confirma algo que el servidor va a rechazar — tampoco un token viejo.
 *  5. El token del CAS es obligatorio en la forma: sin él, la IA pisaría en silencio lo que una persona acaba de guardar.
 */
import { registerCustomerDisplayTools } from '../../../src/mcp/tools/customerDisplay'
import type { McpScope } from '../../../src/mcp/scope'
import { BadRequestError, ConflictError, ForbiddenError } from '@/errors/AppError'
import { TOOL_EFFECTS } from '@/mcp/catalog'

const mockAudit = jest.fn()
const mockWriteScope = jest.fn()
const permisosPedidos: string[] = []
const servicio = {
  getCustomerDisplayForDashboard: jest.fn(),
  listCustomerDisplayDevices: jest.fn(),
  previewCustomerDisplay: jest.fn(),
  saveCustomerDisplayDesign: jest.fn(),
  copyCustomerDisplayDesign: jest.fn(),
  previewCopyCustomerDisplay: jest.fn(),
  resetCustomerDisplayDesign: jest.fn(),
}

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => {
      if (v === 'ajeno') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [v] } }
    },
    requirePermission: (perm: string) => {
      permisosPedidos.push(perm)
    },
  }),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/mcp/requireWriteScopeAlways', () => ({ requireWriteScopeAlways: (...a: unknown[]) => mockWriteScope(...(a as [])) }))
jest.mock('@/services/customer-display/customerDisplayDesign.service', () => ({
  // La tool arma la forma de copy con este tope; `DEVICES_PAGE_MAX` lo lee del módulo PURO de validación (no simulado).
  MAX_COPY_TARGETS: 20,
  getCustomerDisplayForDashboard: (...a: unknown[]) => servicio.getCustomerDisplayForDashboard(...a),
  listCustomerDisplayDevices: (...a: unknown[]) => servicio.listCustomerDisplayDevices(...a),
  previewCustomerDisplay: (...a: unknown[]) => servicio.previewCustomerDisplay(...a),
  saveCustomerDisplayDesign: (...a: unknown[]) => servicio.saveCustomerDisplayDesign(...a),
  copyCustomerDisplayDesign: (...a: unknown[]) => servicio.copyCustomerDisplayDesign(...a),
  previewCopyCustomerDisplay: (...a: unknown[]) => servicio.previewCopyCustomerDisplay(...a),
  resetCustomerDisplayDesign: (...a: unknown[]) => servicio.resetCustomerDisplayDesign(...a),
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const formas = new Map<string, Record<string, any>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (tool: string, args: Record<string, unknown>) => handlers.get(tool)!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerCustomerDisplayTools(
    {
      tool: (...a: unknown[]) => (handlers.set(a[0] as string, a[a.length - 1] as never), formas.set(a[0] as string, a[2] as never)),
    } as never,
    scope,
  )
})
beforeEach(() => {
  jest.clearAllMocks()
  // 🔴 `clearAllMocks` borra las LLAMADAS, no las IMPLEMENTACIONES: sin esto, el mock que lanza en la prueba del candado
  // se filtra a la siguiente y la hace fallar por otro motivo.
  mockWriteScope.mockReset()
  for (const simulado of Object.values(servicio)) simulado.mockReset()
  permisosPedidos.length = 0
  servicio.getCustomerDisplayForDashboard.mockResolvedValue({
    editToken: 'd1:4',
    design: { welcomeText: 'Hola' },
    ficha: { fingerprint: 'f' },
    entitlements: {},
    assetRejected: [],
    device: {},
  })
  servicio.listCustomerDisplayDevices.mockResolvedValue({ total: 1, nextCursor: null, devices: [{ id: 't1', name: 'Caja 1' }] })
  servicio.previewCustomerDisplay.mockResolvedValue({ ficha: { welcomeText: 'Pasa' }, assetRejected: [], previewSeq: 0 })
  servicio.saveCustomerDisplayDesign.mockResolvedValue({ editToken: 'd1:5', ficha: {} })
  servicio.copyCustomerDisplayDesign.mockResolvedValue({ copied: ['t2'], promosOmitted: false })
  servicio.previewCopyCustomerDisplay.mockResolvedValue({
    promosOmitted: false,
    origen: { editToken: 'd1:4', diseno: { welcomeText: 'Hola' } },
    destinos: [{ terminalId: 't2', nombre: 'Caja 2', conservaSusImagenes: false, imagenes: 1 }],
  })
  servicio.resetCustomerDisplayDesign.mockResolvedValue({ editToken: 'd1:5', ficha: {} })
})

const MUTACIONES = [
  [
    'update_customer_display_design',
    { venueId: 'v1', terminalId: 't1', expectedEditToken: 'd1:4', design: { welcomeText: 'Pasa' } },
    'saveCustomerDisplayDesign',
    'CUSTOMER_DISPLAY_DESIGN_UPDATED',
  ],
  [
    'copy_customer_display_design',
    { venueId: 'v1', sourceTerminalId: 't1', sourceEditToken: 'd1:4', targets: [{ terminalId: 't2', editToken: 'factory' }] },
    'copyCustomerDisplayDesign',
    'CUSTOMER_DISPLAY_DESIGN_COPIED',
  ],
  [
    'reset_customer_display_design',
    { venueId: 'v1', terminalId: 't1', expectedEditToken: 'd1:4' },
    'resetCustomerDisplayDesign',
    'CUSTOMER_DISPLAY_DESIGN_RESET',
  ],
] as const

describe('customer_display_design (lectura)', () => {
  it('exige customer-display:read y devuelve el token para editar', async () => {
    const r = parse(await call('customer_display_design', { venueId: 'v1', terminalId: 't1' }))
    expect(permisosPedidos).toEqual(['customer-display:read'])
    expect(r.editToken).toBe('d1:4')
    expect(servicio.getCustomerDisplayForDashboard).toHaveBeenCalledWith('v1', 't1')
  })

  it('un venue ajeno no se puede leer', async () => {
    await expect(call('customer_display_design', { venueId: 'ajeno', terminalId: 't1' })).rejects.toThrow(/out of scope/)
    expect(servicio.getCustomerDisplayForDashboard).not.toHaveBeenCalled()
  })

  // Resolver, no adivinar: sin decir CUÁL dispositivo, se listan los del negocio para elegir; nunca se toma uno al azar.
  it('sin terminalId lista los dispositivos del negocio (acotado) y no lee el diseño de ninguno', async () => {
    const r = parse(await call('customer_display_design', { venueId: 'v1' }))
    expect(permisosPedidos).toEqual(['customer-display:read'])
    expect(servicio.getCustomerDisplayForDashboard).not.toHaveBeenCalled()
    expect(servicio.listCustomerDisplayDevices).toHaveBeenCalledWith({ venueId: 'v1', cursor: undefined, take: 50 })
    expect(r).toMatchObject({ total: 1, nextCursor: null, dispositivos: [{ id: 't1', name: 'Caja 1' }] })
  })

  it('la lista sigue por páginas con el cursor que devolvió la anterior', async () => {
    await call('customer_display_design', { venueId: 'v1', cursor: 't9' })
    expect(servicio.listCustomerDisplayDevices).toHaveBeenCalledWith({ venueId: 'v1', cursor: 't9', take: 50 })
  })

  it('dice qué muestra la tablet, decidido al leer con la regla del panel (la IA no compara huellas)', async () => {
    servicio.getCustomerDisplayForDashboard.mockResolvedValue({
      editToken: 'd1:4',
      design: {},
      ficha: { fingerprint: 'f'.repeat(32) },
      entitlements: {},
      assetRejected: [],
      device: {
        designVersion: 1,
        ack: { fingerprint: 'f'.repeat(32), receivedAt: '2026-10-15T18:00:00.000Z', shownAt: '2026-10-15T17:59:00.000Z' },
      },
    })
    const r = parse(await call('customer_display_design', { venueId: 'v1', terminalId: 't1' }))
    expect(r.enLaTablet).toEqual({ estado: 'MOSTRADO', fecha: '2026-10-15T18:00:00.000Z', imagenesDescargandose: 0, imagenesFallidas: 0 })
    expect(r.aparato.ack).toBeDefined() // el crudo se conserva
  })
})

describe.each(MUTACIONES)('%s', (tool, entrada, metodo, accion) => {
  it('exige customer-display:update', async () => {
    await call(tool, entrada)
    expect(permisosPedidos).toContain('customer-display:update')
    expect(permisosPedidos).not.toContain('customer-display:read')
  })

  it('🔴 un token de SÓLO LECTURA no escribe, aunque la bandera de despliegue esté apagada', async () => {
    mockWriteScope.mockImplementation(() => {
      throw new Error('ScopeError: sólo lectura')
    })
    await expect(call(tool, { ...entrada, confirm: true })).rejects.toThrow(/sólo lectura/)
    expect(servicio[metodo]).not.toHaveBeenCalled()
    expect(mockWriteScope).toHaveBeenCalledWith(scope, 'customer-display:update', expect.stringContaining('cliente'))
  })

  it('un venue ajeno no se toca', async () => {
    await expect(call(tool, { ...entrada, venueId: 'ajeno', confirm: true })).rejects.toThrow(/out of scope/)
    expect(servicio[metodo]).not.toHaveBeenCalled()
  })

  it('la PRIMERA llamada no guarda: enseña el cambio y pide confirmación', async () => {
    expect(parse(await call(tool, entrada))).toMatchObject({ ok: false, requiresConfirmation: true })
    expect(servicio[metodo]).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('la SEGUNDA, con confirm:true, guarda con el token que le dieron y deja auditoría', async () => {
    expect(parse(await call(tool, { ...entrada, confirm: true }))).toMatchObject({ ok: true })
    expect(servicio[metodo]).toHaveBeenCalledTimes(1)
    expect(servicio[metodo]).toHaveBeenCalledWith(expect.objectContaining({ venueId: 'v1', staffId: 's1' }))
    expect(mockAudit).toHaveBeenCalledWith(scope, expect.objectContaining({ action: accion, venueId: 'v1' }))
  })

  it('el token del CAS es OBLIGATORIO en su forma (el SDK lo exige antes de llamar)', () => {
    const forma = formas.get(tool)!
    const campo = tool === 'copy_customer_display_design' ? 'sourceEditToken' : 'expectedEditToken'
    expect(forma[campo].isOptional()).toBe(false)
  })

  // Un rechazo del servidor al GUARDAR (alguien más guardó entre los dos pasos) se devuelve con su código y sus detalles,
  // y no deja auditoría: nada cambió.
  it('si al guardar el servidor rechaza, se dice con su código y NO se audita', async () => {
    servicio[metodo].mockRejectedValueOnce(
      new ConflictError('Alguien más cambió el diseño', 'CUSTOMER_DISPLAY_CONFLICT', { conflicts: ['t2'] }),
    )
    const r = parse(await call(tool, { ...entrada, confirm: true }))
    expect(r).toMatchObject({ ok: false, code: 'CUSTOMER_DISPLAY_CONFLICT', detalles: { conflicts: ['t2'] } })
    expect(mockAudit).not.toHaveBeenCalled()
  })

  // Un error que NO es del operador (un fallo interno) no se disfraza de `ok:false`: se lanza, y `instrument.ts` lo sanea.
  it('un error interno al guardar se LANZA (no se devuelve su texto crudo)', async () => {
    servicio[metodo].mockRejectedValueOnce(new Error('Invalid `prisma.terminal.findFirst()` invocation'))
    await expect(call(tool, { ...entrada, confirm: true })).rejects.toThrow(/prisma/)
    expect(mockAudit).not.toHaveBeenCalled()
  })
})

describe('update: se valida ANTES de pedir confirmación (el molde de receiptLayout)', () => {
  const base = { venueId: 'v1', terminalId: 't1', expectedEditToken: 'd1:4' }

  it('defensa en profundidad del handler (llamado directo, sin el SDK): una llave desconocida en el diseño se rechaza, en español y nombrándola, y NO se ofrece confirmar', async () => {
    const r = parse(await call('update_customer_display_design', { ...base, design: { venueId: 'otro' } }))
    expect(r).toMatchObject({ ok: false, code: 'INVALID_DESIGN' })
    expect(r.error).toMatch(/campo que no existe/)
    expect(r.error).toMatch(/venueId/)
    expect(r.error).not.toMatch(/Unrecognized|Expected/)
    expect(r.requiresConfirmation).toBeUndefined()
    expect(servicio.previewCustomerDisplay).not.toHaveBeenCalled()
  })

  it('lo que el servidor rechazaría (sin plan, una imagen nueva) se dice AHORA, no después de confirmar', async () => {
    servicio.previewCustomerDisplay.mockRejectedValueOnce(
      new ForbiddenError('Las promociones en reposo son del plan PRO.', 'FEATURE_REQUIRES_PRO'),
    )
    const r = parse(await call('update_customer_display_design', { ...base, design: { slides: [{ assetId: 'nueva' }] } }))
    expect(r).toMatchObject({ ok: false, code: 'FEATURE_REQUIRES_PRO' })
    expect(r.requiresConfirmation).toBeUndefined()
    expect(servicio.saveCustomerDisplayDesign).not.toHaveBeenCalled()
  })

  it('una regla de VALORES del servidor (texto largo) también se dice antes de confirmar', async () => {
    servicio.previewCustomerDisplay.mockRejectedValueOnce(new BadRequestError('El texto no puede pasar de 40 caracteres', 'TEXT_TOO_LONG'))
    const r = parse(await call('update_customer_display_design', { ...base, design: { welcomeText: 'x'.repeat(41) } }))
    expect(r).toMatchObject({ ok: false, code: 'TEXT_TOO_LONG' })
    expect(r.requiresConfirmation).toBeUndefined()
  })

  it('la vista previa recibe el borrador YA validado por el esquema, para la terminal y el negocio pedidos', async () => {
    await call('update_customer_display_design', { ...base, design: { welcomeText: 'Pasa' } })
    expect(servicio.previewCustomerDisplay).toHaveBeenCalledWith('v1', 't1', { welcomeText: 'Pasa' }, 0)
  })

  it('la confirmación enseña lo que VERÁ el cliente (la ficha del servidor), no sólo los campos pedidos', async () => {
    const r = parse(await call('update_customer_display_design', { ...base, design: { welcomeText: 'Pasa' } }))
    expect(r.despues).toMatchObject({ welcomeText: 'Pasa' })
    expect(r.antes).toMatchObject({ fingerprint: 'f' })
  })

  // Regla del MCP: la confirmación lleva una vista legible en español, `antes → después`.
  it('la confirmación dice, en español, cada campo que cambia: antes → después', async () => {
    const r = parse(await call('update_customer_display_design', { ...base, design: { welcomeText: 'Pasa', theme: 'DARK' } }))
    expect(r.cambios).toEqual(expect.arrayContaining(['Texto de bienvenida: «Hola» → «Pasa»', 'Tema: claro → oscuro']))
    expect(r.cambios).toHaveLength(2)
  })

  // Codex r8 (remanente de P2-9): la vista previa DEPURA las imágenes que no sirven; guardar las RECHAZA. Confirmar algo
  // así sería confirmar un error.
  it('una imagen que la vista previa descarta NO se ofrece confirmar: ASSET_NOT_USABLE ahora', async () => {
    servicio.previewCustomerDisplay.mockResolvedValueOnce({ ficha: {}, assetRejected: ['ajena'], previewSeq: 0 })
    const r = parse(await call('update_customer_display_design', { ...base, design: { slides: [{ assetId: 'ajena' }] } }))
    expect(r).toMatchObject({ ok: false, code: 'ASSET_NOT_USABLE', assetIds: ['ajena'] })
    expect(r.requiresConfirmation).toBeUndefined()
    expect(servicio.saveCustomerDisplayDesign).not.toHaveBeenCalled()
  })

  // Guardar con un token viejo daría 409: se dice AHORA y con el token vigente, en vez de ofrecer confirmar un error.
  it('si el diseño cambió desde que la IA lo leyó, NO se ofrece confirmar: CUSTOMER_DISPLAY_CONFLICT con el token vigente', async () => {
    const r = parse(await call('update_customer_display_design', { ...base, expectedEditToken: 'd1:3', design: { welcomeText: 'Pasa' } }))
    expect(r).toMatchObject({ ok: false, code: 'CUSTOMER_DISPLAY_CONFLICT', editTokenActual: 'd1:4' })
    expect(r.requiresConfirmation).toBeUndefined()
  })

  it('pedir exactamente lo que ya está no ofrece confirmar nada: NO_CHANGES', async () => {
    const r = parse(await call('update_customer_display_design', { ...base, design: { welcomeText: 'Hola' } }))
    expect(r).toMatchObject({ ok: false, code: 'NO_CHANGES' })
    expect(r.requiresConfirmation).toBeUndefined()
  })

  it('con confirm:true guarda el borrador VALIDADO con el token que le dieron', async () => {
    await call('update_customer_display_design', { ...base, design: { welcomeText: 'Pasa' }, confirm: true })
    expect(servicio.saveCustomerDisplayDesign).toHaveBeenCalledWith({
      venueId: 'v1',
      terminalId: 't1',
      draft: { welcomeText: 'Pasa' },
      expectedEditToken: 'd1:4',
      staffId: 's1',
    })
  })
})

describe('copy: los destinos se revisan ANTES de pedir confirmación', () => {
  const copia = { venueId: 'v1', sourceTerminalId: 't1', sourceEditToken: 'd1:4', targets: [{ terminalId: 't2', editToken: 'factory' }] }

  it('la confirmación enseña qué pasará en cada destino, calculado por el servidor', async () => {
    servicio.previewCopyCustomerDisplay.mockResolvedValueOnce({
      promosOmitted: true,
      origen: { editToken: 'd1:4', diseno: { welcomeText: 'Revisado' } },
      destinos: [{ terminalId: 't2', nombre: 'Caja 2', conservaSusImagenes: true, imagenes: 3 }],
    })
    servicio.getCustomerDisplayForDashboard.mockResolvedValueOnce({ editToken: 'd1:5', design: { welcomeText: 'Otro, guardado después' } })
    const r = parse(await call('copy_customer_display_design', copia))
    expect(r).toMatchObject({
      requiresConfirmation: true,
      promosOmitted: true,
      diseno: { welcomeText: 'Revisado' },
      destinos: [{ terminalId: 't2', conservaSusImagenes: true, imagenes: 3 }],
    })
    expect(r.cambios).toEqual(['Caja 2: su diseño se sustituye por el del origen; conserva sus 3 imágenes'])
    expect(servicio.previewCopyCustomerDisplay).toHaveBeenCalledWith({
      venueId: 'v1',
      source: { terminalId: 't1', editToken: 'd1:4' },
      targets: copia.targets,
    })
  })

  it('M2: un destino con CERO imágenes propias nunca dice «conserva sus ninguna»', async () => {
    servicio.previewCopyCustomerDisplay.mockResolvedValueOnce({
      promosOmitted: true,
      origen: { editToken: 'd1:4', diseno: { welcomeText: 'Revisado' } },
      destinos: [{ terminalId: 't2', nombre: 'Caja 2', conservaSusImagenes: true, imagenes: 0 }],
    })
    const r = parse(await call('copy_customer_display_design', copia))
    expect(r.cambios).toEqual(['Caja 2: su diseño se sustituye por el del origen; no tiene imágenes propias que conservar'])
    expect(r.cambios[0]).not.toMatch(/ninguna/)
  })

  it('M2: un destino con UNA imagen propia dice «conserva su imagen», en singular', async () => {
    servicio.previewCopyCustomerDisplay.mockResolvedValueOnce({
      promosOmitted: true,
      origen: { editToken: 'd1:4', diseno: { welcomeText: 'Revisado' } },
      destinos: [{ terminalId: 't2', nombre: 'Caja 2', conservaSusImagenes: true, imagenes: 1 }],
    })
    const r = parse(await call('copy_customer_display_design', copia))
    expect(r.cambios).toEqual(['Caja 2: su diseño se sustituye por el del origen; conserva su imagen'])
  })

  it('un destino que cambió se dice AHORA y NO se ofrece confirmar', async () => {
    servicio.previewCopyCustomerDisplay.mockRejectedValueOnce(
      new ConflictError('Alguien más cambió el diseño', 'CUSTOMER_DISPLAY_CONFLICT'),
    )
    const r = parse(await call('copy_customer_display_design', copia))
    expect(r).toMatchObject({ ok: false, code: 'CUSTOMER_DISPLAY_CONFLICT' })
    expect(r.requiresConfirmation).toBeUndefined()
    expect(servicio.copyCustomerDisplayDesign).not.toHaveBeenCalled()
  })

  it('con confirm:true copia con los tokens que le dieron, sin volver a revisar por fuera del candado', async () => {
    await call('copy_customer_display_design', { ...copia, confirm: true })
    expect(servicio.copyCustomerDisplayDesign).toHaveBeenCalledWith({
      venueId: 'v1',
      staffId: 's1',
      source: { terminalId: 't1', editToken: 'd1:4' },
      targets: copia.targets,
    })
    expect(mockAudit).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ entityId: 't1', data: expect.objectContaining({ copied: ['t2'] }) }),
    )
  })
})

describe('reset: vuelve al de fábrica, en dos pasos', () => {
  const base = { venueId: 'v1', terminalId: 't1', expectedEditToken: 'd1:4' }

  it('la confirmación dice qué se pierde: cada campo, antes → de fábrica', async () => {
    const r = parse(await call('reset_customer_display_design', base))
    expect(r.cambios).toEqual(['Texto de bienvenida: «Hola» → el de fábrica'])
    expect(r.seQuitaria).toMatchObject({ welcomeText: 'Hola' })
  })

  it('con un token viejo NO se ofrece confirmar: CUSTOMER_DISPLAY_CONFLICT', async () => {
    const r = parse(await call('reset_customer_display_design', { ...base, expectedEditToken: 'd1:3' }))
    expect(r).toMatchObject({ ok: false, code: 'CUSTOMER_DISPLAY_CONFLICT', editTokenActual: 'd1:4' })
    expect(r.requiresConfirmation).toBeUndefined()
  })

  it('si ya está de fábrica, no hay nada que confirmar: NO_CHANGES', async () => {
    servicio.getCustomerDisplayForDashboard.mockResolvedValueOnce({ editToken: 'factory', design: {}, ficha: {} })
    const r = parse(await call('reset_customer_display_design', { ...base, expectedEditToken: 'factory' }))
    expect(r).toMatchObject({ ok: false, code: 'NO_CHANGES' })
    expect(r.requiresConfirmation).toBeUndefined()
  })
})

it('pantalla del cliente: leer lee; actualizar, copiar y restablecer escriben (un efecto faltante tumba el MCP de todos)', () => {
  expect(TOOL_EFFECTS.customer_display_design).toBe('read')
  expect(TOOL_EFFECTS.update_customer_display_design).toBe('write')
  expect(TOOL_EFFECTS.copy_customer_display_design).toBe('write')
  expect(TOOL_EFFECTS.reset_customer_display_design).toBe('write')
})
