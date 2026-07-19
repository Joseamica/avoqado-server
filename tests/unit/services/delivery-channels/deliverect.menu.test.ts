import { mapSnapshotToDeliverectProducts } from '../../../../src/services/delivery-channels/providers/deliverect/deliverect.mapper'
import {
  MenuSnapshot,
  MenuSnapshotProduct,
  MenuSnapshotModifierGroup,
} from '../../../../src/services/delivery-channels/core/menuSnapshot.service'

describe('Deliverect Menu Mapper', () => {
  describe('mapSnapshotToDeliverectProducts', () => {
    // REGRESSION TESTS (existing functionality)
    // None yet for this new feature

    // NEW FEATURE TESTS
    it('should convert pesos to centavos correctly', () => {
      const snapshot: MenuSnapshot = {
        venueId: 'v1',
        generatedAt: '2026-07-18T00:00:00Z',
        categories: [
          {
            name: 'Main',
            products: [
              {
                plu: 'P-001',
                name: 'Tacos',
                description: null,
                price: 45.0,
                imageUrl: null,
                modifierGroups: [],
              },
            ],
          },
        ],
      }

      const result = mapSnapshotToDeliverectProducts(snapshot)

      expect(result.products).toHaveLength(1)
      expect(result.products[0].price).toBe(4500) // 45.00 * 100 = 4500
      expect(typeof result.products[0].price).toBe('number')
    })

    it('should handle prices with decimals and round correctly', () => {
      const snapshot: MenuSnapshot = {
        venueId: 'v1',
        generatedAt: '2026-07-18T00:00:00Z',
        categories: [
          {
            name: 'Main',
            products: [
              {
                plu: 'P-002',
                name: 'Quesadilla',
                description: null,
                price: 19.31,
                imageUrl: null,
                modifierGroups: [],
              },
            ],
          },
        ],
      }

      const result = mapSnapshotToDeliverectProducts(snapshot)

      expect(result.products[0].price).toBe(1931) // 19.31 * 100 = 1931
    })

    it('should map product fields correctly', () => {
      const snapshot: MenuSnapshot = {
        venueId: 'v1',
        generatedAt: '2026-07-18T00:00:00Z',
        categories: [
          {
            name: 'Main',
            products: [
              {
                plu: 'P-003',
                name: 'Enchiladas',
                description: 'Con mole rojo',
                price: 50.0,
                imageUrl: 'https://example.com/enchiladas.jpg',
                modifierGroups: [],
              },
            ],
          },
        ],
      }

      const result = mapSnapshotToDeliverectProducts(snapshot)

      expect(result.products[0]).toMatchObject({
        plu: 'P-003',
        name: 'Enchiladas',
        description: 'Con mole rojo',
        price: 5000,
        imageURL: 'https://example.com/enchiladas.jpg',
        productType: 1,
      })
    })

    it('should set description and imageURL to undefined when null', () => {
      const snapshot: MenuSnapshot = {
        venueId: 'v1',
        generatedAt: '2026-07-18T00:00:00Z',
        categories: [
          {
            name: 'Main',
            products: [
              {
                plu: 'P-004',
                name: 'Burrito',
                description: null,
                price: 35.0,
                imageUrl: null,
                modifierGroups: [],
              },
            ],
          },
        ],
      }

      const result = mapSnapshotToDeliverectProducts(snapshot)

      expect(result.products[0].description).toBeUndefined()
      expect(result.products[0].imageURL).toBeUndefined()
    })

    it('should map modifier groups as productType 3', () => {
      const snapshot: MenuSnapshot = {
        venueId: 'v1',
        generatedAt: '2026-07-18T00:00:00Z',
        categories: [
          {
            name: 'Main',
            products: [
              {
                plu: 'P-005',
                name: 'Pizza',
                description: null,
                price: 100.0,
                imageUrl: null,
                modifierGroups: [
                  {
                    id: 'grp-001',
                    name: 'Size',
                    required: true,
                    allowMultiple: false,
                    minSelections: 1,
                    maxSelections: 1,
                    modifiers: [
                      { plu: 'MOD-001', name: 'Small', price: 0 },
                      { plu: 'MOD-002', name: 'Large', price: 5.0 },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }

      const result = mapSnapshotToDeliverectProducts(snapshot)

      // Product should be there
      expect(result.products.some(p => p.plu === 'P-005')).toBe(true)

      // Modifier group should be there as productType 3
      const modGrp = result.products.find(p => p.plu === 'GRP-grp-001')
      expect(modGrp).toBeDefined()
      expect(modGrp?.productType).toBe(3)
      expect(modGrp?.name).toBe('Size')
      expect(modGrp?.price).toBe(0)
    })

    it('should map modifiers as productType 2', () => {
      const snapshot: MenuSnapshot = {
        venueId: 'v1',
        generatedAt: '2026-07-18T00:00:00Z',
        categories: [
          {
            name: 'Main',
            products: [
              {
                plu: 'P-006',
                name: 'Burger',
                description: null,
                price: 80.0,
                imageUrl: null,
                modifierGroups: [
                  {
                    id: 'GRP-002',
                    name: 'Toppings',
                    required: false,
                    allowMultiple: true,
                    minSelections: 0,
                    maxSelections: null,
                    modifiers: [
                      { plu: 'MOD-003', name: 'Cheese', price: 10.0 },
                      { plu: 'MOD-004', name: 'Bacon', price: 15.5 },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }

      const result = mapSnapshotToDeliverectProducts(snapshot)

      const cheese = result.products.find(p => p.plu === 'MOD-003')
      expect(cheese).toBeDefined()
      expect(cheese?.productType).toBe(2)
      expect(cheese?.name).toBe('Cheese')
      expect(cheese?.price).toBe(1000) // 10.00 * 100

      const bacon = result.products.find(p => p.plu === 'MOD-004')
      expect(bacon).toBeDefined()
      expect(bacon?.productType).toBe(2)
      expect(bacon?.price).toBe(1550) // 15.50 * 100
    })

    it('should reference modifier groups in product subProducts', () => {
      const snapshot: MenuSnapshot = {
        venueId: 'v1',
        generatedAt: '2026-07-18T00:00:00Z',
        categories: [
          {
            name: 'Main',
            products: [
              {
                plu: 'P-007',
                name: 'Sandwich',
                description: null,
                price: 60.0,
                imageUrl: null,
                modifierGroups: [
                  {
                    id: 'grp-003',
                    name: 'Bread',
                    required: true,
                    allowMultiple: false,
                    minSelections: 1,
                    maxSelections: 1,
                    modifiers: [{ plu: 'MOD-005', name: 'Wheat', price: 0 }],
                  },
                ],
              },
            ],
          },
        ],
      }

      const result = mapSnapshotToDeliverectProducts(snapshot)

      const product = result.products.find(p => p.plu === 'P-007')
      expect(product?.subProducts).toContain('GRP-grp-003')
    })

    it('should reference modifiers in modifier group subProducts', () => {
      const snapshot: MenuSnapshot = {
        venueId: 'v1',
        generatedAt: '2026-07-18T00:00:00Z',
        categories: [
          {
            name: 'Main',
            products: [
              {
                plu: 'P-008',
                name: 'Salad',
                description: null,
                price: 55.0,
                imageUrl: null,
                modifierGroups: [
                  {
                    id: 'grp-004',
                    name: 'Dressing',
                    required: false,
                    allowMultiple: false,
                    minSelections: 0,
                    maxSelections: 1,
                    modifiers: [
                      { plu: 'MOD-006', name: 'Ranch', price: 0 },
                      { plu: 'MOD-007', name: 'Caesar', price: 0 },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }

      const result = mapSnapshotToDeliverectProducts(snapshot)

      const modGrp = result.products.find(p => p.plu === 'GRP-grp-004')
      expect(modGrp?.subProducts).toContain('MOD-006')
      expect(modGrp?.subProducts).toContain('MOD-007')
      expect(modGrp?.subProducts).toHaveLength(2)
    })

    it('should not duplicate modifier groups when shared by multiple products', () => {
      const sharedGroup: MenuSnapshotModifierGroup = {
        id: 'grp-005',
        name: 'Size',
        required: true,
        allowMultiple: false,
        minSelections: 1,
        maxSelections: 1,
        modifiers: [
          { plu: 'MOD-008', name: 'Small', price: 0 },
          { plu: 'MOD-009', name: 'Large', price: 10.0 },
        ],
      }

      const snapshot: MenuSnapshot = {
        venueId: 'v1',
        generatedAt: '2026-07-18T00:00:00Z',
        categories: [
          {
            name: 'Main',
            products: [
              {
                plu: 'P-009',
                name: 'Coffee',
                description: null,
                price: 30.0,
                imageUrl: null,
                modifierGroups: [sharedGroup],
              },
              {
                plu: 'P-010',
                name: 'Tea',
                description: null,
                price: 25.0,
                imageUrl: null,
                modifierGroups: [sharedGroup],
              },
            ],
          },
        ],
      }

      const result = mapSnapshotToDeliverectProducts(snapshot)

      // Should have 2 products + 1 modifier group + 2 modifiers = 5
      expect(result.products).toHaveLength(5)

      // Modifier group should appear only once
      const modGrpCount = result.products.filter(p => p.plu === 'GRP-grp-005').length
      expect(modGrpCount).toBe(1)

      // Modifiers should appear only once each
      const mod008Count = result.products.filter(p => p.plu === 'MOD-008').length
      expect(mod008Count).toBe(1)

      const mod009Count = result.products.filter(p => p.plu === 'MOD-009').length
      expect(mod009Count).toBe(1)
    })

    it('should emit shared group and its modifiers exactly once across 3+ products (Set dedup sanity)', () => {
      const sharedGroup: MenuSnapshotModifierGroup = {
        id: 'grp-shared',
        name: 'Salsas',
        required: false,
        allowMultiple: true,
        minSelections: 0,
        maxSelections: null,
        modifiers: [
          { plu: 'MOD-020', name: 'Verde', price: 0 },
          { plu: 'MOD-021', name: 'Roja', price: 3.5 },
        ],
      }
      const mkProduct = (plu: string, name: string, price: number): MenuSnapshotProduct => ({
        plu,
        name,
        description: null,
        price,
        imageUrl: null,
        modifierGroups: [sharedGroup],
      })

      const snapshot: MenuSnapshot = {
        venueId: 'v1',
        generatedAt: '2026-07-18T00:00:00Z',
        categories: [
          {
            name: 'Main',
            products: [mkProduct('P-020', 'Taco', 20.0), mkProduct('P-021', 'Torta', 45.0), mkProduct('P-022', 'Sope', 25.0)],
          },
        ],
      }

      const result = mapSnapshotToDeliverectProducts(snapshot)

      // 3 products + 1 group + 2 modifiers = 6, no duplicates
      expect(result.products).toHaveLength(6)
      expect(result.products.filter(p => p.plu === 'GRP-grp-shared')).toHaveLength(1)
      expect(result.products.filter(p => p.plu === 'MOD-020')).toHaveLength(1)
      expect(result.products.filter(p => p.plu === 'MOD-021')).toHaveLength(1)

      // Every product still references the shared group
      for (const plu of ['P-020', 'P-021', 'P-022']) {
        expect(result.products.find(p => p.plu === plu)?.subProducts).toEqual(['GRP-grp-shared'])
      }
    })

    it('should not duplicate modifiers when shared by multiple modifier groups', () => {
      const sharedModifier = { plu: 'MOD-010', name: 'Extra', price: 5.0 }

      const snapshot: MenuSnapshot = {
        venueId: 'v1',
        generatedAt: '2026-07-18T00:00:00Z',
        categories: [
          {
            name: 'Main',
            products: [
              {
                plu: 'P-011',
                name: 'Nachos',
                description: null,
                price: 40.0,
                imageUrl: null,
                modifierGroups: [
                  {
                    id: 'grp-006',
                    name: 'Proteins',
                    required: false,
                    allowMultiple: true,
                    minSelections: 0,
                    maxSelections: null,
                    modifiers: [sharedModifier],
                  },
                  {
                    id: 'grp-007',
                    name: 'Toppings',
                    required: false,
                    allowMultiple: true,
                    minSelections: 0,
                    maxSelections: null,
                    modifiers: [sharedModifier],
                  },
                ],
              },
            ],
          },
        ],
      }

      const result = mapSnapshotToDeliverectProducts(snapshot)

      // Should have 1 product + 2 modifier groups + 1 modifier (shared) = 4
      expect(result.products).toHaveLength(4)

      // Modifier should appear only once
      const modCount = result.products.filter(p => p.plu === 'MOD-010').length
      expect(modCount).toBe(1)
    })

    it('should handle empty snapshot', () => {
      const snapshot: MenuSnapshot = {
        venueId: 'v1',
        generatedAt: '2026-07-18T00:00:00Z',
        categories: [],
      }

      const result = mapSnapshotToDeliverectProducts(snapshot)

      expect(result).toEqual({ products: [] })
    })

    it('should handle empty categories', () => {
      const snapshot: MenuSnapshot = {
        venueId: 'v1',
        generatedAt: '2026-07-18T00:00:00Z',
        categories: [
          {
            name: 'Empty',
            products: [],
          },
        ],
      }

      const result = mapSnapshotToDeliverectProducts(snapshot)

      expect(result).toEqual({ products: [] })
    })

    it('should handle product with empty modifier groups', () => {
      const snapshot: MenuSnapshot = {
        venueId: 'v1',
        generatedAt: '2026-07-18T00:00:00Z',
        categories: [
          {
            name: 'Main',
            products: [
              {
                plu: 'P-012',
                name: 'Water',
                description: null,
                price: 10.0,
                imageUrl: null,
                modifierGroups: [],
              },
            ],
          },
        ],
      }

      const result = mapSnapshotToDeliverectProducts(snapshot)

      expect(result.products).toHaveLength(1)
      expect(result.products[0].subProducts).toEqual([])
    })

    it('should return correct interface shape', () => {
      const snapshot: MenuSnapshot = {
        venueId: 'v1',
        generatedAt: '2026-07-18T00:00:00Z',
        categories: [
          {
            name: 'Main',
            products: [
              {
                plu: 'P-013',
                name: 'Test',
                description: 'Test product',
                price: 50.0,
                imageUrl: 'https://example.com/test.jpg',
                modifierGroups: [
                  {
                    id: 'grp-008',
                    name: 'Options',
                    required: false,
                    allowMultiple: false,
                    minSelections: 0,
                    maxSelections: 1,
                    modifiers: [{ plu: 'MOD-011', name: 'Option A', price: 5.0 }],
                  },
                ],
              },
            ],
          },
        ],
      }

      const result = mapSnapshotToDeliverectProducts(snapshot)

      // Verify top-level structure
      expect(result).toHaveProperty('products')
      expect(Array.isArray(result.products)).toBe(true)

      // Verify product structure
      const product = result.products.find(p => p.plu === 'P-013')
      expect(product).toHaveProperty('plu')
      expect(product).toHaveProperty('name')
      expect(product).toHaveProperty('price')
      expect(product).toHaveProperty('productType')
      expect(product).toHaveProperty('subProducts')
    })

    it('should handle multiple categories correctly', () => {
      const snapshot: MenuSnapshot = {
        venueId: 'v1',
        generatedAt: '2026-07-18T00:00:00Z',
        categories: [
          {
            name: 'Appetizers',
            products: [
              {
                plu: 'P-014',
                name: 'Wings',
                description: null,
                price: 30.0,
                imageUrl: null,
                modifierGroups: [],
              },
            ],
          },
          {
            name: 'Main',
            products: [
              {
                plu: 'P-015',
                name: 'Steak',
                description: null,
                price: 150.0,
                imageUrl: null,
                modifierGroups: [],
              },
            ],
          },
        ],
      }

      const result = mapSnapshotToDeliverectProducts(snapshot)

      expect(result.products).toHaveLength(2)
      expect(result.products.some(p => p.plu === 'P-014')).toBe(true)
      expect(result.products.some(p => p.plu === 'P-015')).toBe(true)
    })
  })
})
