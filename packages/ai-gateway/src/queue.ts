/**
 * A serial queue owned by a Chord resource.
 *
 * The service is rebuilt whenever the facet reloads, but this value lives on the resource
 * and therefore survives the reload. A read-modify-write in two code versions then shares
 * one ordering instead of racing two independent promise chains.
 */
export class SerialQueue {
	private tail: Promise<unknown> = Promise.resolve();

	run<T>(task: () => Promise<T>): Promise<T> {
		const next = this.tail.then(task, task);
		this.tail = next.catch(() => undefined);
		return next;
	}
}
