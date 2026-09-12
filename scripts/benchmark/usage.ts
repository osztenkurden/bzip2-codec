export const usage = (value: Bun.ResourceUsage | undefined) =>
	value && {
		cpuMs: {
			user: Number(value.cpuTime.user) / 1000,
			system: Number(value.cpuTime.system) / 1000,
			total: Number(value.cpuTime.total) / 1000
		},
		peakRssBytes: value.maxRSS,
		contextSwitches: value.contextSwitches,
		ioOperations: value.ops
	};
