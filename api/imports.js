// api/imports.js — Track import history per portal, archive imported bundles

import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const importsDir = path.join(__dirname, '..', 'data', 'imports');
const indexPath = path.join(importsDir, 'index.json');

if (!fs.existsSync(importsDir)) fs.mkdirSync(importsDir, { recursive: true });
if (!fs.existsSync(indexPath)) fs.writeFileSync(indexPath, '[]');

const router = express.Router();

function readIndex() {
  return JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
}

function writeIndex(index) {
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
}

// Record a new import and archive the bundle
export function recordImport({ portalId, portalName, fileName, bundle, changelog, dateFrom, dateTo }) {
  const importId = uuidv4();
  const timestamp = new Date().toISOString();

  // Save the imported bundle as a separate file
  const bundlePath = path.join(importsDir, `${importId}.json`);
  fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2));

  // Add to index
  const index = readIndex();
  const entry = {
    id: importId,
    portalId: portalId || null,
    portalName: portalName || 'manual-upload',
    fileName: fileName || 'unknown',
    timestamp,
    dateFrom: dateFrom || null,
    dateTo: dateTo || null,
    resourceCount: bundle.entry?.length || 0,
    added: changelog.added?.length || 0,
    updated: changelog.updated?.length || 0,
    unchanged: changelog.unchanged || 0,
  };
  index.push(entry);
  writeIndex(index);

  return entry;
}

// List all imports, optionally filtered by portal
router.get('/', (req, res) => {
  const index = readIndex();
  const { portalId } = req.query;
  if (portalId) {
    return res.json(index.filter(i => i.portalId === portalId));
  }
  res.json(index);
});

// Get import detail (includes the archived bundle)
router.get('/:id', (req, res) => {
  const index = readIndex();
  const entry = index.find(i => i.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'Import not found' });

  const bundlePath = path.join(importsDir, `${entry.id}.json`);
  let bundle = null;
  if (fs.existsSync(bundlePath)) {
    bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf-8'));
  }

  res.json({ ...entry, bundle });
});

// Get per-portal sync summary
router.get('/portal-summary/:portalId', (req, res) => {
  const index = readIndex();
  const portalImports = index.filter(i => i.portalId === req.params.portalId);

  if (portalImports.length === 0) {
    return res.json({ lastImport: null, totalImports: 0, totalResourcesImported: 0 });
  }

  const sorted = portalImports.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  const totalResources = portalImports.reduce((sum, i) => sum + i.resourceCount, 0);
  const totalAdded = portalImports.reduce((sum, i) => sum + i.added, 0);

  res.json({
    lastImport: sorted[0].timestamp,
    totalImports: portalImports.length,
    totalResourcesImported: totalResources,
    totalNewResources: totalAdded,
    history: sorted,
  });
});

export default router;
