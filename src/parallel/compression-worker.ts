// Keep the entry JavaScript-compatible: Node Web Workers strip types only in imports.
import { start } from './compression-worker-main.ts';

start();
