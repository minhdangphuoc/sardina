/**
 * FR-7.4: integer/string encodings for devices.xml, confirmed by reading the real
 * sailfish-qtcreator source (2026-09-28) rather than guessed. Citations point at
 * the exact file/lines read on `master`.
 */

/** src/libs/sfdk/sfdkconstants.h — devices.xml key names, doc type, file name. */
export const XML = {
  fileName: 'devices.xml',
  docType: 'QtCreatorSfdkDevices',
  countKey: 'Devices.Count',
  dataKeyPrefix: 'Device.',
  keys: {
    id: 'Id',
    name: 'Name',
    autodetected: 'Autodetected',
    architecture: 'Architecture',
    wordWidth: 'WordWidth',
    machineType: 'MachineType',
    host: 'Host',
    port: 'Port',
    userName: 'UserName',
    authenticationType: 'AuthenticationType',
    privateKeyFile: 'PrivateKeyFile',
    timeout: 'Timeout',
    hostKeyChecking: 'HostKeyChecking',
    freePorts: 'FreePorts',
    qmlLivePorts: 'QmlLivePorts',
  },
} as const;

/**
 * src/libs/sfdk/device.h: `enum MachineType { HardwareMachine, EmulatorMachine };`
 * Unscoped C++ enum, sequential from 0.
 */
export const MACHINE_TYPE = { hardware: 0, emulator: 1 } as const;

/**
 * src/libs/sfdk/device.h: `enum Architecture { ArmArchitecture, X86Architecture };`
 * Only two values exist — armv7hl and aarch64 both encode as Arm(0); WordWidth (32/64)
 * is what distinguishes them. i486 encodes as X86(1), WordWidth 32.
 */
export const ARCHITECTURE = { arm: 0, x86: 1 } as const;

export type SfdkArch = 'armv7hl' | 'aarch64' | 'i486';

export function architectureFields(arch: SfdkArch): { architecture: number; wordWidth: number } {
  if (arch === 'aarch64') {
    return { architecture: ARCHITECTURE.arm, wordWidth: 64 };
  }
  if (arch === 'armv7hl') {
    return { architecture: ARCHITECTURE.arm, wordWidth: 32 };
  }
  return { architecture: ARCHITECTURE.x86, wordWidth: 32 };
}

/**
 * src/libs/ssh/sshconnection.h: `enum AuthenticationType { AuthenticationTypeAll,
 * AuthenticationTypeSpecificKey };`. device.cpp's DeviceManager::updateDevicesXml (~line 650)
 * only exports a private-key path when `authenticationType == AuthenticationTypeSpecificKey`,
 * confirming SpecificKey is the correct value for a device we register with a generated key
 * (not the struct's own default of `AuthenticationTypeAll`, which is for password/agent auth).
 */
export const AUTHENTICATION_TYPE = { all: 0, specificKey: 1 } as const;

/**
 * src/libs/ssh/sshconnection.h: `enum SshHostKeyCheckingMode { SshHostKeyCheckingNone,
 * SshHostKeyCheckingStrict, SshHostKeyCheckingAllowNoMatch };`. The struct's own field
 * default is `SshHostKeyCheckingAllowNoMatch` (=2) — the TRD's original [D] guess of 0
 * was wrong; corrected here from the real source.
 */
export const HOST_KEY_CHECKING = { none: 0, strict: 1, allowNoMatch: 2 } as const;

/**
 * src/libs/ssh/sshconnection.h `SshConnectionParameters`: `int timeout = 0;` (seconds).
 * The TRD's original [D] guess of 10 was wrong; corrected here from the real source.
 */
export const DEFAULT_TIMEOUT_SECONDS = 0;

/** src/libs/sfdk/sfdkconstants.h: DEFAULT_QML_LIVE_PORT = 10234, MAX_PORT_LIST_PORTS = 10. */
export const DEFAULT_FREE_PORTS = '10000-10009';
export const DEFAULT_QML_LIVE_PORTS = '10234-10243';
