// Suite de tests automáticos para la agenda del Hostal Jijones.
// Ejecuta tests unitarios (lógica interna vía page.evaluate) y E2E (flujos UI).
const { chromium } = require('playwright');

const BASE = 'http://127.0.0.1:8123/index.html';
const results = [];
let browser;

function today(offsetDays = 0) {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

async function newAppPage(seedFn) {
    const context = await browser.newContext();
    await context.route(/fonts\.googleapis\.com|fonts\.gstatic\.com|player\.vimeo\.com/, r => r.abort());
    const page = await context.newPage();
    page.on('dialog', d => d.accept());
    page.on('pageerror', err => { page.__errors = page.__errors || []; page.__errors.push(String(err)); });
    // Evita la descarga automática de backup diario y stubs de descargas
    await page.addInitScript(() => {
        try {
            localStorage.setItem('hostal_jijones_last_backup', new Date().toISOString().slice(0, 10));
            localStorage.setItem('hostal_jijones_last_ical_sync', new Date().toISOString().slice(0, 10));
        } catch {}
        window.__downloads = [];
        const origCreate = URL.createObjectURL.bind(URL);
        URL.createObjectURL = blob => {
            if (blob && blob.text) blob.text().then(t => window.__downloads.push(t));
            return origCreate(blob);
        };
        HTMLAnchorElement.prototype.click = function () { /* no descargar de verdad */ };
    });
    if (seedFn) await page.addInitScript(seedFn);
    await page.goto(BASE);
    return { context, page };
}

async function login(page, user = 'ricardo', pin = '2601') {
    await page.click('#uc_' + user);
    await page.fill('#pinInput', pin);
    await page.waitForSelector('#loginScreen.hidden', { state: 'attached', timeout: 5000 });
    await page.waitForSelector('#bookingGrid tbody tr');
}

async function test(name, fn) {
    let ctx;
    try {
        ctx = await newAppPage();
        await fn(ctx.page);
        results.push({ name, ok: true });
        console.log('PASS  ' + name);
    } catch (e) {
        results.push({ name, ok: false, error: e.message });
        console.log('FAIL  ' + name + '\n      ' + e.message.split('\n')[0]);
    } finally {
        if (ctx) await ctx.context.close();
    }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// Crea una reserva directamente sobre el estado interno (rápido, para preparar escenarios)
const mkBooking = (room, checkin, checkout, extra = {}) => ({
    room, checkin, checkout,
    id: 'b_test_' + Math.random().toString(36).slice(2, 8),
    guestName: extra.guestName || 'Test Guest',
    status: 'confirmed', pricePerNight: 48,
    totalPrice: extra.totalPrice, roomTotal: extra.roomTotal,
    payments: extra.payments || [],
    paymentStatus: extra.paymentStatus || 'pending_payment',
    ...extra
});

(async () => {
    browser = await chromium.launch();

    // ============ UNIT: helpers de fechas ============
    await test('U1 fechas: dateStr/parseDate ida y vuelta (incl. DST)', async page => {
        await login(page);
        const r = await page.evaluate(() => {
            const days = ['2026-03-29', '2026-10-25', '2026-01-01', '2026-12-31', '2024-02-29'];
            return days.map(s => dateStr(parseDate(s)));
        });
        assert(JSON.stringify(r) === JSON.stringify(['2026-03-29', '2026-10-25', '2026-01-01', '2026-12-31', '2024-02-29']), 'roundtrip: ' + r);
    });

    await test('U2 fechas: nightsBetween y addDays a través de cambios de hora', async page => {
        await login(page);
        const r = await page.evaluate(() => [
            nightsBetween('2026-03-28', '2026-03-30'), // DST primavera (España)
            nightsBetween('2026-10-24', '2026-10-26'), // DST otoño
            nightsBetween('2026-07-01', '2026-07-02'),
            dateStr(addDays(parseDate('2026-03-29'), 1)),
        ]);
        assert(r[0] === 2 && r[1] === 2 && r[2] === 1 && r[3] === '2026-03-30', JSON.stringify(r));
    });

    await test('U3 conflictos: solapes y reservas contiguas', async page => {
        await login(page);
        const r = await page.evaluate(() => {
            bookings = [{ id: 'x', room: 101, checkin: '2026-08-10', checkout: '2026-08-15' }];
            blocks = [];
            return {
                overlap: hasConflict(101, '2026-08-12', '2026-08-14', null, null),
                contiguousAfter: hasConflict(101, '2026-08-15', '2026-08-16', null, null),
                contiguousBefore: hasConflict(101, '2026-08-08', '2026-08-10', null, null),
                otherRoom: hasConflict(102, '2026-08-12', '2026-08-14', null, null),
                stringRoom: hasConflict('101', '2026-08-12', '2026-08-14', null, null),
                excluded: hasConflict(101, '2026-08-12', '2026-08-14', 'x', null),
            };
        });
        assert(r.overlap === true, 'solape no detectado');
        assert(r.contiguousAfter === false && r.contiguousBefore === false, 'contiguas no deben chocar');
        assert(r.otherRoom === false, 'otra habitación no debe chocar');
        assert(r.stringRoom === true, 'comparación string/number de habitación');
        assert(r.excluded === false, 'excludeId no funciona');
    });

    await test('U4 conflictos: bloqueos cuentan como ocupación', async page => {
        await login(page);
        const r = await page.evaluate(() => {
            bookings = [];
            blocks = [{ id: 'bl1', room: 101, from: '2026-08-10', to: '2026-08-15' }];
            return {
                overBlock: isRoomAvailable(101, '2026-08-12', '2026-08-13'),
                after: isRoomAvailable(101, '2026-08-15', '2026-08-16'),
            };
        });
        assert(r.overBlock === false && r.after === true, JSON.stringify(r));
    });

    await test('U5 getWeekKey: semanas ISO en límites de año', async page => {
        await login(page);
        const r = await page.evaluate(() => [
            getWeekKey(parseDate('2026-01-01')), // jueves -> 2026-W01
            getWeekKey(parseDate('2024-12-30')), // lunes -> 2025-W01
            getWeekKey(parseDate('2027-01-01')), // viernes -> 2026-W53
        ]);
        assert(r[0] === '2026-W01', 'esperado 2026-W01, got ' + r[0]);
        assert(r[1] === '2025-W01', 'esperado 2025-W01, got ' + r[1]);
        assert(r[2] === '2026-W53', 'esperado 2026-W53, got ' + r[2]);
    });

    await test('U6 getNationalityCode: mapeos y desconocidos', async page => {
        await login(page);
        const r = await page.evaluate(() => [
            getNationalityCode('España'), getNationalityCode('  FRANCIA '), getNationalityCode('fr'),
            getNationalityCode(''), getNationalityCode('Klingon'), getNationalityCode('GB'),
        ]);
        assert(JSON.stringify(r) === JSON.stringify(['ES', 'FR', 'FR', 'UNKNOWN', 'OTHER', 'GB']), JSON.stringify(r));
    });

    await test('U7 parseICalDate: formatos DATE y DATETIME', async page => {
        await login(page);
        const r = await page.evaluate(() => [
            parseICalDate('20260403'), parseICalDate('20260403T140000'), parseICalDate('20260403T140000Z'), parseICalDate('bad'),
        ]);
        assert(r[0] === '2026-04-03' && r[1] === '2026-04-03' && r[2] === '2026-04-03' && r[3] === null, JSON.stringify(r));
    });

    await test('U8 facturas: numeración secuencial y huecos por importación', async page => {
        await login(page);
        const r = await page.evaluate(() => {
            localStorage.removeItem('hostal_jijones_invoice_seq');
            const y = new Date().getFullYear();
            const a = nextInvoiceNumber([]);
            const b = nextInvoiceNumber([]);
            // Simular importación con número más alto
            localStorage.removeItem('hostal_jijones_invoice_seq');
            const c = nextInvoiceNumber([{ invoiceNum: 'F-' + y + '-0042' }]);
            return { a, b, c, y };
        });
        assert(r.a === `F-${r.y}-0001`, 'primera: ' + r.a);
        assert(r.b === `F-${r.y}-0002`, 'segunda: ' + r.b);
        assert(r.c === `F-${r.y}-0043`, 'tras importación: ' + r.c);
    });

    await test('U9 escapeHtml neutraliza HTML', async page => {
        await login(page);
        const r = await page.evaluate(() => escapeHtml('<img src=x onerror=alert(1)> "q" & co'));
        assert(!r.includes('<img'), r);
        assert(r.includes('&lt;img') && r.includes('&quot;q&quot;') && r.includes('&amp;'), r);
    });

    // ============ E2E: login ============
    await test('E1 login: PIN incorrecto muestra error, correcto entra', async page => {
        await page.click('#uc_ricardo');
        await page.fill('#pinInput', '0000');
        const err = await page.textContent('#loginError');
        assert(err.includes('PIN incorrecto'), 'sin mensaje de error');
        await page.fill('#pinInput', '2601');
        await page.waitForSelector('#loginScreen.hidden', { state: 'attached' });
        const rows = await page.locator('#bookingGrid tbody tr:not(.floor-separator)').count();
        assert(rows === 30, 'esperaba 30 habitaciones de hostal, hay ' + rows);
        assert(!(page.__errors || []).length, 'errores JS: ' + (page.__errors || []).join('; '));
    });

    // ============ E2E: crear reserva desde la cuadrícula ============
    await test('E2 crear reserva: clic en celda, guardar, aparece en cuadrícula y localStorage', async page => {
        await login(page);
        const d = today(2);
        await page.click(`td.day-cell[data-room="103"][data-date="${d}"]`);
        await page.waitForSelector('#bookingModal.active');
        // La habitación pedida debe respetarse
        const room = await page.inputValue('#bookingRoom');
        assert(room === '103', 'habitación preseleccionada: ' + room);
        await page.fill('#guestName', 'María Pérez');
        await page.click('text=Guardar Reserva');
        await page.waitForSelector('#bookingModal:not(.active)', { state: 'attached' });
        const cell = page.locator(`td.day-cell[data-room="103"][data-date="${d}"] .booking-block`);
        assert((await cell.textContent()).includes('María'), 'no aparece en la celda');
        const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('hostal_jijones_bookings')));
        assert(stored.length === 1 && stored[0].guestName === 'María Pérez', 'no persistida');
        assert(stored[0].totalPrice === 48, 'total congelado esperado 48, es ' + stored[0].totalPrice);
        // Cliente auto-creado
        const cust = await page.evaluate(() => customers.length);
        assert(cust === 1, 'cliente no creado');
    });

    await test('E3 conflicto: no deja guardar dos reservas solapadas en la misma habitación', async page => {
        await login(page);
        const ci = today(3), co = today(5);
        await page.evaluate(([ci, co]) => {
            bookings.push({ id: 'b1', room: 104, checkin: ci, checkout: co, guestName: 'Ocupante', status: 'confirmed', pricePerNight: 48, payments: [] });
            saveBookings(); renderGrid();
        }, [ci, co]);
        // Abrir en un día libre y extender el checkout por encima de la reserva existente
        await page.evaluate(([d]) => openNewBooking(104, d), [today(2)]);
        await page.fill('#guestName', 'Intruso');
        await page.fill('#bookingCheckout', today(4));
        await page.click('text=Guardar Reserva');
        await page.waitForSelector('.toast');
        const toast = await page.textContent('.toast');
        assert(toast.includes('ocupada'), 'sin aviso de conflicto: ' + toast);
        const n = await page.evaluate(() => bookings.length);
        assert(n === 1, 'la reserva en conflicto se guardó igualmente');
    });

    await test('E4 reservas contiguas (checkout = checkin) sí se permiten', async page => {
        await login(page);
        const ci = today(3), co = today(5), co2 = today(7);
        await page.evaluate(([ci, co]) => {
            bookings.push({ id: 'b1', room: 105, checkin: ci, checkout: co, guestName: 'Primero', status: 'confirmed', pricePerNight: 48, payments: [] });
            saveBookings(); renderGrid();
        }, [ci, co]);
        await page.evaluate(([co, co2]) => { openNewBooking(105, co, co2); }, [co, co2]);
        await page.fill('#guestName', 'Segundo');
        await page.click('text=Guardar Reserva');
        await page.waitForSelector('#bookingModal:not(.active)', { state: 'attached' });
        const n = await page.evaluate(() => bookings.length);
        assert(n === 2, 'la reserva contigua no se guardó');
    });

    // ============ E2E: reserva multi-habitación ============
    await test('E5 multi-habitación: crea hijas, no duplica ingresos ni contadores', async page => {
        await login(page);
        await page.evaluate(([ci]) => openNewBooking(101, ci), [today(10)]);
        await page.fill('#guestName', 'Grupo Familia');
        await page.selectOption('#roomCount', '2');
        await page.click('text=Guardar Reserva');
        await page.waitForSelector('#bookingModal:not(.active)', { state: 'attached' });
        const r = await page.evaluate(() => {
            const mains = mainBookings();
            const total = mains.reduce((s, b) => s + getBookingFrozenTotal(b), 0);
            return {
                total, nBookings: bookings.length, nMains: mains.length,
                child: bookings.find(b => b.groupChild) || null,
                mainExtra: mains[0].extraRooms.length,
            };
        });
        assert(r.nBookings === 2, 'esperaba principal + hija, hay ' + r.nBookings);
        assert(r.nMains === 1, 'los contadores dobles: mains=' + r.nMains);
        assert(r.child && r.child.payments.length === 0, 'la hija no debe llevar pagos');
        assert(r.mainExtra === 1, 'extraRooms de la principal');
        assert(r.total === 96, 'total del grupo esperado 96 (2 hab × 48), es ' + r.total);
        // Las estadísticas cuentan 1 reserva
        const stats = await page.textContent('#statsBar');
        assert(stats.includes('Total reservas: 1') || /Total reservas:\s*<strong>1/.test(await page.innerHTML('#statsBar')), 'stats cuentan mal');
    });

    // ============ E2E: editar ============
    await test('E6 editar reserva: cambios persisten y editar hija abre la principal', async page => {
        await login(page);
        await page.evaluate(([ci]) => openNewBooking(101, ci), [today(10)]);
        await page.fill('#guestName', 'Grupo Editable');
        await page.selectOption('#roomCount', '2');
        await page.click('text=Guardar Reserva');
        await page.waitForSelector('#bookingModal:not(.active)', { state: 'attached' });
        // Editar a través de la reserva hija
        await page.evaluate(() => {
            const child = bookings.find(b => b.groupChild);
            editBooking(child.id);
        });
        await page.waitForSelector('#bookingModal.active');
        const title = await page.textContent('#modalTitle');
        assert(title === 'Editar Reserva', title);
        const editingId = await page.inputValue('#bookingId');
        const mainId = await page.evaluate(() => bookings.find(b => !b.groupChild).id);
        assert(editingId === mainId, 'editar la hija no redirige a la principal');
        await page.fill('#guestName', 'Grupo Renombrado');
        await page.click('text=Guardar Reserva');
        await page.waitForSelector('#bookingModal:not(.active)', { state: 'attached' });
        const names = await page.evaluate(() => bookings.map(b => b.guestName));
        assert(names.every(n => n === 'Grupo Renombrado'), 'no se renombraron todas: ' + names);
        const n = await page.evaluate(() => bookings.length);
        assert(n === 2, 'editar duplicó reservas: ' + n);
    });

    // ============ E2E: cancelar y restaurar ============
    await test('E7 cancelar → papelera → restaurar (y bloqueo si hay conflicto)', async page => {
        await login(page);
        const ci = today(4), co = today(6);
        await page.evaluate(([ci, co]) => {
            bookings.push({ id: 'b1', room: 106, checkin: ci, checkout: co, guestName: 'Cancelable', status: 'confirmed', pricePerNight: 48, payments: [] });
            saveBookings(); renderGrid();
        }, [ci, co]);
        await page.evaluate(() => editBooking('b1'));
        await page.click('#deleteBtn'); // confirm auto-aceptado
        await page.waitForSelector('#bookingModal:not(.active)', { state: 'attached' });
        let r = await page.evaluate(() => ({ n: bookings.length, trash: loadTrash().length }));
        assert(r.n === 0 && r.trash === 1, 'no fue a la papelera: ' + JSON.stringify(r));
        // Restaurar
        await page.evaluate(() => restoreCancelledBooking(loadTrash()[0].id));
        r = await page.evaluate(() => ({ n: bookings.length, trash: loadTrash().length }));
        assert(r.n === 1 && r.trash === 0, 'no se restauró: ' + JSON.stringify(r));
        // Cancelar de nuevo, ocupar la habitación y comprobar que NO se puede restaurar
        await page.evaluate(() => editBooking('b1'));
        await page.click('#deleteBtn');
        await page.waitForSelector('#bookingModal:not(.active)', { state: 'attached' });
        await page.evaluate(([ci, co]) => {
            bookings.push({ id: 'b2', room: 106, checkin: ci, checkout: co, guestName: 'Nuevo Ocupante', status: 'confirmed', pricePerNight: 48, payments: [] });
            saveBookings();
            restoreCancelledBooking(loadTrash()[0].id);
        }, [ci, co]);
        r = await page.evaluate(() => ({ n: bookings.length, trash: loadTrash().length }));
        assert(r.n === 1 && r.trash === 1, 'restauró sobre una habitación ocupada: ' + JSON.stringify(r));
    });

    // ============ E2E: bloqueos ============
    await test('E8 bloqueos: crear bloqueo impide reservar y viceversa', async page => {
        await login(page);
        const ci = today(8), co = today(10);
        await page.evaluate(() => openBlockModal());
        await page.selectOption('#blockRoom', '108');
        await page.fill('#blockFrom', ci);
        await page.fill('#blockTo', co);
        await page.click('text=Guardar Bloqueo');
        await page.waitForSelector('#blockModal:not(.active)', { state: 'attached' });
        let n = await page.evaluate(() => blocks.length);
        assert(n === 1, 'bloqueo no guardado');
        // Reservar encima debe fallar (abrimos en día libre y extendemos sobre el bloqueo)
        await page.evaluate(([d]) => openNewBooking(108, d), [today(7)]);
        await page.fill('#guestName', 'Sobre Bloqueo');
        await page.fill('#bookingCheckout', today(9));
        await page.click('text=Guardar Reserva');
        await page.waitForSelector('.toast');
        n = await page.evaluate(() => bookings.length);
        assert(n === 0, 'permitió reservar sobre un bloqueo');
        await page.evaluate(() => closeModal());
        // Bloquear sobre una reserva debe fallar
        await page.evaluate(([ci, co]) => {
            bookings.push({ id: 'b1', room: 109, checkin: ci, checkout: co, guestName: 'X', status: 'confirmed', pricePerNight: 48, payments: [] });
            saveBookings();
            openBlockModal();
        }, [ci, co]);
        await page.selectOption('#blockRoom', '109');
        await page.fill('#blockFrom', ci);
        await page.fill('#blockTo', co);
        await page.click('text=Guardar Bloqueo');
        n = await page.evaluate(() => blocks.length);
        assert(n === 1, 'permitió bloquear sobre una reserva');
    });

    // ============ E2E: pagos ============
    await test('E9 pagos: añadir pago completo marca "Pagada" y cuadra la caja', async page => {
        await login(page);
        await page.evaluate(([ci, co]) => openNewBooking(110, ci, co), [today(2), today(4)]); // 2 noches x 48 = 96
        await page.fill('#guestName', 'Pagador');
        await page.click('#bmTabBtn_pagos');
        await page.fill('#paymentAmount', '96');
        await page.click('.btn-add-payment');
        const status = await page.inputValue('#paymentStatus');
        assert(status === 'paid', 'estado tras pago completo: ' + status);
        await page.click('text=Guardar Reserva');
        await page.waitForSelector('#bookingModal:not(.active)', { state: 'attached' });
        const r = await page.evaluate(() => {
            const rows = getCashRows(todayStr());
            return { n: rows.length, amount: rows[0] && rows[0].p.amount, pend: bookingPendingAmount(bookings[0]) };
        });
        assert(r.n === 1 && r.amount === 96 && r.pend === 0, JSON.stringify(r));
    });

    await test('E9b pagos: pago parcial en hostal mantiene "pendiente" y el badge cuenta salidas con deuda', async page => {
        await login(page);
        await page.evaluate(([ci, co]) => {
            bookings.push({ id: 'b1', room: 111, checkin: ci, checkout: co, guestName: 'Debe', status: 'checkedin', pricePerNight: 48, totalPrice: 96, roomTotal: 96, paymentStatus: 'pending_payment', payments: [{ id: 'p1', amount: 40, type: 'partial', method: 'cash', date: ci }] });
            saveBookings(); renderGrid();
        }, [today(-1), today(0)]);
        const badge = await page.textContent('#pendingBadge');
        assert(badge === '1', 'badge de cobros pendientes: "' + badge + '"');
    });

    // ============ E2E: casa rural ============
    await test('E10 casa rural: crear reserva y re-editar conserva 16 huéspedes y fianza', async page => {
        await login(page);
        await page.click('#tabRural');
        const d = today(5);
        await page.click(`td.day-cell[data-room="CR1"][data-date="${d}"]`);
        await page.waitForSelector('#bookingModal.active');
        await page.fill('#guestName', 'Familia Rural');
        const guests = await page.inputValue('#guestCount');
        assert(guests === '16', 'nuevos: huéspedes rural = ' + guests);
        const price = await page.inputValue('#pricePerNight');
        assert(price === '250', 'precio rural por defecto: ' + price);
        await page.click('text=Guardar Reserva');
        await page.waitForSelector('#bookingModal:not(.active)', { state: 'attached' });
        let saved = await page.evaluate(() => bookings[0]);
        assert(saved.guests === 16, 'guardado con ' + saved.guests + ' huéspedes');
        assert(saved.ruralDeposit === 300, 'fianza: ' + saved.ruralDeposit);
        assert(saved.totalPrice === 250, 'total rural: ' + saved.totalPrice);
        // Re-editar y guardar sin tocar nada NO debe cambiar los datos
        await page.evaluate(() => editBooking(bookings[0].id));
        await page.waitForSelector('#bookingModal.active');
        const guests2 = await page.inputValue('#guestCount');
        assert(guests2 === '16', 'al re-editar, huéspedes pasa a ser ' + guests2 + ' (se pierde el 16)');
        await page.click('text=Guardar Reserva');
        await page.waitForSelector('#bookingModal:not(.active)', { state: 'attached' });
        saved = await page.evaluate(() => bookings[0]);
        assert(saved.guests === 16, 're-guardado corrompe huéspedes: ' + saved.guests);
    });

    // ============ E2E: buscador de disponibilidad ============
    await test('E11 buscar disponibilidad: 3 personas encuentra la habitación triple configurada', async page => {
        await login(page);
        // Configurar la 113 como triple
        await page.evaluate(() => setRoomBedType(113, 'triple'));
        await page.evaluate(() => openSearchModal());
        await page.fill('#searchFrom', today(3));
        await page.fill('#searchGuests', '3');
        await page.click('#searchModal .btn-success');
        const resTxt = await page.textContent('#searchResults');
        assert(resTxt.includes('113'), 'la triple 113 no aparece para 3 personas. Resultado: ' + resTxt.trim().slice(0, 120));
    });

    // ============ E2E: mover/intercambiar habitaciones ============
    await test('E12 mover reserva: el intercambio no debe crear solapes ocultos', async page => {
        await login(page);
        const r = await page.evaluate(() => {
            // X en 101 (d+1..d+5), Y en 102 (d+3..d+10), Z en 101 (d+6..d+8)
            const D = n => { const d = new Date(); d.setDate(d.getDate() + n); return dateStr(d); };
            bookings = [
                { id: 'X', room: 101, checkin: D(1), checkout: D(5), guestName: 'X', status: 'confirmed', pricePerNight: 48, payments: [] },
                { id: 'Y', room: 102, checkin: D(3), checkout: D(10), guestName: 'Y', status: 'confirmed', pricePerNight: 48, payments: [] },
                { id: 'Z', room: 101, checkin: D(6), checkout: D(8), guestName: 'Z', status: 'confirmed', pricePerNight: 48, payments: [] },
            ];
            saveBookings(); renderGrid();
            moveBookingToRoom('X', 102, false); // intercambia X<->Y
            // ¿Ha quedado alguna pareja solapada en la misma habitación?
            let overlap = null;
            for (const a of bookings) for (const b of bookings) {
                if (a.id < b.id && String(a.room) === String(b.room) && a.checkin < b.checkout && a.checkout > b.checkin) overlap = a.id + '/' + b.id + ' en ' + a.room;
            }
            return { overlap, rooms: bookings.map(b => b.id + ':' + b.room).join(',') };
        });
        assert(!r.overlap, 'el intercambio creó un solape: ' + r.overlap + ' (' + r.rooms + ')');
    });

    // ============ E2E: wizard ============
    await test('E13 wizard reserva rápida: flujo completo con 2 habitaciones', async page => {
        await login(page);
        await page.click('.fab-btn');
        await page.waitForSelector('#wizardModal.active');
        await page.fill('#wizCheckin', today(15));
        await page.fill('#wizCheckout', today(17));
        await page.click('#wp1 >> text=Siguiente');
        await page.click('#wizRooms2');
        await page.click('#wp2 >> text=Siguiente');
        await page.click('#wp3 >> text=Ver disponibilidad');
        await page.waitForSelector('#wizBookBtn:visible');
        await page.click('#wizBookBtn');
        await page.waitForSelector('#bookingModal.active');
        const count = await page.inputValue('#roomCount');
        assert(count === '2', 'roomCount del formulario: ' + count);
        await page.fill('#guestName', 'Wizard User');
        await page.click('text=Guardar Reserva');
        await page.waitForSelector('#bookingModal:not(.active)', { state: 'attached' });
        const n = await page.evaluate(() => bookings.length);
        assert(n === 2, 'principal + hija esperadas, hay ' + n);
    });

    // ============ E2E: búsqueda global ============
    await test('E14 búsqueda global por nombre y teléfono', async page => {
        await login(page);
        await page.evaluate(([ci, co]) => {
            bookings.push({ id: 'b1', room: 112, checkin: ci, checkout: co, guestName: 'Manolo García', phone: '600111222', status: 'confirmed', pricePerNight: 48, payments: [] });
            saveBookings();
        }, [today(1), today(3)]);
        await page.fill('#globalSearch', 'manolo');
        await page.waitForSelector('#globalSearchResults.active');
        let txt = await page.textContent('#globalSearchResults');
        assert(txt.includes('Manolo García'), 'no encuentra por nombre');
        await page.fill('#globalSearch', '600111');
        txt = await page.textContent('#globalSearchResults');
        assert(txt.includes('Manolo García'), 'no encuentra por teléfono');
    });

    // ============ E2E: facturas ============
    await test('E15 factura: pago con tarjeta genera factura al guardar, sin duplicar en edición', async page => {
        await login(page);
        await page.evaluate(([ci, co]) => openNewBooking(114, ci, co), [today(2), today(3)]);
        await page.fill('#guestName', 'Facturado');
        await page.click('#bmTabBtn_pagos');
        await page.fill('#paymentAmount', '48');
        await page.selectOption('#paymentMethod', 'card');
        await page.click('.btn-add-payment');
        await page.click('text=Guardar Reserva');
        await page.waitForSelector('#bookingModal:not(.active)', { state: 'attached' });
        let inv = await page.evaluate(() => JSON.parse(localStorage.getItem('hostal_jijones_invoices')));
        assert(inv.length === 1, 'facturas tras guardar: ' + inv.length);
        const num = inv[0].invoiceNum;
        assert(/^F-\d{4}-0001$/.test(num), 'número: ' + num);
        // Reeditar y guardar: no debe crear otra factura ni cambiar el número
        await page.evaluate(() => editBooking(bookings[0].id));
        await page.click('text=Guardar Reserva');
        await page.waitForSelector('#bookingModal:not(.active)', { state: 'attached' });
        inv = await page.evaluate(() => JSON.parse(localStorage.getItem('hostal_jijones_invoices')));
        assert(inv.length === 1 && inv[0].invoiceNum === num, 'factura duplicada o renumerada');
    });

    // ============ E2E: import iCal ============
    await test('E17 iCal: importa eventos, salta cerrados y no duplica por UID', async page => {
        await login(page);
        const r = await page.evaluate(() => {
            const ics = [
                'BEGIN:VCALENDAR',
                'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20260801', 'DTEND;VALUE=DATE:20260803', 'SUMMARY:Juan Booking', 'UID:uid-1', 'END:VEVENT',
                'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20260810', 'DTEND;VALUE=DATE:20260812', 'SUMMARY:CLOSED - Not available', 'UID:uid-2', 'END:VEVENT',
                'END:VCALENDAR',
            ].join('\n');
            const first = parseICalAndImport(ics, 115);
            const second = parseICalAndImport(ics, 115);
            return { first, second, n: bookings.length, b: bookings[0] };
        });
        assert(r.first.created === 1 && r.first.skipped === 1, '1ª pasada: ' + JSON.stringify(r.first));
        assert(r.second.created === 0, '2ª pasada duplicó: ' + JSON.stringify(r.second));
        assert(r.b.checkin === '2026-08-01' && r.b.checkout === '2026-08-03' && r.b.source === 'booking', JSON.stringify(r.b));
    });

    // ============ E2E: XML Guardia Civil ============
    await test('E18 XML huéspedes: escapa datos y no duplica grupos', async page => {
        await login(page);
        const xml = await page.evaluate(([ci, co]) => {
            const gid = 'g_1';
            bookings = [
                { id: 'm', groupId: gid, room: 101, checkin: ci, checkout: co, guestName: 'Ana & "Luis" <Toro>', status: 'confirmed', pricePerNight: 48, payments: [], extraRooms: [{ room: 102 }], companions: [{ name: 'Peque', docNumber: 'X1' }] },
                { id: 'c', groupId: gid, groupChild: true, room: 102, checkin: ci, checkout: co, guestName: 'Ana & "Luis" <Toro>', status: 'confirmed', pricePerNight: 48, payments: [], extraRooms: [], companions: [{ name: 'Peque', docNumber: 'X1' }] },
            ];
            window.__downloads = [];
            exportGuestXML(ci);
            return new Promise(res => setTimeout(() => res(window.__downloads[0] || ''), 100));
        }, [today(0), today(2)]);
        const guestCount = (xml.match(/<huesped>/g) || []).length;
        assert(guestCount === 2, 'esperados 2 huéspedes (titular+acompañante), hay ' + guestCount + ': ' + xml.slice(0, 200));
        assert(xml.includes('Ana &amp; &quot;Luis&quot; &lt;Toro&gt;'), 'XML sin escapar: ' + xml.slice(0, 300));
    });

    // ============ E2E: seguridad XSS ============
    await test('E19 XSS: nombre malicioso no ejecuta código en cuadrícula/tooltip/panel', async page => {
        await login(page);
        await page.evaluate(([ci, co]) => {
            bookings.push({ id: 'b1', room: 101, checkin: ci, checkout: co, guestName: '<img src=x onerror=window.__xss=1>', phone: '<b>1</b>', status: 'confirmed', pricePerNight: 48, payments: [] });
            saveBookings(); renderGrid(); toggleDayList(true);
        }, [today(0), today(2)]);
        await page.hover(`td.day-cell[data-room="101"][data-date="${today(0)}"]`);
        await page.waitForTimeout(300);
        const xss = await page.evaluate(() => window.__xss);
        assert(!xss, '¡XSS ejecutado!');
        const imgs = await page.evaluate(() => document.querySelectorAll('img[src="x"]').length);
        assert(imgs === 0, 'HTML inyectado en el DOM');
    });

    // ============ E2E: informes no rompen ============
    await test('E20 informes e ingresos: se renderizan sin errores con datos variados', async page => {
        await login(page);
        await page.evaluate(([ci, co]) => {
            bookings = [
                { id: 'a', room: 101, checkin: ci, checkout: co, guestName: 'A', status: 'confirmed', pricePerNight: 48, totalPrice: 96, roomTotal: 96, payments: [{ id: 'p1', amount: 50, method: 'cash', type: 'partial', date: ci }] },
                { id: 'b', room: 'CR1', checkin: ci, checkout: co, guestName: 'B', status: 'confirmed', pricePerNight: 250, totalPrice: 500, roomTotal: 500, ruralDeposit: 300, payments: [{ id: 'p2', amount: 500, method: 'card', type: 'full', date: ci }] },
            ];
            saveBookings();
        }, [today(0), today(2)]);
        await page.evaluate(() => { openReportsModal(); });
        await page.click('.report-tab:has-text("Ingresos")');
        await page.click('.report-tab:has-text("Habitaciones")');
        await page.evaluate(() => { closeReportsModal(); openIncomeModal(); });
        const totals = await page.textContent('#incomeTotals');
        assert(totals.includes('550.00'), 'total cobrado esperado 550: ' + totals);
        await page.evaluate(() => { closeIncomeModal(); openCashModal(); });
        const cash = await page.textContent('#cashTotals');
        assert(cash.includes('50.00') && cash.includes('500.00'), 'caja del día: ' + cash);
        assert(!(page.__errors || []).length, 'errores JS: ' + (page.__errors || []).join('; '));
    });

    // ============ E2E: permisos ============
    await test('E21 permisos: recepción no puede abrir Ingresos/Informes', async page => {
        await login(page, 'alba', '1001');
        await page.evaluate(() => sidebarNav('income'));
        const active = await page.evaluate(() => document.getElementById('incomeModal').classList.contains('active'));
        assert(!active, 'Alba pudo abrir Ingresos');
        // Y además esas opciones deben estar ocultas en el sidebar
        const visible = await page.evaluate(() => document.querySelector('.sidebar-item[data-section="income"]').style.display !== 'none');
        assert(!visible, 'opción Ingresos visible para recepción');
    });

    // ============ E2E: teclado ============
    await test('E22 tecla Escape cierra los modales (incluido INE)', async page => {
        await login(page);
        await page.evaluate(() => openIneModal());
        await page.keyboard.press('Escape');
        const ineOpen = await page.evaluate(() => document.getElementById('ineModal').classList.contains('active'));
        assert(!ineOpen, 'Escape no cierra el modal INE');
        await page.evaluate(() => openClientsModal());
        await page.keyboard.press('Escape');
        const cliOpen = await page.evaluate(() => document.getElementById('clientsModal').classList.contains('active'));
        assert(!cliOpen, 'Escape no cierra Clientes');
    });

    // ============ E2E: día de hoy — acciones rápidas ============
    await test('E23 check-in y check-out rápidos actualizan estado y limpieza', async page => {
        await login(page);
        await page.evaluate(([ci, co]) => {
            bookings.push({ id: 'b1', room: 101, checkin: ci, checkout: co, guestName: 'Hoy', status: 'confirmed', pricePerNight: 48, payments: [] });
            saveBookings(); renderGrid();
        }, [today(0), today(1)]);
        await page.evaluate(() => quickCheckIn('b1'));
        let st = await page.evaluate(() => bookings[0].status);
        assert(st === 'checkedin', 'estado tras check-in: ' + st);
        await page.evaluate(() => quickCheckOut('b1'));
        st = await page.evaluate(() => ({ s: bookings[0].status, clean: roomStatusData[101] || roomStatusData['101'] }));
        assert(st.s === 'checkedout', 'estado tras check-out');
        assert(st.clean && st.clean.status === 'dirty', 'habitación no marcada sucia');
    });

    // ============ E2E: precios ============
    await test('E24 calendario de precios: el precio por intervalo afecta a reservas nuevas', async page => {
        await login(page);
        const ci = today(20), co = today(22);
        await page.evaluate(([ci, co]) => {
            const pricing = loadPricing();
            let d = parseDate(ci);
            while (dateStr(d) < co) { pricing[dateStr(d) + '_doble'] = 60; d = addDays(d, 1); }
            savePricingData(pricing);
        }, [ci, co]);
        await page.evaluate(([ci, co]) => openNewBooking(102, ci, co), [ci, co]);
        await page.fill('#guestName', 'Precio Especial');
        const totalTxt = await page.textContent('#priceTotal');
        assert(totalTxt.includes('120.00'), 'total esperado 120 (2 × 60): ' + totalTxt);
        await page.click('text=Guardar Reserva');
        await page.waitForSelector('#bookingModal:not(.active)', { state: 'attached' });
        const tp = await page.evaluate(() => bookings[0].totalPrice);
        assert(tp === 120, 'totalPrice congelado: ' + tp);
    });

    await browser.close();

    const failed = results.filter(r => !r.ok);
    console.log('\n========================================');
    console.log(`TOTAL: ${results.length} · PASS: ${results.length - failed.length} · FAIL: ${failed.length}`);
    failed.forEach(f => console.log('  ✗ ' + f.name + ' — ' + f.error.split('\n')[0]));
    process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
