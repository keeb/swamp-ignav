# @keeb/ignav

Flight fares from [Ignav](https://ignav.com/docs) for swamp. Built for one
question: which flights get me somewhere by a given time, and back.

## Model

| Model         | Method          | What it does                                                                    |
| ------------- | --------------- | ------------------------------------------------------------------------------- |
| `@keeb/ignav` | `search`        | One one-way leg: route + date, filtered by airline, stops and hour windows      |
|               | `search_legs`   | Several legs in one execution; `fares/<key>` per leg and a `trip/<label>` digest |
|               | `booking_links` | Where one itinerary can be bought, airline sellers first                        |

### Filters

Every leg takes `origin`, `destination` and `date` (local to the origin), plus:

- `airlines` — only these 2-character codes, e.g. `["UA"]`
- `maxStops` — `0` for nonstop only
- `departAfter` / `departBefore` — hours 0-23, origin local time
- `arriveAfter` / `arriveBefore` — hours 0-23, destination local time
- `cabin` (`economy` by default) and `adults`

### What is stored

Each option has its flight numbers, stops, duration, price, an `ignavId`, and
its departure and arrival as local time with the IANA timezone and the UTC
instant. Options are ordered by departure. A red-eye's arrival carries the next
day's date.

No options is a result (`count: 0`), not an error. In `search_legs` a leg that
fails is recorded on that leg and the others still run.

Prices are approximate. The booking page has the current one.

### search_legs

```yaml
legs:
  - { key: out-mon-day,    origin: SFO, destination: BOS, date: "2026-11-23", airlines: [UA], maxStops: 0, departBefore: 13 }
  - { key: out-mon-redeye, origin: SFO, destination: BOS, date: "2026-11-23", airlines: [UA], maxStops: 0, departAfter: 20 }
  - { key: back-tue,       origin: BOS, destination: SFO, date: "2026-11-24", airlines: [UA], maxStops: 0, departAfter: 14 }
label: boston
```

### booking_links

Pass `ignavId` from an option, or `origin`, `destination`, `date`, `carrier`
and `flightNumber`. Each link says whether it opens the exact flight or a
search results page (`specificity`).

## Setup

Ignav gives 1,000 free requests with no card, then bills $2 per 1,000
successful requests. Each leg searched and each booking lookup is one request.

```bash
swamp vault create local_encryption ignav
printf '%s' "$IGNAV_API_KEY" | swamp vault put ignav apiKey

swamp model create @keeb/ignav ignav
# globalArguments:
#   apiKey: ${{ vault.get(ignav, apiKey) }}

swamp model method run ignav search \
  --input origin=SFO --input destination=BOS --input date=2026-11-23 \
  --input 'airlines=["UA"]' --input maxStops=0 --input label=out

swamp data query 'behavior("ignav") && name == "out"' --select attributes.options
```

## License

MIT
