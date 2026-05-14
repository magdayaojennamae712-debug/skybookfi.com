// ============================================================
// NordicWings — script.js
// Frontend logic: Firebase auth, flight search, Stripe payment,
// bookings dashboard. All "pages" are shown/hidden in the DOM.
// ============================================================

// ── YOUR FIREBASE CONFIG ──────────────────────────────────────
// Replace these values with your own from:
// Firebase Console → Project Settings → Your apps → Web app
const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyBC6ocYFDsFMxbx8eccxfeUzooG4HitugQ",
  authDomain:        "nordicwings.net",
  projectId:         "skybook-30c99",
  storageBucket:     "skybook-30c99.firebasestorage.app",
  messagingSenderId: "696427827576",
  appId:             "1:696427827576:web:b8f4b32dfefc9902e8388d"
};

// ── YOUR STRIPE PUBLISHABLE KEY ───────────────────────────────
// Get this from: Stripe Dashboard → Developers → API Keys
const STRIPE_PUBLISHABLE_KEY = "pk_live_51TLzx6A2y3gkkjexteIatqrlYXOzr0czlPkEN4F2faog5HqFSQM574swwi0HVrsMt4kr6gYdiyeZvvC0jS9tPuDH00KmkEAZry";

// ─────────────────────────────────────────────────────────────
// FIREBASE INIT
// ─────────────────────────────────────────────────────────────
// Firebase + Stripe init — deferred safely, never blocks search/UI
let auth = null;
let db   = null;
let stripe = null;

function initFirebaseSafe() {
  try {
    if (typeof firebase === 'undefined') return;
    if (firebase.apps && firebase.apps.length > 0) return;
    firebase.initializeApp(FIREBASE_CONFIG);
    auth = firebase.auth();
    db   = firebase.firestore();
    auth.onAuthStateChanged(function(user) {
      currentUser = user;
      if (typeof updateNavForAuth === 'function') updateNavForAuth(user);

      if (user) {
        var pendingPage = localStorage.getItem('pendingAuthPage');

        // Always fully close the auth overlay (handles popup sign-in on desktop)
        if (typeof _closeAuthOverlay === 'function') _closeAuthOverlay();

        // pendingAuthPage present = sign-in was started (redirect or popup flow)
        // Handles iOS Safari where getRedirectResult() returns null
        if (pendingPage !== null) {
          localStorage.removeItem('pendingAuthPage');
          if (pendingPage && pendingPage !== 'home') {
            showPage(pendingPage);
          }
        }
      }
    });

    // Handle redirect sign-in result (fires after Google redirect on mobile/desktop)
    auth.getRedirectResult().then(function(result) {
      if (result && result.user) {
        if (typeof _closeAuthOverlay === 'function') _closeAuthOverlay();
        var returnPage = localStorage.getItem('pendingAuthPage') || 'home';
        localStorage.removeItem('pendingAuthPage');
        if (returnPage && returnPage !== 'home') showPage(returnPage);
        else if (selectedFlight) showAgencyPage();
      }
    }).catch(function(e) {
      console.warn('getRedirectResult error:', e.message);
    });
  } catch(e) {
    console.warn('Firebase init skipped:', e.message);
  }
}
window.addEventListener('load', initFirebaseSafe);

// ─────────────────────────────────────────────────────────────
// STATE — app-level variables
// ─────────────────────────────────────────────────────────────
let currentUser          = null;    // Firebase user object
let selectedFlight       = null;    // The outbound flight selected
let selectedReturnFlight = null;    // The return flight selected (round trip)
let outboundFlight       = null;    // Temp: holds outbound while searching return
let isRoundTrip          = false;   // True if user chose round trip
let searchReturnDate     = '';      // Return date string (YYYY-MM-DD)
let searchParams         = {};      // Last search params (for display)
let stripeElements       = null;    // Stripe Elements instance
let cancelBookingId      = null;    // Booking being cancelled

// ─────────────────────────────────────────────────────────────
// UI HELPERS
// ─────────────────────────────────────────────────────────────
function setError(el, msg) {
  if (el) { el.textContent = msg; el.style.display = 'block'; }
}
function toggleBtnLoading(textId, spinnerId, loading) {
  const t = document.getElementById(textId);
  const s = document.getElementById(spinnerId);
  if (t) t.style.display = loading ? 'none' : 'inline';
  if (s) s.style.display = loading ? 'inline-block' : 'none';
}

// ─────────────────────────────────────────────────────────────
// PASSENGER PICKER (Adults / Children / Infants)
// ─────────────────────────────────────────────────────────────
var paxCounts = { adults: 1, children: 0, infants: 0 };

function changePax(type, delta) {
  var next = (paxCounts[type] || 0) + delta;
  if (next < 0) return;
  if (type === 'adults'   && next > 9) return;
  if (type === 'children' && next > 8) return;
  if (type === 'infants'  && next > paxCounts.adults) {
    alert('Each infant needs their own adult. Please add more adults first.');
    return;
  }
  paxCounts[type] = next;
  if ((paxCounts.adults + paxCounts.children + paxCounts.infants) < 1) {
    paxCounts.adults = 1;
  }
  updatePaxUI();
}

function updatePaxUI() {
  var adEl = document.getElementById('pax-adults-disp');
  var chEl = document.getElementById('pax-children-disp');
  var inEl = document.getElementById('pax-infants-disp');
  if (adEl) adEl.textContent = paxCounts.adults;
  if (chEl) chEl.textContent = paxCounts.children;
  if (inEl) inEl.textContent = paxCounts.infants;

  var hAdEl = document.getElementById('pax-adults-val');
  var hChEl = document.getElementById('pax-children-val');
  var hInEl = document.getElementById('pax-infants-val');
  if (hAdEl) hAdEl.value = paxCounts.adults;
  if (hChEl) hChEl.value = paxCounts.children;
  if (hInEl) hInEl.value = paxCounts.infants;

  var parts = [];
  if (paxCounts.adults   > 0) parts.push(paxCounts.adults   + ' Adult'   + (paxCounts.adults   > 1 ? 's'   : ''));
  if (paxCounts.children > 0) parts.push(paxCounts.children + ' Child'   + (paxCounts.children > 1 ? 'ren' : ''));
  if (paxCounts.infants  > 0) parts.push(paxCounts.infants  + ' Infant'  + (paxCounts.infants  > 1 ? 's'   : ''));
  var sumEl = document.getElementById('pax-summary');
  if (sumEl) sumEl.textContent = parts.join(', ') || '1 Adult';

  var noteEl = document.getElementById('pax-child-note');
  if (noteEl) noteEl.style.display = (paxCounts.children > 0 || paxCounts.infants > 0) ? 'block' : 'none';
}

function togglePaxPanel() {
  var panel = document.getElementById('pax-panel');
  var btn   = document.getElementById('pax-btn');
  if (!panel || !btn) return;
  if (panel.style.display === 'none' || panel.style.display === '') {
    var rect     = btn.getBoundingClientRect();
    var screenW  = window.innerWidth;
    var isMobile = screenW < 700;

    // ── CRITICAL: move panel to <body> so it escapes any stacking context
    // caused by parent elements with position+z-index (e.g. search form z-index:2)
    if (panel.parentNode !== document.body) {
      document.body.appendChild(panel);
    }

    // Ensure backdrop exists
    var bd = document.getElementById('pax-backdrop');
    if (!bd) {
      bd = document.createElement('div');
      bd.id = 'pax-backdrop';
      bd.style.cssText = 'position:fixed;inset:0;z-index:99998;background:rgba(0,0,0,0.35);';
      bd.addEventListener('click', closePaxPanel);
      document.body.appendChild(bd);
    }
    bd.style.display = 'block';

    if (isMobile) {
      // ── Bottom sheet on mobile ──────────────────────────────
      panel.style.position      = 'fixed';
      panel.style.bottom        = '0';
      panel.style.left          = '0';
      panel.style.right         = '0';
      panel.style.top           = 'auto';
      panel.style.width         = '100%';
      panel.style.borderRadius  = '20px 20px 0 0';
      panel.style.maxHeight     = '85vh';
      panel.style.overflowY     = 'auto';
      panel.style.paddingBottom = 'env(safe-area-inset-bottom, 16px)';
    } else {
      // ── Dropdown on desktop ─────────────────────────────────
      var panelW  = 320;
      var leftPos = rect.left;
      if (leftPos + panelW > screenW - 8) leftPos = screenW - panelW - 8;
      if (leftPos < 8) leftPos = 8;
      panel.style.position     = 'fixed';
      panel.style.top          = (rect.bottom + 6) + 'px';
      panel.style.left         = leftPos + 'px';
      panel.style.bottom       = 'auto';
      panel.style.right        = 'auto';
      panel.style.width        = panelW + 'px';
      panel.style.borderRadius = '14px';
      panel.style.maxHeight    = 'none';
      panel.style.overflowY    = 'visible';
    }
    panel.style.zIndex  = '100000';
    panel.style.display = 'block';
  } else {
    closePaxPanel();
  }
}

function closePaxPanel() {
  var panel = document.getElementById('pax-panel');
  if (panel) panel.style.display = 'none';
  var bd = document.getElementById('pax-backdrop');
  if (bd) bd.style.display = 'none';
}

document.addEventListener('click', function(e) {
  var panel = document.getElementById('pax-panel');
  var btn   = document.getElementById('pax-btn');
  if (!panel || !btn || panel.style.display === 'none') return;
  if (!panel.contains(e.target) && !btn.contains(e.target)) {
    closePaxPanel();
  }
}, { passive: true });

// ─────────────────────────────────────────────────────────────
// DATE / TIME / DURATION HELPERS
// ─────────────────────────────────────────────────────────────
function formatDate(isoStr) {
  if (!isoStr) return '';
  try {
    const d = new Date(isoStr);
    return d.toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' });
  } catch(e) { return isoStr; }
}

function formatTime(isoStr) {
  if (!isoStr) return '';
  try {
    const d = new Date(isoStr);
    return d.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit', hour12:false });
  } catch(e) { return ''; }
}

function formatDuration(pt) {
  if (!pt) return '';
  const m = pt.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!m) return pt;
  const h = parseInt(m[1]||0), min = parseInt(m[2]||0);
  return h > 0 ? `${h}h ${min}m` : `${min}m`;
}

// ─────────────────────────────────────────────────────────────
// AUTH STATE LISTENER
// Fires whenever login state changes (on load, login, logout)
// ─────────────────────────────────────────────────────────────
// auth state handled in initFirebaseSafe()

const OWNER_EMAIL = 'magdayaojennamae712@gmail.com';

function updateNavForAuth(user) {
  const navLogin    = document.getElementById('nav-login');
  const navSignup   = document.getElementById('nav-signup');
  const navUser     = document.getElementById('nav-user');
  const navUsername = document.getElementById('nav-username');
  const navDash     = document.getElementById('nav-dashboard');
  const navAdmin    = document.getElementById('nav-admin');

  // Mobile menu elements
  const mobileLogin    = document.getElementById('mobile-nav-login');
  const mobileSignup   = document.getElementById('mobile-nav-signup');
  const mobileUser     = document.getElementById('mobile-nav-user');
  const mobileUsername = document.getElementById('mobile-nav-username');

  if (user) {
    const displayName = user.displayName || user.email.split('@')[0];
    // Desktop nav
    if (navLogin)    navLogin.style.display    = 'none';
    if (navSignup)   navSignup.style.display   = 'none';
    if (navUser)     navUser.style.display     = 'flex';
    if (navDash)     navDash.style.display     = 'inline-flex';
    if (navUsername) navUsername.textContent   = displayName;
    if (navAdmin)    navAdmin.style.display    = user.email === OWNER_EMAIL ? 'inline-flex' : 'none';
    // Mobile menu
    if (mobileLogin)    mobileLogin.style.display    = 'none';
    if (mobileSignup)   mobileSignup.style.display   = 'none';
    if (mobileUser)     mobileUser.style.display     = 'block';
    if (mobileUsername) mobileUsername.textContent   = '👋 ' + displayName;
  } else {
    // Desktop nav
    if (navLogin)  navLogin.style.display  = 'inline-flex';
    if (navSignup) navSignup.style.display = 'inline-flex';
    if (navUser)   navUser.style.display   = 'none';
    if (navDash)   navDash.style.display   = 'none';
    if (navAdmin)  navAdmin.style.display  = 'none';
    // Mobile menu
    if (mobileLogin)  mobileLogin.style.display  = 'block';
    if (mobileSignup) mobileSignup.style.display = 'block';
    if (mobileUser)   mobileUser.style.display   = 'none';
  }
}

// ─────────────────────────────────────────────────────────────
// SEO — update canonical tag + page title per route URL
// ─────────────────────────────────────────────────────────────
const ROUTE_NAMES = {
  MNL:'Manila', DVO:'Davao', CEB:'Cebu', CRK:'Clark', ILO:'Iloilo',
  BKK:'Bangkok', SIN:'Singapore', KUL:'Kuala Lumpur', DXB:'Dubai',
  HKG:'Hong Kong', NRT:'Tokyo', ICN:'Seoul', CGK:'Jakarta',
  LHR:'London', CDG:'Paris', AMS:'Amsterdam', BCN:'Barcelona',
  FCO:'Rome', FRA:'Frankfurt', ARN:'Stockholm', CPH:'Copenhagen',
  HEL:'Helsinki', OUL:'Oulu', TMP:'Tampere', TKU:'Turku'
};
function updateSeoForRoute(from, to) {
  const fromName = ROUTE_NAMES[from] || from;
  const toName   = ROUTE_NAMES[to]   || to;
  const url      = 'https://nordicwings.net/?from=' + from + '&to=' + to;
  const desc     = 'Find cheap flights from ' + fromName + ' (' + from + ') to ' + toName + ' (' + to + '). Compare airlines, see real-time prices and book securely via NordicWings.';
  // Canonical
  let link = document.querySelector('link[rel="canonical"]');
  if (link) link.href = url;
  // Page title
  document.title = 'Cheap Flights ' + fromName + ' to ' + toName + ' | NordicWings';
  // Meta description
  let metaDesc = document.querySelector('meta[name="description"]');
  if (metaDesc) metaDesc.content = desc;
  // Open Graph
  let ogTitle = document.querySelector('meta[property="og:title"]');
  if (ogTitle) ogTitle.content = 'Cheap Flights ' + fromName + ' → ' + toName + ' | NordicWings';
  let ogDesc = document.querySelector('meta[property="og:description"]');
  if (ogDesc) ogDesc.content = desc;
  let ogUrl = document.querySelector('meta[property="og:url"]');
  if (ogUrl) ogUrl.content = url;
  // Twitter/X
  let twTitle = document.querySelector('meta[name="twitter:title"]');
  if (twTitle) twTitle.content = 'Cheap Flights ' + fromName + ' → ' + toName + ' | NordicWings';
  let twDesc = document.querySelector('meta[name="twitter:description"]');
  if (twDesc) twDesc.content = desc;
  let twUrl = document.querySelector('meta[name="twitter:url"]');
  if (twUrl) twUrl.content = url;
}
function checkUrlParams() {
  const params = new URLSearchParams(window.location.search);
  const from   = (params.get('from') || '').toUpperCase();
  const to     = (params.get('to')   || '').toUpperCase();
  if (from && to) {
    updateSeoForRoute(from, to);
    // Pre-fill and auto-search
    const originEl = document.getElementById('origin');
    const destEl   = document.getElementById('destination');
    if (originEl) originEl.value = from;
    if (destEl)   destEl.value   = to;
    searchFlights();
  }
}
// Run on page load
document.addEventListener('DOMContentLoaded', checkUrlParams);

// ─────────────────────────────────────────────────────────────
// BROWSER BACK BUTTON — return to homepage search from results
// ─────────────────────────────────────────────────────────────
window.addEventListener('popstate', function(e) {
  // If user presses Back from results page, go back to homepage search view
  const resultsList = document.getElementById('results-list');
  const resultsSection = document.getElementById('results-section') || document.querySelector('.results-section');
  const searchSection = document.getElementById('search-section') || document.querySelector('.search-section');

  if (resultsList) resultsList.style.display = 'none';

  // Scroll back to top / search form
  window.scrollTo({ top: 0, behavior: 'smooth' });

  // If we have no state (back to homepage), clear URL params cleanly
  if (!e.state || e.state.view !== 'results') {
    // Replace URL back to clean homepage
    history.replaceState(null, '', '/');
  }
});

// ─────────────────────────────────────────────────────────────
// PAGE NAVIGATION
// ─────────────────────────────────────────────────────────────
function showPage(pageId) {
  var target = document.getElementById('page-' + pageId);
  if (!target) { target = document.getElementById('page-home'); }
  if (!target) return;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  target.classList.add('active');
  window.scrollTo({ top: 0, behavior: 'instant' });

  // Load data when navigating to special pages
  if (pageId === 'dashboard') loadDashboard();
  if (pageId === 'admin')     loadAdminDashboard();
}

// ─────────────────────────────────────────────────────────────
// QUICK SEARCH — called from popular destination cards
// Pre-fills origin/destination and triggers search
// ─────────────────────────────────────────────────────────────
function filterRoutes(region, btn) {
  document.querySelectorAll('.route-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.dest-card').forEach(card => {
    if (region === 'all' || card.dataset.region === region) {
      card.classList.remove('hidden');
    } else {
      card.classList.add('hidden');
    }
  });
}

function quickSearch(orig, dest) {
  // Fill origin input
  const originInput = document.getElementById('origin-input');
  const destInput   = document.getElementById('dest-input');
  const dateInput   = document.getElementById('depart-input');

  originInput.value = orig;
  originInput.dataset.code = orig;
  destInput.value   = dest;
  destInput.dataset.code = dest;

  // Set date to 30 days from today if not already set
  if (!dateInput.value) {
    const d = new Date();
    d.setDate(d.getDate() + 30);
    dateInput.value = d.toISOString().split('T')[0];
  }

  // Scroll to search form and trigger search
  showPage('home');
  setTimeout(() => {
    document.querySelector('.search-box') && document.querySelector('.search-box').scrollIntoView({ behavior: 'smooth' });
    setTimeout(() => searchFlights(), 400);
  }, 100);
}

// quickFill — called from popular route buttons e.g. quickFill('HEL','Helsinki','LHR','London')
function quickFill(origCode, origName, destCode, destName) {
  var originInput = document.getElementById('origin-input');
  var destInput   = document.getElementById('dest-input');
  var dateInput   = document.getElementById('depart-input');
  if (originInput) { originInput.value = origCode + ' — ' + origName; originInput.dataset.code = origCode; }
  if (destInput)   { destInput.value   = destCode + ' — ' + destName;   destInput.dataset.code = destCode; }
  if (dateInput && !dateInput.value) {
    var d = new Date(); d.setDate(d.getDate() + 30);
    dateInput.value = d.toISOString().split('T')[0];
  }
  _lastSearchTs = 0;
  showPage('home');
  setTimeout(function() { window.scrollTo({top:0,behavior:'smooth'}); setTimeout(searchFlights, 300); }, 80);
}

// ─────────────────────────────────────────────────────────────
// TRIP TYPE (one-way / round-trip)
// ─────────────────────────────────────────────────────────────
function setTripType(type) {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.type === type);
  });
  document.getElementById('return-group').style.display =
    type === 'round-trip' ? 'flex' : 'none';
}

// ─────────────────────────────────────────────────────────────
// AIRPORT AUTOCOMPLETE
let autocompleteTimers = {};

