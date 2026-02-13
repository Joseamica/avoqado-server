import { readFileSync } from 'fs'
import os from 'os'
import logger from '../config/logger'

function detectMemoryLimitMb(): number {
  // cgroups v2
  try {
    const raw = readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim()
    logger.info(`[containerLimits] /sys/fs/cgroup/memory.max = "${raw}"`)
    if (raw !== 'max') {
      const mb = Math.round(parseInt(raw) / 1024 / 1024)
      logger.info(`[containerLimits] Memory limit (cgroups v2): ${mb} MB`)
      return mb
    }
  } catch (err: any) {
    logger.info(`[containerLimits] cgroups v2 memory: ${err.code || err.message}`)
  }

  // cgroups v1
  try {
    const raw = readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8').trim()
    logger.info(`[containerLimits] /sys/fs/cgroup/memory/memory.limit_in_bytes = "${raw}"`)
    const bytes = parseInt(raw)
    if (bytes < 1e15) {
      const mb = Math.round(bytes / 1024 / 1024)
      logger.info(`[containerLimits] Memory limit (cgroups v1): ${mb} MB`)
      return mb
    }
  } catch (err: any) {
    logger.info(`[containerLimits] cgroups v1 memory: ${err.code || err.message}`)
  }

  // os.totalmem() - on modern Linux (5.x+) with cgroup v2, /proc/meminfo reflects container limits
  const osMemMb = Math.round(os.totalmem() / 1024 / 1024)
  logger.info(`[containerLimits] Memory limit (os.totalmem fallback): ${osMemMb} MB`)
  return osMemMb
}

function detectCpuLimit(): number {
  // cgroups v2: "quota period" e.g. "100000 100000" = 1.0 CPU
  try {
    const raw = readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim()
    logger.info(`[containerLimits] /sys/fs/cgroup/cpu.max = "${raw}"`)
    if (!raw.startsWith('max')) {
      const [quota, period] = raw.split(' ').map(Number)
      if (quota > 0 && period > 0) {
        const cores = parseFloat((quota / period).toFixed(2))
        logger.info(`[containerLimits] CPU limit (cgroups v2): ${cores} cores`)
        return cores
      }
    }
  } catch (err: any) {
    logger.info(`[containerLimits] cgroups v2 cpu: ${err.code || err.message}`)
  }

  // cgroups v1
  try {
    const quotaRaw = readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_quota_us', 'utf8').trim()
    const periodRaw = readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_period_us', 'utf8').trim()
    logger.info(`[containerLimits] cgroups v1 cpu: quota=${quotaRaw}, period=${periodRaw}`)
    const quota = parseInt(quotaRaw)
    const period = parseInt(periodRaw)
    if (quota > 0 && period > 0) {
      const cores = parseFloat((quota / period).toFixed(2))
      logger.info(`[containerLimits] CPU limit (cgroups v1): ${cores} cores`)
      return cores
    }
  } catch (err: any) {
    logger.info(`[containerLimits] cgroups v1 cpu: ${err.code || err.message}`)
  }

  // os.cpus().length as last resort - may report host CPUs in containers
  // Use 1 as minimum to avoid misleadingly low CPU percentages
  const cpuCount = os.cpus().length
  logger.info(`[containerLimits] CPU (os.cpus fallback): ${cpuCount} host cores detected`)
  return cpuCount
}

// Resolve once at import time
export const CONTAINER_MEMORY_LIMIT_MB = detectMemoryLimitMb()
export const CONTAINER_CPU_LIMIT = detectCpuLimit()
logger.info(`[containerLimits] Final: memory=${CONTAINER_MEMORY_LIMIT_MB}MB, cpu=${CONTAINER_CPU_LIMIT} cores`)
