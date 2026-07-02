/**
 * SAS-flysøk – API-proxy som henter flygninger fra tre kilder og
 * normaliserer dem til ett felles format:
 *
 *   - Avinor XmlFeed (norske flyplasser)   – gratis, ingen nøkkel, ~14 dager frem
 *   - Swedavia FlightInfo v2 (svenske)     – gratis nøkkel, 90 dager frem  (env.SWEDAVIA_KEY)
 *   - AeroDataBox (danske / alt annet)     – valgfri betalt nøkkel        (env.AERODATABOX_KEY)
 *
 * GET /api/flights?airport=OSL&from=2026-07-02&to=2026-07-09&direction=D
 *   direction: D (avganger), A (ankomster), B (begge)
 */

const SWEDAVIA_AIRPORTS = new Set(['ARN', 'BMA', 'GOT', 'MMX', 'LLA', 'UME', 'OSD', 'VBY', 'RNB', 'KRN']);
const DANISH_AIRPORTS = new Set(['CPH', 'BLL', 'AAL', 'AAR']);

const AVINOR_MAX_HOURS_FORWARD = 336; // feeden gir ~14 dager frem
const AVINOR_MAX_HOURS_BACK = 48;
const MAX_RANGE_DAYS = 31;
const CACHE_TTL_SECONDS = 300;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }
    if (url.pathname !== '/api/flights') {
      return json({ error: 'Ukjent endepunkt. Bruk /api/flights' }, 404);
    }

    const cache = caches.default;
    const cacheKey = new Request(url.toString());
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    let result;
    try {
      result = await handleFlights(url.searchParams, env);
    } catch (err) {
      return json({ error: `Uventet feil: ${err.message}` }, 502);
    }
    if (result.error) return json(result, result.status || 400);

    const response = json(result, 200, { 'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}` });
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  },
};

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS, ...extraHeaders },
  });
}

async function handleFlights(params, env) {
  const airport = (params.get('airport') || '').toUpperCase().trim();
  const direction = (params.get('direction') || 'D').toUpperCase();
  const fromStr = params.get('from');
  const toStr = params.get('to');

  if (!/^[A-Z]{3}$/.test(airport)) return { error: 'Ugyldig flyplasskode (IATA, 3 bokstaver)', status: 400 };
  if (!['D', 'A', 'B'].includes(direction)) return { error: 'direction må være D, A eller B', status: 400 };
  if (!isIsoDate(fromStr) || !isIsoDate(toStr)) return { error: 'from/to må være på formatet YYYY-MM-DD', status: 400 };

  const from = new Date(`${fromStr}T00:00:00Z`);
  const to = new Date(`${toStr}T23:59:59Z`);
  if (to < from) return { error: 'til-dato er før fra-dato', status: 400 };

  const rangeDays = Math.ceil((to - from) / 86400000);
  const warnings = [];
  if (rangeDays > MAX_RANGE_DAYS) {
    return { error: `Maks søkeperiode er ${MAX_RANGE_DAYS} dager`, status: 400 };
  }

  let flights;
  let source;

  if (SWEDAVIA_AIRPORTS.has(airport)) {
    source = 'Swedavia';
    if (!env.SWEDAVIA_KEY) {
      return {
        error:
          'Svenske flyplasser krever en (gratis) Swedavia API-nøkkel. ' +
          'Registrer deg på apideveloper.swedavia.se og legg nøkkelen inn som SWEDAVIA_KEY.',
        status: 501,
      };
    }
    flights = await fetchSwedavia(airport, fromStr, toStr, direction, env.SWEDAVIA_KEY);
  } else if (DANISH_AIRPORTS.has(airport)) {
    source = 'AeroDataBox';
    if (!env.AERODATABOX_KEY) {
      return {
        error:
          'Danske flyplasser krever en AeroDataBox-nøkkel (rapidapi.com). ' +
          'Legg den inn som AERODATABOX_KEY for å aktivere København m.fl.',
        status: 501,
      };
    }
    flights = await fetchAeroDataBox(airport, from, to, direction, env.AERODATABOX_KEY, warnings);
  } else {
    source = 'Avinor';
    flights = await fetchAvinor(airport, from, to, direction, warnings);
  }

  // Bare SAS (SK), og bare innenfor det eksakte tidsvinduet
  const sas = flights
    .filter((f) => f.airline === 'SK')
    .filter((f) => {
      const t = new Date(f.scheduledUtc);
      return t >= from && t <= to;
    })
    .sort((a, b) => a.scheduledUtc.localeCompare(b.scheduledUtc));

  return {
    airport,
    from: fromStr,
    to: toStr,
    direction,
    source,
    warnings,
    count: sas.length,
    flights: sas,
    fetchedAt: new Date().toISOString(),
  };
}

function isIsoDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/* ---------------------------- Avinor (Norge) ---------------------------- */

async function fetchAvinor(airport, from, to, direction, warnings) {
  const now = Date.now();
  let hoursBack = Math.max(0, Math.ceil((now - from.getTime()) / 3600000));
  let hoursForward = Math.max(1, Math.ceil((to.getTime() - now) / 3600000));

  if (hoursBack > AVINOR_MAX_HOURS_BACK) {
    hoursBack = AVINOR_MAX_HOURS_BACK;
    warnings.push('Avinor gir bare data ca. 2 døgn tilbake i tid – eldre flygninger vises ikke.');
  }
  if (hoursForward > AVINOR_MAX_HOURS_FORWARD) {
    hoursForward = AVINOR_MAX_HOURS_FORWARD;
    warnings.push('Avinor gir bare data ca. 14 dager frem i tid – flygninger lenger frem vises ikke.');
  }
  if (to.getTime() < now) hoursForward = 1;

  // Uten direction-parameter returnerer feeden både avganger og ankomster
  const dirParam = direction === 'B' ? '' : `&direction=${direction}`;
  const url =
    `https://asrv.avinor.no/XmlFeed/v1.0?airport=${airport}` +
    `&TimeFrom=${hoursBack}&TimeTo=${hoursForward}${dirParam}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Avinor svarte ${res.status}`);
  const xml = await res.text();

  const flights = [];
  const flightBlocks = xml.match(/<flight [^>]*>[\s\S]*?<\/flight>/g) || [];
  for (const block of flightBlocks) {
    const tag = (name) => {
      const m = block.match(new RegExp(`<${name}>([^<]*)</${name}>`));
      return m ? m[1] : '';
    };
    const statusMatch = block.match(/<status code="([A-Z])"/);
    const arrDep = tag('arr_dep');
    flights.push({
      flightId: tag('flight_id'),
      airline: tag('airline'),
      direction: arrDep || (direction === 'B' ? 'D' : direction),
      scheduledUtc: tag('schedule_time'),
      otherIata: tag('airport'),
      otherName: null,
      via: tag('via_airport') || null,
      domInt: tag('dom_int') || null,
      gate: tag('gate') || null,
      terminal: null,
      checkIn: tag('check_in') || null,
      status: avinorStatus(statusMatch ? statusMatch[1] : null),
    });
  }
  return flights;
}

function avinorStatus(code) {
  const map = { N: 'Ny info', E: 'Ny tid', D: 'Avgått', A: 'Ankommet', C: 'Kansellert' };
  return code ? map[code] || code : 'Planlagt';
}

/* --------------------------- Swedavia (Sverige) --------------------------- */

async function fetchSwedavia(airport, fromStr, toStr, direction, key) {
  const dirs = direction === 'B' ? ['D', 'A'] : [direction];
  const dates = listDates(fromStr, toStr);
  const flights = [];

  for (const dir of dirs) {
    const kind = dir === 'D' ? 'departures' : 'arrivals';
    for (const date of dates) {
      const url = `https://api.swedavia.se/flightinfo/v2/${airport}/${kind}/${date}`;
      const res = await fetch(url, {
        headers: { 'Ocp-Apim-Subscription-Key': key, Accept: 'application/json' },
      });
      if (res.status === 401 || res.status === 403) {
        throw new Error('Swedavia avviste API-nøkkelen (sjekk SWEDAVIA_KEY)');
      }
      if (!res.ok) throw new Error(`Swedavia svarte ${res.status} for ${date}`);
      const data = await res.json();

      const list = pick(data, 'flights') || [];
      for (const f of list) {
        const op = pick(f, 'airlineOperator') || {};
        const time = pick(f, dir === 'D' ? 'departureTime' : 'arrivalTime') || {};
        const loc = pick(f, 'locationAndStatus') || {};
        const flightId = pick(f, 'flightId') || '';
        flights.push({
          flightId,
          airline: pick(op, 'iata') || flightId.slice(0, 2),
          direction: dir,
          scheduledUtc: pick(time, 'scheduledUtc') || '',
          otherIata: pick(f, dir === 'D' ? 'arrivalAirportIata' : 'departureAirportIata') || null,
          otherName: pick(f, dir === 'D' ? 'arrivalAirportEnglish' : 'departureAirportEnglish') || null,
          via: null,
          domInt: null,
          gate: pick(loc, 'gate') || null,
          terminal: pick(loc, 'terminal') || null,
          checkIn: null,
          status: swedaviaStatus(pick(loc, 'flightLegStatus')),
        });
      }
    }
  }
  return flights.filter((f) => f.scheduledUtc);
}

