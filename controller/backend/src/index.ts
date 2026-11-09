// src/index.ts -intercom controller bootstrap (mirrors Walk the Nxt Floor)
import express from 'express';
import http from 'http';
import cors from 'cors';
import cookieParser from 'cookie-parser';

import config from './config';
import { pool } from './db/pool';
import { runMigrations } from './db/migrate';
import { seedDefaultAdmin } from './services/userService';
import { seedDemoData } from './services/demoSeedService';
import { startHealthScheduler } from './services/endpointHealthService';
import { errorHandler } from './middleware/errorHandler';

import authRoutes from './routes/auth';
import endpointRoutes from './routes/endpoints';
import groupRoutes from './routes/groups';
import intercomRoutes from './routes/intercom';
import directoryUserRoutes from './routes/directoryUsers';
import intercomClientRoutes from './routes/intercomClient';
import liveRoutes from './routes/live';
import systemRoutes from './routes/system';
import adminRoutes from './routes/admin';
import settingsRoutes from './routes/settings';
import { startTranscriptRetention } from './services/transcriptService';
import { startChatRetention } from './services/chatService';

async function main() {
  console.log('[startup] Waiting for PostgreSQL...');
  for (let i = 0; i < 30; i++) {
    try { await pool.query('SELECT 1'); break; }
    catch { if (i === 29) throw new Error('PostgreSQL not available'); await new Promise(r => setTimeout(r, 1000)); }
  }
  console.log('[startup] PostgreSQL ready');

  await runMigrations();
  await seedDefaultAdmin();
  await seedDemoData();

  const app = express();
  const server = http.createServer(app);
  // CORS only for an explicitly named origin; '*' with credentials would
  // let any website the user visits call the API with their session.
  if (config.corsOrigin && config.corsOrigin !== '*') {
    app.use(cors({ origin: config.corsOrigin.split(',').map((o) => o.trim()), credentials: true }));
  } else if (config.corsOrigin === '*') {
    console.warn('[startup] CORS_ORIGIN=* ignored: the API is same-origin through nginx; name an origin if you need CORS');
  }
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.use('/api/v1/auth', authRoutes);
  app.use('/api/v1/endpoints', endpointRoutes);
  app.use('/api/v1/groups', groupRoutes);
  app.use('/api/v1/intercom', intercomRoutes);
  app.use('/api/v1/directory-users', directoryUserRoutes);
  app.use('/api/v1/intercom-client', intercomClientRoutes);
  app.use('/api/v1/live', liveRoutes);
  app.use('/api/v1/system', systemRoutes);
  app.use('/api/v1/admin', adminRoutes);
  app.use('/api/v1/settings', settingsRoutes);

  app.get('/health', (_req, res) => res.json({ status: 'ok', version: '0.1.0' }));

  app.use(errorHandler);

  startHealthScheduler();
  startTranscriptRetention();
  startChatRetention();

  let shuttingDown = false;
  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal} -closing...`);
    server.close();
    await pool.end().catch(() => {});
    process.exit(0);
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT',  () => void shutdown('SIGINT'));

  server.listen(config.port, () => {
    console.log(`[startup] Intercom controller listening on :${config.port}`);
    console.log(`[startup] Admin: ${config.adminEmail}`);
  });
}

main().catch(err => { console.error('[startup] Fatal:', err); process.exit(1); });
