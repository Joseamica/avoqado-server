import {
  assertSafePreflightEnvironment,
  reservationStaffPreflightQueries,
  runReservationStaffPreflight,
} from '../../../scripts/preflight-reservation-staff-rollout'

describe('reservation staff rollout preflight', () => {
  const violation = {
    reservationId: 'reservation-1',
    confirmationCode: 'RES-ONE',
    venueId: 'venue-1',
    staffId: 'staff-1',
  }

  it('defines exactly the six SELECT-only operational categories from the rollout contract', () => {
    expect(reservationStaffPreflightQueries.map(query => query.key)).toEqual([
      'reservation_missing_staff_venue',
      'class_session_missing_staff_venue',
      'reservation_reservation_overlap',
      'reservation_class_session_overlap',
      'class_session_class_session_overlap',
      'reservation_lead_product_mismatch',
    ])

    for (const definition of reservationStaffPreflightQueries) {
      const sql = definition.query.sql.replace(/\s+/g, ' ').trim()
      expect(sql).toMatch(/^SELECT\b/i)
      expect(sql).toMatch(/clock_timestamp\(\) AT TIME ZONE 'UTC'/i)
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE|CREATE)\b/i)
    }

    expect(reservationStaffPreflightQueries[2].query.sql).toMatch(/a\.id\s*<\s*b\.id/i)
    expect(reservationStaffPreflightQueries[4].query.sql).toMatch(/a\.id\s*<\s*b\.id/i)
    expect(reservationStaffPreflightQueries[5].query.sql).toMatch(/cardinality\(r\."productIds"\)\s*>\s*0/i)
    expect(reservationStaffPreflightQueries[5].query.sql).toMatch(/IS DISTINCT FROM\s*\(r\."productIds"\)\[1\]/i)
  })

  it('counts one actionable violation in every category and returns exit code 1', async () => {
    const queryRaw = jest.fn()
    for (let index = 0; index < reservationStaffPreflightQueries.length; index += 1) {
      queryRaw.mockResolvedValueOnce([{ ...violation, reservationId: `reservation-${index + 1}` }])
    }
    const lines: string[] = []

    const result = await runReservationStaffPreflight({ $queryRaw: queryRaw }, line => lines.push(line))

    expect(result.exitCode).toBe(1)
    expect(result.counts).toEqual({
      reservation_missing_staff_venue: 1,
      class_session_missing_staff_venue: 1,
      reservation_reservation_overlap: 1,
      reservation_class_session_overlap: 1,
      class_session_class_session_overlap: 1,
      reservation_lead_product_mismatch: 1,
    })
    expect(queryRaw).toHaveBeenCalledTimes(6)
    expect(lines).toHaveLength(6)
    expect(lines.every(line => line.includes('count=1'))).toBe(true)
    expect(lines.join('\n')).toContain('RES-ONE')
    expect(lines.join('\n')).not.toContain('postgresql://')
  })

  it('returns exit code 0 only when every category is empty', async () => {
    const queryRaw = jest.fn().mockResolvedValue([])

    const result = await runReservationStaffPreflight({ $queryRaw: queryRaw }, jest.fn())

    expect(result.exitCode).toBe(0)
    expect(Object.values(result.counts)).toEqual([0, 0, 0, 0, 0, 0])
  })

  it('rejects NODE_ENV=test unless DATABASE_URL exactly matches TEST_DATABASE_URL', () => {
    expect(() =>
      assertSafePreflightEnvironment({
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://localhost/production',
        TEST_DATABASE_URL: 'postgresql://localhost/avoqado_test',
      }),
    ).toThrow(/TEST_DATABASE_URL/)

    expect(() =>
      assertSafePreflightEnvironment({
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://localhost/avoqado_test',
        TEST_DATABASE_URL: 'postgresql://localhost/avoqado_test',
      }),
    ).not.toThrow()
  })

  it('requires DATABASE_URL without including its value in the error', () => {
    expect(() => assertSafePreflightEnvironment({ NODE_ENV: 'production' })).toThrow('DATABASE_URL es obligatoria')
  })
})
