import type { Device, DeviceService, DiscoveryMatcher } from "@orbis/sdk";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getDb, now, schema } from "../db";
import { broadcast } from "../ws";

type Listener = (devices: Device[]) => void;
const listeners = new Set<Listener>();

function rowToDevice(r: typeof schema.devices.$inferSelect): Device {
  let services: DeviceService[] = [];
  try {
    services = JSON.parse(r.services);
  } catch {
    /* ignore */
  }
  return {
    id: r.id,
    ip: r.ip,
    mac: r.mac,
    hostname: r.hostname,
    vendor: r.vendor,
    services,
    firstSeen: r.firstSeen,
    lastSeen: r.lastSeen,
    online: r.online,
    claimedBy: r.claimedBy,
    label: r.label,
  };
}

export function listDevices(): Device[] {
  return getDb().select().from(schema.devices).all().map(rowToDevice);
}

export function getDevice(id: string): Device | null {
  const r = getDb().select().from(schema.devices).where(eq(schema.devices.id, id)).get();
  return r ? rowToDevice(r) : null;
}

function notify() {
  const all = listDevices();
  broadcast({ type: "devices:changed" });
  for (const l of listeners) {
    try {
      l(all);
    } catch {
      /* module listener error, ignore */
    }
  }
}

export function onDevicesChange(cb: Listener) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export type DeviceObservation = {
  ip: string;
  mac?: string | null;
  hostname?: string | null;
  vendor?: string | null;
  services?: DeviceService[];
};

/** Merge a scan observation into the registry. Matches by MAC first, then by IP. */
export function observeDevice(obs: DeviceObservation): Device {
  const db = getDb();
  const mac = obs.mac ? obs.mac.toLowerCase() : null;
  const existing =
    (mac ? db.select().from(schema.devices).where(eq(schema.devices.mac, mac)).get() : undefined) ??
    db.select().from(schema.devices).where(eq(schema.devices.ip, obs.ip)).get();
  const ts = now();
  if (existing) {
    const services = mergeServices(JSON.parse(existing.services) as DeviceService[], obs.services ?? []);
    db.update(schema.devices)
      .set({
        ip: obs.ip,
        mac: mac ?? existing.mac,
        hostname: obs.hostname ?? existing.hostname,
        vendor: obs.vendor ?? existing.vendor,
        services: JSON.stringify(services),
        lastSeen: ts,
        online: true,
      })
      .where(eq(schema.devices.id, existing.id))
      .run();
    return getDevice(existing.id)!;
  }
  const id = nanoid(10);
  db.insert(schema.devices)
    .values({ id, ip: obs.ip, mac, hostname: obs.hostname ?? null, vendor: obs.vendor ?? null, services: JSON.stringify(obs.services ?? []), firstSeen: ts, lastSeen: ts, online: true, claimedBy: null, label: null })
    .run();
  return getDevice(id)!;
}

function mergeServices(a: DeviceService[], b: DeviceService[]) {
  const key = (s: DeviceService) => `${s.kind}:${s.name}:${s.port ?? ""}`;
  const map = new Map(a.map((s) => [key(s), s]));
  for (const s of b) map.set(key(s), { ...map.get(key(s)), ...s });
  return [...map.values()];
}

/** Call after a scan pass: devices not seen for `staleMs` are marked offline. Fires change listeners once. */
export function finishScan(seenIds: Set<string>, staleMs = 10 * 60_000) {
  const db = getDb();
  const cutoff = new Date(Date.now() - staleMs).toISOString();
  for (const d of db.select().from(schema.devices).all()) {
    const shouldBeOnline = seenIds.has(d.id) || d.lastSeen > cutoff;
    if (d.online !== shouldBeOnline) db.update(schema.devices).set({ online: shouldBeOnline }).where(eq(schema.devices.id, d.id)).run();
  }
  notify();
}

export function claimDevice(id: string, moduleId: string): Device | null {
  const d = getDevice(id);
  if (!d) return null;
  if (d.claimedBy && d.claimedBy !== moduleId) return null;
  getDb().update(schema.devices).set({ claimedBy: moduleId }).where(eq(schema.devices.id, id)).run();
  notify();
  return getDevice(id);
}

export function releaseDevice(id: string, moduleId?: string) {
  const d = getDevice(id);
  if (!d) return;
  if (moduleId && d.claimedBy !== moduleId) return;
  getDb().update(schema.devices).set({ claimedBy: null }).where(eq(schema.devices.id, id)).run();
  notify();
}

export function releaseAllOfModule(moduleId: string) {
  getDb().update(schema.devices).set({ claimedBy: null }).where(eq(schema.devices.claimedBy, moduleId)).run();
  notify();
}

export function labelDevice(id: string, label: string | null) {
  getDb().update(schema.devices).set({ label }).where(eq(schema.devices.id, id)).run();
  notify();
}

export function deleteDevice(id: string) {
  getDb().delete(schema.devices).where(eq(schema.devices.id, id)).run();
  notify();
}

export function addManualDevice(ip: string, label?: string | null) {
  const d = observeDevice({ ip });
  if (label) labelDevice(d.id, label);
  notify();
  return getDevice(d.id)!;
}

export function matchesDiscovery(d: Device, m: DiscoveryMatcher | undefined): boolean {
  if (!m) return false;
  if (m.vendor && d.vendor && m.vendor.some((v) => d.vendor!.toLowerCase().includes(v.toLowerCase()))) return true;
  if (m.hostname && d.hostname && new RegExp(m.hostname, "i").test(d.hostname)) return true;
  if (m.mdns && d.services.some((s) => s.kind === "mdns" && m.mdns!.some((t) => s.name.includes(t)))) return true;
  if (m.ssdp && d.services.some((s) => s.kind === "ssdp" && m.ssdp!.some((t) => s.name.toLowerCase().includes(t.toLowerCase())))) return true;
  return false;
}
