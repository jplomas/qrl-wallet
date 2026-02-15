/* eslint no-console:0 */
/* global QRLLIB, XMSS_OBJECT, LocalStore, QrlLedger, isElectrified, selectedNetwork,loadAddressTransactions, getTokenBalances, updateBalanceField, refreshTransferPage */
/* global pkRawToB32Address, hexOrB32, rawToHexOrB32, anyAddressToRawAddress, stringToBytes, binaryToBytes, bytesToString, bytesToHex, hexToBytes, toBigendianUint64BytesUnsigned, numberToString, decimalToBinary */
/* global getMnemonicOfFirstAddress, getXMSSDetails, isWalletFileDeprecated, waitForQRLLIB, addressForAPI, binaryToQrlAddress, toUint8Vector, concatenateTypedArrays, getQrlProtoShasum */
/* global resetWalletStatus, passwordPolicyValid, countDecimals, supportedBrowser, wrapMeteorCall, getBalance, otsIndexUsed, ledgerHasNoTokenSupport, resetLocalStorageState, nodeReturnedValidResponse */
/* global POLL_TXN_RATE, POLL_MAX_CHECKS, DEFAULT_NETWORKS, findNetworkData, SHOR_PER_QUANTA, WALLET_VERSION, QRLPROTO_SHA256,  */

import { computed, createApp, h, ref } from 'vue'
import './tools.html'

const TOOLS = [
  {
    href: '/tokens/create',
    title: 'Create Token',
    description: 'Create your own QRT.',
    category: 'asset',
    badge: 'Asset',
  },
  {
    href: '/tools/notarise/start',
    title: 'Notarise Document',
    description: 'Notarise a document on the QRL.',
    category: 'identity',
    badge: 'Identity',
  },
  {
    href: '/tools/message/create',
    title: 'Message',
    description: 'Save a message on the QRL.',
    category: 'identity',
    badge: 'Identity',
  },
  {
    href: '/tools/xmssindex/update',
    title: 'Set XMSS Index',
    description: 'Update the XMSS index on a Ledger Nano S.',
    category: 'advanced',
    badge: 'Ledger',
    ledgerOnly: true,
  },
  {
    href: '/tools/keybase',
    title: 'Keybase ID',
    description: 'Add or remove a Keybase ID for your address.',
    category: 'identity',
    badge: 'Identity',
  },
  {
    href: '/tools/multisig',
    title: 'Multisig',
    description: 'Multisignature wallet functionality.',
    category: 'advanced',
    badge: 'Advanced',
  },
  {
    href: '/tools/addTokens',
    title: 'Add/Remove Tokens',
    description: 'Manage held tokens in your wallet.',
    category: 'asset',
    badge: 'Asset',
  },
  {
    href: '/tools/NFT',
    title: 'Mint QR NFT',
    description: 'Create a quantum-resistant non-fungible token.',
    category: 'asset',
    badge: 'Asset',
  },
]

const CATEGORY_LABELS = {
  all: 'All categories',
  asset: 'Asset',
  identity: 'Identity',
  advanced: 'Advanced',
}

function normalize(value) {
  return String(value || '').toLowerCase().trim()
}

function renderToolCard(tool) {
  return h('a', { href: tool.href, class: 'card-gradient block hover:shadow-accent' }, [
    h('div', { class: 'flex items-start justify-between gap-2' }, [
      h('h3', { class: 'text-lg font-semibold text-base-content' }, tool.title),
      h('span', { class: 'badge badge-outline badge-sm' }, tool.badge),
    ]),
    h('p', { class: 'text-sm text-base-content/70 mt-1' }, tool.description),
  ])
}

function createToolsVueApp(tools) {
  return {
    setup() {
      const query = ref('')
      const selectedCategory = ref('all')

      const categories = ['all', ...new Set(tools.map((tool) => tool.category))]

      const filteredTools = computed(() => {
        const category = selectedCategory.value
        const search = normalize(query.value)

        return tools.filter((tool) => {
          const inCategory = category === 'all' || tool.category === category
          if (!inCategory) return false

          if (!search) return true

          const text = normalize(`${tool.title} ${tool.description} ${tool.badge}`)
          return text.includes(search)
        })
      })

      return {
        categories,
        filteredTools,
        query,
        selectedCategory,
      }
    },
    render() {
      const categoryOptions = this.categories.map((category) => (
        h('option', { value: category }, CATEGORY_LABELS[category] || category)
      ))

      const gridCards = this.filteredTools.map((tool) => renderToolCard(tool))
      const countLabel = `${this.filteredTools.length} tool${this.filteredTools.length === 1 ? '' : 's'}`

      return h('div', { class: 'space-y-4' }, [
        h('div', { class: 'card bg-base-200 border border-base-300' }, [
          h('div', { class: 'card-body p-4 sm:flex-row gap-3 items-center' }, [
            h('input', {
              class: 'input w-full bg-base-100',
              placeholder: 'Search tools',
              value: this.query,
              onInput: (event) => {
                this.query = event.target.value
              },
            }),
            h('select', {
              class: 'select w-full sm:w-56 bg-base-100',
              value: this.selectedCategory,
              onChange: (event) => {
                this.selectedCategory = event.target.value
              },
            }, categoryOptions),
          ]),
        ]),
        h('p', { class: 'text-sm text-base-content/70 px-1' }, countLabel),
        h('div', { class: 'grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4' }, gridCards),
        this.filteredTools.length === 0
          ? h('div', { class: 'alert' }, [
            h('span', {}, 'No tools match the current filter.'),
          ])
          : null,
      ])
    },
  }
}

Template.appTools.onRendered(function onRendered() {
  const mountElement = this.find('#toolsVueRoot')
  if (!mountElement) return

  let isLedgerWallet = false
  try {
    isLedgerWallet = getXMSSDetails().walletType === 'ledger'
  } catch (error) {
    isLedgerWallet = false
  }

  const availableTools = TOOLS.filter((tool) => !tool.ledgerOnly || isLedgerWallet)
  this.toolsVueApp = createApp(createToolsVueApp(availableTools))
  this.toolsVueApp.mount(mountElement)
})

Template.appTools.onDestroyed(function onDestroyed() {
  if (this.toolsVueApp) {
    this.toolsVueApp.unmount()
    this.toolsVueApp = null
  }
})
