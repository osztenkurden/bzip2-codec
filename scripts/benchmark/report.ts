export const REPORT_INTRO = `# Decompression benchmarks

Run \`bun benchmark.ts '<archive-url>'\` to add or update this machine's CPU section.
Each result measures a fresh IPv4 HTTP fetch → decoder → SHA-256 sink, with no output file.
Times include networking and hashing; compare machines only with comparable input and network conditions.
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
