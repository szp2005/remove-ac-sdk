import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const DEFAULT_GLOBAL_FETCH = globalThis.fetch;
const DEFAULT_MAX_REMOTE_IMAGE_BYTES = 25 * 1024 * 1024;

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
  const host = rawHost.replace(/^\[|\]$/g, "").replace(/\.+$/, "");
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
  const labels = host.split(".");
  if (
    labels.length < 2 ||
    labels.some((lbl) => !lbl) ||
    labels.every((lbl) => /^\d+$/.test(lbl) || /^0x[0-9a-f]+$/i.test(lbl))
  ) {
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

export function isFirstPartyRemoveAcHost(rawHost) {
  const host = String(rawHost || "").trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  return host === "remove.ac" || host.endsWith(".remove.ac");
}

function isFirstPartyRemoveAcHttps(parsedUrl) {
  if (!parsedUrl || parsedUrl.protocol !== "https:") return false;
  return isFirstPartyRemoveAcHost(parsedUrl.hostname);
}

function extractNormalizedHost(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || "").trim());
    return parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  } catch {
    return "";
  }
}

export function isAllowedDirectEndpointHost(rawHost, allowedBaseUrl = "") {
  const host = String(rawHost || "").trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (!host) return false;
  if (isFirstPartyRemoveAcHost(host)) return true;
  if (allowedBaseUrl) {
    const baseHost = extractNormalizedHost(allowedBaseUrl);
    if (baseHost && host === baseHost) return true;
  }
  return false;
}

export async function resolveValidatedRemoteUrl(rawUrl, lookupFn = dns.promises.lookup) {
  const syncErr = isDisallowedRemoteUrl(rawUrl);
  if (syncErr) return { error: syncErr, url: null, host: "", addresses: [] };

  const parsed = new URL(String(rawUrl));
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (net.isIPv4(host) || host.includes(":")) {
    const ipNoZone = host.split("%")[0];
    const family = net.isIPv4(ipNoZone) ? 4 : 6;
    return { error: null, url: parsed, host, addresses: [{ address: ipNoZone, family }] };
  }

  const isDefaultLookup = !lookupFn || lookupFn === dns.promises.lookup;
  const effectiveLookup = lookupFn || dns.promises.lookup;
  let records;
  try {
    records = await effectiveLookup(host, { all: true, verbatim: true });
  } catch {
    return { error: `Unable to resolve hostname '${host}'`, url: null, host, addresses: [] };
  }
  const list = Array.isArray(records) ? records : records ? [records] : [];
  if (list.length === 0) {
    return { error: `Hostname '${host}' returned no DNS records`, url: null, host, addresses: [] };
  }
  const allowTunFakeIp = isDefaultLookup && isFirstPartyRemoveAcHttps(parsed);
  const validatedAddresses = [];
  for (const rec of list) {
    const addr = typeof rec === "string" ? rec : rec?.address;
    if (!addr) {
      return {
        error: `Hostname '${host}' resolves to a private, loopback, or reserved IP address`,
        url: null,
        host,
        addresses: [],
      };
    }
    const cleanAddr = String(addr).trim().replace(/^\[|\]$/g, "");
    if (allowTunFakeIp && isRfc2544BenchmarkIpv4(cleanAddr)) {
      validatedAddresses.push({ address: cleanAddr, family: 4 });
      continue;
    }
    if (isDisallowedIpAddress(cleanAddr)) {
      return {
        error: `Hostname '${host}' resolves to a private, loopback, or reserved IP address`,
        url: null,
        host,
        addresses: [],
      };
    }
    const ipNoZone = cleanAddr.split("%")[0];
    const family = net.isIP(ipNoZone) || (typeof rec === "object" && rec?.family) || (ipNoZone.includes(":") ? 6 : 4);
    validatedAddresses.push({ address: ipNoZone, family });
  }
  return { error: null, url: parsed, host, addresses: validatedAddresses };
}

