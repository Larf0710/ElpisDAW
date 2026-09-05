export const ELPISDAW_PORTABLE_PACKAGE_POLICY_VERSION =
  '2026-09-05-node-24.20.0-stability-product-use-v1';

export const ELPISDAW_PORTABLE_PACKAGE = Object.freeze({
  manifestVersion: 1,
  platform: 'windows-x64',
  product: 'ElpisDAW',
  version: '0.1.0-preview.1',
});

export const ELPISDAW_NODE_RUNTIME = Object.freeze({
  archiveFileName: 'node-v24.20.0-win-x64.zip',
  archiveRootName: 'node-v24.20.0-win-x64',
  archiveSha256:
    '6cac9ffbca8f6a47091e4b5c772e0606049c3871cb67d900c0cedde630e545ba',
  nodeSha256:
    '5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5',
  releasePageUrl: 'https://nodejs.org/en/blog/release/v24.20.0',
  sourceUrl:
    'https://nodejs.org/dist/v24.20.0/node-v24.20.0-win-x64.zip',
  version: '24.20.0',
});

export const ELPISDAW_STABILITY_AI_PRODUCT_USE = Object.freeze({
  acceptableUsePolicyUrl: 'https://stability.ai/use-policy',
  agreementSha256:
    'd6f6b1a4dce5c852bd6d7d9482d002baf0ccdb71e662250b73be9eec8764ee8d',
  agreementSourceUrl:
    'https://huggingface.co/stabilityai/stable-audio-3-medium/blob/27b5a21b791b1b033d193a9e1e3ce78493f102f9/LICENSE.md',
  attributionText: 'Powered by Stability AI',
  commercialRegistrationStatus: 'NOT_VERIFIED',
  commercialRegistrationUrl: 'https://stability.ai/community-license',
  noticeText:
    'This Stability AI Model is licensed under the Stability AI Community License, Copyright © Stability AI Ltd. All Rights Reserved',
});

export const ELPISDAW_BUNDLED_JAVASCRIPT_COMPONENTS = Object.freeze([
  Object.freeze({
    license: 'MIT',
    licenseSha256:
      '52412d7bc7ce4157ea628bbaacb8829e0a9cb3c58f57f99176126bc8cf2bfc85',
    name: 'react',
    purl: 'pkg:npm/react@18.3.1',
    version: '18.3.1',
  }),
  Object.freeze({
    license: 'MIT',
    licenseSha256:
      '52412d7bc7ce4157ea628bbaacb8829e0a9cb3c58f57f99176126bc8cf2bfc85',
    name: 'react-dom',
    purl: 'pkg:npm/react-dom@18.3.1',
    version: '18.3.1',
  }),
  Object.freeze({
    license: 'MIT',
    licenseSha256:
      '52412d7bc7ce4157ea628bbaacb8829e0a9cb3c58f57f99176126bc8cf2bfc85',
    name: 'scheduler',
    purl: 'pkg:npm/scheduler@0.23.2',
    version: '0.23.2',
  }),
]);
