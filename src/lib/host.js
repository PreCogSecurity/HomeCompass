/**
 * `Host` header validation — DNS rebinding defence.
 *
 * HomeCompass deliberately binds to loopback and ships no authentication. That
 * combination is directly attackable by DNS rebinding:
 *
 *   1. A hostile page is served from `evil.example` (an address the attacker
 *      controls).
 *   2. The page resolves `homecompass.local` to 127.0.0.1 and reloads. The
 *      browser now treats the response as *same-origin*, because the origin is
 *      compared by name, not by IP.
 *   3. `fetch('/api/items')` therefore needs no CORS exemption at all, and the
 *      attacker reads and rewrites the victim's inventory.
 *
 * CORS cannot fix this: the request never looks cross-origin. The only reliable
 * defence is to refuse requests whose `Host` is not one the operator declared,
 * which is exactly what this module does. It applies to *every* request,
 * including static assets, so the UI itself is unaffected.
 */

/**
 * Hosts always accepted, because they can only ever mean "this machine".
 *
 * `0.0.0.0`/`::` are included deliberately: they are what a container or a
 * wildcard bind reports to a client, and neither can be a rebinding target.
 */
export const LOOPBACK_HOSTS = Object.freeze([
  'localhost',
  '127.0.0.1',
  '[::1]',
  '::1',
  '0.0.0.0',
  '::',
]);

const MAX_AUTHORITY_LENGTH = 255;
const PORT_SUFFIX = /^:\d{1,5}$/;
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * Normalise a `Host` header value to a bare, lower-case host.
 *
 * Handles the authority forms that actually reach a server: `host`,
 * `host:port`, and the bracketed IPv6 literal `[::1]:8080`. Returns `null` for
 * anything malformed so the caller can reject rather than guess.
 *
 * @param {string|string[]|undefined} value
 * @returns {string|null}
 */
export function parseHost(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return null;

  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.length > MAX_AUTHORITY_LENGTH) return null;
  // Userinfo in a Host header is never legitimate; strip rather than trust it,
  // so `victim.example@evil.example` cannot masquerade as `victim.example`.
  const at = trimmed.lastIndexOf('@');
  const authority = at === -1 ? trimmed : trimmed.slice(at + 1);
  if (authority === '') return null;

  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close === -1) return null;
    const host = authority.slice(0, close + 1).toLowerCase();
    const remainder = authority.slice(close + 1);
    // Either nothing, or a well-formed `:port`. `[::1]evil` must not pass.
    if (remainder !== '' && !PORT_SUFFIX.test(remainder)) return null;
    return host;
  }

  // Two or more colons and no brackets is a bare IPv6 literal, which RFC 3986
  // requires to be bracketed in an authority. Reject instead of mis-parsing it
  // as `host:port`.
  const colons = authority.split(':').length - 1;
  if (colons > 1) return null;

  let host = authority;
  if (colons === 1) {
    const index = authority.lastIndexOf(':');
    const port = authority.slice(index + 1);
    if (!PORT_SUFFIX.test(`:${port}`)) return null;
    host = authority.slice(0, index);
  }

  host = host.toLowerCase();
  if (host === '') return null;
  // Accept bracketed IPv6, dotted-quad IPv4, and DNS names. Reject everything
  // else (underscores, spaces, control bytes, trailing dot tricks).
  if (host.startsWith('[') && host.endsWith(']')) return host;
  if (HOSTNAME.test(host)) return host;
  return null;
}

/**
 * Build the allow-list of accepted `Host` values.
 *
 * Always includes the loopback names and the configured bind address. Operators
 * add their own names via `ALLOWED_HOSTS` when a reverse proxy or a custom
 * hostname is in front. `ALLOWED_HOSTS=*` is the documented escape hatch and is
 * deliberately loud: it disables this control entirely.
 *
 * @param {{configured?: string|undefined, host: string}} options
 * @returns {{allowAny: boolean, hosts: Set<string>}}
 */
export function buildAllowedHosts({ configured, host }) {
  const raw = typeof configured === 'string' ? configured.trim() : '';
  if (raw === '*') return { allowAny: true, hosts: new Set() };

  const hosts = new Set(LOOPBACK_HOSTS);
  const bound = parseHost(host);
  if (bound !== null) hosts.add(bound);

  if (raw !== '') {
    for (const entry of raw.split(',')) {
      const candidate = entry.trim();
      if (candidate === '') continue;
      const parsed = parseHost(candidate.includes(':') ? candidate : `${candidate}:0`);
      // Tolerate `example.com` as well as `example.com:8443`: the port is not
      // what identifies the deployment, and operators reasonably omit it.
      const withoutPort = parseHost(candidate.split(':')[0]);
      if (parsed !== null) hosts.add(parsed);
      if (withoutPort !== null) hosts.add(withoutPort);
    }
  }

  return { allowAny: false, hosts };
}

/**
 * Decide whether a request's `Host` is acceptable.
 *
 * @param {string|string[]|undefined} headerValue
 * @param {{allowAny: boolean, hosts: Set<string>}} allowedHosts
 * @returns {{ok: true} | {ok: false, reason: 'missing'|'malformed'|'unlisted'}}
 */
export function checkHost(headerValue, allowedHosts) {
  if (allowedHosts.allowAny === true) return { ok: true };
  const host = parseHost(headerValue);
  // HTTP/1.1 requires a Host header. Its absence means the client is either
  // broken or deliberately obfuscating, and there is no safe default.
  if (host === null) {
    const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    return { ok: false, reason: raw === undefined || raw === '' ? 'missing' : 'malformed' };
  }
  if (!allowedHosts.hosts.has(host)) return { ok: false, reason: 'unlisted' };
  return { ok: true };
}
