import { readFileSync } from 'fs'
import logger from '../config/logger'

function detectMemoryLimitMb(): number {
  // cgroups v2
  try {
    const v2 = readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim()
    if (v2 !== 'max') {
      const mb = Math.round(parseInt(v2) / 1024 / 1024)
      logger.info(`Container memory limit detected (cgroups v2): ${mb} MB`)
      return mb
    }
  } catch {
    // cgroup file not available (non-container environment)
  }

  // cgroups v1
  try {
    const v1 = readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8').trim()
    const bytes = parseInt(v1)
    // Values near or above 1e15 mean "no limit" in cgroups v1
    if (bytes < 1e15) {
      const mb = Math.round(bytes / 1024 / 1024)
      logger.info(`Container memory limit detected (cgroups v1): ${mb} MB`)
      return mb
    }
  } catch {
    // cgroup file not available
  }

  // Fallback to env var
  const fallback = parseInt(process.env.MEMORY_LIMIT_MB || '512', 10)
  logger.info(`Container memory limit: ${fallback} MB (env fallback)`)
  return fallback
}

function detectCpuLimit(): number {
  // cgroups v2: "quota period" e.g. "50000 100000" = 0.5 CPU
  try {
    const v2 = readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim()
    if (!v2.startsWith('max')) {
      const [quota, period] = v2.split(' ').map(Number)
      if (quota > 0 && period > 0) {
        const cores = parseFloat((quota / period).toFixed(2))
        logger.info(`Container CPU limit detected (cgroups v2): ${cores} cores`)
        return cores
      }
    }
  } catch {
    // cgroup file not available (non-container environment)
  }

  // cgroups v1
  try {
    const quota = parseInt(readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_quota_us', 'utf8').trim())
    const period = parseInt(readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_period_us', 'utf8').trim())
    if (quota > 0 && period > 0) {
      const cores = parseFloat((quota / period).toFixed(2))
      logger.info(`Container CPU limit detected (cgroups v1): ${cores} cores`)
      return cores
    }
  } catch {
    // cgroup file not available
  }

  // Fallback to env var
  const fallback = parseFloat(process.env.CPU_LIMIT || '0.5')
  logger.info(`Container CPU limit: ${fallback} cores (env fallback)`)
  return fallback
}

// Resolve once at import time
export const CONTAINER_MEMORY_LIMIT_MB = detectMemoryLimitMb()
export const CONTAINER_CPU_LIMIT = detectCpuLimit()
