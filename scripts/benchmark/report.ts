export const REPORT_INTRO = `# Decompression benchmarks

Run \`bun benchmark.ts '<archive-url>'\` to add or update this machine's CPU section.
The archive is downloaded once over IPv4 and loaded into memory before each trial.
Times include decoding, startup and output buffering; download, file reads and hash validation are excluded.
Compare sections using the same input and measurement method.
`;

/** Replace this CPU's section in place, retaining other CPUs and their order. */
export const updateCpuSection = (document: string, cpu: string, section: string): string => {
	const key = cpu.trim().toLowerCase();
	const headings = [...document.matchAll(/^## ([^\r\n]+)\r?$/gm)];
	const index = headings.findIndex(heading => heading[1]!.trim().toLowerCase() === key);
	if (index < 0) return `${document.trimEnd()}\n\n${section.trim()}\n`;
	const start = headings[index]!.index!;
	const end = headings[index + 1]?.index ?? document.length;
	return document.slice(0, start) + section.trim() + (end < document.length ? '\n\n' : '\n') + document.slice(end);
};

export const median = (values: number[]): number => {
	if (!values.length) throw new Error('Cannot compute a median without trials');
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
