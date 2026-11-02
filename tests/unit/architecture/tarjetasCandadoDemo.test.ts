/**
 * Negocios demo en tarjetas de regalo (auditoría final 1b, Codex #2, 30-oct): todo mensaje de una tarjeta sale con el negocio de
 * ESA tarjeta en el contexto. El candado no toma el negocio del token de un SUPERADMIN (es el que está mirando, no el del
 * mensaje), así que sin `conNegocio` un SUPERADMIN parado en otro negocio dejaba salir el código por WhatsApp de una tarjeta
 * vendida en un demo a un teléfono real. La entrega (`entregarTarjetas`) ya lo exige en candadoDemoJobsGuard.test.ts.
 */
import fs from 'fs'
import path from 'path'

const sinComentarios = (codigo: string) => codigo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
const leer = (ruta: string) => sinComentarios(fs.readFileSync(path.join(__dirname, '../../../src', ruta), 'utf8'))

it('el código por WhatsApp del teléfono sale con el negocio de la tarjeta en el contexto', () => {
  const servicio = leer('services/giftCards/giftCardPhone.service.ts')
  expect(servicio).toMatch(/conNegocio\(venueId, \(\) => sendOtpWhatsApp\(/)
  expect(servicio.match(/sendOtpWhatsApp\(/g)).toHaveLength(1)
})
