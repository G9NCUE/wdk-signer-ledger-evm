// Mirrors the string enums of @ledgerhq/device-management-kit 1.9 (DeviceActionStatus, DeviceStatus).
// Kept local so the signer and its tests load without the kit, whose ESM build only resolves in a bundler.
export const DeviceActionStatus = Object.freeze({
  NotStarted: 'not-started',
  Pending: 'pending',
  Stopped: 'stopped',
  Completed: 'completed',
  Error: 'error'
})

export const DeviceStatus = Object.freeze({
  LOCKED: 'LOCKED',
  BUSY: 'BUSY',
  CONNECTED: 'CONNECTED',
  NOT_CONNECTED: 'NOT CONNECTED'
})
