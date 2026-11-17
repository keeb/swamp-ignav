import { z } from "npm:zod@4";
import type { ModelDefinition } from "jsr:@systeminit/swamp-testing@0.20260604.20";

// Ignav flight fares (https://ignav.com/docs), for answering "which flight
// gets me there in time" questions from swamp.
//
//   search         — one one-way leg (route + date), filtered by airline, stops
//                    and departure/arrival hour windows; lands in `fares/<label>`.
//   search_legs    — fan-out: several legs in one execution (the outbound and
//                    return candidates of a trip), each to `fares/<key>`, plus a
//                    `trip/<label>` digest. A failed leg is recorded, not thrown.
//   booking_links  — where one itinerary can be bought (airline first), by
//                    `ignavId` from a search or by carrier + flight number.
//
// Times are kept as the API gives them: local to each airport, with the IANA
// timezone and the UTC instant alongside. Prices are approximate ("from"); the
// booking page has the current one.

const GlobalArgsSchema = z.object({
  apiKey: z.string().meta({ sensitive: true }).describe(
    "Ignav API key (X-Api-Key)",
  ),
  baseUrl: z.string().default("https://ignav.com/api").describe(
    "Ignav API base URL",
  ),
});

const Iata = z.string().regex(/^[A-Za-z]{3}$/, "3-letter IATA code");
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const Hour = z.number().int().min(0).max(23);
const DataName = z.string().regex(
  /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
  "letters, digits, dot, dash, underscore",
);
const Cabin = z.enum(["economy", "premium_economy", "business", "first"]);

const LegFields = {
  origin: Iata.describe("Departure airport or metro code, e.g. SFO"),
  destination: Iata.describe("Arrival airport or metro code, e.g. BOS"),
  date: IsoDate.describe("Departure date, local to the origin"),
  airlines: z.array(z.string().length(2)).optional().describe(
    'Only these 2-character airline codes, e.g. ["UA"]',
  ),
  maxStops: z.number().int().min(0).max(2).optional().describe(
    "0 = nonstop only; omit for any",
  ),
  cabin: Cabin.default("economy"),
  adults: z.number().int().min(1).max(9).default(1),
  departAfter: Hour.optional().describe(
    "Earliest departure hour (0-23), origin local time",
  ),
  departBefore: Hour.optional().describe(
    "Latest departure hour (0-23), origin local time",
  ),
  arriveAfter: Hour.optional().describe(
    "Earliest arrival hour (0-23), destination local time",
  ),
  arriveBefore: Hour.optional().describe(
    "Latest arrival hour (0-23), destination local time",
  ),
};

const SearchArgsSchema = z.object({
  ...LegFields,
  label: DataName.default("latest").describe("Data name for the result"),
});

const LegInputSchema = z.object({
  key: DataName.describe("Data name for this leg, e.g. out-mon-redeye"),
  ...LegFields,
});

const SearchLegsArgsSchema = z.object({
  legs: z.array(LegInputSchema).min(1).max(20).describe(
    "[{key, origin, destination, date, airlines?, maxStops?, departAfter?, departBefore?, arriveAfter?, arriveBefore?, cabin?, adults?}]",
  ),
  concurrency: z.number().int().min(1).max(5).default(3),
  label: DataName.default("latest").describe("Data name for the digest"),
});

const BookingLinksArgsSchema = z.object({
  ignavId: z.string().optional().describe(
    "`ignavId` of an option from search / search_legs (preferred)",
  ),
  origin: Iata.optional(),
  destination: Iata.optional(),
  date: IsoDate.optional(),
  carrier: z.string().length(2).optional().describe("e.g. UA"),
  flightNumber: z.string().optional().describe("e.g. 796"),
  label: DataName.default("latest").describe("Data name for the result"),
});

const PriceSchema = z.object({
  amount: z.number().nullable(),
  currency: z.string().nullable(),
  status: z.string().nullable(),
});