function swedaviaStatus(code) {
  const map = {
    SCH: 'Planlagt',
    FPL: 'Planlagt',
    SEQ: 'Planlagt',
    ACT: 'Aktiv',
    DEP: 'Avgått',
    LAN: 'Landet',
    CAN: 'Kansellert',
    FLS: 'Innstilt',
    RER: 'Omdirigert',
    DIV: 'Omdirigert',
    DEL: 'Slettet',
  };
  return code ? map[code] || code : 'Planlagt';
}

// Swedavia-JSON kan komme i både camelCase og PascalCase
function pick(obj, key) {
  if (!obj) return undefined;
  if (obj[key] !== undefined) return obj[key];
  const pascal = key[0].toUpperCase() + key.slice(1);
  return obj[pascal];
}

function listDates(fromStr, toStr) {
  const dates = [];
  const d = new Date(`${fromStr}T00:00:00Z`);
  const end = new Date(`${toStr}T00:00:00Z`);
  while (d <= end) {
    dates.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return dates;
}

/* ------------------------ AeroDataBox (Danmark m.m.) ------------------------ */

function adbStatus(status) {
  const map = {
    Unknown: 'Planlagt', Expected: 'Planlagt', CheckIn: 'Innsjekk', Boarding: 'Ombordstigning',
    GateClosed: 'Gate stengt', Departed: 'Avgått', Delayed: 'Forsinket', EnRoute: 'Aktiv',
    Approaching: 'Aktiv', Arrived: 'Ankommet', Canceled: 'Kansellert',
    CanceledUncertain: 'Trolig kansellert', Diverted: 'Omdirigert',
  };
  return status ? map[status] || status : 'Planlagt';
}

async function fetchAeroDataBox(airport, from, to, direction, key, warnings) {
  const flights = [];
  const windowMs = 12 * 3600000; // maks 12 timer per kall
  let cursor = from.getTime();
  let calls = 0;
  const maxCalls = 2 * MAX_RANGE_DAYS;

  while (cursor < to.getTime() && calls < maxCalls) {
    const winEnd = Math.min(cursor + windowMs, to.getTime());
    const fromLocal = new Date(cursor).toISOString().slice(0, 16);
    const toLocal = new Date(winEnd).toISOString().slice(0, 16);
    const dirParam = direction === 'B' ? '' : `&direction=${direction === 'D' ? 'Departure' : 'Arrival'}`;
    const url =
      `https://aerodatabox.p.rapidapi.com/flights/airports/iata/${airport}/${fromLocal}/${toLocal}` +
      `?withCodeshared=false&withCancelled=true&withCargo=false&withPrivate=false${dirParam}`;
    const res = await fetch(url, {
      headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': 'aerodatabox.p.rapidapi.com' },
    });
    calls++;
    if (res.status === 401 || res.status === 403) throw new Error('AeroDataBox avviste API-nøkkelen');
    if (res.status === 429) {
      warnings.push('AeroDataBox-kvoten er brukt opp – resultatet kan være ufullstendig.');
      break;
    }
    if (res.ok) {
      const data = await res.json();
      const lists = [];
      if (direction !== 'A') lists.push(['D', data.departures || []]);
      if (direction !== 'D') lists.push(['A', data.arrivals || []]);
      for (const [dir, list] of lists) {
        for (const f of list) {
          const mv = f.movement || {};
          flights.push({
            flightId: (f.number || '').replace(/\s+/g, ''),
            airline: f.airline?.iata || (f.number || '').slice(0, 2),
            direction: dir,
            scheduledUtc: mv.scheduledTime?.utc || '',
            otherIata: mv.airport?.iata || null,
            otherName: mv.airport?.name || null,
            via: null,
            domInt: null,
            gate: mv.gate || null,
            terminal: mv.terminal || null,
            checkIn: null,
            status: adbStatus(f.status),
          });
        }
      }
    }
    cursor = winEnd;
  }
  return flights.filter((f) => f.scheduledUtc);
}
