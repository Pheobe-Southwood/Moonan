import { execFileSync, spawn } from "node:child_process";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Starts Moonan on the LAN or on the Tailscale interface, without touching the
 * platform's defaults. The platform has no accounts; binding it beyond loopback is
 * only reasonable on a network you already trust (a tailnet is the intended one).
 */
const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

function usage() {
	console.log(`Usage: node scripts/tailnet-start.mjs [options]

Options
  --lan            Bind 0.0.0.0 (LAN + tailnet) instead of the Tailscale IPv4
  --port <n>       Port to listen on (default 21315)
  --dev            Validate every cell write (chord dev mode)
  -h, --help       Show this help

Run this through \`pnpm start:tailnet\` / \`pnpm start:lan\`, which build first.
`);
}

const options = { lan: false, port: "21315", dev: false, help: false };
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
	const flag = argv[index];
	const value = () => {
		const next = argv[index + 1];
		if (next === undefined) throw new Error(`${flag} needs a value`);
		index += 1;
		return next;
	};
	switch (flag) {
		case "--lan":
			options.lan = true;
			break;
		case "--port": {
			const port = Number(value());
			if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port: ${port}`);
			options.port = String(port);
			break;
		}
		case "--dev":
			options.dev = true;
			break;
		case "-h":
		case "--help":
			options.help = true;
			break;
		default:
			throw new Error(`unknown option: ${flag}`);
	}
}

if (options.help) {
	usage();
	process.exit(0);
}

function tailscaleInfo() {
	try {
		const ips = execFileSync("tailscale", ["ip", "-4"], { encoding: "utf8" })
			.split(/\s+/)
			.map((value) => value.trim())
			.filter(Boolean);
		const ip = ips[0];
		let dnsName;
		try {
			const status = JSON.parse(execFileSync("tailscale", ["status", "--json"], { encoding: "utf8" }));
			dnsName = typeof status?.Self?.DNSName === "string" ? status.Self.DNSName.replace(/\.$/, "") : undefined;
		} catch {
			/* MagicDNS is optional */
		}
		return { ip, dnsName };
	} catch {
		return undefined;
	}
}

function lanAddress() {
	for (const [name, addresses] of Object.entries(networkInterfaces())) {
		if (name === "tailscale0") continue;
		for (const address of addresses ?? []) {
			if (address.family === "IPv4" && !address.internal && !address.address.startsWith("100.") && !address.address.startsWith("172.1")) {
				return address.address;
			}
		}
	}
	return undefined;
}

let tailnet;
try {
	tailnet = tailscaleInfo();
} catch (error) {
	console.error(`tailnet-start: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(2);
}

if (!options.lan && !tailnet?.ip) {
	console.error("tailnet-start: no Tailscale IPv4 found. Start Tailscale first, or use `pnpm start:lan`.");
	process.exit(2);
}

const hostname = options.lan ? "0.0.0.0" : tailnet.ip;
const urls = [];
if (tailnet?.ip) urls.push(`http://${tailnet.ip}:${options.port}`);
const lan = lanAddress();
if (options.lan && lan) urls.push(`http://${lan}:${options.port}`);
if (tailnet?.dnsName) urls.push(`http://${tailnet.dnsName}:${options.port}`);

console.log("");
console.log("Moonan is binding outside loopback. There is no account authentication.");
console.log(`  bind: ${hostname}:${options.port}`);
for (const url of [...new Set(urls)]) console.log(`  open: ${url}`);
console.log("  keep this on your tailnet / trusted LAN; do not port-forward it to the internet");
console.log("");

const platform = join(root, "packages", "platform", "bin", "moonan.js");
const args = [
	platform,
	"--hostname",
	hostname,
	"--port",
	options.port,
	...(options.dev ? ["--dev"] : []),
	"--plugin",
	"@moonan_ai/ai-gateway",
];

const child = spawn(process.execPath, args, { cwd: root, stdio: "inherit" });
child.on("error", (error) => {
	console.error(`tailnet-start: could not start Moonan: ${error.message}`);
	process.exitCode = 1;
});
child.on("exit", (code, signal) => {
	if (signal) process.kill(process.pid, signal);
	else process.exitCode = code ?? 1;
});
const forward = (signal) => {
	if (!child.killed) child.kill(signal);
};
process.on("SIGINT", () => forward("SIGINT"));
process.on("SIGTERM", () => forward("SIGTERM"));
process.on("SIGHUP", () => forward("SIGHUP"));
