# Native client feature checklist

Port of Meteor/Electron QRL Wallet capabilities into `native/`.
Base PR target: **`native`** branch.

## Done
- [x] Loopback Node API + OS WebView shells (macOS/Windows/Linux)
- [x] Network picker (mainnet/testnet) + connection badge
- [x] Open wallet (mnemonic / hexseed)
- [x] Create XMSS wallet via worker + countdown/spinner progress
- [x] Balance + Next OTS display
- [x] Mnemonic hidden until user reveals
- [x] daisyUI QRL theme shell
- [x] Quanta transfer: prepare → confirm → local XMSS sign → push
- [x] Receive: address QR
- [x] Transaction history (basic list)
- [x] Verify transaction by txid
- [x] Create options: hash function + backup screen (QR / hexseed / save)
- [x] Wallet file save/open (v3 encrypted + plain)

## Next
- [ ] OTS key tracker + reuse / low-key warnings
- [ ] On-chain message tool
- [ ] Recovery seed tool (mnemonic + hexseed + QR)
- [ ] Token balances + transfer + create
- [ ] Document notarise
- [ ] Ledger open + sign
- [ ] Multisig create/spend/vote
- [ ] Keybase + Github identity tools
- [ ] NFT balances + mint
- [ ] Nav shell + explorer links + version footer

## Explicitly deferred / policy
- Custom gRPC nodes (native allowlist keeps these off by default)
