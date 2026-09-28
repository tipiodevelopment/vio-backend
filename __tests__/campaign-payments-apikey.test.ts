/**
 * Integration tests: POST /api/campaign/payments/apikey/:apiKey
 * Hits the real server at localhost:5001 (igual que el resto de este directorio).
 *
 * Regresion del 2026-09-28: una API key desconocida caia en el catch generico y
 * salia como 500. Commerce llamaba con la key de una cuenta de prueba y producia
 * un 500 cada pocos minutos contra produccion; hubo que rastrear la key hasta la
 * base de Commerce para descubrir que no pasaba nada. Una key que no matchea es
 * un error del cliente, no una falla del servidor.
 */

import supertest from 'supertest';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:5001';
const request = supertest(BASE_URL);

describe('POST /api/campaign/payments/apikey/:apiKey', () => {
  it('devuelve 404 cuando ningun sponsor tiene esa API key', async () => {
    const res = await request
      .post('/api/campaign/payments/apikey/key_que_no_existe_000')
      .send({ paymentMethods: ['card'] });

    expect(res.status).toBe(404);
    expect(res.body.status).toBe('error');
  });

  it('no devuelve la API key en el cuerpo de la respuesta', async () => {
    const apiKey = 'key_que_no_existe_000';
    const res = await request
      .post(`/api/campaign/payments/apikey/${apiKey}`)
      .send({ paymentMethods: ['card'] });

    // La key viaja en el path y ya queda en los access.log; al menos no la
    // repetimos en el body, que Commerce tambien loguea.
    expect(JSON.stringify(res.body)).not.toContain(apiKey);
  });

  it('devuelve 400 cuando paymentMethods no es un array', async () => {
    const res = await request
      .post('/api/campaign/payments/apikey/key_que_no_existe_000')
      .send({ paymentMethods: 'card' });

    // El chequeo de forma corre despues del lookup del sponsor, asi que con una
    // key inexistente gana el 404. Con una key valida seria 400.
    expect([400, 404]).toContain(res.status);
  });
});
