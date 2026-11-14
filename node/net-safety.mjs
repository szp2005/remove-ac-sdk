import dns from "node:dns";
import net from "node:net";

export function isPrivateIpv4Octets(a, b, c, _d) {
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // RFC 6598 CGNAT 100.64.0.0/10
  if (a === 169 && b === 254) return true; // RFC 3927 link-local & cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918 172.16.0.0/12
  if (a === 192 && b === 0 && c === 0) return true; // RFC 6890 192.0.0.0/24
  if (a === 192 && b === 168) return true; // RFC 1918 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true; // RFC 2544 benchmarking 198.18.0.0/15
  if (a >= 224) return true; // Multicast 224.0.0.0/4 & reserved 240.0.0.0/4 + broadcast
  return false;
}

export function isPrivateIpv4(ip) {
  const parts = String(ip)
    .split(".")
    .map((s) => (/^\d{1,3}$/.test(s) ? Number.parseInt(s, 10) : Number.NaN));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true;
  }
  return isPrivateIpv4Octets(parts[0], parts[1], parts[2], parts[3]);
}

function isPrivateIpv4Words(hi16, lo16) {
  const a = (hi16 >>> 8) & 0xff;
  const b = hi16 & 0xff;
  const c = (lo16 >>> 8) & 0xff;
  const d = lo16 & 0xff;
  return isPrivateIpv4Octets(a, b, c, d);
}

export function parseIpv6Words(rawIp) {
  let clean = String(rawIp).trim().toLowerCase().replace(/^\[|\]$/g, "");
  const zoneIdx = clean.indexOf("%");
  if (zoneIdx !== -1) clean = clean.slice(0, zoneIdx);
  if (!clean || !clean.includes(":")) return null;

  const lastColon = clean.lastIndexOf(":");
  const tail = clean.slice(lastColon + 1);
  if (tail.includes(".")) {
    const octets = tail
      .split(".")
      .map((s) => (/^\d{1,3}$/.test(s) ? Number.parseInt(s, 10) : Number.NaN));
    if (octets.length !== 4 || octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
      return null;
    }
    const w6 = ((octets[0] << 8) | octets[1]).toString(16);
    const w7 = ((octets[2] << 8) | octets[3]).toString(16);
    clean = `${clean.slice(0, lastColon + 1)}${w6}:${w7}`;
  }

  const dblParts = clean.split("::");
  if (dblParts.length > 2) return null;

  const parseSide = (str) => {
    if (!str) return [];
    const groups = str.split(":");
    const nums = [];
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      nums.push(Number.parseInt(g, 16));
    }
    return nums;
  };

  if (dblParts.length === 2) {
    const left = parseSide(dblParts[0]);
    const right = parseSide(dblParts[1]);
    if (!left || !right || left.length + right.length >= 8) return null;
    const zeros = new Array(8 - left.length - right.length).fill(0);
    return Uint16Array.from([...left, ...zeros, ...right]);
  }

  const full = parseSide(clean);
  if (!full || full.length !== 8) return null;
  return Uint16Array.from(full);
}

export function isPrivateIpv6(ip) {
  const w = parseIpv6Words(ip);
  if (!w) return true;

  if (w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 && w[4] === 0 && w[5] === 0) {
    if (w[6] === 0 && (w[7] === 0 || w[7] === 1)) return true;
    return isPrivateIpv4Words(w[6], w[7]);
  }
  if (w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 && w[4] === 0 && w[5] === 0xffff) {
    return isPrivateIpv4Words(w[6], w[7]);
  }
  if (w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 && w[4] === 0xffff && w[5] === 0) {
    return isPrivateIpv4Words(w[6], w[7]);
  }
  if (w[0] === 0x0064 && w[1] === 0xff9b) {
    if (w[2] === 0 && w[3] === 0 && w[4] === 0 && w[5] === 0) {
      return isPrivateIpv4Words(w[6], w[7]);
    }
    if (w[2] === 1) return true;
  }
  if (w[0] === 0x0100 && w[1] === 0 && w[2] === 0 && w[3] === 0) return true;
  if ((w[0] & 0xfe00) === 0xfc00) return true;
  if ((w[0] & 0xffc0) === 0xfe80) return true;
  if ((w[0] & 0xffc0) === 0xfec0) return true;
  if ((w[0] & 0xff00) === 0xff00) return true;
  return false;
}

export function isDisallowedIpAddress(ip) {
  const clean = String(ip).trim().replace(/^\[|\]$/g, "");
  if (net.isIPv4(clean)) return isPrivateIpv4(clean);
  if (clean.includes(":")) return isPrivateIpv6(clean);
  return true;
}

