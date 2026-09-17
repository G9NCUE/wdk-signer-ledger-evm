# wdk-signer-ledger-evm

Ledger hardware signer for the [Tether WDK](https://github.com/tetherto/wdk-wallet-evm), on the
Ledger Device Management Kit. Implements the `ISignerEvm` contract of `@tetherto/wdk-wallet-evm`
1.0.0-beta.18, so a `WalletManagerEvm` derives accounts and signs with the device, and the private
key never leaves it.

Port of [tetherto/wdk-wallet-evm PR #89](https://github.com/tetherto/wdk-wallet-evm/pull/89)
onto the published beta.18, as a package outside the WDK. Differences from the PR:

- one device session shared by the root signer and every derived account, one WebHID prompt,
  and disposing the root ends every derived account (the WDK manager only disposes accounts that
  hold a private key);
- `signAuthorization` implemented on `signDelegationAuthorization` of the Ethereum signer kit 1.18
  (the PR, on 1.10, threw: the app could not sign an EIP-7702 authorization alone at the time);
- the primary type of typed data is resolved by ethers, not taken as the first key of `types`, and the
  data goes through `TypedDataEncoder.getPayload` first, so BigInt values (a 7702 user operation) reach
  the device kit as strings ([issue #42](https://github.com/tetherto/wdk-wallet-evm-7702-gasless/issues/42) on the 7702 module);
- the Ledger kits are loaded lazily, so the package and its tests run in Node without a bundler.

Browser only. WebHID exists in Chromium browsers, on `https` or `localhost`.

## Usage

```js
import WalletManagerEvm from '@tetherto/wdk-wallet-evm'
import { LedgerSignerEvm, createWebHidDmk } from 'wdk-signer-ledger-evm'

const dmk = await createWebHidDmk()
const wallet = new WalletManagerEvm(new LedgerSignerEvm({ dmk }), { provider: 'https://ethereum-sepolia-rpc.publicnode.com' })

// call from a click handler: the first getAddress opens the browser device picker
const account = await wallet.getAccount(0)
await account.getAddress()          // m/44'/60'/0'/0/0 on the device
await account.sign('hello')         // confirmed on the device
await account.sendTransaction({ to, value: 1n })
```

`getAddress` does not ask for confirmation on the device (`checkOnDevice: false`). Signing does.
The Ethereum app must be open and the device unlocked, otherwise the call rejects with a clear
message. A signer registered by name (`wallet.addSigner('ledger', signer)`) works the same way.

## Tests

```
npm install
npm test
```

Sixteen offline tests on a fake DMK and Ethereum signer backed by a local HD wallet, through the
real `WalletManagerEvm` beta.18. The device path was verified by hand in
[wdk-signers-demo](https://github.com/G9NCUE/wdk-signers-demo).

## Status

Prototype, not published on npm (`"private": true`). See the decision of 2026-09-11 in the
author's workspace: signer prototypes live under a personal account until the WDK team picks a
name and a home for external signers.
