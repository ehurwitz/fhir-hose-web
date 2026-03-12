// api/watcher.js — Watches ~/Downloads for new clinical files, auto-converts and merges them

import chokidar from 'chokidar';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { mergeBundles } from './fhir-merge.js';
import { recordImport } from './imports.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const masterPath = path.join(__dirname, '..', 'data', 'master_bundle.json');
const changelogPath = path.join(__dirname, '..', 'data', 'changelog.json');
const processedDir = path.join(__dirname, '..', 'data', 'processed');
const activityPath = path.join(__dirname, '..', 'data', 'activity.json');

const CHARMONATOR_BASE = 'http://localhost:5002/charm/api/charmonator/v1';
const WATCH_DIR = path.join(os.homedir(), 'Downloads');
const CLINICAL_EXTENSIONS = new Set(['.xml', '.pdf', '.ccd', '.ccda']);

// Ensure dirs exist
if (!fs.existsSync(processedDir)) fs.mkdirSync(processedDir, { recursive: true });
if (!fs.existsSync(activityPath)) fs.writeFileSync(activityPath, '[]');

// Activity log — lightweight feed for the frontend
function readActivity() {
  try { return JSON.parse(fs.readFileSync(activityPath, 'utf-8')); } catch { return []; }
}

function writeActivity(log) {
  fs.writeFileSync(activityPath, JSON.stringify(log, null, 2));
}

function addActivity(entry) {
  const log = readActivity();
  log.unshift({ ...entry, timestamp: new Date().toISOString() });
  // Keep last 50 entries
  if (log.length > 50) log.length = 50;
  writeActivity(log);
}

// Try to detect which portal a file came from based on content
function detectPortal(content, fileName) {
  const portalsPath = path.join(__dirname, '..', 'data', 'portals.json');
  let portals = [];
  try { portals = JSON.parse(fs.readFileSync(portalsPath, 'utf-8')); } catch { return null; }

  const lowerContent = content.toLowerCase();
  const lowerName = fileName.toLowerCase();

  for (const portal of portals) {
    const name = portal.name.toLowerCase();
    const url = portal.url.toLowerCase();
    // Extract domain from portal URL
    let domain = '';
    try { domain = new URL(portal.url).hostname.toLowerCase(); } catch {}

    // Check file content and name for portal identifiers
    const keywords = [name, domain].filter(Boolean);
    // Also check for common vendor identifiers
    if (url.includes('nextgen')) keywords.push('nextgen');
    if (url.includes('advancedmd')) keywords.push('advancedmd');
    if (portal.notes) keywords.push(portal.notes.toLowerCase());

    for (const kw of keywords) {
      if (kw && (lowerContent.includes(kw) || lowerName.includes(kw))) {
        return portal;
      }
    }
  }

  return null;
}

