// tests/auth.test.js
const request = require('supertest');
const app = require('../src/index');

describe('Auth API', () => {
  test('GET /api/health returns 200', async () => {
    const res = await request(app).get('/health');
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  test('POST /api/auth/login with missing credentials returns 400', async () => {
    const res = await request(app).post('/api/auth/login').send({});
    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test('POST /api/auth/login with wrong credentials returns 401', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@test.com', password: 'wrongpassword123' });
    expect(res.statusCode).toBe(401);
  });

  test('GET /api/employees without token returns 401', async () => {
    const res = await request(app).get('/api/employees');
    expect(res.statusCode).toBe(401);
  });

  test('404 handler works for unknown routes', async () => {
    const res = await request(app).get('/api/nonexistent-route');
    expect(res.statusCode).toBe(404);
    expect(res.body.success).toBe(false);
  });
});
