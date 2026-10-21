/**
 * RH fase 1a — herramientas MCP de puestos y asignaciones (spec RH §6-7, regla «MCP en sync»).
 * Usa el guard REAL (permiso por sucursal + scope mcp:write) y mocks sólo de los servicios, la auditoría y la base.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StaffRole } from '@prisma/client'
import { z } from 'zod'
import { BadRequestError, ConflictError, ForbiddenError } from '@/errors/AppError'
import { configureToolCatalog, TOOL_EFFECTS } from '@/mcp/catalog'
import { registerRhTools } from '@/mcp/tools/rh'
import { registerStaffTools } from '@/mcp/tools/staff'
import type { McpScope } from '@/mcp/scope'

const mockListar = jest.fn()
const mockCrear = jest.fn()
const mockArchivar = jest.fn()
const mockAsignar = jest.fn()
const mockTerminar = jest.fn()
const mockVigentes = jest.fn()
const mockAsegurar = jest.fn()
const mockPagoGenerico = jest.fn()
const mockAudit = jest.fn()
const mockVenueFind = jest.fn()
const mockStaffVenueFind = jest.fn()
const mockStaffVenueFindMany = jest.fn()
const mockPosicionFind = jest.fn()
const mockAsignacionFind = jest.fn()

jest.mock('@/services/dashboard/rh/puestos.service', () => ({
  listarPuestos: (...a: unknown[]) => mockListar(...(a as [])),
  crearPuesto: (...a: unknown[]) => mockCrear(...(a as [])),
  archivarPuesto: (...a: unknown[]) => mockArchivar(...(a as [])),
}))
jest.mock('@/services/dashboard/rh/asignaciones.service', () => ({
  asignarPuesto: (...a: unknown[]) => mockAsignar(...(a as [])),
  terminarAsignacion: (...a: unknown[]) => mockTerminar(...(a as [])),
  asignacionesVigentes: (...a: unknown[]) => mockVigentes(...(a as [])),
}))
jest.mock('@/services/dashboard/rh/marcaBlanca', () => ({
  asegurarSedeNoMarcaBlanca: (...a: unknown[]) => mockAsegurar(...(a as [])),
  pagoGenericoPermitido: (...a: unknown[]) => mockPagoGenerico(...(a as [])),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: (...a: unknown[]) => mockVenueFind(...(a as [])) },
    staffVenue: {
      findUnique: (...a: unknown[]) => mockStaffVenueFind(...(a as [])),
      findMany: (...a: unknown[]) => mockStaffVenueFindMany(...(a as [])),
      count: jest.fn().mockResolvedValue(2),
    },
    staffPosition: { findFirst: (...a: unknown[]) => mockPosicionFind(...(a as [])) },
    staffAssignment: { findFirst: (...a: unknown[]) => mockAsignacionFind(...(a as [])) },
  },
}))

type Handler = (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>
const V = 'v1'
const S = 'staff-1'
const P = 'pos-1'
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)
const FECHA = /^\d{4}-\d{2}-\d{2}$/

function armar(perms: string[] = ['teams:read', 'teams:update'], scopes: string[] = ['mcp:read', 'mcp:write']) {
  const scope = {
    staffId: 'actor-1',
    activeOrg: 'o1',
    scopes,
    allowedVenueIds: [V],
    perVenueAccess: new Map([[V, { role: StaffRole.MANAGER, corePermissions: perms } as never]]),
  } as McpScope
  const handlers = new Map<string, Handler>()
  const shapes = new Map<string, z.ZodRawShape>()
  const descs = new Map<string, string>()
  const server = {
    tool: (...a: unknown[]) => {
      handlers.set(a[0] as string, a[a.length - 1] as Handler)
      descs.set(a[0] as string, typeof a[1] === 'string' ? a[1] : '')
      shapes.set(a[0] as string, (a.length === 4 ? a[2] : a[1]) as z.ZodRawShape)
    },
  } as never
  registerRhTools(server, scope)
  registerStaffTools(server, scope)
  return {
    call: async (name: string, args: Record<string, unknown>) => parse(await handlers.get(name)!(args, {})),
    raw: (name: string, args: Record<string, unknown>) => handlers.get(name)!(args, {}),
    schema: (name: string) => z.object(shapes.get(name)!),
    descs,
  }
}

/** Cliente MCP real contra un servidor con el catálogo (confirmación firmada) y las herramientas de RH. */
async function conectado() {
  const scope = {
    staffId: 'actor-1',
    activeOrg: 'o1',
    scopes: ['mcp:read', 'mcp:write'],
    allowedVenueIds: [V],
    perVenueAccess: new Map([[V, { role: StaffRole.MANAGER, corePermissions: ['teams:read', 'teams:update'] } as never]]),
  } as McpScope
  const server = new McpServer({ name: 'rh-test', version: '1' })
  const client = new Client({ name: 'test', version: '1' })
  configureToolCatalog(server, scope)
  registerRhTools(server, scope)
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
  return { client, close: async () => (await client.close(), await server.close()) }
}

