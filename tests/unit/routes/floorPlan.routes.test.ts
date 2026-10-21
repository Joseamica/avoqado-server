import express from 'express'
import request from 'supertest'

const mockGet = jest.fn()
const mockPublish = jest.fn()
const mockPerms: string[] = []
const mockFeatures: string[] = []

jest.mock('@/services/dashboard/floorPlan/floorPlan.service', () => ({
  getFloorPlan: (...a: unknown[]) => mockGet(...a),
  publishFloorPlan: (...a: unknown[]) => mockPublish(...a),
}))
jest.mock('@/middlewares/checkPermission.middleware', () => ({
  checkPermission: (p: string) => {
    mockPerms.push(p)
    return (_req: unknown, _res: unknown, next: () => void) => next()
  },
}))
jest.mock('@/middlewares/checkFeatureAccess.middleware', () => ({
  checkFeatureAccess: (code: string) => {
    mockFeatures.push(code)
    return (_req: unknown, _res: unknown, next: () => void) => next()
  },
}))

import floorPlanRoutes from '@/routes/dashboard/floorPlan.routes'
import { publishFloorPlanSchema } from '@/schemas/dashboard/floorPlan.schema'

function app() {
  const a = express()
  a.use(express.json())
  a.use((req, _res, next) => {
    ;(req as any).authContext = { userId: 'staff-1', role: 'MANAGER', venueId: 'v1' }
    next()
  })
  a.use('/venues/:venueId/floor-plan', floorPlanRoutes)
  a.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode ?? 500).json({ message: err.message, code: err.code }))
  return a
}

const body = {
  saveId: '7f1c4b8e-1d2a-4c3b-9e8f-0a1b2c3d4e5f',
  baseFingerprint: '0123456789abcdef',
  areas: [{ clientId: 'a1', name: 'Salón', floorShape: 'WIDE', sortOrder: 0 }],
  tables: [{ clientId: 't1', number: '1', capacity: 4, shape: 'SQUARE', rotation: 0, positionX: 0.5, positionY: 0.5, areaRef: 'a1' }],
  elements: [{ type: 'WALL', areaRef: 'a1', positionX: 0, positionY: 0, endX: 1, endY: 0, rotation: 0 }],
}

beforeEach(() => jest.clearAllMocks())

