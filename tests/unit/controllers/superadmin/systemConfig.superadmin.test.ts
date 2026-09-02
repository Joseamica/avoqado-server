/**
 * El endpoint que contesta «¿este servidor tiene bien su configuración crítica?».
 *
 * Dos cosas que esta prueba GUARDA, y las dos importan más que el endpoint en sí:
 *
 * 1. 🔴 Que viva bajo `/superadmin`, no en el health público. Un endpoint sin autenticación que
 *    enumera qué defensas están apagadas es un mapa para quien busca por dónde entrar. Si alguien
 *    lo "simplifica" moviéndolo a `/health` porque es más cómodo de consultar, esta prueba falla.
 * 2. 🔴 Que la respuesta NUNCA lleve el valor de una variable.
 */
import fs from 'fs'
import path from 'path'

import { getConfigCheck } from '@/controllers/superadmin/systemConfig.superadmin.controller'

const RAIZ = path.join(__dirname, '../../../..')
const leer = (p: string) => fs.readFileSync(path.join(RAIZ, p), 'utf8')

describe('GET /superadmin/system/config-check', () => {
  it('🔴 está montado BAJO el router de superadmin, después de validar autoridad activa en DB', () => {
    const rutas = leer('src/routes/superadmin.routes.ts')

    const candado = rutas.indexOf('router.use(requireActiveSuperadmin)')
    const montaje = rutas.indexOf("router.use('/system', systemConfigRoutes)")

    expect(candado).toBeGreaterThan(-1)
    expect(montaje).toBeGreaterThan(-1)
    // El orden es lo que hace que herede el candado: montarlo ANTES lo dejaría abierto.
    expect(montaje).toBeGreaterThan(candado)
  })

  it('🔴 su propio archivo de rutas NO afloja la autenticación por su cuenta', () => {
    // Un `authenticateTokenMiddleware` o un guard de superadmin propio aquí sería la señal de que
    // alguien lo desacopló del padre — y desacoplarlo es como se afloja sin querer.
    const propio = leer('src/routes/superadmin/systemConfig.routes.ts')

    expect(propio).not.toContain('authorizeRole')
    expect(propio).not.toContain('requireActiveSuperadmin')
    expect(propio).not.toContain('optionalAuth')
  })

  it('🔴 NO vive en el health público', () => {
    const app = leer('src/app.ts')

    expect(app).not.toContain('config-check')
    expect(app).not.toContain('revisarConfiguracionCritica')
  })

  it('responde con la forma de la casa (`{ data: ... }`) y con el veredicto', () => {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() }

    getConfigCheck({} as never, res as never)

    expect(res.status).toHaveBeenCalledWith(200)
    const cuerpo = res.json.mock.calls[0][0]
    expect(cuerpo).toHaveProperty('data')
    expect(cuerpo.data).toHaveProperty('todoBien')
    expect(Array.isArray(cuerpo.data.revisiones)).toBe(true)
  })

  it('🔴 la respuesta no trae el valor de ninguna variable', () => {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() }

    getConfigCheck({} as never, res as never)

    const texto = JSON.stringify(res.json.mock.calls[0][0])
    // Si la llave está puesta en el entorno de pruebas, su valor NO puede aparecer.
    const llave = process.env.SESSION_SUCCESSOR_ENC_KEY
    if (llave) expect(texto).not.toContain(llave)
    // Y ninguna cadena que parezca un secreto en hex largo.
    expect(texto).not.toMatch(/[0-9a-f]{32,}/i)
  })
})
