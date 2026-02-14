/* eslint no-console:0 */
/* global QRLLIB, XMSS_OBJECT, LocalStore, QrlLedger, isElectrified, selectedNetwork,loadAddressTransactions, getTokenBalances, updateBalanceField, refreshTransferPage */
/* global pkRawToB32Address, hexOrB32, rawToHexOrB32, anyAddressToRawAddress, stringToBytes, binaryToBytes, bytesToString, bytesToHex, hexToBytes, toBigendianUint64BytesUnsigned, numberToString, decimalToBinary */
/* global getMnemonicOfFirstAddress, getXMSSDetails, isWalletFileDeprecated, waitForQRLLIB, addressForAPI, binaryToQrlAddress, toUint8Vector, concatenateTypedArrays, getQrlProtoShasum */
/* global resetWalletStatus, passwordPolicyValid, countDecimals, supportedBrowser, wrapMeteorCall, getBalance, otsIndexUsed, ledgerHasNoTokenSupport, resetLocalStorageState, nodeReturnedValidResponse */
/* global POLL_TXN_RATE, POLL_MAX_CHECKS, DEFAULT_NETWORKS, findNetworkData, SHOR_PER_QUANTA, WALLET_VERSION, QRLPROTO_SHA256,  */

import { BlazeLayout } from 'meteor/pwix:blaze-layout'
import { FlowRouter } from 'meteor/ostrio:flow-router-extra'
import '../../stylesheets/overrides.css'
import { isChecked, isVisible } from '../../lib/dom'
import { isElectrified } from '../../../startup/client/functions'

BlazeLayout.setRoot('body')

const connectToNode = (endpoint, callback) => {
  wrapMeteorCall('connectToNode', endpoint, (err, res) => {
    if (err) {
      callback(err, null)
    } else {
      callback(null, res)
    }
  })
}

const checkNetworkHealth = (network, callback) => {
  wrapMeteorCall('checkNetworkHealth', network, (err, res) => {
    if (err) {
      callback(err, null)
    } else {
      callback(null, res)
    }
  })
}

// TODO: refactor this -- duplicate code used in ../mobile/mobile.js
// Set session state based on selected network node.
const updateNetwork = (selectedNetwork) => {
  let userNetwork = selectedNetwork

  // If no network is selected, default to mainnet
  if (selectedNetwork === '') {
    const networkSelect = document.getElementById('network')
    if (networkSelect) networkSelect.value = DEFAULT_NETWORKS[0].id
    userNetwork = DEFAULT_NETWORKS[0].id
  }

  // Set node status to connecting
  Session.set('nodeStatus', 'connecting')

  Session.set('cancellingNetwork', false)

  // Update local node connection details
  switch (userNetwork) {
    case 'add': {
      // Show DaisyUI modal for adding custom node
      const modal = document.getElementById('addNodeModal')
      if (modal) modal.showModal()
      break
    }
    case 'custom': {
      const nodeData = {
        id: 'custom',
        name: LocalStore.get('customNodeName'),
        disabled: '',
        explorerUrl: LocalStore.get('customNodeExplorerUrl'),
        type: 'both',
        grpc: LocalStore.get('customNodeGrpc'),
      }

      Session.set('nodeId', 'custom')
      Session.set('nodeName', LocalStore.get('customNodeName'))
      Session.set('nodeGrpc', LocalStore.get('customNodeGrpc'))
      Session.set('nodeExplorerUrl', LocalStore.get('customNodeExplorerUrl'))

      console.log('Connecting to custom remote gRPC node: ', nodeData.grpc)
      connectToNode(nodeData.grpc, (err) => {
        if (err) {
          console.log('Error: ', err)
          Session.set('nodeStatus', 'failed')
        } else {
          console.log('Custom gRPC client loaded: ', nodeData.grpc)
          Session.set('nodeStatus', 'ok')
        }
      })
      break
    }
    default: {
      const nodeData = findNetworkData(DEFAULT_NETWORKS, userNetwork)
      Session.set('nodeId', nodeData.id)
      Session.set('nodeName', nodeData.name)
      Session.set('nodeExplorerUrl', nodeData.explorerUrl)
      Session.set('nodeGrpc', nodeData.grpc)

      console.log('Connecting to network: ', nodeData.name)
      checkNetworkHealth(nodeData.id, (err, res) => {
        if (err) {
          console.log('the error: ', err)
          Session.set('nodeStatus', 'failed')
        } else {
          console.log('Connection to network is healthy: ', nodeData.id)
          Session.set('nodeStatus', 'ok')
        }
      })
      break
    }
  }
}