const POPULAR_AIRPORTS = [
  // Finland
  {iataCode:'HEL',name:'Helsinki-Vantaa Airport',cityName:'Helsinki',countryName:'Finland'},
  {iataCode:'OUL',name:'Oulu Airport',cityName:'Oulu',countryName:'Finland'},
  {iataCode:'TMP',name:'Tampere-Pirkkala Airport',cityName:'Tampere',countryName:'Finland'},
  {iataCode:'TKU',name:'Turku Airport',cityName:'Turku',countryName:'Finland'},
  {iataCode:'RVN',name:'Rovaniemi Airport',cityName:'Rovaniemi',countryName:'Finland'},
  // Scandinavia
  {iataCode:'OSL',name:'Oslo Gardermoen Airport',cityName:'Oslo',countryName:'Norway'},
  {iataCode:'ARN',name:'Stockholm Arlanda Airport',cityName:'Stockholm',countryName:'Sweden'},
  {iataCode:'CPH',name:'Copenhagen Airport',cityName:'Copenhagen',countryName:'Denmark'},
  {iataCode:'BGO',name:'Bergen Airport',cityName:'Bergen',countryName:'Norway'},
  {iataCode:'GOT',name:'Gothenburg Landvetter Airport',cityName:'Gothenburg',countryName:'Sweden'},
  // UK & Ireland
  {iataCode:'LHR',name:'Heathrow Airport',cityName:'London',countryName:'United Kingdom'},
  {iataCode:'LGW',name:'London Gatwick Airport',cityName:'London',countryName:'United Kingdom'},
  {iataCode:'MAN',name:'Manchester Airport',cityName:'Manchester',countryName:'United Kingdom'},
  {iataCode:'EDI',name:'Edinburgh Airport',cityName:'Edinburgh',countryName:'United Kingdom'},
  {iataCode:'BHX',name:'Birmingham Airport',cityName:'Birmingham',countryName:'United Kingdom'},
  {iataCode:'DUB',name:'Dublin Airport',cityName:'Dublin',countryName:'Ireland'},
  // Western Europe
  {iataCode:'CDG',name:'Charles de Gaulle Airport',cityName:'Paris',countryName:'France'},
  {iataCode:'ORY',name:'Paris Orly Airport',cityName:'Paris',countryName:'France'},
  {iataCode:'AMS',name:'Amsterdam Schiphol Airport',cityName:'Amsterdam',countryName:'Netherlands'},
  {iataCode:'FRA',name:'Frankfurt Airport',cityName:'Frankfurt',countryName:'Germany'},
  {iataCode:'MUC',name:'Munich Airport',cityName:'Munich',countryName:'Germany'},
  {iataCode:'BER',name:'Berlin Brandenburg Airport',cityName:'Berlin',countryName:'Germany'},
  {iataCode:'HAM',name:'Hamburg Airport',cityName:'Hamburg',countryName:'Germany'},
  {iataCode:'DUS',name:'Dusseldorf Airport',cityName:'Dusseldorf',countryName:'Germany'},
  {iataCode:'ZRH',name:'Zurich Airport',cityName:'Zurich',countryName:'Switzerland'},
  {iataCode:'GVA',name:'Geneva Airport',cityName:'Geneva',countryName:'Switzerland'},
  {iataCode:'VIE',name:'Vienna International Airport',cityName:'Vienna',countryName:'Austria'},
  {iataCode:'BRU',name:'Brussels Airport',cityName:'Brussels',countryName:'Belgium'},
  // Southern Europe
  {iataCode:'MAD',name:'Adolfo Suarez Madrid-Barajas',cityName:'Madrid',countryName:'Spain'},
  {iataCode:'BCN',name:'Barcelona El Prat Airport',cityName:'Barcelona',countryName:'Spain'},
  {iataCode:'PMI',name:'Palma de Mallorca Airport',cityName:'Palma',countryName:'Spain'},
  {iataCode:'AGP',name:'Malaga Airport',cityName:'Malaga',countryName:'Spain'},
  {iataCode:'LIS',name:'Lisbon Airport',cityName:'Lisbon',countryName:'Portugal'},
  {iataCode:'OPO',name:'Porto Airport',cityName:'Porto',countryName:'Portugal'},
  {iataCode:'FCO',name:'Rome Fiumicino Airport',cityName:'Rome',countryName:'Italy'},
  {iataCode:'MXP',name:'Milan Malpensa Airport',cityName:'Milan',countryName:'Italy'},
  {iataCode:'VCE',name:'Venice Marco Polo Airport',cityName:'Venice',countryName:'Italy'},
  {iataCode:'NCE',name:'Nice Cote d Azur Airport',cityName:'Nice',countryName:'France'},
  {iataCode:'ATH',name:'Athens International Airport',cityName:'Athens',countryName:'Greece'},
  {iataCode:'SKG',name:'Thessaloniki Airport',cityName:'Thessaloniki',countryName:'Greece'},
  // Eastern Europe — Poland
  {iataCode:'WAW',name:'Warsaw Chopin Airport',cityName:'Warsaw',countryName:'Poland'},
  {iataCode:'KRK',name:'Krakow John Paul II Airport',cityName:'Krakow',countryName:'Poland'},
  {iataCode:'GDN',name:'Gdansk Lech Walesa Airport',cityName:'Gdansk',countryName:'Poland'},
  {iataCode:'WRO',name:'Wroclaw Airport',cityName:'Wroclaw',countryName:'Poland'},
  {iataCode:'POZ',name:'Poznan Lawica Airport',cityName:'Poznan',countryName:'Poland'},
  {iataCode:'KTW',name:'Katowice International Airport',cityName:'Katowice',countryName:'Poland'},
  // Eastern Europe — other
  {iataCode:'PRG',name:'Prague Vaclav Havel Airport',cityName:'Prague',countryName:'Czech Republic'},
  {iataCode:'BUD',name:'Budapest Ferenc Liszt Airport',cityName:'Budapest',countryName:'Hungary'},
  {iataCode:'OTP',name:'Bucharest Henri Coanda Airport',cityName:'Bucharest',countryName:'Romania'},
  {iataCode:'SOF',name:'Sofia Airport',cityName:'Sofia',countryName:'Bulgaria'},
  {iataCode:'ZAG',name:'Zagreb Airport',cityName:'Zagreb',countryName:'Croatia'},
  {iataCode:'BEG',name:'Belgrade Nikola Tesla Airport',cityName:'Belgrade',countryName:'Serbia'},
  {iataCode:'VNO',name:'Vilnius Airport',cityName:'Vilnius',countryName:'Lithuania'},
  {iataCode:'RIX',name:'Riga International Airport',cityName:'Riga',countryName:'Latvia'},
  {iataCode:'TLL',name:'Tallinn Airport',cityName:'Tallinn',countryName:'Estonia'},
  {iataCode:'KBP',name:'Kyiv Boryspil Airport',cityName:'Kyiv',countryName:'Ukraine'},
  {iataCode:'IST',name:'Istanbul Airport',cityName:'Istanbul',countryName:'Turkey'},
  {iataCode:'SAW',name:'Istanbul Sabiha Airport',cityName:'Istanbul',countryName:'Turkey'},
  {iataCode:'ADB',name:'Izmir Adnan Menderes Airport',cityName:'Izmir',countryName:'Turkey'},
  // Middle East
  {iataCode:'DXB',name:'Dubai International Airport',cityName:'Dubai',countryName:'UAE'},
  {iataCode:'AUH',name:'Abu Dhabi International Airport',cityName:'Abu Dhabi',countryName:'UAE'},
  {iataCode:'DOH',name:'Hamad International Airport',cityName:'Doha',countryName:'Qatar'},
  {iataCode:'RUH',name:'King Khalid International Airport',cityName:'Riyadh',countryName:'Saudi Arabia'},
  {iataCode:'JED',name:'King Abdulaziz International Airport',cityName:'Jeddah',countryName:'Saudi Arabia'},
  {iataCode:'MCT',name:'Muscat International Airport',cityName:'Muscat',countryName:'Oman'},
  {iataCode:'KWI',name:'Kuwait International Airport',cityName:'Kuwait City',countryName:'Kuwait'},
  {iataCode:'BAH',name:'Bahrain International Airport',cityName:'Manama',countryName:'Bahrain'},
  {iataCode:'AMM',name:'Queen Alia International Airport',cityName:'Amman',countryName:'Jordan'},
  {iataCode:'TLV',name:'Ben Gurion International Airport',cityName:'Tel Aviv',countryName:'Israel'},
  {iataCode:'BEY',name:'Beirut Rafic Hariri Airport',cityName:'Beirut',countryName:'Lebanon'},
  // Asia
  {iataCode:'BKK',name:'Suvarnabhumi Airport',cityName:'Bangkok',countryName:'Thailand'},
  {iataCode:'HKT',name:'Phuket International Airport',cityName:'Phuket',countryName:'Thailand'},
  {iataCode:'CNX',name:'Chiang Mai International Airport',cityName:'Chiang Mai',countryName:'Thailand'},
  {iataCode:'SIN',name:'Singapore Changi Airport',cityName:'Singapore',countryName:'Singapore'},
  {iataCode:'KUL',name:'Kuala Lumpur International Airport',cityName:'Kuala Lumpur',countryName:'Malaysia'},
  {iataCode:'PEN',name:'Penang International Airport',cityName:'Penang',countryName:'Malaysia'},
  {iataCode:'CGK',name:'Soekarno-Hatta International Airport',cityName:'Jakarta',countryName:'Indonesia'},
  {iataCode:'DPS',name:'Ngurah Rai International Airport',cityName:'Bali',countryName:'Indonesia'},
  {iataCode:'MNL',name:'Ninoy Aquino International Airport',cityName:'Manila',countryName:'Philippines'},
  {iataCode:'CEB',name:'Mactan-Cebu International Airport',cityName:'Cebu',countryName:'Philippines'},
  {iataCode:'DVO',name:'Francisco Bangoy International Airport',cityName:'Davao',countryName:'Philippines'},
  {iataCode:'ILO',name:'Iloilo International Airport',cityName:'Iloilo',countryName:'Philippines'},
  {iataCode:'BCD',name:'Bacolod-Silay Airport',cityName:'Bacolod',countryName:'Philippines'},
  {iataCode:'KLO',name:'Kalibo International Airport',cityName:'Kalibo (Boracay)',countryName:'Philippines'},
  {iataCode:'MPH',name:'Godofredo P. Ramos Airport',cityName:'Caticlan (Boracay)',countryName:'Philippines'},
  {iataCode:'PPS',name:'Puerto Princesa Airport',cityName:'Puerto Princesa (Palawan)',countryName:'Philippines'},
  {iataCode:'ENI',name:'El Nido Airport',cityName:'El Nido (Palawan)',countryName:'Philippines'},
  {iataCode:'USU',name:'Francisco B. Reyes Airport',cityName:'Coron / Busuanga',countryName:'Philippines'},
  {iataCode:'TAG',name:'Bohol-Panglao International Airport',cityName:'Tagbilaran (Bohol)',countryName:'Philippines'},
  {iataCode:'ZAM',name:'Zamboanga International Airport',cityName:'Zamboanga',countryName:'Philippines'},
  {iataCode:'CGY',name:'Laguindingan Airport',cityName:'Cagayan de Oro',countryName:'Philippines'},
  {iataCode:'GES',name:'General Santos Airport',cityName:'General Santos',countryName:'Philippines'},
  {iataCode:'DGT',name:'Sibulan Airport',cityName:'Dumaguete',countryName:'Philippines'},
  {iataCode:'TAC',name:'Daniel Z. Romualdez Airport',cityName:'Tacloban',countryName:'Philippines'},
  {iataCode:'CRK',name:'Clark International Airport',cityName:'Clark (Angeles)',countryName:'Philippines'},
  {iataCode:'LGP',name:'Legazpi Airport',cityName:'Legazpi',countryName:'Philippines'},
  {iataCode:'BXU',name:'Bancasi Airport',cityName:'Butuan',countryName:'Philippines'},
  {iataCode:'OZC',name:'Labo Airport',cityName:'Ozamiz',countryName:'Philippines'},
  {iataCode:'LAO',name:'Laoag International Airport',cityName:'Laoag',countryName:'Philippines'},
  {iataCode:'TUG',name:'Tuguegarao Airport',cityName:'Tuguegarao',countryName:'Philippines'},
  {iataCode:'RXS',name:'Roxas Airport',cityName:'Roxas City',countryName:'Philippines'},
  {iataCode:'SUG',name:'Surigao Airport',cityName:'Surigao',countryName:'Philippines'},
  {iataCode:'DPL',name:'Dipolog Airport',cityName:'Dipolog',countryName:'Philippines'},
  // Thailand domestic
  {iataCode:'HKT',name:'Phuket International Airport',cityName:'Phuket',countryName:'Thailand'},
  {iataCode:'CNX',name:'Chiang Mai International Airport',cityName:'Chiang Mai',countryName:'Thailand'},
  {iataCode:'USM',name:'Samui Airport',cityName:'Koh Samui',countryName:'Thailand'},
  {iataCode:'HDY',name:'Hat Yai International Airport',cityName:'Hat Yai',countryName:'Thailand'},
  {iataCode:'KBV',name:'Krabi Airport',cityName:'Krabi',countryName:'Thailand'},
  {iataCode:'UTP',name:'U-Tapao Airport',cityName:'Pattaya',countryName:'Thailand'},
  {iataCode:'CEI',name:'Chiang Rai Airport',cityName:'Chiang Rai',countryName:'Thailand'},
  {iataCode:'HGN',name:'Mae Hong Son Airport',cityName:'Mae Hong Son',countryName:'Thailand'},
  // Indonesia domestic
  {iataCode:'SUB',name:'Juanda International Airport',cityName:'Surabaya',countryName:'Indonesia'},
  {iataCode:'JOG',name:'Yogyakarta International Airport',cityName:'Yogyakarta',countryName:'Indonesia'},
  {iataCode:'UPG',name:'Sultan Hasanuddin Airport',cityName:'Makassar',countryName:'Indonesia'},
  {iataCode:'MDC',name:'Sam Ratulangi Airport',cityName:'Manado',countryName:'Indonesia'},
  {iataCode:'LOP',name:'Lombok International Airport',cityName:'Lombok',countryName:'Indonesia'},
  {iataCode:'BPN',name:'Sultan Aji Muhammad Sulaiman Airport',cityName:'Balikpapan',countryName:'Indonesia'},
  {iataCode:'AMQ',name:'Pattimura Airport',cityName:'Ambon',countryName:'Indonesia'},
  {iataCode:'DJJ',name:'Sentani Airport',cityName:'Jayapura',countryName:'Indonesia'},
  {iataCode:'PLM',name:'Sultan Mahmud Badaruddin II Airport',cityName:'Palembang',countryName:'Indonesia'},
  {iataCode:'PKU',name:'Sultan Syarif Kasim II Airport',cityName:'Pekanbaru',countryName:'Indonesia'},
  {iataCode:'SRG',name:'Ahmad Yani Airport',cityName:'Semarang',countryName:'Indonesia'},
  {iataCode:'PNK',name:'Supadio Airport',cityName:'Pontianak',countryName:'Indonesia'},
  {iataCode:'TIM',name:'Moses Kilangin Airport',cityName:'Timika',countryName:'Indonesia'},
  // Malaysia domestic
  {iataCode:'LGK',name:'Langkawi International Airport',cityName:'Langkawi',countryName:'Malaysia'},
  {iataCode:'BKI',name:'Kota Kinabalu International Airport',cityName:'Kota Kinabalu',countryName:'Malaysia'},
  {iataCode:'KCH',name:'Kuching International Airport',cityName:'Kuching',countryName:'Malaysia'},
  {iataCode:'MYY',name:'Miri Airport',cityName:'Miri',countryName:'Malaysia'},
  {iataCode:'JHB',name:'Senai International Airport',cityName:'Johor Bahru',countryName:'Malaysia'},
  {iataCode:'SDK',name:'Sandakan Airport',cityName:'Sandakan',countryName:'Malaysia'},
  {iataCode:'IPH',name:'Sultan Azlan Shah Airport',cityName:'Ipoh',countryName:'Malaysia'},
  {iataCode:'KUA',name:'Kuantan Airport',cityName:'Kuantan',countryName:'Malaysia'},
  // Vietnam domestic
  {iataCode:'PQC',name:'Phu Quoc International Airport',cityName:'Phu Quoc',countryName:'Vietnam'},
  {iataCode:'CXR',name:'Cam Ranh Airport',cityName:'Nha Trang',countryName:'Vietnam'},
  {iataCode:'HUI',name:'Phu Bai Airport',cityName:'Hue',countryName:'Vietnam'},
  {iataCode:'VCA',name:'Can Tho International Airport',cityName:'Can Tho',countryName:'Vietnam'},
  {iataCode:'DIN',name:'Dien Bien Phu Airport',cityName:'Dien Bien Phu',countryName:'Vietnam'},
  {iataCode:'VCS',name:'Con Dao Airport',cityName:'Con Dao',countryName:'Vietnam'},
  // Middle East
  {iataCode:'MCT',name:'Muscat International Airport',cityName:'Muscat',countryName:'Oman'},
  {iataCode:'BAH',name:'Bahrain International Airport',cityName:'Bahrain',countryName:'Bahrain'},
  {iataCode:'KWI',name:'Kuwait International Airport',cityName:'Kuwait City',countryName:'Kuwait'},
  {iataCode:'JED',name:'King Abdulaziz International Airport',cityName:'Jeddah',countryName:'Saudi Arabia'},
  {iataCode:'RUH',name:'King Khalid International Airport',cityName:'Riyadh',countryName:'Saudi Arabia'},
  {iataCode:'TBS',name:'Tbilisi International Airport',cityName:'Tbilisi',countryName:'Georgia'},
  {iataCode:'EVN',name:'Zvartnots International Airport',cityName:'Yerevan',countryName:'Armenia'},
  {iataCode:'GYD',name:'Heydar Aliyev International Airport',cityName:'Baku',countryName:'Azerbaijan'},
  // Japan domestic
  {iataCode:'OKA',name:'Naha Airport',cityName:'Okinawa',countryName:'Japan'},
  {iataCode:'CTS',name:'New Chitose Airport',cityName:'Sapporo',countryName:'Japan'},
  {iataCode:'NGO',name:'Chubu Centrair International Airport',cityName:'Nagoya',countryName:'Japan'},
  {iataCode:'HIJ',name:'Hiroshima Airport',cityName:'Hiroshima',countryName:'Japan'},
  // South Korea domestic
  {iataCode:'CJU',name:'Jeju International Airport',cityName:'Jeju',countryName:'South Korea'},
  // Australia domestic
  {iataCode:'CNS',name:'Cairns Airport',cityName:'Cairns',countryName:'Australia'},
  {iataCode:'DRW',name:'Darwin Airport',cityName:'Darwin',countryName:'Australia'},
  {iataCode:'OOL',name:'Gold Coast Airport',cityName:'Gold Coast',countryName:'Australia'},
  {iataCode:'HBA',name:'Hobart Airport',cityName:'Hobart',countryName:'Australia'},
  // New Zealand
  {iataCode:'AKL',name:'Auckland Airport',cityName:'Auckland',countryName:'New Zealand'},
  {iataCode:'CHC',name:'Christchurch Airport',cityName:'Christchurch',countryName:'New Zealand'},
  {iataCode:'WLG',name:'Wellington Airport',cityName:'Wellington',countryName:'New Zealand'},
  // More Europe
  {iataCode:'OPO',name:'Francisco Sá Carneiro Airport',cityName:'Porto',countryName:'Portugal'},
  {iataCode:'FAO',name:'Faro Airport',cityName:'Faro (Algarve)',countryName:'Portugal'},
  {iataCode:'LIS',name:'Humberto Delgado Airport',cityName:'Lisbon',countryName:'Portugal'},
  {iataCode:'TFS',name:'Tenerife South Airport',cityName:'Tenerife',countryName:'Spain'},
  {iataCode:'LPA',name:'Gran Canaria Airport',cityName:'Gran Canaria',countryName:'Spain'},
  {iataCode:'IBZ',name:'Ibiza Airport',cityName:'Ibiza',countryName:'Spain'},
  {iataCode:'PMI',name:'Palma de Mallorca Airport',cityName:'Mallorca',countryName:'Spain'},
  {iataCode:'HER',name:'Heraklion Airport',cityName:'Heraklion (Crete)',countryName:'Greece'},
  {iataCode:'RHO',name:'Rhodes International Airport',cityName:'Rhodes',countryName:'Greece'},
  {iataCode:'JMK',name:'Mykonos Airport',cityName:'Mykonos',countryName:'Greece'},
  {iataCode:'JTR',name:'Santorini Airport',cityName:'Santorini',countryName:'Greece'},
  {iataCode:'CFU',name:'Corfu Airport',cityName:'Corfu',countryName:'Greece'},
  {iataCode:'SKG',name:'Thessaloniki Airport',cityName:'Thessaloniki',countryName:'Greece'},
  {iataCode:'SPU',name:'Split Airport',cityName:'Split',countryName:'Croatia'},
  {iataCode:'DBV',name:'Dubrovnik Airport',cityName:'Dubrovnik',countryName:'Croatia'},
  {iataCode:'ZAG',name:'Zagreb Airport',cityName:'Zagreb',countryName:'Croatia'},
  {iataCode:'TGD',name:'Podgorica Airport',cityName:'Podgorica',countryName:'Montenegro'},
  {iataCode:'TIV',name:'Tivat Airport',cityName:'Tivat',countryName:'Montenegro'},
  {iataCode:'SKP',name:'Skopje Airport',cityName:'Skopje',countryName:'North Macedonia'},
  {iataCode:'TIA',name:'Tirana International Airport',cityName:'Tirana',countryName:'Albania'},
  {iataCode:'SOF',name:'Sofia Airport',cityName:'Sofia',countryName:'Bulgaria'},
  {iataCode:'OTP',name:'Henri Coanda International Airport',cityName:'Bucharest',countryName:'Romania'},
  {iataCode:'KIV',name:'Chisinau International Airport',cityName:'Chisinau',countryName:'Moldova'},
  {iataCode:'RIX',name:'Riga International Airport',cityName:'Riga',countryName:'Latvia'},
  {iataCode:'TLL',name:'Tallinn Airport',cityName:'Tallinn',countryName:'Estonia'},
  {iataCode:'VNO',name:'Vilnius Airport',cityName:'Vilnius',countryName:'Lithuania'},
  // Americas
  {iataCode:'CUN',name:'Cancun International Airport',cityName:'Cancun',countryName:'Mexico'},
  {iataCode:'MEX',name:'Benito Juarez International Airport',cityName:'Mexico City',countryName:'Mexico'},
  {iataCode:'GDL',name:'Miguel Hidalgo Airport',cityName:'Guadalajara',countryName:'Mexico'},
  {iataCode:'BOG',name:'El Dorado International Airport',cityName:'Bogota',countryName:'Colombia'},
  {iataCode:'MDE',name:'Jose Maria Cordova Airport',cityName:'Medellin',countryName:'Colombia'},
  {iataCode:'CTG',name:'Rafael Nunez Airport',cityName:'Cartagena',countryName:'Colombia'},
  {iataCode:'GRU',name:'Sao Paulo Guarulhos Airport',cityName:'Sao Paulo',countryName:'Brazil'},
  {iataCode:'GIG',name:'Rio de Janeiro Galeao Airport',cityName:'Rio de Janeiro',countryName:'Brazil'},
  {iataCode:'EZE',name:'Ezeiza International Airport',cityName:'Buenos Aires',countryName:'Argentina'},
  {iataCode:'SCL',name:'Santiago Airport',cityName:'Santiago',countryName:'Chile'},
  {iataCode:'LIM',name:'Jorge Chavez International Airport',cityName:'Lima',countryName:'Peru'},
  {iataCode:'UIO',name:'Quito International Airport',cityName:'Quito',countryName:'Ecuador'},
  // Africa
  {iataCode:'ZNZ',name:'Abeid Amani Karume Airport',cityName:'Zanzibar',countryName:'Tanzania'},
  {iataCode:'MBA',name:'Moi International Airport',cityName:'Mombasa',countryName:'Kenya'},
  {iataCode:'MRU',name:'Sir Seewoosagur Ramgoolam Airport',cityName:'Mauritius',countryName:'Mauritius'},
  {iataCode:'RUN',name:'Roland Garros Airport',cityName:'Reunion',countryName:'Reunion'},
  {iataCode:'SEZ',name:'Seychelles International Airport',cityName:'Mahe',countryName:'Seychelles'},
  // India domestic
  {iataCode:'GOI',name:'Goa International Airport',cityName:'Goa',countryName:'India'},
  {iataCode:'HYD',name:'Rajiv Gandhi International Airport',cityName:'Hyderabad',countryName:'India'},
  {iataCode:'AMD',name:'Sardar Vallabhbhai Patel Airport',cityName:'Ahmedabad',countryName:'India'},
  {iataCode:'COK',name:'Cochin International Airport',cityName:'Kochi',countryName:'India'},
  {iataCode:'TRV',name:'Trivandrum International Airport',cityName:'Trivandrum',countryName:'India'},
  {iataCode:'PNQ',name:'Pune Airport',cityName:'Pune',countryName:'India'},
  {iataCode:'JAI',name:'Jaipur Airport',cityName:'Jaipur',countryName:'India'},
  {iataCode:'ATQ',name:'Sri Guru Ram Dass Jee Airport',cityName:'Amritsar',countryName:'India'},
  {iataCode:'IXC',name:'Chandigarh Airport',cityName:'Chandigarh',countryName:'India'},
  {iataCode:'BBI',name:'Biju Patnaik Airport',cityName:'Bhubaneswar',countryName:'India'},
  {iataCode:'GAU',name:'Lokpriya Gopinath Bordoloi Airport',cityName:'Guwahati',countryName:'India'},
  {iataCode:'IXB',name:'Bagdogra Airport',cityName:'Siliguri',countryName:'India'},
  // Nordic/Finland domestic
  {iataCode:'TMP',name:'Tampere-Pirkkala Airport',cityName:'Tampere',countryName:'Finland'},
  {iataCode:'TKU',name:'Turku Airport',cityName:'Turku',countryName:'Finland'},
  {iataCode:'OUL',name:'Oulu Airport',cityName:'Oulu',countryName:'Finland'},
  {iataCode:'RVN',name:'Rovaniemi Airport',cityName:'Rovaniemi',countryName:'Finland'},
  {iataCode:'JOE',name:'Joensuu Airport',cityName:'Joensuu',countryName:'Finland'},
  {iataCode:'JYV',name:'Jyvaskyla Airport',cityName:'Jyvaskyla',countryName:'Finland'},
  {iataCode:'KAO',name:'Kuusamo Airport',cityName:'Kuusamo',countryName:'Finland'},
  {iataCode:'KEM',name:'Kemi-Tornio Airport',cityName:'Kemi',countryName:'Finland'},
  {iataCode:'KTT',name:'Kittila Airport',cityName:'Kittila',countryName:'Finland'},
  {iataCode:'MHQ',name:'Mariehamn Airport',cityName:'Mariehamn',countryName:'Finland'},
  {iataCode:'VRK',name:'Varkaus Airport',cityName:'Varkaus',countryName:'Finland'},
  {iataCode:'NRT',name:'Tokyo Narita International Airport',cityName:'Tokyo',countryName:'Japan'},
  {iataCode:'HND',name:'Tokyo Haneda Airport',cityName:'Tokyo',countryName:'Japan'},
  {iataCode:'KIX',name:'Kansai International Airport',cityName:'Osaka',countryName:'Japan'},
  {iataCode:'FUK',name:'Fukuoka Airport',cityName:'Fukuoka',countryName:'Japan'},
  {iataCode:'ICN',name:'Incheon International Airport',cityName:'Seoul',countryName:'South Korea'},
  {iataCode:'GMP',name:'Gimpo International Airport',cityName:'Seoul',countryName:'South Korea'},
  {iataCode:'PUS',name:'Gimhae International Airport',cityName:'Busan',countryName:'South Korea'},
  {iataCode:'PEK',name:'Beijing Capital International Airport',cityName:'Beijing',countryName:'China'},
  {iataCode:'PVG',name:'Shanghai Pudong International Airport',cityName:'Shanghai',countryName:'China'},
  {iataCode:'CAN',name:'Guangzhou Baiyun International Airport',cityName:'Guangzhou',countryName:'China'},
  {iataCode:'HKG',name:'Hong Kong International Airport',cityName:'Hong Kong',countryName:'Hong Kong'},
  {iataCode:'TPE',name:'Taiwan Taoyuan International Airport',cityName:'Taipei',countryName:'Taiwan'},
  {iataCode:'SGN',name:'Tan Son Nhat International Airport',cityName:'Ho Chi Minh City',countryName:'Vietnam'},
  {iataCode:'HAN',name:'Noi Bai International Airport',cityName:'Hanoi',countryName:'Vietnam'},
  {iataCode:'DAD',name:'Da Nang International Airport',cityName:'Da Nang',countryName:'Vietnam'},
  {iataCode:'PNH',name:'Phnom Penh International Airport',cityName:'Phnom Penh',countryName:'Cambodia'},
  {iataCode:'REP',name:'Siem Reap International Airport',cityName:'Siem Reap',countryName:'Cambodia'},
  {iataCode:'RGN',name:'Yangon International Airport',cityName:'Yangon',countryName:'Myanmar'},
  {iataCode:'MLE',name:'Velana International Airport',cityName:'Male',countryName:'Maldives'},
  {iataCode:'CMB',name:'Bandaranaike International Airport',cityName:'Colombo',countryName:'Sri Lanka'},
  {iataCode:'KTM',name:'Tribhuvan International Airport',cityName:'Kathmandu',countryName:'Nepal'},
  {iataCode:'DEL',name:'Indira Gandhi International Airport',cityName:'New Delhi',countryName:'India'},
  {iataCode:'BOM',name:'Chhatrapati Shivaji International Airport',cityName:'Mumbai',countryName:'India'},
  {iataCode:'BLR',name:'Kempegowda International Airport',cityName:'Bangalore',countryName:'India'},
  {iataCode:'MAA',name:'Chennai International Airport',cityName:'Chennai',countryName:'India'},
  {iataCode:'CCU',name:'Netaji Subhas Chandra Bose Airport',cityName:'Kolkata',countryName:'India'},
  {iataCode:'KHI',name:'Jinnah International Airport',cityName:'Karachi',countryName:'Pakistan'},
  {iataCode:'LHE',name:'Allama Iqbal International Airport',cityName:'Lahore',countryName:'Pakistan'},
  {iataCode:'ISB',name:'Islamabad International Airport',cityName:'Islamabad',countryName:'Pakistan'},
  {iataCode:'DAC',name:'Hazrat Shahjalal International Airport',cityName:'Dhaka',countryName:'Bangladesh'},
  // Africa
  {iataCode:'CAI',name:'Cairo International Airport',cityName:'Cairo',countryName:'Egypt'},
  {iataCode:'NBO',name:'Jomo Kenyatta International Airport',cityName:'Nairobi',countryName:'Kenya'},
  {iataCode:'ADD',name:'Addis Ababa Bole International Airport',cityName:'Addis Ababa',countryName:'Ethiopia'},
  {iataCode:'LOS',name:'Murtala Muhammed International Airport',cityName:'Lagos',countryName:'Nigeria'},
  {iataCode:'ACC',name:'Kotoka International Airport',cityName:'Accra',countryName:'Ghana'},
  {iataCode:'JNB',name:'OR Tambo International Airport',cityName:'Johannesburg',countryName:'South Africa'},
  {iataCode:'CPT',name:'Cape Town International Airport',cityName:'Cape Town',countryName:'South Africa'},
  {iataCode:'CMN',name:'Mohammed V International Airport',cityName:'Casablanca',countryName:'Morocco'},
  {iataCode:'RAK',name:'Marrakech Menara Airport',cityName:'Marrakech',countryName:'Morocco'},
  {iataCode:'DAR',name:'Julius Nyerere International Airport',cityName:'Dar es Salaam',countryName:'Tanzania'},
  {iataCode:'KGL',name:'Kigali International Airport',cityName:'Kigali',countryName:'Rwanda'},
  // Australia & Pacific
  {iataCode:'SYD',name:'Sydney Kingsford Smith Airport',cityName:'Sydney',countryName:'Australia'},
  {iataCode:'MEL',name:'Melbourne Airport',cityName:'Melbourne',countryName:'Australia'},
  {iataCode:'BNE',name:'Brisbane Airport',cityName:'Brisbane',countryName:'Australia'},
  {iataCode:'PER',name:'Perth Airport',cityName:'Perth',countryName:'Australia'},
  {iataCode:'ADL',name:'Adelaide Airport',cityName:'Adelaide',countryName:'Australia'},
  {iataCode:'AKL',name:'Auckland Airport',cityName:'Auckland',countryName:'New Zealand'},
  {iataCode:'CHC',name:'Christchurch International Airport',cityName:'Christchurch',countryName:'New Zealand'},
  // North America
  {iataCode:'JFK',name:'John F. Kennedy International Airport',cityName:'New York',countryName:'USA'},
  {iataCode:'EWR',name:'Newark Liberty International Airport',cityName:'New York',countryName:'USA'},
  {iataCode:'LAX',name:'Los Angeles International Airport',cityName:'Los Angeles',countryName:'USA'},
  {iataCode:'ORD',name:"O'Hare International Airport",cityName:'Chicago',countryName:'USA'},
  {iataCode:'MIA',name:'Miami International Airport',cityName:'Miami',countryName:'USA'},
  {iataCode:'DFW',name:'Dallas Fort Worth International Airport',cityName:'Dallas',countryName:'USA'},
  {iataCode:'IAH',name:'George Bush Intercontinental Airport',cityName:'Houston',countryName:'USA'},
  {iataCode:'SFO',name:'San Francisco International Airport',cityName:'San Francisco',countryName:'USA'},
  {iataCode:'SEA',name:'Seattle-Tacoma International Airport',cityName:'Seattle',countryName:'USA'},
  {iataCode:'BOS',name:'Logan International Airport',cityName:'Boston',countryName:'USA'},
  {iataCode:'ATL',name:'Hartsfield-Jackson Atlanta Airport',cityName:'Atlanta',countryName:'USA'},
  {iataCode:'DEN',name:'Denver International Airport',cityName:'Denver',countryName:'USA'},
  {iataCode:'LAS',name:'Harry Reid International Airport',cityName:'Las Vegas',countryName:'USA'},
  {iataCode:'MCO',name:'Orlando International Airport',cityName:'Orlando',countryName:'USA'},
  {iataCode:'IAD',name:'Dulles International Airport',cityName:'Washington DC',countryName:'USA'},
  {iataCode:'PHX',name:'Phoenix Sky Harbor Airport',cityName:'Phoenix',countryName:'USA'},
  {iataCode:'YYZ',name:'Toronto Pearson International Airport',cityName:'Toronto',countryName:'Canada'},
  {iataCode:'YVR',name:'Vancouver International Airport',cityName:'Vancouver',countryName:'Canada'},
  {iataCode:'YUL',name:'Montreal Pierre Elliott Trudeau Airport',cityName:'Montreal',countryName:'Canada'},
  {iataCode:'YYC',name:'Calgary International Airport',cityName:'Calgary',countryName:'Canada'},
  {iataCode:'MEX',name:'Benito Juarez International Airport',cityName:'Mexico City',countryName:'Mexico'},
  {iataCode:'CUN',name:'Cancun International Airport',cityName:'Cancun',countryName:'Mexico'},
  // South America
  {iataCode:'GRU',name:'Sao Paulo Guarulhos International Airport',cityName:'Sao Paulo',countryName:'Brazil'},
  {iataCode:'GIG',name:'Rio de Janeiro Galeao Airport',cityName:'Rio de Janeiro',countryName:'Brazil'},
  {iataCode:'EZE',name:'Ezeiza International Airport',cityName:'Buenos Aires',countryName:'Argentina'},
  {iataCode:'SCL',name:'Arturo Merino Benitez Airport',cityName:'Santiago',countryName:'Chile'},
  {iataCode:'LIM',name:'Jorge Chavez International Airport',cityName:'Lima',countryName:'Peru'},
  {iataCode:'BOG',name:'El Dorado International Airport',cityName:'Bogota',countryName:'Colombia'},
  {iataCode:'PTY',name:'Tocumen International Airport',cityName:'Panama City',countryName:'Panama'},
];

