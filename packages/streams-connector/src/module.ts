import { Abstract, DynamicModule, Type } from "@nestjs/common";
import { RedisConnection } from "./connection";
import { StreamsConnectorOptions } from "./options";
import { StreamsService } from "./service";

export interface StreamsConnectorModuleAsyncOptions {
	useFactory: (
		...args: unknown[]
	) => StreamsConnectorOptions | Promise<StreamsConnectorOptions>;
	inject?: Array<Type<unknown> | Abstract<unknown>>;
}

export class StreamsConnectorModule {
	static registerAsync(
		options: StreamsConnectorModuleAsyncOptions,
	): DynamicModule {
		return {
			module: StreamsConnectorModule,
			providers: [
				{
					provide: StreamsConnectorOptions,
					useFactory: options.useFactory,
					inject: options.inject,
				},
				RedisConnection,
				StreamsService,
			],
		};
	}
}