// Wait for a file to finish downloading (stable file size)
async function waitForComplete(filePath, maxWait = 30000) {
  const start = Date.now();
  let lastSize = -1;

  while (Date.now() - start < maxWait) {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > 0 && stat.size === lastSize) {
        return true; // File size stable
      }
      lastSize = stat.size;
    } catch {
      return false; // File gone
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

// Convert file content to FHIR via charmonator
async function convertToFHIR(content, fileName) {
  const ext = path.extname(fileName).toLowerCase();
  let fileContent = content;

  // For PDFs, use charmonator's file conversion first
  if (ext === '.pdf') {
    const formData = new FormData();
    const fileBlob = new Blob([fs.readFileSync(fileName)]);
    formData.append('file', fileBlob, path.basename(fileName));

    const convResp = await fetch(`${CHARMONATOR_BASE}/conversion/file`, {
      method: 'POST',
      body: formData
    });
    const convResult = await convResp.json();
    fileContent = convResult.markdownContent || content;
  }

  const payload = {
    model: 'azure-gpt-5.2-hipaa',
    system: `You are a clinical data interoperability expert. You convert clinical documents to FHIR R4 JSON format. Output valid FHIR Bundle JSON only, no explanation. Include all relevant resources: Patient, Encounter, Conditions, Medications, Allergies, Procedures, Results, Vital Signs, and Immunizations.`,
    temperature: 0.2,
    transcript: {
      messages: [{
        role: 'user',
        content: `Convert the following clinical document into a FHIR R4 Bundle (JSON). Output only the FHIR JSON.\n\n${fileContent}`
      }]
    }
  };

  const chatResp = await fetch(`${CHARMONATOR_BASE}/transcript/extension`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const chatResult = await chatResp.json();
  if (!chatResult.messages || chatResult.messages.length === 0) {
    throw new Error('No response from charmonator');
  }

  let fhirText = chatResult.messages[0].content;
  const jsonMatch = fhirText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) fhirText = jsonMatch[1];

  return JSON.parse(fhirText.trim());
}

// Process a detected clinical file
async function processFile(filePath) {
  const fileName = path.basename(filePath);

  addActivity({ type: 'detected', file: fileName, status: 'processing', message: `Detected new file: ${fileName}` });
  console.log(`[watcher] Detected clinical file: ${fileName}`);

  try {
    // Read file content
    const content = fs.readFileSync(filePath, 'utf-8');

    // Detect portal source
    const portal = detectPortal(content, fileName);
    const sourceName = portal?.name || 'auto-import';
    const portalId = portal?.id || null;

    addActivity({ type: 'converting', file: fileName, status: 'processing', portal: sourceName, message: `Converting ${fileName} via charmonator...` });

    // Convert to FHIR
    const fhirBundle = await convertToFHIR(content, filePath);

    // Merge into master
    const master = JSON.parse(fs.readFileSync(masterPath, 'utf-8'));
    const { updatedBundle, changelog } = mergeBundles(master, fhirBundle, sourceName, portalId);
    fs.writeFileSync(masterPath, JSON.stringify(updatedBundle, null, 2));

    // Update changelog
    let history = [];
    try { history = JSON.parse(fs.readFileSync(changelogPath, 'utf-8')); } catch {}
    history.push({ timestamp: new Date().toISOString(), ...changelog });
    fs.writeFileSync(changelogPath, JSON.stringify(history, null, 2));

    // Record import
    recordImport({
      portalId,
      portalName: sourceName,
      fileName,
      bundle: fhirBundle,
      changelog,
      dateFrom: null,
      dateTo: null,
    });

    // Update portal lastRefresh
    if (portalId) {
      const portalsPath = path.join(__dirname, '..', 'data', 'portals.json');
      try {
        const portals = JSON.parse(fs.readFileSync(portalsPath, 'utf-8'));
        const idx = portals.findIndex(p => p.id === portalId);
        if (idx !== -1) {
          portals[idx].lastRefresh = new Date().toISOString();
          fs.writeFileSync(portalsPath, JSON.stringify(portals, null, 2));
        }
      } catch {}
    }

    // Move processed file out of Downloads
    const destPath = path.join(processedDir, `${Date.now()}_${fileName}`);
    fs.renameSync(filePath, destPath);

    const summary = `+${changelog.added.length} new, ~${changelog.updated.length} updated, ${changelog.unchanged} unchanged`;
    addActivity({
      type: 'complete',
      file: fileName,
      status: 'success',
      portal: sourceName,
      message: `Processed ${fileName}: ${summary}`,
      added: changelog.added.length,
      updated: changelog.updated.length,
      unchanged: changelog.unchanged,
    });

    console.log(`[watcher] Processed ${fileName}: ${summary} (source: ${sourceName})`);

  } catch (err) {
    addActivity({ type: 'error', file: fileName, status: 'error', message: `Error processing ${fileName}: ${err.message}` });
    console.error(`[watcher] Error processing ${fileName}:`, err.message);
  }
}

// Track files we've already seen or are currently processing
const processing = new Set();
const seen = new Set();

// On startup, mark existing files as "seen" so we don't process old downloads
function snapshotExisting() {
  try {
    const files = fs.readdirSync(WATCH_DIR);
    for (const f of files) {
      seen.add(path.join(WATCH_DIR, f));
    }
    console.log(`[watcher] Snapshot: ${seen.size} existing files in ${WATCH_DIR}`);
  } catch (err) {
    console.error(`[watcher] Could not snapshot ${WATCH_DIR}:`, err.message);
  }
}

export function startWatcher() {
  snapshotExisting();

  const watcher = chokidar.watch(WATCH_DIR, {
    ignoreInitial: true,
    depth: 0, // Don't recurse into subdirectories
    awaitWriteFinish: {
      stabilityThreshold: 2000,
      pollInterval: 500,
    },
  });

  watcher.on('add', async (filePath) => {
    // Skip files that existed before we started
    if (seen.has(filePath)) return;

    const ext = path.extname(filePath).toLowerCase();
    if (!CLINICAL_EXTENSIONS.has(ext)) return;

    // Skip temp/partial download files
    const base = path.basename(filePath);
    if (base.startsWith('.') || base.endsWith('.crdownload') || base.endsWith('.part')) return;

    // Avoid double-processing
    if (processing.has(filePath)) return;
    processing.add(filePath);

    try {
      // Extra wait for file stability
      const ready = await waitForComplete(filePath);
      if (!ready) {
        console.log(`[watcher] File not ready, skipping: ${base}`);
        return;
      }

      await processFile(filePath);
    } finally {
      processing.delete(filePath);
    }
  });

  addActivity({ type: 'started', status: 'info', message: `Watcher started — monitoring ${WATCH_DIR} for clinical files` });
  console.log(`[watcher] Watching ${WATCH_DIR} for clinical files (${[...CLINICAL_EXTENSIONS].join(', ')})`);

  return watcher;
}

// Express routes for activity feed
import express from 'express';
const router = express.Router();

router.get('/activity', (req, res) => {
  res.json(readActivity());
});

router.get('/status', (req, res) => {
  res.json({
    watching: true,
    directory: WATCH_DIR,
    extensions: [...CLINICAL_EXTENSIONS],
  });
});

export default router;
