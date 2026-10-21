/**
 * 🔴 Auditoría de seguridad 2026-09-30: `POST /api/v1/pos-sync/test/pos-order` estaba montada SIN
 * autenticación en producción. Con un `venueId` creaba órdenes y cobros COMPLETED, personal con el PIN
 * que quisiera quien llamara, y cambiaba PINs existentes. SoftRestaurant entra por RabbitMQ y ningún
 * cliente la usaba. Esta guardia impide que vuelva a montarse.
 */
import fs from 'fs'
import path from 'path'

const ROUTES_DIR = path.join(__dirname, '../../../src/routes')

describe('la ruta de prueba de pos-sync no existe', () => {
  it('no hay archivo de rutas de pos-sync', () => {
    expect(fs.existsSync(path.join(ROUTES_DIR, 'pos-sync.routes.ts'))).toBe(false)
  })

  it('el índice de rutas no monta nada bajo /pos-sync', () => {
    const index = fs.readFileSync(path.join(ROUTES_DIR, 'index.ts'), 'utf8')
    expect(index).not.toMatch(/['"]\/pos-sync['"]/)
  })

  it('ningún archivo de rutas vuelve a declarar la ruta, ni en línea', () => {
    const files = (fs.readdirSync(ROUTES_DIR, { recursive: true }) as string[]).filter(f => f.endsWith('.ts'))
    const hits = files.filter(f => /pos-order/.test(fs.readFileSync(path.join(ROUTES_DIR, f), 'utf8')))
    expect(hits).toEqual([])
  })
})
