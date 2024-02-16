import { Throughput } from "@joaofnds/throughput";
import {
	Injectable,
	Logger,
	OnApplicationBootstrap,
	OnApplicationShutdown,
} from "@nestjs/common";
import { ClientClosedError } from "redis";
import { RedisConnection } from "./connection";
import { StreamsConnectorOptions } from "./options";
import { Message } from "./types";

@Injectable()
export class StreamsService
	implements OnApplicationBootstrap, OnApplicationShutdown
{
	private readonly PAYLOAD_KEY = "payload";
	private readonly logger = new Logger(StreamsService.name);
	private readonly throughput = new Throughput();
	private reclaimIntervalID?: NodeJS.Timeout;

	constructor(
		private readonly connection: RedisConnection,
		private readonly options: StreamsConnectorOptions,
	) {}

	async onApplicationBootstrap() {
		for (const stream of this.options.streams) {
			await this.createGroupIfNotExists(stream);
		}
		this.throughput.start();
		this.writeEmittedEvents();

		this.listen().catch((error) => {
			if (error instanceof ClientClosedError) return;

			this.logger.error(error);
		});

		this.reclaimIntervalID = setInterval(() => {
			this.reclaim().catch((error) => {
				if (error instanceof ClientClosedError) return;

				this.logger.error(error);
			});
		}, this.options.reclaim.interval);
	}

	onApplicationShutdown() {
		clearInterval(this.reclaimIntervalID);
		this.throughput.stop();
	}

	private async listen() {
		while (true) {
			const response = await this.connection.readClient.xReadGroup(
				this.options.stream.group,
				this.options.stream.consumer,
				this.options.streams.map((key) => ({ key, id: ">" })),
				{ BLOCK: this.options.stream.readTimeout, COUNT: 1 },
			);

			if (!response) continue;

			for (const msg of response) {
				this.throughput.hit();
				const { stream, messageID, message } = this.parseXReadGroupMessage(msg);
				this.process(stream, messageID, message);
			}
		}
	}

	private shouldReclaim(): boolean {
		return (
			this.throughput.perSecond() < this.options.reclaim.throughputThreshold
		);
	}

	private async reclaim() {
		if (!this.shouldReclaim()) return;

		for (const stream of this.options.streams) {
			const claim = await this.connection.reclaimClient.xAutoClaim(
				stream,
				this.options.stream.group,
				this.options.stream.consumer,
				this.options.reclaim.minIdleTime,
				"0",
				{ COUNT: this.options.reclaim.count },
			);

			for (const rawMessage of claim.messages) {
				if (rawMessage === null) continue;
				const { messageID, message } = this.parseMessage(rawMessage);
				const isDead = await this.handleDead(stream, messageID, message);
				if (!isDead) this.process(stream, messageID, message);
			}
		}
	}

	async handleDead(stream: string, messageID: string, message: string) {
		const pending = await this.connection.reclaimClient.xPendingRange(
			stream,
			this.options.stream.group,
			messageID,
			messageID,
			1,
		);

		if (pending[0].deliveriesCounter < this.options.reclaim.maxDeliveries)
			return false;

		await Promise.allSettled([
			this.connection.reclaimClient.xAck(
				stream,
				this.options.stream.group,
				messageID,
			),

			this.connection.reclaimClient.xAdd(
				this.deadLetterFor(stream),
				messageID,
				{ [this.PAYLOAD_KEY]: message },
				{
					TRIM: {
						strategy: "MAXLEN",
						strategyModifier: "~",
						threshold: this.options.stream.deadMaxLen,
					},
				},
			),

			this.options.eventEmitter.emitAsync(this.deadLetterFor(stream), {
				stream,
				messageID,
				message,
			}),
		]);

		return true;
	}

	private writeEmittedEvents() {
		for (const event of this.options.sendEvents) {
			this.options.eventEmitter.on(event.name, (eventData) =>
				this.connection.writeClient.xAdd(
					event.name,
					"*",
					{ [this.PAYLOAD_KEY]: event.serialize(eventData) },
					{
						TRIM: {
							strategy: "MAXLEN",
							strategyModifier: "~",
							threshold: this.options.stream.maxLen,
						},
					},
				),
			);
		}
	}

	private async process(stream: string, messageID: string, message: string) {
		try {
			const event = this.options.eventFor(stream)?.deserialize(message);
			await this.options.eventEmitter.emitAsync(stream, event);
			await this.connection.writeClient.xAck(
				stream,
				this.options.stream.group,
				messageID,
			);
		} catch (error) {
			this.logger.error("failed to process message", error);
		}
	}

	private async createGroupIfNotExists(stream: string) {
		try {
			await this.connection.writeClient.xGroupCreate(
				stream,
				this.options.stream.group,
				"$",
				{ MKSTREAM: true },
			);
			this.logger.log(
				`consumer group '${this.options.stream.group}' created on stream '${stream}'`,
			);
		} catch (error) {
			if (error instanceof Error && error.message.includes("BUSYGROUP")) {
				return;
			}

			throw error;
		}
	}

	private parseXReadGroupMessage(message: {
		name: string;
		messages: Message[];
	}) {
		return {
			stream: message.name,
			...this.parseMessage(message.messages[0]),
		};
	}

	private parseMessage(message: Message) {
		return {
			messageID: message.id,
			message: message.message[this.PAYLOAD_KEY],
		};
	}

	deadLetterFor(stream: string): string {
		return `dead:${stream}`;
	}
}
