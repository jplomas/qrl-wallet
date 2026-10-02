/* global QRLLIB */

const state = {
  network: 'testnet',
  networks: [],
  wallet: null,
  view: 'home',
  busy: false,
  error: '',
  nodeInfo: null,
};

const SHOR_PER_QUANTA = 1e9;

async function api(method, body = {}) {
  const response = await fetch(`/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error((payload && payload.error) || `API ${method} failed`);
  }
  return payload.result;
}

function waitForQrllib(timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (typeof QRLLIB !== 'undefined' && QRLLIB.Xmss) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error('QRLLIB failed to load'));
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

function formatQuanta(shorValue) {
  const raw = Number(shorValue || 0);
  if (!Number.isFinite(raw)) return '0';
  return (raw / SHOR_PER_QUANTA).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 9,
  });
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value !== false && value != null) {
      node.setAttribute(key, value === true ? '' : value);
    }
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function setError(message) {
  state.error = message || '';
  render();
}

function setBusy(busy) {
  state.busy = busy;
  render();
}

function renderHome() {
  return el('section', { className: 'stack' }, [
    el('div', { className: 'hero' }, [
      el('h1', { text: 'QRL Wallet' }),
      el('p', {
        text: 'Native desktop client — keys stay in this process, chain calls go through a loopback-only local API.',
      }),
    ]),
    el('div', { className: 'panel stack' }, [
      el('div', { className: 'row' }, [
        el('button', {
          className: 'btn',
          text: 'Open Wallet',
          onClick: () => {
            state.view = 'open';
            state.error = '';
            render();
          },
        }),
        el('button', {
          className: 'btn secondary',
          text: 'Create Wallet',
          onClick: () => {
            state.view = 'create';
            state.error = '';
            render();
          },
        }),
      ]),
      state.nodeInfo
        ? el('p', {
          className: 'muted',
          text: `Connected · height ${state.nodeInfo.height ?? '—'} · ${state.network}`,
        })
        : el('p', { className: 'muted', text: 'Connecting to network…' }),
    ]),
  ]);
}

function renderOpen() {
  let mode = 'mnemonic';

  const seedInput = el('textarea', {
    id: 'seedInput',
    placeholder: 'Enter mnemonic phrase or hexseed',
    autocomplete: 'off',
    spellcheck: 'false',
  });

  const tabs = el('div', { className: 'tabs' }, [
    el('button', {
      className: 'tab active',
      type: 'button',
      text: 'Mnemonic',
      onClick: (event) => {
        mode = 'mnemonic';
        tabs.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
        event.currentTarget.classList.add('active');
        seedInput.placeholder = 'Enter mnemonic phrase';
      },
    }),
    el('button', {
      className: 'tab',
      type: 'button',
      text: 'Hexseed',
      onClick: (event) => {
        mode = 'hexseed';
        tabs.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
        event.currentTarget.classList.add('active');
        seedInput.placeholder = 'Enter hexseed';
      },
    }),
  ]);

  return el('section', { className: 'stack' }, [
    el('div', { className: 'hero' }, [
      el('h1', { text: 'Open Wallet' }),
      el('p', { text: 'Unlock from a mnemonic or hexseed. Nothing is sent to the local API except signed requests and address lookups.' }),
    ]),
    el('div', { className: 'panel stack' }, [
      tabs,
      el('div', { className: 'field' }, [
        el('label', { for: 'seedInput', text: 'Seed' }),
        seedInput,
      ]),
      el('div', { className: 'actions' }, [
        el('button', {
          className: 'btn secondary',
          text: 'Back',
          onClick: () => {
            state.view = 'home';
            state.error = '';
            render();
          },
        }),
        el('button', {
          className: 'btn',
          text: state.busy ? 'Unlocking…' : 'Unlock',
          disabled: state.busy,
          onClick: async () => {
            const value = seedInput.value.trim();
            if (!value) {
              setError('Enter a mnemonic or hexseed');
              return;
            }
            setBusy(true);
            setError('');
            try {
              await waitForQrllib();
              const xmss = mode === 'hexseed'
                ? QRLLIB.Xmss.fromHexSeed(value)
                : QRLLIB.Xmss.fromMnemonic(value);
              const address = xmss.getAddress();
              if (!address) {
                throw new Error('Invalid seed');
              }
              state.wallet = {
                address,
                pk: xmss.getPK(),
                hexseed: xmss.getHexSeed(),
                mnemonic: xmss.getMnemonic(),
                xmss,
                mode,
              };
              state.view = 'wallet';
              await refreshWallet();
            } catch (error) {
              setError(error.message || String(error));
            } finally {
              setBusy(false);
            }
          },
        }),
      ]),
    ]),
  ]);
}

function renderCreate() {
  const heightSelect = el('select', { id: 'xmssHeight' }, [
    el('option', { value: '10', text: 'Height 10 (safe for testing)' }),
    el('option', { value: '12', text: 'Height 12' }),
    el('option', { value: '14', text: 'Height 14' }),
  ]);

  return el('section', { className: 'stack' }, [
    el('div', { className: 'hero' }, [
      el('h1', { text: 'Create Wallet' }),
      el('p', { text: 'Generate a new XMSS address locally. Back up the mnemonic before using it with funds.' }),
    ]),
    el('div', { className: 'panel stack' }, [
      el('div', { className: 'field' }, [
        el('label', { for: 'xmssHeight', text: 'Tree height' }),
        heightSelect,
      ]),
      el('div', { className: 'actions' }, [
        el('button', {
          className: 'btn secondary',
          text: 'Back',
          onClick: () => {
            state.view = 'home';
            render();
          },
        }),
        el('button', {
          className: 'btn',
          text: state.busy ? 'Generating…' : 'Generate',
          disabled: state.busy,
          onClick: async () => {
            setBusy(true);
            setError('');
            try {
              await waitForQrllib();
              const height = Number(heightSelect.value);
              const seed = new Uint8Array(48);
              crypto.getRandomValues(seed);
              const vec = new QRLLIB.Uint8Vector();
              for (let i = 0; i < seed.length; i += 1) vec.push_back(seed[i]);
              const xmss = await QRLLIB.Xmss.fromParameters(
                vec,
                height,
                QRLLIB.eHashFunction.SHAKE_128,
              );
              state.wallet = {
                address: xmss.getAddress(),
                pk: xmss.getPK(),
                hexseed: xmss.getHexSeed(),
                mnemonic: xmss.getMnemonic(),
                xmss,
                mode: 'created',
              };
              state.view = 'wallet';
              await refreshWallet();
            } catch (error) {
              setError(error.message || String(error));
            } finally {
              setBusy(false);
            }
          },
        }),
      ]),
    ]),
  ]);
}

function renderWallet() {
  const wallet = state.wallet;
  if (!wallet) {
    state.view = 'home';
    return renderHome();
  }

  const balance = wallet.state ? formatQuanta(wallet.state.balance) : '—';
  const ots = wallet.ots && wallet.ots.next_unused_ots != null
    ? String(wallet.ots.next_unused_ots)
    : '—';

  return el('section', { className: 'stack' }, [
    el('div', { className: 'hero' }, [
      el('h1', { text: 'Wallet' }),
      el('p', { className: 'mono', text: wallet.address }),
    ]),
    el('div', { className: 'stat-grid' }, [
      el('div', { className: 'stat' }, [
        el('span', { className: 'label', text: 'Balance' }),
        el('div', { className: 'value', text: `${balance} Quanta` }),
      ]),
      el('div', { className: 'stat' }, [
        el('span', { className: 'label', text: 'Next OTS' }),
        el('div', { className: 'value', text: ots }),
      ]),
      el('div', { className: 'stat' }, [
        el('span', { className: 'label', text: 'Network' }),
        el('div', { className: 'value', text: state.network }),
      ]),
    ]),
    el('div', { className: 'panel stack' }, [
      el('div', { className: 'field' }, [
        el('label', { text: 'Mnemonic (keep private)' }),
        el('p', { className: 'mono muted', text: wallet.mnemonic }),
      ]),
      el('div', { className: 'actions' }, [
        el('button', {
          className: 'btn secondary',
          text: 'Refresh',
          disabled: state.busy,
          onClick: async () => {
            setBusy(true);
            try {
              await refreshWallet();
            } catch (error) {
              setError(error.message || String(error));
            } finally {
              setBusy(false);
            }
          },
        }),
        el('button', {
          className: 'btn secondary',
          text: 'Transfer',
          onClick: () => {
            state.view = 'transfer';
            state.error = '';
            render();
          },
        }),
        el('button', {
          className: 'btn',
          text: 'Lock',
          onClick: () => {
            state.wallet = null;
            state.view = 'home';
            state.error = '';
            render();
          },
        }),
      ]),
    ]),
  ]);
}

function renderTransfer() {
  const wallet = state.wallet;
  if (!wallet) {
    state.view = 'home';
    return renderHome();
  }

  const toInput = el('input', {
    id: 'toAddress',
    placeholder: 'Q…',
    autocomplete: 'off',
  });
  const amountInput = el('input', {
    id: 'amount',
    type: 'number',
    min: '0',
    step: '0.000000001',
    placeholder: '0.0',
  });
  const feeInput = el('input', {
    id: 'fee',
    type: 'number',
    min: '0',
    step: '0.000000001',
    value: '0.001',
  });
  const status = el('p', { className: 'muted', text: 'Transfers are signed locally, then pushed through the loopback API.' });

  return el('section', { className: 'stack' }, [
    el('div', { className: 'hero' }, [
      el('h1', { text: 'Transfer' }),
      el('p', { className: 'mono', text: wallet.address }),
    ]),
    el('div', { className: 'panel stack' }, [
      el('div', { className: 'field' }, [
        el('label', { for: 'toAddress', text: 'Destination' }),
        toInput,
      ]),
      el('div', { className: 'field' }, [
        el('label', { for: 'amount', text: 'Amount (Quanta)' }),
        amountInput,
      ]),
      el('div', { className: 'field' }, [
        el('label', { for: 'fee', text: 'Fee (Quanta)' }),
        feeInput,
      ]),
      status,
      el('div', { className: 'actions' }, [
        el('button', {
          className: 'btn secondary',
          text: 'Back',
          onClick: () => {
            state.view = 'wallet';
            render();
          },
        }),
        el('button', {
          className: 'btn',
          text: state.busy ? 'Sending…' : 'Prepare Transfer',
          disabled: state.busy,
          onClick: async () => {
            const to = toInput.value.trim();
            const amountQuanta = Number(amountInput.value);
            const feeQuanta = Number(feeInput.value);
            if (!/^Q[0-9a-fA-F]{72}$/.test(to)) {
              setError('Destination must be a QRL address');
              return;
            }
            if (!(amountQuanta > 0)) {
              setError('Enter a positive amount');
              return;
            }
            setBusy(true);
            setError('');
            try {
              const amountShor = Math.round(amountQuanta * SHOR_PER_QUANTA);
              const feeShor = Math.round(feeQuanta * SHOR_PER_QUANTA);
              const prepared = await api('transferCoins', {
                network: state.network,
                fromAddress: wallet.address,
                addresses_to: [to],
                amounts: [amountShor],
                fee: feeShor,
                xmss_pk: wallet.pk,
              });
              status.textContent = `Node prepared transfer. Review tx hash material then confirm in a future build. Response keys: ${Object.keys(prepared || {}).join(', ')}`;
              status.className = 'success';
            } catch (error) {
              setError(error.message || String(error));
            } finally {
              setBusy(false);
            }
          },
        }),
      ]),
    ]),
  ]);
}

async function refreshWallet() {
  if (!state.wallet) return;
  const [addressState, ots] = await Promise.all([
    api('getAddressState', {
      network: state.network,
      address: state.wallet.address,
    }),
    api('getOTS', {
      network: state.network,
      address: state.wallet.address,
    }).catch(() => null),
  ]);
  state.wallet.state = addressState;
  state.wallet.ots = ots;
  render();
}

function render() {
  const root = document.getElementById('viewRoot');
  root.replaceChildren();

  let view;
  if (state.view === 'open') view = renderOpen();
  else if (state.view === 'create') view = renderCreate();
  else if (state.view === 'wallet') view = renderWallet();
  else if (state.view === 'transfer') view = renderTransfer();
  else view = renderHome();

  root.appendChild(view);
  if (state.error) {
    root.appendChild(el('div', { className: 'error', text: state.error }));
  }
}

async function bootstrap() {
  window.__QRL_NATIVE_DESKTOP__ = true;
  render();

  const badge = document.getElementById('connectionBadge');
  const networkSelect = document.getElementById('networkSelect');

  try {
    const health = await fetch('/api/health').then((r) => r.json());
    if (!health.ok) throw new Error('Backend unhealthy');

    state.networks = await api('networks');
    networkSelect.replaceChildren();
    for (const network of state.networks) {
      networkSelect.appendChild(el('option', {
        value: network.id,
        text: network.name,
        selected: network.id === state.network,
      }));
    }
    networkSelect.addEventListener('change', async () => {
      state.network = networkSelect.value;
      await refreshConnection();
      if (state.wallet) {
        await refreshWallet();
      }
    });

    await refreshConnection();
    badge.textContent = 'connected';
    badge.classList.add('ok');
  } catch (error) {
    badge.textContent = 'offline';
    badge.classList.add('err');
    setError(error.message || String(error));
  }
}

async function refreshConnection() {
  const connected = await api('connect', { network: state.network });
  const height = await api('getHeight', { network: state.network });
  state.nodeInfo = {
    endpoint: connected.endpoint,
    height: height && (height.height || height.block_height || height),
  };
  render();
}

bootstrap();
