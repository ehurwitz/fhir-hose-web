import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import portalsRouter from './api/portals.js';
import convertRouter, { validateBundle } from './api/convert.js';
import recordsRouter from './api/records.js';
import importsRouter from './api/imports.js';
import watcherRouter, { startWatcher } from './api/watcher.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

// Ensure data directory exists
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

// Initialize master bundle if it doesn't exist
const masterPath = path.join(dataDir, 'master_bundle.json');
if (!fs.existsSync(masterPath)) {
  fs.writeFileSync(masterPath, JSON.stringify({
    resourceType: "Bundle",
    id: "master-record",
    type: "collection",
    timestamp: new Date().toISOString(),
    entry: []
  }, null, 2));
}

// Initialize portals list if it doesn't exist
const portalsPath = path.join(dataDir, 'portals.json');
if (!fs.existsSync(portalsPath)) {
  fs.writeFileSync(portalsPath, JSON.stringify([], null, 2));
}

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// API routes
app.use('/api/portals', portalsRouter);
app.use('/api/convert', convertRouter);
app.use('/api/records', recordsRouter);
app.use('/api/imports', importsRouter);
app.use('/api/watcher', watcherRouter);

// Validate the master bundle on demand
app.get('/api/validate', async (req, res) => {
  try {
    const master = JSON.parse(fs.readFileSync(masterPath, 'utf-8'));
    const result = await validateBundle(master);
    if (!result) return res.status(500).json({ error: 'Validation script failed' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`FHIR-HOSE Web running at http://localhost:${PORT}`);
  console.log(`Charmonator expected at http://localhost:5002`);

  // Start watching ~/Downloads for clinical files
  startWatcher();
});
