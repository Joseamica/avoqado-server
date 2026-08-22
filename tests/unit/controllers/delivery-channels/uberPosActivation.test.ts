/**
 * El interruptor que decide si una tienda de Uber puede ACEPTAR pedidos.
 *
 * 🔴 Este test existe por un bug real, encontrado el 2026-08-20 con un pedido de verdad
 * (`00012fba-…`, tienda "Avoqado Sandbox 1") y NO por ningún test: el flujo de activación
 * mandaba `integrator_store_id` + `integrator_brand_id` a `pos_data`, pero nunca
 * `pos_integration_enabled`. Con ese flag apagado, Uber deja LEER el pedido —se ingería
 * perfecto, con su comanda de cocina y todo— pero `accept_pos_order` responde
 * `403 user_not_allowed`, y a los ~11.5 minutos Uber lo cancela. Todo se veía bien hasta
 * que el cliente se quedaba sin comida.
 *
 * Es un escaneo del FUENTE, no una llamada mockeada, y es deliberado: montar el callback
 * entero (firma del state, canje del token, listado de tiendas) para una sola aserción es
 * mucho andamio, y el modo de falla que importa es exactamente "alguien edita ese cuerpo y
 * suelta el flag". Un mock no lo habría atrapado la primera vez — de hecho, no lo atrapó.
 */
import fs from 'fs'
import path from 'path'

const ARCHIVO = path.join(__dirname, '../../../../src/controllers/delivery-channels/uber.oauth.controller.ts')

describe('activación de tienda Uber: pos_data', () => {
  const fuente = fs.readFileSync(ARCHIVO, 'utf8')

  it('🔴 manda is_order_manager: true — sin esto la tienda NUNCA acepta un pedido', () => {
    expect(fuente).toMatch(/is_order_manager:\s*true/)
  })

  it('🔴 NO manda pos_integration_enabled: está deprecado y Uber lo ignora en silencio', () => {
    // Primer intento de fix, y era el campo equivocado: el POST devolvió 200 y el flag
    // siguió en false. Un 200 que no cambia nada es peor que un error, porque parece éxito.
    expect(fuente).not.toMatch(/pos_integration_enabled:/)
  })

  it('manda require_manual_acceptance: false — quien decide aceptar es nuestro canal', () => {
    expect(fuente).toMatch(/require_manual_acceptance:\s*false/)
  })

  it('sigue mandando la identidad de la tienda (no se perdió al agregar el flag)', () => {
    expect(fuente).toMatch(/integrator_store_id:/)
    expect(fuente).toMatch(/integrator_brand_id:\s*'avoqado'/)
  })
})
