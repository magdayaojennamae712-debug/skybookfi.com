// ============================================================
// NordicWings - server.js
// Express backend: serves the app, proxies Sky Scrapper flight
// search (keeping API keys secret), and handles Stripe payments.
// ============================================================

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const helmet      = require('helmet');
const compression = require('compression');
const rateLimit  = require('express-rate-limit');
const stripe     = require('stripe')(process.env.STRIPE_SECRET_KEY);
const nodemailer = require('nodemailer');
const cron       = require('node-cron');
const fs         = require('fs');
const path       = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';
app.set('trust proxy', 1); // Trust Railway's proxy for rate limiting

// ── Security: Helmet (sets safe HTTP headers) ─────────────────
app.use(helmet({
  // Content Security Policy: restrict what scripts/styles/connections are allowed
  contentSecurityPolicy:    false,  // Disabled — Firebase + Stripe + inline scripts need this off
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: false,
  // Prevent clickjacking
  frameguard: { action: 'sameorigin' },
  // Hide server info from attackers
  hidePoweredBy: true,
  // Prevent MIME sniffing
  noSniff: true,
  // Force HTTPS
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  // Prevent XSS
  xssFilter: true,
  // Referrer policy
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

// ── Security: CORS (only allow your own domain) ───────────────
const allowedOrigins = [
  'http://localhost:3000',
  'https://nordicwings.net',
  'https://www.nordicwings.net',
  'https://nordicwings-production.up.railway.app'
];
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

// ── Security: Block suspicious User-Agents (scanners/bots) ──────
app.use((req, res, next) => {
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  const blocked = ['sqlmap', 'nikto', 'masscan', 'nmap', 'zgrab', 'python-requests/2.', 'go-http-client/1', 'curl/'];
  if (blocked.some(b => ua.includes(b))) {
    return res.status(403).json({ error: 'Access denied.' });
  }
  next();
});

// ── Security: Rate Limiting ────────────────────────────────────
// General limiter: max 100 requests per 15 minutes per IP
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Strict limiter for payment routes: max 10 per 15 minutes
const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many payment attempts. Please try again later.' },
});

// Flight search limiter: max 30 searches per 15 minutes
const searchLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Too many searches. Please slow down and try again.' },
});

app.use(generalLimiter);

// ── Performance: Gzip compression (improves page speed & SEO) ──
app.use(compression());

// ── Middleware ───────────────────────────────────────────────
app.use(express.json({ limit: '10kb' })); // Limit body size to prevent attacks

// Static files with Cache-Control headers
app.use(express.static('public', {
  etag: true,
  lastModified: true,
  setHeaders: function(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
    if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', isProd ? 'public, max-age=604800' : 'no-cache');
    }
    if (/\.(png|jpg|jpeg|gif|svg|webp|ico)$/.test(filePath)) {
      res.setHeader('Cache-Control', isProd ? 'public, max-age=2592000' : 'no-cache');
    }
  }
}));

// ── Security: Input Sanitizer ─────────────────────────────────
// Strips dangerous characters from inputs
function sanitize(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>'"`;]/g, '').trim().substring(0, 200);
}

// Validate IATA airport code (must be 2-4 uppercase letters)
function isValidAirportCode(code) {
  return /^[A-Z]{2,4}$/.test(code);
}

// Validate date format YYYY-MM-DD
function isValidDate(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const date = new Date(dateStr);
  const today = new Date();
  today.setHours(0,0,0,0);
  return date >= today; // Must be today or future
}

// ── RapidAPI / Sky Scrapper config ───────────────────────────
const RAPIDAPI_KEY  = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = 'sky-scrapper.p.rapidapi.com';

// ── Hotelbeds API config ──────────────────────────────────────
const HOTELBEDS_API_KEY = process.env.HOTELBEDS_API_KEY || '2c2c92e707865ec80970569434ecdbaf';
const HOTELBEDS_SECRET  = process.env.HOTELBEDS_SECRET  || '4e909ddcd9';
const HOTELBEDS_BASE    = 'https://api.test.hotelbeds.com'; // switch to api.hotelbeds.com when live

function getHotelbedsHeaders() {
  const crypto = require('crypto');
  const timestamp = Math.round(Date.now() / 1000).toString();
  const signature = crypto.createHash('sha256')
    .update(HOTELBEDS_API_KEY + HOTELBEDS_SECRET + timestamp)
    .digest('hex');
  return {
    'Api-key':        HOTELBEDS_API_KEY,
    'X-Signature':    signature,
    'Accept':         'application/json',
    'Content-Type':   'application/json',
    'Accept-Encoding':'gzip'
  };
}

// ── Tequila (Kiwi.com) API config ────────────────────────────
// PRIMARY flight source — real flights, no balance needed
// Customer pays on Kiwi.com directly. Commission earned via API key.
// Sign up free at: tequila.kiwi.com
const TEQUILA_API_KEY = process.env.TEQUILA_API_KEY;
const TEQUILA_BASE    = 'https://api.tequila.kiwi.com';

function formatTequilaDate(isoDate) {
  const [y, m, d] = isoDate.split('-');
  return `${d}/${m}/${y}`;
}

async function searchTequilaFlights(orig, dest, date, adults, children=0, infants=0, cabinClass='economy') {
  if (!TEQUILA_API_KEY) return null;
  const cabinMap = { economy:'M', premium_economy:'W', business:'C', first:'F' };
  const cabin = cabinMap[cabinClass] || 'M';
  const params = new URLSearchParams({
    fly_from: orig, fly_to: dest,
    date_from: formatTequilaDate(date), date_to: formatTequilaDate(date),
    adults, children, infants,
    selected_cabins: cabin,
    curr: 'EUR', locale: 'en', limit: 20,
    vehicle_type: 'aircraft', sort: 'price', partner_market: 'fi'
  });
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    const res = await fetch(`${TEQUILA_BASE}/v2/search?${params}`, {
      headers: { 'apikey': TEQUILA_API_KEY }, signal: controller.signal
    });
    clearTimeout(timeout);
    if (!res.ok) { console.error('Tequila error:', res.status); return null; }
    const data = await res.json();
    const offers = data.data || [];
    if (!offers.length) return null;
    console.log(`Tequila returned ${offers.length} flights for ${orig}→${dest}`);
    const cabin_name = cabin==='C'?'BUSINESS':cabin==='F'?'FIRST':cabin==='W'?'PREMIUM_ECONOMY':'ECONOMY';
    return offers.map(f => {
      const totalSecs = f.duration?.departure || 0;
      const hrs  = Math.floor(totalSecs / 3600);
      const mins = Math.floor((totalSecs % 3600) / 60);
      const segments = (f.route || []).map(seg => {
        const depMs  = new Date(seg.local_departure).getTime();
        const arrMs  = new Date(seg.local_arrival).getTime();
        const sHrs   = Math.floor((arrMs-depMs)/3600000);
        const sMins  = Math.floor(((arrMs-depMs)%3600000)/60000);
        return {
          departure: { iataCode: seg.flyFrom, at: seg.local_departure },
          arrival:   { iataCode: seg.flyTo,   at: seg.local_arrival   },
          carrierCode: seg.airline,
          number: String(seg.flight_no||'').replace(seg.airline,'').trim()||'0',
          duration: `PT${sHrs}H${sMins}M`
        };
      });
      return {
        id: `tequila-${f.id}`,
        tequilaDeepLink: f.deep_link,
        price: { grandTotal: f.price.toFixed(2), currency:'EUR' },
        baggage: { checkedQty: f.bags_price?.[1] ? 0 : 0, cabinQty: 1 },
        itineraries: [{ duration:`PT${hrs}H${mins}M`, segments }],
        travelerPricings: [{ fareDetailsBySegment:[{ cabin: cabin_name }] }]
      };
    });
  } catch (err) {
    console.error('Tequila search error:', err.message);
    return null;
  }
}

// ── Duffel API config (fallback) ──────────────────────────────
const DUFFEL_API_KEY  = process.env.DUFFEL_API_KEY;
const DUFFEL_BASE_URL = 'https://api.duffel.com';
// NordicWings service fee: 3% of base fare, minimum €8 per ticket
const MARKUP_RATE    = 0.03;  // 3% on every ticket
const MARKUP_MIN_FEE = 8;     // minimum €8 booking fee regardless of price

