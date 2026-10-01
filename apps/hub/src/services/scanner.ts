import { exec } from "node:child_process";
import { networkInterfaces } from "node:os";
import { promisify } from "node:util";
import type { DeviceService } from "@orbis/sdk";
import Bonjour from "bonjour-service";
import { childLog } from "../log";
import { broadcast } from "../ws";
import { finishScan, observeDevice, type DeviceObservation } from "./devices";

const log = childLog("scanner");
const run = promisify(exec);

let scanning = false;
let lastScan: { startedAt: string; finishedAt: string | null; found: number; error: string | null } | null = null;

export function scanStatus() {
  return { scanning, lastScan };
}

/** IPv4 /24 (or smaller) subnets of all non-internal interfaces. */
export function localSubnets(): Array<{ base: string; iface: string; self: string }> {
  const out: Array<{ base: string; iface: string; self: string }> = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (a.address.startsWith("169.254.")) continue;
      // only sweep /24s; larger subnets are too slow to ping blindly
      const base = a.address.split(".").slice(0, 3).join(".");
      if (!out.some((o) => o.base === base)) out.push({ base, iface: name, self: a.address });
    }
  }
  return out;
}

async function ping(ip: string): Promise<boolean> {
  const cmd = process.platform === "win32" ? `ping -n 1 -w 700 ${ip}` : process.platform === "darwin" ? `ping -c 1 -W 700 ${ip}` : `ping -c 1 -W 1 ${ip}`;
  try {
    const { stdout } = await run(cmd, { timeout: 2500, windowsHide: true });
    return /TTL=|ttl=/.test(stdout);
  } catch {
    return false;
  }
}

async function pingSweep(base: string, concurrency = 48): Promise<string[]> {
  const ips = Array.from({ length: 254 }, (_, i) => `${base}.${i + 1}`);
  const alive: string[] = [];
  let idx = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (idx < ips.length) {
        const ip = ips[idx++]!;
        if (await ping(ip)) alive.push(ip);
      }
    }),
  );
  return alive;
}

/** ip → mac from the OS neighbour table. */
export async function arpTable(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    if (process.platform === "linux") {
      const { stdout } = await run("ip neigh", { timeout: 4000 });
      for (const line of stdout.split("\n")) {
        const m = line.match(/^(\d+\.\d+\.\d+\.\d+)\s.*lladdr\s+([0-9a-f:]{17})/i);
        if (m && !/FAILED|INCOMPLETE/.test(line)) map.set(m[1]!, m[2]!.toLowerCase());
      }
    } else {
      const { stdout } = await run("arp -a", { timeout: 4000, windowsHide: true });
      for (const line of stdout.split("\n")) {
        const m = line.match(/(\d+\.\d+\.\d+\.\d+)\D+([0-9a-f]{2}(?:[-:][0-9a-f]{2}){5})/i);
        if (m) {
          const mac = m[2]!.toLowerCase().replace(/-/g, ":");
          if (mac !== "ff:ff:ff:ff:ff:ff" && !mac.startsWith("01:00:5e")) map.set(m[1]!, mac);
        }
      }
    }
  } catch (err) {
    log.warn({ err: (err as Error).message }, "arp table unavailable");
  }
  return map;
}

/* ---------- mDNS (bonjour-service is optional at runtime) ---------- */

type MdnsHit = { ip: string; hostname: string | null; service: DeviceService };

async function mdnsBrowse(durationMs = 4000): Promise<MdnsHit[]> {
  const hits: MdnsHit[] = [];
  let b: InstanceType<typeof Bonjour>;
  try {
    b = new Bonjour();
  } catch (err) {
    log.debug({ err: (err as Error).message }, "mDNS unavailable");
    return hits;
  }
  try {
    await new Promise<void>((resolve) => {
      // no type = wildcard browse of every advertised service
      b.find({} as unknown as Parameters<typeof b.find>[0], (svc) => {
        const ip = (svc.addresses ?? []).find((a) => /^d+.d+.d+.d+$/.test(a)) ?? svc.referer?.address;
        if (!ip) return;
        hits.push({
          ip,
          hostname: svc.host?.replace(/.local.?$/, "") ?? null,
          service: { kind: "mdns", name: `_${svc.type}._${svc.protocol ?? "tcp"}${svc.name ? ` ${svc.name}` : ""}`, port: svc.port, txt: svc.txt as Record<string, string> | undefined },
        });
      });
      setTimeout(resolve, durationMs);
    });
  } finally {
    try {
      b.destroy();
    } catch {
      /* ignore */
    }
  }
  return hits;
}

/* ---------- reverse DNS / NetBIOS-ish hostname ---------- */

async function hostnameFor(ip: string): Promise<string | null> {
  try {
    const { reverse } = await import("node:dns/promises");
    const names = await Promise.race([reverse(ip), new Promise<string[]>((_, rej) => setTimeout(() => rej(new Error("timeout")), 1200))]);
    return names[0]?.replace(/\.$/, "") ?? null;
  } catch {
    return null;
  }
}

