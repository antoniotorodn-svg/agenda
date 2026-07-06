# Tests automáticos

Suite de tests de la agenda (lógica interna + flujos E2E en navegador) y del proxy iCal.

## Requisitos

```bash
npm install -g playwright http-server   # o tenerlos disponibles vía npx
npx playwright install chromium         # solo la primera vez
```

## Ejecución

```bash
# 1. Servir la app en el puerto 8123
npx http-server -p 8123 -s &

# 2. Suite E2E (33 tests): login, reservas, conflictos, bloqueos, pagos,
#    multi-habitación, casa rural, wizard, facturas, iCal, XML, XSS, permisos…
#    (NODE_PATH hace visible el playwright instalado globalmente)
NODE_PATH=$(npm root -g) node tests/e2e.test.js

# 3. Tests del proxy iCal de Vercel (validación de URLs, errores upstream)
node tests/api-ical.test.js
```

Cada test E2E abre un contexto de navegador limpio (localStorage aislado),
hace login con un usuario real y ejecuta el flujo completo contra la UI.
El proceso termina con código 0 si todo pasa y 1 si hay fallos.
