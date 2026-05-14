import { Decimal } from '@prisma/client/runtime/library'
import { prismaMock } from '../../../__helpers__/setup'

// Mock OpenAI before importing the service
const mockChatCompletionsCreate = jest.fn()
jest.mock('openai', () =>
  jest.fn().mockImplementation(() => ({
    chat: { completions: { create: mockChatCompletionsCreate } },
  })),
)

// Mock token budget service — soft limit, just records usage
const mockCheckTokensAvailable = jest.fn().mockResolvedValue({ allowed: true })
const mockRecordTokenUsage = jest.fn().mockResolvedValue({})
const mockGetBudgetStatus = jest.fn().mockResolvedValue({ totalAvailable: 100000, warning: undefined })
jest.mock('../../../../src/services/dashboard/token-budget.service', () => ({
  __esModule: true,
  default: {
    checkTokensAvailable: (...args: any[]) => mockCheckTokensAvailable(...args),
    recordTokenUsage: (...args: any[]) => mockRecordTokenUsage(...args),
    getBudgetStatus: (...args: any[]) => mockGetBudgetStatus(...args),
  },
}))

// Mock global fetch (used for Google Places)
const fetchMock = jest.fn()
;(global as any).fetch = fetchMock

import { getMarketBenchmark, __resetBenchmarkCacheForTests } from '../../../../src/services/dashboard/inventory/market-benchmark.service'

const baseProduct = (overrides: Record<string, any> = {}) => ({
  id: 'prod-001',
  name: 'Cappuccino chico',
  price: new Decimal(55),
  cost: null,
  category: { name: 'Shake bar' },
  recipe: { totalCost: new Decimal(8.02) },
  venue: {
    currency: 'MXN',
    city: 'Ciudad de México',
    address: 'Av. Test 100',
    latitude: new Decimal('19.42708740'),
    longitude: new Decimal('-99.21183690'),
  },
  ...overrides,
})

const placesOk = {
  ok: true,
  json: async () => ({
    status: 'OK',
    results: [
      { name: 'Starbucks Polanco', business_status: 'OPERATIONAL', rating: 4.3, user_ratings_total: 250, types: ['cafe'] },
      { name: 'Café Cardinal', business_status: 'OPERATIONAL', rating: 4.6, user_ratings_total: 80, types: ['cafe'] },
      { name: 'Cerrado Bistro', business_status: 'CLOSED_PERMANENTLY', rating: 4.0, user_ratings_total: 10, types: ['restaurant'] },
    ],
  }),
}

const openAiOk = (overrides: Partial<{ medianEstimate: number; rangeLow: number; rangeHigh: number; confidence: string; reasoning: string }> = {}) => ({
  choices: [
    {
      message: {
        content: JSON.stringify({
          medianEstimate: 65,
          rangeLow: 55,
          rangeHigh: 80,
          confidence: 'high',
          reasoning: 'Producto estándar con múltiples comparables en zona premium.',
          ...overrides,
        }),
      },
    },
  ],
  usage: { prompt_tokens: 1200, completion_tokens: 200 },
})

