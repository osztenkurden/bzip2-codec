import { lookup } from 'node:dns/promises';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { Readable } from 'node:stream';

export const fetchIPv4 = async (url: string, signal: AbortSignal) => {
	const original = new URL(url);
	if (original.protocol !== 'http:' && original.protocol !== 'https:') {
		throw new Error('Demo URL must use HTTP or HTTPS');
	}
	signal.throwIfAborted();
	if (typeof Bun === 'undefined') {
		// Request the original hostname so HTTPS keeps its SNI and certificate identity.
		return new Promise<Response>((resolve, reject) => {
			const get = original.protocol === 'https:' ? httpsGet : httpGet;
			get(original, { family: 4, signal, headers: { 'Accept-Encoding': 'identity' } }, response => {
				const headers = new Headers();
				for (const [key, value] of Object.entries(response.headers)) {
					if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
				}
				const status = response.statusCode!;
				const noBody = [204, 205, 304].includes(status);
				if (noBody) response.resume();
				resolve(
					new Response(noBody ? null : (Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>), {
						status,
						headers
					})
				);
			}).once('error', reject);
		});
	}
	const { address } = await lookup(original.hostname, { family: 4 });
	signal.throwIfAborted();
	const target = new URL(original);
	target.hostname = address;
	// Connect directly over IPv4, but preserve HTTP routing and TLS identity.
	return fetch(target, {
		signal,
		redirect: 'manual',
		proxy: '',
		headers: { Host: original.host, 'Accept-Encoding': 'identity' },
		decompress: false,
		tls: original.protocol === 'https:' ? { serverName: original.hostname, rejectUnauthorized: true } : undefined
	});
};
