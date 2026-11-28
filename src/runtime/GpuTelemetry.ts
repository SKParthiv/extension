import { execFile } from "node:child_process"
import { promisify } from "node:util"
import * as vscode from "vscode"

const execFileAsync = promisify(execFile)

export interface GpuInfo {
  name?: string
  utilization?: number
  memoryUsed?: number
  memoryTotal?: number
  temperature?: number
  powerDraw?: number
  available: boolean
}

/**
 * Read NVIDIA GPU metrics without adding dependencies.
 * Returns available: false gracefully when nvidia-smi is not found or fails.
 */
export async function readGpuTelemetry(): Promise<GpuInfo> {
  const enabled = vscode.workspace.getConfiguration("nottheleast").get<boolean>("enableGpuTelemetry", true)
  if (!enabled) {
    return { available: false }
  }

  try {
    const { stdout } = await execFileAsync("nvidia-smi", [
      "--query-gpu=name,utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu,power.draw",
      "--format=csv,noheader,nounits",
    ], { timeout: 5000 })

    const line = stdout.trim().split("\n")[0]
    if (!line) return { available: false }

    const parts = line.split(",").map((s) => s.trim())
    return {
      name: parts[0] || undefined,
      utilization: parts[1] ? Number(parts[1]) : undefined,
      memoryUsed: parts[3] ? Number(parts[3]) : undefined,
      memoryTotal: parts[4] ? Number(parts[4]) : undefined,
      temperature: parts[5] ? Number(parts[5]) : undefined,
      powerDraw: parts[6] ? Number(parts[6]) : undefined,
      available: true,
    }
  } catch {
    return { available: false }
  }
}