export async function validateRemoteImageUrl(rawUrl, lookupFn = dns.promises.lookup) {
  const res = await resolveValidatedRemoteUrl(rawUrl, lookupFn);
  return res.error;
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
  {
    lookupFn = dns.promises.lookup,
    allowLoopbackOrigin = false,
    allowedBaseUrl = "",
    requireAllowedDirectHost = false,
    label = "endpoint",
  } = {}
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
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (allowLoopbackOrigin && isLoopbackTestOrigin(parsed.origin)) {
    if (requireAllowedDirectHost && allowedBaseUrl) {
      const baseHost = extractNormalizedHost(allowedBaseUrl);
      if (baseHost && host !== baseHost) {
        return `Disallowed ${label} (host '${host}' does not match configured loopback baseUrl host '${baseHost}')`;
      }
    }
    return null;
  }
  if (parsed.protocol !== "https:") {
    return `${label} must use https://`;
  }
  if (requireAllowedDirectHost) {
    if (!isAllowedDirectEndpointHost(host, allowedBaseUrl)) {
      return `Disallowed ${label} (untrusted host '${host}'; only remove.ac, *.remove.ac, or configured baseUrl host are permitted)`;
    }
    if (parsed.port && parsed.port !== "443") {
      let matchesConfiguredOrigin = false;
      if (allowedBaseUrl) {
        try {
          matchesConfiguredOrigin = new URL(String(allowedBaseUrl).trim()).origin === parsed.origin;
        } catch {
          matchesConfiguredOrigin = false;
        }
      }
      if (!matchesConfiguredOrigin) {
        return `Disallowed ${label} (non-standard port '${parsed.port}' is not permitted)`;
      }
    }
  }
  const ssrfErr = await validateRemoteImageUrl(parsed.toString(), lookupFn);
  if (ssrfErr) {
    return `Disallowed ${label} (${ssrfErr})`;
  }
  return null;
}

export async function validateDirectEndpointUrl(
  rawUrl,
  {
    baseUrl = "",
    lookupFn = dns.promises.lookup,
    allowLoopbackOrigin,
    label = "directEndpoint",
  } = {}
) {
  const effectiveAllowLoopback =
    allowLoopbackOrigin !== undefined ? Boolean(allowLoopbackOrigin) : isLoopbackTestOrigin(baseUrl);
  return validateHttpsEndpointUrl(rawUrl, {
    lookupFn,
    allowLoopbackOrigin: effectiveAllowLoopback,
    allowedBaseUrl: baseUrl,
    requireAllowedDirectHost: true,
    label,
  });
}

export function detectSupportedImageFormat(bytes) {
  if (!bytes || bytes.byteLength < 4) return null;
  if (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return { mime: "image/png", ext: "png" };
  }
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: "image/jpeg", ext: "jpg" };
  }
  if (
    bytes.byteLength >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return { mime: "image/webp", ext: "webp" };
  }
  if (
    bytes.byteLength >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return { mime: "image/gif", ext: "gif" };
  }
  return null;
}

export function fetchPinnedResponseBytes(
  parsedUrl,
  pinnedAddresses,
  { maxBytes = DEFAULT_MAX_REMOTE_IMAGE_BYTES, timeoutMs = 30_000, userAgent = "" } = {}
) {
  return new Promise((resolve, reject) => {
    const isHttps = parsedUrl.protocol === "https:";
    const mod = isHttps ? https : http;
    const cleanHost = parsedUrl.hostname.replace(/^\[|\]$/g, "");
    const headers = { Accept: "image/*" };
    if (userAgent) headers["User-Agent"] = userAgent;

    const reqOptions = {
      protocol: parsedUrl.protocol,
      hostname: cleanHost,
      port: parsedUrl.port ? Number.parseInt(parsedUrl.port, 10) : isHttps ? 443 : 80,
      path: `${parsedUrl.pathname || "/"}${parsedUrl.search || ""}`,
      method: "GET",
      headers,
      timeout: timeoutMs,
      autoSelectFamily: pinnedAddresses.length > 1,
      lookup: (_hostname, opts, cb) => {
        const callback = typeof opts === "function" ? opts : cb;
        if (opts && typeof opts === "object" && opts.all) {
          callback(
            null,
            pinnedAddresses.map((entry) => ({ address: entry.address, family: entry.family })),
          );
          return;
        }
        const wantedFamily = opts && typeof opts === "object" ? opts.family : 0;
        const match =
          (wantedFamily ? pinnedAddresses.find((entry) => entry.family === wantedFamily) : null) ||
          pinnedAddresses[0];
        callback(null, match.address, match.family);
      },
    };
    if (isHttps && !net.isIP(cleanHost)) {
      reqOptions.servername = cleanHost;
    }

    let settled = false;
    const fail = (statusCode, message) => {
      if (settled) return;
      settled = true;
      const err = new Error(message);
      err.statusCode = statusCode;
      reject(err);
    };

    const req = mod.request(reqOptions, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400) {
        res.destroy();
        fail(status, `Remote image_url HTTP ${status} redirects are disallowed for security`);
        return;
      }
      if (status < 200 || status >= 300) {
        res.destroy();
        fail(502, `Failed to fetch remote image_url (HTTP ${status})`);
        return;
      }
      const rawLen = res.headers["content-length"];
      if (rawLen !== undefined) {
        const declaredLen = Number.parseInt(String(rawLen), 10);
        if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
          res.destroy();
          fail(413, `Remote image_url exceeds 25 MB maximum download size (${maxBytes} bytes)`);
          return;
        }
      }
      const chunks = [];
      let total = 0;
      res.on("data", (chunk) => {
        if (settled) return;
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buf.byteLength;
        if (total > maxBytes) {
          res.destroy();
          fail(413, `Remote image_url exceeds 25 MB maximum download size (${maxBytes} bytes)`);
          return;
        }
        chunks.push(buf);
      });
      res.on("end", () => {
        if (settled) return;
        settled = true;
        resolve(Buffer.concat(chunks, total));
      });
      res.on("error", () => {
        fail(502, "Failed to read remote image_url response stream");
      });
    });

    req.on("timeout", () => {
      req.destroy();
      fail(504, "Timed out fetching remote image_url");
    });
    req.on("error", () => {
      fail(502, "Failed to connect to remote image_url");
    });
    req.end();
  });
}

