import { createHash } from 'node:crypto';
import { open, readFile, rm } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { deflateRawSync } from 'node:zlib';

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP_VERSION_20 = 20;
const UTF8_FILE_NAME_FLAG = 0x0800;
const DEFLATE_COMPRESSION_METHOD = 8;
const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffffffff;

const CRC32_TABLE = new Uint32Array(256);

for (let index = 0; index < CRC32_TABLE.length; index += 1) {
  let value = index;

  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) !== 0
      ? 0xedb88320 ^ (value >>> 1)
      : value >>> 1;
  }

  CRC32_TABLE[index] = value >>> 0;
}

export class DeterministicZipArchiveError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DeterministicZipArchiveError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new DeterministicZipArchiveError(code, message);
}

function comparePaths(left, right) {
  return left.localeCompare(right, 'en');
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function crc32(content) {
  let value = UINT32_MAX;

  for (const byte of content) {
    value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }

  return (value ^ UINT32_MAX) >>> 0;
}

function requireUInt16(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > UINT16_MAX) {
    fail('ZIP_LIMIT_EXCEEDED', `${label} exceeds the deterministic ZIP boundary.`);
  }
}

function requireUInt32(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > UINT32_MAX) {
    fail('ZIP64_REQUIRED', `${label} requires unsupported ZIP64 output.`);
  }
}

function validateArchivePath(archivePath) {
  if (
    typeof archivePath !== 'string' ||
    archivePath.length === 0 ||
    archivePath.endsWith('/') ||
    archivePath.startsWith('/') ||
    archivePath.includes('\\') ||
    /[\u0000-\u001f\u007f]/.test(archivePath)
  ) {
    fail('INVALID_ARCHIVE_PATH', 'Deterministic ZIP entry path is invalid.');
  }

  const segments = archivePath.split('/');

  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    fail('INVALID_ARCHIVE_PATH', 'Deterministic ZIP entry path is unsafe.');
  }

  const encodedPath = Buffer.from(archivePath, 'utf8');
  requireUInt16(encodedPath.length, 'ZIP entry path');
  return encodedPath;
}

function validateEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    fail('INVALID_ZIP_ENTRIES', 'Deterministic ZIP requires at least one file.');
  }

  requireUInt16(entries.length, 'ZIP entry count');
  const checkedEntries = entries.map((entry) => {
    if (!entry || typeof entry.sourcePath !== 'string' || !isAbsolute(entry.sourcePath)) {
      fail('INVALID_SOURCE_PATH', 'Deterministic ZIP source path must be absolute.');
    }

    return {
      archivePath: entry.archivePath,
      encodedPath: validateArchivePath(entry.archivePath),
      sourcePath: entry.sourcePath,
    };
  }).sort((left, right) => comparePaths(left.archivePath, right.archivePath));

  for (let index = 1; index < checkedEntries.length; index += 1) {
    if (checkedEntries[index - 1].archivePath === checkedEntries[index].archivePath) {
      fail('DUPLICATE_ARCHIVE_PATH', 'Deterministic ZIP entry paths must be unique.');
    }
  }

  return checkedEntries;
}

async function writeBuffer(file, content, position) {
  let written = 0;

  while (written < content.length) {
    const result = await file.write(
      content,
      written,
      content.length - written,
      position + written,
    );

    if (result.bytesWritten <= 0) {
      fail('ZIP_WRITE_FAILED', 'Deterministic ZIP output stopped accepting data.');
    }

    written += result.bytesWritten;
  }

  return position + content.length;
}

function createLocalFileHeader({
  compressedSize,
  crc,
  dosDate,
  dosTime,
  pathLength,
  uncompressedSize,
}) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(LOCAL_FILE_HEADER_SIGNATURE, 0);
  header.writeUInt16LE(ZIP_VERSION_20, 4);
  header.writeUInt16LE(UTF8_FILE_NAME_FLAG, 6);
  header.writeUInt16LE(DEFLATE_COMPRESSION_METHOD, 8);
  header.writeUInt16LE(dosTime, 10);
  header.writeUInt16LE(dosDate, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(compressedSize, 18);
  header.writeUInt32LE(uncompressedSize, 22);
  header.writeUInt16LE(pathLength, 26);
  header.writeUInt16LE(0, 28);
  return header;
}