async function searchDuffelFlights(orig, dest, date, adults, children = 0, infants = 0, cabinClass = 'economy') {
  if (!DUFFEL_API_KEY) return null;

  // Build passengers array — Duffel supports adult, child, infant_without_seat
  const passengers = [];
  for (let i = 0; i < adults;   i++) passengers.push({ type: 'adult' });
  for (let i = 0; i < children; i++) passengers.push({ type: 'child' });
  for (let i = 0; i < infants;  i++) passengers.push({ type: 'infant_without_seat' });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(`${DUFFEL_BASE_URL}/air/offer_requests?return_offers=true`, {
      method: 'POST',
      headers: {
        'Authorization':  `Bearer ${DUFFEL_API_KEY}`,
        'Duffel-Version': 'v2',
        'Content-Type':   'application/json',
        'Accept':         'application/json'
      },
      body: JSON.stringify({
        data: {
          slices: [{ origin: orig, destination: dest, departure_date: date }],
          passengers,
          cabin_class: cabinClass
        }
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const err = await res.text();
      console.error('Duffel error response:', err.substring(0, 300));
      return null;
    }

    const json = await res.json();
    const offers = json?.data?.offers || [];
    if (!offers.length) {
      console.log('Duffel returned 0 offers');
      return null;
    }

    console.log(`Duffel returned ${offers.length} offers`);

    // Sort cheapest first so customers always see best price at top
    offers.sort((a, b) => parseFloat(a.total_amount || 9999) - parseFloat(b.total_amount || 9999));

    // Map Duffel offers to NordicWings flight format — show up to 20
    const flights = [];
    for (let i = 0; i < Math.min(offers.length, 20); i++) {
      try {
        const offer = offers[i];
        const slice = offer.slices?.[0];
        if (!slice) continue;

        const segments = (slice.segments || []).map(seg => ({
          departure: { iataCode: seg.origin?.iata_code || orig, at: seg.departing_at || date },
          arrival:   { iataCode: seg.destination?.iata_code || dest, at: seg.arriving_at || date },
          carrierCode: seg.marketing_carrier?.iata_code || seg.operating_carrier?.iata_code || 'XX',
          number: seg.marketing_carrier_flight_designator?.flight_number || String(i * 10 + 100),
          aircraft: seg.aircraft?.iata_code || null,
          duration: seg.duration || 'PT2H0M'
        }));

        if (!segments.length) continue;

        // ── Validate ALL slices (outbound + return) — skip bad / unacceptable Duffel data ──
        let offerIsValid = true;

        for (const checkSlice of (offer.slices || [])) {
          const checkSegs = (checkSlice.segments || []).map(seg => ({
            depAt: seg.departing_at,
            arrAt: seg.arriving_at
          }));
          if (!checkSegs.length) continue;

          // 1) Any segment under 30 min is impossible (corrupt data)
          for (const seg of checkSegs) {
            const diffMins = (new Date(seg.arrAt) - new Date(seg.depAt)) / 60000;
            if (diffMins < 30 || isNaN(diffMins)) {
              console.warn(`Skipping offer ${offer.id} — segment under 30 min (corrupt data)`);
              offerIsValid = false; break;
            }
          }
          if (!offerIsValid) break;

          // 2) More than 3 segments = suspicious routing, block it
          if (checkSegs.length > 3) {
            console.warn(`Skipping offer ${offer.id} — ${checkSegs.length} legs (more than 3 segments)`);
            offerIsValid = false; break;
          }

          // 3) Any layover over 12 hours = too long
          for (let s = 0; s < checkSegs.length - 1; s++) {
            const layoverMins = (new Date(checkSegs[s+1].depAt) - new Date(checkSegs[s].arrAt)) / 60000;
            if (layoverMins > 720) {
              console.warn(`Skipping offer ${offer.id} — layover ${Math.round(layoverMins)}min (over 12h)`);
              offerIsValid = false; break;
            }
          }
          if (!offerIsValid) break;

          // 3) Total journey over 36 hours is likely corrupt data
          const firstDep = new Date(checkSegs[0].depAt);
          const lastArr  = new Date(checkSegs[checkSegs.length - 1].arrAt);
          const totalMins = (lastArr - firstDep) / 60000;
          if (totalMins > 2160) {
            console.warn(`Skipping offer ${offer.id} — total journey ${Math.round(totalMins/60)}h (over 36h, corrupt data)`);
            offerIsValid = false; break;
          }
        }

        if (!offerIsValid) continue;

        const basePrice   = parseFloat(offer.total_amount || 0);
        // 5% markup with minimum €12 service fee
        const feeAmount   = Math.max(MARKUP_MIN_FEE, basePrice * MARKUP_RATE);
        const markedPrice = Math.round((basePrice + feeAmount) * 100) / 100;
        const cabin = offer.slices?.[0]?.segments?.[0]?.passengers?.[0]?.cabin_class_marketing_name || 'ECONOMY';
        const durationMins = slice.duration
          ? (parseInt(slice.duration.match(/(\d+)H/)?.[1] || 0) * 60 + parseInt(slice.duration.match(/(\d+)M/)?.[1] || 0))
          : 120;

        // Fare conditions from Duffel
        const conds = offer.conditions || {};
        const refundable = conds.refund_before_departure?.allowed === true;
        const changeable = conds.change_before_departure?.allowed === true;
        const refundPenalty = conds.refund_before_departure?.penalty_amount || null;
        const changePenalty = conds.change_before_departure?.penalty_amount || null;

        // Extract real baggage from Duffel per passenger per segment
        const firstPassenger = offer.slices?.[0]?.segments?.[0]?.passengers?.[0];
        const baggages = firstPassenger?.baggages || [];
        const checkedBags = baggages.filter(b => b.type === 'checked_baggage');
        const cabinBags   = baggages.filter(b => b.type === 'carry_on_baggage');
        const checkedQty  = checkedBags.reduce((sum, b) => sum + (b.quantity || 0), 0);
        const cabinQty    = cabinBags.reduce((sum, b) => sum + (b.quantity || 0), 0);

        flights.push({
          id: `duffel-${offer.id}`,
          duffelOfferId: offer.id,
          duffelBasePrice: basePrice,
          nordicwingsFee: feeAmount,
          price: {
            grandTotal: markedPrice.toFixed(2),
            currency:   offer.total_currency || 'EUR',
            fees:       [{ amount: feeAmount.toFixed(2) }]
          },
          conditions: { refundable, changeable, refundPenalty, changePenalty },
          baggage: { checkedQty, cabinQty },
          numberOfBookableSeats: offer.available_services?.length || 9,
          itineraries: [{
            duration: slice.duration || `PT${Math.floor(durationMins/60)}H${durationMins%60}M`,
            segments
          }],
          travelerPricings: [{
            fareDetailsBySegment: [{ cabin: cabin.toUpperCase() }]
          }]
        });
      } catch (mapErr) {
        console.error('Duffel map error:', mapErr.message);
      }
    }
    return flights.length ? flights : null;
  } catch (err) {
    clearTimeout(timeout);
    console.error('Duffel search error:', err.message);
    return null;
  }
}

// Helper: make a fetch request to Sky Scrapper
async function skyFetch(path, params) {
  const url = new URL(`https://${RAPIDAPI_HOST}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000); // 10 second timeout

  try {
    const res = await fetch(url.toString(), {
      headers: {
        'X-RapidAPI-Key':  RAPIDAPI_KEY,
        'X-RapidAPI-Host': RAPIDAPI_HOST
      },
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`Sky Scrapper error: ${res.status}`);
    return res.json();
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

// ============================================================
// ROUTE: GET /api/airports/search
// Autocomplete airport/city names from a keyword.
// Used when the user types in the origin or destination field.
// ============================================================
app.get('/api/airports/search', async (req, res) => {
  const { keyword } = req.query;
  if (!keyword || keyword.length < 2) return res.json([]);

  try {
    const data = await skyFetch('/api/v1/flights/searchAirport', {
      query:  keyword,
      locale: 'en-US'
    });

    console.log('Airport search raw data:', JSON.stringify(data).substring(0, 500));

    const airports = (data.data || []).slice(0, 6).map(loc => ({
      iataCode:    loc.skyId,
      entityId:    loc.entityId,
      name:        loc.presentation?.suggestionTitle || loc.skyId,
      cityName:    loc.presentation?.subtitle || '',
      countryName: ''
    }));

    console.log('Airports returned:', JSON.stringify(airports));
    res.json(airports);
  } catch (err) {
    console.error('Airport search error:', err.message);
    res.json([]);
  }
});

// ============================================================
// ROUTE: GET /api/flights/search
// Search real flights using Sky Scrapper API via RapidAPI.
// Query params: origin, destination, departureDate, adults
//               originEntityId, destinationEntityId
// ============================================================
app.get('/api/flights/search', searchLimiter, async (req, res) => {
  const { origin, destination, departureDate, adults, children, infants, cabinClass, originEntityId, destinationEntityId } = req.query;

  // Validate and sanitize all inputs
  const cleanOrigin    = sanitize(origin || '').toUpperCase();
  const cleanDest      = sanitize(destination || '').toUpperCase();
  const cleanDate      = sanitize(departureDate || '');
  const cleanAdults    = Math.min(Math.max(parseInt(adults)   || 1, 1), 9);
  const cleanChildren  = Math.min(Math.max(parseInt(children) || 0, 0), 8);
  const cleanInfants   = Math.min(Math.max(parseInt(infants)  || 0, 0), cleanAdults);
  const validCabins    = ['economy', 'premium_economy', 'business', 'first'];
  const cleanCabin     = validCabins.includes(cabinClass) ? cabinClass : 'economy';

  if (!cleanOrigin || !cleanDest || !cleanDate) {
    return res.status(400).json({ error: 'Please provide origin, destination, and date.' });
  }
  if (!isValidAirportCode(cleanOrigin)) {
    return res.status(400).json({ error: 'Invalid departure airport code.' });
  }
  if (!isValidAirportCode(cleanDest)) {
    return res.status(400).json({ error: 'Invalid destination airport code.' });
  }
  if (!isValidDate(cleanDate)) {
    return res.status(400).json({ error: 'Invalid or past date provided.' });
  }

  // Auto-lookup entityId if missing — tries exact match first, then first result
  async function getEntityId(skyId) {
    try {
      const data = await skyFetch('/api/v1/flights/searchAirport', { query: skyId, locale: 'en-US' });
      const results = data.data || [];
      // Try exact match first
      const exact = results.find(loc => loc.skyId === skyId);
      if (exact?.entityId) return exact.entityId;
      // Fall back to first result
      if (results[0]?.entityId) return results[0].entityId;
      return '';
    } catch { return ''; }
  }

  let resolvedOriginEntityId      = originEntityId;
  let resolvedDestinationEntityId = destinationEntityId;

  // Run both lookups in parallel (faster than sequential)
  if (!resolvedOriginEntityId || !resolvedDestinationEntityId) {
    const [eid1, eid2] = await Promise.all([
      resolvedOriginEntityId      ? Promise.resolve(resolvedOriginEntityId)      : getEntityId(cleanOrigin),
      resolvedDestinationEntityId ? Promise.resolve(resolvedDestinationEntityId) : getEntityId(cleanDest)
    ]);
    resolvedOriginEntityId      = eid1;
    resolvedDestinationEntityId = eid2;
  }

  console.log(`Flight search: ${cleanOrigin} (${resolvedOriginEntityId}) → ${cleanDest} (${resolvedDestinationEntityId}) on ${cleanDate}`);

  // Helper: generate realistic demo flights with correct stopovers and durations
  function generateDemoFlights(orig, dest, date, numAdults) {

    // ── WORLDWIDE AIRPORT → COUNTRY MAP ──────────────────────
    const airportCountry = {
      // Finland
      'HEL':'FI','OUL':'FI','TMP':'FI','TKU':'FI','JYV':'FI','KUO':'FI',
      'JOE':'FI','RVN':'FI','KEM':'FI','IVL':'FI','KAJ':'FI','VAA':'FI','MHQ':'FI',
      // Philippines
      'MNL':'PH','DVO':'PH','CEB':'PH','ILO':'PH','BCD':'PH','KLO':'PH',
      'ZAM':'PH','GES':'PH','DGT':'PH','MPH':'PH','PPS':'PH','TAG':'PH',
      // USA
      'JFK':'US','LAX':'US','ORD':'US','ATL':'US','DFW':'US','DEN':'US',
      'SFO':'US','SEA':'US','MIA':'US','BOS':'US','LAS':'US','PHX':'US',
      'IAH':'US','MSP':'US','DTW':'US','PHL':'US','CLT':'US','EWR':'US',
      'BWI':'US','SLC':'US','HNL':'US','SAN':'US','PDX':'US','AUS':'US',
      'MCO':'US','TPA':'US','BNA':'US','RDU':'US','STL':'US','MCI':'US',
      // UK
      'LHR':'GB','LGW':'GB','MAN':'GB','STN':'GB','EDI':'GB','GLA':'GB',
      'LTN':'GB','BHX':'GB','BRS':'GB','NCL':'GB','LBA':'GB','ABZ':'GB',
      // Germany
      'FRA':'DE','MUC':'DE','BER':'DE','DUS':'DE','HAM':'DE','STR':'DE',
      'CGN':'DE','NUE':'DE','HAJ':'DE','LEJ':'DE','DRS':'DE',
      // France
      'CDG':'FR','ORY':'FR','NCE':'FR','LYS':'FR','MRS':'FR','TLS':'FR',
      'BOD':'FR','NTE':'FR','LIL':'FR',
      // Spain
      'MAD':'ES','BCN':'ES','AGP':'ES','PMI':'ES','ALC':'ES','VLC':'ES',
      'LPA':'ES','TFN':'ES','IBZ':'ES','SVQ':'ES','BIO':'ES',
      // Italy
      'FCO':'IT','MXP':'IT','LIN':'IT','NAP':'IT','VCE':'IT','CIA':'IT',
      'BLQ':'IT','CTA':'IT','PMO':'IT','BRI':'IT','FLR':'IT',
      // Australia
      'SYD':'AU','MEL':'AU','BNE':'AU','PER':'AU','ADL':'AU','CBR':'AU',
      'OOL':'AU','CNS':'AU','DRW':'AU','TSV':'AU','HBA':'AU','MKY':'AU',
      // India
      'DEL':'IN','BOM':'IN','BLR':'IN','MAA':'IN','CCU':'IN','HYD':'IN',
      'COK':'IN','AMD':'IN','GOI':'IN','PNQ':'IN','JAI':'IN','LKO':'IN',
      // Japan
      'NRT':'JP','HND':'JP','KIX':'JP','NGO':'JP','CTS':'JP','OKA':'JP',
      'FUK':'JP','HIJ':'JP','SDJ':'JP','KOJ':'JP','OIT':'JP',
      // China
      'PEK':'CN','PVG':'CN','SHA':'CN','CAN':'CN','SZX':'CN','CTU':'CN',
      'KMG':'CN','WUH':'CN','CSX':'CN','XIY':'CN','HGH':'CN','NKG':'CN',
      // Brazil
      'GRU':'BR','GIG':'BR','BSB':'BR','SSA':'BR','FOR':'BR','REC':'BR',
      'POA':'BR','CWB':'BR','BEL':'BR','MAO':'BR','CGH':'BR','SDU':'BR',
      // Canada
      'YYZ':'CA','YVR':'CA','YUL':'CA','YYC':'CA','YEG':'CA','YOW':'CA',
      'YWG':'CA','YHZ':'CA','YQB':'CA','YYJ':'CA',
      // Indonesia
      'CGK':'ID','DPS':'ID','SUB':'ID','MES':'ID','UPG':'ID','PLM':'ID',
      'PDG':'ID','BPN':'ID','SOC':'ID','AMQ':'ID','MDC':'ID',
      // Thailand
      'BKK':'TH','DMK':'TH','HKT':'TH','CNX':'TH','HDY':'TH','USM':'TH',
      'CEI':'TH','KBV':'TH',
      // Malaysia
      'KUL':'MY','LGK':'MY','PEN':'MY','BKI':'MY','KCH':'MY','JHB':'MY',
      'MYY':'MY','SDK':'MY',
      // Norway
      'OSL':'NO','BGO':'NO','TRD':'NO','SVG':'NO','TOS':'NO','BOO':'NO',
      'ALF':'NO','LKL':'NO','EVE':'NO',
      // Sweden
      'ARN':'SE','GOT':'SE','MMX':'SE','LLA':'SE','UME':'SE','OSD':'SE',
      // Denmark
      'CPH':'DK','AAL':'DK','BLL':'DK','FAE':'DK',
      // Netherlands
      'AMS':'NL','EIN':'NL','RTM':'NL',
      // Turkey
      'IST':'TR','SAW':'TR','ADB':'TR','AYT':'TR','ESB':'TR','TZX':'TR',
      'GZT':'TR','SZF':'TR','BJV':'TR',
      // UAE
      'DXB':'AE','AUH':'AE','SHJ':'AE',
      // South Korea
      'ICN':'KR','GMP':'KR','PUS':'KR','CJU':'KR','CJJ':'KR',
      // Mexico
      'MEX':'MX','CUN':'MX','GDL':'MX','MTY':'MX','TIJ':'MX','OAX':'MX',
      // Argentina
      'EZE':'AR','AEP':'AR','COR':'AR','MDZ':'AR','BRC':'AR','IGR':'AR',
      // South Africa
      'JNB':'ZA','CPT':'ZA','DUR':'ZA','PLZ':'ZA','GRJ':'ZA',
      // New Zealand
      'AKL':'NZ','CHC':'NZ','WLG':'NZ','ZQN':'NZ','DUD':'NZ',
      // Colombia
      'BOG':'CO','MDE':'CO','CTG':'CO','CLO':'CO','BAQ':'CO',
      // Chile
      'SCL':'CL','PMC':'CL','ANF':'CL','IQQ':'CL','CCP':'CL',
      // Portugal
      'LIS':'PT','OPO':'PT','FAO':'PT','PDL':'PT','FNC':'PT',
      // Greece
      'ATH':'GR','SKG':'GR','HER':'GR','RHO':'GR','CFU':'GR','JMK':'GR',
      // Austria
      'VIE':'AT','GRZ':'AT','INN':'AT','SZG':'AT',
      // Switzerland
      'ZRH':'CH','GVA':'CH','BSL':'CH',
      // Poland
      'WAW':'PL','KRK':'PL','KTW':'PL','GDN':'PL','POZ':'PL','WRO':'PL',
      // Romania
      'OTP':'RO','CLJ':'RO','TSR':'RO','IAS':'RO',
      // Hungary
      'BUD':'HU',
      // Czech Republic
      'PRG':'CZ','BRQ':'CZ',
      // Ireland
      'DUB':'IE','ORK':'IE','SNN':'IE',
      // Belgium
      'BRU':'BE','CRL':'BE','LGG':'BE',
      // Pakistan
      'KHI':'PK','LHE':'PK','ISB':'PK','PEW':'PK','MUX':'PK',
      // Bangladesh
      'DAC':'BD','CGP':'BD','JSR':'BD',
      // Sri Lanka
      'CMB':'LK',
      // Nepal
      'KTM':'NP','PKR':'NP',
      // Egypt
      'CAI':'EG','HRG':'EG','SSH':'EG','LXR':'EG','ASW':'EG',
      // Kenya
      'NBO':'KE','MBA':'KE','KIS':'KE',
      // Nigeria
      'LOS':'NG','ABV':'NG','PHC':'NG','KAN':'NG',
      // Ethiopia
      'ADD':'ET','DIR':'ET',
      // Russia
      'SVO':'RU','DME':'RU','LED':'RU','OVB':'RU','SVX':'RU','KZN':'RU',
      // Ukraine (pre-war routes)
      'KBP':'UA','LWO':'UA',
      // Singapore
      'SIN':'SG',
      // Hong Kong
      'HKG':'HK',
      // Taiwan
      'TPE':'TW','KHH':'TW','RMQ':'TW',
      // Vietnam
      'SGN':'VN','HAN':'VN','DAD':'VN','CXR':'VN','UIH':'VN',
      // Cambodia
      'PNH':'KH','REP':'KH',
      // Morocco
      'CMN':'MA','RAK':'MA','AGA':'MA','FEZ':'MA','TNG':'MA',
    };

    // ── DOMESTIC AIRLINES BY COUNTRY ─────────────────────────
    const domesticConfig = {
      'FI': { airlines:['AY','AY','AY','AY','AY','AY'], price:[45,95],  mins:60,  stops:[] },
      'PH': { airlines:['PR','5J','Z2','PR','5J','Z2'], price:[25,70],  mins:70,  stops:[] },
      'US': { airlines:['AA','UA','DL','WN','B6','AS'], price:[80,280], mins:180, stops:[] },
      'GB': { airlines:['BA','EI','BE','BA','FR','LM'], price:[50,180], mins:75,  stops:[] },
      'AU': { airlines:['QF','VA','JQ','QF','VA','JQ'], price:[60,200], mins:120, stops:[] },
      'IN': { airlines:['AI','6E','SG','G8','AI','6E'], price:[30,120], mins:90,  stops:[] },
      'JP': { airlines:['JL','NH','BC','GK','JL','NH'], price:[60,180], mins:80,  stops:[] },
      'CN': { airlines:['CA','MU','CZ','HU','3U','ZH'], price:[50,180], mins:120, stops:[] },
      'BR': { airlines:['G3','LA','AD','G3','LA','AD'], price:[50,180], mins:120, stops:[] },
      'CA': { airlines:['AC','WS','F8','AC','WS','AC'], price:[80,300], mins:150, stops:[] },
      'ID': { airlines:['GA','JT','QZ','SJ','ID','IN'], price:[25,100], mins:75,  stops:[] },
      'TH': { airlines:['TG','FD','WE','DD','TG','FD'], price:[30,100], mins:75,  stops:[] },
      'MY': { airlines:['MH','AK','OD','MH','AK','OD'], price:[25,90],  mins:75,  stops:[] },
      'NO': { airlines:['SK','DY','SK','DY','SK','DY'], price:[40,140], mins:65,  stops:[] },
      'SE': { airlines:['SK','DY','SK','DY','FR','SK'], price:[40,140], mins:65,  stops:[] },
      'DE': { airlines:['LH','EW','4U','LH','FR','LH'], price:[60,180], mins:75,  stops:[] },
      'ES': { airlines:['IB','VY','FR','VY','IB','FR'], price:[35,150], mins:90,  stops:[] },
      'IT': { airlines:['AZ','FR','U2','AZ','FR','U2'], price:[35,150], mins:90,  stops:[] },
      'TR': { airlines:['TK','PC','TK','PC','TK','XQ'], price:[30,120], mins:80,  stops:[] },
      'ZA': { airlines:['SA','FA','MN','SA','FA','MN'], price:[40,150], mins:90,  stops:[] },
      'MX': { airlines:['AM','Y4','VB','AM','Y4','VB'], price:[40,140], mins:90,  stops:[] },
      'KR': { airlines:['KE','OZ','7C','LJ','KE','OZ'], price:[50,150], mins:55,  stops:[] },
      'AR': { airlines:['AR','JA','LA','AR','JA','AR'], price:[40,150], mins:90,  stops:[] },
      'NZ': { airlines:['NZ','JQ','NZ','JQ','NZ','JQ'], price:[50,160], mins:60,  stops:[] },
      'CO': { airlines:['AV','LA','VX','AV','LA','AV'], price:[35,130], mins:60,  stops:[] },
      'CL': { airlines:['LA','JJ','LA','JJ','LA','JJ'], price:[40,140], mins:80,  stops:[] },
      'PT': { airlines:['TP','FR','U2','TP','FR','U2'], price:[40,130], mins:60,  stops:[] },
      'GR': { airlines:['A3','FR','U2','A3','FR','A3'], price:[40,140], mins:60,  stops:[] },
      'PK': { airlines:['PK','PA','ER','PK','PA','PK'], price:[25,100], mins:80,  stops:[] },
      'EG': { airlines:['MS','HF','ZS','MS','HF','MS'], price:[30,110], mins:60,  stops:[] },
      'NG': { airlines:['QS','IB','LH','QS','IB','QS'], price:[30,120], mins:70,  stops:[] },
      'RU': { airlines:['SU','S7','UT','SU','S7','UT'], price:[40,180], mins:120, stops:[] },
      'VN': { airlines:['VN','VJ','QH','VN','VJ','QH'], price:[25,90],  mins:80,  stops:[] },
      'MA': { airlines:['AT','TO','AT','TO','AT','TO'], price:[30,110], mins:70,  stops:[] },
    };

    // Real-world route data: total duration (minutes) + stopover airports
    const routeData = {
      // European short-haul (direct)
      default_short: { totalMins: 180, stops: [], basePrice: 120 },
      // Medium-haul (direct)
      default_medium: { totalMins: 360, stops: [], basePrice: 280 },
      // Long-haul (1 stop)
      default_long: { totalMins: 840, stops: ['DXB'], basePrice: 520 },
    };

    // Known real routes with accurate data
    const knownRoutes = {
      // ── Finnish domestic ──────────────────────────────────────
      'HEL-OUL': { totalMins: 65,  stops: [], basePrice: 60,  airlines: ['AY','AY','AY','AY','AY','AY'] },
      'HEL-TMP': { totalMins: 45,  stops: [], basePrice: 45,  airlines: ['AY','AY','AY','AY','AY','AY'] },
      'HEL-TKU': { totalMins: 40,  stops: [], basePrice: 42,  airlines: ['AY','AY','AY','AY','AY','AY'] },
      'HEL-JYV': { totalMins: 50,  stops: [], basePrice: 52,  airlines: ['AY','AY','AY','AY','AY','AY'] },
      'HEL-KUO': { totalMins: 55,  stops: [], basePrice: 58,  airlines: ['AY','AY','AY','AY','AY','AY'] },
      'HEL-JOE': { totalMins: 60,  stops: [], basePrice: 62,  airlines: ['AY','AY','AY','AY','AY','AY'] },
      'HEL-RVN': { totalMins: 90,  stops: [], basePrice: 75,  airlines: ['AY','AY','AY','AY','AY','AY'] },
      'HEL-IVL': { totalMins: 105, stops: [], basePrice: 88,  airlines: ['AY','AY','AY','AY','AY','AY'] },
      'HEL-KAJ': { totalMins: 70,  stops: [], basePrice: 65,  airlines: ['AY','AY','AY','AY','AY','AY'] },
      'HEL-VAA': { totalMins: 55,  stops: [], basePrice: 55,  airlines: ['AY','AY','AY','AY','AY','AY'] },
      'HEL-KEM': { totalMins: 95,  stops: [], basePrice: 80,  airlines: ['AY','AY','AY','AY','AY','AY'] },
      'OUL-TMP': { totalMins: 60,  stops: [], basePrice: 55,  airlines: ['AY','AY','AY','AY','AY','AY'] },
      'OUL-TKU': { totalMins: 70,  stops: [], basePrice: 60,  airlines: ['AY','AY','AY','AY','AY','AY'] },
      // ── Finland to Europe ─────────────────────────────────────
      'HEL-LHR': { totalMins: 195, stops: [], basePrice: 130, airlines: ['AY','BA','SK','LH','U2','FR'] },
      'HEL-CDG': { totalMins: 210, stops: [], basePrice: 138, airlines: ['AY','AF','LH','BA','SK','U2'] },
      'HEL-AMS': { totalMins: 195, stops: [], basePrice: 125, airlines: ['AY','KL','LH','BA','SK','U2'] },
      'HEL-FRA': { totalMins: 185, stops: [], basePrice: 122, airlines: ['AY','LH','BA','AF','SK','U2'] },
      'HEL-BCN': { totalMins: 300, stops: [], basePrice: 145, airlines: ['AY','VY','FR','IB','U2','SK'] },
      'HEL-MAD': { totalMins: 315, stops: [], basePrice: 148, airlines: ['AY','IB','FR','VY','LH','BA'] },
      'HEL-FCO': { totalMins: 270, stops: [], basePrice: 142, airlines: ['AY','AZ','FR','LH','BA','U2'] },
      'HEL-ATH': { totalMins: 270, stops: [], basePrice: 155, airlines: ['AY','A3','LH','BA','FR','SK'] },
      'HEL-IST': { totalMins: 225, stops: [], basePrice: 160, airlines: ['AY','TK','LH','BA','FR','PC'] },
      'HEL-VIE': { totalMins: 175, stops: [], basePrice: 118, airlines: ['AY','OS','LH','BA','SK','U2'] },
      'HEL-ZRH': { totalMins: 200, stops: [], basePrice: 135, airlines: ['AY','LX','LH','BA','SK','U2'] },
      'HEL-ARN': { totalMins: 60,  stops: [], basePrice: 55,  airlines: ['AY','SK','DY','SK','AY','DY'] },
      'HEL-CPH': { totalMins: 90,  stops: [], basePrice: 72,  airlines: ['AY','SK','DY','SK','AY','DY'] },
      'HEL-OSL': { totalMins: 105, stops: [], basePrice: 78,  airlines: ['AY','SK','DY','SK','AY','DY'] },
      'HEL-WAW': { totalMins: 150, stops: [], basePrice: 98,  airlines: ['AY','LO','FR','LH','SK','U2'] },
      'HEL-BUD': { totalMins: 185, stops: [], basePrice: 112, airlines: ['AY','W6','LH','BA','FR','SK'] },
      'HEL-PRG': { totalMins: 175, stops: [], basePrice: 108, airlines: ['AY','OK','LH','BA','FR','W6'] },
      'HEL-DUB': { totalMins: 195, stops: [], basePrice: 130, airlines: ['AY','EI','FR','BA','SK','LH'] },
      // ── Finland long haul ─────────────────────────────────────
      'HEL-DXB': { totalMins: 390, stops: [], basePrice: 310,  airlines: ['AY','EK','QR','TK','LH','FZ'] },
      'HEL-BKK': { totalMins: 810, stops: ['DXB'], basePrice: 590, airlines: ['AY','EK','TG','QR','TK','LH'] },
      'HEL-SIN': { totalMins: 870, stops: ['DXB'], basePrice: 620, airlines: ['AY','SQ','EK','QR','TK','LH'] },
      'HEL-MNL': { totalMins: 960, stops: ['DXB'], basePrice: 650, airlines: ['AY','EK','QR','TK','PR','LH'] },
      'HEL-JFK': { totalMins: 570, stops: ['LHR'], basePrice: 480, airlines: ['AY','BA','LH','AF','KL','TK'] },
      'HEL-LAX': { totalMins: 690, stops: ['LHR'], basePrice: 540, airlines: ['AY','BA','LH','AF','KL','AA'] },
      'HEL-NRT': { totalMins: 870, stops: ['HKG'], basePrice: 680, airlines: ['AY','JL','NH','KL','LH','BA'] },
      'HEL-PEK': { totalMins: 780, stops: [], basePrice: 580,  airlines: ['AY','CA','LH','KL','BA','AF'] },
      'HEL-DVO': { totalMins: 1020,stops: ['DXB'], basePrice: 680, airlines: ['AY','EK','QR','TK','PR','LH'] },
      // ── Philippine domestic ───────────────────────────────────
      'MNL-DVO': { totalMins: 90,  stops: [], basePrice: 38,  airlines: ['PR','5J','Z2','PR','5J','Z2'] },
      'DVO-MNL': { totalMins: 90,  stops: [], basePrice: 38,  airlines: ['PR','5J','Z2','PR','5J','Z2'] },
      'MNL-CEB': { totalMins: 60,  stops: [], basePrice: 28,  airlines: ['PR','5J','Z2','PR','5J','Z2'] },
      'CEB-MNL': { totalMins: 60,  stops: [], basePrice: 28,  airlines: ['PR','5J','Z2','PR','5J','Z2'] },
      'DVO-CEB': { totalMins: 55,  stops: [], basePrice: 25,  airlines: ['PR','5J','Z2','PR','5J','Z2'] },
      'CEB-DVO': { totalMins: 55,  stops: [], basePrice: 25,  airlines: ['PR','5J','Z2','PR','5J','Z2'] },
      'MNL-ILO': { totalMins: 55,  stops: [], basePrice: 28,  airlines: ['PR','5J','Z2','PR','5J','Z2'] },
      'MNL-BCD': { totalMins: 60,  stops: [], basePrice: 30,  airlines: ['PR','5J','Z2','PR','5J','Z2'] },
      // ── Popular international ──────────────────────────────────
      'LHR-JFK': { totalMins: 435, stops: [], basePrice: 380, airlines: ['BA','VS','AA','UA','DL','U2'] },
      'LHR-DXB': { totalMins: 405, stops: [], basePrice: 290, airlines: ['BA','EK','QR','TK','LH','FZ'] },
      'LHR-SYD': { totalMins: 1260,stops: ['SIN'], basePrice: 980, airlines: ['BA','QF','SQ','EK','QR','TK'] },
      'CDG-JFK': { totalMins: 510, stops: [], basePrice: 420, airlines: ['AF','UA','AA','DL','BA','KL'] },
      'DXB-SIN': { totalMins: 420, stops: [], basePrice: 250, airlines: ['EK','SQ','QR','TK','FZ','MH'] },
      'DXB-BKK': { totalMins: 390, stops: [], basePrice: 220, airlines: ['EK','TG','QR','TK','FZ','MH'] },
      'BKK-SIN': { totalMins: 135, stops: [], basePrice: 80,  airlines: ['TG','SQ','FD','AK','MH','QZ'] },
      'SIN-MNL': { totalMins: 195, stops: [], basePrice: 110, airlines: ['SQ','PR','5J','CX','MH','QZ'] },
      'SIN-NRT': { totalMins: 420, stops: [], basePrice: 310, airlines: ['SQ','JL','NH','CX','MH','TG'] },
      'AMS-JFK': { totalMins: 525, stops: [], basePrice: 400, airlines: ['KL','UA','DL','AA','BA','AF'] },
    };

    const key    = `${orig}-${dest}`;
    const revKey = `${dest}-${orig}`;
    let route = knownRoutes[key] || knownRoutes[revKey];

    // Smart fallback — detect route type from airport codes
    if (!route) {
      const origCountry = airportCountry[orig];
      const destCountry = airportCountry[dest];
      const isDomestic  = origCountry && destCountry && origCountry === destCountry;

      if (isDomestic && domesticConfig[origCountry]) {
        // True domestic flight — use country-specific config
        const cfg = domesticConfig[origCountry];
        const mins = cfg.mins + Math.floor(Math.random() * 30);
        const price = cfg.price[0] + Math.floor(Math.random() * (cfg.price[1] - cfg.price[0]));
        route = { totalMins: mins, stops: [], basePrice: price, airlines: cfg.airlines };
      } else if (isDomestic) {
        // Domestic but country not in config — generic short haul
        route = { totalMins: 90, stops: [], basePrice: 70, airlines: ['AY','LH','BA','AF','KL','TK'] };
      } else {
        // International — estimate by hubs
        const majorHubs = ['HEL','LHR','CDG','AMS','FRA','JFK','LAX','SYD','NRT','SIN','DXB','ICN','PEK','PVG','BKK','KUL','DEL','BOM','GRU','MEX','JNB'];
        const isLongHaul = majorHubs.includes(orig) || majorHubs.includes(dest);
        if (isLongHaul) {
          route = { totalMins: 600, stops: ['DXB'], basePrice: 420, airlines: ['EK','QR','TK','BA','LH','AY'] };
        } else {
          route = { totalMins: 180, stops: [], basePrice: 120, airlines: ['LH','BA','AF','KL','TK','AY'] };
        }
      }
    }

    // Use route-specific airlines
    const airlineCodes = route.airlines || ['AY','LH','BA','AF','KL','TK'];
    const flightBases  = [100,200,300,400,500,600];
    const priceMods    = [1.0, 2.8, 0.95, 1.0, 0.90, 0.95]; // index 1 = business class

    const options = airlineCodes.map((code, idx) => ({
      code,
      flightBase:    flightBases[idx] || 100 + idx * 100,
      cabinPriceMod: priceMods[idx]   || 1.0,
    }));

    const departureTimes = ['06:15', '08:30', '10:45', '13:00', '15:30', '18:00'];

    return options.map((al, i) => {
      const depTimeStr  = `${date}T${departureTimes[i % departureTimes.length]}:00`;
      const depDate     = new Date(depTimeStr);
      const basePrice   = route.basePrice * al.cabinPriceMod * numAdults;
      const price       = Math.round(basePrice + (i % 3) * 40);
      const isBusiness  = i === 1; // Second option is business class
      const businessMod = isBusiness ? 2.8 : 1;
      const finalPrice  = Math.round(price * businessMod);

      // Build segments
      const segments = [];

      if (route.stops.length === 0) {
        // Direct flight
        const arrDate = new Date(depDate.getTime() + route.totalMins * 60000);
        segments.push({
          departure: { iataCode: orig, at: depDate.toISOString() },
          arrival:   { iataCode: dest, at: arrDate.toISOString() },
          carrierCode: al.code,
          number: String(al.flightBase + i * 13),
          duration: `PT${Math.floor(route.totalMins/60)}H${route.totalMins%60}M`
        });
      } else {
        // Connecting flight — split total time across segments
        const stopover   = route.stops[i % route.stops.length];
        const seg1Mins   = Math.round(route.totalMins * 0.45);
        const layoverMin = 90; // 1.5h layover
        const seg2Mins   = route.totalMins - seg1Mins - layoverMin;

        const midArrDate  = new Date(depDate.getTime() + seg1Mins * 60000);
        const midDepDate  = new Date(midArrDate.getTime() + layoverMin * 60000);
        const finalArrDate = new Date(midDepDate.getTime() + seg2Mins * 60000);

        segments.push({
          departure: { iataCode: orig,    at: depDate.toISOString() },
          arrival:   { iataCode: stopover, at: midArrDate.toISOString() },
          carrierCode: al.code,
          number: String(al.flightBase + i * 13),
          duration: `PT${Math.floor(seg1Mins/60)}H${seg1Mins%60}M`
        });
        segments.push({
          departure: { iataCode: stopover, at: midDepDate.toISOString() },
          arrival:   { iataCode: dest,     at: finalArrDate.toISOString() },
          carrierCode: al.code,
          number: String(al.flightBase + i * 13 + 1),
          duration: `PT${Math.floor(seg2Mins/60)}H${seg2Mins%60}M`
        });
      }

      const totalDurMins = route.totalMins;

      return {
        id: `demo-${i}`,
        price: {
          grandTotal: finalPrice.toFixed(2),
          currency: 'EUR',
          fees: [{ amount: (finalPrice * 0.10).toFixed(2) }]
        },
        numberOfBookableSeats: [9,4,7,2,6,8][i] || 5,
        itineraries: [{
          duration: `PT${Math.floor(totalDurMins/60)}H${totalDurMins%60}M`,
          segments
        }],
        travelerPricings: [{
          fareDetailsBySegment: [{ cabin: isBusiness ? 'BUSINESS' : 'ECONOMY' }]
        }]
      };
    });
  }

  try {
    // 1️⃣ Try Tequila/Kiwi first — real flights, no balance needed
    console.log('Searching Tequila/Kiwi for real flights...');
    const tequilaFlights = await searchTequilaFlights(
      cleanOrigin, cleanDest, cleanDate,
      cleanAdults, cleanChildren, cleanInfants, cleanCabin
    );
    if (tequilaFlights && tequilaFlights.length) {
      console.log(`✅ Tequila returned ${tequilaFlights.length} real flights.`);
      return res.json(tequilaFlights);
    }

    // 2️⃣ Fall back to Duffel if Tequila returns nothing
    if (DUFFEL_API_KEY) {
      console.log('Tequila empty — trying Duffel...');
      const duffelFlights = await searchDuffelFlights(
        cleanOrigin, cleanDest, cleanDate,
        cleanAdults, cleanChildren, cleanInfants, cleanCabin
      );
      if (duffelFlights && duffelFlights.length) {
        console.log(`✅ Duffel returned ${duffelFlights.length} real bookable flights.`);
        return res.json(duffelFlights);
      }
    }

    console.log('No flights found from Tequila or Duffel.');
    return res.json([]);

  } catch (err) {
    console.error('Flight search error:', err.message);
    return res.json([]);
  }
});

// ============================================================
// ROUTE: POST /api/bookings/create
// Books a real flight via Duffel using a live offer ID.
// Customer has already paid via Stripe before this is called.
// Body: { offerId, passengers: [{title,given_name,family_name,born_on,gender,email,phone}] }
// ============================================================
app.post('/api/bookings/create', async (req, res) => {
  const { offerId, passengers } = req.body;

  if (!offerId || !passengers || !passengers.length) {
    return res.status(400).json({ error: 'Missing offer ID or passenger details.' });
  }
  if (!DUFFEL_API_KEY) {
    return res.status(500).json({ error: 'Booking service not configured.' });
  }

  // Validate passengers
  for (const p of passengers) {
    if (!p.given_name || !p.family_name || !p.born_on || !p.gender || !p.email) {
      return res.status(400).json({ error: 'All passenger details are required.' });
    }
  }

  try {
    const orderRes = await fetch(`${DUFFEL_BASE_URL}/air/orders`, {
      method: 'POST',
      headers: {
        'Authorization':  `Bearer ${DUFFEL_API_KEY}`,
        'Duffel-Version': 'v2',
        'Content-Type':   'application/json',
        'Accept':         'application/json'
      },
      body: JSON.stringify({
        data: {
          selected_offers: [offerId],
          passengers: passengers.map((p, i) => ({
            id:          `passenger-${i}`,
            title:       p.title || 'mr',
            given_name:  sanitize(p.given_name),
            family_name: sanitize(p.family_name),
            born_on:     p.born_on,
            gender:      p.gender,
            email:       sanitize(p.email),
            phone_number: p.phone || '+358000000000'
          })),
          payments: [{
            type:     'balance',
            currency: 'EUR',
            amount:   String(req.body.basePrice || '0')
          }]
        }
      })
    });

    const orderData = await orderRes.json();
    if (!orderRes.ok) {
      console.error('Duffel booking error:', JSON.stringify(orderData).substring(0, 500));
      return res.status(400).json({ error: orderData?.errors?.[0]?.message || 'Booking failed. Please try again.' });
    }

    const order = orderData.data;
    console.log(`Booking created! Order ID: ${order.id}, Booking ref: ${order.booking_reference}`);

    res.json({
      success:          true,
      orderId:          order.id,
      bookingReference: order.booking_reference,
      passengerName:    `${passengers[0].given_name} ${passengers[0].family_name}`,
      email:            passengers[0].email
    });
  } catch (err) {
    console.error('Booking error:', err.message);
    res.status(500).json({ error: 'Booking failed. Please try again.' });
  }
});

// ============================================================
// ROUTE: POST /api/payments/create-intent
// Creates a Stripe PaymentIntent on the server side.
// The client secret is sent back to the browser so Stripe.js
// can complete the payment securely — card data NEVER touches
// our server.
// Body: { amount (USD), currency, flightDetails }
// ============================================================
app.post('/api/payments/create-intent', paymentLimiter, async (req, res) => {
  const { amount, currency = 'usd', flightDetails } = req.body;

  // Validate amount — must be a positive number, max $50,000
  const cleanAmount = parseFloat(amount);
  if (!cleanAmount || cleanAmount <= 0 || cleanAmount > 50000) {
    return res.status(400).json({ error: 'Invalid payment amount.' });
  }

  // Validate currency
  const allowedCurrencies = ['usd', 'eur', 'gbp', 'sek', 'nok', 'dkk', 'pln', 'czk', 'huf'];
  const cleanCurrency = (currency || 'eur').toLowerCase();
  if (!allowedCurrencies.includes(cleanCurrency)) {
    return res.status(400).json({ error: 'Invalid currency.' });
  }

  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount:   Math.round(cleanAmount * 100), // Stripe uses cents
      currency: cleanCurrency,
      // Explicitly list methods — forces Klarna, PayPal etc to always show
      payment_method_types: ['card', 'klarna', 'paypal'],
      metadata: {
        flight: JSON.stringify(flightDetails || {}).substring(0, 500)
      }
    });

    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(500).json({ error: 'Maksun asetus epäonnistui. Yritä uudelleen.' });
  }
});

// ============================================================
// ROUTE: POST /api/bookings/cancel
// Cancels a booking: issues Stripe refund + cancels Duffel order.
// Body: { paymentIntentId, duffelOrderId, totalPrice, bookingRef }
// ============================================================
app.post('/api/bookings/cancel', paymentLimiter, async (req, res) => {
  const { paymentIntentId, duffelOrderId, totalPrice, bookingRef } = req.body;

  if (!paymentIntentId) {
    return res.status(400).json({ error: 'Missing payment information. Contact support at support@nordicwings.net.' });
  }

  let stripeRefundId   = null;
  let refundAmount     = 0;
  let duffelCancelled  = false;
  const errors         = [];

  // ── Step 1: Issue Stripe refund ──────────────────────────────
  try {
    const refund = await stripe.refunds.create({
      payment_intent: paymentIntentId,
      reason: 'requested_by_customer'
    });
    stripeRefundId = refund.id;
    refundAmount   = refund.amount / 100; // convert cents → EUR
    console.log('Refund issued: ' + refund.id + ' for booking ' + bookingRef);
  } catch (stripeErr) {
    console.error('Stripe refund error:', stripeErr.message);
    if (stripeErr.code === 'charge_already_refunded') {
      errors.push('Payment was already refunded.');
    } else {
      return res.status(400).json({ error: 'Refund failed: ' + stripeErr.message });
    }
  }

  // Step 2: Cancel Duffel order (if applicable)
  if (duffelOrderId && DUFFEL_API_KEY) {
    try {
      const cancelReqRes = await fetch(DUFFEL_BASE_URL + '/air/order_cancellations', {
        method: 'POST',
        headers: {
          'Authorization':  'Bearer ' + DUFFEL_API_KEY,
          'Duffel-Version': 'v2',
          'Content-Type':   'application/json',
          'Accept':         'application/json'
        },
        body: JSON.stringify({ data: { order_id: duffelOrderId } })
      });
      const cancelReqData = await cancelReqRes.json();
      const cancellationId = cancelReqData && cancelReqData.data && cancelReqData.data.id;

      if (cancellationId) {
        const confirmRes = await fetch(DUFFEL_BASE_URL + '/air/order_cancellations/' + cancellationId + '/actions/confirm', {
          method: 'POST',
          headers: {
            'Authorization':  'Bearer ' + DUFFEL_API_KEY,
            'Duffel-Version': 'v2',
            'Content-Type':   'application/json',
            'Accept':         'application/json'
          }
        });
        duffelCancelled = confirmRes.ok;
        console.log('Duffel order ' + duffelOrderId + ' cancellation: ' + (duffelCancelled ? 'confirmed' : 'failed'));
      }
    } catch (duffelErr) {
      console.error('Duffel cancel error:', duffelErr.message);
      errors.push('Airline cancellation note: ' + duffelErr.message);
    }
  }

  res.json({
    success:      true,
    refundId:     stripeRefundId,
    refundAmount: refundAmount,
    duffelCancelled: duffelCancelled,
    message:      stripeRefundId
      ? 'Refund of EUR ' + refundAmount.toFixed(2) + ' issued. It will appear on your card within 5-10 business days.'
      : 'Cancellation recorded. Contact support for refund.',
    warnings:     errors
  });
});

// ============================================================
// FLIGHT REMINDER EMAIL SYSTEM
// ============================================================

// ── Email transporter (Gmail SMTP) ───────────────────────────
// Set GMAIL_USER and GMAIL_PASS (app password) in Railway env vars.
// To get a Gmail App Password: Google Account → Security → 2FA → App Passwords
let emailTransporter = null;
if (process.env.GMAIL_USER && process.env.GMAIL_PASS) {
  emailTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_PASS   // 16-char App Password, NOT your Gmail password
    }
  });
  emailTransporter.verify((err) => {
    if (err) console.error('Email setup error:', err.message);
    else     console.log('✉️  Email system ready — reminders will be sent from', process.env.GMAIL_USER);
  });
} else {
  console.warn('⚠️  GMAIL_USER / GMAIL_PASS not set — email reminders are disabled.');
}

// ── Reminders store (persisted as JSON file) ─────────────────
const REMINDERS_FILE = path.join(__dirname, 'reminders.json');

function loadReminders() {
  try {
    if (fs.existsSync(REMINDERS_FILE)) {
      return JSON.parse(fs.readFileSync(REMINDERS_FILE, 'utf8'));
    }
  } catch (e) { console.error('Error loading reminders:', e.message); }
  return [];
}

function saveReminders(list) {
  try { fs.writeFileSync(REMINDERS_FILE, JSON.stringify(list, null, 2)); }
  catch (e) { console.error('Error saving reminders:', e.message); }
}

// ── Booking Confirmation Email Template ──────────────────────
function buildConfirmationEmail(data) {
  const {
    passengerName, route, flightDate, departureTime,
    arrivalTime, airline, bookingRef, flightNumber
  } = data;

  const firstName   = (passengerName || 'Traveller').split(' ')[0];
  const flightDt    = new Date(flightDate);
  const dateDisplay = flightDt.toLocaleDateString('en-GB', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
  const [orig, dest] = (route || 'HEL → DXB').split('→').map(s => s.trim());

  const cityMap = {
    HEL:'Helsinki',MNL:'Manila',DVO:'Davao',CEB:'Cebu',DXB:'Dubai',
    BKK:'Bangkok',SIN:'Singapore',LHR:'London',CDG:'Paris',AMS:'Amsterdam',
    FRA:'Frankfurt',BCN:'Barcelona',MAD:'Madrid',FCO:'Rome',IST:'Istanbul',
    NRT:'Tokyo',JFK:'New York',LAX:'Los Angeles',SYD:'Sydney',AUH:'Abu Dhabi',
    KUL:'Kuala Lumpur',ICN:'Seoul',PEK:'Beijing',ARN:'Stockholm',CPH:'Copenhagen',
    OSL:'Oslo',WAW:'Warsaw',BUD:'Budapest',PRG:'Prague',VIE:'Vienna',
    ZRH:'Zurich',ATH:'Athens',DUB:'Dublin',MXP:'Milan',MUC:'Munich',
  };
  const origCity = cityMap[orig] || orig;
  const destCity = cityMap[dest] || dest;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Booking Confirmed! NordicWings</title>
<style>
  body { margin:0; padding:0; background:#f0f4ff; font-family:'Segoe UI',Arial,sans-serif; }
  .wrapper { max-width:600px; margin:0 auto; background:#fff; border-radius:16px; overflow:hidden; box-shadow:0 4px 24px rgba(30,58,138,.12); }
  .header { background:linear-gradient(135deg,#1e3a8a 0%,#1d4ed8 100%); padding:36px 32px 28px; text-align:center; }
  .header .logo-text { color:#fff; font-size:22px; font-weight:800; letter-spacing:-.5px; }
  .header .logo-sub  { color:#93c5fd; font-size:12px; letter-spacing:2px; text-transform:uppercase; margin-top:2px; }
  .hero { background:linear-gradient(135deg,#16a34a,#15803d); padding:32px; text-align:center; }
  .hero .emoji { font-size:56px; line-height:1; margin-bottom:12px; }
  .hero h1 { color:#fff; font-size:28px; font-weight:900; margin:0 0 8px; }
  .hero p  { color:#bbf7d0; font-size:15px; margin:0; }
  .body { padding:32px; }
  .greeting { font-size:16px; color:#1e293b; margin-bottom:20px; line-height:1.6; }
  .ref-box { background:linear-gradient(135deg,#f0fdf4,#dcfce7); border:2px solid #86efac; border-radius:14px; padding:20px; text-align:center; margin-bottom:24px; }
  .ref-box .ref-label { font-size:11px; text-transform:uppercase; letter-spacing:2px; color:#15803d; font-weight:700; margin-bottom:8px; }
  .ref-box .ref-code  { font-size:32px; font-weight:900; color:#14532d; letter-spacing:5px; font-family:monospace; }
  .ref-box .ref-note  { font-size:12px; color:#4ade80; margin-top:6px; }
  .flight-card { background:linear-gradient(135deg,#eff6ff,#dbeafe); border:1.5px solid #93c5fd; border-radius:14px; padding:24px; margin-bottom:24px; }
  .route-row { display:flex; align-items:center; justify-content:center; gap:12px; margin-bottom:18px; }
  .airport { text-align:center; }
  .airport .code { font-size:30px; font-weight:900; color:#1e3a8a; letter-spacing:-1px; }
  .airport .city { font-size:12px; color:#64748b; font-weight:500; margin-top:2px; }
  .route-arrow { font-size:22px; color:#3b82f6; flex-shrink:0; }
  .flight-meta { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
  .meta-item { background:#fff; border-radius:10px; padding:12px 14px; border:1px solid #e0e7ff; }
  .meta-item .label { font-size:10px; text-transform:uppercase; letter-spacing:1px; color:#94a3b8; font-weight:700; margin-bottom:4px; }
  .meta-item .value { font-size:14px; font-weight:700; color:#1e3a8a; }
  .next-steps { margin-bottom:24px; }
  .next-steps h3 { font-size:14px; font-weight:800; color:#1e3a8a; text-transform:uppercase; letter-spacing:.5px; margin-bottom:14px; }
  .step-item { display:flex; align-items:flex-start; gap:10px; padding:10px 14px; border-radius:10px; margin-bottom:8px; background:#f8faff; border:1px solid #e0e7ff; }
  .step-icon { font-size:18px; flex-shrink:0; line-height:1.3; }
  .step-text { font-size:14px; color:#374151; line-height:1.4; }
  .step-text strong { color:#1e3a8a; }
  .cta-section { text-align:center; background:#f0f4ff; border-radius:14px; padding:24px; margin-bottom:24px; }
  .cta-section p { font-size:14px; color:#475569; margin:0 0 16px; }
  .cta-btn { display:inline-block; background:linear-gradient(135deg,#1e3a8a,#1d4ed8); color:#fff; text-decoration:none; padding:14px 36px; border-radius:50px; font-size:15px; font-weight:700; }
  .support { font-size:13px; color:#64748b; text-align:center; margin-bottom:8px; }
  .support a { color:#1d4ed8; text-decoration:none; }
  .footer { background:#1e3a8a; padding:24px 32px; text-align:center; }
  .footer p { color:#93c5fd; font-size:12px; margin:4px 0; }
  .footer .brand { color:#fff; font-weight:800; font-size:14px; margin-bottom:4px; }
  @media(max-width:480px){
    .body{padding:20px;}
    .hero h1{font-size:22px;}
    .flight-meta{grid-template-columns:1fr;}
    .ref-box .ref-code{font-size:24px;letter-spacing:3px;}
  }
</style>
</head>
<body>
<div class="wrapper">

  <div class="header">
    <div class="logo-text">✈ NordicWings</div>
    <div class="logo-sub">nordicwings.net</div>
  </div>

  <div class="hero">
    <div class="emoji">✅</div>
    <h1>Booking confirmed!</h1>
    <p>Your real ticket has been issued. Have a great trip, ${firstName}!</p>
  </div>

  <div class="body">
    <p class="greeting">Hi <strong>${firstName}</strong>,<br>
    Great news — your flight from <strong>${origCity}</strong> to <strong>${destCity}</strong> is fully confirmed and your ticket has been issued by the airline. Please keep your booking reference safe:</p>

    <div class="ref-box">
      <div class="ref-label">Your Booking Reference</div>
      <div class="ref-code">${bookingRef || 'SEE TICKET'}</div>
      <div class="ref-note">📌 Screenshot or write this down — you'll need it at check-in</div>
    </div>

    <div class="flight-card">
      <div class="route-row">
        <div class="airport">
          <div class="code">${orig}</div>
          <div class="city">${origCity}</div>
        </div>
        <div class="route-arrow">✈ ──────</div>
        <div class="airport">
          <div class="code">${dest}</div>
          <div class="city">${destCity}</div>
        </div>
      </div>
      <div class="flight-meta">
        <div class="meta-item">
          <div class="label">📅 Date</div>
          <div class="value">${dateDisplay}</div>
        </div>
        <div class="meta-item">
          <div class="label">🕐 Departure</div>
          <div class="value">${departureTime || 'Check ticket'}</div>
        </div>
        <div class="meta-item">
          <div class="label">✈️ Flight</div>
          <div class="value">${flightNumber || airline || 'See ticket'}</div>
        </div>
        <div class="meta-item">
          <div class="label">🛬 Arrival</div>
          <div class="value">${arrivalTime || 'See ticket'}</div>
        </div>
      </div>
    </div>

    <div class="next-steps">
      <h3>📋 What to do next</h3>
      <div class="step-item">
        <div class="step-icon">📧</div>
        <div class="step-text"><strong>Check for airline email</strong> — The airline may send you a separate email with your e-ticket. Check your inbox (and spam folder).</div>
      </div>
      <div class="step-item">
        <div class="step-icon">📲</div>
        <div class="step-text"><strong>Online check-in</strong> — Most airlines open online check-in 24–48 hours before departure. Check in early to choose your seat.</div>
      </div>
      <div class="step-item">
        <div class="step-icon">🛂</div>
        <div class="step-text"><strong>Prepare your passport</strong> — Make sure it's valid for at least 6 months beyond your travel date.</div>
      </div>
      <div class="step-item">
        <div class="step-icon">⏰</div>
        <div class="step-text"><strong>Arrive early</strong> — For international flights, arrive at least 3 hours before departure. For European routes, 2 hours is recommended.</div>
      </div>
    </div>

    <div class="cta-section">
      <p>Need help or have questions about your booking?</p>
      <a href="https://nordicwings.net" class="cta-btn">Visit NordicWings ✈</a>
    </div>

    <p class="support">
      Need help? Email us at <a href="mailto:support@nordicwings.net">support@nordicwings.net</a><br>
      or visit <a href="https://nordicwings.net">nordicwings.net</a>
    </p>
  </div>

  <div class="footer">
    <div class="brand">NordicWings</div>
    <p>Making affordable flights easy for everyone.</p>
    <p>nordicwings.net | support@nordicwings.net</p>
    <p style="margin-top:14px;font-size:11px;color:#475a8a;">
      You're receiving this because you booked a flight with NordicWings.<br>
      © 2026 NordicWings — nordicwings.net
    </p>
  </div>

</div>
</body>
</html>`;
}

// ── Post-flight Thank You Email Template ─────────────────────
function buildThankYouEmail(data) {
  const {
    passengerName, route, bookingRef
  } = data;

  const firstName   = (passengerName || 'Traveller').split(' ')[0];
  const [orig, dest] = (route || 'HEL → DXB').split('→').map(s => s.trim());

  const cityMap = {
    HEL:'Helsinki',MNL:'Manila',DVO:'Davao',CEB:'Cebu',DXB:'Dubai',
    BKK:'Bangkok',SIN:'Singapore',LHR:'London',CDG:'Paris',AMS:'Amsterdam',
    FRA:'Frankfurt',BCN:'Barcelona',MAD:'Madrid',FCO:'Rome',IST:'Istanbul',
    NRT:'Tokyo',JFK:'New York',LAX:'Los Angeles',SYD:'Sydney',AUH:'Abu Dhabi',
    KUL:'Kuala Lumpur',ICN:'Seoul',PEK:'Beijing',ARN:'Stockholm',CPH:'Copenhagen',
    OSL:'Oslo',WAW:'Warsaw',BUD:'Budapest',PRG:'Prague',VIE:'Vienna',
    ZRH:'Zurich',ATH:'Athens',DUB:'Dublin',MXP:'Milan',MUC:'Munich',
  };
  const origCity = cityMap[orig] || orig;
  const destCity = cityMap[dest] || dest;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Thank you for flying with NordicWings!</title>
<style>
  body { margin:0; padding:0; background:#f0f4ff; font-family:'Segoe UI',Arial,sans-serif; }
  .wrapper { max-width:600px; margin:0 auto; background:#fff; border-radius:16px; overflow:hidden; box-shadow:0 4px 24px rgba(30,58,138,.12); }
  .header { background:linear-gradient(135deg,#1e3a8a 0%,#1d4ed8 100%); padding:36px 32px 28px; text-align:center; }
  .header .logo-text { color:#fff; font-size:22px; font-weight:800; letter-spacing:-.5px; }
  .header .logo-sub  { color:#93c5fd; font-size:12px; letter-spacing:2px; text-transform:uppercase; margin-top:2px; }
  .hero { background:linear-gradient(135deg,#7c3aed,#6d28d9); padding:32px; text-align:center; }
  .hero .emoji { font-size:56px; line-height:1; margin-bottom:12px; }
  .hero h1 { color:#fff; font-size:28px; font-weight:900; margin:0 0 8px; }
  .hero p  { color:#ddd6fe; font-size:15px; margin:0; }
  .body { padding:32px; }
  .greeting { font-size:16px; color:#1e293b; margin-bottom:20px; line-height:1.6; }
  .route-badge { display:flex; align-items:center; justify-content:center; gap:16px; background:#f5f3ff; border:1.5px solid #c4b5fd; border-radius:14px; padding:20px; margin-bottom:24px; }
  .badge-airport { text-align:center; }
  .badge-airport .code { font-size:28px; font-weight:900; color:#5b21b6; }
  .badge-airport .city { font-size:12px; color:#7c3aed; margin-top:2px; }
  .badge-arrow { font-size:20px; color:#8b5cf6; }
  .stars-section { text-align:center; background:#fdf4ff; border:1.5px solid #e9d5ff; border-radius:14px; padding:24px; margin-bottom:24px; }
  .stars-section h3 { font-size:16px; font-weight:800; color:#5b21b6; margin:0 0 8px; }
  .stars-section p { font-size:14px; color:#6d28d9; margin:0 0 16px; }
  .star-row { font-size:36px; letter-spacing:4px; margin-bottom:16px; }
  .review-btn { display:inline-block; background:linear-gradient(135deg,#7c3aed,#6d28d9); color:#fff; text-decoration:none; padding:14px 36px; border-radius:50px; font-size:15px; font-weight:700; }
  .book-again { text-align:center; background:#f0f4ff; border-radius:14px; padding:24px; margin-bottom:24px; }
  .book-again h3 { font-size:16px; font-weight:800; color:#1e3a8a; margin:0 0 8px; }
  .book-again p { font-size:14px; color:#475569; margin:0 0 16px; }
  .book-btn { display:inline-block; background:linear-gradient(135deg,#1e3a8a,#1d4ed8); color:#fff; text-decoration:none; padding:14px 36px; border-radius:50px; font-size:15px; font-weight:700; }
  .support { font-size:13px; color:#64748b; text-align:center; margin-bottom:8px; }
  .support a { color:#1d4ed8; text-decoration:none; }
  .footer { background:#1e3a8a; padding:24px 32px; text-align:center; }
  .footer p { color:#93c5fd; font-size:12px; margin:4px 0; }
  .footer .brand { color:#fff; font-weight:800; font-size:14px; margin-bottom:4px; }
  @media(max-width:480px){
    .body{padding:20px;}
    .hero h1{font-size:22px;}
  }
</style>
</head>
<body>
<div class="wrapper">

  <div class="header">
    <div class="logo-text">✈ NordicWings</div>
    <div class="logo-sub">nordicwings.net</div>
  </div>

  <div class="hero">
    <div class="emoji">🌟</div>
    <h1>Hope you had a wonderful trip!</h1>
    <p>Thank you for flying with NordicWings, ${firstName}.</p>
  </div>

  <div class="body">
    <p class="greeting">Hi <strong>${firstName}</strong>,<br>
    Your flight from <strong>${origCity}</strong> to <strong>${destCity}</strong> has now landed — we hope everything went smoothly and you're enjoying your destination! 🎉</p>

    <div class="route-badge">
      <div class="badge-airport">
        <div class="code">${orig}</div>
        <div class="city">${origCity}</div>
      </div>
      <div class="badge-arrow">✈ ──────</div>
      <div class="badge-airport">
        <div class="code">${dest}</div>
        <div class="city">${destCity}</div>
      </div>
    </div>

    <div class="stars-section">
      <h3>How was your experience?</h3>
      <p>Your review helps other travellers find great flights and helps us improve.</p>
      <div class="star-row">⭐⭐⭐⭐⭐</div>
      <a href="https://www.trustpilot.com/review/nordicwings.net" class="review-btn">Leave a Review ✍</a>
    </div>

    <div class="book-again">
      <h3>Ready for your next adventure?</h3>
      <p>Search thousands of real flights and book in minutes — all with NordicWings.</p>
      <a href="https://nordicwings.net" class="book-btn">Search Flights ✈</a>
    </div>

    <p class="support">
      Had an issue? We're here to help — <a href="mailto:support@nordicwings.net">support@nordicwings.net</a>
    </p>
  </div>

  <div class="footer">
    <div class="brand">NordicWings</div>
    <p>Making affordable flights easy for everyone.</p>
    <p>nordicwings.net | support@nordicwings.net</p>
    <p style="margin-top:14px;font-size:11px;color:#475a8a;">
      Booking reference: ${bookingRef || 'N/A'}<br>
      © 2026 NordicWings — nordicwings.net
    </p>
  </div>

</div>
</body>
</html>`;
}

// ── HTML Email Template ───────────────────────────────────────
function buildReminderEmail(data) {
  const {
    passengerName, email, route, flightDate, departureTime,
    arrivalTime, airline, bookingRef, flightNumber
  } = data;

  const firstName   = (passengerName || 'Traveller').split(' ')[0];
  const tomorrow    = new Date(flightDate);
  const dateDisplay = tomorrow.toLocaleDateString('en-GB', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
  const [orig, dest] = (route || 'HEL → DXB').split('→').map(s => s.trim());

  // Airport city names for common codes
  const cityMap = {
    HEL:'Helsinki',MNL:'Manila',DVO:'Davao',CEB:'Cebu',DXB:'Dubai',
    BKK:'Bangkok',SIN:'Singapore',LHR:'London',CDG:'Paris',AMS:'Amsterdam',
    FRA:'Frankfurt',BCN:'Barcelona',MAD:'Madrid',FCO:'Rome',IST:'Istanbul',
    NRT:'Tokyo',JFK:'New York',LAX:'Los Angeles',SYD:'Sydney',AUH:'Abu Dhabi',
    KUL:'Kuala Lumpur',ICN:'Seoul',PEK:'Beijing',ARN:'Stockholm',CPH:'Copenhagen',
    OSL:'Oslo',WAW:'Warsaw',BUD:'Budapest',PRG:'Prague',VIE:'Vienna',
    ZRH:'Zurich',ATH:'Athens',DUB:'Dublin',MXP:'Milan',MUC:'Munich',
  };
  const origCity = cityMap[orig] || orig;
  const destCity = cityMap[dest] || dest;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Your flight is tomorrow! ✈ NordicWings</title>
<style>
  body { margin:0; padding:0; background:#f0f4ff; font-family:'Segoe UI',Arial,sans-serif; }
  .wrapper { max-width:600px; margin:0 auto; background:#fff; border-radius:16px; overflow:hidden; box-shadow:0 4px 24px rgba(30,58,138,.12); }
  .header { background:linear-gradient(135deg,#1e3a8a 0%,#1d4ed8 100%); padding:36px 32px 28px; text-align:center; }
  .header img { height:36px; margin-bottom:12px; }
  .header .logo-text { color:#fff; font-size:22px; font-weight:800; letter-spacing:-.5px; }
  .header .logo-sub  { color:#93c5fd; font-size:12px; letter-spacing:2px; text-transform:uppercase; margin-top:2px; }
  .hero { background:linear-gradient(135deg,#1d4ed8,#2563eb); padding:32px; text-align:center; border-top:1px solid rgba(255,255,255,.1); }
  .hero .emoji { font-size:56px; line-height:1; margin-bottom:12px; }
  .hero h1 { color:#fff; font-size:28px; font-weight:900; margin:0 0 8px; }
  .hero p  { color:#bfdbfe; font-size:15px; margin:0; }
  .body { padding:32px; }
  .greeting { font-size:16px; color:#1e293b; margin-bottom:20px; }
  .flight-card { background:linear-gradient(135deg,#eff6ff,#dbeafe); border:1.5px solid #93c5fd; border-radius:14px; padding:24px; margin-bottom:24px; }
  .route-row { display:flex; align-items:center; justify-content:center; gap:12px; margin-bottom:18px; }
  .airport { text-align:center; }
  .airport .code { font-size:30px; font-weight:900; color:#1e3a8a; letter-spacing:-1px; }
  .airport .city { font-size:12px; color:#64748b; font-weight:500; margin-top:2px; }
  .route-arrow { font-size:22px; color:#3b82f6; flex-shrink:0; }
  .flight-meta { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
  .meta-item { background:#fff; border-radius:10px; padding:12px 14px; border:1px solid #e0e7ff; }
  .meta-item .label { font-size:10px; text-transform:uppercase; letter-spacing:1px; color:#94a3b8; font-weight:700; margin-bottom:4px; }
  .meta-item .value { font-size:14px; font-weight:700; color:#1e3a8a; }
  .booking-ref { text-align:center; margin-top:14px; padding-top:14px; border-top:1px dashed #bfdbfe; }
  .booking-ref .label { font-size:10px; text-transform:uppercase; letter-spacing:1px; color:#94a3b8; font-weight:700; }
  .booking-ref .ref { font-size:22px; font-weight:900; color:#1e3a8a; letter-spacing:3px; }
  .checklist { margin-bottom:24px; }
  .checklist h3 { font-size:14px; font-weight:800; color:#1e3a8a; text-transform:uppercase; letter-spacing:.5px; margin-bottom:14px; }
  .check-item { display:flex; align-items:flex-start; gap:10px; padding:10px 14px; border-radius:10px; margin-bottom:8px; background:#f8faff; border:1px solid #e0e7ff; }
  .check-icon { font-size:18px; flex-shrink:0; line-height:1.3; }
  .check-text { font-size:14px; color:#374151; line-height:1.4; }
  .check-text strong { color:#1e3a8a; }
  .cta-section { text-align:center; background:#f0f4ff; border-radius:14px; padding:24px; margin-bottom:24px; }
  .cta-section p { font-size:14px; color:#475569; margin:0 0 16px; }
  .cta-btn { display:inline-block; background:linear-gradient(135deg,#1e3a8a,#1d4ed8); color:#fff; text-decoration:none; padding:14px 36px; border-radius:50px; font-size:15px; font-weight:700; }
  .support { font-size:13px; color:#64748b; text-align:center; margin-bottom:8px; }
  .support a { color:#1d4ed8; text-decoration:none; }
  .footer { background:#1e3a8a; padding:24px 32px; text-align:center; }
  .footer p { color:#93c5fd; font-size:12px; margin:4px 0; }
  .footer .brand { color:#fff; font-weight:800; font-size:14px; margin-bottom:4px; }
  .social-links { margin-top:12px; }
  .social-links a { color:#93c5fd; text-decoration:none; margin:0 8px; font-size:12px; }
  @media(max-width:480px){
    .body{padding:20px;}
    .hero h1{font-size:22px;}
    .flight-meta{grid-template-columns:1fr;}
    .route-row{gap:8px;}
    .airport .code{font-size:24px;}
  }
</style>
</head>
<body>
<div class="wrapper">

  <!-- Header -->
  <div class="header">
    <div class="logo-text">✈ NordicWings</div>
    <div class="logo-sub">nordicwings.net</div>
  </div>

  <!-- Hero -->
  <div class="hero">
    <div class="emoji">✈️</div>
    <h1>Your flight is tomorrow!</h1>
    <p>Here's everything you need for a smooth journey, ${firstName}.</p>
  </div>

  <!-- Body -->
  <div class="body">
    <p class="greeting">Hi <strong>${firstName}</strong>,<br>
    Your flight from <strong>${origCity}</strong> to <strong>${destCity}</strong> departs <strong>tomorrow, ${dateDisplay}</strong>. We hope you're all packed and ready! Here's a quick summary:</p>

    <!-- Flight card -->
    <div class="flight-card">
      <div class="route-row">
        <div class="airport">
          <div class="code">${orig}</div>
          <div class="city">${origCity}</div>
        </div>
        <div class="route-arrow">✈ ──────</div>
        <div class="airport">
          <div class="code">${dest}</div>
          <div class="city">${destCity}</div>
        </div>
      </div>
      <div class="flight-meta">
        <div class="meta-item">
          <div class="label">📅 Date</div>
          <div class="value">${dateDisplay}</div>
        </div>
        <div class="meta-item">
          <div class="label">🕐 Departure</div>
          <div class="value">${departureTime || 'Check your ticket'}</div>
        </div>
        <div class="meta-item">
          <div class="label">✈️ Airline</div>
          <div class="value">${airline || 'See your ticket'}</div>
        </div>
        <div class="meta-item">
          <div class="label">🛬 Arrival</div>
          <div class="value">${arrivalTime || 'See your ticket'}</div>
        </div>
      </div>
      ${bookingRef ? `<div class="booking-ref">
        <div class="label">Booking Reference</div>
        <div class="ref">${bookingRef}</div>
      </div>` : ''}
    </div>

    <!-- Pre-flight checklist -->
    <div class="checklist">
      <h3>✅ Pre-flight checklist</h3>
      <div class="check-item">
        <div class="check-icon">🛂</div>
        <div class="check-text"><strong>Passport & ID</strong> — Make sure it's valid for at least 6 months beyond your travel date.</div>
      </div>
      <div class="check-item">
        <div class="check-icon">⏰</div>
        <div class="check-text"><strong>Arrive early</strong> — For international flights, arrive <strong>at least 3 hours</strong> before departure. For domestic, aim for 2 hours.</div>
      </div>
      <div class="check-item">
        <div class="check-icon">🧳</div>
        <div class="check-text"><strong>Baggage</strong> — Check your airline's baggage allowance. Carry-on is usually max 8kg. Keep liquids (under 100ml) in a clear bag.</div>
      </div>
      <div class="check-item">
        <div class="check-icon">📱</div>
        <div class="check-text"><strong>Your boarding pass</strong> — Download or screenshot it now in case you're offline at the airport.</div>
      </div>
      <div class="check-item">
        <div class="check-icon">🔋</div>
        <div class="check-text"><strong>Power bank</strong> — Charge your devices tonight. Note: power banks can't go in checked luggage, only carry-on.</div>
      </div>
      <div class="check-item">
        <div class="check-icon">💱</div>
        <div class="check-text"><strong>Local currency</strong> — It's a good idea to have some local cash at your destination for taxis and tips.</div>
      </div>
    </div>

    <!-- CTA -->
    <div class="cta-section">
      <p>Need to check your booking, make changes, or contact support?</p>
      <a href="https://nordicwings.net" class="cta-btn">Manage My Booking ✈</a>
    </div>

    <p class="support">
      Questions? Email us at <a href="mailto:support@nordicwings.net">support@nordicwings.net</a><br>
      or visit <a href="https://nordicwings.net">nordicwings.net</a>
    </p>
  </div>

  <!-- Footer -->
  <div class="footer">
    <div class="brand">NordicWings</div>
    <p>Making affordable flights easy for everyone.</p>
    <p>nordicwings.net | support@nordicwings.net</p>
    <div class="social-links">
      <a href="https://x.com/nordicwingx3j6">X (Twitter)</a>
      <a href="https://www.linkedin.com/company/115854101">LinkedIn</a>
      <a href="https://nordicwings.net">Website</a>
    </div>
    <p style="margin-top:14px;font-size:11px;color:#475a8a;">
      You're receiving this because you booked a flight with NordicWings.<br>
      © 2026 NordicWings — nordicwings.net
    </p>
  </div>

</div>
</body>
</html>`;
}

// ── ROUTE: POST /api/bookings/reminder-register ───────────────
// Called by the frontend after a booking is confirmed.
// Saves the booking details so we can send a reminder email
// the day before the flight.
// Body: { email, passengerName, route, flightDate, departureTime, arrivalTime, airline, bookingRef, flightNumber }
app.post('/api/bookings/reminder-register', async (req, res) => {
  const {
    email, passengerName, route, flightDate, departureTime,
    arrivalTime, airline, bookingRef, flightNumber
  } = req.body;

  if (!email || !flightDate) {
    return res.status(400).json({ error: 'Email and flightDate are required.' });
  }

  // Basic email validation
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email address.' });
  }

  const reminders = loadReminders();
  const entry = {
    id:            Date.now().toString(),
    email:         sanitize(email).substring(0, 100),
    passengerName: sanitize(passengerName || 'Traveller'),
    route:         sanitize(route || ''),
    flightDate,    // YYYY-MM-DD
    departureTime: sanitize(departureTime || ''),
    arrivalTime:   sanitize(arrivalTime || ''),
    airline:       sanitize(airline || ''),
    bookingRef:    sanitize(bookingRef || ''),
    flightNumber:  sanitize(flightNumber || ''),
    reminderSent:  false,
    thankSent:     false,
    registeredAt:  new Date().toISOString()
  };

  reminders.push(entry);
  saveReminders(reminders);

  // ── Send booking confirmation email immediately ────────────
  if (emailTransporter) {
    try {
      const confirmHtml = buildConfirmationEmail(entry);
      await emailTransporter.sendMail({
        from:    `"NordicWings ✈" <${process.env.GMAIL_USER}>`,
        to:      entry.email,
        subject: `✅ Booking confirmed! ${entry.route || ''} — Ref: ${entry.bookingRef || ''}`,
        html:    confirmHtml
      });
      console.log(`✅ Confirmation email sent to ${entry.email}`);
    } catch (err) {
      console.error(`❌ Failed to send confirmation email to ${entry.email}:`, err.message);
      // Non-critical — don't fail the request
    }
  } else {
    console.warn('⚠️  Email not configured — confirmation email skipped. Set GMAIL_USER + GMAIL_PASS in Railway.');
  }

  console.log(`Reminder registered for ${email} — flight on ${flightDate}`);
  res.json({ success: true, message: 'Reminder registered. You will receive an email the day before your flight.' });
});

// ── Daily cron: send "flight tomorrow" reminders ─────────────
// Runs every day at 08:00 Helsinki time (UTC+3 = 05:00 UTC in summer, 06:00 UTC in winter)
// Using UTC 05:00 (covers Helsinki summer/EEST). Adjust if needed.
cron.schedule('0 5 * * *', async () => {
  console.log('🕔 Running flight reminder cron job...');

  if (!emailTransporter) {
    console.warn('Email transporter not configured — skipping reminders.');
    return;
  }

  const today      = new Date();
  const tomorrow   = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0]; // YYYY-MM-DD

  const reminders = loadReminders();
  const toSend    = reminders.filter(r => !r.reminderSent && r.flightDate === tomorrowStr);

  console.log(`Found ${toSend.length} reminders to send for ${tomorrowStr}`);

  let anySent = false;
  for (const reminder of toSend) {
    try {
      const html = buildReminderEmail(reminder);
      await emailTransporter.sendMail({
        from:    `"NordicWings ✈" <${process.env.GMAIL_USER}>`,
        to:      reminder.email,
        subject: `✈ Your flight is tomorrow! ${reminder.route || ''} — NordicWings`,
        html
      });
      reminder.reminderSent = true;
      reminder.sentAt       = new Date().toISOString();
      console.log(`✅ Reminder sent to ${reminder.email} for ${reminder.flightDate}`);
      anySent = true;
    } catch (err) {
      console.error(`❌ Failed to send reminder to ${reminder.email}:`, err.message);
    }
  }

  if (anySent) {
    // Clean up old reminders (flights more than 7 days ago)
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    const cutoffStr = cutoff.toISOString().split('T')[0];
    const cleaned = reminders.filter(r => r.flightDate >= cutoffStr);
    saveReminders(cleaned);
  }
});
// Railway servers run on UTC — cron '0 5 * * *' = 05:00 UTC = 08:00 Helsinki time (EEST)

console.log('📅 Flight reminder cron job scheduled (runs daily at 08:00 Helsinki time).');

// ── Daily cron: send post-flight thank you email ──────────────
// Runs every day at 10:00 Helsinki time (07:00 UTC) — the morning after the flight
cron.schedule('0 7 * * *', async () => {
  console.log('🌟 Running post-flight thank-you cron job...');

  if (!emailTransporter) {
    console.warn('Email transporter not configured — skipping thank-you emails.');
    return;
  }

  const today    = new Date();
  const todayStr = today.toISOString().split('T')[0]; // YYYY-MM-DD

  const reminders = loadReminders();
  // Send thank-you to customers whose flight was YESTERDAY (flightDate = yesterday)
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];

  const toThank = reminders.filter(r => !r.thankSent && r.flightDate === yesterdayStr);

  console.log(`Found ${toThank.length} thank-you emails to send for flights on ${yesterdayStr}`);

  let anySent = false;
  for (const reminder of toThank) {
    try {
      const html = buildThankYouEmail(reminder);
      await emailTransporter.sendMail({
        from:    `"NordicWings ✈" <${process.env.GMAIL_USER}>`,
        to:      reminder.email,
        subject: `🌟 Hope you had a great flight, ${(reminder.passengerName || 'Traveller').split(' ')[0]}! — NordicWings`,
        html
      });
      reminder.thankSent = true;
      reminder.thankSentAt = new Date().toISOString();
      console.log(`✅ Thank-you email sent to ${reminder.email} (flight was ${reminder.flightDate})`);
      anySent = true;
    } catch (err) {
      console.error(`❌ Failed to send thank-you to ${reminder.email}:`, err.message);
    }
  }

  if (anySent) {
    // Clean up old reminders (flights more than 14 days ago)
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 14);
    const cutoffStr = cutoff.toISOString().split('T')[0];
    const cleaned = reminders.filter(r => r.flightDate >= cutoffStr);
    saveReminders(cleaned);
  }
});

console.log('🌟 Post-flight thank-you cron job scheduled (runs daily at 10:00 Helsinki time).');

// ============================================================
// Global error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err.message);
  res.status(500).json({
    error: isProd ? 'Something went wrong. Please try again.' : err.message
  });
});

// 404 handler
app.use((req, res) => {
  const path = req.path.toLowerCase();
  const probes = ['.php', '.asp', '.aspx', 'wp-admin', 'xmlrpc', '.env', 'config.json', 'admin/', '/.git', '/backup'];
  if (probes.some(p => path.includes(p))) {
    console.warn('Suspicious probe blocked: ' + req.method + ' ' + req.path + ' from ' + req.ip);
    return res.status(404).json({ error: 'Not found.' });
  }
  res.status(404).json({ error: 'Not found.' });
});

// ============================================================
// ROUTE: GET /api/hotels/search
// Search hotels via Hotelbeds API
// Query: destination (IATA or city), checkIn, checkOut, adults, rooms
// ============================================================
app.get('/api/hotels/search', async (req, res) => {
  const { destination, checkIn, checkOut, adults, rooms } = req.query;
  if (!destination || !checkIn || !checkOut) {
    return res.status(400).json({ error: 'destination, checkIn and checkOut are required.' });
  }

  const cleanAdults = Math.min(Math.max(parseInt(adults) || 2, 1), 9);
  const cleanRooms  = Math.min(Math.max(parseInt(rooms)  || 1, 1), 5);

  try {
    // Map IATA airport code → Hotelbeds destination code
    // Hotelbeds uses their own destination codes — use content API to resolve
    const destRes = await fetch(
      `${HOTELBEDS_BASE}/hotel-content-api/1.0/locations/destinations?fields=all&language=ENG&from=1&to=5&useSecondaryLanguage=false&destinationCodes=${encodeURIComponent(destination.toUpperCase())}`,
      { headers: getHotelbedsHeaders(), signal: AbortSignal.timeout(10000) }
    );

    let destCode = destination.toUpperCase();
    if (destRes.ok) {
      const destData = await destRes.json();
      if (destData.destinations?.length) destCode = destData.destinations[0].code;
    }

    // Search hotels
    const body = {
      stay: { checkIn, checkOut },
      occupancies: [{ rooms: cleanRooms, adults: cleanAdults, children: 0 }],
      destination: { code: destCode },
      filter: { maxHotels: 12, minCategory: 1 }
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const hotelRes = await fetch(`${HOTELBEDS_BASE}/hotel-api/1.0/hotels`, {
      method: 'POST',
      headers: getHotelbedsHeaders(),
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!hotelRes.ok) {
      const errText = await hotelRes.text();
      console.error('Hotelbeds error:', errText.substring(0, 300));
      return res.json({ hotels: [] });
    }

    const data = await hotelRes.json();
    const hotels = (data.hotels?.hotels || []).slice(0, 8).map(h => ({
      code:       h.code,
      name:       h.name,
      stars:      h.categoryCode?.replace('EST', '') || '3',
      minRate:    h.minRate,
      maxRate:    h.maxRate,
      currency:   h.currency,
      rooms:      (h.rooms || []).slice(0, 2).map(r => ({
        name:       r.name,
        rate:       r.rates?.[0]?.net,
        boardName:  r.rates?.[0]?.boardName || 'Room only',
        rateKey:    r.rates?.[0]?.rateKey
      }))
    }));

    console.log(`Hotelbeds returned ${hotels.length} hotels for ${destCode}`);
    res.json({ hotels, destination: destCode });

  } catch (err) {
    console.error('Hotelbeds search error:', err.message);
    res.json({ hotels: [] });
  }
});

// ── ROUTE: POST /api/welcome-email ───────────────────────────
// Called after new user registers — sends branded welcome email
app.post('/api/welcome-email', async (req, res) => {
  const { name, email } = req.body || {};
  if (!email) return res.status(400).json({ ok: false, error: 'Missing email' });

  if (!emailTransporter) {
    console.warn('⚠️  Welcome email skipped — email not configured.');
    return res.json({ ok: false, note: 'email not configured' });
  }

  const firstName = (name || 'Traveller').split(' ')[0];

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;background:#f0f4f8;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4f8;padding:32px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);">
        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#1d4ed8 0%,#0ea5e9 100%);padding:36px 40px;text-align:center;">
            <div style="font-size:2rem;margin-bottom:6px;">✈️</div>
            <div style="color:#ffffff;font-size:1.7rem;font-weight:800;letter-spacing:-0.5px;">NordicWings</div>
            <div style="color:rgba(255,255,255,.8);font-size:.85rem;margin-top:4px;">Your Gateway to the World</div>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:40px 40px 32px;">
            <p style="margin:0 0 18px;font-size:1.15rem;font-weight:700;color:#1a2b4a;">Welcome aboard, ${firstName}! 🎉</p>
            <p style="margin:0 0 16px;font-size:.97rem;color:#374151;line-height:1.6;">
              Thank you for signing up to <strong>NordicWings.net</strong>. We're thrilled to have you with us!
            </p>
            <p style="margin:0 0 16px;font-size:.97rem;color:#374151;line-height:1.6;">
              With NordicWings you can search and compare flights from hundreds of airlines worldwide — including Finnair, SAS, Norwegian, Emirates, Qatar Airways, and many more — all in one place, completely free.
            </p>
            <!-- Feature boxes -->
            <table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;">
              <tr>
                <td width="30%" style="background:#eff6ff;border-radius:10px;padding:14px;text-align:center;vertical-align:top;">
                  <div style="font-size:1.4rem;">🔍</div>
                  <div style="font-size:.8rem;font-weight:700;color:#1d4ed8;margin-top:6px;">Compare Flights</div>
                </td>
                <td width="4%"></td>
                <td width="30%" style="background:#f0fdf4;border-radius:10px;padding:14px;text-align:center;vertical-align:top;">
                  <div style="font-size:1.4rem;">💰</div>
                  <div style="font-size:.8rem;font-weight:700;color:#16a34a;margin-top:6px;">Best Prices</div>
                </td>
                <td width="4%"></td>
                <td width="32%" style="background:#fef3c7;border-radius:10px;padding:14px;text-align:center;vertical-align:top;">
                  <div style="font-size:1.4rem;">🌍</div>
                  <div style="font-size:.8rem;font-weight:700;color:#d97706;margin-top:6px;">500+ Destinations</div>
                </td>
              </tr>
            </table>
            <p style="margin:0 0 28px;font-size:.97rem;color:#374151;line-height:1.6;">
              Ready to explore? Search for your next adventure now:
            </p>
            <div style="text-align:center;margin-bottom:28px;">
              <a href="https://nordicwings.net" style="display:inline-block;background:linear-gradient(135deg,#1d4ed8,#0ea5e9);color:#ffffff;text-decoration:none;font-weight:700;font-size:1rem;padding:14px 36px;border-radius:50px;letter-spacing:.3px;">
                ✈️ Search Flights Now
              </a>
            </div>
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="background:#f8fafc;padding:20px 40px;text-align:center;border-top:1px solid #e2e8f0;">
            <p style="margin:0;font-size:.78rem;color:#94a3b8;">
              © 2025 NordicWings.net &nbsp;·&nbsp; <a href="https://nordicwings.net" style="color:#1d4ed8;text-decoration:none;">Visit Website</a>
            </p>
            <p style="margin:6px 0 0;font-size:.72rem;color:#cbd5e1;">
              You're receiving this because you created an account at NordicWings.net.
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  try {
    await emailTransporter.sendMail({
      from:    `"NordicWings ✈" <${process.env.GMAIL_USER}>`,
      to:      email,
      subject: '✈️ Welcome to NordicWings — Your Journey Starts Here!',
      html
    });
    console.log(`✉️  Welcome email sent to ${email}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('Welcome email error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log('NordicWings is running on port ' + PORT);
  console.log('Security: Helmet + CSP + Rate limiting + Input validation enabled');
});