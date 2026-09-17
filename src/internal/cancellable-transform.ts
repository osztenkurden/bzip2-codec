/**
 * Transformer.cancel is not implemented by every supported Web Streams runtime.
 * Forward through standard source/sink cancellation hooks instead. In particular,
 * the writable controller's signal fires even while a worker-backed write waits.
 */
export class CancellableTransform<I, O> extends TransformStream<I, O> {
	readonly #readable: ReadableStream<O>;
	readonly #writable: WritableStream<I>;

	constructor(transformer: Transformer<I, O>, close: () => void) {
		super(transformer);
		const reader = super.readable.getReader();
		const writer = super.writable.getWriter();
		this.#readable = new ReadableStream<O>(
			{
				async pull(controller) {
					const result = await reader.read();
					if (result.done) controller.close();
					else controller.enqueue(result.value);
				},
				cancel(reason) {
					close();
					return reader.cancel(reason);
				}
			},
			{ highWaterMark: 0 }
		);
		this.#writable = new WritableStream<I>({
			start(controller) {
				controller.signal?.addEventListener('abort', close, { once: true });
				void writer.closed.catch(error => {
					close();
					controller.error(error);
				});
			},
			write: chunk => writer.write(chunk),
			close: () => writer.close(),
			abort(reason) {
				close();
				return writer.abort(reason);
			}
		});
	}

	override get readable(): ReadableStream<O> {
		return this.#readable;
	}
	override get writable(): WritableStream<I> {
		return this.#writable;
	}
}
