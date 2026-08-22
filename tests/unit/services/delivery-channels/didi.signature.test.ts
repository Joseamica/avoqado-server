/**
 * `didi-header-sign` — MD5 del cuerpo CRUDO concatenado con el app_secret.
 *
 * Es lo único que separa un pedido real de cualquiera que descubra nuestra URL.
 */
import crypto from 'crypto'
import { verifyDidiSignature } from '../../../../src/services/delivery-channels/providers/didi-food/didi.signature'

const SECRETO = 'b0919c644bddc031c59288884954cf5c'
const CUERPO = Buffer.from('{"app_id":123,"type":"orderNew","data":{"order_id":5764607801871631353}}', 'utf8')
const FIRMA = crypto
  .createHash('md5')
  .update(Buffer.concat([CUERPO, Buffer.from(SECRETO, 'utf8')]))
  .digest('hex')

describe('verifyDidiSignature', () => {
  it('acepta la firma correcta', () => {
    expect(verifyDidiSignature(CUERPO, FIRMA, SECRETO)).toBe(true)
  })

  it('acepta en MAYÚSCULAS — el hex no distingue caja y rechazarlo tiraría pedidos buenos', () => {
    expect(verifyDidiSignature(CUERPO, FIRMA.toUpperCase(), SECRETO)).toBe(true)
  })

  it('rechaza otro secreto', () => {
    expect(verifyDidiSignature(CUERPO, FIRMA, 'otro-secreto')).toBe(false)
  })

  // ── Lo que de verdad protege ──────────────────────────────────────────────────────
  it('🔴 rechaza si el cuerpo cambió UN SOLO BYTE', () => {
    // El caso real: alguien intercepta y sube el total del pedido. La firma es sobre los
    // bytes, así que cualquier retoque la rompe.
    const alterado = Buffer.from(CUERPO.toString('utf8').replace('123', '124'), 'utf8')
    expect(verifyDidiSignature(alterado, FIRMA, SECRETO)).toBe(false)
  })

  it('🔴 la firma es sobre los BYTES CRUDOS, no sobre el JSON re-serializado', () => {
    // Si alguien parsea y vuelve a serializar antes de verificar, cambian espacios y orden
    // y la firma deja de cuadrar SIEMPRE — se caerían todos los pedidos. Este test fija
    // que el verificador recibe el Buffer tal cual llegó.
    const reserializado = Buffer.from(JSON.stringify(JSON.parse(CUERPO.toString('utf8'))), 'utf8')
    expect(reserializado.equals(CUERPO)).toBe(false) // efectivamente NO son iguales
    expect(verifyDidiSignature(reserializado, FIRMA, SECRETO)).toBe(false)
  })

  it('rechaza header ausente, vacío o que no sea hex de 32', () => {
    expect(verifyDidiSignature(CUERPO, undefined, SECRETO)).toBe(false)
    expect(verifyDidiSignature(CUERPO, '', SECRETO)).toBe(false)
    expect(verifyDidiSignature(CUERPO, 'no-soy-hex', SECRETO)).toBe(false)
    expect(verifyDidiSignature(CUERPO, FIRMA.slice(0, 31), SECRETO)).toBe(false)
    expect(verifyDidiSignature(CUERPO, FIRMA + 'ff', SECRETO)).toBe(false)
  })

  it('rechaza si falta el secreto — nunca "pasa" por no estar configurado', () => {
    expect(verifyDidiSignature(CUERPO, FIRMA, '')).toBe(false)
  })

  it('rechaza si el cuerpo no es Buffer', () => {
    expect(verifyDidiSignature('texto' as unknown as Buffer, FIRMA, SECRETO)).toBe(false)
  })
})