describe('rutas del plano de mesas', () => {
  it('pide tables:read para leer y tables:configure + TABLE_SERVICE para publicar', () => {
    expect(mockPerms).toEqual(['tables:read', 'tables:configure'])
    expect(mockFeatures).toEqual(['TABLE_SERVICE'])
  })

  it('GET devuelve el plano del venue', async () => {
    mockGet.mockResolvedValue({ fingerprint: 'x', areas: [], tables: [], elements: [] })
    const res = await request(app()).get('/venues/v1/floor-plan')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true, data: { fingerprint: 'x', areas: [], tables: [], elements: [] } })
    expect(mockGet).toHaveBeenCalledWith('v1')
  })

  it('PUT publica con quién lo hizo', async () => {
    mockPublish.mockResolvedValue({ fingerprint: 'y', publicationId: 'p1', replayed: false })
    const res = await request(app()).put('/venues/v1/floor-plan').send(body)
    expect(res.status).toBe(200)
    expect(mockPublish).toHaveBeenCalledWith(
      'v1',
      expect.objectContaining({ saveId: body.saveId, tables: [expect.objectContaining({ number: '1' })] }),
      'staff-1',
    )
  })

  it('un cuerpo vacío se rechaza en español (nunca «Required»)', async () => {
    const res = await request(app()).put('/venues/v1/floor-plan').send({})
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/folio de guardado/i)
    expect(res.body.message).not.toMatch(/Required/)
    expect(mockPublish).not.toHaveBeenCalled()
  })

  it('rechaza coordenadas fuera del plano y una mesa con una sola coordenada', async () => {
    const fuera = { ...body, tables: [{ ...body.tables[0], positionX: 1.5 }] }
    expect((await request(app()).put('/venues/v1/floor-plan').send(fuera)).body.message).toMatch(/dentro del plano/)
    const media = { ...body, tables: [{ ...body.tables[0], positionY: null }] }
    expect((await request(app()).put('/venues/v1/floor-plan').send(media)).body.message).toMatch(/ambas coordenadas/)
  })

  it('rechaza un área sin id ni clientId y campos desconocidos', async () => {
    const sinClave = { ...body, areas: [{ name: 'Salón', floorShape: 'WIDE', sortOrder: 0 }] }
    expect((await request(app()).put('/venues/v1/floor-plan').send(sinClave)).status).toBe(400)
    const extra = { ...body, hack: true }
    expect((await request(app()).put('/venues/v1/floor-plan').send(extra)).body.message).toMatch(/campo no permitido/)
  })

  // Regla de la casa: el middleware muestra el mensaje de Zod tal cual. Ningún tipo equivocado puede
  // salir con el texto por defecto en inglés («Required», «Expected string, received number»…).
  it('ningún tipo equivocado sale con el mensaje de Zod en inglés', async () => {
    const malos: unknown[] = [
      [],
      { ...body, saveId: 5, baseFingerprint: true },
      { ...body, areas: 'Salón' },
      { ...body, areas: ['Salón'] },
      { ...body, areas: [{ clientId: 7, name: 3, floorShape: 'X', sortOrder: 'a' }] },
      { ...body, tables: [{ clientId: 't1', number: 1, capacity: '4', shape: 'OVAL', rotation: 1.5, positionX: 'a', positionY: 0.5 }] },
      { ...body, elements: [{ type: 'WALL', positionX: 0, positionY: 0, rotation: 0, color: 7, label: 4 }] },
    ]
    for (const malo of malos) {
      const res = await request(app())
        .put('/venues/v1/floor-plan')
        .send(malo as object)
      expect(res.status).toBe(400)
      expect({ malo, message: res.body.message }).not.toEqual(
        expect.objectContaining({ message: expect.stringMatching(/Required|Expected|Invalid|received|must be/) }),
      )
    }
    expect(mockPublish).not.toHaveBeenCalled()
  })

  it('los mensajes de los números son frases correctas (artículo en minúscula, plural concordado)', () => {
    const mensajes = (b: unknown) => {
      const r = publishFloorPlanSchema.safeParse({ params: { venueId: 'v1' }, body: b })
      return r.success ? [] : r.error.errors.map(e => e.message)
    }
    const t = body.tables[0]
    const sin = (campo: keyof typeof t) => Object.fromEntries(Object.entries(t).filter(([k]) => k !== campo))
    expect(mensajes({ ...body, tables: [sin('positionX')] })).toContain('Falta la posición')
    expect(mensajes({ ...body, tables: [{ ...t, positionX: 'a' }] })).toContain('La posición debe ser un número')
    expect(mensajes({ ...body, tables: [{ ...t, positionX: 2 }] })).toContain('La posición debe estar dentro del plano')
    expect(mensajes({ ...body, tables: [sin('capacity')] })).toContain('Faltan las personas')
    expect(mensajes({ ...body, tables: [{ ...t, capacity: '4' }] })).toContain('Las personas deben ser un número')
    expect(mensajes({ ...body, tables: [sin('rotation')] })).toContain('Falta el giro')
    expect(mensajes({ ...body, tables: [{ ...t, rotation: 'x' }] })).toContain('El giro debe ser un número')
    expect(mensajes({ ...body, tables: [{ ...t, rotation: 1.5 }] })).toContain('El giro debe ser un número entero')
    expect(mensajes({ ...body, areas: [{ ...body.areas[0], sortOrder: 'a' }] })).toContain('El orden debe ser un número')
    const barra = { type: 'BAR_COUNTER', areaRef: 'a1', positionX: 0, positionY: 0, rotation: 0, width: 0, height: 2 }
    expect(mensajes({ ...body, elements: [barra] })).toEqual(
      expect.arrayContaining(['El ancho debe ser mayor a cero', 'El alto no puede salirse del plano']),
    )
    const pared = { type: 'WALL', areaRef: 'a1', positionX: 0, positionY: 0, rotation: 0, endX: 3, endY: 0 }
    expect(mensajes({ ...body, elements: [pared] })).toContain('El final de la pared debe estar dentro del plano')
    // Ningún mensaje empieza en minúscula ni trae el artículo en mayúscula a media frase («Falta La posición»).
    const todos = [
      { ...body, tables: [{ ...t, positionX: 'a', positionY: undefined, capacity: undefined, rotation: 'x' }] },
      { ...body, areas: [{ ...body.areas[0], sortOrder: undefined }] },
      { ...body, elements: [{ ...barra, width: 'a', height: undefined, positionX: 'b' }] },
    ].flatMap(mensajes)
    expect(todos.length).toBeGreaterThan(5)
    for (const m of todos) expect(m).toMatch(/^[A-ZÁÉÍÓÚÑ¿]/)
    for (const m of todos) expect(m).not.toMatch(/\s(La|El|Las|Los) /)
  })
})
