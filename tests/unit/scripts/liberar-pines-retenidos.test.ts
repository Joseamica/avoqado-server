import { WHERE_PINES_RETENIDOS, wherePinesRetenidos } from '../../../scripts/liberar-pines-retenidos'

jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: {} }))

/**
 * Fija la FORMA del filtro de la limpieza de PINs retenidos. Cambiarla en la dirección
 * equivocada tiene costo real:
 *  - sin `active: false` la limpieza le QUITARÍA el PIN a gente trabajando;
 *  - sin `deactivatedBySeatCap: false` borraría los PINs de personas suspendidas por
 *    tope de asientos, que se reactivan solas al re-upgradear y deben conservarlo;
 *  - sin `pin: { not: null }` tocaría filas que no tienen nada que liberar.
 */
describe('liberar-pines-retenidos: el filtro', () => {
  it('sólo apunta a bajas reales con PIN, nunca a activos ni a suspendidos por seat-cap', () => {
    expect(WHERE_PINES_RETENIDOS).toEqual({
      active: false,
      pin: { not: null },
      deactivatedBySeatCap: false,
    })
  })

  // --org-id acota a UNA organización SIN aflojar el resto del filtro: el caso real fue
  // limpiar sólo PlayTelecom dejando Mindform/Amaena/Sams intactos.
  it('con org-id agrega el filtro de organización y conserva los tres candados', () => {
    expect(wherePinesRetenidos('org-1')).toEqual({
      active: false,
      pin: { not: null },
      deactivatedBySeatCap: false,
      venue: { organizationId: 'org-1' },
    })
  })

  it('sin org-id es exactamente el filtro global', () => {
    expect(wherePinesRetenidos()).toEqual(WHERE_PINES_RETENIDOS)
  })
})
