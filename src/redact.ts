/**
 * Exact-substring secret redaction applied at every output boundary.
 *
 * @module xrxs-dsh-android-publish/redact
 */

export const REDACTED = '[redacted]'

export interface Redactor {
  /** Replace every known secret occurrence in free text. */
  redact(text: string): string
  /** Walk a JSON value and redact secrets inside strings. */
  redactKnown<T>(value: T): T
}

/**
 * Build one redactor per run from the resolved secret values.
 * Replacement is exact substring matching, never regex built from secret content.
 */
export function createRedactor(secrets: Iterable<string>): Redactor {
  const values = [...secrets].filter(v => typeof v === 'string' && v.length >= 4)
  return {
    redact(text: string): string {
      let out = text
      for (const value of values) {
        if (out.includes(value)) out = out.split(value).join(REDACTED)
      }
      return out
    },
    redactKnown<T>(value: T): T {
      if (typeof value === 'string') return this.redact(value) as unknown as T
      if (Array.isArray(value)) return value.map(v => this.redactKnown(v)) as unknown as T
      if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          out[k] = this.redactKnown(v)
        }
        return out as unknown as T
      }
      return value
    },
  }
}

/** No-op redactor for secret-free paths (e.g. doctor probes). */
export const nullRedactor: Redactor = {
  redact: text => text,
  redactKnown: <T>(value: T): T => value,
}