const SegmentSchema = z.object({
  flight: z.string().nullable(),
  operatedBy: z.string().nullable(),
  from: z.string(),
  to: z.string(),
  departLocal: z.string(),
  departTimezone: z.string().nullable(),
  departUtc: z.string().nullable(),
  arriveLocal: z.string(),
  arriveTimezone: z.string().nullable(),
  arriveUtc: z.string().nullable(),
  durationMinutes: z.number().nullable(),
  aircraft: z.string().nullable(),
});

const OptionSchema = z.object({
  ignavId: z.string().nullable(),
  flights: z.array(z.string()),
  carrier: z.string().nullable(),
  stops: z.number(),
  durationMinutes: z.number().nullable(),
  departLocal: z.string().nullable(),
  departUtc: z.string().nullable(),
  arriveLocal: z.string().nullable(),
  arriveUtc: z.string().nullable(),
  price: PriceSchema,
  cabin: z.string().nullable(),
  mixedCarriers: z.boolean(),
  segments: z.array(SegmentSchema),
});

const QuerySchema = z.object({
  origin: z.string(),
  destination: z.string(),
  date: z.string(),
  airlines: z.array(z.string()).nullable(),
  maxStops: z.number().nullable(),
  cabin: z.string(),
  adults: z.number(),
  departAfter: z.number().nullable(),
  departBefore: z.number().nullable(),
  arriveAfter: z.number().nullable(),
  arriveBefore: z.number().nullable(),
});

const FaresSchema = z.object({
  generatedAt: z.string(),
  key: z.string(),
  query: QuerySchema,
  observedAt: z.string().nullable(),
  count: z.number(),
  options: z.array(OptionSchema),
  error: z.string().nullable(),
});

const TripSchema = z.object({
  generatedAt: z.string(),
  label: z.string(),
  requests: z.number(),
  legs: z.array(z.object({
    key: z.string(),
    route: z.string(),
    date: z.string(),
    count: z.number(),
    earliestArrival: z.string().nullable(),
    latestDeparture: z.string().nullable(),
    cheapest: z.number().nullable(),
    flights: z.array(z.string()),
    error: z.string().nullable(),
  })),
});

const BookingSchema = z.object({
  generatedAt: z.string(),
  lookup: z.record(z.string(), z.string()),
  itinerary: OptionSchema.nullable(),
  links: z.array(z.object({
    provider: z.string(),
    providerType: z.string().nullable(),
    fareName: z.string().nullable(),
    specificity: z.string().nullable(),
    legs: z.array(z.string()),
    price: PriceSchema,
    url: z.string(),
  })),
});

type Doc = Record<string, unknown>;
type Ctx = { globalArgs: z.infer<typeof GlobalArgsSchema> };
type Leg = z.infer<typeof LegInputSchema>;
type Option = z.infer<typeof OptionSchema>;
type Fares = z.infer<typeof FaresSchema>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Error carrying Ignav's machine-readable `code` ("itinerary_not_found", …). */
export class IgnavError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "IgnavError";
  }
}

/**
 * POST to Ignav. Retries what the docs say to retry: 503 (honouring
 * Retry-After), 424 `unable_to_complete_request`, and network failures.
 * Every other 4xx is a request to fix, and failed requests are never billed.
 */
