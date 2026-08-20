/**
 * En modo white-label los permisos se filtran por acceso a la función, para que el frontend
 * pueda preguntar `can('permiso')` sin saber nada de features. Un permiso que NO está en
 * `PERMISSION_TO_FEATURE_MAP` se conserva tal cual — pensado para permisos de sistema.
 *
 * 🔴 Ese "se conserva tal cual" es justamente la trampa: un permiso de una función DE PAGA
 * que se olvide en el mapa pasa el filtro aunque el venue no la haya pagado. Es el mismo
 * hueco que el comentario de `upsells:*` documenta en el propio archivo.
 */
import fs from 'fs'
import path from 'path'

const ARCHIVO = path.join(__dirname, '../../../../src/services/access/access.service.ts')

describe('white-label: los permisos de delivery se filtran por la función PREMIUM', () => {
  const fuente = fs.readFileSync(ARCHIVO, 'utf8')

  it.each(['delivery-channels:read', 'delivery-channels:manage', 'delivery-channels:request', 'delivery-channels:connect'])(
    '🔴 %s está mapeado a DELIVERY_CHANNELS',
    permiso => {
      expect(fuente).toMatch(new RegExp(`'${permiso}':\\s*'DELIVERY_CHANNELS'`))
    },
  )
})
