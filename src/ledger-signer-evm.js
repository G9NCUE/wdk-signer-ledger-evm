'use strict'

import { ISigner, InvalidSignerError, ValueError } from '@tetherto/wdk-wallet'
import { filter, firstValueFrom, map } from 'rxjs'
import { Signature, Transaction, TypedDataEncoder, getBytes } from 'ethers'
import { DeviceActionStatus, DeviceStatus } from './constants.js'

// loaded on first connect: the Ledger kits ship an ESM build that only a bundler resolves
async function defaultBuildSignerEth ({ dmk, sessionId }) {
  const { SignerEthBuilder } = await import('@ledgerhq/device-signer-kit-ethereum')
  return new SignerEthBuilder({ dmk, sessionId }).build()
}

const PATH_PREFIX = "44'/60'"
const DEFAULT_PATH = "0'/0/0"

// Follows the ISignerEvm contract by shape: wdk-wallet-evm beta.18 does not export the class.
// Port of tetherto/wdk-wallet-evm PR #89 (Ledger DMK) onto the published beta.18, with one
// device session shared by the root signer and every account derived from it.
export default class LedgerSignerEvm extends ISigner {
  // dmk is a DeviceManagementKit built with a transport (see createWebHidDmk in ../index.js).
  // buildSignerEth({ dmk, sessionId }) returns a SignerEth, injectable for tests.
  constructor ({ dmk, buildSignerEth, path = DEFAULT_PATH, session, isChild = false } = {}) {
    super()
    if (!dmk) throw new ValueError('A Ledger DeviceManagementKit is required.')
    this._dmk = dmk
    this._buildSignerEth = buildSignerEth ?? defaultBuildSignerEth
    this._path = `${PATH_PREFIX}/${path}`
    this._isChild = isChild
    // shared by reference between the root and its children: { id, signerEth }
    this._session = session ?? { id: '', signerEth: undefined }
    this._address = undefined
    this._publicKey = null
  }

  static async connect (opts) {
    const signer = new LedgerSignerEvm(opts)
    await signer.getAddress()
    return signer
  }

  get isDerivable () { return !this._isChild }
  get index () { return +this._path.split('/').pop() }
  get path () { return this._path }
  get address () { return this._address }
  get keyPair () { return { privateKey: null, publicKey: this._publicKey } }

  async derive (relPath) {
    if (!this.isDerivable) throw new InvalidSignerError('Cannot derive: this signer is a derived child.')
    return new LedgerSignerEvm({ dmk: this._dmk, buildSignerEth: this._buildSignerEth, path: relPath, session: this._session, isChild: true })
  }

  async getAddress () {
    if (this._address) return this._address
    const signerEth = await this._ready()
    const { address, publicKey } = await this._run(signerEth.getAddress(this._path, { checkOnDevice: false }))
    this._address = address
    this._publicKey = getBytes(hex0x(publicKey))
    return this._address
  }

  async sign (message) {
    const signerEth = await this._ready()
    const sig = await this._run(signerEth.signMessage(this._path, message))
    return Signature.from(toEthersSig(sig)).serialized
  }

  async signTransaction (unsignedTx) {
    const address = await this.getAddress()
    // the Ethereum app signs the RLP of the unsigned transaction, "from" is not part of it
    const { from, ...txLike } = unsignedTx
    if (from && from.toLowerCase() !== address.toLowerCase()) {
      throw new ValueError(`Transaction "from" (${from}) does not match the signer address (${address}).`)
    }
    const tx = Transaction.from(txLike)
    const signerEth = await this._ready()
    const sig = await this._run(signerEth.signTransaction(this._path, getBytes(tx.unsignedSerialized)))
    tx.signature = Signature.from(toEthersSig(sig))
    return tx.serialized
  }

  async signTypedData ({ domain, types, message }) {
    // the device kit adds the EIP712Domain struct itself, and wants the primary type spelled out
    const { EIP712Domain, ...rest } = types
    const primaryType = TypedDataEncoder.from(rest).primaryType
    const signerEth = await this._ready()
    const sig = await this._run(signerEth.signTypedData(this._path, { domain, types: rest, primaryType, message }))
    return Signature.from(toEthersSig(sig)).serialized
  }

  // needs Ethereum app 1.16 or later on the device, older apps refuse it
  async signAuthorization (auth) {
    const populated = { address: auth.address, nonce: BigInt(auth.nonce ?? 0), chainId: BigInt(auth.chainId ?? 0) }
    const signerEth = await this._ready()
    const sig = await this._run(signerEth.signDelegationAuthorization(this._path, Number(populated.chainId), populated.address, Number(populated.nonce)))
    return { ...populated, signature: Signature.from(toEthersSig(sig)) }
  }

  // the root owns the device session, children only drop their references
  dispose () {
    if (!this._isChild && this._session.id && this._dmk) {
      const { id } = this._session
      this._session.id = ''
      this._session.signerEth = undefined
      this._dmk.disconnect({ sessionId: id }).catch(() => {})
    }
    this._dmk = undefined
    this._publicKey = null
  }

  // connects on first use, checks the device is unlocked and reachable, returns the SignerEth
  async _ready () {
    if (!this._dmk) throw new InvalidSignerError('The signer has been disposed.')
    if (!this._session.id) await this._connect()
    let state
    try {
      state = await firstValueFrom(this._dmk.getDeviceSessionState({ sessionId: this._session.id }))
    } catch {
      await this._connect()
      return this._session.signerEth
    }
    if (state.deviceStatus === DeviceStatus.LOCKED) throw new InvalidSignerError('The Ledger device is locked.')
    if (state.deviceStatus === DeviceStatus.BUSY) throw new InvalidSignerError('The Ledger device is busy.')
    if (state.deviceStatus === DeviceStatus.NOT_CONNECTED) await this._connect()
    return this._session.signerEth
  }

  // with the WebHID transport this opens the browser device picker, so call it from a user gesture
  async _connect () {
    const device = await firstValueFrom(this._dmk.startDiscovering({}))
    this._session.id = await this._dmk.connect({ device, sessionRefresherOptions: { isRefresherDisabled: true } })
    this._session.signerEth = await this._buildSignerEth({ dmk: this._dmk, sessionId: this._session.id })
  }

  // waits for a device action to finish and unwraps its output
  async _run ({ observable }) {
    return firstValueFrom(observable.pipe(
      filter(e => e.status === DeviceActionStatus.Completed || e.status === DeviceActionStatus.Error || e.status === DeviceActionStatus.Stopped),
      map(e => {
        if (e.status === DeviceActionStatus.Completed) return e.output
        if (e.status === DeviceActionStatus.Error) throw errorFrom(e.error)
        throw new InvalidSignerError('The Ledger action was stopped on the device.')
      })
    ))
  }
}

// the kit gives v as 27/28, or EIP-155 encoded for legacy transactions, ethers handles both
function toEthersSig ({ r, s, v }) {
  return { r: hex0x(r), s: hex0x(s), v }
}

function errorFrom (error) {
  if (error instanceof Error) return error
  const tag = error?._tag ?? error?.name ?? 'LedgerError'
  const detail = error?.message ?? error?.originalError?.message ?? JSON.stringify(error)
  return new InvalidSignerError(`${tag}: ${detail}`)
}

function hex0x (hex) {
  return hex.startsWith('0x') ? hex : `0x${hex}`
}
