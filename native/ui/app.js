/* global QRLLIB */

import { ensureXmssFromWallet, signTransferTransaction } from './lib/sign-transfer.js';
import {
  buildEncryptedEnvelope,
  buildUnencryptedEnvelope,
  decryptV3Envelope,
  downloadWalletFile,
  normalizeWalletRecord,
} from './lib/wallet-v3.js';
import {
  otsIndexUsed,
  otsKeysRemaining,
  parseOtsBitfield,
  totalSignaturesForHeight,
} from './lib/ots.js';
import { signMessageTransaction } from './lib/sign-message.js';
import {
  signTokenCreateTransaction,
  signTokenTransferTransaction,
} from './lib/sign-token.js';
import {
  buildNotarisationHex,
  notarisationHexToMessageBytes,
  sha256HexOfArrayBuffer,
  NOTARISE_SHA256_ADDITIONAL_MAX,
} from './lib/notarise.js';

const state = {
  network: 'testnet',
  networks: [],
  wallet: null,
  view: 'home',
  busy: false,
  error: '',
  success: '',
  nodeInfo: null,
  revealMnemonic: false,
  generating: null,
  transferDraft: null,
  transferResult: null,
  history: null,
  verifyResult: null,
  tokens: null,
  tokenCreateDraft: null,
  tokenCreateResult: null,
  tokenTransferDraft: null,
  tokenTransferResult: null,
  notariseDraft: null,
  notariseResult: null,
};

const SHOR_PER_QUANTA = 1e9;

/** Estimated XMSS tree build times (seconds) — used for the countdown phase. */
const XMSS_ESTIMATE_SECONDS = {
  8: 1,
  10: 3,
  12: 15,
  14: 90,
  16: 420,
  18: 1500,
};

const XMSS_ESTIMATE_LABELS = {
  8: '~1 second',
  10: '~2–3 seconds',
  12: '~10–15 seconds',
  14: '~1–2 minutes',
  16: '~5–10 minutes',
  18: '~20–30 minutes',
};

let generationWorker = null;
let countdownTimer = null;
let elapsedTimer = null;
let generationEpoch = 0;

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

function waitForQrllib(timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (typeof QRLLIB !== 'undefined' && typeof QRLLIB.str2bin === 'function' && QRLLIB.Xmss) {
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

function isValidQrlAddress(address) {
  return typeof address === 'string'
    && /^Q[0-9a-fA-F]{78}$/.test(address);
}

function openXmssFromSeed(mode, value) {
  const xmss = mode === 'hexseed'
    ? QRLLIB.Xmss.fromHexSeed(value)
    : QRLLIB.Xmss.fromMnemonic(value);
  const address = xmss.getAddress();
  if (!isValidQrlAddress(address)) {
    throw new Error('Derived address is invalid — QRLLIB may not be fully initialised. Try again.');
  }
  return {
    address,
    pk: xmss.getPK(),
    hexseed: xmss.getHexSeed(),
    mnemonic: xmss.getMnemonic(),
    xmss,
    mode,
  };
}

function readBalanceShor(addressState) {
  if (!addressState) return null;
  if (addressState.state && addressState.state.balance != null) {
    return addressState.state.balance;
  }
  if (addressState.balance != null) return addressState.balance;
  return null;
}

function readNextOts(otsResponse) {
  if (!otsResponse) return null;
  if (otsResponse.next_unused_ots_index != null) {
    return otsResponse.next_unused_ots_index;
  }
  if (otsResponse.next_unused_ots != null) return otsResponse.next_unused_ots;
  if (otsResponse.nextKey != null) return otsResponse.nextKey;
  return null;
}

function formatQuanta(shorValue) {
  const raw = Number(shorValue || 0);
  if (!Number.isFinite(raw)) return '0';
  return (raw / SHOR_PER_QUANTA).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 9,
  });
}

