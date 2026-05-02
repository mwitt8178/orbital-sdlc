/**
 * Unit tests for projects/active-project-context.ts.
 */

import { describe, it, expect } from 'vitest'
import { OrbitalError } from '@orbital/types'
import {
  ACTIVE_PROJECT_HEADER,
  optionalActiveProject,
  readActiveProjectIdFromHeaders,
  requireActiveProject,
} from '../../../src/projects/active-project-context.js'
import { PROJECTS_ERROR_CODES } from '../../../src/projects/types.js'

describe('readActiveProjectIdFromHeaders', () => {
  it('returns null when headers missing', () => {
    expect(readActiveProjectIdFromHeaders(undefined)).toBeNull()
  })

  it('returns null when header absent', () => {
    expect(readActiveProjectIdFromHeaders({})).toBeNull()
  })

  it('returns the string value when header is a string', () => {
    expect(
      readActiveProjectIdFromHeaders({ [ACTIVE_PROJECT_HEADER]: 'proj-1' }),
    ).toBe('proj-1')
  })

  it('returns null for empty string', () => {
    expect(readActiveProjectIdFromHeaders({ [ACTIVE_PROJECT_HEADER]: '' })).toBeNull()
  })

  it('returns the first valid string when header is an array', () => {
    expect(
      readActiveProjectIdFromHeaders({ [ACTIVE_PROJECT_HEADER]: ['', 'proj-2'] }),
    ).toBe('proj-2')
  })

  it('returns null for unrecognized types', () => {
    expect(
      readActiveProjectIdFromHeaders({
        [ACTIVE_PROJECT_HEADER]: 1234 as unknown as string,
      }),
    ).toBeNull()
  })
})

describe('optionalActiveProject / requireActiveProject', () => {
  it('optionalActiveProject returns null when ctx has no req', () => {
    expect(optionalActiveProject({})).toBeNull()
  })

  it('optionalActiveProject returns the header value', () => {
    expect(
      optionalActiveProject({ req: { headers: { [ACTIVE_PROJECT_HEADER]: 'p' } } }),
    ).toBe('p')
  })

  it('requireActiveProject throws ACTIVE_PROJECT_REQUIRED when missing', () => {
    try {
      requireActiveProject({})
      expect.fail('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(OrbitalError)
      expect((err as OrbitalError).code).toBe(
        PROJECTS_ERROR_CODES.ACTIVE_PROJECT_REQUIRED,
      )
    }
  })

  it('requireActiveProject returns the header value when set', () => {
    expect(
      requireActiveProject({ req: { headers: { [ACTIVE_PROJECT_HEADER]: 'p' } } }),
    ).toBe('p')
  })
})
