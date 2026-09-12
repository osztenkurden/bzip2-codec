import { decodeStandaloneBlock } from '../codec/decoder.ts';
import { startWorker } from './worker-runtime.ts';

startWorker(decodeStandaloneBlock);
