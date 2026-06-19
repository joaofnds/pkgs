// Backend CPU sampling via `docker stats`, uniform across redis / nats so the
// saturation harness attributes the bottleneck without per-server stat
// backends. Client CPU is read in the orchestrator via process.cpuUsage()
// (process-wide on this platform, so it already covers the worker threads).

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const pexecFile = promisify(execFile);

export function resolveContainer(service: string): string {
	const id = execFileSync("docker", ["compose", "ps", "-q", service])
		.toString()
		.trim();
	if (id === "") {
		throw new Error(
			`no container for compose service "${service}" — is it up?`,
		);
	}
	return id;
}

// CPUPerc is "523.45%" where 100% == one core, so /100 yields cores in use.
// --no-stream samples one ~1s CPU delta on the daemon, off the event loop.
export async function sampleContainerCores(
	containerId: string,
): Promise<number> {
	const { stdout } = await pexecFile("docker", [
		"stats",
		"--no-stream",
		"--format",
		"{{.CPUPerc}}",
		containerId,
	]);
	const pct = Number.parseFloat(stdout.trim().replace("%", ""));
	return Number.isFinite(pct) ? pct / 100 : 0;
}
