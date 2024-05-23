import { Module } from "@nestjs/common";
import { BeeConfig } from "./config";
import { BeeService } from "./service";

@Module({
	providers: [BeeConfig, BeeService],
	exports: [BeeService],
})
export class BeeModule {
	static forRoot(config: ConstructorParameters<typeof BeeConfig>[0]) {
		return {
			module: BeeModule,
			providers: [
				{
					provide: BeeConfig,
					useFactory: () => new BeeConfig(config),
				},
			],
		};
	}
}
