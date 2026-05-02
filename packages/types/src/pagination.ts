import { z } from 'zod'

/** Per Primitives §12 — cursor pagination. */
export const PaginationInputSchema = z.object({
  after: z.string().optional(),
  limit: z.number().int().min(1).max(1000).default(100),
})

export type PaginationInput = z.infer<typeof PaginationInputSchema>

export const paginatedResponse = <T extends z.ZodTypeAny>(itemSchema: T) =>
  z.object({
    items: z.array(itemSchema),
    next_cursor: z.string().nullable(),
    has_more: z.boolean(),
    total_estimate: z.number().int().optional(),
  })

export interface PaginatedResponse<T> {
  items: T[]
  next_cursor: string | null
  has_more: boolean
  total_estimate?: number
}