const dtoPuesto = (o: Record<string, unknown> = {}) => ({
  id: P,
  name: 'Coach',
  color: null,
  icon: null,
  suggestedRole: 'WAITER',
  suggestedRelation: null,
  tracksAttendanceDefault: true,
  componentKinds: [],
  archivedAt: null,
  personasVigentes: 2,
  ...o,
})
const dtoAsignacion = (o: Record<string, unknown> = {}) => ({
  id: 'asg-1',
  staffId: S,
  positionId: P,
  positionName: 'Coach',
  relation: null,
  effectiveFrom: '2026-10-01',
  effectiveTo: null,
  tracksAttendance: true,
  supersedesId: null,
  ...o,
})

beforeEach(() => {
  jest.resetAllMocks()
  mockAsegurar.mockResolvedValue(undefined)
  mockPagoGenerico.mockResolvedValue(true)
  mockVenueFind.mockResolvedValue({ timezone: 'America/Mexico_City' })
  mockStaffVenueFind.mockResolvedValue({ active: true, staff: { firstName: 'Ana', lastName: 'López' } })
  mockPosicionFind.mockResolvedValue({ name: 'Coach', archivedAt: null })
  mockAsignacionFind.mockResolvedValue({
    effectiveTo: null,
    position: { name: 'Coach' },
    staff: { firstName: 'Ana', lastName: 'López' },
  })
  mockCrear.mockResolvedValue(dtoPuesto())
  // Archivado por ESTA llamada: su archivedAt es de ahora (uno anterior a la llamada significa «ya estaba archivado»).
  mockArchivar.mockImplementation(async () => dtoPuesto({ archivedAt: new Date().toISOString() }))
  mockAsignar.mockResolvedValue(dtoAsignacion())
  mockTerminar.mockResolvedValue(dtoAsignacion({ effectiveTo: '2026-10-11' }))
  mockVigentes.mockResolvedValue(new Map())
})