function createCentralDirectoryHeader({
  compressedSize,
  crc,
  dosDate,
  dosTime,
  localHeaderOffset,
  pathLength,
  uncompressedSize,
}) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(CENTRAL_DIRECTORY_HEADER_SIGNATURE, 0);
  header.writeUInt16LE(ZIP_VERSION_20, 4);
  header.writeUInt16LE(ZIP_VERSION_20, 6);
  header.writeUInt16LE(UTF8_FILE_NAME_FLAG, 8);
  header.writeUInt16LE(DEFLATE_COMPRESSION_METHOD, 10);
  header.writeUInt16LE(dosTime, 12);
  header.writeUInt16LE(dosDate, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(compressedSize, 20);
  header.writeUInt32LE(uncompressedSize, 24);
  header.writeUInt16LE(pathLength, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(localHeaderOffset, 42);
  return header;
}

function createEndOfCentralDirectory({
  centralDirectoryOffset,
  centralDirectorySize,
  entryCount,
}) {
  const footer = Buffer.alloc(22);
  footer.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
  footer.writeUInt16LE(0, 4);
  footer.writeUInt16LE(0, 6);
  footer.writeUInt16LE(entryCount, 8);
  footer.writeUInt16LE(entryCount, 10);
  footer.writeUInt32LE(centralDirectorySize, 12);
  footer.writeUInt32LE(centralDirectoryOffset, 16);
  footer.writeUInt16LE(0, 20);
  return footer;
}

export async function writeDeterministicZipArchive({
  compressionLevel,
  dosDate,
  dosTime,
  entries,
  outputPath,
}) {
  if (typeof outputPath !== 'string' || !isAbsolute(outputPath)) {
    fail('OUTPUT_PATH_NOT_ABSOLUTE', 'Deterministic ZIP output path must be absolute.');
  }

  if (!Number.isInteger(compressionLevel) || compressionLevel < 0 || compressionLevel > 9) {
    fail('INVALID_COMPRESSION_LEVEL', 'Deterministic ZIP compression level is invalid.');
  }

  requireUInt16(dosDate, 'ZIP DOS date');
  requireUInt16(dosTime, 'ZIP DOS time');
  const checkedEntries = validateEntries(entries);
  let output;
  let succeeded = false;

  try {
    output = await open(outputPath, 'wx');
    let position = 0;
    let payloadSizeBytes = 0;
    let compressedPayloadSizeBytes = 0;
    const centralEntries = [];

    for (const entry of checkedEntries) {
      const content = await readFile(entry.sourcePath);
      const compressed = deflateRawSync(content, { level: compressionLevel });
      requireUInt32(content.length, 'ZIP uncompressed entry size');
      requireUInt32(compressed.length, 'ZIP compressed entry size');
      requireUInt32(position, 'ZIP local header offset');
      const entryCrc32 = crc32(content);
      const localHeaderOffset = position;
      const localHeader = createLocalFileHeader({
        compressedSize: compressed.length,
        crc: entryCrc32,
        dosDate,
        dosTime,
        pathLength: entry.encodedPath.length,
        uncompressedSize: content.length,
      });
      position = await writeBuffer(output, localHeader, position);
      position = await writeBuffer(output, entry.encodedPath, position);
      position = await writeBuffer(output, compressed, position);
      payloadSizeBytes += content.length;
      compressedPayloadSizeBytes += compressed.length;
      centralEntries.push({
        compressedSize: compressed.length,
        crc: entryCrc32,
        dosDate,
        dosTime,
        encodedPath: entry.encodedPath,
        localHeaderOffset,
        uncompressedSize: content.length,
      });
    }

    const centralDirectoryOffset = position;

    for (const entry of centralEntries) {
      const centralHeader = createCentralDirectoryHeader({
        ...entry,
        pathLength: entry.encodedPath.length,
      });
      position = await writeBuffer(output, centralHeader, position);
      position = await writeBuffer(output, entry.encodedPath, position);
    }

    const centralDirectorySize = position - centralDirectoryOffset;
    requireUInt32(centralDirectoryOffset, 'ZIP central directory offset');
    requireUInt32(centralDirectorySize, 'ZIP central directory size');
    position = await writeBuffer(
      output,
      createEndOfCentralDirectory({
        centralDirectoryOffset,
        centralDirectorySize,
        entryCount: centralEntries.length,
      }),
      position,
    );
    requireUInt32(position, 'ZIP archive size');
    await output.sync();
    succeeded = true;

    return {
      archiveEntryCount: centralEntries.length,
      archiveSha256: sha256(await readFile(outputPath)),
      archiveSizeBytes: position,
      compressedPayloadSizeBytes,
      payloadSizeBytes,
    };
  } finally {
    await output?.close();

    if (!succeeded) {
      await rm(outputPath, { force: true });
    }
  }
}
