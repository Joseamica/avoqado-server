jest.mock('@/services/customer/consent.service')
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn() },
  },
}))

import { getPublicPrivacyNotice } from '@/controllers/public/privacyNotice.public.controller'
import * as consentSvc from '@/services/customer/consent.service'
import prisma from '@/utils/prismaClient'

const mockGetNotice = consentSvc.getCurrentPrivacyNotice as jest.Mock
const mockVenueFindUnique = (prisma as any).venue.findUnique as jest.Mock

function mockRes() {
  const res: any = {}
  res.statusCode = 200
  res.body = undefined
  res.status = jest.fn((c: number) => {
    res.statusCode = c
    return res
  })
  res.type = jest.fn(() => res)
  res.send = jest.fn((b: string) => {
    res.body = b
    return res
  })
  res.json = jest.fn((b: unknown) => {
    res.body = b
    return res
  })
  return res
}

beforeEach(() => {
  jest.clearAllMocks()
})

/**
 * Fix round 1 (revisor, post-Task 7/8): esta ruta es PÚBLICA y adivinable — cualquiera
 * puede pedirla para cualquier venueId, sin haber recibido un correo. Estas pruebas fijan
 * las dos cosas que el revisor pidió: la plantilla (`esPlantilla:true`) NUNCA se sirve aquí
 * (b), y la página se ve en un navegador, no en un lector de JSON (a, c) — con todo lo que
 * teclea el dueño escapado antes de entrar al HTML (d).
 */
describe('GET /venues/:venueId/privacy-notice', () => {
  it('(a) venue CON aviso + Accept: text/html ⇒ página HTML con el texto del aviso', async () => {
    mockVenueFindUnique.mockResolvedValue({ id: 'v1', name: 'Testarudo Café', email: 'hola@testarudo.mx', phone: null })
    mockGetNotice.mockResolvedValue({
      id: 'not1',
      content: 'Mi aviso real de privacidad, ya publicado',
      contentHash: 'h',
      language: 'es',
      createdAt: new Date('2026-01-01'),
      esPlantilla: false,
    })
    const req: any = { params: { venueId: 'v1' }, get: () => 'text/html' }
    const res = mockRes()

    await getPublicPrivacyNotice(req, res, jest.fn())

    expect(res.statusCode).toBe(200)
    expect(res.type).toHaveBeenCalledWith('html')
    expect(res.body).toContain('Mi aviso real de privacidad, ya publicado')
    expect(res.body).toContain('Testarudo Café')
    expect(res.json).not.toHaveBeenCalled()
  })

  // 🔴 El caso central de este fix: sin aviso propio, la plantilla de precarga NUNCA debe
  // aparecer en la página pública — sólo la honestidad de que no hay nada publicado, más
  // el contacto del negocio (si lo tiene) para que el titular le escriba directamente.
  it('(b) venue SIN aviso propio ⇒ dice que no hay aviso publicado y NUNCA muestra el texto de la plantilla', async () => {
    mockVenueFindUnique.mockResolvedValue({ id: 'v1', name: 'Café Sin Aviso', email: 'hola@sinaviso.mx', phone: null })
    mockGetNotice.mockResolvedValue({
      id: null,
      content: 'TEXTO DE LA PLANTILLA — Aviso de Privacidad — Secretaría Anticorrupción y Buen Gobierno',
      contentHash: null,
      language: 'es',
      createdAt: null,
      esPlantilla: true,
    })
    const req: any = { params: { venueId: 'v1' }, get: () => 'text/html' }
    const res = mockRes()

    await getPublicPrivacyNotice(req, res, jest.fn())

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('todavía no ha publicado su aviso de privacidad')
    expect(res.body).not.toContain('TEXTO DE LA PLANTILLA')
    expect(res.body).not.toContain('Secretaría Anticorrupción y Buen Gobierno')
    expect(res.body).toContain('hola@sinaviso.mx') // el contacto SÍ se ofrece
  })

  it('(c) Accept: application/json sigue devolviendo el JSON (para el consumo programático)', async () => {
    mockVenueFindUnique.mockResolvedValue({ id: 'v1', name: 'Testarudo Café', email: 'hola@testarudo.mx', phone: null })
    mockGetNotice.mockResolvedValue({
      id: 'not1',
      content: 'Mi aviso real',
      contentHash: 'h',
      language: 'es',
      createdAt: new Date('2026-01-01'),
      esPlantilla: false,
    })
    const req: any = { params: { venueId: 'v1' }, get: () => 'application/json' }
    const res = mockRes()

    await getPublicPrivacyNotice(req, res, jest.fn())

    expect(res.json).toHaveBeenCalledWith({ data: { content: 'Mi aviso real', language: 'es', esPlantilla: false } })
    expect(res.send).not.toHaveBeenCalled()
  })

  // Sin aviso propio + JSON: el mismo candado que en HTML — nunca `content`, sólo el aviso
  // de "no publicado" más el contacto.
  it('(c-bis) Accept: application/json sin aviso propio ⇒ JSON honesto, sin content de la plantilla', async () => {
    mockVenueFindUnique.mockResolvedValue({ id: 'v1', name: 'Café Sin Aviso', email: 'hola@sinaviso.mx', phone: null })
    mockGetNotice.mockResolvedValue({
      id: null,
      content: 'TEXTO DE LA PLANTILLA',
      contentHash: null,
      language: 'es',
      createdAt: null,
      esPlantilla: true,
    })
    const req: any = { params: { venueId: 'v1' }, get: () => 'application/json' }
    const res = mockRes()

    await getPublicPrivacyNotice(req, res, jest.fn())

    expect(res.json).toHaveBeenCalledWith({ data: { published: false, venueName: 'Café Sin Aviso', contact: 'hola@sinaviso.mx' } })
  })

  it('(d) el contenido del aviso y el nombre del venue se ESCAPAN antes de entrar al HTML', async () => {
    mockVenueFindUnique.mockResolvedValue({ id: 'v1', name: '<script>alert(1)</script> Café', email: null, phone: null })
    mockGetNotice.mockResolvedValue({
      id: 'not1',
      content: '<img src=x onerror=alert(1)>',
      contentHash: 'h',
      language: 'es',
      createdAt: new Date('2026-01-01'),
      esPlantilla: false,
    })
    const req: any = { params: { venueId: 'v1' }, get: () => 'text/html' }
    const res = mockRes()

    await getPublicPrivacyNotice(req, res, jest.fn())

    expect(res.body).not.toContain('<script>alert(1)</script>')
    expect(res.body).not.toContain('<img src=x onerror=alert(1)>')
    expect(res.body).toContain('&lt;script&gt;')
    expect(res.body).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('venueId inexistente ⇒ 404 vía next(), sin consultar el aviso', async () => {
    mockVenueFindUnique.mockResolvedValue(null)
    const req: any = { params: { venueId: 'no-existe' }, get: () => 'text/html' }
    const res = mockRes()
    const next = jest.fn()

    await getPublicPrivacyNotice(req, res, next)

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('Negocio no encontrado') }))
    expect(mockGetNotice).not.toHaveBeenCalled()
  })
})
