/**
 * La puerta S14 del lanzamiento: que el límite de altas cuente PERSONAS y no bordes de Cloudflare.
 * Los valores de IP de aquí son los REALES que se midieron en producción el 17-sep.
 */
import express, { Request } from 'express'
import rateLimit from 'express-rate-limit'
import request from 'supertest'
import { ipDelCliente, llavePorCorreoOIp } from '@/utils/clientIp'

function pedir(headers: Record<string, string | string[]>, extra: Record<string, unknown> = {}): Request {
  return { headers, ...extra } as unknown as Request
}

describe('ipDelCliente', () => {
  it('🔴 prefiere CF-Connecting-IP sobre el borde que ve Express', () => {
    // 172.69.164.176 es el borde que más tráfico atendió en 24 h: 4 346 peticiones
    const req = pedir({ 'cf-connecting-ip': '189.203.10.55' }, { ip: '172.69.164.176' })
    expect(ipDelCliente(req)).toBe('189.203.10.55')
  })

  it('🔴 sin la cabecera de Cloudflare NO se fía de X-Forwarded-For: su primer eslabón lo escribe el visitante', () => {
    // Medido en producción el 21-oct: un X-Forwarded-For inventado llega intacto a la app, porque Cloudflare y el
    // proxy de Render AGREGAN su eslabón al final en vez de reemplazar la cadena. `req.ip` (trust proxy = 1) es el
    // eslabón que puso el proxy, y ése no lo escribe nadie de afuera.
    const req = pedir({ 'x-forwarded-for': '203.0.113.7, 189.203.10.55' }, { ip: '189.203.10.55' })
    expect(ipDelCliente(req)).toBe('189.203.10.55')
  })

  it('dos X-Forwarded-For inventados distintos desde la MISMA conexión son la MISMA llave', () => {
    const a = pedir({ 'x-forwarded-for': '203.0.113.7' }, { ip: '189.203.10.55' })
    const b = pedir({ 'x-forwarded-for': '203.0.113.8' }, { ip: '189.203.10.55' })
    expect(ipDelCliente(a)).toBe(ipDelCliente(b))
  })

  it('sin ninguna de las dos cae a req.ip, que es el comportamiento de antes', () => {
    expect(ipDelCliente(pedir({}, { ip: '172.69.164.176' }))).toBe('172.69.164.176')
  })

  it('una cabecera vacía o de puro espacio no se toma por buena', () => {
    const req = pedir({ 'cf-connecting-ip': '   ' }, { ip: '172.69.164.176' })
    expect(ipDelCliente(req)).toBe('172.69.164.176')
  })
})

describe('llavePorCorreoOIp', () => {
  it('🔴 EL CASO DE LA PUERTA: dos personas distintas detrás del MISMO borde son dos llaves', () => {
    const borde = '172.69.164.176'
    const ana = pedir({}, { ip: borde, body: { email: 'ana@negocio.mx' } })
    const beto = pedir({}, { ip: borde, body: { email: 'beto@otro.mx' } })
    expect(llavePorCorreoOIp(ana)).not.toBe(llavePorCorreoOIp(beto))
  })

  it('el mismo correo con distinta caja o espacios es la MISMA persona', () => {
    const a = pedir({}, { ip: '1.1.1.1', body: { email: '  Ana@Negocio.MX ' } })
    const b = pedir({}, { ip: '2.2.2.2', body: { email: 'ana@negocio.mx' } })
    expect(llavePorCorreoOIp(a)).toBe(llavePorCorreoOIp(b))
  })

  it('sin correo cae a la IP REAL, no al borde compartido', () => {
    const req = pedir({ 'cf-connecting-ip': '189.203.10.55' }, { ip: '172.69.164.176', body: {} })
    expect(llavePorCorreoOIp(req)).toBe('189.203.10.55')
  })

  it('un cuerpo ausente o un correo que no es texto no tumban la llave', () => {
    expect(llavePorCorreoOIp(pedir({}, { ip: '1.1.1.1' }))).toBe('1.1.1.1')
    expect(llavePorCorreoOIp(pedir({}, { ip: '1.1.1.1', body: { email: 42 } }))).toBe('1.1.1.1')
    expect(llavePorCorreoOIp(pedir({}, { body: {} }))).toBe('desconocida')
  })

  it('sin correo y sin Cloudflare, un X-Forwarded-For inventado no abre una llave nueva', () => {
    const req = pedir({ 'x-forwarded-for': '203.0.113.7' }, { ip: '189.203.10.55', body: {} })
    expect(llavePorCorreoOIp(req)).toBe('189.203.10.55')
  })
})

describe('el límite de verdad: Express con un salto de proxy, como en producción', () => {
  // Réplica del carril: `trust proxy = 1` (src/config/middleware.ts) y el keyGenerator de `public.routes.ts`. El
  // `X-Forwarded-For` de cada petición es el que el proxy de Render le entrega a la app: lo que mandó el visitante,
  // con la conexión real AGREGADA al final (por eso `req.ip` sale del último eslabón y nadie de afuera lo escribe).
  const BORDE = '172.69.164.176'

  function app() {
    const a = express()
    a.set('trust proxy', 1)
    const limite = rateLimit({
      windowMs: 60_000,
      max: 5,
      keyGenerator: req => ipDelCliente(req) || 'desconocida',
      standardHeaders: true,
      legacyHeaders: false,
    })
    a.get('/x', limite, (_req, res) => {
      res.sendStatus(200)
    })
    return a
  }

  async function estados(peticiones: Array<Record<string, string>>): Promise<number[]> {
    const a = app()
    const vistos: number[] = []
    for (const encabezados of peticiones) vistos.push((await request(a).get('/x').set(encabezados)).status)
    return vistos
  }

  it('🔴 inventar un X-Forwarded-For distinto en cada petición NO abre una cubeta nueva: la sexta es 429', async () => {
    const peticiones = [1, 2, 3, 4, 5, 6].map(i => ({ 'X-Forwarded-For': `203.0.113.${i}, 189.203.10.55` }))
    expect(await estados(peticiones)).toEqual([200, 200, 200, 200, 200, 429])
  })

  it('con la cabecera de Cloudflare, dos visitantes detrás del MISMO borde tienen cada uno su cubeta', async () => {
    const ana = { 'CF-Connecting-IP': '189.203.10.55', 'X-Forwarded-For': `189.203.10.55, ${BORDE}` }
    const beto = { 'CF-Connecting-IP': '189.203.10.56', 'X-Forwarded-For': `189.203.10.56, ${BORDE}` }
    const vistos = await estados([ana, ana, ana, ana, ana, beto, ana])
    expect(vistos).toEqual([200, 200, 200, 200, 200, 200, 429])
  })
})
