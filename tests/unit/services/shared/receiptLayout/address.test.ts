import { addressLine } from '@/services/shared/receiptLayout/address'

describe('addressLine — no repite lo que la dirección ya dice (medido en papel, Android 1-sep)', () => {
  it('compone dirección, ciudad, estado y CP con comas', () => {
    expect(addressLine({ address: 'Nápoles 47', city: 'Cuauhtémoc', state: 'Ciudad de México', zipCode: '06600' })).toBe(
      'Nápoles 47, Cuauhtémoc, Ciudad de México, CP 06600',
    )
  })
  it('P1 una dirección que ya trae ciudad, estado y CP no los repite (sin acentos ni mayúsculas)', () => {
    expect(
      addressLine({
        address: 'Monte Himalaya 408, Lomas de Chapultepec, Miguel Hidalgo, 11000 Ciudad de México, CDMX, México',
        city: 'Ciudad de Mexico',
        state: 'cdmx',
        zipCode: '11000',
      }),
    ).toBe('Monte Himalaya 408, Lomas de Chapultepec, Miguel Hidalgo, 11000 Ciudad de México, CDMX, México')
  })
  it('sin nada, null', () => {
    expect(addressLine({ address: null, city: '  ', state: null, zipCode: null })).toBeNull()
  })
})
