import { createServer } from 'node:http';

import { describe, expect, it } from 'vitest';

import {
  classifyAudioFileDeletion,
  settleProjectSave,
} from '../src/clipTakeDeletionTransaction.ts';
import { LocalEngineClient } from '../src/localEngineClient.ts';
import {
  commitSessionEdit,
  createSessionEditHistory,
  undoSessionEdit,
} from '../src/sessionEditHistory.ts';

const intendedProjectFile = {
  app: 'HumSTUDIO',
  savedAt: '2026-08-08T06:00:00.000Z',
  version: '0.1.0',
  workspace: {
    project: { artifacts: [], name: 'Deletion Safety' },
    selectedClipId: 'clip-a',
  },
};

describe('Clip Take deletion transaction response-loss integration', () => {
  it('confirms a durable save after the HTTP success response is lost', async () => {
    let persistedProjectFile;
    let server;

    try {
      server = createServer((request, response) => {
        if (request.method === 'PUT') {
          void readRequestJson(request).then((projectFile) => {
            persistedProjectFile = projectFile;
            request.socket.destroy();
          });
          return;
        }

        if (request.method === 'GET' && persistedProjectFile) {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(
            JSON.stringify({
              bytesRead: 512,
              lastModifiedAt: '2026-08-08T06:00:01.000Z',
              projectFile: persistedProjectFile,
              projectFileName: 'Deletion Safety.humstudio.json',
              projectFilePath: 'D:\\Projects\\Deletion Safety.humstudio.json',
              savedAt: intendedProjectFile.savedAt,
              status: 'LOADED',
            }),
          );
          return;
        }

        response.writeHead(404).end();
      });
      const client = new LocalEngineClient({
        baseUrl: await listen(server),
        token: 'project-save-response-loss-test-token-0001',
      });
      const saveResult = await client.saveProjectFile(intendedProjectFile);

      expect(saveResult).toMatchObject({ ok: false, reason: 'offline' });
      await expect(
        settleProjectSave(
          intendedProjectFile,
          saveResult,
          () => client.loadProjectFile(),
        ),
      ).resolves.toMatchObject({
        confirmation: 'readback',
        status: 'CONFIRMED',
      });
    } finally {
      await closeServer(server);
    }
  });

  it('blocks Undo when the delete side effect completes before socket loss', async () => {
    let deletionSideEffectCompleted = false;
    let server;

    try {
      server = createServer((request) => {
        request.resume();
        request.on('end', () => {
          deletionSideEffectCompleted = true;
          request.socket.destroy();
        });
      });
      const client = new LocalEngineClient({
        baseUrl: await listen(server),
        token: 'audio-delete-response-loss-test-token-001',
      });
      const result = await client.deleteAudioArtifactFile({
        artifactId: 'artifact-response-loss',
        extension: '.wav',
        name: 'artifact-response-loss.wav',
        relativePath: 'renders/instruments/artifact-response-loss.wav',
        sizeBytes: 512,
        storageKind: 'generated',
      });

      expect(deletionSideEffectCompleted).toBe(true);
      expect(result).toMatchObject({ ok: false, reason: 'offline' });
      const settlement = classifyAudioFileDeletion(result);
      expect(settlement).toMatchObject({
        fileDisposition: 'unknown',
        irreversible: true,
      });
      const history = createSessionEditHistory(
        { targetTakePresent: true },
        {
          category: 'system',
          createdAt: '2026-08-08T06:00:00.000Z',
          id: 'initial',
          label: 'Initial state',
        },
      );
      const committed = commitSessionEdit(
        history,
        { targetTakePresent: false },
        {
          category: 'take',
          createdAt: '2026-08-08T06:00:01.000Z',
          id: 'response-loss',
          irreversible: settlement.irreversible,
          label: 'Audio deletion outcome unknown',
        },
        80,
      );

      expect(undoSessionEdit(committed).status).toBe(
        'IRREVERSIBLE_BOUNDARY',
      );
    } finally {
      await closeServer(server);
    }
  });
});

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();

  if (!address || typeof address === 'string') {
    throw new Error('Test server did not expose a TCP port.');
  }

  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server) {
  await new Promise((resolve) => server?.close(() => resolve()) ?? resolve());
}

async function readRequestJson(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
