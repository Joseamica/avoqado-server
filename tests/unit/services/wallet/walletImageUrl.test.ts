/**
 * 🔴 Bug reportado por el founder usando la pantalla (2026-08-27):
 * "Me equivoqué al subir esta foto y ya no la puedo cambiar".
 *
 * La causa era una decisión mía. El archivo se guarda con un nombre ESTABLE
 * (`venues/<slug>/wallet/icon.png`) para no acumular basura con cada intento de
 * diseño — hasta ahí bien. Pero la URL pública que se guardaba era exactamente la
 * misma para siempre, así que al subir otra imagen el navegador seguía sirviendo la
 * anterior de su caché. El archivo SÍ cambiaba; lo que no cambiaba era la dirección.
 *
 * El síntoma es el peor posible: el negocio sube la imagen correcta, ve la equivocada,
 * y concluye que la pantalla está rota.
 */
import { versionedStorageUrl } from '../../../../src/services/wallet/cardDesign.service'

describe('la dirección de una imagen de la tarjeta', () => {
  const base = 'https://storage.googleapis.com/bucket/dev/venues/mi-cafe/wallet/icon.png'

  it('🔴 cambia entre una subida y otra', () => {
    const primera = versionedStorageUrl(base, 1000)
    const segunda = versionedStorageUrl(base, 2000)

    expect(primera).not.toBe(segunda)
  })

  it('apunta al MISMO archivo: sólo se le agrega la versión', () => {
    // Se conserva el nombre estable para no acumular basura — que era el motivo
    // original y sigue siendo correcto.
    expect(versionedStorageUrl(base, 1000)).toContain('/wallet/icon.png')
    expect(versionedStorageUrl(base, 1000)).toMatch(/\?v=1000$/)
  })

  it('🔴 no acumula versiones al volver a subir', () => {
    // La segunda subida parte de la URL que devuelve el almacenamiento, pero si
    // alguna vez llegara una que ya trae `?v=`, no puede quedar `?v=1&v=2`.
    const yaVersionada = `${base}?v=1000`

    expect(versionedStorageUrl(yaVersionada, 2000)).toBe(`${base}?v=2000`)
  })

  it('respeta una URL que ya trae otros parámetros', () => {
    // Firebase puede devolver `?alt=media&token=…`. Esos no se pueden perder.
    const conToken = 'https://firebasestorage.googleapis.com/v0/b/x/o/y.png?alt=media&token=abc'

    const r = versionedStorageUrl(conToken, 5000)

    expect(r).toContain('alt=media')
    expect(r).toContain('token=abc')
    expect(r).toContain('v=5000')
  })
})