async function readFetchResponseBounded(res, maxBytes) {
  const rawLen = res?.headers?.get?.("content-length");
  if (rawLen !== null && rawLen !== undefined) {
    const declaredLen = Number.parseInt(String(rawLen), 10);
    if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
      try {
        await res.body?.cancel?.();
      } catch {
        // ignore cancel failure
      }
      const err = new Error(`Remote image_url exceeds 25 MB maximum download size (${maxBytes} bytes)`);
      err.statusCode = 413;
      throw err;
    }
  }
  if (res.body && typeof res.body.getReader === "function") {
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          try {
            await reader.cancel();
          } catch {
            // ignore cancel failure
          }
          const err = new Error(`Remote image_url exceeds 25 MB maximum download size (${maxBytes} bytes)`);
          err.statusCode = 413;
          throw err;
        }
        chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore lock release failure
      }
    }
    return Buffer.concat(chunks, total);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > maxBytes) {
    const err = new Error(`Remote image_url exceeds 25 MB maximum download size (${maxBytes} bytes)`);
    err.statusCode = 413;
    throw err;
  }
  return buf;
}

export async function fetchSafeRemoteImageBytes(
  rawUrl,
  {
    fetchImpl = globalThis.fetch,
    lookupFn = dns.promises.lookup,
    maxBytes = DEFAULT_MAX_REMOTE_IMAGE_BYTES,
    timeoutMs = 30_000,
    userAgent = "",
  } = {}
) {
  const resolved = await resolveValidatedRemoteUrl(rawUrl, lookupFn);
  if (resolved.error || !resolved.url || resolved.addresses.length === 0) {
    const err = new Error(`Disallowed image_url (${resolved.error || "invalid URL"})`);
    err.statusCode = 400;
    throw err;
  }

  let bytes;
  const usePinnedNodeTransport =
    !fetchImpl || (fetchImpl === DEFAULT_GLOBAL_FETCH && globalThis.fetch === DEFAULT_GLOBAL_FETCH);

  if (usePinnedNodeTransport) {
    bytes = await fetchPinnedResponseBytes(resolved.url, resolved.addresses, {
      maxBytes,
      timeoutMs,
      userAgent,
    });
  } else {
    const headers = { Accept: "image/*" };
    if (userAgent) headers["User-Agent"] = userAgent;
    let res;
    try {
      res = await fetchWithoutRedirects(fetchImpl, resolved.url.toString(), {
        method: "GET",
        headers,
        signal: typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
          ? AbortSignal.timeout(timeoutMs)
          : undefined,
      });
    } catch (err) {
      if (err && typeof err.statusCode === "number") {
        throw err;
      }
      const netErr = new Error("Failed to fetch remote image_url");
      netErr.statusCode = 502;
      throw netErr;
    }
    if (!res || !res.ok) {
      try {
        await res?.body?.cancel?.();
      } catch {
        // ignore cancel error
      }
      const status = res && typeof res.status === "number" ? res.status : 502;
      const err = new Error(`Failed to fetch remote image_url (HTTP ${status})`);
      err.statusCode = 502;
      throw err;
    }
    bytes = await readFetchResponseBounded(res, maxBytes);
  }

  if (!bytes || bytes.byteLength === 0) {
    const err = new Error("Remote image_url returned an empty response");
    err.statusCode = 400;
    throw err;
  }
  const detected = detectSupportedImageFormat(bytes);
  if (!detected) {
    const err = new Error("Remote image_url did not return a valid PNG, JPEG, WebP, or GIF image");
    err.statusCode = 400;
    throw err;
  }
  return {
    bytes,
    mime: detected.mime,
    fileName: `remote-image.${detected.ext}`,
  };
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
