const TransportNodeHid = require('@ledgerhq/hw-transport-node-hid').default;
const Qrl = require('@theqrl/hw-app-qrl/lib/Qrl').default;

async function withLedger(fn) {
  const transport = await TransportNodeHid.create();
  try {
    const qrl = new Qrl(transport);
    return await fn(qrl);
  } finally {
    await transport.close().catch(() => {});
  }
}

module.exports = {
  async getState() {
    return withLedger((qrl) => qrl.get_state());
  },
  async publicKey() {
    return withLedger((qrl) => qrl.publickey());
  },
  async getVersion() {
    return withLedger((qrl) => qrl.get_version());
  },
  async verifyAddress() {
    return withLedger((qrl) => qrl.verifyAddress());
  },
};
