import { ToolError } from "../errors"
import { installLaunchdService, launchdServiceStatus, uninstallLaunchdService } from "./service-launchd"
import { installSystemdService, systemdServiceStatus, uninstallSystemdService } from "./service-systemd"
import {
  defaultServiceHost,
  type ServiceHost,
  type ServiceName,
  type ServiceSpec,
  type ServiceStatus,
} from "./service-types"

export type { ServiceHost, ServiceName, ServiceSpec, ServiceStatus }
export { defaultServiceHost }

const UNSUPPORTED_PLATFORM = "Running the sync service is supported on macOS and Linux only."
const WINDOWS_UNSUPPORTED =
  "Registering the sync service is not supported on Windows yet; run the sync command in a terminal instead."

function checkPlatform(platform: NodeJS.Platform): void {
  if (platform === "win32") {
    throw new ToolError("invalid_argument", WINDOWS_UNSUPPORTED)
  }
  if (platform !== "darwin" && platform !== "linux") {
    throw new ToolError("invalid_argument", UNSUPPORTED_PLATFORM)
  }
}

/**
 * Installs and enables the background sync service for one label.
 *
 * Supported on macOS (launchd agent) and Linux (systemd user unit).
 * Refuses on other platforms.
 */
export async function installService(
  spec: ServiceSpec,
  host: ServiceHost = defaultServiceHost(),
): Promise<{ file: string; log?: string }> {
  checkPlatform(host.platform)
  if (host.platform === "darwin") {
    return installLaunchdService(spec, host)
  }
  return installSystemdService(spec, host)
}

/**
 * Stops, disables, and deletes the sync service for one label. On macOS the
 * launcher script goes too, and its directory once empty.
 *
 * Missing or already-uninstalled services complete without error.
 */
export async function uninstallService(
  name: ServiceName,
  label: string,
  host: ServiceHost = defaultServiceHost(),
): Promise<void> {
  checkPlatform(host.platform)
  if (host.platform === "darwin") {
    return uninstallLaunchdService(name, label, host)
  }
  return uninstallSystemdService(name.id, label, host)
}

/**
 * Queries the current installation and execution status of the sync service.
 */
export async function serviceStatus(
  id: string,
  label: string,
  host: ServiceHost = defaultServiceHost(),
): Promise<ServiceStatus> {
  checkPlatform(host.platform)
  if (host.platform === "darwin") {
    return launchdServiceStatus(id, label, host)
  }
  return systemdServiceStatus(id, label, host)
}
