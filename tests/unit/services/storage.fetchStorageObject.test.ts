// tests/unit/services/storage.fetchStorageObject.test.ts
// El servidor sólo descarga objetos de NUESTRO Storage (logo del venue, PDF/XML de CFDI). Sin esto,
// `Venue.logo` con una URL arbitraria haría al servidor pedir cualquier destino (SSRF) y cargarlo
// entero en memoria (auditoría de Codex, 21-sep-2026).
jest.mock('../../../src/config/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))

import { fetchStorageObject, StorageFetchError } from '../../../src/services/storage.service'

const okResponse = (bytes: Buffer, headers: Record<string, string> = {}) =>
  ({
    ok: true,
    status: 200,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  }) as unknown as Response

describe('fetchStorageObject', () => {
  it('descarga un objeto de storage.googleapis.com / firebasestorage.googleapis.com, sin seguir redirecciones y con timeout', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(okResponse(Buffer.from('%PDF'), { 'content-type': 'application/pdf' }))
    const out = await fetchStorageObject('https://storage.googleapis.com/avoqado/prod/venues/x/cfdi/a.pdf', { maxBytes: 1024 }, fetchImpl)
    expect(out.equals(Buffer.from('%PDF'))).toBe(true)
    const [, init] = fetchImpl.mock.calls[0]
    expect(init.redirect).toBe('error')
    expect(init.signal).toBeDefined()
    await expect(
      fetchStorageObject(
        'https://firebasestorage.googleapis.com/v0/b/avoqado-d0a24.appspot.com/o/prod%2Flogo.jpg?alt=media',
        { maxBytes: 1024 },
        fetchImpl,
      ),
    ).resolves.toBeInstanceOf(Buffer)
  })

  it('rechaza cualquier otro host, http plano y URLs inválidas SIN hacer la petición', async () => {
    const fetchImpl = jest.fn()
    for (const url of ['https://evil.example/x.png', 'http://storage.googleapis.com/b/x', 'https://169.254.169.254/latest', 'no-es-url']) {
      await expect(fetchStorageObject(url, { maxBytes: 1024 }, fetchImpl)).rejects.toBeInstanceOf(StorageFetchError)
    }
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rechaza por tamaño: Content-Length mayor al tope, o cuerpo mayor al tope aunque no venga Content-Length', async () => {
    const big = Buffer.alloc(2048, 1)
    await expect(
      fetchStorageObject(
        'https://storage.googleapis.com/b/x',
        { maxBytes: 1024 },
        jest.fn().mockResolvedValue(okResponse(big, { 'content-length': '2048' })),
      ),
    ).rejects.toThrow(/tope/)
    await expect(
      fetchStorageObject('https://storage.googleapis.com/b/x', { maxBytes: 1024 }, jest.fn().mockResolvedValue(okResponse(big))),
    ).rejects.toThrow(/tope/)
  })

  it('con cuerpo en STREAM sin Content-Length: corta al superar el tope sin leer el resto', async () => {
    let reads = 0
    const chunk = new Uint8Array(600)
    const reader = {
      read: jest.fn(async () => {
        reads += 1
        return reads <= 5 ? { done: false, value: chunk } : { done: true, value: undefined }
      }),
      cancel: jest.fn(async () => undefined),
    }
    const res = { ok: true, status: 200, headers: { get: () => null }, body: { getReader: () => reader } } as unknown as Response
    await expect(
      fetchStorageObject('https://storage.googleapis.com/b/x', { maxBytes: 1024 }, jest.fn().mockResolvedValue(res)),
    ).rejects.toThrow(/tope/)
    expect(reads).toBe(2) // 600 + 600 > 1024: se detuvo en el segundo trozo, nunca leyó los 5
    expect(reader.cancel).toHaveBeenCalled()
  })

  it('exige el tipo de contenido cuando se pide (logo = imagen)', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(okResponse(Buffer.from('<html>'), { 'content-type': 'text/html' }))
    await expect(
      fetchStorageObject('https://storage.googleapis.com/b/logo', { maxBytes: 1024, contentTypePrefix: 'image/' }, fetchImpl),
    ).rejects.toThrow(/tipo/)
  })

  it('un status no-2xx es error, con el status en el mensaje', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 404, headers: { get: () => null } })
    await expect(fetchStorageObject('https://storage.googleapis.com/b/x', { maxBytes: 1024 }, fetchImpl)).rejects.toThrow(/404/)
  })
})
