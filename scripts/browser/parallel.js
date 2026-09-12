import { compress, createDecompressionStream } from '../../dist/index.mjs';

const check = (condition, message) => {
	if (!condition) throw new Error(message);
};

try {
	const created = new Set();
	const revoked = new Set();
	const create = URL.createObjectURL.bind(URL);
	const revoke = URL.revokeObjectURL.bind(URL);
	URL.createObjectURL = blob => {
		const url = create(blob);
		created.add(url);
		return url;
	};
	URL.revokeObjectURL = url => {
		revoked.add(url);
		revoke(url);
	};
	const original = new Uint8Array(350_000);
	for (let index = 0; index < original.length; index++) original[index] = (index * 31 + (index >>> 8) * 17) & 255;
	const encoded = compress(original, { blockSize: 1 });
	let offset = 0;
	await new ReadableStream({
		start(controller) {
			controller.enqueue(encoded);
			controller.close();
		}
	})
		.pipeThrough(createDecompressionStream({ concurrency: 3 }))
		.pipeTo(
			new WritableStream({
				write(chunk) {
					for (const byte of chunk) check(byte === original[offset++], 'Decoded output differs');
				}
			})
		);
	check(offset === original.length, 'Output length differs');
	check(created.size > 0, 'No Blob worker was created');
	check(
		[...created].every(url => revoked.has(url)),
		'Worker Blob URL leaked'
	);
	await fetch('/result', {
		method: 'POST',
		body: JSON.stringify({ ok: true, workers: created.size, bytes: offset })
	});
} catch (error) {
	await fetch('/result', { method: 'POST', body: JSON.stringify({ ok: false, error: String(error) }) });
}
