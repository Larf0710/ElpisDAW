import { ELPISDAW_NODE_RUNTIME } from './elpisDawPortablePackagePolicy.mjs';

export const ELPISDAW_PORTABLE_ARCHIVE_POLICY_VERSION =
  '2026-09-05-deterministic-zip-v1';

export const ELPISDAW_PORTABLE_ARCHIVE = Object.freeze({
  compression: 'deflate',
  compressionLevel: 9,
  dosDate: 0x0021,
  dosTime: 0,
  format: 'zip',
  formatVersion: 1,
  nodeSha256: ELPISDAW_NODE_RUNTIME.nodeSha256,
  nodeVersion: ELPISDAW_NODE_RUNTIME.version,
  rootDirectoryName: 'ElpisDAW',
  zlibVersion: '1.3.2.1-motley-42c2f19',
});
