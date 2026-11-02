/**
 * La subida del sello dice de entrada que una imagen es demasiado grande: al dibujar la tarjeta no se abriría (Codex, 2-nov-2026).
 */
import { uploadCardImageHandler } from '@/controllers/dashboard/loyalty.dashboard.controller'
import { NotFoundError } from '@/errors/AppError'
import { prismaMock } from '../../../__helpers__/setup'

function encabezadoPng(ancho: number, alto: number): Buffer {
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4, 'latin1')
  ihdr.writeUInt32BE(ancho, 8)
  ihdr.writeUInt32BE(alto, 12)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr])
}

const subir = (kind: string, ancho: number, alto: number) =>
  uploadCardImageHandler(
    { params: { venueId: 'v1' }, query: { kind }, body: {}, file: { buffer: encabezadoPng(ancho, alto), originalname: 'x.png' } } as any,
    {} as any,
  )

describe('uploadCardImageHandler: sello demasiado grande', () => {
  beforeEach(() => prismaMock.venue.findUnique.mockResolvedValue(null))

  it('🔴 pasando de 5000×5000 lo rechaza con su medida, sin guardar nada', async () => {
    await expect(subir('stamp', 6000, 6000)).rejects.toThrow('El sello es demasiado grande (6000×6000)')
    expect(prismaMock.venue.findUnique).not.toHaveBeenCalled()
  })

  it.each([
    ['alta resolución', 4096, 4096],
    ['justo en el tope', 5000, 5000],
  ])('%s sigue pasando', async (_, ancho, alto) => {
    await expect(subir('stamp', ancho, alto)).rejects.toThrow(NotFoundError) // llegó hasta buscar el negocio
  })

  it('un logo grande no cambia: el logo no se abre al dibujar', async () => {
    await expect(subir('logo', 6000, 2000)).rejects.toThrow(NotFoundError)
  })
})
