import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import {
  createModelTestContext,
  withMockedFetch,
} from "jsr:@systeminit/swamp-testing@0.20260604.20";
import { legBody, model, toOption } from "./ignav.ts";

const globalArgs = { apiKey: "test-key", baseUrl: "https://ignav.example.com" };

function segment(
  flight: string,
  dep: string,
  arr: string,
  from = "SFO",
  to = "BOS",
) {
  return {
    marketing_carrier_code: "UA",
    flight_number: flight,
    operating_carrier_name: "United Airlines",
    departure_airport: from,
    departure_time_local: dep,
    departure_timezone: "America/Los_Angeles",
    departure_time_utc: null,
    arrival_airport: to,
    arrival_time_local: arr,
    arrival_timezone: "America/New_York",
    arrival_time_utc: null,
    duration_minutes: 330,
    aircraft: "Boeing 737 MAX 9",
  };
}

function itinerary(id: string, amount: number, ...segments: unknown[]) {
  return {
    ignav_id: id,
    price: { amount, currency: "USD", status: "verified" },
    outbound: { carrier: "United Airlines", duration_minutes: 330, segments },
    cabin_class: "economy",
    has_mixed_carriers: false,
  };
}

const redeye = itinerary(
  "id-redeye",
  420,
  segment("796", "2026-11-23T21:25:00", "2026-11-24T06:21:00"),
);
const morning = itinerary(
  "id-morning",
  380,
  segment("371", "2026-11-23T07:00:00", "2026-11-23T15:40:00"),
);

/** Serves the Ignav API; `reply` maps (path, body) to a Response. */
function api(
  reply: (path: string, body: Record<string, unknown>) => Response,
  seen: { path: string; body: Record<string, unknown> }[] = [],
) {
  return async (req: Request) => {
    if (req.headers.get("x-api-key") !== "test-key") {
      return Response.json({
        error: { type: "auth_error", code: "invalid_api_key", message: "no" },
      }, { status: 401 });
    }
    const path = new URL(req.url).pathname;
    const body = await req.json();
    seen.push({ path, body });
    return reply(path, body);
  };
}

const leg = {
  origin: "sfo",
  destination: "bos",
  date: "2026-11-23",
  cabin: "economy" as const,
  adults: 1,
};

Deno.test("legBody: unset filters are left out", () => {
  assertEquals(legBody(leg), {
    origin: "SFO",
    destination: "BOS",
    departure_date: "2026-11-23",
    adults: 1,
    cabin_class: "economy",
  });
});

Deno.test("legBody: airline, nonstop and hour windows", () => {
  assertEquals(
    legBody({
      ...leg,
      airlines: ["ua"],
      maxStops: 0,
      departAfter: 20,
      arriveBefore: 9,
    }),
    {
      origin: "SFO",
      destination: "BOS",
      departure_date: "2026-11-23",
      adults: 1,
      cabin_class: "economy",
      max_stops: 0,
      airlines_include: ["UA"],
      departure_time_range: { earliest_hour: 20, arrival_latest_hour: 9 },
    },
  );
});

Deno.test("toOption: a connection spans first departure to last arrival", () => {
  const o = toOption(itinerary(
    "id-conn",
    300,
    segment("100", "2026-11-23T06:00:00", "2026-11-23T12:10:00", "SFO", "ORD"),
    segment("200", "2026-11-23T13:30:00", "2026-11-23T16:45:00", "ORD", "BOS"),
  ));
  assertEquals(o.flights, ["UA100", "UA200"]);
  assertEquals(o.stops, 1);
  assertEquals(o.departLocal, "2026-11-23T06:00:00");
  assertEquals(o.arriveLocal, "2026-11-23T16:45:00");
  assertEquals(o.price.amount, 300);
});

