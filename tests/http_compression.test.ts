/**
 * tests/http_compression.test.ts
 * Real HTTP integration test: starts an Express instance with compression and static asset headers,
 * sends HTTP requests with Accept-Encoding: gzip, and asserts on Content-Encoding and Cache-Control headers.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import compression from 'compression';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

describe('HTTP Compression & Cache-Control Integration', () => {
  let server: http.Server;
  let baseUrl: string;

  before(async () => {
    const app = express();
    app.use(compression({ threshold: 100 })); // Compress anything > 100 bytes

    const distPath = path.join(ROOT_DIR, 'dist');
    
    // Static assets
    app.use('/assets', express.static(path.join(distPath, 'assets'), {
      maxAge: 31536000000,
      immutable: true,
      setHeaders: (res) => {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    }));

    // Large JSON endpoint
    app.get('/api/test-data', (_req, res) => {
      const data = {
        orders: Array.from({ length: 500 }, (_, i) => ({
          id: `ord_${i}`,
          waybill: `WB_TEST_${i.toString().padStart(6, '0')}`,
          shopName: `Shop Thời Trang ${i}`,
          codAmount: 250000,
          fee: 22000,
        }))
      };
      res.json(data);
    });

    // Fallback for HTML
    app.use((_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(distPath, 'index.html'));
    });

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('H1: JSON API response has Content-Encoding: gzip when client accepts gzip', async () => {
    const res = await fetch(`${baseUrl}/api/test-data`, {
      headers: { 'Accept-Encoding': 'gzip' }
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-encoding'), 'gzip');
    const json = await res.json();
    assert.equal(json.orders.length, 500);
  });

  it('H2: Static JS assets in /assets/ have Cache-Control: public, max-age=31536000, immutable and gzip', async () => {
    // Find a JS file from dist/assets
    const fs = await import('node:fs');
    const files = fs.readdirSync(path.join(ROOT_DIR, 'dist', 'assets'));
    const jsFile = files.find(f => f.endsWith('.js'));
    assert.ok(jsFile, 'Must have a JS bundle file in dist/assets');

    const res = await fetch(`${baseUrl}/assets/${jsFile}`, {
      headers: { 'Accept-Encoding': 'gzip' }
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(res.headers.get('content-encoding'), 'gzip');
  });

  it('H3: HTML index fallback has Cache-Control: no-cache', async () => {
    const res = await fetch(`${baseUrl}/some-spa-route`, {
      headers: { 'Accept-Encoding': 'gzip' }
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    const text = await res.text();
    assert.ok(text.includes('<!doctype html>'), 'Must return HTML index');
  });
});
