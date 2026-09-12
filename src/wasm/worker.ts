import { startWorker } from '../parallel/worker-runtime.ts';
import { decodeStandaloneBlock } from './decoder.ts';

startWorker(decodeStandaloneBlock);