function showAcList(listEl, inputEl, airports, field) {
  var rect    = inputEl.getBoundingClientRect();
  var screenW = window.innerWidth;
  var screenH = window.innerHeight;
  var listW   = Math.min(Math.max(rect.width, 280), screenW - 16);
  var leftPos = Math.max(8, Math.min(rect.left, screenW - listW - 8));
  // If near bottom of visible screen, show ABOVE the input instead
  var spaceBelow = screenH - rect.bottom;
  var topPos = spaceBelow > 180 ? (rect.bottom + 4) : Math.max(8, rect.top - 270);
  listEl.style.cssText = 'display:block;position:fixed;top:'+topPos+'px;left:'+leftPos+'px;width:'+listW+'px;z-index:99999;max-height:260px;overflow-y:auto;-webkit-overflow-scrolling:touch;background:#fff;border:1px solid #dde3f0;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.18);list-style:none;padding:4px 0;';

  if (airports.length === 0) {
    listEl.innerHTML = '<li style="padding:14px 16px;color:#aaa;font-size:.9rem;text-align:center;">No airport found</li>';
    return;
  }
  var html = '';
  for (var i = 0; i < Math.min(airports.length, 8); i++) {
    var a    = airports[i];
    var city = (a.cityName || a.name).replace(/'/g, "&#39;");
    var aname = a.name.replace(/'/g, "&#39;");
    var country = (a.countryName || '').replace(/'/g, "&#39;");
    var code = a.iataCode;
    var eid  = (a.entityId || '').replace(/'/g, "&#39;");
    var fn   = "selectAirport('" + field + "','" + code + "','" + city + "','" + eid + "')";
    // Use both ontouchend and onclick for instant mobile response
    html += '<li ontouchend="event.preventDefault();'+fn+'" onclick="'+fn+'" style="padding:14px 16px;cursor:pointer;display:flex;align-items:center;gap:10px;border-bottom:1px solid #f0f2f8;-webkit-tap-highlight-color:transparent;">';
    html += '<span style="width:32px;height:32px;background:#e8efff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:1.1rem;flex-shrink:0;">✈️</span>';
    html += '<span><strong style="color:#1a2b4a;font-size:.95rem;">' + city + '</strong>';
    html += ' <span style="background:#1d4ed8;color:#fff;font-size:.7rem;font-weight:800;padding:2px 7px;border-radius:4px;">' + code + '</span><br>';
    html += '<span style="font-size:.78rem;color:#7a8aaa;">' + country + '</span></span>';
    html += '</li>';
  }
  listEl.innerHTML = html;
}

var _acTimers = {};
function airportSearch(field) {
  // Debounce — wait 200ms after user stops typing before searching
  clearTimeout(_acTimers[field]);
  _acTimers[field] = setTimeout(function() {
    _doAirportSearch(field);
  }, 200);
}

function _doAirportSearch(field) {
  var inputEl = document.getElementById(field === 'origin' ? 'origin-input' : 'dest-input');
  var listEl  = document.getElementById(field === 'origin' ? 'origin-list' : 'dest-list');
  if (!inputEl || !listEl) return;
  var keyword = inputEl.value.trim().toLowerCase();
  if (keyword.length < 1) { listEl.innerHTML = ''; listEl.style.display = 'none'; return; }

  var results = POPULAR_AIRPORTS.filter(function(a) {
    return a.cityName.toLowerCase().indexOf(keyword) !== -1 ||
           a.iataCode.toLowerCase().indexOf(keyword) !== -1 ||
           a.countryName.toLowerCase().indexOf(keyword) !== -1 ||
           a.name.toLowerCase().indexOf(keyword) !== -1;
  });
  results.sort(function(a, b) {
    var aStart = a.cityName.toLowerCase().indexOf(keyword) === 0 ? 0 : 1;
    var bStart = b.cityName.toLowerCase().indexOf(keyword) === 0 ? 0 : 1;
    return aStart - bStart;
  });

  if (results.length > 0) {
    showAcList(listEl, inputEl, results, field);
  } else {
    var rect = inputEl.getBoundingClientRect();
    var screenW = window.innerWidth;
    var listW = Math.min(Math.max(rect.width, 280), screenW - 16);
    var leftPos = Math.max(8, Math.min(rect.left, screenW - listW - 8));
    // Position above input if near bottom of screen
    var topPos = rect.bottom + 4;
    listEl.innerHTML = '<li style="padding:14px 16px;color:#aaa;font-size:.9rem;text-align:center;">No airport found — try typing e.g. HEL, CDG, LHR</li>';
    listEl.style.cssText = 'display:block;position:fixed;top:'+topPos+'px;left:'+leftPos+'px;width:'+listW+'px;z-index:99999;max-height:260px;overflow-y:auto;';
  }
}

function selectAirport(field, code, cityName, entityId) {
  const inputEl = document.getElementById(field === 'origin' ? 'origin-input' : 'dest-input');
  const listEl  = document.getElementById(field === 'origin' ? 'origin-list' : 'dest-list');
  inputEl.value = `${code} — ${unescape(cityName)}`;
  inputEl.dataset.code     = code;     // Store the IATA/Sky code
  inputEl.dataset.entityId = entityId; // Store the entityId for Sky Scrapper
  listEl.innerHTML = '';
}

// Close autocomplete when clicking elsewhere
document.addEventListener('click', e => {
  if (!e.target.closest('.autocomplete-wrap')) {
    document.querySelectorAll('.autocomplete-list').forEach(l => { l.innerHTML = ''; l.style.display = 'none'; });
  }
}, { passive: true });

function swapAirports() {
  const originInput = document.getElementById('origin-input');
  const destInput   = document.getElementById('dest-input');
  const tempVal  = originInput.value;
  const tempCode = originInput.dataset.code;
  originInput.value = destInput.value;
  originInput.dataset.code = destInput.dataset.code || '';
  destInput.value = tempVal;
  destInput.dataset.code = tempCode || '';
}

// ─────────────────────────────────────────────────────────────
// FLIGHT SEARCH
// Reads the form, calls /api/flights/search, shows results
// ─────────────────────────────────────────────────────────────
function generateClientFlights(orig, dest, date, numAdults) {
  const knownRoutes = {
    'HEL-LHR':{totalMins:195,stops:[],basePrice:130,airlines:['AY','BA','SK','LH','U2','FR']},
    'HEL-CDG':{totalMins:210,stops:[],basePrice:138,airlines:['AY','AF','LH','BA','SK','U2']},
    'HEL-AMS':{totalMins:195,stops:[],basePrice:125,airlines:['AY','KL','LH','BA','SK','U2']},
    'HEL-FRA':{totalMins:185,stops:[],basePrice:122,airlines:['AY','LH','BA','AF','SK','U2']},
    'HEL-BCN':{totalMins:300,stops:[],basePrice:145,airlines:['AY','VY','FR','IB','U2','SK']},
    'HEL-MAD':{totalMins:315,stops:[],basePrice:148,airlines:['AY','IB','FR','VY','LH','BA']},
    'HEL-FCO':{totalMins:270,stops:[],basePrice:142,airlines:['AY','AZ','FR','LH','BA','U2']},
    'HEL-ATH':{totalMins:270,stops:[],basePrice:155,airlines:['AY','A3','LH','BA','FR','SK']},
    'HEL-IST':{totalMins:225,stops:[],basePrice:160,airlines:['AY','TK','LH','BA','FR','PC']},
    'HEL-VIE':{totalMins:175,stops:[],basePrice:118,airlines:['AY','OS','LH','BA','SK','U2']},
    'HEL-ZRH':{totalMins:200,stops:[],basePrice:135,airlines:['AY','LX','LH','BA','SK','U2']},
    'HEL-ARN':{totalMins:60, stops:[],basePrice:55, airlines:['AY','SK','DY','SK','AY','DY']},
    'HEL-CPH':{totalMins:90, stops:[],basePrice:72, airlines:['AY','SK','DY','SK','AY','DY']},
    'HEL-OSL':{totalMins:105,stops:[],basePrice:78, airlines:['AY','SK','DY','SK','AY','DY']},
    'HEL-WAW':{totalMins:150,stops:[],basePrice:98, airlines:['AY','LO','FR','LH','SK','U2']},
    'HEL-BUD':{totalMins:185,stops:[],basePrice:112,airlines:['AY','W6','LH','BA','FR','SK']},
    'HEL-PRG':{totalMins:175,stops:[],basePrice:108,airlines:['AY','OK','LH','BA','FR','W6']},
    'HEL-DUB':{totalMins:195,stops:[],basePrice:130,airlines:['AY','EI','FR','BA','SK','LH']},
    'HEL-DXB':{totalMins:390,stops:[],basePrice:310,airlines:['AY','EK','QR','TK','LH','FZ']},
    'HEL-BKK':{totalMins:810,stops:['DXB'],basePrice:590,airlines:['AY','EK','TG','QR','TK','LH']},
    'HEL-SIN':{totalMins:870,stops:['DXB'],basePrice:620,airlines:['AY','SQ','EK','QR','TK','LH']},
    'HEL-MNL':{totalMins:960,stops:['DXB'],basePrice:650,airlines:['AY','EK','QR','TK','PR','LH']},
    'HEL-JFK':{totalMins:570,stops:['LHR'],basePrice:480,airlines:['AY','BA','LH','AF','KL','TK']},
    'HEL-LAX':{totalMins:690,stops:['LHR'],basePrice:540,airlines:['AY','BA','LH','AF','KL','AA']},
    'HEL-NRT':{totalMins:870,stops:['HKG'],basePrice:680,airlines:['AY','JL','NH','KL','LH','BA']},
    'HEL-PEK':{totalMins:780,stops:[],basePrice:580,airlines:['AY','CA','LH','KL','BA','AF']},
    'HEL-ICN':{totalMins:810,stops:[],basePrice:640,airlines:['AY','KE','OZ','LH','KL','BA']},
    'HEL-DOH':{totalMins:360,stops:[],basePrice:290,airlines:['AY','QR','EK','TK','LH','BA']},
    'MNL-DVO':{totalMins:90, stops:[],basePrice:38, airlines:['PR','5J','Z2','PR','5J','Z2']},
    'DVO-MNL':{totalMins:90, stops:[],basePrice:38, airlines:['PR','5J','Z2','PR','5J','Z2']},
    'MNL-CEB':{totalMins:60, stops:[],basePrice:28, airlines:['PR','5J','Z2','PR','5J','Z2']},
    'CEB-MNL':{totalMins:60, stops:[],basePrice:28, airlines:['PR','5J','Z2','PR','5J','Z2']},
    'LHR-JFK':{totalMins:435,stops:[],basePrice:380,airlines:['BA','VS','AA','UA','DL','U2']},
    'LHR-DXB':{totalMins:405,stops:[],basePrice:290,airlines:['BA','EK','QR','TK','LH','FZ']},
    'DXB-SIN':{totalMins:420,stops:[],basePrice:250,airlines:['EK','SQ','QR','TK','FZ','MH']},
    'DXB-BKK':{totalMins:390,stops:[],basePrice:220,airlines:['EK','TG','QR','TK','FZ','MH']},
    'BKK-SIN':{totalMins:135,stops:[],basePrice:80, airlines:['TG','SQ','FD','AK','MH','QZ']},
    'SIN-MNL':{totalMins:195,stops:[],basePrice:110,airlines:['SQ','PR','5J','CX','MH','QZ']},
    'AMS-JFK':{totalMins:525,stops:[],basePrice:400,airlines:['KL','UA','DL','AA','BA','AF']},
    'CDG-JFK':{totalMins:510,stops:[],basePrice:420,airlines:['AF','UA','AA','DL','BA','KL']},
  };
  const key = orig+'-'+dest;
  const rev = dest+'-'+orig;
  let route = knownRoutes[key] || knownRoutes[rev];

  if (!route) {
    // Detect region by airport prefix patterns
    const finlandAirports = ['HEL','OUL','TMP','TKU','JYV','KUO','JOE','RVN','KEM','IVL','KAJ','VAA','MHQ'];
    const phAirports      = ['MNL','DVO','CEB','ILO','BCD','KLO','ZAM','GES','DGT','MPH','PPS','TAG','ENI','USU','CGY','TAC','CRK','LGP','BXU','OZC','LAO','TUG','RXS','SUG','DPL','SJI','NWP','CBO'];
    const euAirports      = ['LHR','LGW','CDG','AMS','FRA','MUC','BER','MAD','BCN','FCO','MXP','ARN','CPH','OSL','WAW','VIE','ZRH','ATH','IST','BRU','DUB'];
    const usAirports      = ['JFK','LAX','ORD','ATL','DFW','DEN','SFO','SEA','MIA','BOS','LAS'];
    const asiaAirports    = ['BKK','SIN','KUL','NRT','HND','ICN','PEK','PVG','HKG','TPE','DEL','BOM'];
    const gulfAirports    = ['DXB','AUH','DOH','RUH','KWI','BAH','MCT'];

    const origFI = finlandAirports.includes(orig);
    const destFI = finlandAirports.includes(dest);
    const origPH = phAirports.includes(orig);
    const destPH = phAirports.includes(dest);
    const origEU = euAirports.includes(orig);
    const destEU = euAirports.includes(dest);

    // Finnish domestic (non-HEL) airports to/from international — route via HEL+DXB
    if ((origFI && !['HEL'].includes(orig)) && (destPH || asiaAirports.includes(dest))) {
      route = {totalMins:1080, stops:['HEL','DXB'], basePrice:680, airlines:['AY','EK','QR','TK','PR','AY']};
    } else if ((destFI && !['HEL'].includes(dest)) && (origPH || asiaAirports.includes(orig))) {
      route = {totalMins:1080, stops:['DXB','HEL'], basePrice:680, airlines:['AY','EK','QR','TK','PR','AY']};
    } else if ((origFI || origEU) && destPH) {
      route = {totalMins:960, stops:['DXB'], basePrice:650, airlines:['AY','EK','QR','TK','PR','LH']};
    } else if (origPH && (destFI || destEU)) {
      route = {totalMins:960, stops:['DXB'], basePrice:650, airlines:['PR','EK','QR','TK','AY','LH']};
    } else if (origPH && destPH) {
      // Philippine domestic
      route = {totalMins:75, stops:[], basePrice:32, airlines:['PR','5J','Z2','PR','5J','Z2']};
    } else if (origFI && destFI) {
      // Finnish domestic
      route = {totalMins:70, stops:[], basePrice:65, airlines:['AY','AY','AY','AY','AY','AY']};
    } else if ((origEU || origFI) && usAirports.includes(dest)) {
      route = {totalMins:570, stops:['LHR'], basePrice:480, airlines:['AY','BA','LH','AF','KL','TK']};
    } else if ((origEU || origFI) && gulfAirports.includes(dest)) {
      route = {totalMins:390, stops:[], basePrice:300, airlines:['AY','EK','QR','TK','LH','BA']};
    } else if ((origEU || origFI) && asiaAirports.includes(dest)) {
      route = {totalMins:750, stops:['DXB'], basePrice:520, airlines:['AY','EK','QR','TK','SQ','LH']};
    } else {
      // Generic international fallback — realistic long haul
      route = {totalMins:600, stops:['DXB'], basePrice:420, airlines:['EK','QR','TK','AY','LH','BA']};
    }
  }
  const times=['06:15','08:30','10:45','13:00','15:30','18:00'];
  const pmods=[1.0,2.8,0.95,1.0,0.90,0.95];
  return route.airlines.map((code,i) => {
    const isBiz = i===1;
    const price = Math.round(route.basePrice * pmods[i] * numAdults + (i%3)*40);
    const dep   = new Date(`${date}T${times[i]}:00`);
    const segs  = [];
    if (!route.stops.length) {
      const arr = new Date(dep.getTime()+route.totalMins*60000);
      segs.push({departure:{iataCode:orig,at:dep.toISOString()},arrival:{iataCode:dest,at:arr.toISOString()},carrierCode:code,number:String(100+i*13),duration:`PT${Math.floor(route.totalMins/60)}H${route.totalMins%60}M`});
    } else {
      const s=route.stops[0],s1=Math.round(route.totalMins*0.45),s2=route.totalMins-s1-90;
      const ma=new Date(dep.getTime()+s1*60000),md=new Date(ma.getTime()+90*60000),fa=new Date(md.getTime()+s2*60000);
      segs.push({departure:{iataCode:orig,at:dep.toISOString()},arrival:{iataCode:s,at:ma.toISOString()},carrierCode:code,number:String(100+i*13),duration:`PT${Math.floor(s1/60)}H${s1%60}M`});
      segs.push({departure:{iataCode:s,at:md.toISOString()},arrival:{iataCode:dest,at:fa.toISOString()},carrierCode:code,number:String(101+i*13),duration:`PT${Math.floor(s2/60)}H${s2%60}M`});
    }
    return {
      id:'f'+i,
      price:{grandTotal:price.toFixed(2),currency:'EUR',fees:[{amount:(price*0.1).toFixed(2)}]},
      numberOfBookableSeats:[9,4,7,2,6,8][i]||5,
      itineraries:[{duration:`PT${Math.floor(route.totalMins/60)}H${route.totalMins%60}M`,segments:segs}],
      travelerPricings:[{fareDetailsBySegment:[{cabin:isBiz?'BUSINESS':'ECONOMY'}]}]
    };
  });
}

// Pre-fill date to 30 days from today so it's never empty on mobile
document.addEventListener('DOMContentLoaded', function() {
  var el = document.getElementById('depart-input');
  if (el && !el.value) { var d=new Date(); d.setDate(d.getDate()+30); el.value=d.toISOString().split('T')[0]; }
});

let _lastSearchTs = 0;
async function searchFlights() {
  // Debounce 600ms — prevents touchend+onclick double-fire on Android
  var now = Date.now();
  if (now - _lastSearchTs < 600) return;
  _lastSearchTs = now;

  const originInput = document.getElementById('origin-input');
  const destInput   = document.getElementById('dest-input');
  const departDate  = document.getElementById('depart-input').value;
  const errorEl     = document.getElementById('search-error');

  // Read passenger counts from picker
  const numAdults   = parseInt((document.getElementById('pax-adults-val')||{}).value)   || paxCounts.adults   || 1;
  const numChildren = parseInt((document.getElementById('pax-children-val')||{}).value) || paxCounts.children || 0;
  const numInfants  = parseInt((document.getElementById('pax-infants-val')||{}).value)  || paxCounts.infants  || 0;
  const passengers  = numAdults + numChildren + numInfants; // total for display

  // Validate: children/infants require at least 1 adult
  if ((numChildren > 0 || numInfants > 0) && numAdults === 0) {
    return setError(errorEl, 'Children and infants must travel with at least 1 adult.');
  }
  if (numInfants > numAdults) {
    return setError(errorEl, 'Each infant needs their own adult. Please add more adults.');
  }

  // City / country → IATA code (very comprehensive)
  const cityToCode = {
    // Finland
    'HELSINKI':'HEL','TAMPERE':'TMP','TURKU':'TKU','OULU':'OUL','ROVANIEMI':'RVN',
    // Scandinavia
    'OSLO':'OSL','BERGEN':'BGO','STOCKHOLM':'ARN','GOTHENBURG':'GOT','COPENHAGEN':'CPH','MALMO':'MMX',
    // UK & Ireland
    'LONDON':'LHR','MANCHESTER':'MAN','BIRMINGHAM':'BHX','EDINBURGH':'EDI','GLASGOW':'GLA','DUBLIN':'DUB',
    // Western Europe
    'PARIS':'CDG','AMSTERDAM':'AMS','BRUSSELS':'BRU','FRANKFURT':'FRA','BERLIN':'BER',
    'MUNICH':'MUC','HAMBURG':'HAM','DUSSELDORF':'DUS','ZURICH':'ZRH','GENEVA':'GVA',
    'VIENNA':'VIE','ROME':'FCO','MILAN':'MXP','VENICE':'VCE','NAPLES':'NAP',
    'MADRID':'MAD','BARCELONA':'BCN','LISBON':'LIS','PORTO':'OPO',
    'NICE':'NCE','LYON':'LYS','MARSEILLE':'MRS',
    // Eastern Europe
    'WARSAW':'WAW','POLAND':'WAW','KRAKOW':'KRK','GDANSK':'GDN','WROCLAW':'WRO','POZNAN':'POZ','KATOWICE':'KTW',
    'PRAGUE':'PRG','CZECH REPUBLIC':'PRG','BUDAPEST':'BUD','HUNGARY':'BUD',
    'BUCHAREST':'OTP','ROMANIA':'OTP','SOFIA':'SOF','BULGARIA':'SOF',
    'ZAGREB':'ZAG','CROATIA':'ZAG','BELGRADE':'BEG','SERBIA':'BEG',
    'BRATISLAVA':'BTS','SLOVAKIA':'BTS','VILNIUS':'VNO','LITHUANIA':'VNO',
    'RIGA':'RIX','LATVIA':'RIX','TALLINN':'TLL','ESTONIA':'TLL',
    'KIEV':'KBP','KYIV':'KBP','UKRAINE':'KBP',
    'MINSK':'MSQ','BELARUS':'MSQ',
    // Southern Europe
    'ATHENS':'ATH','GREECE':'ATH','THESSALONIKI':'SKG',
    'ISTANBUL':'IST','TURKEY':'IST','ANKARA':'ESB',
    'MALTA':'MLA','VALLETTA':'MLA','NICOSIA':'LCA','CYPRUS':'LCA',
    // Middle East
    'DUBAI':'DXB','UAE':'DXB','ABU DHABI':'AUH','SHARJAH':'SHJ',
    'DOHA':'DOH','QATAR':'DOH','RIYADH':'RUH','SAUDI ARABIA':'RUH',
    'JEDDAH':'JED','MUSCAT':'MCT','OMAN':'MCT','KUWAIT':'KWI',
    'BAHRAIN':'BAH','AMMAN':'AMM','JORDAN':'AMM',
    'TEL AVIV':'TLV','ISRAEL':'TLV','BEIRUT':'BEY','LEBANON':'BEY',
    // Asia
    'BANGKOK':'BKK','THAILAND':'BKK','PHUKET':'HKT','CHIANG MAI':'CNX',
    'KOH SAMUI':'USM','SAMUI':'USM','KRABI':'KBV','PATTAYA':'UTP','HAT YAI':'HDY','CHIANG RAI':'CEI',
    'SURABAYA':'SUB','YOGYAKARTA':'JOG','MAKASSAR':'UPG','MANADO':'MDC','LOMBOK':'LOP',
    'BALIKPAPAN':'BPN','AMBON':'AMQ','JAYAPURA':'DJJ','PALEMBANG':'PLM','SEMARANG':'SRG',
    'LANGKAWI':'LGK','KOTA KINABALU':'BKI','SABAH':'BKI','KUCHING':'KCH','SARAWAK':'KCH',
    'JOHOR BAHRU':'JHB','MIRI':'MYY','IPOH':'IPH',
    'PHU QUOC':'PQC','NHA TRANG':'CXR','HUE':'HUI','CAN THO':'VCA','CON DAO':'VCS',
    'MUSCAT':'MCT','OMAN':'MCT','BAHRAIN':'BAH','KUWAIT':'KWI','JEDDAH':'JED',
    'RIYADH':'RUH','TBILISI':'TBS','GEORGIA':'TBS','YEREVAN':'EVN','BAKU':'GYD',
    'OKINAWA':'OKA','NAHA':'OKA','SAPPORO':'CTS','HOKKAIDO':'CTS','NAGOYA':'NGO','HIROSHIMA':'HIJ',
    'JEJU':'CJU','JEJU ISLAND':'CJU',
    'AUCKLAND':'AKL','NEW ZEALAND':'AKL','CHRISTCHURCH':'CHC','WELLINGTON':'WLG',
    'CANCUN':'CUN','MEXICO CITY':'MEX','MEXICO':'MEX','GUADALAJARA':'GDL',
    'BOGOTA':'BOG','COLOMBIA':'BOG','MEDELLIN':'MDE','CARTAGENA':'CTG',
    'SAO PAULO':'GRU','RIO DE JANEIRO':'GIG','BRAZIL':'GRU','BUENOS AIRES':'EZE',
    'SANTIAGO':'SCL','CHILE':'SCL','LIMA':'LIM','PERU':'LIM','QUITO':'UIO',
    'ZANZIBAR':'ZNZ','MOMBASA':'MBA','MAURITIUS':'MRU','SEYCHELLES':'SEZ',
    'GOA':'GOI','HYDERABAD':'HYD','AHMEDABAD':'AMD','KOCHI':'COK','COCHIN':'COK',
    'TRIVANDRUM':'TRV','PUNE':'PNQ','JAIPUR':'JAI','AMRITSAR':'ATQ','GUWAHATI':'GAU',
    'PORTO':'OPO','LISBON':'LIS','FARO':'FAO','ALGARVE':'FAO',
    'TENERIFE':'TFS','GRAN CANARIA':'LPA','IBIZA':'IBZ','MALLORCA':'PMI',
    'CRETE':'HER','HERAKLION':'HER','RHODES':'RHO','MYKONOS':'JMK','SANTORINI':'JTR','CORFU':'CFU',
    'SPLIT':'SPU','DUBROVNIK':'DBV','ZAGREB':'ZAG','TIVAT':'TIV','PODGORICA':'TGD',
    'TIRANA':'TIA','SOFIA':'SOF','BUCHAREST':'OTP','RIGA':'RIX','TALLINN':'TLL','VILNIUS':'VNO',
    'TAMPERE':'TMP','TURKU':'TKU','OULU':'OUL','ROVANIEMI':'RVN','JOENSUU':'JOE',
    'JYVASKYLA':'JYV','KUUSAMO':'KAO','KITTILA':'KTT',
    'SINGAPORE':'SIN','KUALA LUMPUR':'KUL','MALAYSIA':'KUL','PENANG':'PEN',
    'JAKARTA':'CGK','INDONESIA':'CGK','BALI':'DPS','SURABAYA':'SUB',
    'MANILA':'MNL','PHILIPPINES':'MNL','CEBU':'CEB','DAVAO':'DVO',
    'ILOILO':'ILO','BACOLOD':'BCD','KALIBO':'KLO','ZAMBOANGA':'ZAM',
    'CAGAYAN DE ORO':'CGY','GENERAL SANTOS':'GES','DUMAGUETE':'DGT',
    'CATICLAN':'MPH','BORACAY':'MPH','PUERTO PRINCESA':'PPS','PALAWAN':'PPS',
    'TAGBILARAN':'TAG','BOHOL':'TAG','BUTUAN':'BXU','LEGAZPI':'LGP',
    'NAGA':'WNP','TACLOBAN':'TAC','OZAMIZ':'OZC','PAGADIAN':'PAG',
    'EL NIDO':'ENI','BUSUANGA':'USU','CORON':'USU','SAN JOSE':'SJI',
    'LAOAG':'LAO','VIGAN':'VIG','TUGUEGARAO':'TUG','CAUAYAN':'CYZ',
    'ROXAS':'RXS','CATARMAN':'CRM','CALBAYOG':'CYP','SURIGAO':'SUG',
    'DIPOLOG':'DPL','COTABATO':'CBO','JOLO':'JOL','TAWI TAWI':'TWT',
    'CLARK':'CRK','ANGELES':'CRK','SUBIC':'SFS',
    'TOKYO':'NRT','JAPAN':'NRT','OSAKA':'KIX','NAGOYA':'NGO','SAPPORO':'CTS','FUKUOKA':'FUK',
    'SEOUL':'ICN','SOUTH KOREA':'ICN','BUSAN':'PUS',
    'BEIJING':'PEK','CHINA':'PEK','SHANGHAI':'PVG','GUANGZHOU':'CAN','SHENZHEN':'SZX','CHENGDU':'CTU',
    'HONG KONG':'HKG','TAIPEI':'TPE','TAIWAN':'TPE',
    'HO CHI MINH':'SGN','VIETNAM':'SGN','HANOI':'HAN','DA NANG':'DAD',
    'CAMBODIA':'PNH','PHNOM PENH':'PNH','SIEM REAP':'REP',
    'MYANMAR':'RGN','YANGON':'RGN',
    'MALDIVES':'MLE','SRI LANKA':'CMB','COLOMBO':'CMB',
    'NEPAL':'KTM','KATHMANDU':'KTM',
    'DELHI':'DEL','INDIA':'DEL','MUMBAI':'BOM','BANGALORE':'BLR','CHENNAI':'MAA','KOLKATA':'CCU','HYDERABAD':'HYD',
    'DHAKA':'DAC','BANGLADESH':'DAC','KARACHI':'KHI','PAKISTAN':'KHI','LAHORE':'LHE','ISLAMABAD':'ISB',
    // Africa
    'CAIRO':'CAI','EGYPT':'CAI','NAIROBI':'NBO','KENYA':'NBO',
    'ADDIS ABABA':'ADD','ETHIOPIA':'ADD','LAGOS':'LOS','NIGERIA':'LOS',
    'ACCRA':'ACC','GHANA':'ACC','JOHANNESBURG':'JNB','SOUTH AFRICA':'JNB','CAPE TOWN':'CPT',
    'CASABLANCA':'CMN','MOROCCO':'CMN','TUNIS':'TUN','TUNISIA':'TUN',
    'DAR ES SALAAM':'DAR','TANZANIA':'DAR','KAMPALA':'EBB','UGANDA':'EBB',
    'KIGALI':'KGL','RWANDA':'KGL','LUSAKA':'LUN','ZAMBIA':'LUN',
    // Australia & Pacific
    'SYDNEY':'SYD','AUSTRALIA':'SYD','MELBOURNE':'MEL','BRISBANE':'BNE','PERTH':'PER','ADELAIDE':'ADL',
    'AUCKLAND':'AKL','NEW ZEALAND':'AKL','CHRISTCHURCH':'CHC',
    // North America
    'NEW YORK':'JFK','LOS ANGELES':'LAX','CHICAGO':'ORD','MIAMI':'MIA',
    'DALLAS':'DFW','HOUSTON':'IAH','SEATTLE':'SEA','BOSTON':'BOS',
    'ATLANTA':'ATL','DENVER':'DEN','SAN FRANCISCO':'SFO','LAS VEGAS':'LAS',
    'WASHINGTON':'IAD','PHILADELPHIA':'PHL','DETROIT':'DTW','MINNEAPOLIS':'MSP',
    'ORLANDO':'MCO','PHOENIX':'PHX','PORTLAND':'PDX','SALT LAKE CITY':'SLC',
    'USA':'JFK','UNITED STATES':'JFK',
    'TORONTO':'YYZ','CANADA':'YYZ','VANCOUVER':'YVR','MONTREAL':'YUL','CALGARY':'YYC',
    'MEXICO CITY':'MEX','MEXICO':'MEX','CANCUN':'CUN','GUADALAJARA':'GDL',
    // Central & South America
    'SAO PAULO':'GRU','BRAZIL':'GRU','RIO':'GIG','RIO DE JANEIRO':'GIG',
    'BUENOS AIRES':'EZE','ARGENTINA':'EZE','SANTIAGO':'SCL','CHILE':'SCL',
    'LIMA':'LIM','PERU':'LIM','BOGOTA':'BOG','COLOMBIA':'BOG',
    'PANAMA CITY':'PTY','PANAMA':'PTY','SAN JOSE':'SJO','COSTA RICA':'SJO',
  };

  function resolveCode(input) {
    var ds = input.dataset.code;
    if (ds && ds.length === 3) return ds;
    // Handle "HEL — Helsinki" autocomplete format (em dash or hyphen)
    var raw = input.value.replace(/\s*[\u2014\-].*$/, '').trim().toUpperCase().replace(/[^A-Z ]/g, '');
    if (/^[A-Z]{3}$/.test(raw)) return raw;
    if (cityToCode[raw]) return cityToCode[raw];
    // Fuzzy partial match: "HELSIN" → "HELSINKI"
    var keys = Object.keys(cityToCode);
    var partial = keys.find(function(k){ return k.startsWith(raw); });
    if (partial) return cityToCode[partial];
    var partial2 = keys.find(function(k){ return raw.startsWith(k) && k.length >= 4; });
    if (partial2) return cityToCode[partial2];
    return null;
  }

  const origin = resolveCode(originInput);
  const dest   = resolveCode(destInput);

  errorEl.textContent = '';
  if (!origin) return setError(errorEl, 'Could not find departure airport. Try typing the airport code (e.g. HEL, WAW, LHR).');
  if (!dest)   return setError(errorEl, 'Could not find destination airport. Try typing the airport code (e.g. WAW, LHR, DXB).');
  if (!departDate)                   return setError(errorEl, 'Please select a departure date.');
  if (new Date(departDate) < new Date().setHours(0,0,0,0)) return setError(errorEl, 'Departure date cannot be in the past.');

  // Capture trip type and return date
  const activeTab = document.querySelector('.tab-btn.active');
  isRoundTrip = (activeTab && activeTab.dataset && activeTab.dataset.type) === 'round-trip';
  searchReturnDate = (document.getElementById('return-input')||{}).value || '';
  if (isRoundTrip && !searchReturnDate) {
    return setError(errorEl, 'Please select a return date.');
  }
  if (isRoundTrip && new Date(searchReturnDate) <= new Date(departDate)) {
    return setError(errorEl, 'Return date must be after departure date.');
  }

  // Reset round trip state for new search
  outboundFlight = null;
  selectedReturnFlight = null;

  const cabinClass = (document.getElementById('cabin-class-input')||{}).value || 'economy';
  searchParams = { origin, dest, departDate, returnDate: searchReturnDate, passengers,
                   numAdults, numChildren, numInfants, isRoundTrip, cabinClass };

  showPage('results');
  document.getElementById('results-loading').style.display = 'flex';
  document.getElementById('results-list').style.display    = 'none';
  document.getElementById('results-empty').style.display   = 'none';
  const _banner = document.getElementById('outbound-selected-banner');
  if (_banner) _banner.style.display = 'none';
  document.getElementById('results-heading').textContent   = `${origin} \u2192 ${dest}`;
  // Build passenger summary for results page
  var paxParts2 = [];
  if (numAdults   > 0) paxParts2.push(numAdults   + ' Adult'   + (numAdults   > 1 ? 's'   : ''));
  if (numChildren > 0) paxParts2.push(numChildren + ' Child'   + (numChildren > 1 ? 'ren' : ''));
  if (numInfants  > 0) paxParts2.push(numInfants  + ' Infant'  + (numInfants  > 1 ? 's'   : ''));
  document.getElementById('results-subheading').textContent =
    `${formatDate(departDate)} \u00B7 ${paxParts2.join(', ')}`;

  // Pass entity IDs from autocomplete selection (if user picked from dropdown)
  const originEntityId = originInput.dataset.entityId || '';
  const destEntityId   = destInput.dataset.entityId   || '';

  // Build query params — pass adults, children, infants separately to backend
  const qs = new URLSearchParams({
    origin, destination: dest, departureDate: departDate,
    adults: numAdults, children: numChildren, infants: numInfants,
    cabinClass: cabinClass
  });
  if (originEntityId) qs.set('originEntityId', originEntityId);
  if (destEntityId)   qs.set('destinationEntityId', destEntityId);

  // Defer results render 80ms — lets browser paint the loading spinner first (critical on Android)
  var _orig=origin, _dest=dest, _date=departDate, _ad=numAdults, _ch=numChildren, _in=numInfants;

  // Push state so browser Back button returns to homepage search
  history.pushState(
    { view: 'results', orig: _orig, dest: _dest, date: _date, adults: _ad },
    '',
    '?from=' + _orig + '&to=' + _dest + '&date=' + _date + '&pax=' + _ad
  );

  setTimeout(function() {
    document.getElementById('results-loading').style.display = 'none';
    document.getElementById('results-list').style.display    = 'block';
    renderAffiliateResults(_orig, _dest, _date, _ad, _ch, _in);
  }, 80);
}

function renderAffiliateResults(orig, dest, date, adults, children, infants) {
  const TP   = '719573';
  const TC   = 'Allianceid=8098413&SID=306552835&trip_sub1=flights&trip_sub3=D16144585';
  const pax  = adults || 1;
  const fromName = ROUTE_NAMES[orig] || orig;
  const toName   = ROUTE_NAMES[dest] || dest;
  const label    = (orig && dest) ? `${fromName} → ${toName}` : 'your route';

  const tripDate   = date ? date.replace(/-/g, '') : '';
  const kiwiUrl    = `https://www.kiwi.com/en/search/results/${orig}/${dest}/${date}?adults=${pax}&affilid=kiwi_affiliates`;
  const aviaUrl    = `https://aviasales.com/?marker=${TP}&origin=${orig}&destination=${dest}&departure_at=${date}&adults=${pax}`;
  const tripUrl    = `https://www.trip.com/flights/explore?Allianceid=8098413&SID=306552835&trip_sub1=flights&dcity=${orig.toLowerCase()}&acity=${dest.toLowerCase()}&ddate=${date}&triptype=ow&class=y&quantity=${pax}`;
  const expediaUrl = `https://www.jdoqocy.com/click-101737492-13852728?url=https%3A%2F%2Fwww.expedia.fi%2FLennot`;
  const jBase    = `https://jetradar.com/flights/?marker=${TP}&origin=${orig}&destination=${dest}&depart_date=${date}&adults=${pax}`;

  const list = document.getElementById('results-list');
  list.style.display = 'block';
  list.innerHTML = `
    <div style="max-width:700px;margin:0 auto;padding:8px 0;">
      <div style="background:linear-gradient(135deg,#1e3a8a,#2563eb);border-radius:16px;padding:22px 24px;margin-bottom:20px;color:#fff;">
        <div style="font-size:1.1rem;font-weight:800;margin-bottom:4px;">✈ Find the best price for ${label}</div>
        <div style="font-size:.85rem;opacity:.85;">${formatDate(date)} · ${pax} Adult${pax>1?'s':''}</div>
        <div style="font-size:.78rem;opacity:.7;margin-top:6px;">Click any option below — you'll be taken directly to the airline or booking site to complete your purchase securely.</div>
      </div>

      <div style="font-size:.75rem;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px;">🌍 Compare all airlines — 4 options below</div>
      <div style="background:#fef9c3;border:1.5px solid #fde047;border-radius:10px;padding:10px 14px;margin-bottom:12px;font-size:.82rem;color:#713f12;font-weight:600;text-align:center;">
        👇 Scroll down to see all partners &amp; airlines
      </div>
      <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:24px;">
        <a href="${kiwiUrl}" target="_blank" rel="noopener" onclick="typeof gtag==='function'&&gtag('event','affiliate_click',{event_category:'Revenue',event_label:'Kiwi.com: '+orig+' → '+dest,value:1})"
          style="display:flex;align-items:center;justify-content:space-between;background:#fff;border:1.5px solid #bae6fd;border-radius:12px;padding:16px 18px;text-decoration:none;box-shadow:0 2px 8px rgba(0,0,0,.06);">
          <div style="display:flex;align-items:center;gap:12px;">
            <span style="font-size:1.8rem;">🥝</span>
            <div>
              <div style="font-weight:800;color:#0284c7;font-size:.95rem;">Kiwi.com</div>
              <div style="font-size:.78rem;color:#475569;">Mix &amp; match airlines — often finds cheapest combos</div>
            </div>
          </div>
          <span style="background:#0284c7;color:#fff;padding:8px 16px;border-radius:8px;font-weight:700;font-size:.85rem;white-space:nowrap;">Search →</span>
        </a>
        <a href="${aviaUrl}" target="_blank" rel="noopener" onclick="typeof gtag==='function'&&gtag('event','affiliate_click',{event_category:'Revenue',event_label:'Aviasales: '+orig+' → '+dest,value:1})"
          style="display:flex;align-items:center;justify-content:space-between;background:#fff;border:1.5px solid #e2e8f0;border-radius:12px;padding:16px 18px;text-decoration:none;box-shadow:0 2px 8px rgba(0,0,0,.06);">
          <div style="display:flex;align-items:center;gap:12px;">
            <span style="font-size:1.8rem;">🔍</span>
            <div>
              <div style="font-weight:800;color:#1a2b4a;font-size:.95rem;">Aviasales</div>
              <div style="font-size:.78rem;color:#475569;">Compare 728 airlines worldwide</div>
            </div>
          </div>
          <span style="background:#1a2b4a;color:#fff;padding:8px 16px;border-radius:8px;font-weight:700;font-size:.85rem;white-space:nowrap;">Search →</span>
        </a>
        <a href="${tripUrl}" target="_blank" rel="noopener" onclick="typeof gtag==='function'&&gtag('event','affiliate_click',{event_category:'Revenue',event_label:'Trip.com: '+orig+' → '+dest,value:1})"
          style="display:flex;align-items:center;justify-content:space-between;background:#fff;border:1.5px solid #e2e8f0;border-radius:12px;padding:16px 18px;text-decoration:none;box-shadow:0 2px 8px rgba(0,0,0,.06);">
          <div style="display:flex;align-items:center;gap:12px;">
            <span style="font-size:1.8rem;">✈️</span>
            <div>
              <div style="font-weight:800;color:#e53e3e;font-size:.95rem;">Trip.com</div>
              <div style="font-size:.78rem;color:#475569;">Flights + hotels + packages worldwide</div>
            </div>
          </div>
          <span style="background:#e53e3e;color:#fff;padding:8px 16px;border-radius:8px;font-weight:700;font-size:.85rem;white-space:nowrap;">Search →</span>
        </a>
        <a href="${expediaUrl}" target="_blank" rel="noopener" onclick="typeof gtag==='function'&&gtag('event','affiliate_click',{event_category:'Revenue',event_label:'Expedia: '+orig+' → '+dest,value:1})"
          style="display:flex;align-items:center;justify-content:space-between;background:#fff;border:1.5px solid #fde68a;border-radius:12px;padding:16px 18px;text-decoration:none;box-shadow:0 2px 8px rgba(0,0,0,.06);">
          <div style="display:flex;align-items:center;gap:12px;">
            <span style="font-size:1.8rem;">🏨</span>
            <div>
              <div style="font-weight:800;color:#d97706;font-size:.95rem;">Expedia</div>
              <div style="font-size:.78rem;color:#475569;">Flights + hotels — best price guarantee</div>
            </div>
          </div>
          <span style="background:#d97706;color:#fff;padding:8px 16px;border-radius:8px;font-weight:700;font-size:.85rem;white-space:nowrap;">Search →</span>
        </a>
      </div>

      <div style="font-size:.75rem;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px;">✈ Book directly with airline</div>

      <div style="font-size:.7rem;font-weight:700;color:#94a3b8;letter-spacing:.05em;margin:0 0 8px;">🌿 NORDIC & EUROPEAN</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px;">
        ${[['AY','Finnair','Europe & Asia from HEL'],['DY','Norwegian','Budget Nordic & Europe'],['SK','SAS','Scandinavian & Europe'],['LH','Lufthansa','Global via Frankfurt'],['KL','KLM','Worldwide via Amsterdam'],['AF','Air France','Worldwide via Paris'],['BA','British Airways','Via London Heathrow'],['TK','Turkish Airlines','Worldwide via Istanbul'],['FR','Ryanair','Cheapest European budget'],['U2','easyJet','European budget routes'],['W6','Wizz Air','Eastern Europe budget'],['SN','Brussels Airlines','Europe & Africa']].map(([code,name,desc])=>`
        <a href="${jBase}&airline=${code}" target="_blank" rel="noopener" onclick="typeof gtag==='function'&&gtag('event','affiliate_click',{event_category:'Revenue',event_label:'Jetradar: '+orig+' → '+dest,value:1})"
          style="display:flex;align-items:center;gap:10px;background:#fff;border:1.5px solid #e2e8f0;border-radius:12px;padding:12px 14px;text-decoration:none;box-shadow:0 2px 6px rgba(0,0,0,.05);">
          <img src="https://images.kiwi.com/airlines/64/${code}.png" alt="${name}" width="38" height="38"
            loading="lazy" style="border-radius:8px;object-fit:contain;background:#f8fafc;padding:2px;flex-shrink:0;"
            onerror="this.style.display='none'"/>
          <div style="min-width:0;">
            <div style="font-weight:800;color:#1a2b4a;font-size:.85rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${name}</div>
            <div style="font-size:.7rem;color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${desc}</div>
          </div>
        </a>`).join('')}
      </div>

      <div style="font-size:.7rem;font-weight:700;color:#94a3b8;letter-spacing:.05em;margin:0 0 8px;">🌙 GULF & MIDDLE EAST</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px;">
        ${[['EK','Emirates','Worldwide via Dubai'],['QR','Qatar Airways','Worldwide via Doha'],['WY','Oman Air','Gulf, Asia & Europe'],['FZ','flydubai','Budget Gulf & beyond'],['SV','Saudia','Middle East & worldwide'],['G9','Air Arabia','Budget Middle East']].map(([code,name,desc])=>`
        <a href="${jBase}&airline=${code}" target="_blank" rel="noopener" onclick="typeof gtag==='function'&&gtag('event','affiliate_click',{event_category:'Revenue',event_label:'Jetradar: '+orig+' → '+dest,value:1})"
          style="display:flex;align-items:center;gap:10px;background:#fff;border:1.5px solid #e2e8f0;border-radius:12px;padding:12px 14px;text-decoration:none;box-shadow:0 2px 6px rgba(0,0,0,.05);">
          <img src="https://images.kiwi.com/airlines/64/${code}.png" alt="${name}" width="38" height="38"
            loading="lazy" style="border-radius:8px;object-fit:contain;background:#f8fafc;padding:2px;flex-shrink:0;"
            onerror="this.style.display='none'"/>
          <div style="min-width:0;">
            <div style="font-weight:800;color:#1a2b4a;font-size:.85rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${name}</div>
            <div style="font-size:.7rem;color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${desc}</div>
          </div>
        </a>`).join('')}
      </div>

      <div style="font-size:.7rem;font-weight:700;color:#94a3b8;letter-spacing:.05em;margin:0 0 8px;">🌏 ASIA & PACIFIC</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px;">
        ${[['SQ','Singapore Airlines','World class via Singapore'],['TG','Thai Airways','Asia via Bangkok'],['MH','Malaysia Airlines','Asia via Kuala Lumpur'],['CX','Cathay Pacific','Asia via Hong Kong'],['JL','Japan Airlines','Japan & Asia'],['NH','ANA','Japan & worldwide'],['KE','Korean Air','Asia via Seoul'],['VN','Vietnam Airlines','Vietnam & Asia'],['GA','Garuda Indonesia','Indonesia & Asia'],['AK','AirAsia','Budget Asia routes']].map(([code,name,desc])=>`
        <a href="${jBase}&airline=${code}" target="_blank" rel="noopener" onclick="typeof gtag==='function'&&gtag('event','affiliate_click',{event_category:'Revenue',event_label:'Jetradar: '+orig+' → '+dest,value:1})"
          style="display:flex;align-items:center;gap:10px;background:#fff;border:1.5px solid #e2e8f0;border-radius:12px;padding:12px 14px;text-decoration:none;box-shadow:0 2px 6px rgba(0,0,0,.05);">
          <img src="https://images.kiwi.com/airlines/64/${code}.png" alt="${name}" width="38" height="38"
            loading="lazy" style="border-radius:8px;object-fit:contain;background:#f8fafc;padding:2px;flex-shrink:0;"
            onerror="this.style.display='none'"/>
          <div style="min-width:0;">
            <div style="font-weight:800;color:#1a2b4a;font-size:.85rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${name}</div>
            <div style="font-size:.7rem;color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${desc}</div>
          </div>
        </a>`).join('')}
      </div>

      <div style="font-size:.7rem;font-weight:700;color:#94a3b8;letter-spacing:.05em;margin:0 0 8px;">🇵🇭 PHILIPPINES AIRLINES</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:20px;">
        ${[['PR','Philippine Airlines','Full service MNL hub'],['5J','Cebu Pacific','Budget all PH domestic'],['Z2','Philippines AirAsia','Budget domestic & Asia']].map(([code,name,desc])=>`
        <a href="${jBase}&airline=${code}" target="_blank" rel="noopener" onclick="typeof gtag==='function'&&gtag('event','affiliate_click',{event_category:'Revenue',event_label:'Jetradar: '+orig+' → '+dest,value:1})"
          style="display:flex;align-items:center;gap:10px;background:#fff;border:1.5px solid #e2e8f0;border-radius:12px;padding:12px 14px;text-decoration:none;box-shadow:0 2px 6px rgba(0,0,0,.05);">
          <img src="https://images.kiwi.com/airlines/64/${code}.png" alt="${name}" width="38" height="38"
            loading="lazy" style="border-radius:8px;object-fit:contain;background:#f8fafc;padding:2px;flex-shrink:0;"
            onerror="this.style.display='none'"/>
          <div style="min-width:0;">
            <div style="font-weight:800;color:#1a2b4a;font-size:.85rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${name}</div>
            <div style="font-size:.7rem;color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${desc}</div>
          </div>
        </a>`).join('')}
      </div>

      <div style="background:#f0fdf4;border:1.5px solid #86efac;border-radius:10px;padding:12px 16px;font-size:.78rem;color:#166534;text-align:center;">
        ✓ All links are real airlines &amp; trusted booking sites &nbsp;·&nbsp; ✓ Secure payment on their website &nbsp;·&nbsp; ✓ Real ticket issued instantly
      </div>

      <!-- HOTEL UPSELL BANNER -->
      <div style="margin-top:20px;background:linear-gradient(135deg,#1e3a8a,#2563eb);border-radius:16px;padding:20px 22px;">
        <div style="color:#fff;font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px;">🏨 Also need a hotel?</div>
        <div style="color:#fff;font-weight:800;font-size:1rem;margin-bottom:4px;">Book your hotel at ${toName} — best prices guaranteed</div>
        <div style="color:rgba(255,255,255,.8);font-size:.8rem;margin-bottom:14px;">Hotels earn up to 6% commission — compare thousands of options with free cancellation</div>
        <div style="display:flex;flex-wrap:wrap;gap:10px;">
          <a href="https://www.jdoqocy.com/click-101737492-13852728" target="_blank" rel="noopener"
            onclick="typeof gtag==='function'&&gtag('event','affiliate_click',{event_category:'Revenue',event_label:'Expedia Hotel: '+dest,value:3})"
            style="display:inline-flex;align-items:center;gap:7px;background:#fff;color:#1e3a8a;font-weight:800;font-size:.88rem;padding:10px 20px;border-radius:10px;text-decoration:none;flex:1;min-width:140px;justify-content:center;">
            🏨 Expedia Hotels →
          </a>
          <a href="https://www.trip.com/hotels/?Allianceid=8098413&SID=306552835&trip_sub1=hotels" target="_blank" rel="noopener"
            onclick="typeof gtag==='function'&&gtag('event','affiliate_click',{event_category:'Revenue',event_label:'Trip.com Hotel: '+dest,value:3})"
            style="display:inline-flex;align-items:center;gap:7px;background:rgba(255,255,255,.15);color:#fff;font-weight:700;font-size:.88rem;padding:10px 20px;border-radius:10px;text-decoration:none;border:1.5px solid rgba(255,255,255,.4);flex:1;min-width:140px;justify-content:center;">
            🌐 Trip.com Hotels →
          </a>
        </div>
      </div>

      <!-- INSURANCE UPSELL BANNER -->
      <div style="margin-top:12px;background:linear-gradient(135deg,#065f46,#059669);border-radius:16px;padding:20px 22px;display:flex;align-items:center;gap:16px;flex-wrap:wrap;">
        <div style="flex:1;min-width:180px;">
          <div style="color:#fff;font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px;">🛡️ Travel Insurance</div>
          <div style="color:#fff;font-weight:800;font-size:.95rem;margin-bottom:3px;">Protect your trip with World Nomads</div>
          <div style="color:rgba(255,255,255,.85);font-size:.78rem;">Medical emergencies, cancellations, lost baggage &amp; more — from €3/day</div>
        </div>
        <a href="https://www.jdoqocy.com/click-101737492-15403748" target="_blank" rel="noopener"
          onclick="typeof gtag==='function'&&gtag('event','affiliate_click',{event_category:'Revenue',event_label:'WorldNomads Insurance',value:5})"
          style="display:inline-flex;align-items:center;gap:7px;background:#fff;color:#065f46;font-weight:800;font-size:.9rem;padding:12px 22px;border-radius:10px;text-decoration:none;white-space:nowrap;">
          Get a Free Quote →
        </a>
      </div>

    </div>
  `;
}

// Airline code → full name map
const AIRLINE_NAMES = {
  // Finnish / Nordic
  'AY':'Finnair','SK':'SAS','DY':'Norwegian','BT':'airBaltic','TF':'Braathens Regional',
  'FC':'Finncomm Airlines','6H':'Nordic Regional Airlines','OHY':'Nordic Regional Airlines',
  // European full-service
  'EK':'Emirates','QR':'Qatar Airways','BA':'British Airways','LH':'Lufthansa',
  'TK':'Turkish Airlines','AF':'Air France','KL':'KLM','IB':'Iberia',
  'TP':'TAP Air Portugal','LX':'Swiss','OS':'Austrian Airlines','SN':'Brussels Airlines',
  'EI':'Aer Lingus','AZ':'ITA Airways','LO':'LOT Polish Airlines','OK':'Czech Airlines',
  'RO':'TAROM','SU':'Aeroflot','PS':'Ukraine International','A3':'Aegean Airlines',
  'EW':'Eurowings','BT':'airBaltic','WY':'Oman Air','SV':'Saudia','MS':'EgyptAir',
  'ET':'Ethiopian Airlines','KQ':'Kenya Airways','SA':'South African Airways',
  // Budget European
  'FR':'Ryanair','U2':'easyJet','W6':'Wizz Air','VY':'Vueling','TO':'Transavia France',
  'HV':'Transavia','I2':'Iberia Express','LS':'Jet2','BY':'TUI Airways',
  'BE':'Flybe','PC':'Pegasus Airlines','V7':'Volotea',
  // Middle East / Asia full-service
  'FZ':'flydubai','G9':'Air Arabia','TG':'Thai Airways','SQ':'Singapore Airlines',
  'MH':'Malaysia Airlines','CX':'Cathay Pacific','JL':'Japan Airlines','NH':'ANA',
  'OZ':'Asiana Airlines','KE':'Korean Air','GA':'Garuda Indonesia',
  'CI':'China Airlines','BR':'EVA Air','TG':'Thai Airways','VN':'Vietnam Airlines',
  'MU':'China Eastern','CA':'Air China','CZ':'China Southern',
  // Philippines
  'PR':'Philippine Airlines','5J':'Cebu Pacific','Z2':'Philippines AirAsia',
  // Southeast Asia budget
  'QZ':'Indonesia AirAsia','JT':'Lion Air','FD':'Thai AirAsia','AK':'AirAsia',
  'XW':'NokScoot','ID':'Batik Air','SJ':'Sriwijaya Air','OD':'Batik Air Malaysia',
  // Oceania
  'QF':'Qantas','NZ':'Air New Zealand','VA':'Virgin Australia',
  // Americas
  'AC':'Air Canada','WS':'WestJet','AA':'American Airlines','UA':'United Airlines',
  'DL':'Delta Air Lines','WN':'Southwest Airlines','B6':'JetBlue','AS':'Alaska Airlines',
  'F9':'Frontier Airlines','LA':'LATAM','G3':'Gol','AD':'Azul','CM':'Copa Airlines',
};

// Budget carriers — no free checked bag, buy-on-board food
const BUDGET_AIRLINES = new Set([
  'FR','U2','W6','DY','PC','XW','VY','FD','AK','QZ','JT','ID','SJ', // Europe/Asia budget
  '5J','Z2','OD',                          // Philippines/Malaysia budget
  'FZ','G9',                               // Middle East LCC
  'TO','HV','I2','LS','BY','V7',           // European budget (Transavia, Jet2, TUI, Volotea)
  'F9','WN','G3','AD'                      // Americas budget
]);

// Render flight result cards (Skyscanner-style)
function renderFlightCards(flights) {
  window._flights = flights;
  window._flightsAll = flights; // Keep original for sorting/filtering

  const list = document.getElementById('results-list');
  list.style.display = 'flex';

  // Build sort/filter bar
  const hasNonstop = flights.some(f => f.itineraries[0].segments.length === 1);
  const sortBarHtml = `
    <div class="results-sort-bar">
      <div class="sort-label">Sort by:</div>
      <button class="sort-btn active" onclick="sortFlights('cheapest', this)">💰 Cheapest</button>
      <button class="sort-btn" onclick="sortFlights('fastest', this)">⚡ Fastest</button>
      ${hasNonstop ? '<button class="filter-btn" onclick="filterNonstop(this)">✅ Nonstop only</button>' : ''}
      <div class="results-count">${flights.length} flights found</div>
    </div>
  `;

  const kiwiOrigin = searchParams.origin || '';
  const kiwiDest   = searchParams.dest   || '';
  const kiwiDate   = searchParams.departDate || '';
  const kiwiPass   = searchParams.numAdults || 1;

  // Pre-filled deep links — route + date + passengers passed directly
  const kiwiUrl = (kiwiOrigin && kiwiDest && kiwiDate)
    ? `https://www.kiwi.com/en/search/results/${kiwiOrigin}/${kiwiDest}/${kiwiDate}?adults=${kiwiPass}&affilid=kiwi_affiliates`
    : `https://kiwi.tpk.mx/Imxir0ir`;

  const kiwiDateTrip = kiwiDate ? kiwiDate.replace(/-/g, '') : '';
  const tripUrl = (kiwiOrigin && kiwiDest && kiwiDateTrip)
    ? `https://www.trip.com/flights/explore?Allianceid=8098413&SID=306552835&trip_sub1=flights&dcity=${kiwiOrigin.toLowerCase()}&acity=${kiwiDest.toLowerCase()}&ddate=${kiwiDate}&triptype=ow&class=y&quantity=${kiwiPass}`
    : `https://www.trip.com/flights/?Allianceid=8098413&SID=306552835&trip_sub1=flights&trip_sub3=D16144585`;

  const fromName = ROUTE_NAMES[kiwiOrigin] || kiwiOrigin;
  const toName   = ROUTE_NAMES[kiwiDest]   || kiwiDest;
  const routeLabel = (kiwiOrigin && kiwiDest) ? `${fromName} → ${toName}` : 'your route';

  const kiwiBanner = `
    <div style="background:linear-gradient(135deg,#e0f2fe,#f0fdf4);border:1.5px solid #bae6fd;border-radius:12px;
      padding:12px 16px;margin-bottom:12px;">
      <div style="font-weight:700;color:#0c4a6e;font-size:.88rem;margin-bottom:6px;">💡 Also compare prices for <strong>${routeLabel}</strong> on other platforms:</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
        <div style="flex:1;min-width:200px;">
          <div style="font-size:.78rem;color:#0369a1;margin-bottom:6px;">🌍 Kiwi.com — mix &amp; match airlines, find cheaper combos</div>
          <a href="${kiwiUrl}" target="_blank" rel="noopener" onclick="typeof gtag==='function'&&gtag('event','affiliate_click',{event_category:'Revenue',event_label:'Kiwi Banner: '+kiwiOrigin+' → '+kiwiDest,value:1})"
            style="background:#0284c7;color:#fff;padding:7px 14px;border-radius:8px;font-size:.82rem;font-weight:700;text-decoration:none;white-space:nowrap;display:inline-block;">
            Compare on Kiwi.com →
          </a>
        </div>
        <div style="flex:1;min-width:200px;">
          <div style="font-size:.78rem;color:#1d4ed8;margin-bottom:6px;">✈️ Trip.com — flights, hotels &amp; packages worldwide</div>
          <a href="${tripUrl}" target="_blank" rel="noopener" onclick="typeof gtag==='function'&&gtag('event','affiliate_click',{event_category:'Revenue',event_label:'Trip.com Banner: '+kiwiOrigin+' → '+kiwiDest,value:1})"
            style="background:#1d4ed8;color:#fff;padding:7px 14px;border-radius:8px;font-size:.82rem;font-weight:700;text-decoration:none;white-space:nowrap;display:inline-block;">
            Compare on Trip.com →
          </a>
        </div>
      </div>
    </div>`;

  list.innerHTML = kiwiBanner + sortBarHtml + '<div id="flights-container"></div>';
  renderFlightList(flights);

  // ── Show airline direct links (always on results page) ──────
  const TP = '719573';
  const airlineSection = document.getElementById('airline-direct-section');
  if (airlineSection) {
    airlineSection.style.display = 'block';
    const o = kiwiOrigin, d = kiwiDest, dt = kiwiDate, p = kiwiPass;
    const base = `https://jetradar.com/flights/?marker=${TP}&origin=${o}&destination=${d}&depart_date=${dt}&adults=${p}`;
    const oa = document.getElementById('results-omanair-link');
    const ek = document.getElementById('results-emirates-link');
    const ay = document.getElementById('results-finnair-link');
    const qr = document.getElementById('results-qatar-link');
    if (o && d && dt) {
      if (oa) oa.href = base + '&airline=WY';
      if (ek) ek.href = base + '&airline=EK';
      if (ay) ay.href = base + '&airline=AY';
      if (qr) qr.href = base + '&airline=QR';
    }
  }
}

function renderFlightList(flights) {
  const container = document.getElementById('flights-container');
  if (!container) return;

  // Pre-compute min price once (not inside the map loop)
  const _allPrices = (window._flightsAll || flights).map(f => parseFloat(f.price.grandTotal));
  const _minPrice  = _allPrices.length ? Math.min(..._allPrices) : 0;

  container.innerHTML = flights.map((flight, i) => {
    const seg      = flight.itineraries[0].segments[0];
    const lastSeg  = flight.itineraries[0].segments[flight.itineraries[0].segments.length - 1];
    const allSegs  = flight.itineraries[0].segments;
    const stops    = allSegs.length - 1;
    const duration = formatDuration(flight.itineraries[0].duration);
    const price    = parseFloat(flight.price.grandTotal).toFixed(0);
    const currency = flight.price.currency;
    const seats    = flight.numberOfBookableSeats;
    const cabin    = (((((flight.travelerPricings||[])[0])||{}).fareDetailsBySegment||[])[0]||{}).cabin || 'ECONOMY';
    const code     = seg.carrierCode;
    const name     = AIRLINE_NAMES[code] || code;
    const sym      = currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : '$';

    // Stop badge
    const stopVia = allSegs.slice(0,-1).map(s => s.arrival.iataCode).join(', ');
    const stopBadge = stops === 0
      ? '<span class="badge-nonstop">Nonstop</span>'
      : `<span class="badge-stop">${stops} stop${stops>1?'s':''} · ${stopVia}</span>`;

    // Seats urgency
    const seatsBadge = (seats && seats <= 5)
      ? `<div class="seats-urgent">🔥 Only ${seats} left!</div>`
      : (seats && seats <= 9 ? `<div class="seats-warning">${seats} seats left</div>` : '');

    // Best deal badge (cheapest 5% range)
    const dealBadge = parseFloat(flight.price.grandTotal) <= _minPrice * 1.05
      ? '<div class="badge-best">Best price</div>' : '';

    // Baggage & meal info — use actual Duffel API data where available
    const isBudget = BUDGET_AIRLINES.has(code);
    const isBiz = cabin === 'BUSINESS';
    // Use real Duffel checked-bag quantity (stored at flight.baggage by server.js)
    const checkedBagQty = (flight.baggage && flight.baggage.checkedQty) || 0;
    const cabinBagQty   = (flight.baggage && flight.baggage.cabinQty)   || 0;
    // Meal: only claim what is certain — never guess per airline
    const _durStr = flight.itineraries[0].duration || 'PT0H';
    const _durH = (parseInt((_durStr.match(/(\d+)H/)||[])[1] || 0)) + (parseInt((_durStr.match(/(\d+)M/)||[])[1] || 0) / 60);
    const isLongHaul = _durH >= 6;
    const baggage = isBudget
      ? '🎒 Cabin bag only · Checked bag: paid add-on'
      : checkedBagQty > 0
        ? `🧳 ${checkedBagQty}× checked bag (23kg) · Carry-on included`
        : isLongHaul && !isBudget
          ? '🧳 23kg checked bag typically included · Verify with airline'
          : '🎒 Carry-on included · Checked bag: check fare';
    const meal = isBiz
      ? '🍽️ Meal service included'
      : isBudget
        ? '🥤 Buy on board'
        : isLongHaul
          ? '🍱 Meal service (check airline)'
          : '☕ Snack/drink (check airline)';

    return `
      <div class="fc" data-price="${flight.price.grandTotal}" data-dur="${flight.itineraries[0].duration}" data-stops="${stops}">
        <div class="fc-airline">
          <img src="https://www.gstatic.com/flights/airline_logos/70px/${code}.png"
               onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"
               class="fc-logo" alt="${name}" />
          <div class="fc-logo-fallback" style="display:none">${code}</div>
          <div class="fc-airline-name">${name}</div>
          <div class="fc-flight-num">${code}${seg.number}</div>
        </div>

        <div class="fc-route">
          <div class="fc-point">
            <div class="fc-time">${formatTime(seg.departure.at)}</div>
            <div class="fc-iata">${seg.departure.iataCode}</div>
          </div>
          <div class="fc-mid">
            <div class="fc-dur">${duration}</div>
            <div class="fc-line-wrap">
              <span class="fc-dot"></span>
              <div class="fc-bar"></div>
              <span class="fc-plane">✈</span>
              <div class="fc-bar"></div>
              <span class="fc-dot"></span>
            </div>
            ${stopBadge}
          </div>
          <div class="fc-point">
            <div class="fc-time">${formatTime(lastSeg.arrival.at)}</div>
            <div class="fc-iata">${lastSeg.arrival.iataCode}</div>
          </div>
        </div>

        <div class="fc-cabin-col">
          <div class="fc-cabin">${cabin === 'BUSINESS' ? '💼 Business' : '✈ Economy'}</div>
          <div class="fc-baggage">${baggage}</div>
          <div class="fc-meal">${meal}</div>
          <div class="fc-conditions" style="margin-top:6px;font-size:.72rem;display:flex;gap:6px;flex-wrap:wrap;">
            ${(flight.conditions && flight.conditions.refundable)
              ? '<span style="background:#dcfce7;color:#166534;padding:2px 7px;border-radius:20px;">✓ Refundable</span>'
              : '<span style="background:#fee2e2;color:#991b1b;padding:2px 7px;border-radius:20px;">✗ Non-refundable</span>'}
            ${(flight.conditions && flight.conditions.changeable)
              ? '<span style="background:#dbeafe;color:#1e40af;padding:2px 7px;border-radius:20px;">✓ Changes allowed</span>'
              : '<span style="background:#fef3c7;color:#92400e;padding:2px 7px;border-radius:20px;">✗ No changes</span>'}
          </div>
        </div>

        <div class="fc-right">
          ${dealBadge}
          ${seatsBadge}
          <div class="fc-price">${sym}${price}</div>
          <div class="fc-per">per person</div>
          <a class="fc-select-btn" href="https://jetradar.com/flights/?marker=719573&origin=${searchParams.origin||''}&destination=${searchParams.dest||''}&depart_date=${searchParams.departDate||''}&adults=${searchParams.numAdults||1}&airline=${code}" target="_blank" rel="noopener" onclick="typeof gtag==='function'&&gtag('event','affiliate_click',{event_category:'Revenue',event_label:'Flight card: '+(searchParams&&searchParams.origin||'')+' → '+(searchParams&&searchParams.dest||'')+',value:1})" style="text-decoration:none;display:inline-block;">Book →</a>
        </div>
      </div>
    `;
  }).join('');
}

let _nonstopOnly = false;
function filterNonstop(btn) {
  _nonstopOnly = !_nonstopOnly;
  btn.classList.toggle('active', _nonstopOnly);
  const base = window._flightsAll || window._flights || [];
  const filtered = _nonstopOnly ? base.filter(f => f.itineraries[0].segments.length === 1) : base;
  renderFlightList(filtered);
  window._flights = filtered;
}

function sortFlights(by, btn) {
  document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const arr = [...(window._flightsAll || window._flights || [])];
  if (_nonstopOnly) arr.filter(f => f.itineraries[0].segments.length === 1);
  if (by === 'cheapest') {
    arr.sort((a,b) => parseFloat(a.price.grandTotal) - parseFloat(b.price.grandTotal));
  } else if (by === 'fastest') {
    const durMs = d => { const m = (d||'').match(/PT(?:(\d+)H)?(?:(\d+)M)?/); return ((+(m||[])[1]||0)*60+(+(m||[])[2]||0)); };
    arr.sort((a,b) => durMs(a.itineraries[0].duration) - durMs(b.itineraries[0].duration));
  }
  window._flights = arr;
  renderFlightList(arr);
}

function selectFlight(index) {
  const flight = (window._flights || [])[index];

  if (isRoundTrip && !outboundFlight) {
    // First selection = outbound flight — now search for return
    outboundFlight = flight;
    searchReturnFlightsAndShow();
  } else if (isRoundTrip && outboundFlight) {
    // Second selection = return flight — proceed to agency/booking
    selectedFlight       = outboundFlight;
    selectedReturnFlight = flight;
    outboundFlight = null;
    showAgencyPage();
  } else {
    // One-way trip
    selectedFlight       = flight;
    selectedReturnFlight = null;
    showAgencyPage();
  }
}

async function searchReturnFlightsAndShow() {
  const { dest, origin, passengers } = searchParams;

  // Show outbound-selected banner
  const banner    = document.getElementById('outbound-selected-banner');
  const bannerInfo = document.getElementById('outbound-selected-info');
  if (banner && outboundFlight) {
    const ob     = outboundFlight;
    const obSeg  = ob.itineraries[0].segments[0];
    const obLast = ob.itineraries[0].segments[ob.itineraries[0].segments.length - 1];
    const airName = AIRLINE_NAMES[obSeg.carrierCode] || obSeg.carrierCode;
    if (bannerInfo) bannerInfo.textContent =
      `${airName} · ${obSeg.departure.iataCode} → ${obLast.arrival.iataCode} · ` +
      `${formatDate(obSeg.departure.at)} · ${formatTime(obSeg.departure.at)} – ${formatTime(obLast.arrival.at)}`;
    banner.style.display = 'flex';
  }

  // Update heading
  document.getElementById('results-heading').textContent = `${dest} \u2192 ${origin}`;
  document.getElementById('results-subheading').textContent =
    `Return · ${formatDate(searchReturnDate)} · ${passengers} passenger${passengers > 1 ? 's' : ''}`;
  document.getElementById('results-loading').style.display = 'flex';
  document.getElementById('results-list').style.display    = 'none';
  document.getElementById('results-empty').style.display   = 'none';

  const qs = new URLSearchParams({
    origin: dest, destination: origin,
    departureDate: searchReturnDate, adults: passengers
  });

  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20000);
    const resp = await fetch(`/api/flights/search?${qs}`, { signal: controller.signal });
    if (!resp.ok) throw new Error('API error');
    const flights = await resp.json();
    document.getElementById('results-loading').style.display = 'none';
    if (!flights || !flights.length) {
      document.getElementById('results-empty').style.display = 'flex';
      return;
    }
    renderFlightCards(flights);
  } catch (err) {
    console.warn('Return flight search failed:', err.message);
    document.getElementById('results-loading').style.display = 'none';
    document.getElementById('results-empty').style.display   = 'flex';
  }
}

// ─────────────────────────────────────────────────────────────
// AGENCY COMPARISON PAGE (Skyscanner-style)
// ─────────────────────────────────────────────────────────────
function showAgencyPage() {
  const f       = selectedFlight;
  const seg     = f.itineraries[0].segments[0];
  const lastSeg = f.itineraries[0].segments[f.itineraries[0].segments.length - 1];
  const allSegs = f.itineraries[0].segments;
  const price   = parseFloat(f.price.grandTotal);
  const sym     = f.price.currency === 'EUR' ? '€' : '$';

  // Route title
  document.getElementById('agency-route-title').textContent =
    `${seg.departure.iataCode} → ${lastSeg.arrival.iataCode}`;
  document.getElementById('agency-route-sub').textContent =
    `${formatDate(seg.departure.at)} · ${formatDuration(f.itineraries[0].duration)} · ${allSegs.length === 1 ? 'Nonstop' : allSegs.length - 1 + ' stop'}`;

  // Agencies list — NordicWings Direct always shown first, then confirmed affiliate partners only
  const isTequila = !!(f.tequilaDeepLink);
  const agencies = [
    { name: 'Kiwi.com',    rating: 4.8, reviews: 62400, price: price,   perks: '✓ Mix & match airlines · Flexible dates · Best price guarantee',  direct: false, stars: 5, highlight: true },
    { name: 'Aviasales',   rating: 4.7, reviews: 48200, price: price+1, perks: '✓ Compare 728 airlines · No hidden fees · Trusted worldwide',      direct: false, stars: 5, highlight: true },
    { name: 'Jetradar',    rating: 4.7, reviews: 41800, price: price+2, perks: '✓ Cashback on flights · Real-time prices · 728 airlines',          direct: false, stars: 5, highlight: true },
    { name: 'Trip.com',    rating: 4.7, reviews: 3821,  price: price+3, perks: '✓ Pay now or pay later · 24/7 support · Worldwide coverage',      direct: false, stars: 5, highlight: true },
  ];

  document.getElementById('agencies-list').innerHTML = `
    <div class="agency-disclaimer">
      ℹ️ <strong>Estimated prices shown.</strong> Clicking a partner will open their site with live, real prices for this route. Prices may vary by date and availability.
    </div>
  ` + agencies.map((a, i) => `
    <div class="agency-row ${a.direct ? 'nordicwings-direct' : ''} ${a.highlight ? 'agency-highlight' : ''}"
         onclick="${a.direct ? 'proceedToBooking()' : `openPartnerLink('${a.name}')`}">
      <div class="agency-name-wrap">
        <div class="agency-name">
          ${a.name}
          ${a.direct ? '<span class="agency-badge badge-direct">Book Direct</span>' : '<span class="agency-badge badge-partner">Partner</span>'}
          ${a.highlight ? '<span class="agency-badge badge-top">⭐ Top Pick</span>' : ''}
        </div>
        <div class="agency-stars">
          ${'★'.repeat(a.stars)}<span class="agency-rating">${a.rating}/5 · ${a.reviews.toLocaleString()} reviews</span>
        </div>
        ${a.perks ? `<div class="agency-perks">${a.perks}</div>` : ''}
      </div>
      <div>
        <div class="agency-price">${sym}${a.price.toFixed(0)}</div>
        <div class="agency-price-sub">est. per person</div>
      </div>
      <button class="agency-btn ${a.direct ? 'direct' : ''}">${a.direct ? 'Book Now' : 'View Deal'}</button>
    </div>
  `).join('');

  // Build detailed itinerary
  let itinHtml = `<div class="itin-leg"><div class="itin-leg-label">Outbound · ${formatDate(seg.departure.at)}</div>`;
  allSegs.forEach((s, idx) => {
    itinHtml += `
      <div class="itin-seg">
        <div class="itin-dot-col">
          <div class="itin-dot"></div>
          ${idx < allSegs.length - 1 ? '<div class="itin-line"></div>' : ''}
        </div>
        <div class="itin-seg-info">
          <div class="itin-seg-time">${formatTime(s.departure.at)}</div>
          <div class="itin-seg-airport">${s.departure.iataCode}</div>
          <div class="itin-seg-flight">Flight ${s.carrierCode}${s.number} · ${AIRLINE_NAMES[s.carrierCode] || s.carrierCode}</div>
          <div class="itin-seg-dur">▼ ${formatDuration(s.duration)}</div>
        </div>
        <div class="itin-seg-info" style="text-align:right;">
          <div class="itin-seg-time">${formatTime(s.arrival.at)}</div>
          <div class="itin-seg-airport">${s.arrival.iataCode}</div>
        </div>
      </div>
      ${idx < allSegs.length - 1 ? (
        allSegs[idx+1] && s.arrival.iataCode !== allSegs[idx+1].departure.iataCode
          ? `<div class="itin-layover" style="color:#dc2626;background:#fef2f2;border-radius:6px;padding:4px 8px;">⚠️ <strong>Airport change:</strong> Arrive ${s.arrival.iataCode}, depart from ${allSegs[idx+1].departure.iataCode} — self-transfer required (collect & re-check bags)</div>`
          : `<div class="itin-layover">🕐 Layover at ${s.arrival.iataCode} — approx 1h 30min</div>`
      ) : ''}
    `;
  });
  itinHtml += `<div class="itin-arrival">🛬 Arrives ${formatDate(lastSeg.arrival.at)} · Total: ${formatDuration(f.itineraries[0].duration)}</div></div>`;

  document.getElementById('agency-itinerary').innerHTML = itinHtml;
  showPage('agencies');
}

function proceedToBooking() {
  // Tequila/Kiwi flight — open the real booking link directly
  if (selectedFlight && selectedFlight.tequilaDeepLink) {
    if (typeof gtag === 'function') {
      var _orig = (searchParams && searchParams.origin) || '';
      var _dest = (searchParams && searchParams.dest)   || '';
      gtag('event', 'affiliate_click', {
        event_category: 'Revenue',
        event_label: 'Direct flight: ' + _orig + ' → ' + _dest,
        value: 1
      });
    }
    window.open(selectedFlight.tequilaDeepLink, '_blank');
    return;
  }
  // Duffel flight — normal Stripe booking flow
  if (!currentUser) {
    openAuthModal('login');
    return;
  }
  setupBookingPage();
  showPage('booking');
}

function openPartnerLink(agencyName) {
  const f    = selectedFlight;
  const seg  = f.itineraries[0].segments[0];
  const last = f.itineraries[0].segments[f.itineraries[0].segments.length - 1];
  const orig = seg.departure.iataCode;
  const dest = last.arrival.iataCode;
  const date = seg.departure.at ? seg.departure.at.split('T')[0] : '';
  const pass = searchParams.passengers || 1;
  const marker = '719573'; // Your Travelpayouts marker

  // Your affiliate IDs
  const TP  = '719573';          // Travelpayouts marker
  const TC  = 'Allianceid=8098413&SID=306552835&trip_sub1=&trip_sub3=D15634670'; // Trip.com

  // Affiliate deep links — confirmed partners only (earn real commission)
  const links = {
    'Kiwi.com':   `https://www.kiwi.com/en/search/results/${orig}/${dest}/${date}?adults=${pass}&affilid=kiwi_affiliates`,
    'Aviasales':  `https://aviasales.com/?marker=${TP}&origin=${orig}&destination=${dest}&departure_at=${date}&adults=${pass}`,
    'Jetradar':   `https://www.jetradar.com/flights/?origin=${orig}&destination=${dest}&depart_date=${date}&adults=${pass}&marker=${TP}`,
    'Trip.com':   `https://www.trip.com/flights/explore?Allianceid=8098413&SID=306552835&trip_sub1=flights&dcity=${orig.toLowerCase()}&acity=${dest.toLowerCase()}&ddate=${date}&triptype=ow&class=y&quantity=${pass}`,
  };

  // Fallback to Kiwi.com (affiliate)
  const fallback = `https://www.kiwi.com/en/search/results/${orig}/${dest}/${date}?adults=${pass}&affilid=kiwi_affiliates`;
  const url = links[agencyName] || fallback;

  // Track affiliate click in Google Analytics
  if (typeof gtag === 'function') {
    gtag('event', 'affiliate_click', {
      event_category: 'Revenue',
      event_label: agencyName + ': ' + orig + ' → ' + dest,
      value: 1
    });
  }

  window.open(url, '_blank');
}

// ─────────────────────────────────────────────────────────────
// BOOKING PAGE SETUP
// Builds the passenger forms and loads the Stripe payment element
// ─────────────────────────────────────────────────────────────
async function setupBookingPage() {
  const seg      = selectedFlight.itineraries[0].segments[0];
  const lastSeg  = selectedFlight.itineraries[0].segments[selectedFlight.itineraries[0].segments.length - 1];
  const price    = parseFloat(selectedFlight.price.grandTotal);
  const currency = selectedFlight.price.currency;
  const passengerCount = searchParams.passengers || 1;

  // Pre-fill contact email with logged-in user's email
  if (currentUser) {
    document.getElementById('contact-email').value = currentUser.email || '';
  }

  // Build passenger forms — separate sections for Adults, Children, Infants
  const nAdults   = searchParams.numAdults   || passengerCount;
  const nChildren = searchParams.numChildren || 0;
  const nInfants  = searchParams.numInfants  || 0;

  // Price breakdown: use combined outbound + return price per person
  const returnPriceVal = selectedReturnFlight ? parseFloat(selectedReturnFlight.price.grandTotal) : 0;
  const combinedPrice  = price + returnPriceVal;
  const adultPrice  = Math.round(combinedPrice * 100) / 100;
  const childPrice  = Math.round(combinedPrice * 0.75 * 100) / 100;
  const infantPrice = Math.round(combinedPrice * 0.10 * 100) / 100;
  const totalPrice  = (adultPrice * nAdults) + (childPrice * nChildren) + (infantPrice * nInfants);

  // Store for payment
  window._paxBreakdown = { nAdults, nChildren, nInfants, adultPrice, childPrice, infantPrice, totalPrice };

  function buildAdultForm(num) {
    return `
      <div class="pax-form-block" style="background:#f8faff;border:1.5px solid #dbeafe;border-radius:12px;padding:16px;margin-bottom:14px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <p class="passenger-header" style="margin:0;">👤 Adult ${num}</p>
          <span style="background:#dbeafe;color:#1d4ed8;font-size:.78rem;font-weight:700;padding:3px 10px;border-radius:20px;">Full price · €${adultPrice.toFixed(2)}</span>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Title</label>
            <select class="pax-title">
              <option value="mr">Mr</option>
              <option value="ms">Ms</option>
              <option value="mrs">Mrs</option>
              <option value="dr">Dr</option>
            </select>
          </div>
          <div class="form-group">
            <label>Gender</label>
            <select class="pax-gender">
              <option value="m">Male</option>
              <option value="f">Female</option>
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>First Name</label>
            <input type="text" class="pax-first" placeholder="As on passport" />
          </div>
          <div class="form-group">
            <label>Last Name</label>
            <input type="text" class="pax-last" placeholder="As on passport" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Date of Birth</label>
            <input type="date" class="pax-dob" />
          </div>
          <div class="form-group">
            <label>Passport / ID Number</label>
            <input type="text" class="pax-passport" placeholder="Passport number" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Email</label>
            <input type="email" class="pax-email" placeholder="For ticket delivery" />
          </div>
          <div class="form-group">
            <label>Phone Number</label>
            <input type="tel" class="pax-phone" placeholder="+358..." />
          </div>
        </div>
      </div>`;
  }

  function buildChildForm(num) {
    return `
      <div class="pax-form-block" style="background:#fff7ed;border:1.5px solid #fed7aa;border-radius:12px;padding:16px;margin-bottom:14px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <p class="passenger-header" style="margin:0;">🧒 Child ${num} <span style="font-size:.75rem;color:#92400e;font-weight:500;">(2–17 yrs)</span></p>
          <span style="background:#fed7aa;color:#92400e;font-size:.78rem;font-weight:700;padding:3px 10px;border-radius:20px;">~25% off · €${childPrice.toFixed(2)}</span>
        </div>
        <div style="background:#fef3c7;border:1px solid #fde68a;border-radius:8px;padding:8px 12px;font-size:.78rem;color:#92400e;margin-bottom:12px;">
          ⚠️ Children aged 2–17 must travel with at least one adult.
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Gender</label>
            <select class="pax-gender">
              <option value="m">Male</option>
              <option value="f">Female</option>
            </select>
          </div>
          <div class="form-group">
            <label>Date of Birth <span style="color:#d97706;font-size:.75rem;">(must be 2–17)</span></label>
            <input type="date" class="pax-dob pax-dob-child" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>First Name</label>
            <input type="text" class="pax-first" placeholder="As on passport" />
          </div>
          <div class="form-group">
            <label>Last Name</label>
            <input type="text" class="pax-last" placeholder="As on passport" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Passport / ID Number</label>
            <input type="text" class="pax-passport" placeholder="Passport number" />
          </div>
          <div class="form-group">
            <label>Email <span style="color:#94a3b8;font-size:.75rem;">(optional)</span></label>
            <input type="email" class="pax-email" placeholder="Parent's email if under 18" />
          </div>
        </div>
        <input type="hidden" class="pax-title" value="ms">
        <input type="hidden" class="pax-phone" value="">
      </div>`;
  }

  function buildInfantForm(num) {
    return `
      <div class="pax-form-block" style="background:#f0fdf4;border:1.5px solid #86efac;border-radius:12px;padding:16px;margin-bottom:14px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <p class="passenger-header" style="margin:0;">👶 Infant ${num} <span style="font-size:.75rem;color:#166534;font-weight:500;">(0–1 yr · lap)</span></p>
          <span style="background:#dcfce7;color:#166534;font-size:.78rem;font-weight:700;padding:3px 10px;border-radius:20px;">~90% off · €${infantPrice.toFixed(2)}</span>
        </div>
        <div style="background:#d1fae5;border:1px solid #6ee7b7;border-radius:8px;padding:8px 12px;font-size:.78rem;color:#065f46;margin-bottom:12px;">
          👶 Infants travel on a parent/guardian's lap — no separate seat. Must be under 2 years old on the date of travel.
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>First Name</label>
            <input type="text" class="pax-first" placeholder="As on passport" />
          </div>
          <div class="form-group">
            <label>Last Name</label>
            <input type="text" class="pax-last" placeholder="As on passport" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Date of Birth <span style="color:#16a34a;font-size:.75rem;">(must be under 2)</span></label>
            <input type="date" class="pax-dob pax-dob-infant" />
          </div>
          <div class="form-group">
            <label>Gender</label>
            <select class="pax-gender">
              <option value="m">Male</option>
              <option value="f">Female</option>
            </select>
          </div>
        </div>
        <input type="hidden" class="pax-title" value="ms">
        <input type="hidden" class="pax-passport" value="">
        <input type="hidden" class="pax-email" value="">
        <input type="hidden" class="pax-phone" value="">
      </div>`;
  }

  let formsHtml = '';
  // Adults section
  for (let i = 1; i <= nAdults; i++)   formsHtml += buildAdultForm(i);
  // Children section
  for (let i = 1; i <= nChildren; i++) formsHtml += buildChildForm(i);
  // Infants section
  for (let i = 1; i <= nInfants; i++)  formsHtml += buildInfantForm(i);

  // Price breakdown banner
  if (nChildren > 0 || nInfants > 0) {
    formsHtml += `
      <div style="background:#eff6ff;border:1.5px solid #bfdbfe;border-radius:12px;padding:14px 16px;margin-bottom:16px;">
        <div style="font-weight:800;color:#1e3a8a;font-size:.9rem;margin-bottom:8px;">💶 Price Breakdown</div>
        ${nAdults   > 0 ? `<div style="display:flex;justify-content:space-between;font-size:.85rem;padding:4px 0;"><span>👤 Adults × ${nAdults}</span><span>€${(adultPrice * nAdults).toFixed(2)}</span></div>` : ''}
        ${nChildren > 0 ? `<div style="display:flex;justify-content:space-between;font-size:.85rem;padding:4px 0;"><span>🧒 Children × ${nChildren} <span style="color:#92400e;">(−25%)</span></span><span>€${(childPrice * nChildren).toFixed(2)}</span></div>` : ''}
        ${nInfants  > 0 ? `<div style="display:flex;justify-content:space-between;font-size:.85rem;padding:4px 0;"><span>👶 Infants × ${nInfants} <span style="color:#166534;">(−90%)</span></span><span>€${(infantPrice * nInfants).toFixed(2)}</span></div>` : ''}
        <div style="display:flex;justify-content:space-between;font-size:1rem;font-weight:800;color:#1e3a8a;padding-top:8px;border-top:1px solid #bfdbfe;margin-top:6px;">
          <span>Total</span><span>€${totalPrice.toFixed(2)}</span>
        </div>
      </div>`;
  }

  document.getElementById('passenger-forms').innerHTML = formsHtml;

  // Build full route string including stopovers
  const allSegs   = selectedFlight.itineraries[0].segments;
  const stopCodes = allSegs.slice(0, -1).map(s => s.arrival.iataCode);
  const routeStr  = stopCodes.length > 0
    ? `${seg.departure.iataCode} → ${stopCodes.join(' → ')} → ${lastSeg.arrival.iataCode}`
    : `${seg.departure.iataCode} → ${lastSeg.arrival.iataCode}`;

  const stopLabel = stopCodes.length === 0
    ? '<span style="color:#16a34a;font-size:.8rem;font-weight:600;">✅ Nonstop</span>'
    : `<span style="color:#d97706;font-size:.8rem;font-weight:600;">🔄 ${stopCodes.length} stop via ${stopCodes.join(', ')}</span>`;

  // IATA aircraft code → full name (real data from Duffel API)
  const iataAircraftMap = {
    '319':'Airbus A319','320':'Airbus A320','321':'Airbus A321',
    '32A':'Airbus A320neo','32B':'Airbus A321neo','32N':'Airbus A321neo',
    '32S':'Airbus A320neo','32K':'Airbus A321XLR',
    '330':'Airbus A330','332':'Airbus A330-200','333':'Airbus A330-300',
    '338':'Airbus A330-800neo','339':'Airbus A330-900neo',
    '343':'Airbus A340-300','346':'Airbus A340-600',
    '350':'Airbus A350','359':'Airbus A350-900','351':'Airbus A350-1000',
    '380':'Airbus A380','388':'Airbus A380-800',
    '737':'Boeing 737-800','738':'Boeing 737-800','739':'Boeing 737-900',
    '7M8':'Boeing 737 MAX 8','7M9':'Boeing 737 MAX 9',
    '763':'Boeing 767-300','772':'Boeing 777-200','773':'Boeing 777-300',
    '77W':'Boeing 777-300ER','788':'Boeing 787-8','789':'Boeing 787-9','78X':'Boeing 787-10',
    'E90':'Embraer E190','E95':'Embraer E195','E75':'Embraer E175',
    'AT7':'ATR 72','CR9':'Bombardier CRJ-900',
    // Airbus A220 family
    '220':'Airbus A220-100','221':'Airbus A220-100',
    '223':'Airbus A220-300','BCS1':'Airbus A220-100','BCS3':'Airbus A220-300',
  };
  // Fallback per airline if Duffel gives no aircraft code
  const airlineAircraftMap = {
    'EK':'Boeing 777-300ER','QR':'Airbus A350-900','BA':'Boeing 787-9',
    'LH':'Airbus A320','TK':'Boeing 777-300ER','AY':'Airbus A321neo',
    'AF':'Airbus A350-900','KL':'Boeing 777-200','SK':'Airbus A320neo',
    'FI':'Boeing 757-200','FR':'Boeing 737-800','W6':'Airbus A320',
    'BT':'Airbus A220-300',
  };
  const aircraft = iataAircraftMap[seg.aircraft] || airlineAircraftMap[seg.carrierCode] || 'Airbus A320';
  const cabin    = ((((selectedFlight.travelerPricings[0])||{}).fareDetailsBySegment||[])[0]||{}).cabin || 'ECONOMY';
  const isBiz    = cabin === 'BUSINESS';

  document.getElementById('booking-flight-summary').innerHTML = `
    <div class="summary-flight-row">
      <div style="display:flex;align-items:center;gap:10px;">
        <img src="https://www.gstatic.com/flights/airline_logos/70px/${seg.carrierCode}.png"
             onerror="this.style.display='none'"
             style="width:32px;height:32px;object-fit:contain;border-radius:4px;background:#f1f5f9;padding:2px;" />
        <div class="summary-route">${seg.departure.iataCode} → ${lastSeg.arrival.iataCode}</div>
      </div>
      <span style="background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;padding:4px 10px;border-radius:6px;font-size:.8rem;font-weight:600;">✈ Selected</span>
    </div>
    ${stopLabel}
    <div class="summary-times" style="margin-top:8px;">
      <strong style="font-size:1.1rem;">${formatTime(seg.departure.at)}</strong>
      <span style="color:#9ca3af;margin:0 6px;">→</span>
      <strong style="font-size:1.1rem;">${formatTime(lastSeg.arrival.at)}</strong>
    </div>
    <div class="summary-duration">${formatDate(seg.departure.at)} · Total flight time: ${formatDuration(selectedFlight.itineraries[0].duration)}</div>
    <div class="summary-duration" style="margin-top:4px;">✈ ${seg.carrierCode}${seg.number} · ${aircraft}</div>

    <!-- Flight details grid -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px;background:#f8fafc;border-radius:8px;padding:12px;">
      <div style="font-size:.8rem;">
        <div style="color:#6b7280;font-weight:600;text-transform:uppercase;font-size:.7rem;margin-bottom:2px;">Cabin Class</div>
        <div style="font-weight:700;color:#1a2b4a;">${isBiz ? '💼 Business' : '✈ Economy'}</div>
      </div>
      <div style="font-size:.8rem;">
        <div style="color:#6b7280;font-weight:600;text-transform:uppercase;font-size:.7rem;margin-bottom:2px;">Aircraft</div>
        <div style="font-weight:700;color:#1a2b4a;">${aircraft}</div>
      </div>
      <div style="font-size:.8rem;">
        <div style="color:#6b7280;font-weight:600;text-transform:uppercase;font-size:.7rem;margin-bottom:2px;">Checked Baggage</div>
        <div style="font-weight:700;color:#1a2b4a;">${((selectedFlight.baggage && selectedFlight.baggage.checkedQty) > 0) ? selectedFlight.baggage.checkedQty + ' × bag included' : (isBiz ? '2 × bag included' : 'Not included — check airline')}</div>
      </div>
      <div style="font-size:.8rem;">
        <div style="color:#6b7280;font-weight:600;text-transform:uppercase;font-size:.7rem;margin-bottom:2px;">Carry-on</div>
        <div style="font-weight:700;color:#1a2b4a;">${((selectedFlight.baggage && selectedFlight.baggage.cabinQty) > 0) ? selectedFlight.baggage.cabinQty + ' × bag included' : '1 × personal item'}</div>
      </div>
      <div style="font-size:.8rem;">
        <div style="color:#6b7280;font-weight:600;text-transform:uppercase;font-size:.7rem;margin-bottom:2px;">Meal Service</div>
        <div style="font-weight:700;color:#1a2b4a;">🍽 ${isBiz ? 'Included' : 'Varies by airline'}</div>
      </div>
      <div style="font-size:.8rem;">
        <div style="color:#6b7280;font-weight:600;text-transform:uppercase;font-size:.7rem;margin-bottom:2px;">Entertainment</div>
        <div style="font-weight:700;color:#1a2b4a;">📺 Varies by aircraft</div>
      </div>
    </div>

    <!-- Flight itinerary -->
    <div style="margin-top:12px;padding:12px;background:#fffbeb;border-radius:8px;border:1px solid #fde68a;">
      <div style="font-size:.78rem;font-weight:700;color:#92400e;margin-bottom:8px;">✈ FLIGHT ITINERARY</div>
      ${allSegs.map((s, idx) => {
        const nextSeg = allSegs[idx + 1];
        let layoverStr = '';
        if (nextSeg) {
          const arrTime = new Date(s.arrival.at);
          const depTime = new Date(nextSeg.departure.at);
          const diffMins = Math.round((depTime - arrTime) / 60000);
          const lh = Math.floor(diffMins / 60);
          const lm = diffMins % 60;
          layoverStr = lh > 0 ? `${lh}h ${lm}m` : `${lm}m`;
        }
        const segDur = s.duration ? formatDuration(s.duration) : '';
        return `
        <div style="font-size:.82rem;color:#374151;padding:6px 0;border-bottom:${idx < allSegs.length-1 ? '1px dashed #e5e7eb' : 'none'};">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;">
            <div style="display:flex;align-items:center;gap:6px;">
              <img src="https://www.gstatic.com/flights/airline_logos/70px/${s.carrierCode}.png"
                   onerror="this.style.display='none'"
                   style="width:20px;height:20px;object-fit:contain;border-radius:3px;background:#f1f5f9;" />
              <div>
                <strong>${s.departure.iataCode}</strong>
                <span style="font-size:.75rem;color:#374151;"> ${formatTime(s.departure.at)}</span>
                <span style="font-size:.7rem;color:#9ca3af;"> ${formatDate(s.departure.at)}</span>
              </div>
            </div>
            <span style="color:#9ca3af;font-size:.75rem;">──✈──</span>
            <div style="text-align:right;">
              <strong>${s.arrival.iataCode}</strong>
              <span style="font-size:.75rem;color:#374151;"> ${formatTime(s.arrival.at)}</span>
              <span style="font-size:.7rem;color:#9ca3af;"> ${formatDate(s.arrival.at)}</span>
            </div>
          </div>
          <div style="font-size:.75rem;color:#6b7280;margin-top:3px;padding-left:26px;">
            Flight ${s.carrierCode}${s.number}${segDur ? ' · ' + segDur : ''} · ${iataAircraftMap[s.aircraft] || airlineAircraftMap[s.carrierCode] || aircraft}
          </div>
        </div>
        ${nextSeg ? (
          s.arrival.iataCode !== nextSeg.departure.iataCode
            ? `<div style="font-size:.78rem;color:#dc2626;background:#fef2f2;border:1px solid #fca5a5;border-radius:6px;padding:6px 8px;margin:4px 0;display:flex;align-items:flex-start;gap:6px;">
                ⚠️ <span><strong>Airport change required!</strong> You arrive at <strong>${s.arrival.iataCode}</strong> but your next flight departs from <strong>${nextSeg.departure.iataCode}</strong>. You have ${layoverStr} to travel between airports, collect your bags, and re-check in. This is a <strong>self-transfer</strong> — not a protected connection.</span>
               </div>`
            : `<div style="font-size:.78rem;color:#d97706;padding:6px 0 6px 8px;display:flex;align-items:center;gap:6px;">
                🕐 <span><strong>Layover at ${s.arrival.iataCode}</strong> — ${layoverStr} connection time</span>
               </div>`
        ) : ''}
        `;
      }).join('')}
    </div>

    <!-- Included amenities — only show what is confirmed from Duffel data -->
    ${(() => {
      const _bCode = selectedFlight.itineraries[0].segments[0].carrierCode;
      const _isBudg = BUDGET_AIRLINES.has(_bCode);
      const _bd = selectedFlight.itineraries[0].duration || 'PT0H';
      const _bh = (parseInt((_bd.match(/(\d+)H/)||[])[1]||0)) + (parseInt((_bd.match(/(\d+)M/)||[])[1]||0)/60);
      const _isLongHaul = _bh >= 6;
      const _hasChecked = (selectedFlight.baggage && selectedFlight.baggage.checkedQty) > 0;
      const rows = [];
      // Baggage — use Duffel data, fall back to long-haul hint
      rows.push(_hasChecked
        ? '✓ Checked baggage (23kg)'
        : (_isLongHaul && !_isBudg)
          ? '🧳 23kg bag typically included (verify with airline)'
          : '<span style="color:#6b7280">Checked bag: see fare</span>');
      rows.push(_isBudg ? '<span style="color:#6b7280">Carry-on: check airline</span>' : '✓ Carry-on bag');
      // Meals — only confirmed claims
      if (isBiz)        rows.push('✓ Meal service (business)');
      else if (_isBudg) rows.push('<span style="color:#6b7280">Food: buy on board</span>');
      else              rows.push('<span style="color:#6b7280">Meals: check airline</span>');
      // Only show IFE/comfort for confirmed long-haul widebody flights (6h+)
      if (isBiz) rows.push('✓ Priority boarding');
      // Always true for every NordicWings booking
      rows.push('✓ Real e-ticket issued');
      rows.push('✓ Secure payment on partner site');
      rows.push('✓ 24/7 booking support');
      const cells = rows.map(r => `<div>${r}</div>`).join('');
      return `<div style="margin-top:12px;padding:10px;background:#f0fdf4;border-radius:8px;border:1px solid #bbf7d0;">
        <div style="font-size:.78rem;font-weight:700;color:#15803d;margin-bottom:6px;">✅ WHAT'S INCLUDED</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:.78rem;color:#374151;">${cells}</div>
        <div style="font-size:.7rem;color:#6b7280;margin-top:6px;">Meals, entertainment &amp; Wi-Fi vary by airline and aircraft. Check airline website for full details.</div>
      </div>`;
    })()}
  `;

  // Show return flight section if round trip
  if (selectedReturnFlight) {
    const rSeg    = selectedReturnFlight.itineraries[0].segments[0];
    const rLast   = selectedReturnFlight.itineraries[0].segments[selectedReturnFlight.itineraries[0].segments.length - 1];
    const rSegs   = selectedReturnFlight.itineraries[0].segments;
    const rPrice  = parseFloat(selectedReturnFlight.price.grandTotal);
    const rStops  = rSegs.length - 1;
    const rStopLabel = rStops === 0
      ? '<span style="color:#16a34a;font-size:.8rem;font-weight:600;">✅ Nonstop</span>'
      : `<span style="color:#d97706;font-size:.8rem;font-weight:600;">🔄 ${rStops} stop via ${rSegs.slice(0,-1).map(s=>s.arrival.iataCode).join(', ')}</span>`;
    const rAircraft = iataAircraftMap[rSeg.aircraf(t||{}).code] || airlineAircraftMap[rSeg.carrierCode] || 'Airbus A320neo';

    const returnHtml = `
    <div style="margin-top:14px;padding-top:14px;border-top:2px dashed #e5e7eb;">
      <div style="font-size:.78rem;font-weight:700;color:#6b7280;text-transform:uppercase;margin-bottom:8px;">↩ Return Flight</div>
      <div style="display:flex;align-items:center;gap:10px;justify-content:space-between;flex-wrap:wrap;">
        <div style="display:flex;align-items:center;gap:8px;">
          <img src="https://www.gstatic.com/flights/airline_logos/70px/${rSeg.carrierCode}.png"
               onerror="this.style.display='none'"
               style="width:28px;height:28px;object-fit:contain;border-radius:4px;background:#f1f5f9;padding:2px;" />
          <div style="font-weight:700;color:#1a2b4a;font-size:1rem;">${rSeg.departure.iataCode} → ${rLast.arrival.iataCode}</div>
        </div>
        <span style="background:#f0fdf4;color:#16a34a;border:1px solid #bbf7d0;padding:4px 10px;border-radius:6px;font-size:.8rem;font-weight:600;">↩ Return Selected</span>
      </div>
      ${rStopLabel}
      <div style="margin-top:6px;">
        <strong style="font-size:1rem;">${formatTime(rSeg.departure.at)}</strong>
        <span style="color:#9ca3af;margin:0 6px;">→</span>
        <strong style="font-size:1rem;">${formatTime(rLast.arrival.at)}</strong>
      </div>
      <div style="font-size:.82rem;color:#6b7280;margin-top:2px;">${formatDate(rSeg.departure.at)} · ${formatDuration(selectedReturnFlight.itineraries[0].duration)} · ${rSeg.carrierCode}${rSeg.number} · ${rAircraft}</div>
      <!-- Return itinerary -->
      <div style="margin-top:10px;padding:10px;background:#fffbeb;border-radius:8px;border:1px solid #fde68a;">
        <div style="font-size:.78rem;font-weight:700;color:#92400e;margin-bottom:6px;">↩ RETURN ITINERARY</div>
        ${rSegs.map((s, idx) => {
          const nxt = rSegs[idx+1];
          let lay = '';
          if (nxt) {
            const diff = Math.round((new Date(nxt.departure.at) - new Date(s.arrival.at)) / 60000);
            lay = `${Math.floor(diff/60)}h ${diff%60}m`;
          }
          return `
          <div style="font-size:.8rem;color:#374151;padding:4px 0;border-bottom:${idx<rSegs.length-1?'1px dashed #e5e7eb':'none'};">
            <div style="display:flex;justify-content:space-between;">
              <div><img src="https://www.gstatic.com/flights/airline_logos/70px/${s.carrierCode}.png" onerror="this.style.display='none'" style="width:16px;height:16px;vertical-align:middle;border-radius:2px;"> <strong>${s.departure.iataCode}</strong> ${formatTime(s.departure.at)} <span style="font-size:.7rem;color:#9ca3af;">${formatDate(s.departure.at)}</span></div>
              <div style="text-align:right;"><strong>${s.arrival.iataCode}</strong> ${formatTime(s.arrival.at)} <span style="font-size:.7rem;color:#9ca3af;">${formatDate(s.arrival.at)}</span></div>
            </div>
            <div style="font-size:.72rem;color:#6b7280;padding-left:20px;">Flight ${s.carrierCode}${s.number}${s.duration?' · '+formatDuration(s.duration):''}</div>
          </div>
          ${nxt ? (
            s.arrival.iataCode !== nxt.departure.iataCode
              ? `<div style="font-size:.75rem;color:#dc2626;background:#fef2f2;border:1px solid #fca5a5;border-radius:5px;padding:5px 8px;margin:3px 0;">⚠️ <strong>Airport change:</strong> Arrive ${s.arrival.iataCode} → depart ${nxt.departure.iataCode} (${lay}) — self-transfer, collect & re-check bags</div>`
              : `<div style="font-size:.75rem;color:#d97706;padding:4px 0 4px 8px;">🕐 <strong>Layover at ${s.arrival.iataCode}</strong> — ${lay}</div>`
          ) : ''}
          `;
        }).join('')}
      </div>
    </div>`;

    document.getElementById('booking-flight-summary').innerHTML += returnHtml;
  }

  // Price calculation with age-based breakdown
  const nAdults2   = searchParams.numAdults   || passengerCount;
  const nChildren2 = searchParams.numChildren || 0;
  const nInfants2  = searchParams.numInfants  || 0;

  const returnPrice    = selectedReturnFlight ? parseFloat(selectedReturnFlight.price.grandTotal) : 0;
  const baseFlightPrice = price + returnPrice;

  // Age-based pricing: adults full, children 75%, infants 10%
  const adultTotal   = baseFlightPrice * nAdults2;
  const childTotal   = baseFlightPrice * 0.75 * nChildren2;
  const infantTotal  = baseFlightPrice * 0.10 * nInfants2;
  const grandTotal   = adultTotal + childTotal + infantTotal;

  // NordicWings fee (combined outbound + return, already included in per-adult price)
  const nwFeeOut    = parseFloat(selectedFlight.nordicwingsFee) || 12;
  const nwFeeRet    = selectedReturnFlight ? (parseFloat(selectedReturnFlight.nordicwingsFee) || 12) : 0;
  const nwFeeTotal  = (nwFeeOut + nwFeeRet).toFixed(2);

  let breakdownHtml = `
    <div class="price-row"><span>✈ Outbound fare / adult</span><span>€${price.toFixed(2)}</span></div>
    ${selectedReturnFlight ? `<div class="price-row"><span>✈ Return fare / adult</span><span>€${returnPrice.toFixed(2)}</span></div>` : ''}
    ${nAdults2   > 0 ? `<div class="price-row"><span>👤 Adults × ${nAdults2}</span><span>€${adultTotal.toFixed(2)}</span></div>` : ''}
    ${nChildren2 > 0 ? `<div class="price-row" style="color:#92400e;"><span>🧒 Children × ${nChildren2} <span style="font-size:.75rem;">(−25%)</span></span><span>€${(baseFlightPrice * 0.75 * nChildren2).toFixed(2)}</span></div>` : ''}
    ${nInfants2  > 0 ? `<div class="price-row" style="color:#166534;"><span>👶 Infants × ${nInfants2} <span style="font-size:.75rem;">(−90%)</span></span><span>€${(baseFlightPrice * 0.10 * nInfants2).toFixed(2)}</span></div>` : ''}
    ${((selectedFlight.baggage && selectedFlight.baggage.checkedQty) > 0) ? '<div class="price-row" style="font-size:.82rem;color:#16a34a;"><span>  ✓ Checked baggage included</span><span>€0.00</span></div>' : ''}
    ${(() => { const _d = selectedFlight.itineraries[0].duration || 'PT0H'; const _h = (parseInt((_d.match(/(\d+)H/)||[])[1]||0)) + (parseInt((_d.match(/(\d+)M/)||[])[1]||0)/60); return _h >= 4 || isBiz ? '<div class="price-row" style="font-size:.82rem;color:#16a34a;"><span>  ✓ Meals included</span><span>€0.00</span></div>' : ''; })()}
    <div class="price-row" style="font-size:.82rem;color:#16a34a;"><span>  ✓ 24/7 booking support</span><span>€0.00</span></div>
    <div class="price-row total"><span>Total</span><span>€${grandTotal.toFixed(2)}</span></div>
    <div style="font-size:.75rem;color:#6b7280;margin-top:6px;text-align:center;">🔒 Transparent pricing · No surprise charges at checkout</div>
  `;
  document.getElementById('price-breakdown').innerHTML = breakdownHtml;

  // Setup Stripe payment element with the correct total
  await setupStripePayment(grandTotal, currency);
}

async function setupStripePayment(amount, currency) {
  document.getElementById('booking-error').textContent = '';

  try {
    // Ask our backend to create a PaymentIntent
    const res  = await fetch('/api/payments/create-intent', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        amount,
        currency: (currency || 'EUR').toLowerCase(),
        flightDetails: {
          from: searchParams.origin,
          to:   searchParams.dest,
          date: searchParams.departDate
        }
      })
    });
    const { clientSecret, error } = await res.json();

    if (error) throw new Error(error);

    // Mount the Stripe Payment Element into #payment-element
    stripeElements = stripe.elements({
      clientSecret,
      appearance: {
        theme: 'stripe',
        variables: {
          colorPrimary: '#2563eb',
          borderRadius: '8px',
          fontFamily: 'Inter, system-ui, sans-serif'
        }
      }
    });
    const paymentElement = stripeElements.create('payment', {
      layout: { type: 'tabs', defaultCollapsed: false },
      wallets: { link: 'never', applePay: 'auto', googlePay: 'auto' }
    });
    paymentElement.mount('#payment-element');
  } catch (err) {
    document.getElementById('booking-error').textContent = 'Could not load payment form. Please try again.';
  }
}

