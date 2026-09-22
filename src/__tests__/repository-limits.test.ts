import { describe, expect, it } from 'vitest'
import { assertD1ParameterLimit, getBulkDeleteBatchSize } from '../server/Repository'

describe('Repository D1 parameter limits', () => {
  it('reserves parameters for syncId, scope, and a soft-delete value', () => {
    expect(getBulkDeleteBatchSize({ singleTenant: false, scoped: true, softDelete: true })).toBe(97)
    expect(getBulkDeleteBatchSize({ singleTenant: false, scoped: false, softDelete: false })).toBe(99)
    expect(getBulkDeleteBatchSize({ singleTenant: true, scoped: false, softDelete: false })).toBe(100)
  })

  it('accepts exactly 100 parameters and rejects wider individual statements', () => {
    expect(() => assertD1ParameterLimit('bulkUpdate', 100)).not.toThrow()
    expect(() => assertD1ParameterLimit('bulkUpdate', 101)).toThrow(
      'A single query requires 101 bound parameters; D1 allows at most 100'
    )
  })
})
