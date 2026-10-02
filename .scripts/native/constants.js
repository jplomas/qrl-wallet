const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const NATIVE_ROOT = path.join(PROJECT_ROOT, 'native');
const BACKEND_ROOT = path.join(NATIVE_ROOT, 'backend');
const UI_ROOT = path.join(NATIVE_ROOT, 'ui');
const DIST_ROOT = path.join(PROJECT_ROOT, '.native', '.dist');
const PROTO_DIR = path.join(PROJECT_ROOT, 'private');

const DESKTOP_USER_AGENT_TOKEN = 'QRLWallet-Native';

function desktopUserAgent(version, platform) {
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) ${DESKTOP_USER_AGENT_TOKEN}/${version} Safari/537.36`;
}

module.exports = {
  PROJECT_ROOT,
  NATIVE_ROOT,
  BACKEND_ROOT,
  UI_ROOT,
  DIST_ROOT,
  PROTO_DIR,
  DESKTOP_USER_AGENT_TOKEN,
  desktopUserAgent,
  DEFAULT_HOST: '127.0.0.1',
  DEFAULT_PORT: 51888,
};