// ─────────────────────────────────────────────────────────────
// SUBMIT BOOKING (pay + save to Firestore)
// ─────────────────────────────────────────────────────────────
async function submitBooking() {
  const errorEl = document.getElementById('booking-error');
  errorEl.textContent = '';

  // Validate passenger fields
  const firstNames = Array.from(document.querySelectorAll('.pax-first')).map(el => el.value.trim());
  const lastNames  = Array.from(document.querySelectorAll('.pax-last')).map(el => el.value.trim());
  const email      = document.getElementById('contact-email').value.trim();
  const phone      = document.getElementById('contact-phone').value.trim();

  // Only validate if fields exist and have values
  if (firstNames.length > 0 && (firstNames.some(n => !n) || lastNames.some(n => !n))) {
    return setError(errorEl, 'Please fill in all passenger names.');
  }
  if (!email || !email.includes('@')) {
    return setError(errorEl, 'Please enter a valid email address.');
  }
  if (!phone) {
    return setError(errorEl, 'Please enter a contact phone number.');
  }
  // If Stripe elements not loaded yet, try to load it now
  if (!stripeElements) {
    setError(errorEl, 'Loading payment form... please wait.');
    const _retP = selectedReturnFlight ? parseFloat(selectedReturnFlight.price.grandTotal) : 0;
    await setupStripePayment(
      (parseFloat(selectedFlight.price.grandTotal) + _retP) * (searchParams.passengers || 1),
      selectedFlight.price.currency || 'EUR'
    );
    // Give it 2 seconds to mount
    await new Promise(resolve => setTimeout(resolve, 2000));
    if (!stripeElements) {
      return setError(errorEl, 'Payment form could not load. Please refresh the page and try again.');
    }
  }

  toggleBtnLoading('pay-btn-text', 'pay-btn-spinner', true);
  document.getElementById('pay-btn').disabled = true;

  try {
    // Confirm the Stripe payment
    const { error: stripeError, paymentIntent } = await stripe.confirmPayment({
      elements: stripeElements,
      confirmParams: {
        return_url: window.location.origin + '/?booking=confirmed',
        payment_method_data: {
          billing_details: { email, phone }
        }
      },
      redirect: 'always' // Klarna/PayPal require redirect — use return_url to come back
    });

    if (stripeError) {
      setError(errorEl, stripeError.message);
      return;
    }

    // Capture Stripe PaymentIntent ID for future refunds
    const paymentIntentId = paymentInten(t||{}).id || null;

    // Payment succeeded — now issue the real ticket via Duffel (if Duffel flight)
    const seg     = selectedFlight.itineraries[0].segments[0];
    const lastSeg = selectedFlight.itineraries[0].segments[selectedFlight.itineraries[0].segments.length - 1];
    const _retPx  = selectedReturnFlight ? parseFloat(selectedReturnFlight.price.grandTotal) : 0;
    const _baseP  = parseFloat(selectedFlight.price.grandTotal) + _retPx;
    const _nA = searchParams.numAdults   || searchParams.passengers || 1;
    const _nC = searchParams.numChildren || 0;
    const _nI = searchParams.numInfants  || 0;
    const price   = (_baseP * _nA) + (_baseP * 0.75 * _nC) + (_baseP * 0.10 * _nI);

    // Collect all passenger details from form
    const titles   = Array.from(document.querySelectorAll('.pax-title')).map(el => el.value);
    const genders  = Array.from(document.querySelectorAll('.pax-gender')).map(el => el.value);
    const dobs     = Array.from(document.querySelectorAll('.pax-dob')).map(el => el.value);
    const paxEmails = Array.from(document.querySelectorAll('.pax-email')).map(el => el.value.trim());
    const phones   = Array.from(document.querySelectorAll('.pax-phone')).map(el => el.value.trim());

    let duffelBookingRef = null;
    let duffelOrderId    = null;

    // If this is a Duffel flight, create the real order
    if (selectedFlight.duffelOfferId) {
      try {
        const passengersPayload = firstNames.map((first, i) => ({
          title:       titles[i] || 'mr',
          given_name:  first,
          family_name: lastNames[i],
          born_on:     dobs[i] || '1990-01-01',
          gender:      genders[i] || 'm',
          email:       paxEmails[i] || email,
          phone:       phones[i] || phone || '+358000000000'
        }));

        const bookRes = await fetch('/api/bookings/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            offerId:   selectedFlight.duffelOfferId,
            basePrice: selectedFlight.duffelBasePrice,
            passengers: passengersPayload
          })
        });

        const bookData = await bookRes.json();
        if (bookData.success) {
          duffelBookingRef = bookData.bookingReference;
          duffelOrderId    = bookData.orderId;
          console.log('✅ Duffel ticket issued! Ref:', duffelBookingRef);
        } else {
          console.error('Duffel booking failed:', bookData.error);
          // Payment already taken — still save to Firestore, flag for manual review
        }
      } catch (duffelErr) {
        console.error('Duffel order error:', duffelErr.message);
      }
    }

    const booking = {
      userId:    currentUser.uid,
      userEmail: currentUser.email,
      bookingRef: duffelBookingRef || generateBookingRef(),
      duffelOrderId: duffelOrderId || null,
      status:    'confirmed',
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      flight: {
        from:       seg.departure.iataCode,
        to:         lastSeg.arrival.iataCode,
        departTime: seg.departure.at,
        arriveTime: lastSeg.arrival.at,
        airline:    seg.carrierCode,
        flightNum:  seg.carrierCode + seg.number,
        duration:   formatDuration(selectedFlight.itineraries[0].duration)
      },
      ...(selectedReturnFlight ? {
        returnFlight: {
          from:       selectedReturnFlight.itineraries[0].segments[0].departure.iataCode,
          to:         selectedReturnFlight.itineraries[0].segments[selectedReturnFlight.itineraries[0].segments.length-1].arrival.iataCode,
          departTime: selectedReturnFlight.itineraries[0].segments[0].departure.at,
          arriveTime: selectedReturnFlight.itineraries[0].segments[selectedReturnFlight.itineraries[0].segments.length-1].arrival.at,
          airline:    selectedReturnFlight.itineraries[0].segments[0].carrierCode,
          duration:   formatDuration(selectedReturnFlight.itineraries[0].duration)
        }
      } : {}),
      passengers: firstNames.map((first, i) => ({
        firstName: first,
        lastName:  lastNames[i],
        dob:       dobs[i] || '',
        gender:    genders[i] || ''
      })),
      contact: { email, phone },
      totalPrice:      price.toFixed(2),
      duffelBasePrice: (selectedFlight.duffelBasePrice || 0).toFixed(2),
      nordicwingsFee:  (selectedFlight.nordicwingsFee  || 0).toFixed(2),
      currency:        selectedFlight.price.currency || 'EUR',
      paymentIntentId: paymentIntentId || null,
      source:          'direct'   // 'direct' = booked on NordicWings
    };

    await db.collection('bookings').add(booking);

    // Register flight reminder email (sent the day before the flight)
    try {
      var reminderEmail   = booking.contact.email || booking.userEmail || '';
      var passengerFirst  = (booking.passengers && booking.passengers[0]) ? booking.passengers[0].firstName + ' ' + booking.passengers[0].lastName : 'Traveller';
      var flightDateOnly  = booking.flight.departTime ? booking.flight.departTime.split('T')[0] : '';
      if (reminderEmail && flightDateOnly) {
        fetch('/api/bookings/reminder-register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email:         reminderEmail,
            passengerName: passengerFirst,
            route:         booking.flight.from + ' → ' + booking.flight.to,
            flightDate:    flightDateOnly,
            departureTime: booking.flight.departTime ? formatTime(booking.flight.departTime) : '',
            arrivalTime:   booking.flight.arriveTime ? formatTime(booking.flight.arriveTime)  : '',
            airline:       booking.flight.airline || '',
            bookingRef:    booking.bookingRef || '',
            flightNumber:  booking.flight.flightNum || ''
          })
        }).catch(function(e) { console.warn('Reminder registration failed (non-critical):', e.message); });
      }
    } catch (reminderErr) {
      console.warn('Reminder registration error (non-critical):', reminderErr.message);
    }

    // Show confirmation page
    showConfirmationPage(booking);

  } catch (err) {
    setError(errorEl, 'Booking failed: ' + (err.message || 'Please try again.'));
  } finally {
    toggleBtnLoading('pay-btn-text', 'pay-btn-spinner', false);
    document.getElementById('pay-btn').disabled = false;
  }
}