Template.appBody.onRendered(() => {
  Session.set('modalEventTriggered', false)

  // Initialize with default network
  const networkSelect = document.getElementById('network')
  if (networkSelect) {
    networkSelect.value = Session.get('nodeId') || DEFAULT_NETWORKS[0].id
  }

  updateNetwork(selectedNetwork())

  // Debug log for web assembly support
  console.log('Web Assembly Supported: ', supportedBrowser())
})

Template.appBody.events({
  'change #network': (event) => {
    const value = event.target.value
    console.log('Network changed to:', value)
    updateNetwork(value)
    if (value !== 'add' && Session.get('cancellingNetwork') !== true) {
      // reload to update balances/Txs if on different network
      window.Reload._reload()
    }
    Session.set('cancellingNetwork', false)
  },
  'click #saveCustomNode': () => {
    // Save custom node settings
    Session.set('nodeId', 'custom')
    Session.set('nodeName', document.getElementById('customNodeName').value)
    Session.set('nodeGrpc', document.getElementById('customNodeGrpc').value)
    Session.set('nodeExplorerUrl', document.getElementById('customNodeExplorer').value)

    LocalStore.set('customNodeName', document.getElementById('customNodeName').value)
    LocalStore.set('customNodeGrpc', document.getElementById('customNodeGrpc').value)
    LocalStore.set('customNodeExplorerUrl', document.getElementById('customNodeExplorer').value)
    LocalStore.set('customNodeCreated', true)

    // Close modal and select custom node
    const modal = document.getElementById('addNodeModal')
    if (modal) modal.close()
    
    const networkSelect = document.getElementById('network')
    if (networkSelect) networkSelect.value = 'custom'
    
    updateNetwork('custom')
  },
  'click #cancelCustomNode': () => {
    const modal = document.getElementById('addNodeModal')
    if (modal) modal.close()
    
    // Revert to mainnet
    Session.set('cancellingNetwork', true)
    const networkSelect = document.getElementById('network')
    if (networkSelect) networkSelect.value = 'mainnet'
  },
  'change #addressFormatCheckbox': () => {
    const checked = isChecked('addressFormatCheckbox')
    if (checked) {
      LocalStore.set('addressFormat', 'bech32')
    } else {
      LocalStore.set('addressFormat', 'hex')
    }
  },
  'click #sendAndReceiveButton': () => {
    // Three primary sections
    const transactionGenerateFieldVisible = isVisible('generateTransactionArea')
    const tokenBalancesTabVisible = isVisible('tokenBalancesTab')
    const receiveTabVisible = isVisible('receiveTab')

    // Completed transaction sections
    const tokenTransactionResultAreaVisible = isVisible('tokenTransactionResultArea')
    const transactionResultAreaVisible = isVisible('transactionResultArea')

    if (FlowRouter.getRouteName() === 'App.transfer') {
      if (
        (transactionGenerateFieldVisible === false)
        && (tokenBalancesTabVisible === false)
        && (receiveTabVisible === false)) {
        // If the user has completed the transaction, go back to send form.
        if (
          (tokenTransactionResultAreaVisible === true)
          || (transactionResultAreaVisible === true)) {
          // Check if the trasaction is confirmed on the network.
          const transactionConfirmed = Session.get('transactionConfirmed')
          if (transactionConfirmed === 'true') {
            const reloadPath = FlowRouter.path('/reloadTransfer', {})
            FlowRouter.go(reloadPath)
          } else {
            window.walletUi.showModal('#cancelWaitingForTransactionWarning', {
              onApprove: () => {
                window.walletUi.hideModal('#cancelWaitingForTransactionWarning')
                const reloadPath = FlowRouter.path('/reloadTransfer', {})
                FlowRouter.go(reloadPath)
              },
            })
          }
        } else {
          // Confirm with user they will lose progress of this transaction if they proceeed.
          window.walletUi.showModal('#cancelTransactionGenerationWarning', {
            onApprove: () => {
              window.walletUi.hideModal('#cancelTransactionGenerationWarning')
              const reloadPath = FlowRouter.path('/reloadTransfer', {})
              FlowRouter.go(reloadPath)
            },
          })
        }
      }
    }
  },
})