describe('getMarketBenchmark', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    __resetBenchmarkCacheForTests()
    process.env.GOOGLE_GEOLOCATION_API_KEY = 'fake-google-key'
    process.env.OPENAI_API_KEY = 'fake-openai-key'
  })

  it('returns benchmark for a recipe product using venue coordinates', async () => {
    prismaMock.product.findFirst.mockResolvedValue(baseProduct() as any)
    fetchMock.mockResolvedValueOnce(placesOk)
    mockChatCompletionsCreate.mockResolvedValueOnce(openAiOk())

    const result = await getMarketBenchmark('venue-1', 'prod-001')

    expect(result.productId).toBe('prod-001')
    expect(result.currency).toBe('MXN')
    expect(result.medianEstimate).toBe(65)
    expect(result.confidence).toBe('high')
    expect(result.comparablesFound).toBe(2) // CLOSED_PERMANENTLY filtered out
    expect(result.comparableVenues).toContain('Starbucks Polanco')
    expect(result.cached).toBe(false)
  })

  it('uses Product.cost for quantity products (no recipe)', async () => {
    prismaMock.product.findFirst.mockResolvedValue(
      baseProduct({ recipe: null, cost: new Decimal(68) }) as any,
    )
    fetchMock.mockResolvedValueOnce(placesOk)
    mockChatCompletionsCreate.mockResolvedValueOnce(openAiOk({ medianEstimate: 90 }))

    const result = await getMarketBenchmark('venue-1', 'prod-001')
    expect(result.medianEstimate).toBe(90)
    // Prompt should mention the wholesale cost — verify the prompt content
    const prompt = mockChatCompletionsCreate.mock.calls[0][0].messages[1].content
    expect(prompt).toContain('Costo unitario: 68')
  })

  it('returns cached result on second call within TTL', async () => {
    prismaMock.product.findFirst.mockResolvedValue(baseProduct() as any)
    fetchMock.mockResolvedValueOnce(placesOk)
    mockChatCompletionsCreate.mockResolvedValueOnce(openAiOk())

    const first = await getMarketBenchmark('venue-1', 'prod-001')
    expect(first.cached).toBe(false)

    const second = await getMarketBenchmark('venue-1', 'prod-001')
    expect(second.cached).toBe(true)
    // Only one upstream call to each external service
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(mockChatCompletionsCreate).toHaveBeenCalledTimes(1)
  })

  it('throws NotFoundError when product belongs to a different venue', async () => {
    prismaMock.product.findFirst.mockResolvedValue(null)
    await expect(getMarketBenchmark('venue-1', 'missing')).rejects.toThrow(/no encontrado/i)
  })

  it('falls back to geocoding when venue has no lat/lng', async () => {
    prismaMock.product.findFirst.mockResolvedValue(
      baseProduct({ venue: { ...baseProduct().venue, latitude: null, longitude: null } }) as any,
    )
    // Geocode response
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: [{ geometry: { location: { lat: 19.43, lng: -99.21 } } }] }),
    })
    // Then Places response
    fetchMock.mockResolvedValueOnce(placesOk)
    mockChatCompletionsCreate.mockResolvedValueOnce(openAiOk())

    const result = await getMarketBenchmark('venue-1', 'prod-001')
    expect(result.medianEstimate).toBe(65)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('throws clear error when venue has neither coordinates nor address', async () => {
    prismaMock.product.findFirst.mockResolvedValue(
      baseProduct({
        venue: { ...baseProduct().venue, latitude: null, longitude: null, address: null },
      }) as any,
    )
    await expect(getMarketBenchmark('venue-1', 'prod-001')).rejects.toThrow(/coordenadas ni dirección/)
  })

  it('handles OpenAI returning low confidence + null median for unique products', async () => {
    prismaMock.product.findFirst.mockResolvedValue(
      baseProduct({ name: 'Doradita Keto Cacao' }) as any,
    )
    fetchMock.mockResolvedValueOnce(placesOk)
    mockChatCompletionsCreate.mockResolvedValueOnce(
      openAiOk({ medianEstimate: null as any, confidence: 'low', reasoning: 'Producto único, sin comparables' }),
    )

    const result = await getMarketBenchmark('venue-1', 'prod-001')
    expect(result.medianEstimate).toBeNull()
    expect(result.confidence).toBe('low')
  })

  it('rejects when GOOGLE_GEOLOCATION_API_KEY is not configured', async () => {
    delete process.env.GOOGLE_GEOLOCATION_API_KEY
    prismaMock.product.findFirst.mockResolvedValue(baseProduct() as any)
    await expect(getMarketBenchmark('venue-1', 'prod-001')).rejects.toThrow(/GOOGLE_GEOLOCATION_API_KEY/)
  })

  // Regression: ensure tenant isolation in the prisma query
  it('regression: scopes product query by venueId (tenant isolation)', async () => {
    prismaMock.product.findFirst.mockResolvedValue(baseProduct() as any)
    fetchMock.mockResolvedValueOnce(placesOk)
    mockChatCompletionsCreate.mockResolvedValueOnce(openAiOk())

    await getMarketBenchmark('venue-1', 'prod-001')
    expect(prismaMock.product.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'prod-001', venueId: 'venue-1' }),
      }),
    )
  })

  it('checks token budget before calling OpenAI and records actual usage after', async () => {
    prismaMock.product.findFirst.mockResolvedValue(baseProduct() as any)
    fetchMock.mockResolvedValueOnce(placesOk)
    mockChatCompletionsCreate.mockResolvedValueOnce(openAiOk())

    await getMarketBenchmark('venue-1', 'prod-001', { userId: 'staff-99' })

    expect(mockCheckTokensAvailable).toHaveBeenCalledWith('venue-1', expect.any(Number))
    expect(mockRecordTokenUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        venueId: 'venue-1',
        userId: 'staff-99',
        promptTokens: 1200,
        completionTokens: 200,
      }),
    )
  })

  it('does NOT consume tokens on cached hits', async () => {
    prismaMock.product.findFirst.mockResolvedValue(baseProduct() as any)
    fetchMock.mockResolvedValueOnce(placesOk)
    mockChatCompletionsCreate.mockResolvedValueOnce(openAiOk())

    // First call: consumes tokens
    await getMarketBenchmark('venue-1', 'prod-001')
    expect(mockRecordTokenUsage).toHaveBeenCalledTimes(1)

    // Second call: served from cache, no token usage
    mockRecordTokenUsage.mockClear()
    mockCheckTokensAvailable.mockClear()
    const cached = await getMarketBenchmark('venue-1', 'prod-001')
    expect(cached.cached).toBe(true)
    expect(mockCheckTokensAvailable).not.toHaveBeenCalled()
    expect(mockRecordTokenUsage).not.toHaveBeenCalled()
  })

  it('skipBudget option bypasses both check and record (system / cron use)', async () => {
    prismaMock.product.findFirst.mockResolvedValue(baseProduct() as any)
    fetchMock.mockResolvedValueOnce(placesOk)
    mockChatCompletionsCreate.mockResolvedValueOnce(openAiOk())

    mockCheckTokensAvailable.mockClear()
    mockRecordTokenUsage.mockClear()
    await getMarketBenchmark('venue-1', 'prod-001', { skipBudget: true })

    expect(mockCheckTokensAvailable).not.toHaveBeenCalled()
    expect(mockRecordTokenUsage).not.toHaveBeenCalled()
  })
})