function showConfirmationPage(booking) {
  const isRealTicket = !!booking.duffelOrderId;
  document.getElementById('confirmation-details').innerHTML = `
    <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:10px;padding:16px;margin-bottom:16px;text-align:center;">
      <div style="font-size:2rem;margin-bottom:8px;">${isRealTicket ? '✅' : '🎫'}</div>
      <div style="font-weight:700;color:#16a34a;font-size:1.1rem;">${isRealTicket ? 'Real Ticket Issued!' : 'Booking Confirmed!'}</div>
      <div style="font-size:.85rem;color:#4b5563;margin-top:4px;">${isRealTicket ? 'Your ticket has been issued by the airline.' : 'Your booking is confirmed.'}</div>
    </div>
    <div style="display:grid;gap:10px;">
      <div style="display:flex;justify-content:space-between;padding:10px;background:#f8fafc;border-radius:8px;">
        <span style="color:#6b7280;font-size:.85rem;">Booking Reference</span>
        <strong style="color:#1a2b4a;font-size:1rem;letter-spacing:1px;">${booking.bookingRef}</strong>
      </div>
      <div style="display:flex;justify-content:space-between;padding:10px;background:#f8fafc;border-radius:8px;">
        <span style="color:#6b7280;font-size:.85rem;">Route</span>
        <strong>${booking.flight.from} → ${booking.flight.to}</strong>
      </div>
      <div style="display:flex;justify-content:space-between;padding:10px;background:#f8fafc;border-radius:8px;">
        <span style="color:#6b7280;font-size:.85rem;">Date</span>
        <strong>${formatDate(booking.flight.departTime)}</strong>
      </div>
      <div style="display:flex;justify-content:space-between;padding:10px;background:#f8fafc;border-radius:8px;">
        <span style="color:#6b7280;font-size:.85rem;">Flight Time</span>
        <strong>${formatTime(booking.flight.departTime)} → ${formatTime(booking.flight.arriveTime)}</strong>
      </div>
      <div style="display:flex;justify-content:space-between;padding:10px;background:#f8fafc;border-radius:8px;">
        <span style="color:#6b7280;font-size:.85rem;">Flight</span>
        <strong>${booking.flight.flightNum}</strong>
      </div>
      <div style="display:flex;justify-content:space-between;padding:10px;background:#f8fafc;border-radius:8px;">
        <span style="color:#6b7280;font-size:.85rem;">Passengers</span>
        <strong>${booking.passengers.map(p => p.firstName + ' ' + p.lastName).join(', ')}</strong>
      </div>
      <div style="display:flex;justify-content:space-between;padding:10px;background:#f8fafc;border-radius:8px;">
        <span style="color:#6b7280;font-size:.85rem;">Total Paid</span>
        <strong style="color:#16a34a;font-size:1.1rem;">€${booking.totalPrice}</strong>
      </div>
    </div>
    <div style="margin-top:14px;padding:12px;background:#fffbeb;border-radius:8px;font-size:.82rem;color:#92400e;text-align:center;">
      📧 Confirmation and ticket details sent to <strong>${booking.contact.email}</strong>
    </div>

    <!-- AirHelp affiliate banner -->
    <div style="margin-top:16px;background:linear-gradient(135deg,#fef3c7,#fff7ed);border:1.5px solid #fbbf24;
      border-radius:12px;padding:14px 16px;">
      <div style="font-weight:700;color:#92400e;font-size:.9rem;margin-bottom:4px;">✈️ Flight delayed or cancelled?</div>
      <div style="font-size:.8rem;color:#b45309;margin-bottom:10px;">You could be entitled to up to €600 compensation per person. AirHelp handles your claim for free.</div>
      <a href="https://airhelp.tpk.mx/2qYxqDeS" target="_blank" rel="noopener"
        style="display:inline-block;background:#f59e0b;color:#fff;padding:8px 18px;border-radius:8px;font-size:.82rem;font-weight:700;text-decoration:none;">
        Check my compensation →
      </a>
    </div>

    <!-- EKTA Travel Insurance affiliate banner -->
    <div style="margin-top:10px;background:linear-gradient(135deg,#f0fdf4,#dcfce7);border:1.5px solid #86efac;
      border-radius:12px;padding:14px 16px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
      <div>
        <div style="font-weight:700;color:#166534;font-size:.85rem;">🛡️ Travel Insurance — EKTA</div>
        <div style="font-size:.78rem;color:#15803d;margin-top:2px;">Medical cover, trip cancellation, lost luggage · Accepted by embassies worldwide</div>
      </div>
      <a href="https://tp.media/r?marker=719573&trs=519813&p=5869&u=https%3A%2F%2Fektatraveling.com&campaign_id=225" target="_blank" rel="noopener"
        style="background:#16a34a;color:#fff;padding:8px 14px;border-radius:8px;font-size:.8rem;font-weight:700;text-decoration:none;white-space:nowrap;">
        Get insured →
      </a>
    </div>

    <!-- SeaRadar affiliate banner — ferry booking -->
    <div style="margin-top:10px;background:linear-gradient(135deg,#eff6ff,#dbeafe);border:1.5px solid #93c5fd;
      border-radius:12px;padding:14px 16px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
      <div>
        <div style="font-weight:700;color:#1e40af;font-size:.85rem;">🚢 Need a ferry?</div>
        <div style="font-size:.78rem;color:#1d4ed8;margin-top:2px;">Book ferry tickets across the Baltic, Mediterranean &amp; beyond — SeaRadar</div>
      </div>
      <a href="https://searadar.tpk.mx/XaNzHXVR" target="_blank" rel="noopener"
        style="background:#2563eb;color:#fff;padding:8px 14px;border-radius:8px;font-size:.8rem;font-weight:700;text-decoration:none;white-space:nowrap;">
        Find ferries →
      </a>
    </div>

    <!-- Klook banner — tours & activities at destination -->
    <div style="margin-top:10px;background:linear-gradient(135deg,#fdf4ff,#fef3c7);border:1.5px solid #e9d5ff;
      border-radius:12px;padding:14px 16px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
      <div>
        <div style="font-weight:700;color:#7c3aed;font-size:.85rem;">🎡 Things to do at your destination</div>
        <div style="font-size:.78rem;color:#6d28d9;margin-top:2px;">Tours, attractions & activities — book experiences with Klook</div>
      </div>
      <a href="https://tp.media/r?marker=719573&trs=519663&p=4110&u=https%3A%2F%2Fklook.com&campaign_id=137" target="_blank" rel="noopener"
        style="background:#7c3aed;color:#fff;padding:8px 14px;border-radius:8px;font-size:.8rem;font-weight:700;text-decoration:none;white-space:nowrap;">
        Explore activities →
      </a>
    </div>

    <!-- Trip.com banner -->
    <div style="margin-top:10px;background:linear-gradient(135deg,#eff6ff,#e0f2fe);border:1.5px solid #93c5fd;
      border-radius:12px;padding:14px 16px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
      <div>
        <div style="font-weight:700;color:#1e3a8a;font-size:.85rem;">🌏 Need a hotel for your trip?</div>
        <div style="font-size:.78rem;color:#1d4ed8;margin-top:2px;">Book hotels, tours & transfers at your destination with Trip.com</div>
      </div>
      <a href="https://www.trip.com/?Allianceid=8098413&SID=306552835&trip_sub1=&trip_sub3=D16144585" target="_blank" rel="noopener"
        style="background:#1d4ed8;color:#fff;padding:8px 14px;border-radius:8px;font-size:.8rem;font-weight:700;text-decoration:none;white-space:nowrap;">
        Find hotels →
      </a>
    </div>
  `;
  showPage('confirmation');

  // Auto-search hotels for destination
  const destCode = booking.fligh(t||{}).to;
  const departDate = ((booking.flightDepartTime||'').substring(0, 10));
  if (destCode && departDate) {
    const checkIn  = departDate;
    const checkOut = new Date(new Date(departDate).getTime() + 7 * 86400000).toISOString().substring(0, 10);
    searchHotelsForConfirmation(destCode, checkIn, checkOut, 2);
  }
}

