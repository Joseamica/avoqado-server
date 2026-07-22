import { updateReservationSettingsBodySchema } from '@/schemas/dashboard/reservation.schema'

describe('reservation settings staff-aware schema', () => {
  it('round-trips both flat staff-aware fields', () => {
    expect(
      updateReservationSettingsBodySchema.parse({
        capacityMode: 'per_staff',
        showStaffPicker: false,
      }),
    ).toEqual({ capacityMode: 'per_staff', showStaffPicker: false })
  })

  it('round-trips both nested staff-aware fields', () => {
    expect(
      updateReservationSettingsBodySchema.parse({
        scheduling: { capacityMode: 'pacing' },
        publicBooking: { showStaffPicker: true },
      }),
    ).toEqual({
      scheduling: { capacityMode: 'pacing' },
      publicBooking: { showStaffPicker: true },
    })
  })

  it.each([
    { capacityMode: 'future_mode' },
    { showStaffPicker: 'true' },
    { scheduling: { capacityMode: 'staff' } },
    { publicBooking: { showStaffPicker: 1 } },
  ])('rejects invalid flat or nested staff-aware values: %#', input => {
    expect(updateReservationSettingsBodySchema.safeParse(input).success).toBe(false)
  })
})
