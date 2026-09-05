import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';

const DEFAULT_MAX_FILE_BYTES = 32 * 1024 * 1024;
const INDEX_FILE_NAME = 'index.html';
const STATIC_CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.ttf', 'font/ttf'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);
const DOCUMENT_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self'",
  "font-src 'self' data:",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'self' blob:",
].join('; ');
const SVG_CONTENT_SECURITY_POLICY = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

export class ProductionUiConfigurationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProductionUiConfigurationError';
    this.code = code;
  }
}

export class ProductionUiFileServer {
  static async create({ maxFileBytes = DEFAULT_MAX_FILE_BYTES, rootPath } = {}) {
    if (typeof rootPath !== 'string' || !rootPath.trim() || !isAbsolute(rootPath)) {
      throw new ProductionUiConfigurationError(
        'PRODUCTION_UI_ROOT_INVALID',
        'Production UI root must be an absolute directory path.',
      );
    }

    if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0) {
      throw new ProductionUiConfigurationError(
        'PRODUCTION_UI_FILE_LIMIT_INVALID',
        'Production UI file limit must be a positive safe integer.',
      );
    }

    let canonicalRootPath;
    let rootStats;

    try {
      canonicalRootPath = await realpath(rootPath);
      rootStats = await stat(canonicalRootPath);
    } catch {
      throw new ProductionUiConfigurationError(
        'PRODUCTION_UI_ROOT_UNAVAILABLE',
        'Production UI root is unavailable.',
      );
    }

    if (!rootStats.isDirectory()) {
      throw new ProductionUiConfigurationError(
        'PRODUCTION_UI_ROOT_NOT_DIRECTORY',
        'Production UI root must be a directory.',
      );
    }

    const indexPath = await resolveCanonicalFile(canonicalRootPath, INDEX_FILE_NAME);

    if (!indexPath) {
      throw new ProductionUiConfigurationError(
        'PRODUCTION_UI_INDEX_UNAVAILABLE',
        'Production UI root must contain a regular index.html file.',
      );
    }

    return new ProductionUiFileServer({
      canonicalRootPath,
      indexPath,
      maxFileBytes,
    });
  }

  constructor({ canonicalRootPath, indexPath, maxFileBytes }) {
    this.canonicalRootPath = canonicalRootPath;
    this.indexPath = indexPath;
    this.maxFileBytes = maxFileBytes;
  }

  async serve(request, response, requestUrl) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');
      sendJson(response, 405, {
        code: 'UI_METHOD_NOT_ALLOWED',
        message: 'Production UI files support GET and HEAD only.',
      });
      return;
    }

    if (hasRequestBody(request.headers)) {
      sendJson(response, 413, {
        code: 'UI_REQUEST_BODY_REJECTED',
        message: 'Production UI file requests must not contain a body.',
      });
      return;
    }

    const decodedPath = decodeRequestPath(requestUrl.pathname);

    if (!decodedPath) {
      sendJson(response, 400, {
        code: 'UI_PATH_INVALID',
        message: 'Production UI path is invalid.',
      });
      return;
    }

    const requestedFile = await this.resolveRequestedFile(decodedPath);

    if (!requestedFile) {
      const acceptsDocument = readHeader(request.headers.accept)
        .toLowerCase()
        .split(',')
        .some((entry) => entry.trim().startsWith('text/html'));

      if (acceptsDocument && isValidUiRoute(decodedPath)) {
        await this.sendFile(request, response, this.indexPath);
        return;
      }

      sendJson(response, 404, {
        code: 'UI_FILE_NOT_FOUND',
        message: 'Production UI file was not found.',
      });
      return;
    }

    await this.sendFile(request, response, requestedFile);
  }

  async resolveRequestedFile(decodedPath) {
    if (decodedPath === '/') {
      return this.indexPath;
    }

    const segments = decodedPath.slice(1).split('/');

    if (
      segments.some(
        (segment) =>
          !segment ||
          segment === '.' ||
          segment === '..' ||
          segment.startsWith('.') ||
          segment.includes(':'),
      )
    ) {
      return undefined;
    }

    const candidatePath = resolve(this.canonicalRootPath, ...segments);

    if (!isPathInsideRoot(this.canonicalRootPath, candidatePath)) {
      return undefined;
    }

    return resolveCanonicalFile(this.canonicalRootPath, candidatePath);
  }

  async sendFile(request, response, filePath) {
    const extension = extname(filePath).toLowerCase();
    const contentType = STATIC_CONTENT_TYPES.get(extension);

    if (!contentType) {
      sendJson(response, 415, {
        code: 'UI_FILE_TYPE_UNSUPPORTED',
        message: 'Production UI file type is not supported.',
      });
      return;
    }

    let fileStats;

    try {
      fileStats = await stat(filePath);
    } catch {
      sendJson(response, 404, {
        code: 'UI_FILE_NOT_FOUND',
        message: 'Production UI file was not found.',
      });
      return;
    }

    if (fileStats.size > this.maxFileBytes) {
      sendJson(response, 413, {
        code: 'UI_FILE_TOO_LARGE',
        message: 'Production UI file exceeds the configured size limit.',
      });
      return;
    }

    let bytes;

    try {
      bytes = await readFile(filePath);
    } catch {
      sendJson(response, 500, {
        code: 'UI_FILE_READ_FAILED',
        message: 'Production UI file could not be read.',
      });
      return;
    }

    const headers = {
      'Cache-Control': 'no-store',
      'Content-Length': bytes.length,
      'Content-Type': contentType,
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    };

    if (extension === '.html') {
      headers['Content-Security-Policy'] = DOCUMENT_CONTENT_SECURITY_POLICY;
    } else if (extension === '.svg') {
      headers['Content-Security-Policy'] = SVG_CONTENT_SECURITY_POLICY;
    }

    response.writeHead(200, headers);
    response.end(request.method === 'HEAD' ? undefined : bytes);
  }
}

async function resolveCanonicalFile(canonicalRootPath, relativeOrAbsolutePath) {
  const candidatePath = resolve(canonicalRootPath, relativeOrAbsolutePath);

  if (!isPathInsideRoot(canonicalRootPath, candidatePath)) {
    return undefined;
  }

  try {
    const canonicalFilePath = await realpath(candidatePath);
    const fileStats = await stat(canonicalFilePath);

    return fileStats.isFile() && isPathInsideRoot(canonicalRootPath, canonicalFilePath)
      ? canonicalFilePath
      : undefined;
  } catch {
    return undefined;
  }
}

function decodeRequestPath(pathname) {
  try {
    const decodedPath = decodeURIComponent(pathname);

    if (
      !decodedPath.startsWith('/') ||
      decodedPath.includes('\\') ||
      decodedPath.includes('\0') ||
      decodedPath.includes('%')
    ) {
      return undefined;
    }

    return decodedPath;
  } catch {
    return undefined;
  }
}

function isPathInsideRoot(rootPath, candidatePath) {
  const relativePath = relative(rootPath, candidatePath);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function isValidUiRoute(decodedPath) {
  if (decodedPath === '/') {
    return true;
  }

  return decodedPath
    .slice(1)
    .split('/')
    .every((segment) => /^[A-Za-z0-9_-]+$/.test(segment));
}

function hasRequestBody(headers) {
  const contentLength = readHeader(headers['content-length']);
  const transferEncoding = readHeader(headers['transfer-encoding']);

  return transferEncoding !== '' || (contentLength !== '' && contentLength !== '0');
}

function readHeader(value) {
  if (Array.isArray(value)) {
    return value[0]?.trim() ?? '';
  }

  return typeof value === 'string' ? value.trim() : '';
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}