async function searchHotelsForConfirmation(destination, checkIn, checkOut, adults) {
  const upsell  = document.getElementById('hotel-upsell');
  const loading = document.getElementById('hotel-loading');
  const results = document.getElementById('hotel-results');
  if (!upsell) return;

  upsell.style.display  = 'block';
  loading.style.display = 'block';
  results.style.display = 'none';

  try {
    const params = new URLSearchParams({ destination, checkIn, checkOut, adults, rooms: 1 });
    const res = await fetch(`/api/hotels/search?${params}`);
    const data = await res.json();
    const hotels = data.hotels || [];

    loading.style.display = 'none';

    if (!hotels.length) {
      // Fallback: show affiliate hotel links when Hotelbeds returns nothing
      results.innerHTML = hotelAffiliateFallback(destination);
      results.style.display = 'block';
      return;
    }

    results.innerHTML = hotels.slice(0, 4).map(h => {
      const stars = '⭐'.repeat(Math.min(parseInt(h.stars) || 3, 5));
      const price = ((h.rooms && h.rooms[0] && h.rooms[0].rate)) ? `from €${parseFloat(h.rooms[0].rate).toFixed(0)}/night` : '';
      const board = ((h.rooms && h.rooms[0] && h.rooms[0].boardName)) || '';
      return `
        <div style="background:#fff;border:1.5px solid #e2e8f0;border-radius:12px;padding:14px;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
          <div style="flex:1;min-width:180px;">
            <div style="font-weight:700;color:#1a2b4a;font-size:.9rem;">${h.name}</div>
            <div style="font-size:.78rem;color:#f59e0b;margin:2px 0;">${stars}</div>
            <div style="font-size:.75rem;color:#6b7280;">${board}</div>
          </div>
          <div style="text-align:right;">
            <div style="font-weight:800;color:#16a34a;font-size:1rem;">${price}</div>
            <div style="font-size:.72rem;color:#6b7280;">per room · ${checkIn} – ${checkOut}</div>
          </div>
        </div>`;
    }).join('') + `
      <div style="text-align:center;margin-top:8px;">
        <a href="https://www.trip.com/hotels/?Allianceid=8098413&SID=306552835"
           target="_blank" rel="noopener"
           style="display:inline-block;background:#1a2b4a;color:#fff;padding:10px 24px;border-radius:10px;font-weight:700;font-size:.85rem;text-decoration:none;margin-bottom:6px;">
          🏨 Book a hotel at your destination →
        </a>
        <div style="font-size:.72rem;color:#9ca3af;">Best price guarantee · Free cancellation on most rooms</div>
      </div>`;

    results.style.display = 'block';
  } catch (err) {
    console.warn('Hotel search error:', err.message);
    // Show fallback even on error
    results.innerHTML = hotelAffiliateFallback(destination);
    results.style.display = 'block';
  }
}

