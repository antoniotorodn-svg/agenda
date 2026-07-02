// Proxy para los calendarios iCal de Booking.com.
// El navegador no puede leerlos directamente (CORS) y la URL contiene un
// token secreto, así que se descarga desde aquí en vez de usar proxys de
// terceros. Solo se permiten URLs de booking.com para no ser un proxy abierto.
module.exports = async (req, res) => {
    const url = (req.query && req.query.url) || '';
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        res.status(400).send('URL invalida');
        return;
    }
    if (parsed.protocol !== 'https:' || !/(^|\.)booking\.com$/.test(parsed.hostname)) {
        res.status(400).send('Solo se permiten URLs iCal de booking.com');
        return;
    }
    try {
        const upstream = await fetch(parsed.toString(), {
            headers: { 'User-Agent': 'HostalJijones-Agenda/1.0' }
        });
        if (!upstream.ok) {
            res.status(502).send('Booking.com respondio ' + upstream.status);
            return;
        }
        const text = await upstream.text();
        res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.status(200).send(text);
    } catch {
        res.status(502).send('No se pudo obtener el iCal');
    }
};
