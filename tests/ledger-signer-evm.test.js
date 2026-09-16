import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DeviceActionStatus, DeviceStatus } from '../src/constants.js'
import { Transaction, verifyAuthorization, verifyMessage, verifyTypedData } from 'ethers'
import { of } from 'rxjs'
import WalletManagerEvm from '@tetherto/wdk-wallet-evm'
import { LedgerSignerEvm } from '../index.js'
import { fakeLedger } from './fake-ledger.js'

// throwaway test mnemonic, never funded
const MNEMONIC = 'test test test test test test test test test test test junk'
const expected = (i, ledger) => ledger.wallet.derivePath(`44'/60'/0'/0/${i}`).address

function setup () {
  const ledger = fakeLedger(MNEMONIC)
  const signer = new LedgerSignerEvm({ dmk: ledger.dmk, buildSignerEth: ledger.buildSignerEth })
  return { ledger, signer, wallet: new WalletManagerEvm(signer) }
}

test('requires a dmk', () => {
  assert.throws(() => new LedgerSignerEvm({}), /DeviceManagementKit/)
})

test('root signer is derivable, with the BIP-44 path and index', () => {
  const { signer } = setup()
  assert.equal(signer.isDerivable, true)
  assert.equal(signer.path, "m/44'/60'/0'/0/0")
  assert.equal(signer.index, 0)
})

test('account 0 through the WDK manager has the device address', async () => {
  const { ledger, wallet } = setup()
  const account = await wallet.getAccount(0)
  assert.equal(await account.getAddress(), expected(0, ledger))
  assert.equal(account.path, "m/44'/60'/0'/0/0")
  assert.equal(account.keyPair.privateKey, null)
  assert.equal(account.keyPair.publicKey.length, 65)
})

test('accounts share one device session', async () => {
  const { ledger, wallet } = setup()
  const a0 = await wallet.getAccount(0)
  const a1 = await wallet.getAccount(1)
  assert.equal(await a0.getAddress(), expected(0, ledger))
  assert.equal(await a1.getAddress(), expected(1, ledger))
  assert.equal(ledger.dmk.calls.filter(c => c === 'connect').length, 1)
})

test('a derived child cannot derive', async () => {
  const { signer } = setup()
  const child = await signer.derive("0'/0/3")
  assert.equal(child.isDerivable, false)
  assert.equal(child.index, 3)
  await assert.rejects(child.derive("0'/0/4"), /derived child/)
})

test('signs a message', async () => {
  const { wallet } = setup()
  const account = await wallet.getAccount(0)
  const address = await account.getAddress()
  const sig = await account.sign('hello from wdk')
  assert.equal(verifyMessage('hello from wdk', sig), address)
})

test('signs an EIP-1559 transaction', async () => {
  const { ledger, wallet } = setup()
  const account = await wallet.getAccount(0)
  const address = await account.getAddress()
  const signed = await account.signTransaction({
    chainId: 11155111, nonce: 0, to: address, value: 0n, data: '0x', type: 2,
    gasLimit: 21000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n
  })
  const tx = Transaction.from(signed)
  assert.equal(tx.from, address)
  assert.equal(tx.type, 2)
  assert.ok(ledger.signerEth.calls.includes('signTransaction'))
})

test('signs a legacy transaction with an EIP-155 v', async () => {
  const { wallet } = setup()
  const account = await wallet.getAccount(0)
  const address = await account.getAddress()
  const signed = await account.signTransaction({ chainId: 11155111, nonce: 0, to: address, value: 0n, type: 0, gasLimit: 21000n, gasPrice: 1_000_000_000n })
  assert.equal(Transaction.from(signed).from, address)
})

test('rejects a transaction from another address', async () => {
  const { signer } = setup()
  await signer.getAddress()
  await assert.rejects(signer.signTransaction({ from: '0x0000000000000000000000000000000000000001', chainId: 1, nonce: 0 }), /does not match/)
})

test('signs typed data, primary type resolved, EIP712Domain stripped', async () => {
  const { ledger, wallet } = setup()
  const account = await wallet.getAccount(0)
  const address = await account.getAddress()
  const typed = {
    domain: { name: 'WDK', version: '1', chainId: 11155111, verifyingContract: address },
    types: {
      EIP712Domain: [{ name: 'name', type: 'string' }],
      Person: [{ name: 'wallet', type: 'address' }],
      Transfer: [{ name: 'to', type: 'Person' }, { name: 'amount', type: 'uint256' }]
    },
    message: { to: { wallet: address }, amount: 42 }
  }
  const sig = await account.signTypedData(typed)
  const { EIP712Domain, ...types } = typed.types
  assert.equal(verifyTypedData(typed.domain, types, typed.message, sig), address)
  assert.ok(ledger.signerEth.calls.includes('signTypedData:Transfer'))
})

test('signs an EIP-7702 authorization', async () => {
  const { wallet } = setup()
  const account = await wallet.getAccount(0)
  const address = await account.getAddress()
  const auth = await account.signAuthorization({ address, nonce: 1, chainId: 11155111 })
  assert.equal(verifyAuthorization(auth, auth.signature), address)
})

test('refuses to sign on a locked device', async () => {
  const { ledger, signer } = setup()
  await signer.getAddress()
  ledger.dmk.status = DeviceStatus.LOCKED
  await assert.rejects(signer.sign('x'), /locked/)
})

test('reconnects when the device session is gone', async () => {
  const { ledger, signer } = setup()
  await signer.getAddress()
  ledger.dmk.status = DeviceStatus.NOT_CONNECTED
  const sig = await signer.sign('again')
  assert.equal(verifyMessage('again', sig), signer.address)
  assert.equal(ledger.dmk.calls.filter(c => c === 'connect').length, 2)
})

test('surfaces device action errors', async () => {
  const { ledger, signer } = setup()
  ledger.signerEth.signTypedData = () => ({ observable: of({ status: DeviceActionStatus.Error, error: { _tag: 'UserRejected', message: 'rejected on device' } }) })
  await assert.rejects(signer.signTypedData({ domain: {}, types: { A: [{ name: 'x', type: 'uint8' }] }, message: { x: 1 } }), /UserRejected: rejected on device/)
})

test('registered by name with addSigner', async () => {
  const seed = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
  const wallet = new WalletManagerEvm(seed)
  const ledger = fakeLedger(MNEMONIC)
  wallet.addSigner('ledger', new LedgerSignerEvm({ dmk: ledger.dmk, buildSignerEth: ledger.buildSignerEth }))
  const account = await wallet.getAccount(0, { signerName: 'ledger' })
  assert.equal(await account.getAddress(), expected(0, ledger))
  wallet.dispose()
})

test('dispose closes the device session once, from the root', async () => {
  const { ledger, wallet } = setup()
  await (await wallet.getAccount(0)).getAddress()
  await (await wallet.getAccount(1)).getAddress()
  wallet.dispose()
  await new Promise(r => setImmediate(r))
  assert.deepEqual(ledger.dmk.calls.filter(c => c.startsWith('disconnect')), ['disconnect:session-1'])
})
