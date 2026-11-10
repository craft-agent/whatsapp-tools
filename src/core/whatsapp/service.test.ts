import { describe, expect, test } from "bun:test"
import { ToolError } from "../errors"
import {
  defaultServiceHost,
  installService,
  serviceStatus,
  serviceWorkingDirectory,
  uninstallService,
  type ServiceHost,
  type ServiceSpec,
} from "./service"
import { mapProgramError } from "./service-types"

describe("service dispatcher", () => {
  const spec: ServiceSpec = {
    id: "io.github.craft-agent.whatsapp-tools",
    label: "default",
    program: "/bin/node",
    args: [],
    path: "/bin",
    launcher: "example-sync",
  }

  test("refuses Windows platform with invalid_argument and terminal run advice", async () => {
    const host: ServiceHost = {
      platform: "win32",
      home: "C:\\Users\\test",
      uid: 0,
      env: {},
      run: async () => ({ code: 0, stdout: "", stderr: "" }),
    }

    const expectedMessage =
      "Registering the sync service is not supported on Windows yet; run the sync command in a terminal instead."

    const installError = await installService(spec, host).catch((e: unknown) => e)
    expect(installError).toBeInstanceOf(ToolError)
    expect((installError as ToolError).code).toBe("invalid_argument")
    expect((installError as ToolError).message).toBe(expectedMessage)

    const uninstallError = await uninstallService(spec, spec.label, host).catch((e: unknown) => e)
    expect(uninstallError).toBeInstanceOf(ToolError)
    expect((uninstallError as ToolError).code).toBe("invalid_argument")
    expect((uninstallError as ToolError).message).toBe(expectedMessage)

    const statusError = await serviceStatus(spec.id, spec.label, host).catch((e: unknown) => e)
    expect(statusError).toBeInstanceOf(ToolError)
    expect((statusError as ToolError).code).toBe("invalid_argument")
    expect((statusError as ToolError).message).toBe(expectedMessage)
  })

  test("refuses other unsupported platforms with invalid_argument and platform support list", async () => {
    const host: ServiceHost = {
      platform: "freebsd",
      home: "/home/test",
      uid: 1000,
      env: {},
      run: async () => ({ code: 0, stdout: "", stderr: "" }),
    }

    const expectedMessage = "Running the sync service is supported on macOS and Linux only."

    const installError = await installService(spec, host).catch((e: unknown) => e)
    expect(installError).toBeInstanceOf(ToolError)
    expect((installError as ToolError).code).toBe("invalid_argument")
    expect((installError as ToolError).message).toBe(expectedMessage)

    const uninstallError = await uninstallService(spec, spec.label, host).catch((e: unknown) => e)
    expect(uninstallError).toBeInstanceOf(ToolError)
    expect((uninstallError as ToolError).code).toBe("invalid_argument")
    expect((uninstallError as ToolError).message).toBe(expectedMessage)

    const statusError = await serviceStatus(spec.id, spec.label, host).catch((e: unknown) => e)
    expect(statusError).toBeInstanceOf(ToolError)
    expect((statusError as ToolError).code).toBe("invalid_argument")
    expect((statusError as ToolError).message).toBe(expectedMessage)
  })

  test("mapProgramError masks phone numbers and truncates to 300 characters", () => {
    const error1 = mapProgramError("systemctl", {
      code: 1,
      stdout: "",
      stderr: "Error connecting to +15551234567 daemon",
    })
    expect(error1.code).toBe("upstream_error")
    expect(error1.message).toBe("systemctl failed: Error connecting to <number> daemon")

    const longStderr = "x".repeat(350)
    const error2 = mapProgramError("launchctl", {
      code: 1,
      stdout: "",
      stderr: longStderr,
    })
    expect(error2.message).toBe(`launchctl failed: ${"x".repeat(300)}`)

    const emptyError = mapProgramError("launchctl", {
      code: 1,
      stdout: "",
      stderr: "",
    })
    expect(emptyError.message).toBe("launchctl failed.")
  })

  test("serviceWorkingDirectory is the directory the service manager starts the service in", () => {
    const host = (platform: NodeJS.Platform): ServiceHost => ({
      platform,
      home: "/home/test",
      uid: 1000,
      env: {},
      run: async () => ({ code: 0, stdout: "", stderr: "" }),
    })

    expect(serviceWorkingDirectory(host("darwin"))).toBe("/")
    expect(serviceWorkingDirectory(host("linux"))).toBe("/home/test")
    expect(() => serviceWorkingDirectory(host("win32"))).toThrow(
      "Registering the sync service is not supported on Windows yet; run the sync command in a terminal instead.",
    )
    expect(() => serviceWorkingDirectory(host("freebsd"))).toThrow(
      "Running the sync service is supported on macOS and Linux only.",
    )
  })

  test("defaultServiceHost provides required host properties", () => {
    const host = defaultServiceHost()
    expect(host.platform).toBe(process.platform)
    expect(typeof host.home).toBe("string")
    expect(typeof host.uid).toBe("number")
    expect(typeof host.run).toBe("function")
  })
})
