import { Module } from "@nestjs/common";
import { BulleeConfig } from "./config";
import { BulleeService } from "./service";

@Module({
	providers: [BulleeConfig, BulleeService],
	exports: [BulleeService],
})
export class BulleeModule {
	static forRoot(config: ConstructorParameters<typeof BulleeConfig>[0]) {
		return {
			module: BulleeModule,
			providers: [
				{
					provide: BulleeConfig,
					useFactory: () => new BulleeConfig(config),
				},
			],
		};
	}
}