function formatElapsed(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${String(remainder).padStart(2, '0')}s`;
  }
  return `${remainder}s`;
}

function formatCountdown(seconds) {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const remainder = safe % 60;
  if (minutes > 0) {
    return `${minutes}:${String(remainder).padStart(2, '0')}`;
  }
  return String(remainder);
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === false || value == null) {
      // skip
    } else if (value === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, value);
    }
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function icon(paths, className = 'h-5 w-5') {
  return el('svg', {
    xmlns: 'http://www.w3.org/2000/svg',
    className,
    fill: 'none',
    viewBox: '0 0 24 24',
    stroke: 'currentColor',
    'aria-hidden': 'true',
  }, paths.map((d) => el('path', {
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'stroke-width': '2',
    d,
  })));
}

function setError(message) {
  state.error = message || '';
  state.success = '';
  render();
}

function setSuccess(message) {
  state.success = message || '';
  state.error = '';
  render();
}

function setBusy(busy) {
  state.busy = busy;
  render();
}

function clearGenerationTimers() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  if (elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
}

function stopGenerationWorker() {
  if (generationWorker) {
    generationWorker.terminate();
    generationWorker = null;
  }
  clearGenerationTimers();
}

function startGenerationProgress(xmssHeight) {
  clearGenerationTimers();
  const estimateSeconds = XMSS_ESTIMATE_SECONDS[xmssHeight] || 15;
  state.generating = {
    height: xmssHeight,
    phase: 'countdown',
    countdownRemaining: estimateSeconds,
    estimateLabel: XMSS_ESTIMATE_LABELS[xmssHeight] || 'calculating…',
    elapsedSeconds: 0,
    signatures: 2 ** xmssHeight,
  };
  state.view = 'generating';
  state.error = '';
  render();

  countdownTimer = setInterval(() => {
    if (!state.generating) return;
    if (state.generating.countdownRemaining <= 1) {
      state.generating.countdownRemaining = 0;
      state.generating.phase = 'spinner';
      clearInterval(countdownTimer);
      countdownTimer = null;
      render();
      return;
    }
    state.generating.countdownRemaining -= 1;
    render();
  }, 1000);

  elapsedTimer = setInterval(() => {
    if (!state.generating) return;
    state.generating.elapsedSeconds += 1;
    // Refresh elapsed label without resetting countdown phase visuals every tick
    // once we are in spinner phase; still update during countdown for accuracy.
    const elapsedEl = document.getElementById('genElapsed');
    if (elapsedEl) {
      elapsedEl.textContent = `Elapsed ${formatElapsed(state.generating.elapsedSeconds)}`;
    } else {
      render();
    }
  }, 1000);
}

function generateWithWorker(randomSeed, xmssHeight, hashFunction = 'SHAKE_128') {
  if (!window.Worker) {
    throw new Error('Web Workers are not supported in this environment');
  }

  return new Promise((resolve, reject) => {
    stopGenerationWorker();
    generationWorker = new Worker('/workers/wallet-worker.js');

    generationWorker.onmessage = (event) => {
      const data = event.data || {};
      stopGenerationWorker();
      if (data.error) {
        reject(new Error(data.error));
        return;
      }
      resolve(data);
    };

    generationWorker.onerror = (error) => {
      stopGenerationWorker();
      reject(new Error(error.message || 'Wallet generation failed in worker'));
    };

    generationWorker.postMessage({
      randomSeed: Array.from(randomSeed),
      xmssHeight,
      hashFunction,
      timeoutMs: 120000,
    });
  });
}

function generateOnMainThread(randomSeed, xmssHeight) {
  const vec = new QRLLIB.Uint8Vector();
  for (let i = 0; i < randomSeed.length; i += 1) vec.push_back(randomSeed[i]);
  const xmss = QRLLIB.Xmss.fromParameters(
    vec,
    xmssHeight,
    QRLLIB.eHashFunction.SHAKE_128,
  );
  return {
    address: xmss.getAddress(),
    pk: xmss.getPK(),
    hexseed: xmss.getHexSeed(),
    mnemonic: xmss.getMnemonic(),
    height: xmssHeight,
  };
}

function renderHome() {
  return el('section', { className: 'space-y-8' }, [
    el('div', { className: 'space-y-3' }, [
      el('p', {
        className: 'text-xs uppercase tracking-[0.2em] text-primary font-semibold',
        text: 'QRL Wallet',
      }),
      el('h1', {
        className: 'native-hero-brand text-base-content',
        text: 'Quantum-secure keys, local only',
      }),
      el('p', {
        className: 'text-base-content/70 max-w-xl leading-relaxed',
        text: 'Open or create an XMSS wallet. Seeds never leave this process — chain calls go through a loopback API.',
      }),
    ]),
    el('div', { className: 'card-gradient' }, [
      el('div', { className: 'card-body gap-5' }, [
        el('div', { className: 'flex flex-wrap gap-3' }, [
          el('button', {
            className: 'btn btn-primary gap-2',
            type: 'button',
            onClick: () => {
              state.view = 'open';
              state.error = '';
              state.revealMnemonic = false;
              render();
            },
          }, [
            icon(['M8 11V7a4 4 0 118 0v4M5 11h14v10H5V11z']),
            'Open Wallet',
          ]),
          el('button', {
            className: 'btn btn-outline gap-2',
            type: 'button',
            onClick: () => {
              state.view = 'create';
              state.error = '';
              render();
            },
          }, [
            icon(['M12 4v16m8-8H4']),
            'Create Wallet',
          ]),
          el('button', {
            className: 'btn btn-ghost gap-2',
            type: 'button',
            onClick: () => {
              state.view = 'verify';
              state.verifyResult = null;
              state.error = '';
              render();
            },
          }, ['Verify TX']),
        ]),
        state.nodeInfo
          ? el('p', {
            className: 'text-sm text-base-content/60',
            text: `Connected · height ${state.nodeInfo.height ?? '—'} · ${state.network}`,
          })
          : el('p', {
            className: 'text-sm text-base-content/60',
            text: 'Connecting to network…',
          }),
      ]),
    ]),
  ]);
}

function renderOpen() {
  let mode = 'mnemonic';

  const seedInput = el('textarea', {
    id: 'seedInput',
    className: 'textarea textarea-bordered w-full native-mono min-h-28',
    placeholder: 'Enter mnemonic phrase',
    autocomplete: 'off',
    spellcheck: 'false',
  });

  const fileInput = el('input', {
    id: 'walletFileInput',
    className: 'file-input file-input-bordered w-full',
    type: 'file',
    accept: 'application/json,.json',
  });
  const filePass = el('input', {
    id: 'walletFilePassphrase',
    className: 'input input-bordered w-full',
    type: 'password',
    placeholder: 'Passphrase (if encrypted)',
    autocomplete: 'current-password',
  });

  const seedPanel = el('div', { id: 'openSeedPanel', className: 'space-y-4' }, [
    el('div', { className: 'tabs tabs-boxed bg-base-100/40 w-full' }, [
      el('a', {
        className: 'tab tab-active',
        role: 'tab',
        text: 'Mnemonic',
        onClick: (event) => {
          event.preventDefault();
          mode = 'mnemonic';
          event.currentTarget.classList.add('tab-active');
          event.currentTarget.parentElement.querySelectorAll('.tab').forEach((t) => {
            if (t !== event.currentTarget) t.classList.remove('tab-active');
          });
          seedInput.placeholder = 'Enter mnemonic phrase';
        },
      }),
      el('a', {
        className: 'tab',
        role: 'tab',
        text: 'Hexseed',
        onClick: (event) => {
          event.preventDefault();
          mode = 'hexseed';
          event.currentTarget.classList.add('tab-active');
          event.currentTarget.parentElement.querySelectorAll('.tab').forEach((t) => {
            if (t !== event.currentTarget) t.classList.remove('tab-active');
          });
          seedInput.placeholder = 'Enter hexseed';
        },
      }),
    ]),
    el('fieldset', { className: 'fieldset' }, [
      el('legend', { className: 'fieldset-legend', text: 'Seed' }),
      seedInput,
    ]),
  ]);

  const filePanel = el('div', { id: 'openFilePanel', className: 'space-y-4 hidden' }, [
    el('fieldset', { className: 'fieldset' }, [
      el('legend', { className: 'fieldset-legend', text: 'Wallet file' }),
      fileInput,
    ]),
    el('fieldset', { className: 'fieldset' }, [
      el('legend', { className: 'fieldset-legend', text: 'Passphrase' }),
      filePass,
    ]),
  ]);

  let openMode = 'seed';
  const modeTabs = el('div', { className: 'tabs tabs-boxed w-full mb-2' }, [
    el('a', {
      className: 'tab tab-active',
      text: 'Seed',
      onClick: (event) => {
        event.preventDefault();
        openMode = 'seed';
        seedPanel.classList.remove('hidden');
        filePanel.classList.add('hidden');
        modeTabs.querySelectorAll('.tab').forEach((t) => t.classList.remove('tab-active'));
        event.currentTarget.classList.add('tab-active');
      },
    }),
    el('a', {
      className: 'tab',
      text: 'Wallet file',
      onClick: (event) => {
        event.preventDefault();
        openMode = 'file';
        seedPanel.classList.add('hidden');
        filePanel.classList.remove('hidden');
        modeTabs.querySelectorAll('.tab').forEach((t) => t.classList.remove('tab-active'));
        event.currentTarget.classList.add('tab-active');
      },
    }),
  ]);

  return el('section', { className: 'space-y-6' }, [
    el('div', { className: 'space-y-2' }, [
      el('h1', { className: 'text-3xl font-bold', text: 'Open Wallet' }),
      el('p', {
        className: 'text-base-content/70',
        text: 'Unlock from a mnemonic, hexseed, or a saved v3 wallet file.',
      }),
    ]),
    el('div', { className: 'card-gradient' }, [
      el('div', { className: 'card-body gap-4' }, [
        modeTabs,
        seedPanel,
        filePanel,
        el('div', { className: 'card-actions justify-between' }, [
          el('button', {
            className: 'btn btn-ghost',
            type: 'button',
            onClick: () => {
              state.view = 'home';
              state.error = '';
              render();
            },
          }, ['Back']),
          el('button', {
            className: 'btn btn-primary',
            type: 'button',
            disabled: state.busy,
            text: state.busy ? 'Unlocking…' : 'Unlock',
            onClick: async () => {
              setBusy(true);
              setError('');
              try {
                await waitForQrllib();
                if (openMode === 'file') {
                  const file = fileInput.files && fileInput.files[0];
                  if (!file) throw new Error('Choose a wallet.json file');
                  const raw = JSON.parse(await file.text());
                  const unlocked = await decryptV3Envelope(raw, filePass.value || '');
                  const record = normalizeWalletRecord(unlocked);
                  state.wallet = {
                    address: record.address,
                    pk: record.pk,
                    hexseed: record.hexseed,
                    mnemonic: record.mnemonic,
                    height: record.height,
                    hashFunction: record.hashFunction,
                    mode: 'file',
                  };
                } else {
                  const value = seedInput.value.trim();
                  if (!value) throw new Error('Enter a mnemonic or hexseed');
                  state.wallet = openXmssFromSeed(mode, value);
                }
                state.revealMnemonic = false;
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
    ]),
  ]);
}

function renderCreate() {
  const heightSelect = el('select', {
    id: 'xmssHeight',
    className: 'select select-bordered w-full bg-base-100',
  }, [
    el('option', { value: '8', text: 'Height 8 — 256 signatures (~1s)' }),
    el('option', { value: '10', text: 'Height 10 — 1,024 signatures (~2–3s)', selected: true }),
    el('option', { value: '12', text: 'Height 12 — 4,096 signatures (~10–15s)' }),
    el('option', { value: '14', text: 'Height 14 — 16,384 signatures (~1–2 min)' }),
    el('option', { value: '16', text: 'Height 16 — 65,536 signatures (~5–10 min)' }),
    el('option', { value: '18', text: 'Height 18 — 262,144 signatures (~20–30 min)' }),
  ]);
  const hashSelect = el('select', {
    id: 'hashFunction',
    className: 'select select-bordered w-full bg-base-100',
  }, [
    el('option', { value: 'SHAKE_128', text: 'SHAKE_128 (default)', selected: true }),
    el('option', { value: 'SHAKE_256', text: 'SHAKE_256' }),
    el('option', { value: 'SHA2_256', text: 'SHA2_256' }),
  ]);

  return el('section', { className: 'space-y-6' }, [
    el('div', { className: 'space-y-2' }, [
      el('h1', { className: 'text-3xl font-bold', text: 'Create Wallet' }),
      el('p', {
        className: 'text-base-content/70',
        text: 'Generate a new XMSS address locally. Larger tree heights take longer — generation runs in a background worker so the UI stays responsive.',
      }),
    ]),
    el('div', { className: 'grid gap-4 lg:grid-cols-5' }, [
      el('div', { className: 'card-gradient lg:col-span-3' }, [
        el('div', { className: 'card-body gap-4' }, [
          el('fieldset', { className: 'fieldset' }, [
            el('legend', { className: 'fieldset-legend', text: 'XMSS tree height' }),
            heightSelect,
          ]),
          el('fieldset', { className: 'fieldset' }, [
            el('legend', { className: 'fieldset-legend', text: 'Hash function' }),
            hashSelect,
          ]),
          el('div', { className: 'card-actions justify-between' }, [
            el('button', {
              className: 'btn btn-ghost',
              type: 'button',
              onClick: () => {
                state.view = 'home';
                render();
              },
            }, ['Back']),
            el('button', {
              className: 'btn btn-primary gap-2',
              type: 'button',
              disabled: state.busy,
              onClick: () => {
                const height = Number(heightSelect.value);
                const hashFunction = hashSelect.value;
                void createWallet(height, hashFunction);
              },
            }, [
              icon(['M12 4v16m8-8H4']),
              'Generate',
            ]),
          ]),
        ]),
      ]),
      el('div', {
        role: 'alert',
        className: 'alert alert-warning lg:col-span-2 items-start',
      }, [
        icon(['M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z'], 'stroke-current shrink-0 h-6 w-6'),
        el('div', {}, [
          el('h3', { className: 'font-bold', text: 'Large trees take time' }),
          el('p', {
            className: 'text-sm',
            text: 'Height 14+ can take minutes. Keep this window open while the XMSS tree builds in a worker thread.',
          }),
        ]),
      ]),
    ]),
  ]);
}

function renderGenerating() {
  const gen = state.generating;
  if (!gen) {
    state.view = 'create';
    return renderCreate();
  }

  const isCountdown = gen.phase === 'countdown' && gen.countdownRemaining > 0;

  return el('section', { className: 'space-y-6 native-generating-panel' }, [
    el('div', { className: 'space-y-2' }, [
      el('h1', { className: 'text-3xl font-bold', text: 'Generating wallet' }),
      el('p', {
        className: 'text-base-content/70',
        text: `Building an XMSS tree at height ${gen.height} (${gen.signatures.toLocaleString()} one-time signatures). Larger heights can take a while — this runs off the UI thread.`,
      }),
    ]),
    el('div', { className: 'card-gradient' }, [
      el('div', { className: 'card-body items-center text-center gap-5 py-10' }, [
        isCountdown
          ? el('div', { className: 'space-y-3' }, [
            el('p', {
              className: 'text-sm uppercase tracking-widest text-base-content/50',
              text: 'Estimated time remaining',
            }),
            el('div', {
              className: 'native-countdown font-mono text-6xl md:text-7xl text-primary font-bold',
              text: formatCountdown(gen.countdownRemaining),
            }),
            el('p', {
              className: 'text-sm text-base-content/60',
              text: `Typical for height ${gen.height}: ${gen.estimateLabel}`,
            }),
          ])
          : el('div', { className: 'native-spinner-phase space-y-4 flex flex-col items-center' }, [
            el('span', {
              className: 'loading loading-spinner loading-lg text-primary',
              'aria-label': 'Generating',
            }),
            el('div', { className: 'space-y-1' }, [
              el('h3', { className: 'font-bold text-lg', text: 'Still generating…' }),
              el('p', {
                className: 'text-sm text-base-content/70 max-w-md',
                text: 'The XMSS tree is still building. This can exceed the estimate on slower machines — please wait.',
              }),
            ]),
          ]),
        el('div', { className: 'flex flex-wrap justify-center gap-3 text-sm text-base-content/60' }, [
          el('span', {
            id: 'genElapsed',
            className: 'badge badge-ghost',
            text: `Elapsed ${formatElapsed(gen.elapsedSeconds)}`,
          }),
          el('span', {
            className: 'badge badge-ghost',
            text: 'Worker thread',
          }),
        ]),
        el('button', {
          className: 'btn btn-ghost btn-sm',
          type: 'button',
          onClick: () => {
            generationEpoch += 1;
            stopGenerationWorker();
            state.generating = null;
            state.busy = false;
            state.view = 'create';
            setError('Wallet generation cancelled');
          },
        }, ['Cancel']),
      ]),
    ]),
  ]);
}

async function createWallet(xmssHeight, hashFunction = 'SHAKE_128') {
  const epoch = generationEpoch + 1;
  generationEpoch = epoch;
  setBusy(true);
  setError('');
  startGenerationProgress(xmssHeight);

  // Yield so the generating view paints before heavy work begins.
  await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 50)));

  try {
    await waitForQrllib();
    if (epoch !== generationEpoch) return;

    const seed = new Uint8Array(48);
    crypto.getRandomValues(seed);

    let generated;
    try {
      generated = await generateWithWorker(seed, xmssHeight, hashFunction);
    } catch (workerError) {
      if (epoch !== generationEpoch) return;
      console.warn('Worker generation failed, falling back to main thread:', workerError);
      generated = generateOnMainThread(seed, xmssHeight);
    }

    if (epoch !== generationEpoch) return;

    if (!isValidQrlAddress(generated.address)) {
      throw new Error('Generated address is invalid — QRLLIB may not be fully initialised');
    }

    state.wallet = {
      address: generated.address,
      pk: generated.pk,
      hexseed: generated.hexseed,
      mnemonic: generated.mnemonic,
      height: xmssHeight,
      hashFunction,
      mode: 'created',
    };
    state.revealMnemonic = false;
    state.generating = null;
    clearGenerationTimers();
    state.view = 'backup';
    render();
    void loadBackupQr();
  } catch (error) {
    if (epoch !== generationEpoch) return;
    stopGenerationWorker();
    state.generating = null;
    state.view = 'create';
    setError(error.message || String(error));
  } finally {
    if (epoch === generationEpoch) {
      setBusy(false);
    }
  }
}

function renderBackup() {
  const wallet = state.wallet;
  if (!wallet) {
    state.view = 'home';
    return renderHome();
  }

  const passphraseInput = el('input', {
    id: 'backupPassphrase',
    className: 'input input-bordered w-full',
    type: 'password',
    placeholder: 'Passphrase for encrypted save',
    autocomplete: 'new-password',
  });

  return el('section', { className: 'space-y-6' }, [
    el('div', { className: 'space-y-2' }, [
      el('h1', { className: 'text-3xl font-bold', text: 'Backup wallet' }),
      el('p', {
        className: 'text-base-content/70',
        text: 'Save your wallet before using it. The mnemonic is shown once here — store it offline.',
      }),
    ]),
    el('div', { className: 'card-gradient' }, [
      el('div', { className: 'card-body gap-4' }, [
        el('div', { className: 'flex flex-col md:flex-row gap-4 items-start' }, [
          el('div', {
            id: 'backupQr',
            className: 'bg-white rounded-lg p-3 min-h-36 min-w-36 flex items-center justify-center',
          }, [
            wallet.backupQrSvg
              ? el('div', { html: wallet.backupQrSvg })
              : el('span', { className: 'loading loading-spinner text-primary' }),
          ]),
          el('div', { className: 'space-y-2 flex-1' }, [
            el('p', { className: 'text-xs uppercase tracking-wide text-base-content/50', text: 'Address' }),
            el('p', { className: 'native-mono text-sm break-all', text: wallet.address }),
            el('p', { className: 'text-xs uppercase tracking-wide text-base-content/50', text: 'Mnemonic' }),
            el('p', {
              id: 'backupMnemonic',
              className: 'native-mono text-sm text-warning bg-warning/10 border border-warning/30 rounded-lg p-3',
              text: wallet.mnemonic,
            }),
            el('p', { className: 'text-xs uppercase tracking-wide text-base-content/50', text: 'Hexseed' }),
            el('p', { className: 'native-mono text-xs break-all', text: wallet.hexseed }),
          ]),
        ]),
        el('fieldset', { className: 'fieldset' }, [
          el('legend', { className: 'fieldset-legend', text: 'Encrypted save passphrase' }),
          passphraseInput,
        ]),
        el('div', { className: 'card-actions justify-between flex-wrap' }, [
          el('button', {
            className: 'btn btn-outline',
            type: 'button',
            text: 'Save encrypted',
            onClick: async () => {
              const passphrase = passphraseInput.value;
              if (!passphrase || passphrase.length < 8) {
                setError('Passphrase must be at least 8 characters');
                return;
              }
              try {
                const record = normalizeWalletRecord({
                  address: wallet.address,
                  pk: wallet.pk,
                  hexseed: wallet.hexseed,
                  mnemonic: wallet.mnemonic,
                  height: wallet.height,
                  hashFunction: wallet.hashFunction || 'SHAKE_128',
                  index: 0,
                });
                const envelope = await buildEncryptedEnvelope(record, passphrase);
                downloadWalletFile(envelope, `qrl-wallet-${wallet.address.slice(0, 10)}.json`);
                setSuccess('Encrypted wallet file downloaded');
              } catch (error) {
                setError(error.message || String(error));
              }
            },
          }),
          el('button', {
            className: 'btn btn-ghost',
            type: 'button',
            text: 'Save unencrypted',
            onClick: () => {
              try {
                const record = normalizeWalletRecord({
                  address: wallet.address,
                  pk: wallet.pk,
                  hexseed: wallet.hexseed,
                  mnemonic: wallet.mnemonic,
                  height: wallet.height,
                  hashFunction: wallet.hashFunction || 'SHAKE_128',
                  index: 0,
                });
                downloadWalletFile(
                  buildUnencryptedEnvelope(record),
                  `qrl-wallet-${wallet.address.slice(0, 10)}-UNENCRYPTED.json`,
                );
                setSuccess('Unencrypted wallet file downloaded — keep it private');
              } catch (error) {
                setError(error.message || String(error));
              }
            },
          }),
          el('button', {
            className: 'btn btn-primary',
            type: 'button',
            text: 'Open wallet',
            onClick: async () => {
              state.view = 'wallet';
              state.error = '';
              state.success = '';
              render();
              await refreshWallet();
            },
          }),
        ]),
      ]),
    ]),
  ]);
}

async function loadBackupQr() {
  if (!state.wallet) return;
  try {
    const result = await api('qrSvg', { text: state.wallet.address });
    state.wallet.backupQrSvg = result.svg;
    if (state.view === 'backup') render();
  } catch (error) {
    console.warn('backup QR failed', error);
  }
}

function renderWallet() {
  const wallet = state.wallet;
  if (!wallet) {
    state.view = 'home';
    return renderHome();
  }

  const balanceShor = readBalanceShor(wallet.state);
  const balance = balanceShor != null ? formatQuanta(balanceShor) : '—';
  const nextOts = readNextOts(wallet.ots);
  const ots = nextOts != null ? String(nextOts) : '—';
  const otsFound = wallet.ots && wallet.ots.unused_ots_index_found;
  const height = wallet.height || 10;
  const totalSigs = totalSignaturesForHeight(height);
  const parsedOts = wallet.ots ? parseOtsBitfield(wallet.ots, totalSigs) : { keys: {} };
  const remaining = otsKeysRemaining(parsedOts.keys, totalSigs);
  const lowOts = remaining > 0 && remaining <= Math.max(8, Math.floor(totalSigs * 0.05));

  return el('section', { className: 'space-y-6' }, [
    el('div', { className: 'space-y-2' }, [
      el('h1', { className: 'text-3xl font-bold', text: 'Wallet' }),
      el('p', { className: 'native-mono text-sm text-base-content/80', text: wallet.address }),
      lowOts
        ? el('div', {
          role: 'alert',
          className: 'alert alert-warning text-sm',
          text: `Low OTS keys remaining: ${remaining} of ${totalSigs}. Create a new wallet before you run out.`,
        })
        : null,
    ]),
    el('div', { className: 'stats stats-vertical sm:stats-horizontal bg-base-200/80 border border-base-content/10 w-full shadow' }, [
      el('div', { className: 'stat' }, [
        el('div', { className: 'stat-title', text: 'Balance' }),
        el('div', { className: 'stat-value text-2xl text-primary', text: `${balance}` }),
        el('div', { className: 'stat-desc', text: 'Quanta' }),
      ]),
      el('div', { className: 'stat' }, [
        el('div', { className: 'stat-title', text: 'Next OTS' }),
        el('div', { className: 'stat-value text-2xl', text: ots }),
        otsFound === false
          ? el('div', { className: 'stat-desc text-warning', text: 'index not confirmed' })
          : el('div', { className: 'stat-desc', text: 'one-time signature' }),
      ]),
      el('div', { className: 'stat' }, [
        el('div', { className: 'stat-title', text: 'Network' }),
        el('div', { className: 'stat-value text-2xl capitalize', text: state.network }),
        el('div', { className: 'stat-desc', text: wallet.height ? `XMSS height ${wallet.height}` : 'XMSS' }),
      ]),
    ]),
    el('div', { className: 'card-gradient' }, [
      el('div', { className: 'card-body gap-4' }, [
        el('div', { className: 'flex items-center justify-between gap-3 flex-wrap' }, [
          el('h2', { className: 'card-title text-base', text: 'Recovery phrase' }),
          el('button', {
            className: 'btn btn-sm btn-outline',
            type: 'button',
            id: 'revealMnemonicBtn',
            text: state.revealMnemonic ? 'Hide mnemonic' : 'Show mnemonic',
            onClick: () => {
              state.revealMnemonic = !state.revealMnemonic;
              render();
            },
          }),
        ]),
        state.revealMnemonic
          ? el('p', {
            id: 'mnemonicReveal',
            className: 'native-mono text-sm text-warning bg-warning/10 border border-warning/30 rounded-lg p-3',
            text: wallet.mnemonic,
          })
          : el('p', {
            className: 'text-sm text-base-content/60',
            text: 'Mnemonic is hidden. Only reveal it when you need to back up this wallet. Never share it.',
          }),
        el('div', { className: 'card-actions justify-end flex-wrap gap-2' }, [
          el('button', {
            className: 'btn btn-ghost btn-sm',
            type: 'button',
            disabled: state.busy,
            text: 'Refresh',
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
            className: 'btn btn-outline btn-sm',
            type: 'button',
            text: 'Receive',
            onClick: () => {
              state.view = 'receive';
              state.error = '';
              render();
              void loadReceiveQr();
            },
          }),
          el('button', {
            className: 'btn btn-outline btn-sm',
            type: 'button',
            text: 'History',
            onClick: () => {
              state.view = 'history';
              state.error = '';
              render();
              void loadHistory();
            },
          }),
          el('button', {
            className: 'btn btn-outline btn-sm',
            type: 'button',
            text: 'Verify',
            onClick: () => {
              state.view = 'verify';
              state.verifyResult = null;
              state.error = '';
              render();
            },
          }),
          el('button', {
            className: 'btn btn-outline btn-sm',
            type: 'button',
            text: 'Tokens',
            onClick: () => {
              state.view = 'tokens';
              state.tokenCreateDraft = null;
              state.tokenCreateResult = null;
              state.tokenTransferDraft = null;
              state.tokenTransferResult = null;
              state.error = '';
              render();
              void loadTokens();
            },
          }),
          el('button', {
            className: 'btn btn-outline btn-sm',
            type: 'button',
            text: 'OTS',
            onClick: () => {
              state.view = 'ots';
              state.error = '';
              render();
              void loadOtsTracker();
            },
          }),
          el('button', {
            className: 'btn btn-outline btn-sm',
            type: 'button',
            text: 'Tools',
            onClick: () => {
              state.view = 'tools';
              state.error = '';
              render();
            },
          }),
          el('button', {
            className: 'btn btn-outline btn-sm',
            type: 'button',
            text: 'Transfer',
            onClick: () => {
              state.view = 'transfer';
              state.transferDraft = null;
              state.transferResult = null;
              state.error = '';
              render();
            },
          }),
          el('button', {
            className: 'btn btn-primary btn-sm',
            type: 'button',
            text: 'Lock',
            onClick: () => {
              state.wallet = null;
              state.revealMnemonic = false;
              state.transferDraft = null;
              state.transferResult = null;
              state.history = null;
              state.tokens = null;
              state.tokenCreateDraft = null;
              state.tokenCreateResult = null;
              state.tokenTransferDraft = null;
              state.tokenTransferResult = null;
              state.view = 'home';
              state.error = '';
              render();
            },
          }),
        ]),
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

  if (state.transferResult) {
    return el('section', { className: 'space-y-6' }, [
      el('div', { className: 'space-y-2' }, [
        el('h1', { className: 'text-3xl font-bold', text: 'Transfer sent' }),
        el('p', { className: 'text-base-content/70', text: 'Transaction relayed to the network.' }),
      ]),
      el('div', { className: 'card-gradient' }, [
        el('div', { className: 'card-body gap-3' }, [
          el('p', { className: 'text-sm text-base-content/60', text: 'Transaction hash' }),
          el('p', {
            id: 'txHashResult',
            className: 'native-mono text-sm break-all',
            text: state.transferResult.txnHash,
          }),
          el('div', { className: 'card-actions justify-end' }, [
            el('button', {
              className: 'btn btn-primary',
              type: 'button',
              text: 'Back to wallet',
              onClick: () => {
                state.transferResult = null;
                state.transferDraft = null;
                state.view = 'wallet';
                render();
                void refreshWallet();
              },
            }),
          ]),
        ]),
      ]),
    ]);
  }

  if (state.transferDraft) {
    const draft = state.transferDraft;
    return el('section', { className: 'space-y-6' }, [
      el('div', { className: 'space-y-2' }, [
        el('h1', { className: 'text-3xl font-bold', text: 'Confirm transfer' }),
        el('p', {
          className: 'text-base-content/70',
          text: 'Review details, then sign locally with the next OTS key and relay.',
        }),
      ]),
      el('div', { className: 'card-gradient' }, [
        el('div', { className: 'card-body gap-3' }, [
          el('div', {}, [
            el('p', { className: 'text-xs uppercase tracking-wide text-base-content/50', text: 'To' }),
            el('p', { className: 'native-mono text-sm', text: draft.to }),
          ]),
          el('div', { className: 'grid grid-cols-2 gap-3' }, [
            el('div', {}, [
              el('p', { className: 'text-xs uppercase tracking-wide text-base-content/50', text: 'Amount' }),
              el('p', { className: 'font-semibold', text: `${draft.amountQuanta} Quanta` }),
            ]),
            el('div', {}, [
              el('p', { className: 'text-xs uppercase tracking-wide text-base-content/50', text: 'Fee' }),
              el('p', { className: 'font-semibold', text: `${draft.feeQuanta} Quanta` }),
            ]),
            el('div', {}, [
              el('p', { className: 'text-xs uppercase tracking-wide text-base-content/50', text: 'OTS index' }),
              el('p', { className: 'font-semibold', text: String(draft.otsIndex) }),
            ]),
          ]),
          el('div', { className: 'card-actions justify-between' }, [
            el('button', {
              className: 'btn btn-ghost',
              type: 'button',
              disabled: state.busy,
              text: 'Cancel',
              onClick: () => {
                state.transferDraft = null;
                render();
              },
            }),
            el('button', {
              className: 'btn btn-primary',
              type: 'button',
              id: 'confirmTransferBtn',
              disabled: state.busy,
              text: state.busy ? 'Signing…' : 'Sign & send',
              onClick: () => { void confirmAndRelayTransfer(); },
            }),
          ]),
        ]),
      ]),
    ]);
  }

  const nextOts = readNextOts(wallet.ots);
  const toInput = el('input', {
    id: 'toAddress',
    className: 'input input-bordered w-full native-mono',
    placeholder: 'Q…',
    autocomplete: 'off',
  });
  const amountInput = el('input', {
    id: 'amount',
    className: 'input input-bordered w-full',
    type: 'number',
    min: '0',
    step: '0.000000001',
    placeholder: '0.0',
  });
  const feeInput = el('input', {
    id: 'fee',
    className: 'input input-bordered w-full',
    type: 'number',
    min: '0',
    step: '0.000000001',
    value: '0.001',
  });
  const otsInput = el('input', {
    id: 'otsKey',
    className: 'input input-bordered w-full',
    type: 'number',
    min: '0',
    step: '1',
    value: nextOts != null ? String(nextOts) : '0',
  });

  return el('section', { className: 'space-y-6' }, [
    el('div', { className: 'space-y-2' }, [
      el('h1', { className: 'text-3xl font-bold', text: 'Transfer' }),
      el('p', { className: 'native-mono text-sm text-base-content/70', text: wallet.address }),
    ]),
    el('div', { className: 'card-gradient' }, [
      el('div', { className: 'card-body gap-4' }, [
        el('fieldset', { className: 'fieldset' }, [
          el('legend', { className: 'fieldset-legend', text: 'Destination' }),
          toInput,
        ]),
        el('fieldset', { className: 'fieldset' }, [
          el('legend', { className: 'fieldset-legend', text: 'Amount (Quanta)' }),
          amountInput,
        ]),
        el('fieldset', { className: 'fieldset' }, [
          el('legend', { className: 'fieldset-legend', text: 'Fee (Quanta)' }),
          feeInput,
        ]),
        el('fieldset', { className: 'fieldset' }, [
          el('legend', { className: 'fieldset-legend', text: 'OTS key index' }),
          otsInput,
        ]),
        el('p', {
          className: 'text-sm text-base-content/60',
          text: 'Prepared on the node, signed in this process with XMSS, then pushed over the loopback API.',
        }),
        el('div', { className: 'card-actions justify-between' }, [
          el('button', {
            className: 'btn btn-ghost',
            type: 'button',
            onClick: () => {
              state.view = 'wallet';
              render();
            },
          }, ['Back']),
          el('button', {
            className: 'btn btn-primary',
            type: 'button',
            id: 'prepareTransferBtn',
            disabled: state.busy,
            text: state.busy ? 'Preparing…' : 'Prepare',
            onClick: async () => {
              const to = toInput.value.trim();
              const amountQuanta = Number(amountInput.value);
              const feeQuanta = Number(feeInput.value);
              const otsIndex = Number(otsInput.value);
              if (!isValidQrlAddress(to)) {
                setError('Destination must be a QRL address (Q + 78 hex chars)');
                return;
              }
              if (!(amountQuanta > 0)) {
                setError('Enter a positive amount');
                return;
              }
              if (!Number.isInteger(otsIndex) || otsIndex < 0) {
                setError('OTS index must be a non-negative integer');
                return;
              }
              const totalSigs = totalSignaturesForHeight(wallet.height || 10);
              const parsed = wallet.ots ? parseOtsBitfield(wallet.ots, totalSigs) : { keys: {} };
              if (otsIndexUsed(parsed.keys, otsIndex)) {
                setError(`OTS key ${otsIndex} appears used. Choosing a used key can permanently damage the wallet.`);
                return;
              }
              setBusy(true);
              setError('');
              try {
                await waitForQrllib();
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
                state.transferDraft = {
                  to,
                  amountQuanta,
                  feeQuanta,
                  amountShor,
                  feeShor,
                  otsIndex,
                  prepared,
                };
                render();
              } catch (error) {
                setError(error.message || String(error));
              } finally {
                setBusy(false);
              }
            },
          }),
        ]),
      ]),
    ]),
  ]);
}

async function confirmAndRelayTransfer() {
  const wallet = state.wallet;
  const draft = state.transferDraft;
  if (!wallet || !draft) return;

  setBusy(true);
  setError('');
  try {
    await waitForQrllib();
    const xmss = ensureXmssFromWallet(wallet);
    const signed = signTransferTransaction(xmss, draft.prepared, draft.otsIndex);
    const pushed = await api('pushTransaction', {
      network: state.network,
      transaction_signed: signed.signedTx,
    });
    const txnHash = (pushed && pushed.tx_hash) || signed.txnHash;
    state.transferResult = {
      txnHash,
      signature: signed.signatureHex,
      relayed: pushed && pushed.relayed,
    };
    state.transferDraft = null;
    render();
  } catch (error) {
    setError(error.message || String(error));
  } finally {
    setBusy(false);
  }
}

function renderReceive() {
  const wallet = state.wallet;
  if (!wallet) {
    state.view = 'home';
    return renderHome();
  }

  const qrWrap = el('div', {
    id: 'receiveQr',
    className: 'bg-white rounded-lg p-3 inline-block min-h-40 min-w-40 flex items-center justify-center',
  }, [
    state.wallet.receiveQrSvg
      ? el('div', { html: state.wallet.receiveQrSvg })
      : el('span', { className: 'loading loading-spinner loading-md text-primary' }),
  ]);

  return el('section', { className: 'space-y-6' }, [
    el('div', { className: 'space-y-2' }, [
      el('h1', { className: 'text-3xl font-bold', text: 'Receive' }),
      el('p', { className: 'text-base-content/70', text: 'Share this address to receive Quanta.' }),
    ]),
    el('div', { className: 'card-gradient' }, [
      el('div', { className: 'card-body items-center text-center gap-4' }, [
        qrWrap,
        el('p', { className: 'native-mono text-sm break-all', text: wallet.address }),
        el('div', { className: 'card-actions' }, [
          el('button', {
            className: 'btn btn-ghost',
            type: 'button',
            text: 'Back',
            onClick: () => {
              state.view = 'wallet';
              render();
            },
          }),
        ]),
      ]),
    ]),
  ]);
}

async function loadReceiveQr() {
  if (!state.wallet) return;
  try {
    const result = await api('qrSvg', { text: state.wallet.address });
    state.wallet.receiveQrSvg = result.svg;
    if (state.view === 'receive') render();
  } catch (error) {
    setError(error.message || String(error));
  }
}

function renderHistory() {
  const wallet = state.wallet;
  if (!wallet) {
    state.view = 'home';
    return renderHome();
  }

  const rows = (state.history && state.history.transactions_detail) || [];
  const list = rows.length
    ? el('div', { className: 'space-y-2' }, rows.map((item) => {
      const tx = item.transaction || item;
      const hash = tx.tx && (tx.tx.transaction_hash || tx.tx.tx_hash);
      const type = (tx.tx && tx.tx.transactionType) || (tx.tx && Object.keys(tx.tx).find((k) => !['public_key', 'signature', 'transaction_hash', 'fee', 'nonce', 'master_addr'].includes(k))) || 'tx';
      return el('div', {
        className: 'border border-base-content/10 rounded-lg p-3 bg-base-100/40',
      }, [
        el('p', { className: 'text-xs uppercase tracking-wide text-base-content/50', text: String(type) }),
        el('p', {
          className: 'native-mono text-xs break-all',
          text: hash ? String(hash) : JSON.stringify(tx).slice(0, 120),
        }),
      ]);
    }))
    : el('p', {
      className: 'text-sm text-base-content/60',
      text: state.history ? 'No transactions found for this address.' : 'Loading…',
    });

  return el('section', { className: 'space-y-6' }, [
    el('div', { className: 'space-y-2' }, [
      el('h1', { className: 'text-3xl font-bold', text: 'History' }),
      el('p', { className: 'text-base-content/70', text: 'Recent transactions for this address.' }),
    ]),
    el('div', { className: 'card-gradient' }, [
      el('div', { className: 'card-body gap-3' }, [
        list,
        el('div', { className: 'card-actions justify-between' }, [
          el('button', {
            className: 'btn btn-ghost',
            type: 'button',
            text: 'Back',
            onClick: () => {
              state.view = 'wallet';
              render();
            },
          }),
          el('button', {
            className: 'btn btn-outline',
            type: 'button',
            disabled: state.busy,
            text: 'Reload',
            onClick: () => { void loadHistory(); },
          }),
        ]),
      ]),
    ]),
  ]);
}

async function loadHistory() {
  if (!state.wallet) return;
  setBusy(true);
  try {
    state.history = await api('getTransactionsByAddress', {
      network: state.network,
      address: state.wallet.address,
      item_per_page: 10,
      page_number: 1,
    });
    if (state.view === 'history') render();
  } catch (error) {
    setError(error.message || String(error));
  } finally {
    setBusy(false);
  }
}

function renderOts() {
  const wallet = state.wallet;
  if (!wallet) {
    state.view = 'home';
    return renderHome();
  }
  const totalSigs = totalSignaturesForHeight(wallet.height || 10);
  const parsed = wallet.otsTracker || (wallet.ots ? parseOtsBitfield(wallet.ots, totalSigs) : null);
  const cells = [];
  if (parsed) {
    const show = Math.min(totalSigs, 256);
    for (let i = 0; i < show; i += 1) {
      const used = otsIndexUsed(parsed.keys, i);
      cells.push(el('div', {
        className: `w-3 h-3 rounded-sm ${used ? 'bg-error' : 'bg-success/70'}`,
        title: `OTS ${i}: ${used ? 'used' : 'free'}`,
      }));
    }
  }

  return el('section', { className: 'space-y-6' }, [
    el('div', { className: 'space-y-2' }, [
      el('h1', { className: 'text-3xl font-bold', text: 'OTS key tracker' }),
      el('p', {
        className: 'text-base-content/70',
        text: parsed
          ? `Next unused: ${parsed.nextKey ?? '—'} · Remaining (sampled): ${otsKeysRemaining(parsed.keys, Math.min(totalSigs, 256))} of first ${Math.min(totalSigs, 256)}`
          : 'Loading OTS bitfield…',
      }),
    ]),
    el('div', { className: 'card-gradient' }, [
      el('div', { className: 'card-body gap-4' }, [
        el('div', { className: 'flex flex-wrap gap-1 max-w-xl' }, cells.length ? cells : [
          el('span', { className: 'loading loading-spinner text-primary' }),
        ]),
        el('p', { className: 'text-xs text-base-content/50', text: 'Green = unused · Red = used' }),
        el('div', { className: 'card-actions justify-between' }, [
          el('button', {
            className: 'btn btn-ghost',
            type: 'button',
            text: 'Back',
            onClick: () => { state.view = 'wallet'; render(); },
          }),
          el('button', {
            className: 'btn btn-outline',
            type: 'button',
            text: 'Reload',
            onClick: () => { void loadOtsTracker(); },
          }),
        ]),
      ]),
    ]),
  ]);
}

async function loadOtsTracker() {
  if (!state.wallet) return;
  setBusy(true);
  try {
    const totalSigs = totalSignaturesForHeight(state.wallet.height || 10);
    const pagesNeeded = Math.max(1, Math.ceil(Math.min(totalSigs, 1024) / 64));
    const ots = await api('getOTS', {
      network: state.network,
      address: state.wallet.address,
      page_from: 1,
      page_count: pagesNeeded,
      unused_ots_index_from: 0,
    });
    state.wallet.ots = ots;
    state.wallet.otsTracker = parseOtsBitfield(ots, totalSigs);
    if (state.view === 'ots') render();
  } catch (error) {
    setError(error.message || String(error));
  } finally {
    setBusy(false);
  }
}

function renderTools() {
  if (!state.wallet) {
    state.view = 'home';
    return renderHome();
  }
  const tools = [
    { id: 'message', title: 'Message', desc: 'Embed up to 80 bytes on-chain', view: 'message' },
    { id: 'notarise', title: 'Notarise', desc: 'Anchor a document hash on-chain', view: 'notarise' },
    { id: 'recovery', title: 'Recovery seed', desc: 'View mnemonic, hexseed, and QR', view: 'recovery' },
    { id: 'verify', title: 'Verify TX', desc: 'Look up a transaction hash', view: 'verify' },
    { id: 'ots', title: 'OTS tracker', desc: 'Inspect used one-time keys', view: 'ots' },
    { id: 'tokens', title: 'Tokens', desc: 'Balances, create, and transfer', view: 'tokens' },
  ];
  return el('section', { className: 'space-y-6' }, [
    el('div', { className: 'space-y-2' }, [
      el('h1', { className: 'text-3xl font-bold', text: 'Tools' }),
      el('p', { className: 'text-base-content/70', text: 'Seed-wallet utilities for this native client.' }),
    ]),
    el('div', { className: 'grid gap-3 sm:grid-cols-2' }, tools.map((tool) => el('button', {
      className: 'card-gradient text-left p-4 hover:border-primary/40 transition-colors',
      type: 'button',
      onClick: () => {
        state.view = tool.view;
        state.error = '';
        if (tool.view === 'notarise') {
          state.notariseDraft = null;
          state.notariseResult = null;
        }
        render();
        if (tool.view === 'ots') void loadOtsTracker();
        if (tool.view === 'recovery') void loadRecoveryQr();
        if (tool.view === 'tokens') void loadTokens();
      },
    }, [
      el('h3', { className: 'font-bold', text: tool.title }),
      el('p', { className: 'text-sm text-base-content/60', text: tool.desc }),
    ]))),
    el('button', {
      className: 'btn btn-ghost',
      type: 'button',
      text: 'Back',
      onClick: () => { state.view = 'wallet'; render(); },
    }),
  ]);
}

function renderRecovery() {
  const wallet = state.wallet;
  if (!wallet) {
    state.view = 'home';
    return renderHome();
  }
  return el('section', { className: 'space-y-6' }, [
    el('div', { className: 'space-y-2' }, [
      el('h1', { className: 'text-3xl font-bold', text: 'Recovery seed' }),
      el('p', { className: 'text-warning text-sm', text: 'Anyone with this seed can spend your funds. Keep it offline.' }),
    ]),
    el('div', { className: 'card-gradient' }, [
      el('div', { className: 'card-body gap-4' }, [
        el('div', {
          id: 'recoveryQr',
          className: 'bg-white rounded-lg p-3 self-start',
        }, [
          wallet.recoveryQrSvg
            ? el('div', { html: wallet.recoveryQrSvg })
            : el('span', { className: 'loading loading-spinner text-primary' }),
        ]),
        el('div', {}, [
          el('p', { className: 'text-xs uppercase text-base-content/50', text: 'Mnemonic' }),
          el('p', { className: 'native-mono text-sm', text: wallet.mnemonic }),
        ]),
        el('div', {}, [
          el('p', { className: 'text-xs uppercase text-base-content/50', text: 'Hexseed' }),
          el('p', { className: 'native-mono text-xs break-all', text: wallet.hexseed }),
        ]),
        el('button', {
          className: 'btn btn-ghost self-start',
          type: 'button',
          text: 'Back',
          onClick: () => { state.view = 'tools'; render(); },
        }),
      ]),
    ]),
  ]);
}

async function loadRecoveryQr() {
  if (!state.wallet) return;
  try {
    const result = await api('qrSvg', { text: state.wallet.hexseed || state.wallet.address });
    state.wallet.recoveryQrSvg = result.svg;
    if (state.view === 'recovery') render();
  } catch (error) {
    setError(error.message || String(error));
  }
}

function renderMessage() {
  const wallet = state.wallet;
  if (!wallet) {
    state.view = 'home';
    return renderHome();
  }
  if (state.messageResult) {
    return el('section', { className: 'space-y-6' }, [
      el('h1', { className: 'text-3xl font-bold', text: 'Message sent' }),
      el('p', { className: 'native-mono text-sm break-all', id: 'messageTxHash', text: state.messageResult.txnHash }),
      el('button', {
        className: 'btn btn-primary',
        type: 'button',
        text: 'Back to tools',
        onClick: () => { state.messageResult = null; state.view = 'tools'; render(); },
      }),
    ]);
  }

  const msgInput = el('textarea', {
    id: 'messageBody',
    className: 'textarea textarea-bordered w-full',
    maxlength: '80',
    placeholder: 'Up to 80 bytes',
  });
  const feeInput = el('input', {
    id: 'messageFee',
    className: 'input input-bordered w-full',
    type: 'number',
    min: '0',
    step: '0.000000001',
    value: '0.001',
  });
  const nextOts = readNextOts(wallet.ots);
  const otsInput = el('input', {
    id: 'messageOts',
    className: 'input input-bordered w-full',
    type: 'number',
    min: '0',
    value: nextOts != null ? String(nextOts) : '0',
  });

  return el('section', { className: 'space-y-6' }, [
    el('div', { className: 'space-y-2' }, [
      el('h1', { className: 'text-3xl font-bold', text: 'On-chain message' }),
      el('p', { className: 'text-base-content/70', text: 'Create, sign, and relay a message transaction (≤80 bytes).' }),
    ]),
    el('div', { className: 'card-gradient' }, [
      el('div', { className: 'card-body gap-4' }, [
        el('fieldset', { className: 'fieldset' }, [
          el('legend', { className: 'fieldset-legend', text: 'Message' }),
          msgInput,
        ]),
        el('fieldset', { className: 'fieldset' }, [
          el('legend', { className: 'fieldset-legend', text: 'Fee (Quanta)' }),
          feeInput,
        ]),
        el('fieldset', { className: 'fieldset' }, [
          el('legend', { className: 'fieldset-legend', text: 'OTS key' }),
          otsInput,
        ]),
        el('div', { className: 'card-actions justify-between' }, [
          el('button', {
            className: 'btn btn-ghost',
            type: 'button',
            text: 'Back',
            onClick: () => { state.view = 'tools'; render(); },
          }),
          el('button', {
            className: 'btn btn-primary',
            type: 'button',
            disabled: state.busy,
            text: state.busy ? 'Sending…' : 'Sign & send',
            onClick: async () => {
              const text = msgInput.value;
              const bytes = new TextEncoder().encode(text);
              if (!text || bytes.length === 0 || bytes.length > 80) {
                setError('Message must be 1–80 bytes');
                return;
              }
              const feeQuanta = Number(feeInput.value);
              const otsIndex = Number(otsInput.value);
              const totalSigs = totalSignaturesForHeight(wallet.height || 10);
              const parsed = wallet.ots ? parseOtsBitfield(wallet.ots, totalSigs) : { keys: {} };
              if (otsIndexUsed(parsed.keys, otsIndex)) {
                setError(`OTS key ${otsIndex} appears used`);
                return;
              }
              setBusy(true);
              setError('');
              try {
                await waitForQrllib();
                const prepared = await api('createMessageTxn', {
                  network: state.network,
                  message: Array.from(bytes),
                  fee: Math.round(feeQuanta * SHOR_PER_QUANTA),
                  xmss_pk: wallet.pk,
                });
                const xmss = ensureXmssFromWallet(wallet);
                const signed = signMessageTransaction(xmss, prepared, otsIndex);
                const pushed = await api('pushTransaction', {
                  network: state.network,
                  transaction_signed: signed.signedTx,
                });
                state.messageResult = {
                  txnHash: (pushed && pushed.tx_hash) || signed.txnHash,
                };
                render();
              } catch (error) {
                setError(error.message || String(error));
              } finally {
                setBusy(false);
              }
            },
          }),
        ]),
      ]),
    ]),
  ]);
}

function renderNotarise() {
  const wallet = state.wallet;
  if (!wallet) {
    state.view = 'home';
    return renderHome();
  }

  if (state.notariseResult) {
    const result = state.notariseResult;
    return el('section', { className: 'space-y-6' }, [
      el('h1', { className: 'text-3xl font-bold', text: 'Document notarised' }),
      el('div', { className: 'card-gradient' }, [
        el('div', { className: 'card-body gap-3' }, [
          el('p', { className: 'text-xs uppercase text-base-content/50', text: 'Transaction' }),
          el('p', { className: 'native-mono text-sm break-all', id: 'notariseTxHash', text: result.txnHash }),
          el('p', { text: `File: ${result.fileName}` }),
          el('p', { className: 'native-mono text-xs break-all', text: `SHA256: ${result.fileHash}` }),
          result.additionalText
            ? el('p', { text: `Note: ${result.additionalText}` })
            : null,
          el('button', {
            className: 'btn btn-primary self-start',
            type: 'button',
            text: 'Back to tools',
            onClick: () => {
              state.notariseResult = null;
              state.notariseDraft = null;
              state.view = 'tools';
              render();
            },
          }),
        ]),
      ]),
    ]);
  }

  if (state.notariseDraft && state.notariseDraft.prepared) {
    const draft = state.notariseDraft;
    return el('section', { className: 'space-y-6' }, [
      el('h1', { className: 'text-3xl font-bold', text: 'Confirm notarisation' }),
      el('div', { className: 'card-gradient' }, [
        el('div', { className: 'card-body gap-2' }, [
          el('p', { text: `File: ${draft.fileName}` }),
          el('p', { className: 'native-mono text-xs break-all', text: `SHA256: ${draft.fileHash}` }),
          el('p', { text: `Hash function: ${draft.hashFunction}` }),
          draft.additionalText
            ? el('p', { text: `Additional text: ${draft.additionalText}` })
            : el('p', { className: 'text-base-content/60', text: 'No additional text' }),
          el('p', { className: 'native-mono text-xs break-all', text: `Message hex: ${draft.messageHex}` }),
          el('p', { text: `Fee: ${draft.feeQuanta} Quanta` }),
          el('p', { text: `OTS: ${draft.otsIndex}` }),
          el('div', { className: 'card-actions justify-between mt-2' }, [
            el('button', {
              className: 'btn btn-ghost',
              type: 'button',
              text: 'Back',
              onClick: () => { state.notariseDraft = null; render(); },
            }),
            el('button', {
              id: 'confirmNotariseBtn',
              className: 'btn btn-primary',
              type: 'button',
              disabled: state.busy,
              text: state.busy ? 'Signing…' : 'Sign & notarise',
              onClick: () => { void confirmNotarise(); },
            }),
          ]),
        ]),
      ]),
    ]);
  }

  const nextOts = readNextOts(wallet.ots);
  const fileInput = el('input', {
    id: 'notaryDocument',
    className: 'file-input file-input-bordered w-full',
    type: 'file',
  });
  const noteInput = el('input', {
    id: 'notaryAdditionalText',
    className: 'input input-bordered w-full',
    maxlength: String(NOTARISE_SHA256_ADDITIONAL_MAX),
    placeholder: `Optional note (max ${NOTARISE_SHA256_ADDITIONAL_MAX} bytes)`,
  });
  const feeInput = el('input', {
    id: 'notaryFee',
    className: 'input input-bordered w-full',
    type: 'number',
    min: '0',
    step: '0.000000001',
    value: '0.001',
  });
  const otsInput = el('input', {
    id: 'notaryOts',
    className: 'input input-bordered w-full',
    type: 'number',
    min: '0',
    value: nextOts != null ? String(nextOts) : '0',
  });

  return el('section', { className: 'space-y-6' }, [
    el('div', { className: 'space-y-2' }, [
      el('h1', { className: 'text-3xl font-bold', text: 'Notarise document' }),
      el('p', {
        className: 'text-base-content/70',
        text: 'Stores a SHA-256 hash of your file on-chain (Meteor-compatible AFAFA encoding). The file itself is not uploaded.',
      }),
    ]),
    el('div', { className: 'card-gradient' }, [
      el('div', { className: 'card-body gap-4' }, [
        el('fieldset', { className: 'fieldset' }, [
          el('legend', { className: 'fieldset-legend', text: 'Document' }),
          fileInput,
        ]),
        el('fieldset', { className: 'fieldset' }, [
          el('legend', { className: 'fieldset-legend', text: 'Hash function' }),
          el('input', {
            className: 'input input-bordered w-full',
            value: 'SHA256',
            disabled: true,
            id: 'notaryHashFunction',
          }),
        ]),
        el('fieldset', { className: 'fieldset' }, [
          el('legend', { className: 'fieldset-legend', text: 'Additional text' }),
          noteInput,
        ]),
        el('fieldset', { className: 'fieldset' }, [
          el('legend', { className: 'fieldset-legend', text: 'Fee (Quanta)' }),
          feeInput,
        ]),
        el('fieldset', { className: 'fieldset' }, [
          el('legend', { className: 'fieldset-legend', text: 'OTS key' }),
          otsInput,
        ]),
        el('div', { className: 'card-actions justify-between' }, [
          el('button', {
            className: 'btn btn-ghost',
            type: 'button',
            text: 'Back',
            onClick: () => { state.view = 'tools'; render(); },
          }),
          el('button', {
            id: 'prepareNotariseBtn',
            className: 'btn btn-primary',
            type: 'button',
            disabled: state.busy,
            text: state.busy ? 'Preparing…' : 'Prepare',
            onClick: async () => {
              const file = fileInput.files && fileInput.files[0];
              if (!file) {
                setError('Select a document to notarise');
                return;
              }
              const additionalText = noteInput.value || '';
              const feeQuanta = Number(feeInput.value);
              const otsIndex = Number(otsInput.value);
              const totalSigs = totalSignaturesForHeight(wallet.height || 10);
              const parsed = wallet.ots ? parseOtsBitfield(wallet.ots, totalSigs) : { keys: {} };
              if (otsIndexUsed(parsed.keys, otsIndex)) {
                setError(`OTS key ${otsIndex} appears used`);
                return;
              }
              setBusy(true);
              setError('');
              try {
                const buffer = await file.arrayBuffer();
                const fileHash = await sha256HexOfArrayBuffer(buffer);
                const messageHex = buildNotarisationHex({
                  fileHashHex: fileHash,
                  additionalText,
                  hashFunction: 'SHA256',
                });
                const messageBytes = notarisationHexToMessageBytes(messageHex);
                const prepared = await api('createMessageTxn', {
                  network: state.network,
                  message: Array.from(messageBytes),
                  fee: Math.round(feeQuanta * SHOR_PER_QUANTA),
                  xmss_pk: wallet.pk,
                });
                state.notariseDraft = {
                  prepared,
                  fileName: file.name,
                  fileHash,
                  hashFunction: 'SHA256',
                  additionalText,
                  messageHex,
                  feeQuanta,
                  otsIndex,
                };
                render();
              } catch (error) {
                setError(error.message || String(error));
              } finally {
                setBusy(false);
              }
            },
          }),
        ]),
      ]),
    ]),
  ]);
}

async function confirmNotarise() {
  const wallet = state.wallet;
  const draft = state.notariseDraft;
  if (!wallet || !draft || !draft.prepared) return;
  setBusy(true);
  setError('');
  try {
    await waitForQrllib();
    const xmss = ensureXmssFromWallet(wallet);
    const signed = signMessageTransaction(xmss, draft.prepared, draft.otsIndex);
    const pushed = await api('pushTransaction', {
      network: state.network,
      transaction_signed: signed.signedTx,
    });
    state.notariseResult = {
      txnHash: (pushed && pushed.tx_hash) || signed.txnHash,
      fileName: draft.fileName,
      fileHash: draft.fileHash,
      additionalText: draft.additionalText,
    };
    state.notariseDraft = null;
    render();
  } catch (error) {
    setError(error.message || String(error));
  } finally {
    setBusy(false);
  }
}

async function loadTokens() {
  if (!state.wallet) return;
  try {
    const result = await api('getTokensByAddress', {
      network: state.network,
      address: state.wallet.address,
    });
    state.tokens = (result && result.tokens) || [];
    if (state.view === 'tokens' || state.view === 'token-transfer') render();
  } catch (error) {
    setError(error.message || String(error));
  }
}

function renderTokens() {
  const wallet = state.wallet;
  if (!wallet) {
    state.view = 'home';
    return renderHome();
  }
  const list = state.tokens;
  const fungible = (list || []).filter((t) => !t.is_nft);
  const rows = fungible.map((token) => el('tr', {}, [
    el('td', { className: 'font-semibold', text: token.symbol || '—' }),
    el('td', { text: token.name || '—' }),
    el('td', { className: 'native-mono', text: token.balance_display != null ? String(token.balance_display) : token.balance }),
    el('td', {}, [
      el('button', {
        className: 'btn btn-xs btn-outline',
        type: 'button',
        text: 'Send',
        onClick: () => {
          state.view = 'token-transfer';
          state.tokenTransferDraft = { token };
          state.tokenTransferResult = null;
          state.error = '';
          render();
        },
      }),
    ]),
  ]));

  return el('section', { className: 'space-y-6' }, [
    el('div', { className: 'space-y-2' }, [
      el('h1', { className: 'text-3xl font-bold', text: 'Tokens' }),
      el('p', { className: 'text-base-content/70', text: 'Fungible token balances for this address.' }),
    ]),
    el('div', { className: 'flex flex-wrap gap-2' }, [
      el('button', {
        className: 'btn btn-primary btn-sm',
        type: 'button',
        text: 'Create token',
        onClick: () => {
          state.view = 'token-create';
          state.tokenCreateDraft = null;
          state.tokenCreateResult = null;
          state.error = '';
          render();
        },
      }),
      el('button', {
        className: 'btn btn-outline btn-sm',
        type: 'button',
        disabled: state.busy,
        text: 'Refresh',
        onClick: () => { void loadTokens(); },
      }),
      el('button', {
        className: 'btn btn-ghost btn-sm',
        type: 'button',
        text: 'Back',
        onClick: () => { state.view = 'wallet'; render(); },
      }),
    ]),
    !list
      ? el('p', { className: 'text-base-content/60', text: 'Loading…' })
      : fungible.length === 0
        ? el('p', { className: 'text-base-content/60', text: 'No tokens held on this address.' })
        : el('div', { className: 'overflow-x-auto card-gradient' }, [
          el('table', { className: 'table table-sm', id: 'tokenBalancesTable' }, [
            el('thead', {}, [
              el('tr', {}, [
                el('th', { text: 'Symbol' }),
                el('th', { text: 'Name' }),
                el('th', { text: 'Balance' }),
                el('th', { text: '' }),
              ]),
            ]),
            el('tbody', {}, rows),
          ]),
        ]),
  ]);
}

function renderTokenCreate() {
  const wallet = state.wallet;
  if (!wallet) {
    state.view = 'home';
    return renderHome();
  }

  if (state.tokenCreateResult) {
    return el('section', { className: 'space-y-6' }, [
      el('h1', { className: 'text-3xl font-bold', text: 'Token created' }),
      el('p', { className: 'native-mono text-sm break-all', id: 'tokenCreateTxHash', text: state.tokenCreateResult.txnHash }),
      el('button', {
        className: 'btn btn-primary',
        type: 'button',
        text: 'Back to tokens',
        onClick: () => {
          state.tokenCreateResult = null;
          state.tokenCreateDraft = null;
          state.view = 'tokens';
          render();
          void loadTokens();
        },
      }),
    ]);
  }

  if (state.tokenCreateDraft && state.tokenCreateDraft.prepared) {
    const draft = state.tokenCreateDraft;
    return el('section', { className: 'space-y-6' }, [
      el('h1', { className: 'text-3xl font-bold', text: 'Confirm token create' }),
      el('div', { className: 'card-gradient' }, [
        el('div', { className: 'card-body gap-2' }, [
          el('p', { text: `Symbol: ${draft.symbol}` }),
          el('p', { text: `Name: ${draft.name}` }),
          el('p', { text: `Decimals: ${draft.decimals}` }),
          el('p', { text: `Initial supply (units): ${draft.supplyDisplay}` }),
          el('p', { text: `Fee: ${draft.feeQuanta} Quanta` }),
          el('p', { text: `OTS: ${draft.otsIndex}` }),
          el('div', { className: 'card-actions justify-between mt-2' }, [
            el('button', {
              className: 'btn btn-ghost',
              type: 'button',
              text: 'Back',
              onClick: () => { state.tokenCreateDraft = null; render(); },
            }),
            el('button', {
              id: 'confirmTokenCreateBtn',
              className: 'btn btn-primary',
              type: 'button',
              disabled: state.busy,
              text: state.busy ? 'Signing…' : 'Sign & create',
              onClick: () => { void confirmTokenCreate(); },
            }),
          ]),
        ]),
      ]),
    ]);
  }

  const nextOts = readNextOts(wallet.ots);
  const symbolInput = el('input', { id: 'tokenSymbol', className: 'input input-bordered w-full', maxlength: '10', placeholder: 'SYM' });
  const nameInput = el('input', { id: 'tokenName', className: 'input input-bordered w-full', maxlength: '32', placeholder: 'Token name' });
  const decimalsInput = el('input', { id: 'tokenDecimals', className: 'input input-bordered w-full', type: 'number', min: '0', max: '19', value: '0' });
  const supplyInput = el('input', { id: 'tokenSupply', className: 'input input-bordered w-full', type: 'number', min: '1', step: '1', value: '1000' });
  const feeInput = el('input', { id: 'tokenCreateFee', className: 'input input-bordered w-full', type: 'number', min: '0', step: '0.000000001', value: '0.01' });
  const otsInput = el('input', { id: 'tokenCreateOts', className: 'input input-bordered w-full', type: 'number', min: '0', value: nextOts != null ? String(nextOts) : '0' });

  return el('section', { className: 'space-y-6' }, [
    el('div', { className: 'space-y-2' }, [
      el('h1', { className: 'text-3xl font-bold', text: 'Create token' }),
      el('p', { className: 'text-base-content/70', text: 'Mint a fungible token with initial balance to this wallet.' }),
    ]),
    el('div', { className: 'card-gradient' }, [
      el('div', { className: 'card-body gap-4' }, [
        el('fieldset', { className: 'fieldset' }, [el('legend', { className: 'fieldset-legend', text: 'Symbol' }), symbolInput]),
        el('fieldset', { className: 'fieldset' }, [el('legend', { className: 'fieldset-legend', text: 'Name' }), nameInput]),
        el('fieldset', { className: 'fieldset' }, [el('legend', { className: 'fieldset-legend', text: 'Decimals' }), decimalsInput]),
        el('fieldset', { className: 'fieldset' }, [el('legend', { className: 'fieldset-legend', text: 'Initial supply' }), supplyInput]),
        el('fieldset', { className: 'fieldset' }, [el('legend', { className: 'fieldset-legend', text: 'Fee (Quanta)' }), feeInput]),
        el('fieldset', { className: 'fieldset' }, [el('legend', { className: 'fieldset-legend', text: 'OTS key' }), otsInput]),
        el('div', { className: 'card-actions justify-between' }, [
          el('button', {
            className: 'btn btn-ghost',
            type: 'button',
            text: 'Back',
            onClick: () => { state.view = 'tokens'; render(); },
          }),
          el('button', {
            id: 'prepareTokenCreateBtn',
            className: 'btn btn-primary',
            type: 'button',
            disabled: state.busy,
            text: state.busy ? 'Preparing…' : 'Prepare',
            onClick: async () => {
              const symbol = symbolInput.value.trim();
              const name = nameInput.value.trim();
              const decimals = Number(decimalsInput.value);
              const supply = Number(supplyInput.value);
              const feeQuanta = Number(feeInput.value);
              const otsIndex = Number(otsInput.value);
              if (!symbol || !name) {
                setError('Symbol and name are required');
                return;
              }
              if (!Number.isInteger(decimals) || decimals < 0 || decimals > 19) {
                setError('Decimals must be an integer 0–19');
                return;
              }
              if (!Number.isFinite(supply) || supply <= 0) {
                setError('Supply must be positive');
                return;
              }
              const amountUnits = Math.round(supply * (10 ** decimals));
              if (!Number.isSafeInteger(amountUnits) || amountUnits <= 0) {
                setError('Supply × 10^decimals exceeds safe integer range');
                return;
              }
              const totalSigs = totalSignaturesForHeight(wallet.height || 10);
              const parsed = wallet.ots ? parseOtsBitfield(wallet.ots, totalSigs) : { keys: {} };
              if (otsIndexUsed(parsed.keys, otsIndex)) {
                setError(`OTS key ${otsIndex} appears used`);
                return;
              }
              setBusy(true);
              setError('');
              try {
                const prepared = await api('createTokenTxn', {
                  network: state.network,
                  symbol: Array.from(new TextEncoder().encode(symbol)),
                  name: Array.from(new TextEncoder().encode(name)),
                  owner: wallet.address,
                  decimals,
                  initial_balances: [{ address: wallet.address, amount: amountUnits }],
                  fee: Math.round(feeQuanta * SHOR_PER_QUANTA),
                  xmss_pk: wallet.pk,
                });
                state.tokenCreateDraft = {
                  prepared,
                  symbol,
                  name,
                  decimals,
                  supplyDisplay: supply,
                  feeQuanta,
                  otsIndex,
                };
                render();
              } catch (error) {
                setError(error.message || String(error));
              } finally {
                setBusy(false);
              }
            },
          }),
        ]),
      ]),
    ]),
  ]);
}

async function confirmTokenCreate() {
  const wallet = state.wallet;
  const draft = state.tokenCreateDraft;
  if (!wallet || !draft || !draft.prepared) return;
  setBusy(true);
  setError('');
  try {
    await waitForQrllib();
    const xmss = ensureXmssFromWallet(wallet);
    const signed = signTokenCreateTransaction(xmss, draft.prepared, draft.otsIndex);
    const pushed = await api('pushTransaction', {
      network: state.network,
      transaction_signed: signed.signedTx,
    });
    state.tokenCreateResult = {
      txnHash: (pushed && pushed.tx_hash) || signed.txnHash,
    };
    state.tokenCreateDraft = null;
    render();
  } catch (error) {
    setError(error.message || String(error));
  } finally {
    setBusy(false);
  }
}

function renderTokenTransfer() {
  const wallet = state.wallet;
  if (!wallet) {
    state.view = 'home';
    return renderHome();
  }

  if (state.tokenTransferResult) {
    return el('section', { className: 'space-y-6' }, [
      el('h1', { className: 'text-3xl font-bold', text: 'Token sent' }),
      el('p', { className: 'native-mono text-sm break-all', id: 'tokenTransferTxHash', text: state.tokenTransferResult.txnHash }),
      el('button', {
        className: 'btn btn-primary',
        type: 'button',
        text: 'Back to tokens',
        onClick: () => {
          state.tokenTransferResult = null;
          state.tokenTransferDraft = null;
          state.view = 'tokens';
          render();
          void loadTokens();
        },
      }),
    ]);
  }

  const draft = state.tokenTransferDraft || {};
  const token = draft.token;
  if (!token) {
    state.view = 'tokens';
    return renderTokens();
  }

  if (draft.prepared) {
    return el('section', { className: 'space-y-6' }, [
      el('h1', { className: 'text-3xl font-bold', text: 'Confirm token transfer' }),
      el('div', { className: 'card-gradient' }, [
        el('div', { className: 'card-body gap-2' }, [
          el('p', { text: `Token: ${token.symbol || token.hash}` }),
          el('p', { className: 'native-mono text-xs break-all', text: `To: ${draft.toAddress}` }),
          el('p', { text: `Amount: ${draft.amountDisplay}` }),
          el('p', { text: `Fee: ${draft.feeQuanta} Quanta` }),
          el('p', { text: `OTS: ${draft.otsIndex}` }),
          el('div', { className: 'card-actions justify-between mt-2' }, [
            el('button', {
              className: 'btn btn-ghost',
              type: 'button',
              text: 'Back',
              onClick: () => {
                state.tokenTransferDraft = { token };
                render();
              },
            }),
            el('button', {
              id: 'confirmTokenTransferBtn',
              className: 'btn btn-primary',
              type: 'button',
              disabled: state.busy,
              text: state.busy ? 'Signing…' : 'Sign & send',
              onClick: () => { void confirmTokenTransfer(); },
            }),
          ]),
        ]),
      ]),
    ]);
  }

  const nextOts = readNextOts(wallet.ots);
  const toInput = el('input', {
    id: 'tokenToAddress',
    className: 'input input-bordered w-full native-mono',
    placeholder: 'Q…',
    value: wallet.address,
  });
  const amountInput = el('input', {
    id: 'tokenAmount',
    className: 'input input-bordered w-full',
    type: 'number',
    min: '0',
    step: 'any',
    value: '1',
  });
  const feeInput = el('input', {
    id: 'tokenTransferFee',
    className: 'input input-bordered w-full',
    type: 'number',
    min: '0',
    step: '0.000000001',
    value: '0.001',
  });
  const otsInput = el('input', {
    id: 'tokenTransferOts',
    className: 'input input-bordered w-full',
    type: 'number',
    min: '0',
    value: nextOts != null ? String(nextOts) : '0',
  });

  return el('section', { className: 'space-y-6' }, [
    el('div', { className: 'space-y-2' }, [
      el('h1', { className: 'text-3xl font-bold', text: 'Transfer token' }),
      el('p', { className: 'text-base-content/70', text: `${token.symbol || 'Token'} · balance ${token.balance_display != null ? token.balance_display : token.balance}` }),
    ]),
    el('div', { className: 'card-gradient' }, [
      el('div', { className: 'card-body gap-4' }, [
        el('fieldset', { className: 'fieldset' }, [el('legend', { className: 'fieldset-legend', text: 'Recipient' }), toInput]),
        el('fieldset', { className: 'fieldset' }, [el('legend', { className: 'fieldset-legend', text: 'Amount' }), amountInput]),
        el('fieldset', { className: 'fieldset' }, [el('legend', { className: 'fieldset-legend', text: 'Fee (Quanta)' }), feeInput]),
        el('fieldset', { className: 'fieldset' }, [el('legend', { className: 'fieldset-legend', text: 'OTS key' }), otsInput]),
        el('div', { className: 'card-actions justify-between' }, [
          el('button', {
            className: 'btn btn-ghost',
            type: 'button',
            text: 'Back',
            onClick: () => { state.view = 'tokens'; state.tokenTransferDraft = null; render(); },
          }),
          el('button', {
            id: 'prepareTokenTransferBtn',
            className: 'btn btn-primary',
            type: 'button',
            disabled: state.busy,
            text: state.busy ? 'Preparing…' : 'Prepare',
            onClick: async () => {
              const toAddress = toInput.value.trim();
              const amountDisplay = Number(amountInput.value);
              const feeQuanta = Number(feeInput.value);
              const otsIndex = Number(otsInput.value);
              const decimals = Number(token.decimals || 0);
              if (!/^Q[0-9a-fA-F]{78}$/.test(toAddress)) {
                setError('Recipient must be a Q + 78 hex address');
                return;
              }
              if (!Number.isFinite(amountDisplay) || amountDisplay <= 0) {
                setError('Amount must be positive');
                return;
              }
              const amountUnits = Math.round(amountDisplay * (10 ** decimals));
              if (!Number.isSafeInteger(amountUnits) || amountUnits <= 0) {
                setError('Amount exceeds safe integer precision');
                return;
              }
              const totalSigs = totalSignaturesForHeight(wallet.height || 10);
              const parsed = wallet.ots ? parseOtsBitfield(wallet.ots, totalSigs) : { keys: {} };
              if (otsIndexUsed(parsed.keys, otsIndex)) {
                setError(`OTS key ${otsIndex} appears used`);
                return;
              }
              setBusy(true);
              setError('');
              try {
                const prepared = await api('transferTokenTxn', {
                  network: state.network,
                  addresses_to: [toAddress],
                  amounts: [amountUnits],
                  token_txhash: token.hash,
                  fee: Math.round(feeQuanta * SHOR_PER_QUANTA),
                  xmss_pk: wallet.pk,
                });
                state.tokenTransferDraft = {
                  token,
                  prepared,
                  toAddress,
                  amountDisplay,
                  feeQuanta,
                  otsIndex,
                };
                render();
              } catch (error) {
                setError(error.message || String(error));
              } finally {
                setBusy(false);
              }
            },
          }),
        ]),
      ]),
    ]),
  ]);
}

async function confirmTokenTransfer() {
  const wallet = state.wallet;
  const draft = state.tokenTransferDraft;
  if (!wallet || !draft || !draft.prepared) return;
  setBusy(true);
  setError('');
  try {
    await waitForQrllib();
    const xmss = ensureXmssFromWallet(wallet);
    const signed = signTokenTransferTransaction(xmss, draft.prepared, draft.otsIndex);
    const pushed = await api('pushTransaction', {
      network: state.network,
      transaction_signed: signed.signedTx,
    });
    state.tokenTransferResult = {
      txnHash: (pushed && pushed.tx_hash) || signed.txnHash,
    };
    state.tokenTransferDraft = null;
    render();
  } catch (error) {
    setError(error.message || String(error));
  } finally {
    setBusy(false);
  }
}

function renderVerify() {
  const hashInput = el('input', {
    id: 'verifyTxHash',
    className: 'input input-bordered w-full native-mono',
    placeholder: '64-character transaction hash',
    autocomplete: 'off',
  });

  const detail = state.verifyResult
    ? el('pre', {
      className: 'native-mono text-xs whitespace-pre-wrap break-all bg-base-100/50 rounded-lg p-3 max-h-96 overflow-auto',
      text: JSON.stringify(state.verifyResult, null, 2),
    })
    : null;

  return el('section', { className: 'space-y-6' }, [
    el('div', { className: 'space-y-2' }, [
      el('h1', { className: 'text-3xl font-bold', text: 'Verify transaction' }),
      el('p', { className: 'text-base-content/70', text: 'Look up a transaction by hash on the selected network.' }),
    ]),
    el('div', { className: 'card-gradient' }, [
      el('div', { className: 'card-body gap-4' }, [
        el('fieldset', { className: 'fieldset' }, [
          el('legend', { className: 'fieldset-legend', text: 'Transaction hash' }),
          hashInput,
        ]),
        detail,
        el('div', { className: 'card-actions justify-between' }, [
          el('button', {
            className: 'btn btn-ghost',
            type: 'button',
            text: 'Back',
            onClick: () => {
              state.view = state.wallet ? 'wallet' : 'home';
              state.verifyResult = null;
              render();
            },
          }),
          el('button', {
            className: 'btn btn-primary',
            type: 'button',
            disabled: state.busy,
            text: state.busy ? 'Looking up…' : 'Lookup',
            onClick: async () => {
              const hash = hashInput.value.trim().replace(/^0x/i, '');
              if (!/^[0-9a-fA-F]{64}$/.test(hash)) {
                setError('Enter a 64-character hex transaction hash');
                return;
              }
              setBusy(true);
              setError('');
              try {
                state.verifyResult = await api('getTxnHash', {
                  network: state.network,
                  txhash: hash,
                });
                render();
              } catch (error) {
                setError(error.message || String(error));
              } finally {
                setBusy(false);
              }
            },
          }),
        ]),
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
      page_from: 1,
      page_count: 1,
      unused_ots_index_from: 0,
    }).catch((error) => {
      console.error('getOTS failed', error);
      return null;
    }),
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
  else if (state.view === 'generating') view = renderGenerating();
  else if (state.view === 'backup') view = renderBackup();
  else if (state.view === 'wallet') view = renderWallet();
  else if (state.view === 'transfer') view = renderTransfer();
  else if (state.view === 'receive') view = renderReceive();
  else if (state.view === 'history') view = renderHistory();
  else if (state.view === 'ots') view = renderOts();
  else if (state.view === 'tools') view = renderTools();
  else if (state.view === 'recovery') view = renderRecovery();
  else if (state.view === 'message') view = renderMessage();
  else if (state.view === 'notarise') view = renderNotarise();
  else if (state.view === 'tokens') view = renderTokens();
  else if (state.view === 'token-create') view = renderTokenCreate();
  else if (state.view === 'token-transfer') view = renderTokenTransfer();
  else if (state.view === 'verify') view = renderVerify();
  else view = renderHome();

  root.appendChild(view);
  if (state.error) {
    root.appendChild(el('div', {
      role: 'alert',
      className: 'alert alert-error mt-4',
    }, [
      icon(['M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z'], 'stroke-current shrink-0 h-6 w-6'),
      el('span', { text: state.error }),
    ]));
  } else if (state.success) {
    root.appendChild(el('div', {
      role: 'alert',
      className: 'alert alert-success mt-4',
    }, [
      el('span', { text: state.success }),
    ]));
  }
}

async function bootstrap() {
  window.__QRL_NATIVE_DESKTOP__ = true;
  render();

  const badge = document.getElementById('connectionBadge');
  const networkSelect = document.getElementById('networkSelect');
  const brandHome = document.getElementById('brandHome');
  const footerVersion = document.getElementById('footerVersion');
  const explorerLink = document.getElementById('explorerLink');

  try {
    const health = await fetch('/api/health').then((r) => r.json());
    if (!health.ok) throw new Error('Backend unhealthy');
    if (footerVersion) {
      footerVersion.textContent = `QRL Wallet v${health.version || ''}`;
    }

    if (brandHome) {
      brandHome.addEventListener('click', () => {
        state.view = state.wallet ? 'wallet' : 'home';
        state.error = '';
        render();
      });
    }

    state.networks = await api('networks');
    networkSelect.replaceChildren();
    for (const network of state.networks) {
      networkSelect.appendChild(el('option', {
        value: network.id,
        text: network.name,
        selected: network.id === state.network,
      }));
    }
    const syncExplorer = () => {
      const selected = state.networks.find((n) => n.id === state.network);
      if (explorerLink && selected && selected.explorerUrl) {
        explorerLink.href = selected.explorerUrl;
        explorerLink.textContent = `${selected.name} explorer`;
      }
    };
    syncExplorer();
    networkSelect.addEventListener('change', async () => {
      state.network = networkSelect.value;
      syncExplorer();
      await refreshConnection();
      if (state.wallet) {
        await refreshWallet();
      }
    });

    await refreshConnection();
    badge.textContent = 'connected';
    badge.className = 'badge badge-success badge-sm';
  } catch (error) {
    badge.textContent = 'offline';
    badge.className = 'badge badge-error badge-sm';
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

window.addEventListener('beforeunload', () => {
  stopGenerationWorker();
});

bootstrap();
