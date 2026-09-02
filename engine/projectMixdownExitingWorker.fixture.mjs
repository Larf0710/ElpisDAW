import { parentPort } from 'node:worker_threads';

if (!parentPort) {
  throw new Error('Exiting Project Mixdown test Worker requires a parent port.');
}

parentPort.once('message', () => {
  process.exitCode = 7;
  parentPort.close();
});
