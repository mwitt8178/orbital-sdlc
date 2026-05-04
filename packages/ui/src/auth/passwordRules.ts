/**
 * Password policy schema mirroring the Cognito pool policy:
 *   - Minimum length: 12
 *   - Requires uppercase, lowercase, number, symbol
 *
 * If the pool policy ever changes, update both at the same time. The Cognito
 * server is still the source of truth — this schema only saves a roundtrip.
 */

import { z } from 'zod'

export const passwordSchema = z
  .string()
  .min(12, 'Must be at least 12 characters')
  .regex(/[A-Z]/, 'Must contain an uppercase letter')
  .regex(/[a-z]/, 'Must contain a lowercase letter')
  .regex(/[0-9]/, 'Must contain a number')
  .regex(/[^A-Za-z0-9]/, 'Must contain a symbol')

export const emailSchema = z.string().email('Enter a valid email address')

export const PASSWORD_RULES_HUMAN: string[] = [
  '12+ characters',
  'Uppercase + lowercase letters',
  'At least one number',
  'At least one symbol',
]