Template.appBody.helpers({
  walletStatus() {
    return Session.get('walletStatus')
  },
  addressFormat() {
    if (LocalStore.get('addressFormat') === 'bech32') {
      return 'BECH32'
    }
    return 'Hex'
  },
  inProgress() {
    if (Session.get('txstatus') === 'Pending') {
      return true
    }
    return false
  },
  balanceAmount() {
    if (Session.get('balanceAmount')) {
      return Session.get('balanceAmount')
    }
    return Session.get('transferFromBalance')
  },
  otsKeysRemaining() {
    if (Session.get('errorLoadingTransactions')) {
      return 'unknown'
    }
    return Session.get('otsKeysRemaining')

  },
  balanceSymbol() {
    return Session.get('balanceSymbol')
  },
  addressFormatChecked() {
    if (LocalStore.get('addressFormat') === 'bech32') {
      return 'checked'
    }
    return ''
  },
  nodeId() {
    if ((Session.get('nodeId') === '') || (Session.get('nodeId') === null)) {
      return DEFAULT_NETWORKS[0].id
    }
    return Session.get('nodeId')
  },
  nodeName() {
    if ((Session.get('nodeName') === '') || (Session.get('nodeName') === null)) {
      return DEFAULT_NETWORKS[0].name
    }
    return Session.get('nodeName')
  },
  nodeExplorerUrl() {
    if ((Session.get('nodeExplorerUrl') === '') || (Session.get('nodeExplorerUrl') === null)) {
      return DEFAULT_NETWORKS[0].explorerUrl
    }
    return Session.get('nodeExplorerUrl')
  },
  defaultNetworks() {
    const visibleNodes = []

    // Only return nodes specific to this (web/desktop/both).
    _.each(DEFAULT_NETWORKS, (node) => {
      // Desktop Electrified Clients
      if ((node.type === 'desktop') && (isElectrified())) {
        visibleNodes.push(node)
      // Web Non-Electrified Clients
      } else if ((node.type === 'web') && !isElectrified()) {
        visibleNodes.push(node)
      // Everything else
      } else if (node.type === 'both') {
        visibleNodes.push(node)
      }
    })

    return visibleNodes
  },
  connectionStatus() {
    const status = {}
    if (Session.get('nodeStatus') === 'connecting') {
      status.string = 'Connecting to'
      status.colour = 'yellow'
      status.connected = false
    } else if (Session.get('nodeStatus') === 'ok') {
      status.string = 'Connected to'
      status.colour = 'green'
      status.connected = true
    } else {
      status.string = 'Failed to connect to'
      status.colour = 'red'
      status.connected = false
    }
    return status
  },
  customNodeCreated() {
    return LocalStore.get('customNodeCreated')
  },
  customNodeName() {
    return LocalStore.get('customNodeName')
  },

  /* Active Menu Item Helpers */
  menuNewWalletActive() {
    if (
      (FlowRouter.getRouteName() === 'App.home')
      || (FlowRouter.getRouteName() === 'App.create')
      || (FlowRouter.getRouteName() === 'App.createAddress')) {
      return 'active'
    }
    return ''
  },
  menuOpenWalletActive() {
    if (
      (FlowRouter.getRouteName() === 'App.open')
      || (FlowRouter.getRouteName() === 'App.opened')) {
      return 'active'
    }
    return ''
  },
  menuTransferActive() {
    if (
      (FlowRouter.getRouteName() === 'App.transfer')) {
      return 'active'
    }
    return ''
  },
  menuToolsActive() {
    if (FlowRouter.getRouteName()?.startsWith('App.tools') || 
        FlowRouter.getRouteName()?.startsWith('App.message') ||
        FlowRouter.getRouteName()?.startsWith('App.multisig')) {
      return 'active'
    }
    return ''
  },
  menuTokensActive() {
    if (
      (FlowRouter.getRouteName() === 'App.tokens')
      || (FlowRouter.getRouteName() === 'App.tokensView')
      || (FlowRouter.getRouteName() === 'App.tokensCreate')
      || (FlowRouter.getRouteName() === 'App.tokenCreationConfirm')
      || (FlowRouter.getRouteName() === 'App.tokenCreationResult')
      || (FlowRouter.getRouteName() === 'App.tokensTransfer')
      || (FlowRouter.getRouteName() === 'App.tokensTransferLoad')
      || (FlowRouter.getRouteName() === 'App.tokensTransferConfirm')
      || (FlowRouter.getRouteName() === 'App.tokensTransferResult')) {
      return 'active'
    }
    return ''
  },
  menuVerifyActive() {
    if (
      (FlowRouter.getRouteName() === 'App.verify')
      || (FlowRouter.getRouteName() === 'App.verifytxid')) {
      return 'active'
    }
    return ''
  },
  qrlWalletVersion() {
    return WALLET_VERSION
  },
  currentYear() {
    return new Date().getFullYear()
  },
})

Template.customNode.helpers({
  customNodeName() {
    return LocalStore.get('customNodeName')
  },
  customNodeGrpc() {
    return LocalStore.get('customNodeGrpc')
  },
  customNodeExplorer() {
    return LocalStore.get('customNodeExplorerUrl')
  },
})
