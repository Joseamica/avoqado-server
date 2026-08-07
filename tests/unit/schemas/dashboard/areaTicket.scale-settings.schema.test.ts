import { updateScaleSettingsSchema } from '../../../../src/schemas/dashboard/areaTicket.schema'

const parse = (body: unknown) =>
  updateScaleSettingsSchema.safeParse({
    params: { venueId: 'venue-creamery' },
    body,
  })

describe('updateScaleSettingsSchema — etiqueta de peso variable', () => {
  it('accepts enabling a standard EAN-13 label with a venue prefix', () => {
    const result = parse({
      variableBarcodeEnabled: true,
      variableBarcodePrefix: '20',
    })

    expect(result.success).toBe(true)
  })

  it.each(['2', '200', 'AB', '2*'])('rejects an unsafe prefix: %s', prefix => {
    expect(parse({ variableBarcodePrefix: prefix }).success).toBe(false)
  })

  it('keeps physical serial integration independently configurable', () => {
    expect(parse({ enabled: false, variableBarcodeEnabled: true, variableBarcodePrefix: '21' }).success).toBe(true)
  })
})