describe('MCP RH', () => {
  describe('list_positions', () => {
    it('devuelve los puestos con «Sin definir» y la paginación, y manda limit/offset al servicio', async () => {
      mockListar.mockResolvedValue({
        data: [dtoPuesto(), dtoPuesto({ id: 'pos-2', name: 'Barbero', suggestedRelation: 'RENTA_SILLA' })],
        total: 5,
        hasMore: true,
      })
      const out = await armar().call('list_positions', { venueId: V, includeArchived: true, limit: 2, offset: 2 })

      expect(mockAsegurar).toHaveBeenCalledWith(V)
      expect(mockListar).toHaveBeenCalledWith(V, { incluirArchivados: true, limit: 2, offset: 2 })
      expect(out).toMatchObject({ venueId: V, count: 2, total: 5, hasMore: true, nextOffset: 4 })
      expect(out.puestos[0]).toMatchObject({
        positionId: P,
        nombre: 'Coach',
        relacionSugerida: 'Sin definir',
        personasVigentes: 2,
        archivado: false,
      })
      expect(out.puestos[1]).toMatchObject({ nombre: 'Barbero', relacionSugerida: 'RENTA_SILLA' })
    })

    it('marca blanca ⇒ 403 también en la lectura, sin tocar el servicio', async () => {
      mockAsegurar.mockRejectedValue(new ForbiddenError('Puestos y relación de RH no está disponible en esta sucursal.'))
      await expect(armar().call('list_positions', { venueId: V })).rejects.toThrow('no está disponible')
      expect(mockListar).not.toHaveBeenCalled()
    })

    it('sin teams:read o fuera de scope ⇒ rechazado', async () => {
      await expect(armar(['teams:update']).call('list_positions', { venueId: V })).rejects.toThrow('teams:read')
      await expect(armar().call('list_positions', { venueId: 'ajena' })).rejects.toThrow('not in your scope')
      expect(mockListar).not.toHaveBeenCalled()
    })
  })

  describe('create_position', () => {
    const base = { venueId: V, name: 'Coach', suggestedRole: 'WAITER' }

    it('sin confirm devuelve vista previa y NO escribe ni audita', async () => {
      const out = await armar().call('create_position', base)
      expect(out).toMatchObject({
        ok: false,
        requiresConfirmation: true,
        preview: { nombre: 'Coach', rolSugerido: 'WAITER', relacionSugerida: 'Sin definir', checaAsistencia: true },
      })
      expect(mockCrear).not.toHaveBeenCalled()
      expect(mockAudit).not.toHaveBeenCalled()
    })

    it('con confirm crea con el actor de la conexión y audita', async () => {
      const out = await armar().call('create_position', { ...base, name: 'Coach', suggestedRelation: 'RENTA_SILLA', confirm: true })
      expect(mockCrear).toHaveBeenCalledWith(
        expect.objectContaining({
          venueId: V,
          actorId: 'actor-1',
          name: 'Coach',
          suggestedRole: 'WAITER',
          suggestedRelation: 'RENTA_SILLA',
        }),
      )
      expect(mockAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'STAFF_POSITION_CREATED', entity: 'StaffPosition', entityId: P, venueId: V }),
      )
      expect(out).toMatchObject({ ok: true, puesto: { positionId: P, nombre: 'Coach' } })
    })

    it('regresión: sin teams:update ⇒ rechazado; con token de sólo lectura también', async () => {
      await expect(armar(['teams:read']).call('create_position', { ...base, confirm: true })).rejects.toThrow('teams:update')
      await expect(armar(['teams:update'], ['mcp:read']).call('create_position', { ...base, confirm: true })).rejects.toThrow('mcp:write')
      expect(mockCrear).not.toHaveBeenCalled()
    })

    it('el servicio rechaza (409) ⇒ ok:false con su mensaje en español, sin auditar', async () => {
      mockCrear.mockRejectedValue(new ConflictError('Ya existe un puesto llamado «Coach» en esta sucursal.'))
      const out = await armar().call('create_position', { ...base, confirm: true })
      expect(out).toEqual({ ok: false, error: 'Ya existe un puesto llamado «Coach» en esta sucursal.' })
      expect(mockAudit).not.toHaveBeenCalled()
    })

    it('un fallo inesperado NO se disfraza de respuesta: sube para que lo sanee el instrumentador', async () => {
      mockCrear.mockRejectedValue(new TypeError('boom interno'))
      await expect(armar().call('create_position', { ...base, confirm: true })).rejects.toThrow('boom interno')
    })

    it('el esquema nunca acepta SUPERADMIN, nombres vacíos ni una relación que no existe', () => {
      const s = armar().schema('create_position')
      expect(s.safeParse({ ...base, suggestedRole: 'SUPERADMIN' }).success).toBe(false)
      expect(s.safeParse({ ...base, name: '' }).success).toBe(false)
      expect(s.safeParse({ ...base, suggestedRelation: 'Sin definir' }).success).toBe(false)
      expect(s.safeParse({ ...base, suggestedRelation: null }).success).toBe(true)
    })
  })

  describe('archive_position', () => {
    const base = { venueId: V, positionId: P }

    it('sin confirm: vista previa con el nombre y NO archiva', async () => {
      const out = await armar().call('archive_position', base)
      expect(out).toMatchObject({ requiresConfirmation: true, preview: { puesto: 'Coach' } })
      expect(mockArchivar).not.toHaveBeenCalled()
      expect(mockAudit).not.toHaveBeenCalled()
    })

    it('con confirm archiva y audita', async () => {
      const out = await armar().call('archive_position', { ...base, confirm: true })
      expect(mockArchivar).toHaveBeenCalledWith({ venueId: V, actorId: 'actor-1', positionId: P })
      expect(mockAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'STAFF_POSITION_ARCHIVED', entityId: P }))
      expect(out).toMatchObject({ ok: true, puesto: { archivado: true } })
    })

    it('ya estaba archivado (lo archivó otra persona antes) ⇒ responde ok pero NO escribe auditoría de esta conexión', async () => {
      mockArchivar.mockResolvedValue(dtoPuesto({ archivedAt: '2026-01-01T00:00:00.000Z' }))
      const out = await armar().call('archive_position', { ...base, confirm: true })
      expect(mockArchivar).toHaveBeenCalledTimes(1)
      expect(mockAudit).not.toHaveBeenCalled()
      expect(out).toMatchObject({ ok: true, puesto: { positionId: P, archivado: true } })
    })

    it('puesto ajeno o ya archivado ⇒ ok:false en la vista previa', async () => {
      mockPosicionFind.mockResolvedValueOnce(null)
      expect(await armar().call('archive_position', base)).toMatchObject({ ok: false, error: 'Ese puesto no existe en esta sucursal.' })
      mockPosicionFind.mockResolvedValueOnce({ name: 'Coach', archivedAt: new Date() })
      expect(await armar().call('archive_position', base)).toMatchObject({ ok: false, error: expect.stringContaining('ya está archivado') })
      expect(mockArchivar).not.toHaveBeenCalled()
    })

    it('sin teams:update ⇒ rechazado', async () => {
      await expect(armar(['teams:read']).call('archive_position', { ...base, confirm: true })).rejects.toThrow('teams:update')
      expect(mockArchivar).not.toHaveBeenCalled()
    })
  })

  describe('assign_staff_position', () => {
    const base = { venueId: V, staffId: S, positionId: P }

    it('sin confirm devuelve vista previa (con nombres, «Sin definir» y la fecha concreta de hoy) y NO escribe', async () => {
      const out = await armar().call('assign_staff_position', base)
      expect(out.requiresConfirmation).toBe(true)
      expect(out.preview).toEqual({ persona: 'Ana López', puesto: 'Coach', relacion: 'Sin definir', fecha: expect.stringMatching(FECHA) })
      expect(out.fecha).toBe(out.preview.fecha) // arriba también: es lo que ata la confirmación firmada
      expect(mockAsignar).not.toHaveBeenCalled()
      expect(mockAudit).not.toHaveBeenCalled()
    })

    describe('«hoy» es la fecha civil de la sede', () => {
      beforeEach(() =>
        jest.useFakeTimers({ now: new Date('2026-10-12T05:00:00Z'), doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }),
      )
      afterEach(() => jest.useRealTimers())

      it('la vista previa devuelve ese día arriba y en el preview, según la zona horaria de la sede', async () => {
        const t = armar()
        // 05:00 UTC = 23:00 del 11 en Ciudad de México y 14:00 del 12 en Tokio.
        mockVenueFind.mockResolvedValue({ timezone: 'America/Mexico_City' })
        const mx = await t.call('assign_staff_position', base)
        expect(mx.fecha).toBe('2026-10-11')
        expect(mx.preview.fecha).toBe('2026-10-11')
        expect(mx.message).toContain('desde 2026-10-11')
        mockVenueFind.mockResolvedValue({ timezone: 'Asia/Tokyo' })
        expect((await t.call('assign_staff_position', base)).fecha).toBe('2026-10-12')
        expect(mockVenueFind).toHaveBeenCalledWith({ where: { id: V }, select: { timezone: true } })
      })

      it('si la persona ya pasó una fecha, esa se respeta y no se consulta la zona horaria', async () => {
        const out = await armar().call('assign_staff_position', { ...base, fecha: '2026-10-01' })
        expect(out.fecha).toBe('2026-10-01')
        expect(out.preview.fecha).toBe('2026-10-01')
        expect(mockVenueFind).not.toHaveBeenCalled()
      })
    })

    it('con confirm escribe (relación vacía = null) y audita', async () => {
      const out = await armar().call('assign_staff_position', { ...base, fecha: '2026-10-01', confirm: true })
      expect(mockAsignar).toHaveBeenCalledWith({
        venueId: V,
        staffId: S,
        positionId: P,
        relation: null,
        fecha: '2026-10-01',
        actorId: 'actor-1',
      })
      expect(mockAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'STAFF_ASSIGNMENT_CREATED',
          entity: 'StaffAssignment',
          entityId: 'asg-1',
          venueId: V,
          data: expect.objectContaining({ staffId: S, positionId: P, relation: null }),
        }),
      )
      expect(out).toMatchObject({ ok: true, asignacion: { id: 'asg-1', relation: 'Sin definir' } })
    })

    it('una relación explícita llega tal cual al servicio', async () => {
      mockAsignar.mockResolvedValue(dtoAsignacion({ relation: 'ASIMILADO' }))
      const out = await armar().call('assign_staff_position', { ...base, relation: 'ASIMILADO', confirm: true })
      expect(mockAsignar).toHaveBeenCalledWith(expect.objectContaining({ relation: 'ASIMILADO' }))
      expect(out.asignacion.relation).toBe('ASIMILADO')
    })

    it('persona inactiva, ajena o puesto archivado ⇒ ok:false desde la vista previa', async () => {
      const t = armar()
      mockStaffVenueFind.mockResolvedValueOnce(null)
      expect(await t.call('assign_staff_position', base)).toMatchObject({ ok: false, error: 'Esa persona no trabaja en esta sucursal.' })
      mockStaffVenueFind.mockResolvedValueOnce({ active: false, staff: { firstName: 'Ana', lastName: 'López' } })
      expect(await t.call('assign_staff_position', base)).toMatchObject({ ok: false, error: 'Esa persona no está activa en este negocio.' })
      mockPosicionFind.mockResolvedValueOnce(null)
      expect(await t.call('assign_staff_position', base)).toMatchObject({ ok: false, error: 'Ese puesto no existe en esta sucursal.' })
      mockPosicionFind.mockResolvedValueOnce({ name: 'Coach', archivedAt: new Date() })
      expect(await t.call('assign_staff_position', base)).toMatchObject({ ok: false, error: expect.stringContaining('archivado') })
      expect(mockAsignar).not.toHaveBeenCalled()
    })

    it('marca blanca ⇒ 403 incluso en la vista previa', async () => {
      mockAsegurar.mockRejectedValue(new ForbiddenError('Puestos y relación de RH no está disponible en esta sucursal.'))
      await expect(armar().call('assign_staff_position', base)).rejects.toThrow('no está disponible')
      await expect(armar().call('assign_staff_position', { ...base, confirm: true })).rejects.toThrow('no está disponible')
      expect(mockAsignar).not.toHaveBeenCalled()
    })

    it('sin teams:update ⇒ rechazado', async () => {
      await expect(armar(['teams:read']).call('assign_staff_position', { ...base, confirm: true })).rejects.toThrow('teams:update')
      expect(mockAsignar).not.toHaveBeenCalled()
    })

    it('errores de negocio del servicio (periodo cerrado, traslape, fecha futura) vuelven como ok:false', async () => {
      const t = armar()
      mockAsignar.mockRejectedValueOnce(new ConflictError('Ya tiene ese puesto en esas fechas.'))
      expect(await t.call('assign_staff_position', { ...base, confirm: true })).toEqual({
        ok: false,
        error: 'Ya tiene ese puesto en esas fechas.',
      })
      mockAsignar.mockRejectedValueOnce(new BadRequestError('No se permiten fechas futuras. Usa la fecha de hoy o una anterior.'))
      expect(await t.call('assign_staff_position', { ...base, fecha: '2030-01-01', confirm: true })).toMatchObject({ ok: false })
      expect(mockAudit).not.toHaveBeenCalled()
    })

    it('el esquema pide la fecha AAAA-MM-DD y una relación válida', () => {
      const s = armar().schema('assign_staff_position')
      expect(s.safeParse({ ...base, fecha: '1/10/2026' }).success).toBe(false)
      expect(s.safeParse({ ...base, relation: 'Sin definir' }).success).toBe(false)
      expect(s.safeParse({ ...base, relation: null, fecha: '2026-10-01' }).success).toBe(true)
    })
  })

  describe('end_staff_assignment', () => {
    const base = { venueId: V, assignmentId: 'asg-1' }

    it('sin confirm: vista previa con persona y puesto, y NO termina nada', async () => {
      const out = await armar().call('end_staff_assignment', base)
      expect(out.preview).toEqual({ persona: 'Ana López', puesto: 'Coach', ultimoDia: expect.stringMatching(FECHA) })
      expect(out.fecha).toBe(out.preview.ultimoDia) // arriba también: es lo que ata la confirmación firmada
      expect(mockTerminar).not.toHaveBeenCalled()
      expect(mockAudit).not.toHaveBeenCalled()
    })

    it('«hoy» es la fecha civil de la sede (23:00 del 11 en Ciudad de México, aunque en UTC ya sea 12) y una fecha dada se respeta', async () => {
      jest.useFakeTimers({ now: new Date('2026-10-12T05:00:00Z'), doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] })
      try {
        const t = armar()
        const out = await t.call('end_staff_assignment', base)
        expect(out.fecha).toBe('2026-10-11')
        expect(out.preview.ultimoDia).toBe('2026-10-11')
        expect(out.message).toContain('último día: 2026-10-11')
        mockVenueFind.mockClear()
        expect((await t.call('end_staff_assignment', { ...base, fecha: '2026-10-05' })).fecha).toBe('2026-10-05')
        expect(mockVenueFind).not.toHaveBeenCalled()
      } finally {
        jest.useRealTimers()
      }
    })

    it('con confirm termina en la fecha dada y audita', async () => {
      const out = await armar().call('end_staff_assignment', { ...base, fecha: '2026-10-11', confirm: true })
      expect(mockTerminar).toHaveBeenCalledWith({ venueId: V, assignmentId: 'asg-1', fecha: '2026-10-11', actorId: 'actor-1' })
      expect(mockAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'STAFF_ASSIGNMENT_ENDED', entity: 'StaffAssignment', entityId: 'asg-1', venueId: V }),
      )
      expect(out).toMatchObject({ ok: true, asignacion: { id: 'asg-1', effectiveTo: '2026-10-11' } })
    })

    it('asignación ajena o ya terminada ⇒ ok:false desde la vista previa', async () => {
      const t = armar()
      mockAsignacionFind.mockResolvedValueOnce(null)
      expect(await t.call('end_staff_assignment', base)).toMatchObject({ ok: false, error: 'Esa asignación no existe en esta sucursal.' })
      mockAsignacionFind.mockResolvedValueOnce({
        effectiveTo: new Date(),
        position: { name: 'Coach' },
        staff: { firstName: 'Ana', lastName: 'López' },
      })
      expect(await t.call('end_staff_assignment', base)).toMatchObject({ ok: false, error: 'Esa asignación ya terminó.' })
      expect(mockTerminar).not.toHaveBeenCalled()
    })

    it('marca blanca y falta de permiso ⇒ rechazado', async () => {
      await expect(armar(['teams:read']).call('end_staff_assignment', { ...base, confirm: true })).rejects.toThrow('teams:update')
      mockAsegurar.mockRejectedValue(new ForbiddenError('Puestos y relación de RH no está disponible en esta sucursal.'))
      await expect(armar().call('end_staff_assignment', { ...base, confirm: true })).rejects.toThrow('no está disponible')
      expect(mockTerminar).not.toHaveBeenCalled()
    })
  })

  describe('list_staff y staff_detail traen los puestos vigentes', () => {
    const filas = [
      { id: 'sv-1', staffId: 'st-1', role: 'MANAGER', staff: { firstName: 'Ana', lastName: 'Alfa', active: true } },
      { id: 'sv-2', staffId: 'st-2', role: 'WAITER', staff: { firstName: 'Beto', lastName: 'Beta', active: true } },
    ]

    it('list_staff: UNA llamada por página (sin N+1), «Sin definir» y persona sin puesto ⇒ []', async () => {
      mockStaffVenueFindMany.mockResolvedValue(filas)
      mockVigentes.mockResolvedValue(
        new Map([
          [
            'st-1',
            [
              dtoAsignacion({ staffId: 'st-1', relation: null }),
              dtoAsignacion({
                id: 'asg-2',
                positionId: 'pos-2',
                positionName: 'Barbero',
                relation: 'RENTA_SILLA',
                effectiveFrom: '2026-09-15',
              }),
            ],
          ],
        ]),
      )
      const out = await armar().call('list_staff', { venueId: V })

      expect(mockVigentes).toHaveBeenCalledTimes(1)
      expect(mockVigentes).toHaveBeenCalledWith(V, ['st-1', 'st-2'], expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/))
      expect(out.staff[0].puestos).toEqual([
        { assignmentId: 'asg-1', positionId: P, nombre: 'Coach', relacion: 'Sin definir', desde: '2026-10-01' },
        { assignmentId: 'asg-2', positionId: 'pos-2', nombre: 'Barbero', relacion: 'RENTA_SILLA', desde: '2026-09-15' },
      ])
      expect(out.staff[1].puestos).toEqual([])
      expect(out.staff[0]).toMatchObject({ staffVenueId: 'sv-1', staffId: 'st-1', name: 'Ana Alfa', role: 'MANAGER', active: true })
    })

    it('la descripción de list_staff avisa, en español llano, que en marca blanca no se incluyen los puestos', () => {
      expect(armar().descs.get('list_staff')).toMatch(/no se incluyen en sucursales de marca blanca/)
    })

    it('list_staff en marca blanca: no hay puestos y ni se consultan', async () => {
      mockStaffVenueFindMany.mockResolvedValue(filas)
      mockPagoGenerico.mockResolvedValue(false)
      const out = await armar().call('list_staff', { venueId: V })
      expect(out.staff[0]).not.toHaveProperty('puestos')
      expect(mockVigentes).not.toHaveBeenCalled()
    })

    it('staff_detail: los puestos de esa persona en la sucursal', async () => {
      mockStaffVenueFindMany
        .mockResolvedValueOnce([{ staffId: 'st-1', staff: { firstName: 'Ana', lastName: 'Alfa', active: true } }])
        .mockResolvedValueOnce([{ role: 'MANAGER', venue: { name: 'Centro' } }])
      mockVigentes.mockResolvedValue(new Map([['st-1', [dtoAsignacion({ staffId: 'st-1' })]]]))
      const out = await armar().call('staff_detail', { venueId: V, name: 'ana' })

      expect(mockVigentes).toHaveBeenCalledWith(V, ['st-1'], expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/))
      expect(out.puestos).toEqual([{ assignmentId: 'asg-1', positionId: P, nombre: 'Coach', relacion: 'Sin definir', desde: '2026-10-01' }])
      expect(out.venues).toEqual([{ venue: 'Centro', role: 'MANAGER' }])
    })
  })

  describe('por el protocolo MCP real (catálogo con confirmación firmada)', () => {
    it('cada parámetro declara su tipo (sin $ref a otro parámetro) y las cinco herramientas se anuncian', async () => {
      const c = await conectado()
      try {
        const { tools } = await c.client.listTools()
        const mias = tools.filter(t => /position|assignment/.test(t.name))
        expect(mias.map(t => t.name).sort()).toEqual([
          'archive_position',
          'assign_staff_position',
          'create_position',
          'end_staff_assignment',
          'list_positions',
        ])
        const sinTipo: string[] = []
        for (const t of mias)
          for (const [k, v] of Object.entries((t.inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>))
            if ('$ref' in v || !(v.type || v.anyOf || v.enum)) sinTipo.push(`${t.name}.${k}`)
        expect(sinTipo).toEqual([])
      } finally {
        await c.close()
      }
    })

    it('la vista previa devuelve un token y SÓLO con él (y los mismos argumentos) se escribe', async () => {
      const c = await conectado()
      try {
        const args = { venueId: V, staffId: S, positionId: P, relation: null, fecha: '2026-10-01' }
        const previa = (await c.client.callTool({ name: 'assign_staff_position', arguments: args })).structuredContent as {
          data: Record<string, any>
        }
        expect(previa.data.requiresConfirmation).toBe(true)
        expect(previa.data.confirmationToken).toEqual(expect.any(String))
        expect(mockAsignar).not.toHaveBeenCalled()

        const sinToken = await c.client.callTool({ name: 'assign_staff_position', arguments: { ...args, confirm: true } })
        expect(sinToken.structuredContent).toMatchObject({ status: 'needs_input', data: { needsInput: true, field: 'confirmationToken' } })
        expect(mockAsignar).not.toHaveBeenCalled()

        const hecho = await c.client.callTool({
          name: 'assign_staff_position',
          arguments: { ...previa.data.confirmationArguments, confirm: true, confirmationToken: previa.data.confirmationToken },
        })
        expect(hecho.isError).not.toBe(true)
        expect(mockAsignar).toHaveBeenCalledTimes(1)
        expect(mockAsignar).toHaveBeenCalledWith(
          expect.objectContaining({ staffId: S, positionId: P, relation: null, fecha: '2026-10-01', actorId: 'actor-1' }),
        )
      } finally {
        await c.close()
      }
    })
  })

  describe('la fecha de «hoy» queda atada a la confirmación firmada', () => {
    type Previa = { structuredContent: { data: Record<string, any> } }

    it('asignar sin fecha: la vista previa fija el día, el token lo ata y SÓLO con ese día se escribe', async () => {
      const c = await conectado()
      try {
        const args = { venueId: V, staffId: S, positionId: P }
        const previa = (await c.client.callTool({ name: 'assign_staff_position', arguments: args })) as unknown as Previa
        const { data } = previa.structuredContent
        expect(data.fecha).toMatch(FECHA)
        expect(data.confirmationArguments).toMatchObject({ ...args, fecha: data.fecha })

        // Confirmar con los argumentos originales (sin el día que se vio) ya no vale: el token cubre la fecha.
        const sinDia = await c.client.callTool({
          name: 'assign_staff_position',
          arguments: { ...args, confirm: true, confirmationToken: data.confirmationToken },
        })
        expect(sinDia.structuredContent).toMatchObject({ status: 'needs_input', data: { field: 'confirmationToken' } })
        expect(mockAsignar).not.toHaveBeenCalled()

        const hecho = await c.client.callTool({
          name: 'assign_staff_position',
          arguments: { ...data.confirmationArguments, confirm: true, confirmationToken: data.confirmationToken },
        })
        expect(hecho.isError).not.toBe(true)
        expect(mockAsignar).toHaveBeenCalledTimes(1)
        expect(mockAsignar).toHaveBeenCalledWith(expect.objectContaining({ staffId: S, positionId: P, fecha: data.fecha }))
      } finally {
        await c.close()
      }
    })

    it('terminar sin fecha: igual, el último día que se VIO es el que se escribe', async () => {
      const c = await conectado()
      try {
        const args = { venueId: V, assignmentId: 'asg-1' }
        const previa = (await c.client.callTool({ name: 'end_staff_assignment', arguments: args })) as unknown as Previa
        const { data } = previa.structuredContent
        expect(data.fecha).toMatch(FECHA)
        expect(data.confirmationArguments).toMatchObject({ ...args, fecha: data.fecha })

        const hecho = await c.client.callTool({
          name: 'end_staff_assignment',
          arguments: { ...data.confirmationArguments, confirm: true, confirmationToken: data.confirmationToken },
        })
        expect(hecho.isError).not.toBe(true)
        expect(mockTerminar).toHaveBeenCalledWith(expect.objectContaining({ assignmentId: 'asg-1', fecha: data.fecha }))
      } finally {
        await c.close()
      }
    })
  })

  describe('regresión', () => {
    const NUNCA = /por fuera|informal|sin comprobante/i

    it('registra las cinco herramientas con su efecto declarado', () => {
      const { descs } = armar()
      expect([...descs.keys()].filter(n => /position|assignment/.test(n)).sort()).toEqual([
        'archive_position',
        'assign_staff_position',
        'create_position',
        'end_staff_assignment',
        'list_positions',
      ])
      expect(TOOL_EFFECTS).toMatchObject({
        list_positions: 'read',
        create_position: 'write',
        archive_position: 'write',
        assign_staff_position: 'write',
        end_staff_assignment: 'write',
      })
    })

    it('ni las descripciones ni las vistas previas dicen «por fuera», «informal» o «sin comprobante»', async () => {
      const t = armar()
      for (const n of ['list_positions', 'create_position', 'archive_position', 'assign_staff_position', 'end_staff_assignment'])
        expect({ n, desc: t.descs.get(n) }).toEqual({ n, desc: expect.not.stringMatching(NUNCA) })
      const previas = [
        await t.raw('create_position', { venueId: V, name: 'Coach', suggestedRole: 'WAITER' }),
        await t.raw('archive_position', { venueId: V, positionId: P }),
        await t.raw('assign_staff_position', { venueId: V, staffId: S, positionId: P }),
        await t.raw('end_staff_assignment', { venueId: V, assignmentId: 'asg-1' }),
      ]
      for (const p of previas) expect(p.content[0].text).not.toMatch(NUNCA)
    })

    it('las lecturas de las vistas previas (persona, puesto, asignación) siempre llevan venueId en su where', async () => {
      const t = armar()
      await t.call('archive_position', { venueId: V, positionId: P })
      expect(mockPosicionFind).toHaveBeenLastCalledWith(expect.objectContaining({ where: { id: P, venueId: V } }))

      mockPosicionFind.mockClear()
      await t.call('assign_staff_position', { venueId: V, staffId: S, positionId: P })
      expect(mockStaffVenueFind).toHaveBeenLastCalledWith(
        expect.objectContaining({ where: { staffId_venueId: { staffId: S, venueId: V } } }),
      )
      expect(mockPosicionFind).toHaveBeenLastCalledWith(expect.objectContaining({ where: { id: P, venueId: V } }))

      await t.call('end_staff_assignment', { venueId: V, assignmentId: 'asg-1' })
      expect(mockAsignacionFind).toHaveBeenLastCalledWith(expect.objectContaining({ where: { id: 'asg-1', venueId: V } }))
    })

    it('asignar o terminar un puesto no toca el rol: sólo llama a los servicios de asignaciones', async () => {
      const t = armar()
      await t.call('assign_staff_position', { venueId: V, staffId: S, positionId: P, confirm: true })
      await t.call('end_staff_assignment', { venueId: V, assignmentId: 'asg-1', confirm: true })
      expect(mockAsignar).toHaveBeenCalledTimes(1)
      expect(mockTerminar).toHaveBeenCalledTimes(1)
    })

    it('las descripciones no mencionan tablas ni Prisma (lo cubre catalog-no-internals.test.ts)', () => {
      const { descs } = armar()
      for (const n of ['list_positions', 'create_position', 'archive_position', 'assign_staff_position', 'end_staff_assignment'])
        expect(descs.get(n)).not.toMatch(/prisma|StaffVenue|StaffPosition|StaffAssignment|ActivityLog/i)
    })
  })
})
