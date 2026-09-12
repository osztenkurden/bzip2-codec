import { lookup } from 'node:dns/promises';

export const fetchIPv4 = async (url: string, signal: AbortSignal) => {
	const original = new URL(url);
	if (original.protocol !== 'http:' && original.protocol !== 'https:') {
		throw new Error('Demo URL must use HTTP or HTTPS');
	}
	signal.throwIfAborted();
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
