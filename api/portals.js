// api/portals.js — CRUD for saved patient portals

import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const portalsPath = path.join(__dirname, '..', 'data', 'portals.json');

const router = express.Router();

function readPortals() {
  return JSON.parse(fs.readFileSync(portalsPath, 'utf-8'));
}

function writePortals(portals) {
  fs.writeFileSync(portalsPath, JSON.stringify(portals, null, 2));
}

// List all portals
router.get('/', (req, res) => {
  res.json(readPortals());
});

// Add a portal
router.post('/', (req, res) => {
  const { name, url, type, notes } = req.body;
  if (!name || !url) {
    return res.status(400).json({ error: 'name and url are required' });
  }
  const portals = readPortals();
  const portal = {
    id: uuidv4(),
    name,
    url,
    type: type || 'manual', // 'manual' or 'smart-on-fhir'
    notes: notes || '',
    lastRefresh: null,
    recordCount: 0,
    createdAt: new Date().toISOString()
  };
  portals.push(portal);
  writePortals(portals);
  res.json(portal);
});

// Update a portal
router.put('/:id', (req, res) => {
  const portals = readPortals();
  const idx = portals.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Portal not found' });
  portals[idx] = { ...portals[idx], ...req.body, id: req.params.id };
  writePortals(portals);
  res.json(portals[idx]);
});

// Delete a portal
router.delete('/:id', (req, res) => {
  let portals = readPortals();
  portals = portals.filter(p => p.id !== req.params.id);
  writePortals(portals);
  res.json({ success: true });
});

export default router;