export function isDisallowedRemoteUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl));
  } catch {
    return "Invalid URL syntax";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return "Only http:// and https:// image URLs are allowed";
  }
  if (parsed.username || parsed.password) {
    return "URLs with embedded credentials are not permitted";
  }
  const rawHost = parsed.hostname.toLowerCase();
  const host = rawHost.replace(/^\[|\]$/g, "");
  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".home.arpa")
  ) {
    return "Local or internal hostnames are not permitted";
  }
  if (rawHost.startsWith("[") || host.includes(":")) {
    if (isPrivateIpv6(host)) {
      return "Private, loopback, or reserved IPv6 addresses are not permitted";
    }
    return null;
  }
  if (net.isIPv4(host)) {
    if (isPrivateIpv4(host)) {
      return "Private, loopback, or reserved IPv4 addresses are not permitted";
    }
    return null;
  }
  if (!host.includes(".") || /^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) {
    return "Single-label or non-standard numeric hostnames are not permitted";
  }
  return null;
}

function isRfc2544BenchmarkIpv4(ip) {
  const clean = String(ip).trim();
  if (!net.isIPv4(clean)) return false;
  const parts = clean.split(".").map((s) => Number.parseInt(s, 10));
  return parts.length === 4 && parts[0] === 198 && (parts[1] === 18 || parts[1] === 19);
}

function isFirstPartyRemoveAcHttps(parsedUrl) {
  if (!parsedUrl || parsedUrl.protocol !== "https:") return false;
  const host = parsedUrl.hostname.toLowerCase();
  return host === "remove.ac" || host.endsWith(".remove.ac");
}

export async function validateRemoteImageUrl(rawUrl, lookupFn = dns.promises.lookup) {
  const syncErr = isDisallowedRemoteUrl(rawUrl);
  if (syncErr) return syncErr;

  const parsed = new URL(String(rawUrl));
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (net.isIPv4(host) || host.includes(":")) {
    return null;
  }

  let records;
  try {
    records = await lookupFn(host, { all: true, verbatim: true });
  } catch {
    return `Unable to resolve hostname '${host}'`;
  }
  const list = Array.isArray(records) ? records : records ? [records] : [];
  if (list.length === 0) {
    return `Hostname '${host}' returned no DNS records`;
  }
  const allowTunFakeIp = isFirstPartyRemoveAcHttps(parsed);
  for (const rec of list) {
    const addr = typeof rec === "string" ? rec : rec?.address;
    if (!addr) {
      return `Hostname '${host}' resolves to a private, loopback, or reserved IP address`;
    }
    if (allowTunFakeIp && isRfc2544BenchmarkIpv4(addr)) {
      continue;
    }
    if (isDisallowedIpAddress(addr)) {
      return `Hostname '${host}' resolves to a private, loopback, or reserved IP address`;
    }
  }
  return null;
}

export function isLoopbackTestOrigin(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl));
    if (parsed.protocol !== "http:") return false;
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host === "127.0.0.1" || host === "::1" || host === "localhost";
  } catch {
    return false;
  }
}

export async function validateHttpsEndpointUrl(
  rawUrl,
  { lookupFn = dns.promises.lookup, allowLoopbackOrigin = false, label = "endpoint" } = {}
) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || "").trim());
  } catch {
    return `Invalid ${label} URL`;
  }
  if (parsed.username || parsed.password) {
    return `${label} must not contain embedded credentials`;
  }
  if (allowLoopbackOrigin && isLoopbackTestOrigin(parsed.origin)) {
    return null;
  }
  if (parsed.protocol !== "https:") {
    return `${label} must use https://`;
  }
  const ssrfErr = await validateRemoteImageUrl(parsed.toString(), lookupFn);
  if (ssrfErr) {
    return `Disallowed ${label} (${ssrfErr})`;
  }
  return null;
}

export async function fetchWithoutRedirects(fetchImpl, url, init = {}) {
  let res;
  try {
    res = await fetchImpl(url, {
      ...init,
      redirect: "error",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const causeMsg = err && err.cause instanceof Error ? err.cause.message : "";
    if (/redirect/i.test(msg) || /redirect/i.test(causeMsg)) {
      const redirErr = new Error("HTTP redirects are disallowed for security");
      redirErr.statusCode = 302;
      throw redirErr;
    }
    throw err;
  }
  if (res && res.status >= 300 && res.status < 400) {
    const redirErr = new Error(`HTTP ${res.status} redirects are disallowed for security`);
    redirErr.statusCode = res.status;
    throw redirErr;
  }
  return res;
}