Deno.test("search: options stored by departure time under label", async () => {
  const seen: { path: string; body: Record<string, unknown> }[] = [];
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });
  await withMockedFetch(
    api(() =>
      Response.json({
        observed_at: "2026-11-17T20:00:00Z",
        itineraries: [redeye, morning],
      }), seen),
    () =>
      model.methods.search.execute(
        { ...leg, airlines: ["UA"], maxStops: 0, label: "out" },
        context as never,
      ),
  );
  assertEquals(seen[0].path, "/fares/one-way");
  assertEquals(seen[0].body.airlines_include, ["UA"]);
  const [r] = getWrittenResources();
  assertEquals(`${r.specName}/${r.name}`, "fares/out");
  assertEquals(r.data.count, 2);
  const options = r.data.options as { flights: string[] }[];
  assertEquals(options.map((o) => o.flights[0]), ["UA371", "UA796"]);
  assertEquals(r.data.observedAt, "2026-11-17T20:00:00Z");
});

Deno.test("search: an empty itinerary list is a result, not an error", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });
  await withMockedFetch(
    api(() => Response.json({ itineraries: [] })),
    () =>
      model.methods.search.execute({ ...leg, label: "none" }, context as never),
  );
  assertEquals(getWrittenResources()[0].data.count, 0);
});

Deno.test("search: a 400 is thrown with Ignav's code, without retry", async () => {
  const seen: { path: string; body: Record<string, unknown> }[] = [];
  const { context } = createModelTestContext({ globalArgs });
  await assertRejects(
    () =>
      withMockedFetch(
        api(() =>
          Response.json({
            error: {
              type: "invalid_request",
              code: "departure_date_in_past",
              message: "departure_date is in the past.",
            },
          }, { status: 400 }), seen),
        () =>
          model.methods.search.execute(
            { ...leg, label: "past" },
            context as never,
          ),
      ),
    Error,
    "departure_date_in_past",
  );
  assertEquals(seen.length, 1);
});

Deno.test("search: 503 is retried after Retry-After", async () => {
  let calls = 0;
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });
  await withMockedFetch(
    api(() =>
      ++calls === 1
        ? Response.json({
          error: { type: "upstream_error", code: "server_busy", message: "x" },
        }, { status: 503, headers: { "retry-after": "0.01" } })
        : Response.json({ itineraries: [redeye] })
    ),
    () =>
      model.methods.search.execute({ ...leg, label: "busy" }, context as never),
  );
  assertEquals(calls, 2);
  assertEquals(getWrittenResources()[0].data.count, 1);
});

Deno.test("search_legs: one resource per leg, a digest, and a failed leg recorded", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });
  await withMockedFetch(
    api((_path, body) =>
      body.origin === "BOS"
        ? Response.json({
          error: {
            type: "invalid_request",
            code: "invalid_fare_request",
            message: "nope",
          },
        }, { status: 400 })
        : Response.json({ itineraries: [redeye, morning] })
    ),
    () =>
      model.methods.search_legs.execute({
        legs: [
          { key: "out", ...leg },
          { key: "back", ...leg, origin: "BOS", destination: "SFO" },
        ],
        concurrency: 1,
        label: "boston",
      }, context as never),
  );
  const written = getWrittenResources();
  const by = (n: string) =>
    written.find((w) => `${w.specName}/${w.name}` === n)!;
  assertEquals(by("fares/out").data.count, 2);
  assertEquals(String(by("fares/back").data.error).includes("400"), true);
  const digest = by("trip/boston").data as {
    requests: number;
    legs: Record<string, unknown>[];
  };
  assertEquals(digest.requests, 1);
  assertEquals(digest.legs[0].earliestArrival, "2026-11-23T15:40:00");
  assertEquals(digest.legs[0].latestDeparture, "2026-11-23T21:25:00");
  assertEquals(digest.legs[0].cheapest, 380);
  assertEquals(digest.legs[0].flights, ["UA371", "UA796"]);
  assertEquals(typeof digest.legs[1].error, "string");
});

