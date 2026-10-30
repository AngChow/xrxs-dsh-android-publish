/**
 * Append-only JSON Lines audit trail under the plugin runtime directory.
 *
 * @module xrxs-dsh-android-publish/audit
 */

import { mkdir, appendFile } from 'node:fs/promises'
import path from 'node:path'

export type AuditEvent =
  | 'start'
  | 'preflight'
  | 'approval_denied'
  | 'complete'
  | 'failed'
  | 'cancelled'

export interface AuditRecord {
  event: AuditEvent
  sessionId?: string
  callId?: string
  profileId?: string
  projectRoot?: string
  mode?: string
  stores?: readonly string[]
  approval?: 'granted' | 'denied'
  jobId?: string
  exitCode?: number | null
  detail?: string
}

/** Append one audit record; never throws into tool execution. */
export async function appendAudit(
  runtimeDir: string,
  record: AuditRecord,
): Promise<void> {
  try {
    await mkdir(runtimeDir, { recursive: true, mode: 0o700 })
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...record }) + '\n'
    await appendFile(path.join(runtimeDir, 'audit.ndjson'), line, { mode: 0o600 })
  } catch {
    // Audit failures must not break or leak into tool results.
  }
}
