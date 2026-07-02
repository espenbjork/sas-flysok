# SAS-flysøk

Nettverktøy som lister **alle SAS-flygninger (SK)** fra en valgt skandinavisk flyplass
i en valgt tidsperiode. Avganger eller ankomster, gruppert per dag, med CSV-eksport.

Bygget som én Cloudflare Worker som serverer både frontend (statisk) og API-proxy.

## Datakilder

| Land | Kilde | Nøkkel | Hvor langt frem |
|---|---|---|---|
| Norge | Avinor XmlFeed | Ingen | ~14 dager |
| Sverige | Swedavia FlightInfo v2 | Gratis (registrering) | 90 dager |
| Danmark | AeroDataBox (RapidAPI) | Valgfri, freemium | Måneder |

API-et normaliserer alle kildene til samme JSON-format og filtrerer på SK-flightnummer
(inkluderer SAS Link/SAS Connect, ikke codeshare på andre selskaper).

## Kjøre lokalt

```bash
cd sas-flysok
cp .dev.vars.example .dev.vars   # og lim inn Swedavia-nøkkel hvis du har
npx wrangler dev
```

Åpne http://localhost:8787. Norske flyplasser fungerer uten noen nøkler.

## Deploy

```bash
npx wrangler deploy
npx wrangler secret put SWEDAVIA_KEY      # for svenske flyplasser
npx wrangler secret put AERODATABOX_KEY   # valgfritt, for danske
```

## API

```
GET /api/flights?airport=OSL&from=2026-07-02&to=2026-07-09&direction=D
```

- `airport`: IATA-kode (OSL, ARN, CPH …)
- `from`/`to`: YYYY-MM-DD (maks 31 dager)
- `direction`: `D` avganger, `A` ankomster

Svar: `{ airport, from, to, source, warnings, count, flights: [{ flightId, scheduledUtc, otherIata, otherName, gate, terminal, status, … }] }`

Svar caches i 5 minutter.