function hotelAffiliateFallback(destination) {
  const tripUrl = `https://www.trip.com/hotels/?Allianceid=8098413&SID=306552835`;
  const bookingUrl = `https://www.booking.com/?marker=719573`;
  const hotelsUrl = `https://www.hotels.com/?affid=719573`;
  return `
    <div style="margin-bottom:10px;">
      <a href="${tripUrl}" target="_blank" rel="noopener"
         style="display:flex;align-items:center;justify-content:space-between;background:#fff;border:1.5px solid #e2e8f0;border-radius:12px;padding:14px;margin-bottom:8px;text-decoration:none;">
        <div>
          <div style="font-weight:700;color:#1a2b4a;font-size:.9rem;">🏨 Trip.com Hotels</div>
          <div style="font-size:.75rem;color:#6b7280;">Best price guarantee · 1.4M+ hotels worldwide</div>
        </div>
        <div style="background:#1a2b4a;color:#fff;padding:8px 16px;border-radius:8px;font-size:.8rem;font-weight:700;white-space:nowrap;">Search Hotels →</div>
      </a>
      <a href="${bookingUrl}" target="_blank" rel="noopener"
         style="display:flex;align-items:center;justify-content:space-between;background:#fff;border:1.5px solid #e2e8f0;border-radius:12px;padding:14px;margin-bottom:8px;text-decoration:none;">
        <div>
          <div style="font-weight:700;color:#1a2b4a;font-size:.9rem;">🛎️ Booking.com</div>
          <div style="font-size:.75rem;color:#6b7280;">Free cancellation on most rooms · 28M+ listings</div>
        </div>
        <div style="background:#003580;color:#fff;padding:8px 16px;border-radius:8px;font-size:.8rem;font-weight:700;white-space:nowrap;">Search Hotels →</div>
      </a>
      <a href="${hotelsUrl}" target="_blank" rel="noopener"
         style="display:flex;align-items:center;justify-content:space-between;background:#fff;border:1.5px solid #e2e8f0;border-radius:12px;padding:14px;text-decoration:none;">
        <div>
          <div style="font-weight:700;color:#1a2b4a;font-size:.9rem;">🌟 Hotels.com</div>
          <div style="font-size:.75rem;color:#6b7280;">Earn free nights · 500,000+ hotels</div>
        </div>
        <div style="background:#c8002a;color:#fff;padding:8px 16px;border-radius:8px;font-size:.8rem;font-weight:700;white-space:nowrap;">Search Hotels →</div>
      </a>
    </div>`;
}

// ─────────────────────────────────────────────────────────────
// DASHBOARD — My Bookings
// ─────────────────────────────────────────────────────────────
async function loadDashboard() {
  const loadingEl  = document.getElementById('dashboard-loading');
  const emptyEl    = document.getElementById('dashboard-empty');
  const listEl     = document.getElementById('dashboard-list');
  const authPrompt = document.getElementById('dashboard-auth-prompt');

  // Reset states
  loadingEl.style.display  = 'none';
  emptyEl.style.display    = 'none';
  listEl.style.display     = 'none';
  authPrompt.style.display = 'none';

  if (!currentUser) {
    authPrompt.style.display = 'flex';
    return;
  }

  loadingEl.style.display = 'flex';

  try {
    const snapshot = await db.collection('bookings')
      .where('userId', '==', currentUser.uid)
      .orderBy('createdAt', 'desc')
      .get();

    loadingEl.style.display = 'none';

    if (snapshot.empty) {
      emptyEl.style.display = 'flex';
      return;
    }

    listEl.style.display = 'flex';

    // Build all HTML at once — never use innerHTML += in a loop (causes DOM reflow each iteration)
    const cardsHtml = [];
    snapshot.forEach(doc => {
      const b = doc.data();
      cardsHtml.push(`
        <div class="booking-card" id="booking-${doc.id}">
          <div>
            <span class="booking-status ${b.status === 'confirmed' ? 'status-confirmed' : 'status-cancelled'}">
              ${b.status === 'confirmed' ? 'Confirmed' : 'Cancelled'}
            </span>
          </div>
          <div class="booking-info">
            <div class="booking-route">${b.flight.from} → ${b.flight.to}</div>
            <div class="booking-date-time">${formatDate(b.flight.departTime)} · ${formatTime(b.flight.departTime)} – ${formatTime(b.flight.arriveTime)}</div>
            <div class="booking-date-time">${b.flight.flightNum} · ${b.flight.duration}</div>
            <div class="booking-ref">Ref: ${b.bookingRef}</div>
          </div>
          <div>
            <div class="booking-price">$${b.totalPrice}</div>
            <div class="booking-price-label">${b.passengers.length} passenger${b.passengers.length > 1 ? 's' : ''}</div>
          </div>
          ${b.status === 'confirmed' ? `
            <button class="btn-cancel" onclick="openCancelModal('${doc.id}')">
              Cancel
            </button>
          ` : '<span style="color:#9ca3af;font-size:.85rem;">Cancelled</span>'}
        </div>
      `);
    });
    listEl.innerHTML = cardsHtml.join('');

  } catch (err) {
    loadingEl.style.display = 'none';
    emptyEl.style.display   = 'flex';
  }
}

// Cancel booking flow
function openCancelModal(bookingId) {
  cancelBookingId = bookingId;
  document.getElementById('cancel-overlay').style.display = 'flex';
  document.getElementById('cancel-overlay').classList.add('open');
}

function closeCancelModal(e) {
  if (e && e.target !== document.getElementById('cancel-overlay')) return;
  document.getElementById('cancel-overlay').style.display = 'none';
  cancelBookingId = null;
}

async function confirmCancelBooking() {
  if (!cancelBookingId) return;

  const btn      = document.getElementById('confirm-cancel-btn');
  const keepBtn  = document.getElementById('keep-booking-btn');
  const resultEl = document.getElementById('cancel-result');
  btn.disabled   = true;
  btn.textContent = 'Processing...';
  if (keepBtn)  keepBtn.disabled  = true;
  if (resultEl) resultEl.style.display = 'none';

  try {
    // Get booking details from Firestore (need paymentIntentId for refund)
    const docSnap = await db.collection('bookings').doc(cancelBookingId).get();
    if (!docSnap.exists) throw new Error('Booking not found.');
    const booking = docSnap.data();

    // Call backend: issue real Stripe refund + Duffel cancellation
    let refundMessage = '';
    if (booking.paymentIntentId) {
      try {
        const res  = await fetch('/api/bookings/cancel', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            paymentIntentId: booking.paymentIntentId,
            duffelOrderId:   booking.duffelOrderId || null,
            totalPrice:      booking.totalPrice,
            bookingRef:      booking.bookingRef
          })
        });
        const data = await res.json();
        refundMessage = data.success
          ? (data.message || 'Refund processed successfully.')
          : (data.error   || 'Contact support@nordicwings.net for your refund.');
      } catch {
        refundMessage = 'Automatic refund unavailable. Email support@nordicwings.net with ref: ' + (booking.bookingRef || cancelBookingId);
      }
    } else {
      refundMessage = 'Booking cancelled. Email support@nordicwings.net with ref: ' + (booking.bookingRef || cancelBookingId) + ' to request your refund.';
    }

    // Mark as cancelled in Firestore
    await db.collection('bookings').doc(cancelBookingId).update({
      status:      'cancelled',
      cancelledAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    // Update card in dashboard UI
    const card = document.getElementById('booking-' + cancelBookingId);
    if (card) {
      const statusEl = card.querySelector('.booking-status');
      if (statusEl) { statusEl.className = 'booking-status status-cancelled'; statusEl.textContent = 'Cancelled'; }
      const cancelBtn = card.querySelector('.btn-cancel');
      if (cancelBtn) cancelBtn.outerHTML = '<span style="color:#9ca3af;font-size:.85rem;">Cancelled</span>';
    }

    // Show success message in modal
    if (resultEl) {
      resultEl.style.cssText = 'display:block;background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:10px;color:#15803d;';
      resultEl.innerHTML = '✅ <strong>Booking cancelled.</strong> ' + refundMessage;
    }
    // Auto-close after 4 seconds
    setTimeout(() => {
      document.getElementById('cancel-overlay').style.display = 'none';
      cancelBookingId = null;
    }, 4000);

  } catch (err) {
    if (resultEl) {
      resultEl.style.cssText = 'display:block;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:10px;color:#dc2626;';
      resultEl.innerHTML = '❌ ' + (err.message || 'Could not cancel. Please contact support@nordicwings.net');
    }
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Yes, Cancel & Refund';
    if (keepBtn) keepBtn.disabled = false;
  }
}

// ─────────────────────────────────────────────────────────────
// AUTH MODAL
// ─────────────────────────────────────────────────────────────
function openAuthModal(tab) {
  // Remember which page is active so we can return after sign-in
  var activePage = document.querySelector('.page.active');
  var returnPageId = activePage ? activePage.id.replace('page-', '') : 'home';
  localStorage.setItem('pendingAuthPage', returnPageId);

  document.getElementById('auth-overlay').style.display = 'flex';
  document.getElementById('auth-overlay').classList.add('open');
  switchAuthTab(tab || 'login');
}

function closeAuthModal(e) {
  if (e && e.target !== document.getElementById('auth-overlay')) return;
  _closeAuthOverlay();
}

function switchAuthTab(tab) {
  document.getElementById('form-login').style.display  = tab === 'login'  ? 'block' : 'none';
  document.getElementById('form-signup').style.display = tab === 'signup' ? 'block' : 'none';
  var tLogin  = document.getElementById('tab-login');
  var tSignup = document.getElementById('tab-signup');
  if (tLogin && tSignup) {
    tLogin.style.background  = tab === 'login'  ? '#fff' : 'rgba(255,255,255,.2)';
    tLogin.style.color       = tab === 'login'  ? '#1e3a8a' : '#fff';
    tSignup.style.background = tab === 'signup' ? '#fff' : 'rgba(255,255,255,.2)';
    tSignup.style.color      = tab === 'signup' ? '#1e3a8a' : '#fff';
  }
  var title = document.getElementById('auth-modal-title');
  var sub   = document.getElementById('auth-modal-sub');
  if (title) title.textContent = tab === 'login' ? 'Welcome back' : 'Join NordicWings';
  if (sub)   sub.textContent   = tab === 'login' ? 'Sign in to manage your bookings' : 'Create your free account in seconds';
  document.getElementById('login-error').textContent  = '';
  document.getElementById('signup-error').textContent = '';
}

// Sign In
async function signInWithGoogle() {
  if (!auth) { alert('Please refresh the page and try again.'); return; }

  // Remember which page opened the sign-in modal so we can return there
  var returnPageId = localStorage.getItem('pendingAuthPage') || 'home';

  // Detect mobile — always use redirect on mobile (popups are unreliable on phones)
  var isMobile = /Android|iPhone|iPad|iPod|Mobile|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

  const provider = new firebase.auth.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });

  if (isMobile) {
    // Mobile: go straight to redirect — reliable on all mobile browsers
    try {
      await auth.signInWithRedirect(provider);
      // Page will reload; getRedirectResult() in initFirebaseSafe handles the rest
    } catch (err) {
      const errorEl = document.getElementById('login-error') || document.getElementById('signup-error');
      if (errorEl) { errorEl.textContent = 'Sign-in failed. Please try again.'; errorEl.style.display = 'block'; }
    }
    return;
  }

  // Desktop: try popup first, fall back to redirect
  try {
    let result;
    try {
      result = await auth.signInWithPopup(provider);
    } catch (popupErr) {
      if (popupErr.code === 'auth/popup-blocked' ||
          popupErr.code === 'auth/operation-not-supported-in-this-environment' ||
          popupErr.code === 'auth/internal-error') {
        await auth.signInWithRedirect(provider);
        return;
      }
      throw popupErr;
    }

    if (result && result.user) {
      _closeAuthOverlay();
      localStorage.removeItem('pendingAuthPage');
      if (returnPageId && returnPageId !== 'home') {
        showPage(returnPageId);
      } else if (selectedFlight) {
        showAgencyPage();
      }
    }
  } catch (err) {
    if (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request') return;
    const errorEl = document.getElementById('login-error') || document.getElementById('signup-error');
    const msg = (err.code || '') + ': ' + (err.message || 'Unknown error');
    if (errorEl) { errorEl.textContent = msg; errorEl.style.display = 'block'; }
    else alert('Google Sign-In error: ' + msg);
  }
}

async function signInUser() {
  const email    = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const errorEl  = document.getElementById('login-error');

  if (!email || !password) return setError(errorEl, 'Please enter your email and password.');

  toggleBtnLoading('login-btn-text', 'login-btn-spinner', true);

  try {
    await auth.signInWithEmailAndPassword(email, password);
    _closeAuthOverlay();

    // Return to the page that opened the modal
    var returnPage = localStorage.getItem('pendingAuthPage');
    localStorage.removeItem('pendingAuthPage');
    if (returnPage && returnPage !== 'home') {
      showPage(returnPage);
    } else if (selectedFlight) {
      showAgencyPage();
    }
  } catch (err) {
    setError(errorEl, friendlyAuthError(err.code));
  } finally {
    toggleBtnLoading('login-btn-text', 'login-btn-spinner', false);
  }
}

// Sign Up
// Toggle password visibility (👁 / 🙈)
function togglePw(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;
  if (input.type === 'password') {
    input.type = 'text';
    btn.textContent = '🙈';
  } else {
    input.type = 'password';
    btn.textContent = '👁';
  }
}

async function signUpUser() {
  const name     = document.getElementById('signup-name').value.trim();
  const email    = document.getElementById('signup-email').value.trim();
  const password = document.getElementById('signup-password').value;
  const errorEl  = document.getElementById('signup-error');

  if (!name)                   return setError(errorEl, 'Please enter your full name.');
  if (!email)                  return setError(errorEl, 'Please enter your email.');
  if (password.length < 6)     return setError(errorEl, 'Password must be at least 6 characters.');

  toggleBtnLoading('signup-btn-text', 'signup-btn-spinner', true);

  try {
    const cred = await auth.createUserWithEmailAndPassword(email, password);
    await cred.user.updateProfile({ displayName: name });
    _closeAuthOverlay();

    // Send welcome email
    try {
      await fetch('/api/welcome-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email })
      });
    } catch(e) { /* non-critical, ignore */ }

    // Return to the page that opened the modal
    var returnPage = localStorage.getItem('pendingAuthPage');
    localStorage.removeItem('pendingAuthPage');
    if (returnPage && returnPage !== 'home') {
      showPage(returnPage);
    } else if (selectedFlight) {
      showAgencyPage();
    }
  } catch (err) {
    setError(errorEl, friendlyAuthError(err.code));
  } finally {
    toggleBtnLoading('signup-btn-text', 'signup-btn-spinner', false);
  }
}

// ─────────────────────────────────────────────────────────────
// NEWSLETTER SUBSCRIPTION
// ─────────────────────────────────────────────────────────────
async function subscribeNewsletter() {
  const input = document.getElementById('newsletter-email');
  const msg   = document.getElementById('newsletter-msg');
  if (!input || !msg) return;

  const email = input.value.trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    msg.textContent = 'Please enter a valid email address.';
    msg.style.background = '#fee2e2';
    msg.style.color = '#dc2626';
    msg.style.display = 'block';
    return;
  }

  if (!db) { alert('Please refresh and try again.'); return; }

  try {
    // Check if already subscribed
    const existing = await db.collection('newsletter_subscribers')
      .where('email', '==', email).limit(1).get();
    if (!existing.empty) {
      msg.textContent = "✅ You're already subscribed — we'll keep you posted!";
      msg.style.background = '#f0fdf4';
      msg.style.color = '#15803d';
      msg.style.display = 'block';
      return;
    }

    await db.collection('newsletter_subscribers').add({
      email:       email,
      source:      'homepage',
      subscribedAt: firebase.firestore.FieldValue.serverTimestamp(),
      status:      'active'
    });

    input.value = '';
    msg.textContent = "🎉 You're subscribed! Expect great deals in your inbox soon.";
    msg.style.background = '#f0fdf4';
    msg.style.color = '#15803d';
    msg.style.display = 'block';
  } catch(e) {
    msg.textContent = 'Something went wrong. Please try again.';
    msg.style.background = '#fee2e2';
    msg.style.color = '#dc2626';
    msg.style.display = 'block';
  }
}

// Sign Out
async function signOutUser() {
  await auth.signOut();
  showPage('home');
}

// Map Firebase error codes to friendly messages
function friendlyAuthError(code) {
  const map = {
    'auth/user-not-found':      'No account found with this email.',
    'auth/wrong-password':      'Incorrect password. Please try again.',
    'auth/email-already-in-use':'An account with this email already exists.',
    'auth/invalid-email':       'Please enter a valid email address.',
    'auth/weak-password':       'Password is too weak. Use at least 6 characters.',
    'auth/too-many-requests':   'Too many attempts. Please try again later.'
  };
  return map[code] || 'Something went wrong. Please try again.';
}

// ─────────────────────────────────────────────────────────────
// ADMIN BUSINESS DASHBOARD
// Only visible to owner (magdayaojennamae712@gmail.com)
// ─────────────────────────────────────────────────────────────
let _allAdminBookings = [];

// ─────────────────────────────────────────────────────────────
// CRM — ADMIN / BUSINESS DASHBOARD
// ─────────────────────────────────────────────────────────────
let _crmTab = 'overview';

function crmSwitchTab(tab) {
  _crmTab = tab;
  document.querySelectorAll('.crm-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.crm-tab-pane').forEach(p => p.style.display = p.id === 'crm-' + tab ? 'block' : 'none');
  if (tab === 'customers')  renderCRMCustomers(_allAdminBookings);
  if (tab === 'bookings')   renderAdminTable(_allAdminBookings);
  if (tab === 'affiliate')  renderAffiliateTab();
  if (tab === 'newsletter') loadAdminNewsletter();
}

async function loadAdminDashboard() {
  if (!currentUser || currentUser.email !== OWNER_EMAIL) {
    showPage('home'); return;
  }
  document.getElementById('crm-loading').style.display = 'flex';
  document.getElementById('crm-content').style.display = 'none';

  try {
    const snapshot = await db.collection('bookings').orderBy('createdAt','desc').get();
    _allAdminBookings = [];
    snapshot.forEach(doc => _allAdminBookings.push({ id: doc.id, ...doc.data() }));
    document.getElementById('crm-loading').style.display = 'none';
    document.getElementById('crm-content').style.display = 'block';
    renderAdminStats(_allAdminBookings);
    renderCRMOverview(_allAdminBookings);
    renderAdminTable(_allAdminBookings);
  } catch (err) {
    console.error('CRM load error:', err);
    document.getElementById('crm-loading').innerHTML = '<p style="color:#ef4444">Failed to load. Refresh to retry.</p>';
  }
}

function renderAdminStats(bookings) {
  const confirmed  = bookings.filter(b => b.status === 'confirmed');
  const revenue    = confirmed.reduce((s, b) => s + parseFloat(b.totalPrice || 0), 0);
  const profit     = confirmed.reduce((s, b) => s + parseFloat(b.nordicwingsFee || 0), 0);
  const customers  = new Set(bookings.map(b => b.userEmail)).size;
  const avgOrder   = confirmed.length ? revenue / confirmed.length : 0;

  // This month
  const now = new Date();
  const thisMonth = confirmed.filter(b => {
    const d = b.createdA(t||{}).toDate ? b.createdAt.toDate() : new Date(b.createdAt || 0);
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  });
  const monthRevenue = thisMonth.reduce((s,b) => s + parseFloat(b.totalPrice||0), 0);
  const monthProfit  = thisMonth.reduce((s,b) => s + parseFloat(b.nordicwingsFee||0), 0);

  document.getElementById('stat-total-bookings').textContent  = bookings.length;
  document.getElementById('stat-total-revenue').textContent   = '€' + revenue.toFixed(2);
  document.getElementById('stat-total-customers').textContent = customers;
  document.getElementById('stat-confirmed').textContent       = confirmed.length;
  const ps = document.getElementById('stat-profit');
  if (ps) ps.textContent = '€' + profit.toFixed(2);
  const av = document.getElementById('stat-avg-order');
  if (av) av.textContent = '€' + avgOrder.toFixed(2);
  const mr = document.getElementById('stat-month-revenue');
  if (mr) mr.textContent = '€' + monthRevenue.toFixed(2);
  const mp = document.getElementById('stat-month-profit');
  if (mp) mp.textContent = '€' + monthProfit.toFixed(2);
}

