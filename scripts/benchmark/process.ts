import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';

// Keep Bun's native resource measurements when running under Bun.
export const spawnProcess = (
	args: string[],
	options: { cwd?: string; stdin?: 'pipe'; stdout: 'pipe'; stderr: 'pipe' }
) => {
	if (typeof Bun !== 'undefined') return Bun.spawn(args, { ...options, stdin: 'pipe' });
	const child = spawn(args[0]!, args.slice(1), { cwd: options.cwd, stdio: 'pipe' });
	const exited = new Promise<number>((resolve, reject) => {
		child.once('error', reject);
		child.once('close', code => resolve(code ?? 1));
	});
	const writer = Writable.toWeb(child.stdin).getWriter();
	return {
		stdin: {
			write: (chunk: string | Uint8Array) => writer.write(chunk),
			flush: async () => {},
			end: () => writer.close()
		},
		stdout: Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
		stderr: Readable.toWeb(child.stderr) as unknown as ReadableStream<Uint8Array>,
		exited,
		get exitCode() {
			return child.exitCode;
		},
		kill: () => child.kill('SIGKILL'),
		resourceUsage: () => undefined
	};
};
