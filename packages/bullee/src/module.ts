import {
	DynamicModule,
	FactoryProvider,
	Module,
	ModuleMetadata,
} from "@nestjs/common";
import { EventEmitterModule } from "@nestjs/event-emitter";
import { BulleeService } from "./service";
import { BulleeServiceConfig } from "./service.config";

type BulleeModuleOptions = Pick<ModuleMetadata, "imports"> &
	Pick<FactoryProvider<BulleeServiceConfig>, "inject" | "useFactory">;

@Module({
	imports: [EventEmitterModule],
	providers: [BulleeServiceConfig, BulleeService],
	exports: [BulleeService],
})
export class BulleeModule {
	static forRootAsync({
		imports,
		inject,
		useFactory,
	}: BulleeModuleOptions): DynamicModule {
		return {
			module: BulleeModule,
			imports,
			providers: [{ provide: BulleeServiceConfig, inject, useFactory }],
		};
	}
}