async function ignav(context: Ctx, path: string, body: Doc): Promise<Doc> {
  const url = `${context.globalArgs.baseUrl.replace(/\/$/, "")}${path}`;
  for (let attempt = 0;; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "X-Api-Key": context.globalArgs.apiKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90_000),
      });
    } catch (e) {
      if (attempt < 3) {
        await sleep(2 ** attempt * 1000);
        continue;
      }
      throw new Error(`Ignav POST ${path} failed: ${(e as Error).message}`);
    }
    const text = await res.text();
    if (res.ok) return JSON.parse(text) as Doc;
    let err: Doc = {};
    try {
      err = ((JSON.parse(text) as Doc).error as Doc) ?? {};
    } catch { /* non-JSON error body */ }
    const code = typeof err.code === "string" ? err.code : null;
    const retryable = res.status === 503 ||
      (res.status === 424 && code === "unable_to_complete_request");
    if (retryable && attempt < 3) {
      const wait = Math.min(
        Number(res.headers.get("retry-after")) || 2 ** attempt,
        15,
      );
      await sleep(wait * 1000);
      continue;
    }
    throw new IgnavError(
      `Ignav POST ${path} failed (${res.status}${code ? ` ${code}` : ""}): ${
        String(err.message ?? text.slice(0, 300))
      }`,
      res.status,
      code,
    );
  }
}

const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const num = (v: unknown) => (typeof v === "number" ? v : null);

function price(p: unknown): z.infer<typeof PriceSchema> {
  const d = (p ?? {}) as Doc;
  return {
    amount: num(d.amount),
    currency: str(d.currency),
    status: str(d.status),
  };
}

/** One Ignav itinerary (its `outbound` direction) → a flat option. */
export function toOption(it: Doc): Option {
  const out = (it.outbound ?? {}) as Doc;
  const segments = ((out.segments as Doc[]) ?? []).map((s) => ({
    flight: s.marketing_carrier_code && s.flight_number
      ? `${s.marketing_carrier_code}${s.flight_number}`
      : null,
    operatedBy: str(s.operating_carrier_name),
    from: String(s.departure_airport ?? ""),
    to: String(s.arrival_airport ?? ""),
    departLocal: String(s.departure_time_local ?? ""),
    departTimezone: str(s.departure_timezone),
    departUtc: str(s.departure_time_utc),
    arriveLocal: String(s.arrival_time_local ?? ""),
    arriveTimezone: str(s.arrival_timezone),
    arriveUtc: str(s.arrival_time_utc),
    durationMinutes: num(s.duration_minutes),
    aircraft: str(s.aircraft),
  }));
  const first = segments[0], last = segments.at(-1);
  return {
    ignavId: str(it.ignav_id),
    flights: segments.map((s) => s.flight).filter((f): f is string => !!f),
    carrier: str(out.carrier),
    stops: Math.max(segments.length - 1, 0),
    durationMinutes: num(out.duration_minutes),
    departLocal: first?.departLocal || null,
    departUtc: first?.departUtc ?? null,
    arriveLocal: last?.arriveLocal || null,
    arriveUtc: last?.arriveUtc ?? null,
    price: price(it.price),
    cabin: str(it.cabin_class),
    mixedCarriers: it.has_mixed_carriers === true,
    segments,
  };
}

/** The request body for one one-way leg; unset filters are left out. */
export function legBody(leg: Omit<Leg, "key">): Doc {
  const range: Doc = {};
  if (leg.departAfter !== undefined) range.earliest_hour = leg.departAfter;
  if (leg.departBefore !== undefined) range.latest_hour = leg.departBefore;
  if (leg.arriveAfter !== undefined) {
    range.arrival_earliest_hour = leg.arriveAfter;
  }
  if (leg.arriveBefore !== undefined) {
    range.arrival_latest_hour = leg.arriveBefore;
  }
  return {
    origin: leg.origin.toUpperCase(),
    destination: leg.destination.toUpperCase(),
    departure_date: leg.date,
    adults: leg.adults,
    cabin_class: leg.cabin,
    ...(leg.maxStops !== undefined ? { max_stops: leg.maxStops } : {}),
    ...(leg.airlines?.length
      ? { airlines_include: leg.airlines.map((a) => a.toUpperCase()) }
      : {}),
    ...(Object.keys(range).length ? { departure_time_range: range } : {}),
  };
}

