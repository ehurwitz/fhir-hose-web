// api/records.js — Master FHIR bundle: read, merge new data, get changelog

import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { mergeBundles } from './fhir-merge.js';
import { recordImport } from './imports.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const masterPath = path.join(__dirname, '..', 'data', 'master_bundle.json');
const changelogPath = path.join(__dirname, '..', 'data', 'changelog.json');

const router = express.Router();

function readMaster() {
  return JSON.parse(fs.readFileSync(masterPath, 'utf-8'));
}

function writeMaster(bundle) {
  fs.writeFileSync(masterPath, JSON.stringify(bundle, null, 2));
}

function readChangelog() {
  if (!fs.existsSync(changelogPath)) return [];
  return JSON.parse(fs.readFileSync(changelogPath, 'utf-8'));
}

function writeChangelog(log) {
  fs.writeFileSync(changelogPath, JSON.stringify(log, null, 2));
}

// Get the master FHIR bundle
router.get('/', (req, res) => {
  const master = readMaster();
  const entries = master.entry || [];

  // Build a summary by resource type
  const summary = {};
  for (const entry of entries) {
    const rt = entry.resource?.resourceType;
    if (rt) summary[rt] = (summary[rt] || 0) + 1;
  }

  res.json({
    bundle: master,
    totalResources: entries.length,
    summary,
    lastUpdated: master.timestamp
  });
});

// Get just the summary (lighter response)
router.get('/summary', (req, res) => {
  const master = readMaster();
  const entries = master.entry || [];

  const summary = {};
  const sources = new Set();
  for (const entry of entries) {
    const rt = entry.resource?.resourceType;
    if (rt) summary[rt] = (summary[rt] || 0) + 1;
    if (entry.resource?.meta?.source) sources.add(entry.resource.meta.source);
  }

  res.json({
    totalResources: entries.length,
    summary,
    sources: [...sources],
    lastUpdated: master.timestamp
  });
});

// Merge a new FHIR bundle into the master
router.post('/merge', (req, res) => {
  const { bundle, sourceName, portalId, fileName, dateFrom, dateTo } = req.body;
  if (!bundle || !bundle.entry) {
    return res.status(400).json({ error: 'bundle with entry array is required' });
  }

  const master = readMaster();
  const { updatedBundle, changelog } = mergeBundles(master, bundle, sourceName || 'unknown', portalId);

  writeMaster(updatedBundle);

  // Append to changelog history
  const history = readChangelog();
  history.push({
    timestamp: new Date().toISOString(),
    ...changelog
  });
  writeChangelog(history);

  // Archive this import
  const importEntry = recordImport({
    portalId: portalId || null,
    portalName: sourceName || 'manual-upload',
    fileName: fileName || 'unknown',
    bundle,
    changelog,
    dateFrom: dateFrom || null,
    dateTo: dateTo || null,
  });

  res.json({
    changelog,
    totalResources: updatedBundle.entry.length,
    importId: importEntry.id,
  });
});

// Get changelog history
router.get('/changelog', (req, res) => {
  res.json(readChangelog());
});

// Get resources by type
router.get('/resources/:type', (req, res) => {
  const master = readMaster();
  const filtered = master.entry
    .filter(e => e.resource?.resourceType === req.params.type)
    .map(e => e.resource);
  res.json(filtered);
});

// Get resources by portal
router.get('/by-portal/:portalId', (req, res) => {
  const master = readMaster();
  const filtered = master.entry
    .filter(e => e.resource?.meta?.tag?.some(t => t.system === 'fhir-hose:portalId' && t.code === req.params.portalId))
    .map(e => e.resource);

  const summary = {};
  for (const r of filtered) {
    const rt = r.resourceType;
    summary[rt] = (summary[rt] || 0) + 1;
  }

  res.json({ resources: filtered, totalResources: filtered.length, summary });
});

// Reset master bundle (careful!)
router.delete('/', (req, res) => {
  writeMaster({
    resourceType: "Bundle",
    id: "master-record",
    type: "collection",
    timestamp: new Date().toISOString(),
    entry: []
  });
  writeChangelog([]);
  res.json({ success: true, message: 'Master bundle reset' });
});

export default router;
