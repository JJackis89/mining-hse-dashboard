import { describe, it, expect } from 'vitest'

// Pure filter logic extracted from Inventory.jsx for isolated testing
function filterRecords(records, { search = '', filterCat = 'All' } = {}) {
  const q = search.toLowerCase()
  return records.filter((r) => {
    const matchCat    = filterCat === 'All' || r.category === filterCat
    const matchSearch = !q ||
      (r.material_name || '').toLowerCase().includes(q) ||
      (r.received_by   || '').toLowerCase().includes(q) ||
      (r.remarks       || '').toLowerCase().includes(q)
    return matchCat && matchSearch
  })
}

const RECORDS = [
  { objectid: 1, material_name: 'Cement Bags',   category: 'Civil',      received_by: 'Alice',  remarks: 'Urgent' },
  { objectid: 2, material_name: 'Steel Rods',    category: 'Structural', received_by: 'Bob',    remarks: '' },
  { objectid: 3, material_name: 'Paint Primer',  category: 'Civil',      received_by: 'Charlie', remarks: 'Check quality' },
  { objectid: 4, material_name: 'Diesel Fuel',   category: 'Fuel',       received_by: 'Alice',  remarks: '' },
]

describe('Inventory filter — category', () => {
  it('returns all records when category is "All"', () => {
    expect(filterRecords(RECORDS, { filterCat: 'All' })).toHaveLength(4)
  })

  it('filters to matching category only', () => {
    const result = filterRecords(RECORDS, { filterCat: 'Civil' })
    expect(result).toHaveLength(2)
    expect(result.every((r) => r.category === 'Civil')).toBe(true)
  })

  it('returns empty array when no records match category', () => {
    expect(filterRecords(RECORDS, { filterCat: 'Electrical' })).toHaveLength(0)
  })
})

describe('Inventory filter — search', () => {
  it('matches on material_name (case-insensitive)', () => {
    const result = filterRecords(RECORDS, { search: 'cement' })
    expect(result).toHaveLength(1)
    expect(result[0].objectid).toBe(1)
  })

  it('matches on received_by', () => {
    const result = filterRecords(RECORDS, { search: 'alice' })
    expect(result).toHaveLength(2)
  })

  it('matches on remarks', () => {
    const result = filterRecords(RECORDS, { search: 'quality' })
    expect(result).toHaveLength(1)
    expect(result[0].objectid).toBe(3)
  })

  it('returns all records when search is empty', () => {
    expect(filterRecords(RECORDS, { search: '' })).toHaveLength(4)
  })

  it('returns empty array when search matches nothing', () => {
    expect(filterRecords(RECORDS, { search: 'zzz' })).toHaveLength(0)
  })
})

describe('Inventory filter — combined search + category', () => {
  it('applies both filters simultaneously', () => {
    const result = filterRecords(RECORDS, { search: 'alice', filterCat: 'Civil' })
    expect(result).toHaveLength(1)
    expect(result[0].objectid).toBe(1)
  })

  it('returns empty when category matches but search does not', () => {
    const result = filterRecords(RECORDS, { search: 'zzz', filterCat: 'Civil' })
    expect(result).toHaveLength(0)
  })
})

// ─── pagination helper ────────────────────────────────────────
function paginate(items, page, pageSize) {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize))
  const safePage   = Math.min(Math.max(1, page), totalPages)
  return {
    items: items.slice((safePage - 1) * pageSize, safePage * pageSize),
    totalPages,
    safePage,
  }
}

describe('paginate helper', () => {
  const items = Array.from({ length: 55 }, (_, i) => i + 1)

  it('returns correct slice for page 1', () => {
    const { items: slice } = paginate(items, 1, 20)
    expect(slice).toHaveLength(20)
    expect(slice[0]).toBe(1)
  })

  it('returns correct slice for last page', () => {
    const { items: slice, totalPages } = paginate(items, 3, 20)
    expect(totalPages).toBe(3)
    expect(slice).toHaveLength(15)
  })

  it('clamps page to totalPages when page exceeds total', () => {
    const { safePage, totalPages } = paginate(items, 99, 20)
    expect(safePage).toBe(totalPages)
  })

  it('returns totalPages of 1 for empty array', () => {
    const { totalPages, items: slice } = paginate([], 1, 20)
    expect(totalPages).toBe(1)
    expect(slice).toHaveLength(0)
  })
})