function queryOf(leg: Omit<Leg, "key">): z.infer<typeof QuerySchema> {
  return {
    origin: leg.origin.toUpperCase(),
    destination: leg.destination.toUpperCase(),
    date: leg.date,
    airlines: leg.airlines?.map((a) => a.toUpperCase()) ?? null,
    maxStops: leg.maxStops ?? null,
    cabin: leg.cabin,
    adults: leg.adults,
    departAfter: leg.departAfter ?? null,
    departBefore: leg.departBefore ?? null,
    arriveAfter: leg.arriveAfter ?? null,
    arriveBefore: leg.arriveBefore ?? null,
  };
}

/** Search one leg. Options come back ordered by departure time. */
async function searchLeg(
  context: Ctx,
  key: string,
  leg: Omit<Leg, "key">,
): Promise<Fares> {
  const body = await ignav(context, "/fares/one-way", legBody(leg));
  const options = ((body.itineraries as Doc[]) ?? []).map(toOption).sort((
    a,
    b,
  ) => (a.departLocal ?? "").localeCompare(b.departLocal ?? ""));
  return {
    generatedAt: new Date().toISOString(),
    key,
    query: queryOf(leg),
    observedAt: str(body.observed_at),
    count: options.length,
    options,
    error: null,
  };
}

/** Ignav flight fares: one-way leg search, a multi-leg fan-out, and booking links. */
export const model = {
  type: "@keeb/ignav",
  version: "2026.11.17.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    fares: {
      description:
        "One one-way leg search: the query, and every option ordered by departure (flight numbers, local and UTC times, stops, duration, price, `ignavId`). Keyed by `label` (search) or the leg `key` (search_legs); each run appends a version.",
      schema: FaresSchema,
      lifetime: "infinite",
      garbageCollection: 30,
    },
    trip: {
      description:
        "Digest of one search_legs run: per leg the option count, earliest arrival, latest departure, cheapest price and flight numbers, or the error. Keyed by `label`.",
      schema: TripSchema,
      lifetime: "infinite",
      garbageCollection: 30,
    },
    booking: {
      description:
        "Where one itinerary can be bought: the refreshed itinerary and each seller's link, airline sellers first. Keyed by `label`.",
      schema: BookingSchema,
      lifetime: "infinite",
      garbageCollection: 30,
    },
  },
  methods: {
    search: {
      description:
        "Search one-way fares for one route and date, optionally filtered by airline, stops and departure/arrival hours.",
      arguments: SearchArgsSchema,
      execute: async (args: z.infer<typeof SearchArgsSchema>, context) => {
        const { label, ...leg } = args;
        context.logger.info("Ignav {o}→{d} on {date}", {
          o: leg.origin,
          d: leg.destination,
          date: leg.date,
        });
        const fares = await searchLeg(context, label, leg);
        context.logger.info("{n} options", { n: fares.count });
        const handle = await context.writeResource("fares", label, fares);
        return { dataHandles: [handle] };
      },
    },
    search_legs: {
      description:
        "Search several one-way legs in one execution (e.g. every outbound and return candidate of a trip). Writes fares/<key> per leg and a trip/<label> digest; a leg that fails is recorded on that leg and the run continues.",
      arguments: SearchLegsArgsSchema,
      execute: async (args: z.infer<typeof SearchLegsArgsSchema>, context) => {
        const keys = new Set(args.legs.map((l) => l.key));
        if (keys.size !== args.legs.length) {
          throw new Error("leg keys must be unique");
        }
        context.logger.info("Searching {n} legs on Ignav", {
          n: args.legs.length,
        });
        const results: Fares[] = new Array(args.legs.length);
        const handles: Awaited<ReturnType<typeof context.writeResource>>[] = [];
        let writes: Promise<unknown> = Promise.resolve();
        let next = 0;
        await Promise.all(
          Array.from(
            { length: Math.min(args.concurrency, args.legs.length) },
            async () => {
              while (next < args.legs.length) {
                const i = next++;
                const { key, ...leg } = args.legs[i];
                let r: Fares;
                try {
                  r = await searchLeg(context, key, leg);
                } catch (e) {
                  r = {
                    generatedAt: new Date().toISOString(),
                    key,
                    query: queryOf(leg),
                    observedAt: null,
                    count: 0,
                    options: [],
                    error: (e as Error).message,
                  };
                }
                results[i] = r;
                writes = writes.then(async () =>
                  handles.push(await context.writeResource("fares", key, r))
                );
              }
            },
          ),
        );
        await writes;
        const legs = results.map((r) => {
          const arrivals = r.options.map((o) => o.arriveLocal).filter((
            a,
          ): a is string => !!a).sort();
          const departures = r.options.map((o) => o.departLocal).filter((
            d,
          ): d is string => !!d).sort();
          const prices = r.options.map((o) => o.price.amount).filter((
            p,
          ): p is number => p !== null);
          return {
            key: r.key,
            route: `${r.query.origin}-${r.query.destination}`,
            date: r.query.date,
            count: r.count,
            earliestArrival: arrivals[0] ?? null,
            latestDeparture: departures.at(-1) ?? null,
            cheapest: prices.length ? Math.min(...prices) : null,
            flights: r.options.map((o) => o.flights.join("+")),
            error: r.error,
          };
        });
        const failed = legs.filter((l) => l.error).length;
        context.logger.info("{ok} legs searched, {failed} failed", {
          ok: legs.length - failed,
          failed,
        });
        handles.push(
          await context.writeResource("trip", args.label, {
            generatedAt: new Date().toISOString(),
            label: args.label,
            requests: legs.length - failed,
            legs,
          }),
        );
        return { dataHandles: handles };
      },
    },
    booking_links: {
      description:
        "Get booking links for one itinerary: pass `ignavId` from a search, or origin + destination + date + carrier + flightNumber. Airline sellers are listed first.",
      arguments: BookingLinksArgsSchema,
      execute: async (
        args: z.infer<typeof BookingLinksArgsSchema>,
        context,
      ) => {
        let request: Doc;
        const lookup: Record<string, string> = {};
        if (args.ignavId) {
          request = { ignav_id: args.ignavId };
          lookup.ignavId = args.ignavId;
        } else if (
          args.origin && args.destination && args.date && args.carrier &&
          args.flightNumber
        ) {
          request = {
            origin: args.origin.toUpperCase(),
            destination: args.destination.toUpperCase(),
            departure_date: args.date,
            outbound_carrier_code: args.carrier.toUpperCase(),
            outbound_flight_number: args.flightNumber,
          };
          lookup.flight =
            `${request.outbound_carrier_code}${args.flightNumber}`;
          lookup.route = `${request.origin}-${request.destination}`;
          lookup.date = args.date;
        } else {
          throw new Error(
            "pass `ignavId`, or all of origin, destination, date, carrier and flightNumber",
          );
        }
        const body = await ignav(context, "/fares/booking-links", request);
        const links = ((body.booking_options as Doc[]) ?? []).flatMap((o) =>
          ((o.links as Doc[]) ?? []).map((l) => ({
            provider: String(l.provider_name ?? ""),
            providerType: str(l.provider_type),
            fareName: str(l.fare_name),
            specificity: str(l.specificity),
            legs: Array.isArray(o.legs) ? (o.legs as string[]) : [],
            price: price(l.price),
            url: String(l.url ?? ""),
          }))
        ).sort((a, b) =>
          Number(b.providerType === "airline") -
          Number(a.providerType === "airline")
        );
        context.logger.info("{n} booking links", { n: links.length });
        const handle = await context.writeResource("booking", args.label, {
          generatedAt: new Date().toISOString(),
          lookup,
          itinerary: body.itinerary ? toOption(body.itinerary as Doc) : null,
          links,
        });
        return { dataHandles: [handle] };
      },
    },
  },
} satisfies ModelDefinition<typeof GlobalArgsSchema>;