Deno.test("search_legs: a rejected key fails the run and writes nothing", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { ...globalArgs, apiKey: "wrong" },
  });
  await assertRejects(
    () =>
      withMockedFetch(
        api(() => Response.json({ itineraries: [] })),
        () =>
          model.methods.search_legs.execute({
            legs: [{ key: "out", ...leg }, { key: "back", ...leg }],
            concurrency: 1,
            label: "t",
          }, context as never),
      ),
    Error,
    "invalid_api_key",
  );
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("search_legs: a label that is also a leg key throws before any request", async () => {
  const seen: { path: string; body: Record<string, unknown> }[] = [];
  const { context } = createModelTestContext({ globalArgs });
  await assertRejects(
    () =>
      withMockedFetch(
        api(() => Response.json({ itineraries: [] }), seen),
        () =>
          model.methods.search_legs.execute({
            legs: [{ key: "boston", ...leg }],
            concurrency: 1,
            label: "boston",
          }, context as never),
      ),
    Error,
    "also a leg key",
  );
  assertEquals(seen.length, 0);
});

Deno.test("search_legs: duplicate keys throw before any request", async () => {
  const seen: { path: string; body: Record<string, unknown> }[] = [];
  const { context } = createModelTestContext({ globalArgs });
  await assertRejects(
    () =>
      withMockedFetch(
        api(() => Response.json({ itineraries: [] }), seen),
        () =>
          model.methods.search_legs.execute({
            legs: [{ key: "a", ...leg }, { key: "a", ...leg }],
            concurrency: 1,
            label: "t",
          }, context as never),
      ),
    Error,
    "unique",
  );
  assertEquals(seen.length, 0);
});

Deno.test("booking_links: by ignavId, airline sellers first", async () => {
  const seen: { path: string; body: Record<string, unknown> }[] = [];
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });
  await withMockedFetch(
    api(() =>
      Response.json({
        itinerary: redeye,
        booking_options: [{
          legs: ["outbound"],
          links: [
            {
              provider_name: "Expedia",
              provider_type: "third_party",
              price: { amount: 431, currency: "USD", status: "verified" },
              url: "https://expedia.example/x",
            },
            {
              provider_name: "United Airlines",
              provider_type: "airline",
              fare_name: "Economy",
              specificity: "exact_flight",
              price: { amount: 420, currency: "USD", status: "verified" },
              url: "https://united.example/x",
            },
          ],
        }],
      }), seen),
    () =>
      model.methods.booking_links.execute(
        { ignavId: "id-redeye", label: "redeye" },
        context as never,
      ),
  );
  assertEquals(seen[0].path, "/fares/booking-links");
  assertEquals(seen[0].body, { ignav_id: "id-redeye" });
  const [r] = getWrittenResources();
  assertEquals(`${r.specName}/${r.name}`, "booking/redeye");
  const links = r.data.links as { provider: string; url: string }[];
  assertEquals(links.map((l) => l.provider), ["United Airlines", "Expedia"]);
  assertEquals((r.data.itinerary as { flights: string[] }).flights, ["UA796"]);
});

Deno.test("booking_links: by flight number sends the manual fields", async () => {
  const seen: { path: string; body: Record<string, unknown> }[] = [];
  const { context } = createModelTestContext({ globalArgs });
  await withMockedFetch(
    api(() => Response.json({ itinerary: redeye, booking_options: [] }), seen),
    () =>
      model.methods.booking_links.execute({
        origin: "sfo",
        destination: "bos",
        date: "2026-11-23",
        carrier: "ua",
        flightNumber: "796",
        label: "manual",
      }, context as never),
  );
  assertEquals(seen[0].body, {
    origin: "SFO",
    destination: "BOS",
    departure_date: "2026-11-23",
    outbound_carrier_code: "UA",
    outbound_flight_number: "796",
  });
});

Deno.test("booking_links: neither lookup mode throws", async () => {
  const { context } = createModelTestContext({ globalArgs });
  await assertRejects(
    () =>
      model.methods.booking_links.execute(
        { origin: "SFO", label: "t" },
        context as never,
      ),
    Error,
    "ignavId",
  );
});
