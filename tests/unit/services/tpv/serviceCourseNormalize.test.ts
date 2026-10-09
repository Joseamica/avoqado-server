import { normalizeAddItems } from '@/services/tpv/order.tpv.service'
import { DEFAULT_SERVICE_COURSES } from '@/services/service-courses/serviceCourseContract'

describe('ordinary order lines: preserve service identity and immediate semantics', () => {
  it('renamed immediate overrides legacy course to null', () => {
    const serviceCourse = { ...DEFAULT_SERVICE_COURSES[0], label: 'Al momento' }
    expect(normalizeAddItems([{ productId: 'coffee', quantity: 1, course: 'Postres', serviceCourse }])[0]).toMatchObject({
      course: null,
      serviceCourse,
    })
  })
  it('a standard snapshot supplies its historical label without a catalog lookup', () => {
    const serviceCourse = { id: 'removed', label: 'Segundo tiempo', kind: 'STANDARD' as const }
    expect(normalizeAddItems([{ productId: 'coffee', quantity: 1, serviceCourse }])[0]).toMatchObject({
      course: 'Segundo tiempo',
      serviceCourse,
    })
  })
  it('does not merge distinct identities with the same visible label', () => {
    const standard = { label: 'Segundo tiempo', kind: 'STANDARD' as const }
    expect(
      normalizeAddItems([
        { productId: 'coffee', quantity: 1, serviceCourse: { ...standard, id: 'a' } },
        { productId: 'coffee', quantity: 1, serviceCourse: { ...standard, id: 'b' } },
      ]),
    ).toHaveLength(2)
  })
  it('does not merge a legacy line into a new historical snapshot', () => {
    expect(
      normalizeAddItems([
        { productId: 'coffee', quantity: 1, course: 'Postres' },
        { productId: 'coffee', quantity: 1, serviceCourse: DEFAULT_SERVICE_COURSES[3] },
      ]),
    ).toHaveLength(2)
  })
  it('legacy merging and quantity remain unchanged', () => {
    const result = normalizeAddItems([
      { productId: 'coffee', quantity: 1, course: ' Postres ' },
      { productId: 'coffee', quantity: 2, course: 'Postres' },
    ])
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ course: 'Postres', quantity: 3 })
  })
  it('malformed metadata is rejected before normalization or money writes', () => {
    expect(() =>
      normalizeAddItems([{ productId: 'coffee', quantity: 1, serviceCourse: { id: 'desserts', label: ' ', kind: 'STANDARD' } }]),
    ).toThrow()
  })
})
