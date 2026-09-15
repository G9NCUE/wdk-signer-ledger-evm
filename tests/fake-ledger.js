// Stands in for a Ledger DeviceManagementKit and its SignerEth, signing with a local HD wallet.
// Shapes follow @ledgerhq/device-management-kit 1.9 and @ledgerhq/device-signer-kit-ethereum 1.18.
import { DeviceActionStatus, DeviceStatus } from '../src/constants.js'
import { HDNodeWallet, Signature, SigningKey, Transaction, TypedDataEncoder, hashAuthorization, hashMessage, hexlify } from 'ethers'
import { of, throwError } from 'rxjs'

export class FakeDmk {
  constructor () {
    this.status = DeviceStatus.CONNECTED
    this.calls = []
    this.sessions = 0
  }

  startDiscovering () {
    this.calls.push('startDiscovering')
    return of({ id: 'fake-device' })
  }

  async connect ({ device }) {
    this.calls.push('connect')
    if (device.id !== 'fake-device') throw new Error('unknown device')
    return `session-${++this.sessions}`
  }

  getDeviceSessionState ({ sessionId }) {
    this.calls.push('getDeviceSessionState')
    if (!sessionId) return throwError(() => new Error('no session'))
    return of({ deviceStatus: this.status })
  }

  async disconnect ({ sessionId }) {
    this.calls.push('disconnect:' + sessionId)
  }
}

export class FakeSignerEth {
  constructor (mnemonic, dmk) {
    this.root = HDNodeWallet.fromPhrase(mnemonic, undefined, 'm')
    this.dmk = dmk
    this.calls = []
  }

  _wallet (path) {
    return this.root.derivePath(path)
  }

  _done (output) {
    return { observable: of({ status: DeviceActionStatus.Completed, output }) }
  }

  _sig (wallet, digest) {
    const { r, s, v } = wallet.signingKey.sign(digest)
    return { r: r.slice(2), s: s.slice(2), v }
  }

  getAddress (path) {
    this.calls.push('getAddress')
    const w = this._wallet(path)
    // the Ethereum app returns the uncompressed key, 65 bytes, no 0x
    return this._done({ address: w.address, publicKey: SigningKey.computePublicKey(w.privateKey, false).slice(2) })
  }

  signMessage (path, message) {
    this.calls.push('signMessage')
    return this._done(this._sig(this._wallet(path), hashMessage(message)))
  }

  signTransaction (path, bytes) {
    this.calls.push('signTransaction')
    const tx = Transaction.from(hexlify(bytes))
    return this._done(this._sig(this._wallet(path), tx.unsignedHash))
  }

  signTypedData (path, { domain, types, primaryType, message }) {
    this.calls.push('signTypedData:' + primaryType)
    if (types.EIP712Domain) return { observable: of({ status: DeviceActionStatus.Error, error: { _tag: 'InvalidTypedData', message: 'EIP712Domain in types' } }) }
    return this._done(this._sig(this._wallet(path), TypedDataEncoder.hash(domain, types, message)))
  }

  signDelegationAuthorization (path, chainId, address, nonce) {
    this.calls.push('signDelegationAuthorization')
    return this._done(this._sig(this._wallet(path), hashAuthorization({ address, nonce, chainId })))
  }
}

export function fakeLedger (mnemonic) {
  const dmk = new FakeDmk()
  const signerEth = new FakeSignerEth(mnemonic, dmk)
  return { dmk, signerEth, buildSignerEth: () => signerEth, wallet: signerEth.root, Signature }
}
