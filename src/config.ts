import { readFileSync } from "node:fs";

export interface Config {
  /** the header's `39998:<pubkey>:<d>` coordinate */
  headerCoordinate: string;
  /** the curator's pubkey; checked against the loaded key and used for deletion `a` tags */
  curatorPubkey: string;
  /** template event ids the items and profiles point to, by template name */
  templateIds: { "divine-video": string; "divine-profile": string };
  /** name -> url, e.g. { dcosl: "wss://…", search: "wss://…" } */
  relays: Record<string, string>;
  /** relay name used for the header read */
  headerRelay: string;
  /**
   * Optional, per relay name: the NIP-50 `search` string added to every REQ filter sent to that
   * relay. The search relay refuses a plain REQ and answers one with `include:spam`. A read
   * setting only: publishing sends no REQ.
   */
  relayReadSearch?: Record<string, string>;
  source: {
    relay: string;
    pageSize: number;
    pageDelayMs: number;
    harvestSince: number;
    overlapSeconds: number;
    readTimeoutMs: number;
  };
  media: { base: string; requestsPerSecond: number; recheckDays: number; timeoutMs: number };
  profiles: { batchSize: number; refreshDays: number; nip05TtlDays: number; nip05TimeoutMs: number };
  profileRelays: string[];
  scope: { includeVines: boolean };
  publish: { eventsPerSecond: number; okTimeoutMs: number };
  guards: {
    maxNewOrChanged: number;
    maxDeletionsFloor: number;
    maxDeletionsFraction: number;
    maxVanishedFraction: number;
    maxMediaFailureFraction: number;
  };
  pilotSize: number;
  paths: { out: string; state: string };
}

const COORDINATE_RE = /^39998:[0-9a-f]{64}:[^:]+$/;
const HEX64_RE = /^[0-9a-f]{64}$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isPositiveNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

function isNonNegativeNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

function isPositiveInteger(v: unknown): v is number {
  return Number.isInteger(v) && (v as number) > 0;
}

function isNonNegativeInteger(v: unknown): v is number {
  return Number.isInteger(v) && (v as number) >= 0;
}

function isFraction(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
}

function isUrlWithProtocol(v: unknown, protocols: string[]): boolean {
  if (typeof v !== "string") return false;
  try {
    const url = new URL(v);
    return protocols.includes(url.protocol) && url.hostname !== "";
  } catch {
    return false;
  }
}

function isRelayUrl(v: unknown): boolean {
  return isUrlWithProtocol(v, ["ws:", "wss:"]);
}

