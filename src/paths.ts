/**
 * Path canonicalization and profile-scoped path safety.
 *
 * @module xrxs-dsh-android-publish/paths
 */

import { realpath } from 'node:fs/promises'
import path from 'node:path'

/**
 * Canonicalize an existing path with realpath. Throws when the path does not
 * exist or is not readable.
 */
export async function canonicalize(existingPath: string): Promise<string> {
  return realpath(existingPath)
}

/** Reject relative or non-canonical model-supplied paths. */
export function requireAbsolute(candidate: string, label: string): string {
  if (!candidate || !path.isAbsolute(candidate)) {
    throw new Error(`${label} must be an absolute path; got "${candidate}"`)
  }
  return candidate
}

/** True when `child` equals or lives under canonical `parent`. */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}
