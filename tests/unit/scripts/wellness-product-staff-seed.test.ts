import fs from 'fs'
import path from 'path'

describe('wellness ProductStaff seed identity', () => {
  it('resolves StaffVenue by staffId_venueId and persists that row id for every explicit mapping', () => {
    const seed = fs.readFileSync(path.join(process.cwd(), 'prisma/seed.ts'), 'utf8')
    const wellnessStart = seed.indexOf('// ----- B. Avoqado Wellness: full bespoke setup -----')
    const wellnessSource = seed.slice(wellnessStart)

    expect(wellnessStart).toBeGreaterThan(-1)
    expect(wellnessSource).toMatch(
      /staffVenue\.findUnique\([\s\S]*staffId_venueId:\s*\{\s*staffId:\s*member\.staffId,\s*venueId:\s*venue\.id/,
    )
    expect(wellnessSource).toMatch(/productStaff\.upsert\([\s\S]*productId_staffVenueId/)
    expect(wellnessSource).toMatch(/staffVenueId:\s*staffVenue\.id/)
    expect(wellnessSource).not.toMatch(/staffVenueId:\s*(?:member|staff)\.staffId/)
  })
})