function renderCRMOverview(bookings) {
  // Monthly revenue chart (last 6 months)
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(); d.setMonth(d.getMonth() - i);
    months.push({ label: d.toLocaleString('en', {month:'short'}), year: d.getFullYear(), month: d.getMonth(), rev: 0, profit: 0 });
  }
  bookings.filter(b => b.status === 'confirmed').forEach(b => {
    const d = b.createdA(t||{}).toDate ? b.createdAt.toDate() : new Date(b.createdAt || 0);
    const m = months.find(m => m.month === d.getMonth() && m.year === d.getFullYear());
    if (m) { m.rev += parseFloat(b.totalPrice||0); m.profit += parseFloat(b.nordicwingsFee||0); }
  });
  const maxRev = Math.max(...months.map(m => m.rev), 1);
  const chartEl = document.getElementById('crm-revenue-chart');
  if (chartEl) {
    chartEl.innerHTML = months.map(m => `
      <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;">
        <div style="font-size:.72rem;color:#16a34a;font-weight:700;">€${m.profit.toFixed(0)}</div>
        <div style="width:100%;background:#e0f2fe;border-radius:6px 6px 0 0;position:relative;height:${Math.max(8, Math.round((m.rev/maxRev)*100))}px;">
          <div style="position:absolute;bottom:0;left:0;right:0;background:#16a34a;border-radius:4px 4px 0 0;height:${Math.max(4,Math.round((m.profit/maxRev)*100))}px;"></div>
        </div>
        <div style="font-size:.72rem;color:#64748b;font-weight:600;">${m.label}</div>
        <div style="font-size:.7rem;color:#1d4ed8;">€${m.rev.toFixed(0)}</div>
      </div>
    `).join('');
  }

  // Top routes
  const routeCounts = {};
  bookings.filter(b=>b.status==='confirmed').forEach(b => {
    const r = (b.flight||{}.from||'?') + '→' + (b.flight||{}.to||'?');
    routeCounts[r] = (routeCounts[r]||0) + 1;
  });
  const topRoutes = Object.entries(routeCounts).sort((a,b)=>b[1]-a[1]).slice(0,5);
  const trEl = document.getElementById('crm-top-routes');
  if (trEl) {
    trEl.innerHTML = topRoutes.length ? topRoutes.map(([r,c]) =>
      `<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #f1f5f9;font-size:.85rem;">
        <span style="font-weight:600;color:#1e293b;">✈ ${r.replace('→',' → ')}</span>
        <span style="background:#dbeafe;color:#1e40af;padding:2px 10px;border-radius:20px;font-weight:700;">${c} booking${c>1?'s':''}</span>
      </div>`).join('')
    : '<div style="color:#94a3b8;font-size:.85rem;padding:8px 0;">No bookings yet</div>';
  }

  // Recent 5 bookings
  const recent = bookings.slice(0,5);
  const recentEl = document.getElementById('crm-recent-bookings');
  if (recentEl) {
    recentEl.innerHTML = recent.map(b => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid #f1f5f9;gap:8px;flex-wrap:wrap;">
        <div>
          <div style="font-weight:700;font-size:.85rem;color:#1e293b;">${((b.passengers && b.passengers[0] && b.passengers[0].firstName)||'')||''} ${((b.passengers && b.passengers[0] && b.passengers[0].lastName)||'')||''}</div>
          <div style="font-size:.75rem;color:#64748b;">${b.flight||{}.from||'?'} → ${b.flight||{}.to||'?'} · ${b.flight||{}.departTime ? formatDate(b.flight.departTime) : '—'}</div>
        </div>
        <div style="text-align:right;">
          <div style="font-weight:800;color:#1e3a8a;">€${parseFloat(b.totalPrice||0).toFixed(2)}</div>
          <div style="font-size:.72rem;color:#16a34a;font-weight:600;">+€${parseFloat(b.nordicwingsFee||0).toFixed(2)} profit</div>
        </div>
        <span style="padding:3px 10px;border-radius:20px;font-size:.72rem;font-weight:700;
          background:${b.status==='confirmed'?'#dcfce7':'#fee2e2'};
          color:${b.status==='confirmed'?'#16a34a':'#dc2626'};">${b.status||'unknown'}</span>
      </div>
    `).join('') || '<div style="color:#94a3b8;font-size:.85rem;padding:8px;">No bookings yet</div>';
  }
}

function renderCRMCustomers(bookings) {
  // Group by email
  const map = {};
  bookings.forEach(b => {
    const email = b.contact||{}.email || b.userEmail || 'unknown';
    if (!map[email]) map[email] = { email, name: `${((b.passengers && b.passengers[0] && b.passengers[0].firstName)||'')||''} ${((b.passengers && b.passengers[0] && b.passengers[0].lastName)||'')||''}`.trim(), phone: (b.contact && b.contact.phone)||'', bookings:[] };
    map[email].bookings.push(b);
  });
  const customers = Object.values(map).sort((a,b) => b.bookings.length - a.bookings.length);
  const el = document.getElementById('crm-customers-list');
  if (!el) return;
  if (!customers.length) { el.innerHTML = '<div style="color:#94a3b8;padding:20px;text-align:center;">No customers yet</div>'; return; }
  el.innerHTML = customers.map((c, ci) => {
    const totalSpent  = c.bookings.reduce((s,b) => s + parseFloat(b.totalPrice||0), 0);
    const totalProfit = c.bookings.reduce((s,b) => s + parseFloat(b.nordicwingsFee||0), 0);
    const confirmed   = c.bookings.filter(b => b.status==='confirmed').length;
    const lastBooking = c.bookings[0];
    return `
    <div style="background:#fff;border:1.5px solid #e2e8f0;border-radius:12px;margin-bottom:12px;overflow:hidden;">
      <div style="display:flex;justify-content:space-between;align-items:center;padding:14px 16px;cursor:pointer;gap:10px;flex-wrap:wrap;"
           onclick="document.getElementById('crm-cust-detail-${ci}').style.display=document.getElementById('crm-cust-detail-${ci}').style.display==='none'?'block':'none'">
        <div style="display:flex;align-items:center;gap:12px;">
          <div style="width:42px;height:42px;border-radius:50%;background:linear-gradient(135deg,#1e3a8a,#3b82f6);
               display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:1rem;flex-shrink:0;">
            ${(c.name||c.email)[0].toUpperCase()}
          </div>
          <div>
            <div style="font-weight:700;color:#1e293b;">${c.name || 'Unknown'}</div>
            <div style="font-size:.78rem;color:#64748b;">${c.email}</div>
            ${c.phone ? `<div style="font-size:.75rem;color:#64748b;">${c.phone}</div>` : ''}
          </div>
        </div>
        <div style="display:flex;gap:16px;flex-wrap:wrap;">
          <div style="text-align:center;">
            <div style="font-weight:800;color:#1e3a8a;font-size:1.1rem;">${c.bookings.length}</div>
            <div style="font-size:.7rem;color:#64748b;">Bookings</div>
          </div>
          <div style="text-align:center;">
            <div style="font-weight:800;color:#1e3a8a;font-size:1.1rem;">€${totalSpent.toFixed(0)}</div>
            <div style="font-size:.7rem;color:#64748b;">Spent</div>
          </div>
          <div style="text-align:center;">
            <div style="font-weight:800;color:#16a34a;font-size:1.1rem;">€${totalProfit.toFixed(0)}</div>
            <div style="font-size:.7rem;color:#64748b;">Your Profit</div>
          </div>
          <a href="mailto:${c.email}?subject=Your NordicWings booking"
             style="background:#1e3a8a;color:#fff;padding:6px 14px;border-radius:8px;font-size:.78rem;font-weight:700;text-decoration:none;align-self:center;"
             onclick="event.stopPropagation()">✉ Email</a>
        </div>
      </div>
      <div id="crm-cust-detail-${ci}" style="display:none;border-top:1px solid #f1f5f9;padding:12px 16px;background:#f8fafc;">
        <div style="font-size:.78rem;font-weight:700;color:#475569;margin-bottom:8px;text-transform:uppercase;">Booking History</div>
        ${c.bookings.map(b => `
          <div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #e2e8f0;font-size:.82rem;flex-wrap:wrap;gap:4px;">
            <div>
              <span style="font-family:monospace;background:#eff6ff;color:#1d4ed8;padding:1px 6px;border-radius:4px;font-size:.75rem;">${b.bookingRef||'—'}</span>
              <strong style="margin-left:8px;">${b.flight||{}.from||'?'} → ${b.flight||{}.to||'?'}</strong>
              <span style="color:#64748b;margin-left:6px;">${b.flight||{}.departTime ? formatDate(b.flight.departTime) : '—'}</span>
              <span style="color:#64748b;margin-left:6px;">${b.passengers||[].length||1} pax</span>
            </div>
            <div style="display:flex;gap:10px;align-items:center;">
              <strong>€${parseFloat(b.totalPrice||0).toFixed(2)}</strong>
              <span style="color:#16a34a;font-size:.75rem;">+€${parseFloat(b.nordicwingsFee||0).toFixed(2)}</span>
              <span style="padding:2px 8px;border-radius:20px;font-size:.72rem;font-weight:700;
                background:${b.status==='confirmed'?'#dcfce7':'#fee2e2'};
                color:${b.status==='confirmed'?'#16a34a':'#dc2626'};">${b.status}</span>
            </div>
          </div>`).join('')}
      </div>
    </div>`;
  }).join('');
}

function renderAffiliateTab() {
  const el = document.getElementById('crm-affiliate-content');
  if (!el || el.dataset.loaded) return;
  el.dataset.loaded = '1';

  // Estimate Trip.com clicks (we can't get real data without their API — direct to portal)
  el.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;margin-bottom:24px;">

      <!-- Trip.com -->
      <div style="background:linear-gradient(135deg,#eff6ff,#dbeafe);border:1.5px solid #93c5fd;border-radius:14px;padding:20px;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
          <div style="font-size:1.8rem;">✈️</div>
          <div>
            <div style="font-weight:800;color:#1e3a8a;font-size:1rem;">Trip.com</div>
            <div style="font-size:.75rem;color:#3b82f6;">Alliance ID: 8098413</div>
          </div>
        </div>
        <div style="font-size:.82rem;color:#1e40af;line-height:1.6;margin-bottom:12px;">
          <strong>Commission rates:</strong><br>
          ✈ Flights: ~1.1–2% of booking value<br>
          🏨 Hotels: ~4–6% of booking value<br>
          🎭 Tours/activities: ~6–8%<br>
          💳 Paid monthly (net-30 after booking)
        </div>
        <div style="background:#fff;border-radius:8px;padding:10px;font-size:.78rem;color:#475569;margin-bottom:12px;">
          💡 Example: Customer books HEL→MNL €800 hotel package on Trip.com via your link → you earn ~€32–48
        </div>
        <a href="https://www.trip.com/pages/affiliate/" target="_blank" rel="noopener"
           style="display:block;text-align:center;background:#1e3a8a;color:#fff;padding:10px;border-radius:10px;font-weight:700;font-size:.85rem;text-decoration:none;">
          Open Trip.com Affiliate Portal →
        </a>
      </div>

      <!-- Kiwi.com -->
      <div style="background:linear-gradient(135deg,#f0fdf4,#dcfce7);border:1.5px solid #86efac;border-radius:14px;padding:20px;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
          <div style="font-size:1.8rem;">🌍</div>
          <div>
            <div style="font-weight:800;color:#15803d;font-size:1rem;">Kiwi.com</div>
            <div style="font-size:.75rem;color:#16a34a;">Via Travelpayouts</div>
          </div>
        </div>
        <div style="font-size:.82rem;color:#166534;line-height:1.6;margin-bottom:12px;">
          <strong>Commission rates:</strong><br>
          ✈ Flights: ~1.5–2% of booking value<br>
          💳 Paid monthly via Travelpayouts<br>
          🔗 Deep links now pre-filled with route + date
        </div>
        <a href="https://travelpayouts.com/dashboard" target="_blank" rel="noopener"
           style="display:block;text-align:center;background:#16a34a;color:#fff;padding:10px;border-radius:10px;font-weight:700;font-size:.85rem;text-decoration:none;">
          Open Travelpayouts Dashboard →
        </a>
      </div>

      <!-- Booking.com + Hotels.com -->
      <div style="background:linear-gradient(135deg,#fdf4ff,#f3e8ff);border:1.5px solid #d8b4fe;border-radius:14px;padding:20px;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
          <div style="font-size:1.8rem;">🏨</div>
          <div>
            <div style="font-weight:800;color:#7e22ce;font-size:1rem;">Booking.com / Hotels.com</div>
            <div style="font-size:.75rem;color:#9333ea;">Affiliate Marker: 719573</div>
          </div>
        </div>
        <div style="font-size:.82rem;color:#6b21a8;line-height:1.6;margin-bottom:12px;">
          <strong>Commission rates:</strong><br>
          🏨 Hotels: ~4% of booking value<br>
          💳 Paid monthly by Booking.com<br>
          🔗 Shown on homepage hotel cards
        </div>
        <a href="https://www.booking.com/affiliates.html" target="_blank" rel="noopener"
           style="display:block;text-align:center;background:#7e22ce;color:#fff;padding:10px;border-radius:10px;font-weight:700;font-size:.85rem;text-decoration:none;">
          Open Booking.com Affiliate Portal →
        </a>
      </div>
    </div>

    <!-- Commission Calculator -->
    <div style="background:#fff;border:1.5px solid #e2e8f0;border-radius:14px;padding:20px;">
      <div style="font-weight:800;color:#1e293b;font-size:1rem;margin-bottom:16px;">🧮 Affiliate Commission Calculator</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:16px;">
        <div>
          <label style="font-size:.78rem;font-weight:600;color:#475569;display:block;margin-bottom:4px;">Platform</label>
          <select id="calc-platform" onchange="calcAffiliate()" style="width:100%;padding:8px;border-radius:8px;border:1.5px solid #e2e8f0;font-size:.85rem;">
            <option value="trip-flight">Trip.com — Flight (1.5%)</option>
            <option value="trip-hotel">Trip.com — Hotel (5%)</option>
            <option value="kiwi">Kiwi.com — Flight (1.8%)</option>
            <option value="booking">Booking.com — Hotel (4%)</option>
          </select>
        </div>
        <div>
          <label style="font-size:.78rem;font-weight:600;color:#475569;display:block;margin-bottom:4px;">Booking Value (€)</label>
          <input type="number" id="calc-value" value="500" oninput="calcAffiliate()" min="1"
            style="width:100%;padding:8px;border-radius:8px;border:1.5px solid #e2e8f0;font-size:.85rem;box-sizing:border-box;">
        </div>
        <div>
          <label style="font-size:.78rem;font-weight:600;color:#475569;display:block;margin-bottom:4px;">Number of Bookings / Month</label>
          <input type="number" id="calc-count" value="10" oninput="calcAffiliate()" min="1"
            style="width:100%;padding:8px;border-radius:8px;border:1.5px solid #e2e8f0;font-size:.85rem;box-sizing:border-box;">
        </div>
      </div>
      <div id="calc-result" style="background:#f0fdf4;border:1.5px solid #86efac;border-radius:10px;padding:14px;text-align:center;">
        <div style="font-size:1.4rem;font-weight:900;color:#15803d;" id="calc-monthly">—</div>
        <div style="font-size:.82rem;color:#16a34a;">estimated monthly affiliate income</div>
        <div style="font-size:.78rem;color:#6b7280;margin-top:4px;" id="calc-annual">—</div>
      </div>
    </div>
  `;
  calcAffiliate();
}

function calcAffiliate() {
  const platform = (document.getElementById('calc-platform')||{}).value;
  const val      = parseFloat((document.getElementById('calc-value')||{}).value) || 0;
  const count    = parseInt((document.getElementById('calc-count')||{}).value) || 0;
  const rates    = { 'trip-flight':0.015, 'trip-hotel':0.05, 'kiwi':0.018, 'booking':0.04 };
  const rate     = rates[platform] || 0.015;
  const monthly  = val * rate * count;
  const annual   = monthly * 12;
  const mr = document.getElementById('calc-monthly');
  const ar = document.getElementById('calc-annual');
  if (mr) mr.textContent = '€' + monthly.toFixed(2) + ' / month';
  if (ar) ar.textContent = 'That\'s approximately €' + annual.toFixed(0) + ' per year';
}

function renderAdminTable(bookings) {
  const filtered = _adminFilter(bookings);
  const tableEl  = document.getElementById('admin-table');
  const emptyEl  = document.getElementById('admin-empty');
  if (!tableEl) return;
  if (!filtered.length) {
    tableEl.style.display = 'none';
    if (emptyEl) emptyEl.style.display = 'flex';
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';
  tableEl.style.display = 'table';

  document.getElementById('admin-table-body').innerHTML = filtered.map(b => `
    <tr>
      <td><span class="admin-ref">${b.bookingRef || '—'}</span></td>
      <td>
        <div class="admin-customer-name">${((b.passengers && b.passengers[0] && b.passengers[0].firstName)||'')||''} ${((b.passengers && b.passengers[0] && b.passengers[0].lastName)||'')||''}</div>
        <div class="admin-customer-email">${b.contact||{}.email || b.userEmail || ''}</div>
      </td>
      <td><strong>${b.flight||{}.from||'?'} → ${b.flight||{}.to||'?'}</strong></td>
      <td>${b.flight||{}.departTime ? formatDate(b.flight.departTime) : '—'}</td>
      <td style="text-align:center;">${b.passengers||[].length||1}</td>
      <td>
        <strong>€${parseFloat(b.totalPrice||0).toFixed(2)}</strong>
        <div style="font-size:.72rem;color:#16a34a;font-weight:600;">+€${parseFloat(b.nordicwingsFee||0).toFixed(2)} profit</div>
      </td>
      <td><span class="booking-status ${b.status==='confirmed'?'status-confirmed':'status-cancelled'}">${b.status||'unknown'}</span></td>
      <td>
        <a href="mailto:${(b.contact||{}).email||b.userEmail||''}?subject=Your NordicWings Booking ${b.bookingRef||''}"
           style="background:#1e3a8a;color:#fff;padding:4px 10px;border-radius:6px;font-size:.8rem;text-decoration:none;display:inline-block;">✉ Email</a>
      </td>
    </tr>
  `).join('');
}

// ═══════════════════════════════════════════════════════════════════
// CASHBACK PLATFORM
// ═══════════════════════════════════════════════════════════════════

const CASHBACK_RATES = {
  flights: 0.008,
  hotels:  0.015,
  tours:   0.02,
  ferries: 0.008,
  events:  0.08   // TicketNetwork: up to 8% avg of 6–12.5% range
};

// Track a click on a cashback affiliate link (anonymous or logged-in)
function trackCashbackClick(partner, category) {
  try {
    const uid = (typeof currentUser !== 'undefined' && currentUser) ? currentUser.uid : 'anon';
    db.collection('cashback_clicks').add({
      partner:   partner,
      category:  category,
      userId:    uid,
      timestamp: firebase.firestore.FieldValue.serverTimestamp()
    });
  } catch(e) { /* silent */ }
}

// Called when cashback page loads — shows balance if logged in
function loadCashbackPage() {
  const form      = document.getElementById('cb-claim-form');
  const notice    = document.getElementById('cb-login-notice');
  const balSec    = document.getElementById('cb-balance-section');
  if (!form) return;

  // Live cashback estimate — add listeners once only
  const amountEl = document.getElementById('cb-amount');
  const typeEl   = document.getElementById('cb-type');
  if (amountEl && !amountEl.dataset.listenerAdded) {
    amountEl.addEventListener('input',  updateCashbackEstimate);
    typeEl   && typeEl.addEventListener('change', updateCashbackEstimate);
    amountEl.dataset.listenerAdded = '1';
  }

  function applyAuthState(user) {
    var heroSignup = document.getElementById('cb-hero-signup-btn');
    var heroClaim  = document.getElementById('cb-hero-claim-btn');
    if (user) {
      // Signed in — show claim form, hide guest prompts
      if (notice)     notice.style.display     = 'none';
      if (form)       form.style.display       = 'block';
      if (heroSignup) heroSignup.style.display = 'none';
      if (heroClaim)  heroClaim.style.display  = 'inline-block';
      loadUserCashbackBalance();
    } else {
      // Guest — show sign-in prompts, hide claim form
      if (notice)     notice.style.display     = 'block';
      if (form)       form.style.display       = 'none';
      if (balSec)     balSec.style.display     = 'none';
      if (heroSignup) heroSignup.style.display = 'inline-block';
      if (heroClaim)  heroClaim.style.display  = 'none';
    }
  }

  if (typeof currentUser !== 'undefined' && currentUser) {
    applyAuthState(currentUser);
  } else {
    applyAuthState(null);
    // Wait for Firebase auth to resolve (first page load)
    firebase.auth().onAuthStateChanged(function(user) {
      applyAuthState(user);
    });
  }
}

function updateCashbackEstimate() {
  const amt     = parseFloat(document.getElementById('cb-amount').value) || 0;
  const type    = (document.getElementById('cb-type').value) || '';
  const rate    = CASHBACK_RATES[type] || 0;
  const est     = document.getElementById('cb-estimate');
  if (!est) return;
  if (!amt || !type) {
    est.textContent = 'Fill in the category and amount above to see your estimated cashback.';
  } else {
    const cashback = (amt * rate).toFixed(2);
    est.innerHTML = `Based on a €${amt.toFixed(2)} ${type} booking → <strong style="color:#15803d;">you may earn approximately €${cashback} cashback</strong>. Final amount confirmed after verification.`;
  }
}

function submitCashbackClaim() {
  const user = (typeof currentUser !== 'undefined') ? currentUser : firebase.auth().currentUser;
  if (!user) { openAuthModal('login'); return; }

  const type    = document.getElementById('cb-type').value;
  const partner = document.getElementById('cb-partner').value;
  const ref     = document.getElementById('cb-ref').value.trim();
  const amount  = parseFloat(document.getElementById('cb-amount').value);
  const date    = document.getElementById('cb-date').value;
  const notes   = document.getElementById('cb-notes').value.trim();
  const msg     = document.getElementById('cb-submit-msg');

  if (!type || !partner || !ref || !amount || !date) {
    showCashbackMsg(msg, '⚠️ Please fill in all required fields.', '#fef3c7', '#92400e');
    return;
  }
  if (amount < 1) {
    showCashbackMsg(msg, '⚠️ Booking amount must be at least €1.', '#fef3c7', '#92400e');
    return;
  }

  const rate     = CASHBACK_RATES[type] || 0;
  const cashback = parseFloat((amount * rate).toFixed(2));

  const btn = document.querySelector('#cb-claim-section button[onclick="submitCashbackClaim()"]');
  if (btn) { btn.disabled = true; btn.textContent = 'Submitting…'; }

  db.collection('cashback_claims').add({
    userId:          user.uid,
    userEmail:       user.email,
    type:            type,
    partner:         partner,
    bookingRef:      ref,
    bookingAmount:   amount,
    cashbackRate:    rate,
    cashbackAmount:  cashback,
    bookingDate:     date,
    notes:           notes,
    status:          'pending',
    submittedAt:     firebase.firestore.FieldValue.serverTimestamp()
  }).then(function() {
    showCashbackMsg(msg,
      '✅ Claim submitted! We\'ll verify your booking and credit €' + cashback.toFixed(2) + ' within 30 days.',
      '#f0fdf4', '#15803d'
    );
    // Clear form
    ['cb-type','cb-partner','cb-ref','cb-amount','cb-date','cb-notes'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    document.getElementById('cb-estimate').textContent = 'Fill in the category and amount above to see your estimated cashback.';
    loadUserCashbackBalance();
  }).catch(function(err) {
    showCashbackMsg(msg, '❌ Error submitting claim: ' + err.message, '#fef2f2', '#991b1b');
  }).finally(function() {
    if (btn) { btn.disabled = false; btn.textContent = 'Submit Cashback Claim 💰'; }
  });
}

function showCashbackMsg(el, text, bg, color) {
  if (!el) return;
  el.style.display    = 'block';
  el.style.background = bg;
  el.style.color      = color;
  el.style.padding    = '12px 16px';
  el.style.borderRadius = '10px';
  el.style.marginTop  = '12px';
  el.style.fontWeight = '600';
  el.style.fontSize   = '.88rem';
  el.textContent      = text;
}

function loadUserCashbackBalance() {
  const user = (typeof currentUser !== 'undefined') ? currentUser : firebase.auth().currentUser;
  if (!user) return;
  const balSec = document.getElementById('cb-balance-section');
  if (!balSec) return;
  balSec.style.display = 'block';

  db.collection('cashback_claims')
    .where('userId', '==', user.uid)
    .orderBy('submittedAt', 'desc')
    .get()
    .then(function(snap) {
      let pending   = 0;
      let confirmed = 0;
      let paid      = 0;
      const claims  = [];

      snap.forEach(function(doc) {
        const d = doc.data();
        claims.push(d);
        if (d.status === 'pending')   pending   += d.cashbackAmount || 0;
        if (d.status === 'confirmed') confirmed += d.cashbackAmount || 0;
        if (d.status === 'paid')      paid      += d.cashbackAmount || 0;
      });

      document.getElementById('cb-bal-pending').textContent   = '€' + pending.toFixed(2);
      document.getElementById('cb-bal-confirmed').textContent = '€' + confirmed.toFixed(2);
      document.getElementById('cb-bal-paid').textContent      = '€' + paid.toFixed(2);

      // Show payout button if confirmed ≥ €10
      const payBtn = document.getElementById('cb-payout-btn');
      if (payBtn) payBtn.style.display = confirmed >= 10 ? 'inline-block' : 'none';

      // Render recent claims list
      const listEl = document.getElementById('cb-claims-list');
      if (listEl) {
        if (!claims.length) {
          listEl.innerHTML = '<p style="color:#94a3b8;font-size:.85rem;text-align:center;margin:0 0 8px;">No cashback claims yet. Book through our partners above and submit your first claim!</p>';
        } else {
          listEl.innerHTML = '<div style="font-size:.78rem;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px;">Recent Claims</div>' +
            claims.slice(0, 8).map(function(d) {
              const statusColor = d.status === 'confirmed' ? '#34d399' : d.status === 'paid' ? '#60a5fa' : '#fbbf24';
              const dt = d.bookingDate || '';
              return '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.08);">' +
                '<div>' +
                  '<div style="font-size:.85rem;font-weight:600;color:#f8fafc;">' + (d.partner || '') + ' — ' + (d.type || '') + '</div>' +
                  '<div style="font-size:.75rem;color:#94a3b8;">' + d.bookingRef + (dt ? ' · ' + dt : '') + '</div>' +
                '</div>' +
                '<div style="text-align:right;">' +
                  '<div style="font-size:.95rem;font-weight:800;color:#34d399;">+€' + (d.cashbackAmount||0).toFixed(2) + '</div>' +
                  '<div style="font-size:.7rem;font-weight:700;color:' + statusColor + ';text-transform:uppercase;">' + (d.status||'pending') + '</div>' +
                '</div>' +
              '</div>';
            }).join('');
        }
      }
    })
    .catch(function(err) { console.warn('Cashback balance error:', err); });
}

function requestCashbackPayout() {
  const user = (typeof currentUser !== 'undefined') ? currentUser : firebase.auth().currentUser;
  if (!user) return;
  const confirmed = parseFloat(document.getElementById('cb-bal-confirmed').textContent.replace('€','')) || 0;
  if (confirmed < 10) { alert('You need at least €10 in confirmed cashback to request a payout.'); return; }

  if (!confirm('Request a payout of €' + confirmed.toFixed(2) + ' to the email ' + user.email + '?\n\nWe will contact you within 5 business days to arrange payment (PayPal or SEPA bank transfer).')) return;

  db.collection('cashback_payouts').add({
    userId:    user.uid,
    userEmail: user.email,
    amount:    confirmed,
    status:    'requested',
    requestedAt: firebase.firestore.FieldValue.serverTimestamp()
  }).then(function() {
    alert('✅ Payout request submitted! We will contact you at ' + user.email + ' within 5 business days.');
    document.getElementById('cb-payout-btn').style.display = 'none';
  }).catch(function(err) {
    alert('Error requesting payout: ' + err.message);
  });
}

// Hook into showPage to load cashback data when navigating there
const _origShowPage = showPage;
showPage = function(pageId) {
  _origShowPage(pageId);
  if (pageId === 'cashback') loadCashbackPage();
};

// ── Admin: load & manage cashback claims ─────────────────────────
function loadAdminCashbackClaims() {
  var loading   = document.getElementById('cb-admin-loading');
  var tableWrap = document.getElementById('cb-admin-table-wrap');
  var empty     = document.getElementById('cb-admin-empty');
  var tbody     = document.getElementById('cb-admin-table-body');
  if (!loading) return;
  loading.style.display = 'block';
  if (tableWrap) tableWrap.style.display = 'none';
  if (empty)     empty.style.display     = 'none';

  db.collection('cashback_claims').orderBy('submittedAt','desc').limit(200).get()
    .then(function(snap) {
      loading.style.display = 'none';
      var pendingCount=0, pendingEur=0, confirmedCount=0, paidEur=0, rows=[];
      snap.forEach(function(doc) {
        var d=doc.data(); d._id=doc.id;
        if (d.status==='pending')   { pendingCount++;   pendingEur   +=d.cashbackAmount||0; }
        if (d.status==='confirmed') { confirmedCount++; }
        if (d.status==='paid')      { paidEur +=d.cashbackAmount||0; }
        rows.push(d);
      });
      var el; 
      if ((el=document.getElementById('cb-admin-pending-count')))   el.textContent = pendingCount;
      if ((el=document.getElementById('cb-admin-pending-eur')))     el.textContent = '€'+pendingEur.toFixed(2);
      if ((el=document.getElementById('cb-admin-confirmed-count'))) el.textContent = confirmedCount;
      if ((el=document.getElementById('cb-admin-paid-eur')))        el.textContent = '€'+paidEur.toFixed(2);

      if (!rows.length) { if (empty) empty.style.display='block'; return; }
      if (tableWrap) tableWrap.style.display='block';
      if (tbody) {
        tbody.innerHTML = rows.map(function(d) {
          var sc  = d.status==='confirmed'?'#15803d':d.status==='paid'?'#1d4ed8':'#b45309';
          var sbg = d.status==='confirmed'?'#f0fdf4':d.status==='paid'?'#eff6ff':'#fffbeb';
          var acts = (d.status==='pending')
            ? '<button onclick="approveCashbackClaim(\''+d._id+'\',this)" style="background:#15803d;color:#fff;border:none;padding:5px 10px;border-radius:6px;font-size:.75rem;cursor:pointer;margin-right:4px;">✔ Approve</button>'
            + '<button onclick="rejectCashbackClaim(\''+d._id+'\',this)"  style="background:#dc2626;color:#fff;border:none;padding:5px 10px;border-radius:6px;font-size:.75rem;cursor:pointer;">✗ Reject</button>'
            : '—';
          return '<tr>'
            +'<td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;font-size:.8rem;color:#64748b;">'+(d.userEmail||'—')+'</td>'
            +'<td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;"><strong>'+(d.type||'—')+'</strong><br><span style="font-size:.75rem;color:#64748b;">'+(d.partner||'—')+'</span></td>'
            +'<td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;font-family:monospace;font-size:.82rem;">'+(d.bookingRef||'—')+'</td>'
            +'<td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;">€'+(d.bookingAmount||0).toFixed(2)+'</td>'
            +'<td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;font-weight:800;color:#15803d;">€'+(d.cashbackAmount||0).toFixed(2)+'</td>'
            +'<td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;font-size:.8rem;">'+(d.bookingDate||'—')+'</td>'
            +'<td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;"><span style="background:'+sbg+';color:'+sc+';font-size:.72rem;font-weight:700;padding:3px 9px;border-radius:20px;text-transform:uppercase;">'+(d.status||'pending')+'</span></td>'
            +'<td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;">'+acts+'</td>'
            +'</tr>';
        }).join('');
      }
    }).catch(function(err) {
      if (loading) { loading.style.display='block'; loading.textContent='Error: '+err.message; }
    });
}


// ── Admin: load newsletter subscribers ───────────────────────
function loadAdminNewsletter() {
  var loading  = document.getElementById('nl-admin-loading');
  var tableWrap= document.getElementById('nl-admin-table-wrap');
  var empty    = document.getElementById('nl-admin-empty');
  var tbody    = document.getElementById('nl-admin-table-body');
  var countEl  = document.getElementById('nl-admin-count');
  if (!loading) return;
  loading.style.display = 'block';
  if (tableWrap) tableWrap.style.display = 'none';
  if (empty) empty.style.display = 'none';

  db.collection('newsletter_subscribers').orderBy('subscribedAt','desc').get()
    .then(function(snap) {
      loading.style.display = 'none';
      var rows = [];
      snap.forEach(function(doc) {
        var d = doc.data(); d._id = doc.id;
        rows.push(d);
      });
      if (countEl) countEl.textContent = rows.length + ' subscriber' + (rows.length !== 1 ? 's' : '');
      if (!rows.length) { if (empty) empty.style.display = 'block'; return; }
      if (tableWrap) tableWrap.style.display = 'block';
      if (tbody) {
        tbody.innerHTML = rows.map(function(d) {
          var date = d.subscribedAt && d.subscribedAt.toDate
            ? d.subscribedAt.toDate().toLocaleDateString('en-GB', {day:'numeric',month:'short',year:'numeric'})
            : '—';
          var sc  = d.status === 'active' ? '#15803d' : '#dc2626';
          var sbg = d.status === 'active' ? '#f0fdf4' : '#fee2e2';
          return '<tr>'
            + '<td style="padding:10px 14px;border-bottom:1px solid #f1f5f9;font-weight:600;">' + (d.email||'—') + '</td>'
            + '<td style="padding:10px 14px;border-bottom:1px solid #f1f5f9;font-size:.8rem;color:#64748b;">' + (d.source||'homepage') + '</td>'
            + '<td style="padding:10px 14px;border-bottom:1px solid #f1f5f9;font-size:.82rem;">' + date + '</td>'
            + '<td style="padding:10px 14px;border-bottom:1px solid #f1f5f9;"><span style="background:'+sbg+';color:'+sc+';font-size:.72rem;font-weight:700;padding:3px 10px;border-radius:20px;text-transform:uppercase;">' + (d.status||'active') + '</span></td>'
            + '</tr>';
        }).join('');
      }
    }).catch(function(err) {
      if (loading) { loading.style.display = 'block'; loading.textContent = 'Error: ' + err.message; }
    });
}

function approveCashbackClaim(docId, btn) {
  if (!confirm('Approve this cashback claim?')) return;
  if (btn) { btn.disabled=true; btn.textContent='Saving…'; }
  db.collection('cashback_claims').doc(docId)
    .update({status:'confirmed', reviewedAt: firebase.firestore.FieldValue.serverTimestamp()})
    .then(function() { loadAdminCashbackClaims(); })
    .catch(function(e) { alert('Error: '+e.message); if (btn) { btn.disabled=false; btn.textContent='✔ Approve'; } });
}

function rejectCashbackClaim(docId, btn) {
  if (!confirm('Reject this claim?')) return;
  if (btn) { btn.disabled=true; btn.textContent='Saving…'; }
  db.collection('cashback_claims').doc(docId)
    .update({status:'rejected', reviewedAt: firebase.firestore.FieldValue.serverTimestamp()})
    .then(function() { loadAdminCashbackClaims(); })
    .catch(function(e) { alert('Error: '+e.message); if (btn) { btn.disabled=false; btn.textContent='✗ Reject'; } });
}
