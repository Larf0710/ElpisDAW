import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ProductionUiConfigurationError,
  ProductionUiFileServer,
} from './productionUiFileServer.mjs';

const runningServers = new Set();
const temporaryDirectories = new Set();

afterEach(async () => {
  await Promise.all([...runningServers].map((server) => closeServer(server)));
  runningServers.clear();
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { force: true, recursive: true })),
  );
  temporaryDirectories.clear();
});

describe('ProductionUiFileServer configuration', () => {
  it('requires an absolute existing directory containing index.html', async () => {
    await expect(ProductionUiFileServer.create({ rootPath: 'relative-ui' })).rejects.toMatchObject({
      code: 'PRODUCTION_UI_ROOT_INVALID',
      name: 'ProductionUiConfigurationError',
    });

    const rootPath = await createTemporaryDirectory();

    await expect(ProductionUiFileServer.create({ rootPath })).rejects.toEqual(
      expect.objectContaining({
        code: 'PRODUCTION_UI_INDEX_UNAVAILABLE',
        message: 'Production UI root must contain a regular index.html file.',
      }),
    );
  });

  it('rejects invalid file-size limits without exposing the root path', async () => {
    const rootPath = await createUiRoot();

    await expect(
      ProductionUiFileServer.create({ maxFileBytes: 0, rootPath }),
    ).rejects.toBeInstanceOf(ProductionUiConfigurationError);
  });
});

describe('ProductionUiFileServer responses', () => {
  it('serves index and allowlisted assets with hardened headers', async () => {
    const rootPath = await createUiRoot();
    const { baseUrl } = await startUiServer(rootPath);
    const documentResponse = await fetch(`${baseUrl}/`);
    const scriptResponse = await fetch(`${baseUrl}/assets/app.js`);
    const svgResponse = await fetch(`${baseUrl}/assets/logo.svg`);

    expect(documentResponse.status).toBe(200);
    expect(documentResponse.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(documentResponse.headers.get('x-content-type-options')).toBe('nosniff');
    expect(documentResponse.headers.get('x-frame-options')).toBe('DENY');
    expect(documentResponse.headers.get('referrer-policy')).toBe('no-referrer');
    expect(documentResponse.headers.get('content-security-policy')).toContain(
      "default-src 'self'",
    );
    await expect(documentResponse.text()).resolves.toContain('<title>ElpisDAW</title>');

    expect(scriptResponse.status).toBe(200);
    expect(scriptResponse.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    await expect(scriptResponse.text()).resolves.toBe("console.log('ElpisDAW');\n");
    expect(svgResponse.status).toBe(200);
    expect(svgResponse.headers.get('content-security-policy')).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    );
  });

  it('supports HEAD without returning a response body', async () => {
    const rootPath = await createUiRoot();
    const { baseUrl } = await startUiServer(rootPath);
    const response = await fetch(`${baseUrl}/assets/app.js`, { method: 'HEAD' });

    expect(response.status).toBe(200);
    expect(Number(response.headers.get('content-length'))).toBeGreaterThan(0);
    await expect(response.text()).resolves.toBe('');
  });

  it('falls back to index.html only for explicit HTML navigation routes', async () => {
    const rootPath = await createUiRoot();
    const { baseUrl } = await startUiServer(rootPath);
    const routeResponse = await fetch(`${baseUrl}/project/session`, {
      headers: { Accept: 'text/html,application/xhtml+xml' },
    });
    const nonNavigationResponse = await fetch(`${baseUrl}/project/session`);
    const missingAssetResponse = await fetch(`${baseUrl}/assets/missing.js`, {
      headers: { Accept: 'text/html' },
    });
    const directoryResponse = await fetch(`${baseUrl}/assets/`, {
      headers: { Accept: 'text/html' },
    });

    expect(routeResponse.status).toBe(200);
    await expect(routeResponse.text()).resolves.toContain('<title>ElpisDAW</title>');
    expect(nonNavigationResponse.status).toBe(404);
    expect(missingAssetResponse.status).toBe(404);
    expect(directoryResponse.status).toBe(404);
  });

  it('rejects unsafe paths, unsupported methods, and non-allowlisted file types', async () => {
    const rootPath = await createUiRoot();
    await writeFile(join(rootPath, 'assets', 'app.js.map'), '{}\n', 'utf8');
    const { baseUrl } = await startUiServer(rootPath);
    const unsafePathResponse = await fetch(`${baseUrl}/%5Coutside.txt`);
    const methodResponse = await fetch(`${baseUrl}/`, { method: 'POST' });
    const sourceMapResponse = await fetch(`${baseUrl}/assets/app.js.map`);

    expect(unsafePathResponse.status).toBe(400);
    await expect(unsafePathResponse.json()).resolves.toMatchObject({ code: 'UI_PATH_INVALID' });
    expect(methodResponse.status).toBe(405);
    expect(methodResponse.headers.get('allow')).toBe('GET, HEAD');
    expect(sourceMapResponse.status).toBe(415);
  });

  it('enforces the configured file-size limit before reading an asset', async () => {
    const rootPath = await createUiRoot();
    const { baseUrl } = await startUiServer(rootPath, { maxFileBytes: 20 });
    const response = await fetch(`${baseUrl}/`);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ code: 'UI_FILE_TOO_LARGE' });
  });
});

async function createUiRoot() {
  const rootPath = await createTemporaryDirectory();
  await mkdir(join(rootPath, 'assets'), { recursive: true });
  await writeFile(
    join(rootPath, 'index.html'),
    '<!doctype html><html><head><title>ElpisDAW</title></head></html>\n',
    'utf8',
  );
  await writeFile(join(rootPath, 'assets', 'app.js'), "console.log('ElpisDAW');\n", 'utf8');
  await writeFile(
    join(rootPath, 'assets', 'logo.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n',
    'utf8',
  );
  return rootPath;
}

async function createTemporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'elpisdaw-production-ui-'));
  temporaryDirectories.add(directory);
  return directory;
}

async function startUiServer(rootPath, overrides = {}) {
  const fileServer = await ProductionUiFileServer.create({ rootPath, ...overrides });
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    void fileServer.serve(request, response, requestUrl);
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  runningServers.add(server);
  const address = server.address();

  if (!address || typeof address === 'string') {
    throw new Error('Test UI server did not expose a TCP address.');
  }

  return { baseUrl: `http://127.0.0.1:${address.port}`, server };
}

function closeServer(server) {
  return new Promise((resolveClose, rejectClose) => {
    server.closeAllConnections?.();
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}
