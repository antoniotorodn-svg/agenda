// Tests unitarios del proxy iCal (api/ical.js)
const handler = require('../api/ical.js');

function mockRes() {
    const res = { statusCode: null, headers: {}, body: null };
    res.status = c => { res.statusCode = c; return res; };
    res.send = b => { res.body = b; return res; };
    res.setHeader = (k, v) => { res.headers[k] = v; };
    return res;
}

const realFetch = global.fetch;
let fetchCalls = [];
global.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return { ok: true, status: 200, text: async () => 'BEGIN:VCALENDAR\nEND:VCALENDAR' };
};

const cases = [
    // [nombre, url, esperaStatus, esperaFetch]
    ['URL vacía → 400', '', 400, false],
    ['URL inválida → 400', 'no-es-una-url', 400, false],
    ['http (no https) → 400', 'http://admin.booking.com/ical.ics', 400, false],
    ['dominio ajeno → 400', 'https://evil.com/ical.ics', 400, false],
    ['sufijo falso evilbooking.com → 400', 'https://evilbooking.com/ical.ics', 400, false],
    ['booking.com.evil.com → 400', 'https://booking.com.evil.com/x.ics', 400, false],
    ['userinfo trampa → 400', 'https://booking.com@evil.com/x.ics', 400, false],
    ['booking.com raíz → 200', 'https://booking.com/ical.ics?t=abc', 200, true],
    ['subdominio admin.booking.com → 200', 'https://admin.booking.com/hotel/ical.html?t=tok', 200, true],
];

(async () => {
    let fail = 0;
    for (const [name, url, expStatus, expFetch] of cases) {
        fetchCalls = [];
        const res = mockRes();
        await handler({ query: { url } }, res);
        const okStatus = res.statusCode === expStatus;
        const okFetch = (fetchCalls.length > 0) === expFetch;
        if (okStatus && okFetch) console.log('PASS  ' + name);
        else { fail++; console.log(`FAIL  ${name} — status=${res.statusCode} (esperado ${expStatus}), fetch=${fetchCalls.length > 0}`); }
    }
    // Upstream con error → 502 y no cachear
    {
        global.fetch = async () => ({ ok: false, status: 500 });
        const res = mockRes();
        await handler({ query: { url: 'https://admin.booking.com/x.ics' } }, res);
        if (res.statusCode === 502) console.log('PASS  upstream 500 → 502');
        else { fail++; console.log('FAIL  upstream 500 → esperado 502, fue ' + res.statusCode); }
    }
    // Excepción de red → 502
    {
        global.fetch = async () => { throw new Error('boom'); };
        const res = mockRes();
        await handler({ query: { url: 'https://admin.booking.com/x.ics' } }, res);
        if (res.statusCode === 502) console.log('PASS  error de red → 502');
        else { fail++; console.log('FAIL  error de red → esperado 502, fue ' + res.statusCode); }
    }
    // Respuesta correcta reenvía el texto y marca no-store
    {
        global.fetch = async () => ({ ok: true, status: 200, text: async () => 'BEGIN:VCALENDAR' });
        const res = mockRes();
        await handler({ query: { url: 'https://admin.booking.com/x.ics' } }, res);
        if (res.body === 'BEGIN:VCALENDAR' && res.headers['Cache-Control'] === 'no-store') console.log('PASS  reenvía texto + no-store');
        else { fail++; console.log('FAIL  reenvío: ' + JSON.stringify(res)); }
    }
    global.fetch = realFetch;
    console.log(fail === 0 ? '\nAPI iCal: todos los tests PASS' : `\nAPI iCal: ${fail} fallos`);
    process.exit(fail ? 1 : 0);
})();
