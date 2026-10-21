import {
  DEFAULT_SERVICE_COURSES,
  MAX_SERVICE_COURSES,
  resolveServiceCourses,
  serviceCourseCatalogSchema,
  serviceCourseSnapshotSchema,
  legacyCourseForSnapshot,
} from '@/services/service-courses/serviceCourseContract'

const custom = [
  { id: 'immediate', label: 'Al momento', kind: 'IMMEDIATE' },
  { id: 'drinks', label: 'Bebidas', kind: 'STANDARD' },
]

describe('service courses: bounded, additive catalog contract', () => {
  it('freezes preparation capability and course order in a historical line snapshot', () => {
    expect(serviceCourseSnapshotSchema.parse({ ...custom[1], preparationVersion: 1, sortOrder: 7 })).toMatchObject({
      preparationVersion: 1,
      sortOrder: 7,
    })
  })
  it('keeps workflow metadata out of organization and venue catalogs', () => {
    expect(serviceCourseCatalogSchema.safeParse([{ ...custom[0], preparationVersion: 1 }, custom[1]]).success).toBe(false)
  })
  it('preserves the four existing defaults and null for immediate', () => {
    expect(DEFAULT_SERVICE_COURSES.map(c => legacyCourseForSnapshot(c))).toEqual([null, 'Aperitivos', 'Principales', 'Postres'])
  })
  it('normalizes Unicode and whitespace without changing stable identifiers', () => {
    const result = serviceCourseCatalogSchema.parse([custom[0], { ...custom[1], label: '  Cafe\u0301   y pan  ' }])
    expect(result[1]).toEqual({ id: 'drinks', label: 'Café y pan', kind: 'STANDARD' })
  })
  it.each(['', '   ', 'a'.repeat(61), 'Café\nPan', 'Café\u0000'])('rejects invalid labels %j', label => {
    expect(serviceCourseCatalogSchema.safeParse([custom[0], { ...custom[1], label }]).success).toBe(false)
  })
  it('rejects every C0 control and DEL while preserving adjacent Unicode characters', () => {
    for (const code of [...Array.from({ length: 32 }, (_, index) => index), 127]) {
      expect(serviceCourseSnapshotSchema.safeParse({ ...custom[1], label: `Café${String.fromCharCode(code)}Pan` }).success).toBe(false)
    }
    expect(serviceCourseSnapshotSchema.parse({ ...custom[1], label: 'Café ! ~ 😀' }).label).toBe('Café ! ~ 😀')
    expect(serviceCourseSnapshotSchema.parse({ ...custom[1], label: `Café${String.fromCharCode(128)}Pan` }).label).toContain(
      String.fromCharCode(128),
    )
  })
  it('rejects duplicate labels after normalization and case folding', () => {
    expect(
      serviceCourseCatalogSchema.safeParse([custom[0], custom[1], { id: 'other', label: ' BEBIDAS ', kind: 'STANDARD' }]).success,
    ).toBe(false)
  })
  it('rejects duplicate IDs even with distinct labels', () => {
    expect(serviceCourseCatalogSchema.safeParse([custom[0], custom[1], { ...custom[1], label: 'Postres' }]).success).toBe(false)
  })
  it.each(
    [
      [],
      [custom[1]],
      [{ ...custom[0], kind: 'STANDARD' }],
      [custom[1], custom[0]],
      [custom[0], { ...custom[1], kind: 'IMMEDIATE' }],
      [{ ...custom[0], id: 'another-immediate' }],
    ].map(courses => [courses]),
  )('keeps exactly one immediate entry first, with its stable identity: %j', courses => {
    expect(serviceCourseCatalogSchema.safeParse(courses).success).toBe(false)
  })
  it('enforces the maximum without silently truncating the list', () => {
    const entries = [
      custom[0],
      ...Array.from({ length: MAX_SERVICE_COURSES }, (_, i) => ({ id: `c${i}`, label: `Tiempo ${i}`, kind: 'STANDARD' })),
    ]
    expect(serviceCourseCatalogSchema.safeParse(entries).success).toBe(false)
    expect(serviceCourseCatalogSchema.parse(entries.slice(0, MAX_SERVICE_COURSES))).toHaveLength(MAX_SERVICE_COURSES)
  })
  it('accepts a historical snapshot after its catalog entry was renamed or removed', () => {
    const snapshot = serviceCourseSnapshotSchema.parse({ id: 'old-stage', label: 'Segundo tiempo', kind: 'STANDARD' })
    expect(legacyCourseForSnapshot(snapshot)).toBe('Segundo tiempo')
  })
  it('a renamed immediate still maps to null', () => {
    expect(legacyCourseForSnapshot(serviceCourseSnapshotSchema.parse(custom[0]))).toBeNull()
  })
  it('resolves defaults, organization inheritance and the complete venue override', () => {
    const org = { serviceCourses: custom, serviceCoursesRevision: 3 }
    expect(resolveServiceCourses(null, null)).toMatchObject({ source: 'DEFAULT', revision: 'o:0:v:0', courses: DEFAULT_SERVICE_COURSES })
    expect(resolveServiceCourses(org, null)).toMatchObject({ source: 'ORGANIZATION', revision: 'o:3:v:0', courses: custom })
    expect(resolveServiceCourses(org, { serviceCourses: DEFAULT_SERVICE_COURSES, serviceCoursesRevision: 2 })).toMatchObject({
      source: 'VENUE',
      revision: 'v:2',
      courses: DEFAULT_SERVICE_COURSES,
    })
  })
  it('restoring inheritance retains the local revision and adopts the current organization list', () => {
    expect(
      resolveServiceCourses({ serviceCourses: custom, serviceCoursesRevision: 4 }, { serviceCourses: null, serviceCoursesRevision: 7 }),
    ).toMatchObject({ source: 'ORGANIZATION', revision: 'o:4:v:7', courses: custom })
  })
  it('does not disguise corrupt saved settings as an empty/default catalog', () => {
    expect(() => resolveServiceCourses({ serviceCourses: [], serviceCoursesRevision: 1 }, null)).toThrow()
  })
})
