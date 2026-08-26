import { Topic } from "@joaofnds/flume";
import { uniqueTopic } from "@joaofnds/flume-tck";
import { JetStreamManager, jetstreamManager } from "@nats-io/jetstream";
import { NatsConnection } from "@nats-io/nats-core";
import { connect } from "@nats-io/transport-node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NatsStreamsBroker } from "../src/index";
import { STREAM, STREAM_SUBJECTS } from "../src/subject";

const NATS_URL = "nats://localhost:4223";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("NatsStreamsBroker reconnect", () => {
	const open: NatsStreamsBroker[] = [];
	let admin: NatsConnection;
	let jsm: JetStreamManager;

	beforeEach(async () => {
		admin = await connect({ servers: NATS_URL });
		jsm = await jetstreamManager(admin);
	});

	afterEach(async () => {
		await Promise.all(open.splice(0).map((broker) => broker.close()));
		await admin.close();
	});

	async function start(): Promise<NatsStreamsBroker> {
		const broker = new NatsStreamsBroker({
			nats: { servers: NATS_URL },
			ackWait: 2000,
		});
		await broker.connect();
		open.push(broker);
		return broker;
	}

	it("recreates the stream when a reconnect finds it deleted", async () => {
		const broker = await start();
		await broker.publish(new Topic(uniqueTopic()), encode("before"));
		await broker.close();
		await jsm.streams.delete(STREAM);

		await broker.connect();
		await broker.publish(new Topic(uniqueTopic()), encode("after"));

		const info = await jsm.streams.info(STREAM);
		expect(info.config.subjects).toEqual(STREAM_SUBJECTS);
	});
});
