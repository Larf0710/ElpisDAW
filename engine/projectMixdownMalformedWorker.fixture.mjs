import { parentPort } from 'node:worker_threads';

import {
  PROJECT_MIXDOWN_WORKER_PROTOCOL_VERSION,
} from './projectMixdownWorkerProtocol.mjs';

if (!parentPort) {
  throw new Error('Malformed Project Mixdown test Worker requires a parent port.');
}

parentPort.once('message', (message) => {
  const frameCount = 1;
  const bytes = Buffer.alloc(44 + frameCount * 4);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(bytes.byteLength - 8, 4);
  bytes.write('WAVE', 8, 'ascii');
  bytes.write('JUNK', 12, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(44_100, 24);
  bytes.writeUInt32LE(176_400, 28);
  bytes.writeUInt16LE(4, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('NOPE', 36, 'ascii');
  bytes.writeUInt32LE(frameCount * 4, 40);
  const transferableBytes = Uint8Array.from(bytes);

  parentPort.postMessage(
    {
      ok: true,
      operation: message.operation,
      protocolVersion: PROJECT_MIXDOWN_WORKER_PROTOCOL_VERSION,
      requestId: message.requestId,
      result: {
        bitsPerSample: 16,
        bytes: transferableBytes,
        channels: 2,
        durationSeconds: frameCount / 44_100,
        frameCount,
        mimeType: 'audio/wav',
        sampleRate: 44_100,
      },
    },
    [transferableBytes.buffer],
  );
  parentPort.close();
});
