import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { queryFeatures, LAYERS, getMaterials } from '../services/arcgisService'

// ─── LAYERS constant ─────────────────────────────────────────
describe('LAYERS constants', () => {
  it('has the correct index for each named layer', () => {
    expect(LAYERS.CENTROID).toBe(0)
    expect(LAYERS.PILLARS).toBe(1)
    expect(LAYERS.BUFFER).toBe(2)
    expect(LAYERS.CONCESSION).toBe(3)
    expect(LAYERS.CAMP_AND_MINE_OFFICE).toBe(14)
    expect(LAYERS.WORKERS_CAMP).toBe(15)
    expect(LAYERS.SENIOR_CAMP).toBe(16)
    expect(LAYERS.GARLAND_PATH).toBe(17)
  })
})

// ─── queryFeatures ───────────────────────────────────────────
describe('queryFeatures', () => {
  const FAKE_URL = 'https://example.com/FeatureServer/0'

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns mapped attributes on success', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        features: [
          { attributes: { objectid: 1, name: 'Pillar A' } },
          { attributes: { objectid: 2, name: 'Pillar B' } },
        ],
      }),
    })

    const result = await queryFeatures(FAKE_URL, { outFields: 'objectid,name' })
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ objectid: 1, name: 'Pillar A' })
  })

  it('returns an empty array when features is absent', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ features: [] }),
    })

    const result = await queryFeatures(FAKE_URL)
    expect(result).toEqual([])
  })

  it('throws when the ArcGIS response contains an error object', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ error: { code: 400, message: 'Invalid query' } }),
    })

    await expect(queryFeatures(FAKE_URL)).rejects.toThrow('Invalid query')
  })

  it('includes _geometry when returnGeometry is true', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        features: [
          { attributes: { objectid: 1 }, geometry: { x: 10, y: 20 } },
        ],
      }),
    })

    const result = await queryFeatures(FAKE_URL, { returnGeometry: true })
    expect(result[0]._geometry).toEqual({ x: 10, y: 20 })
  })

  it('retries on network failure and eventually throws', async () => {
    fetch.mockRejectedValue(new Error('Network failure'))

    await expect(queryFeatures(FAKE_URL)).rejects.toThrow('Network failure')
    // 1 initial attempt + 2 retries = 3 total calls
    expect(fetch).toHaveBeenCalledTimes(3)
  }, 10_000)

  it('retries on 5xx server error and eventually throws', async () => {
    fetch.mockResolvedValue({ ok: false, status: 503 })

    await expect(queryFeatures(FAKE_URL)).rejects.toThrow('Server error 503')
    expect(fetch).toHaveBeenCalledTimes(3)
  }, 10_000)

  it('does NOT retry on 4xx client error', async () => {
    // 404 is passed through (not retried); ArcGIS JSON is parsed normally.
    // Since the mock returns {} with no error key, queryFeatures returns [].
    fetch.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) })

    const result = await queryFeatures(FAKE_URL)
    expect(result).toEqual([])
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('appends orderByFields param when orderBy is provided', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ features: [] }),
    })

    await queryFeatures(FAKE_URL, { orderBy: 'CreationDate DESC' })
    const calledUrl = fetch.mock.calls[0][0]
    expect(calledUrl).toContain('orderByFields=CreationDate+DESC')
  })
})

// ─── getMaterials field normalisation ───────────────────────
describe('getMaterials', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()) })
  afterEach(() => { vi.restoreAllMocks() })

  function mockResponse(attributes) {
    fetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ features: [{ attributes }] }),
    })
  }

  it('maps coded-value fields to canonical names when text fields are null', async () => {
    mockResponse({
      objectid: 1, material_name: null, field_19: 'Cement',
      category: null, field_15: 'Construction',
      unit: null, field_16: 'Bags',
      quantity_received: 200, supplier: 'Acme',
    })
    const [row] = await getMaterials()
    expect(row.material_name).toBe('Cement')
    expect(row.category).toBe('Construction')
    expect(row.unit).toBe('Bags')
  })

  it('prefers free-text fields over coded-value fields when both are present', async () => {
    mockResponse({
      objectid: 2, material_name: 'Custom Material', field_19: 'Cement',
      category: 'Custom Cat', field_15: 'Construction',
      unit: 'kg', field_16: 'Bags',
      quantity_received: 10, supplier: 'Supplier X',
    })
    const [row] = await getMaterials()
    expect(row.material_name).toBe('Custom Material')
    expect(row.category).toBe('Custom Cat')
    expect(row.unit).toBe('kg')
  })

  it('returns null for canonical fields when both text and coded values are absent', async () => {
    mockResponse({
      objectid: 3, material_name: null, field_19: null,
      category: null, field_15: null,
      unit: null, field_16: null,
      quantity_received: 5, supplier: null,
    })
    const [row] = await getMaterials()
    expect(row.material_name).toBeNull()
    expect(row.category).toBeNull()
    expect(row.unit).toBeNull()
  })
})
