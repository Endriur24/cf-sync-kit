import { describe, it, expect } from 'vitest'
import { SyncError, isSyncError } from '../shared/types'

describe('SyncError', () => {
  it('should create error with message and code', () => {
    const error = new SyncError('Test error', 'TEST_CODE')

    expect(error.message).toBe('Test error')
    expect(error.code).toBe('TEST_CODE')
    expect(error.name).toBe('SyncError')
    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(SyncError)
  })

  it('should support optional status and details', () => {
    const error = new SyncError('Not found', 'NOT_FOUND', 404, { id: '123' })

    expect(error.status).toBe(404)
    expect(error.details).toEqual({ id: '123' })
  })

  it('should work with isSyncError type guard', () => {
    const syncError = new SyncError('Test', 'CODE')
    const plainError = new Error('Plain')
    const object = { name: 'ParseError', message: 'Test', code: 'CODE' }

    expect(isSyncError(syncError)).toBe(true)
    expect(isSyncError(plainError)).toBe(false)
    expect(isSyncError(object)).toBe(false)
    expect(isSyncError(null)).toBe(false)
    expect(isSyncError(undefined)).toBe(false)
  })

  it('should preserve stack trace', () => {
    const error = new SyncError('Stack test', 'STACK')
    expect(error.stack).toBeDefined()
    expect(error.stack).toContain('SyncError')
  })

  it('should be throwable and catchable', () => {
    function throwSyncError() {
      throw new SyncError('Thrown', 'THROWN', 500)
    }

    expect(throwSyncError).toThrow()
    try {
      throwSyncError()
    } catch (e) {
      expect(isSyncError(e)).toBe(true)
      if (isSyncError(e)) {
        expect(e.code).toBe('THROWN')
        expect(e.status).toBe(500)
      }
    }
  })
})