/** A short rendering of a bad value for an error message. */
function shown(v: unknown): string {
  if (v === undefined) return "nothing";
  const text = JSON.stringify(v);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/**
 * Reads and validates the config: `path`, else `$DIVINEBOT_CONFIG`, else `config.json`. Every
 * field is checked, so a missing or mistyped value (say a missing guard limit) stops the run
 * here instead of turning a safety check off later. Each error names the file and the field.
 */
export function loadConfig(path?: string): Config {
  const file = path ?? process.env.DIVINEBOT_CONFIG ?? "config.json";
  const text = readFileSync(file, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file}: not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!isObject(raw)) throw new Error(`${file}: must be a JSON object, got ${shown(raw)}`);

  const check = (field: string, value: unknown, ok: boolean, rule: string): void => {
    if (!ok) throw new Error(`${file}: ${field} must be ${rule}, got ${shown(value)}`);
  };

  /** Checks that `section` is an object and every listed field passes its rule. */
  const checkSection = (
    name: string,
    section: unknown,
    fields: Record<string, [(v: unknown) => boolean, string]>,
  ): void => {
    check(name, section, isObject(section), `an object with ${Object.keys(fields).join(", ")}`);
    for (const [key, [ok, rule]] of Object.entries(fields)) {
      const value = (section as Record<string, unknown>)[key];
      check(`${name}.${key}`, value, ok(value), rule);
    }
  };

  const { headerCoordinate, curatorPubkey, relays, headerRelay } = raw;
  check(
    "headerCoordinate",
    headerCoordinate,
    typeof headerCoordinate === "string" && COORDINATE_RE.test(headerCoordinate),
    "39998:<64 hex pubkey>:<d tag>",
  );
  check(
    "curatorPubkey",
    curatorPubkey,
    typeof curatorPubkey === "string" && HEX64_RE.test(curatorPubkey),
    "64 lowercase hex characters",
  );

  const hex64 = (v: unknown): boolean => typeof v === "string" && HEX64_RE.test(v);
  checkSection("templateIds", raw.templateIds, {
    "divine-video": [hex64, "64 lowercase hex characters"],
    "divine-profile": [hex64, "64 lowercase hex characters"],
  });

  check("relays", relays, isObject(relays) && Object.keys(relays).length > 0, "a non-empty object of named relay URLs");
  const relayMap = relays as Record<string, unknown>;
  for (const [name, url] of Object.entries(relayMap)) {
    check(`relays.${name}`, url, isRelayUrl(url), "a ws:// or wss:// URL");
  }
  check(
    "headerRelay",
    headerRelay,
    typeof headerRelay === "string" && Object.hasOwn(relayMap, headerRelay),
    `one of the relay names (${Object.keys(relayMap).join(", ")})`,
  );

  const searchMap = raw.relayReadSearch;
  if (searchMap !== undefined) {
    check("relayReadSearch", searchMap, isObject(searchMap), "an object mapping relay names to search strings");
    for (const [name, search] of Object.entries(searchMap as Record<string, unknown>)) {
      check(
        `relayReadSearch.${name}`,
        search,
        Object.hasOwn(relayMap, name),
        `keyed by one of the relay names (${Object.keys(relayMap).join(", ")})`,
      );
      check(`relayReadSearch.${name}`, search, typeof search === "string" && search.trim() !== "", "a non-empty string");
    }
  }

  checkSection("source", raw.source, {
    relay: [isRelayUrl, "a ws:// or wss:// URL"],
    pageSize: [isPositiveInteger, "a positive integer"],
    pageDelayMs: [isNonNegativeNumber, "a number of 0 or more"],
    harvestSince: [isNonNegativeInteger, "a whole number of seconds, 0 or more"],
    overlapSeconds: [isNonNegativeInteger, "a whole number of seconds, 0 or more"],
    readTimeoutMs: [isPositiveNumber, "a number above 0"],
  });

  checkSection("media", raw.media, {
    base: [(v) => isUrlWithProtocol(v, ["http:", "https:"]), "an http:// or https:// URL"],
    requestsPerSecond: [isPositiveNumber, "a number above 0"],
    recheckDays: [isPositiveNumber, "a number above 0"],
    timeoutMs: [isPositiveNumber, "a number above 0"],
  });

  checkSection("profiles", raw.profiles, {
    batchSize: [isPositiveInteger, "a positive integer"],
    refreshDays: [isPositiveNumber, "a number above 0"],
    nip05TtlDays: [isPositiveNumber, "a number above 0"],
    nip05TimeoutMs: [isPositiveNumber, "a number above 0"],
  });

  const profileRelays = raw.profileRelays;
  check(
    "profileRelays",
    profileRelays,
    Array.isArray(profileRelays) && profileRelays.length > 0,
    "a non-empty array of ws:// or wss:// URLs",
  );
  (profileRelays as unknown[]).forEach((url, i) => {
    check(`profileRelays[${i}]`, url, isRelayUrl(url), "a ws:// or wss:// URL");
  });

  checkSection("scope", raw.scope, {
    includeVines: [(v) => typeof v === "boolean", "true or false"],
  });

  checkSection("publish", raw.publish, {
    eventsPerSecond: [isPositiveNumber, "a number above 0"],
    okTimeoutMs: [isPositiveNumber, "a number above 0"],
  });

  checkSection("guards", raw.guards, {
    maxNewOrChanged: [isNonNegativeInteger, "a whole number, 0 or more"],
    maxDeletionsFloor: [isNonNegativeInteger, "a whole number, 0 or more"],
    maxDeletionsFraction: [isFraction, "a number from 0 to 1"],
    maxVanishedFraction: [isFraction, "a number from 0 to 1"],
    maxMediaFailureFraction: [isFraction, "a number from 0 to 1"],
  });

  check("pilotSize", raw.pilotSize, isPositiveInteger(raw.pilotSize), "a positive integer");

  checkSection("paths", raw.paths, {
    out: [(v) => typeof v === "string" && v.trim() !== "", "a non-empty string"],
    state: [(v) => typeof v === "string" && v.trim() !== "", "a non-empty string"],
  });

  return raw as unknown as Config;
}

/** The URL of the relay called `name`, or an error that lists the configured names. */
export function relayUrl(cfg: Pick<Config, "relays">, name: string): string {
  const url = Object.hasOwn(cfg.relays, name) ? cfg.relays[name] : undefined;
  if (url === undefined) {
    throw new Error(`unknown relay "${name}"; the relays are ${Object.keys(cfg.relays).join(", ")}`);
  }
  return url;
}

/**
 * The NIP-50 `search` string to add to every REQ filter sent to the relay called `name`, or
 * undefined when config has none for it (the filter is then sent as it is).
 */
export function readSearch(cfg: Pick<Config, "relayReadSearch">, name: string): string | undefined {
  const map = cfg.relayReadSearch;
  return map !== undefined && Object.hasOwn(map, name) ? map[name] : undefined;
}
