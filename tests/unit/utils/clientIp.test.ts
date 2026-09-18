/**
 * La puerta S14 del lanzamiento: que el límite de altas cuente PERSONAS y no bordes de Cloudflare.
 * Los valores de IP de aquí son los REALES que se midieron en producción el 17-sep.
 */
import { Request } from 'express'
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

  it('sin la cabecera de Cloudflare toma el PRIMER eslabón de X-Forwarded-For, que es el cliente', () => {
    const req = pedir({ 'x-forwarded-for': '189.203.10.55, 172.69.164.176' }, { ip: '172.69.164.176' })
    expect(ipDelCliente(req)).toBe('189.203.10.55')
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
})
