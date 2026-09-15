// Browser only: WebHID exists in Chromium browsers, on a secure origin or localhost.
// The Ledger kits are loaded here, not at module top level, so this package imports cleanly in Node.
export async function createWebHidDmk () {
  const [{ DeviceManagementKitBuilder }, { webHidTransportFactory }] = await Promise.all([
    import('@ledgerhq/device-management-kit'),
    import('@ledgerhq/device-transport-kit-web-hid')
  ])
  return new DeviceManagementKitBuilder().addTransport(webHidTransportFactory).build()
}