/* ---------- OUI vendor lookup (tiny built-in table, extended by modules later) ---------- */

const OUI: Record<string, string> = {
  "b8:27:eb": "Raspberry Pi", "dc:a6:32": "Raspberry Pi", "e4:5f:01": "Raspberry Pi", "d8:3a:dd": "Raspberry Pi",
  "00:17:88": "Philips Hue", "ec:b5:fa": "Philips Hue",
  "c4:5b:be": "Shelly", "8c:aa:b5": "Shelly", "3c:61:05": "Shelly", "e8:db:84": "Shelly", "34:94:54": "Shelly", "a4:cf:12": "Shelly", "48:3f:da": "Shelly",
  "cc:50:e3": "Espressif", "24:6f:28": "Espressif", "a0:20:a6": "Espressif", "30:ae:a4": "Espressif", "84:cc:a8": "Espressif", "ec:fa:bc": "Espressif", "24:0a:c4": "Espressif",
  "fc:fb:fb": "Sonos", "00:0e:58": "Sonos", "5c:aa:fd": "Sonos", "48:a6:b8": "Sonos", "94:9f:3e": "Sonos",
  "f0:ef:86": "Google", "54:60:09": "Google", "20:df:b9": "Google", "1c:f2:9a": "Google", "d4:f5:47": "Google",
  "fc:65:de": "Amazon", "74:c2:46": "Amazon", "44:65:0d": "Amazon", "a0:02:dc": "Amazon", "0c:47:c9": "Amazon", "40:b4:cd": "Amazon",
  "00:1a:22": "eQ-3 / Homematic", "00:1f:3f": "AVM Fritz!", "3c:a6:2f": "AVM Fritz!", "e0:28:6d": "AVM Fritz!", "dc:39:6f": "AVM Fritz!", "c8:0e:14": "AVM Fritz!",
  "28:6d:97": "Samsung", "8c:71:f8": "Samsung", "00:12:fb": "Samsung", "f8:04:2e": "Samsung",
  "a4:83:e7": "Apple", "f0:18:98": "Apple", "3c:22:fb": "Apple", "14:7d:da": "Apple", "d0:03:4b": "Apple", "ac:bc:32": "Apple", "f4:0f:24": "Apple",
  "00:1e:c0": "Microchip", "b4:e6:2d": "Espressif", "10:52:1c": "Espressif", "7c:df:a1": "Espressif", "c8:c9:a3": "Espressif",
  "d8:f1:5b": "Espressif", "3c:71:bf": "Espressif", "08:3a:f2": "Espressif", "f4:cf:a2": "Espressif",
  "00:50:56": "VMware", "08:00:27": "VirtualBox", "52:54:00": "QEMU/KVM",
  "00:11:32": "Synology", "00:1b:a9": "Brother", "30:05:5c": "Brother", "00:80:92": "Silex",
};

export function vendorFor(mac: string | null | undefined): string | null {
  if (!mac) return null;
  return OUI[mac.slice(0, 8).toLowerCase()] ?? null;
}

/* ---------- orchestrate ---------- */

export async function scanNetwork(): Promise<void> {
  if (scanning) return;
  scanning = true;
  lastScan = { startedAt: new Date().toISOString(), finishedAt: null, found: 0, error: null };
  broadcast({ type: "devices:changed" });
  try {
    const subnets = localSubnets();
    log.info({ subnets: subnets.map((s) => `${s.base}.0/24 (${s.iface})`) }, "scanning");
    const [alive, mdns] = await Promise.all([Promise.all(subnets.map((s) => pingSweep(s.base))).then((r) => r.flat()), mdnsBrowse()]);
    const arp = await arpTable();
    const ips = new Set<string>([...alive, ...mdns.map((m) => m.ip), ...arp.keys()].filter((ip) => subnets.some((s) => ip.startsWith(`${s.base}.`))));
    const seen = new Set<string>();
    const hostnames = new Map<string, string | null>();
    await Promise.all([...ips].map(async (ip) => hostnames.set(ip, await hostnameFor(ip))));
    for (const ip of ips) {
      const mac = arp.get(ip) ?? null;
      const services = mdns.filter((m) => m.ip === ip).map((m) => m.service);
      const obs: DeviceObservation = {
        ip,
        mac,
        hostname: mdns.find((m) => m.ip === ip && m.hostname)?.hostname ?? hostnames.get(ip) ?? null,
        vendor: vendorFor(mac),
        services,
      };
      const d = observeDevice(obs);
      seen.add(d.id);
    }
    lastScan.found = seen.size;
    finishScan(seen);
    log.info({ found: seen.size }, "scan complete");
  } catch (err) {
    lastScan.error = (err as Error).message;
    log.error({ err }, "scan failed");
  } finally {
    scanning = false;
    lastScan.finishedAt = new Date().toISOString();
    broadcast({ type: "devices:changed" });
  }
}
