import net from "node:net";

interface Pair {
	readonly client: net.Socket;
	readonly upstream: net.Socket;
}

// A TCP proxy in front of the shared test server that can stop forwarding on
// demand. It stalls only its own connections, so the other test files running in
// parallel against the same server are untouched.
export class StallingProxy {
	private readonly server: net.Server;
	private readonly pairs = new Set<Pair>();
	private readonly buffered: Array<() => void> = [];
	private pattern?: string;
	private stalled = false;

	private constructor(
		server: net.Server,
		private readonly upstreamHost: string,
		private readonly upstreamPort: number,
	) {
		this.server = server;
	}

	static async start(
		upstream = "redis://localhost:6381",
	): Promise<StallingProxy> {
		const url = new URL(upstream);
		const server = net.createServer();
		const proxy = new StallingProxy(
			server,
			url.hostname,
			Number(url.port || 6379),
		);
		server.on("connection", (client) => proxy.accept(client));
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		return proxy;
	}

	get url(): string {
		const address = this.server.address();
		if (address === null || typeof address === "string") {
			throw new Error("stalling proxy is not listening");
		}
		return `redis://127.0.0.1:${address.port}`;
	}

	// Arms the stall: the first client→server chunk carrying `pattern` stops
	// forwarding on every connection, including ones dialled after the stall.
	stallOn(pattern: string): void {
		this.pattern = pattern;
		this.stalled = false;
	}

	resume(): void {
		this.pattern = undefined;
		this.stalled = false;
		const pending = this.buffered.splice(0);
		for (const flush of pending) flush();
	}

	close(): void {
		this.pattern = undefined;
		this.stalled = false;
		this.buffered.length = 0;
		for (const pair of [...this.pairs]) {
			pair.client.destroy();
			pair.upstream.destroy();
		}
		this.pairs.clear();
		this.server.close();
	}

	private accept(client: net.Socket): void {
		const upstream = net.connect(this.upstreamPort, this.upstreamHost);
		const pair: Pair = { client, upstream };
		this.pairs.add(pair);

		// Without these listeners a write onto a destroyed socket is an uncaught
		// exception that kills the vitest worker.
		client.on("error", () => {});
		upstream.on("error", () => {});

		const drop = (): void => {
			this.pairs.delete(pair);
			client.destroy();
			upstream.destroy();
		};
		client.on("close", drop);
		upstream.on("close", drop);

		client.on("data", (chunk) => this.forward(chunk, upstream, true));
		upstream.on("data", (chunk) => this.forward(chunk, client, false));
	}

	private forward(
		chunk: string | Buffer,
		destination: net.Socket,
		fromClient: boolean,
	): void {
		if (fromClient && !this.stalled && this.pattern !== undefined) {
			if (String(chunk).toUpperCase().includes(this.pattern)) {
				this.stalled = true;
			}
		}

		if (!this.stalled) {
			if (!destination.destroyed) destination.write(chunk);
			return;
		}

		this.buffered.push(() => {
			if (!destination.destroyed) destination.write(chunk);
		});
	}
}
