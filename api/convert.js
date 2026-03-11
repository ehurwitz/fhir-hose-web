// api/convert.js — Takes uploaded file, sends to charmonator, returns FHIR

import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const upload = multer({ dest: path.join(__dirname, '..', 'data', 'uploads') });
const router = express.Router();

const CHARMONATOR_BASE = 'http://localhost:5002/charm/api/charmonator/v1';

// Convert an uploaded file to FHIR
router.post('/', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const filePath = req.file.path;
  const originalName = req.file.originalname;

  try {
    // Step 1: Read the file content
    const content = fs.readFileSync(filePath, 'utf-8');

    // Step 2: Determine file type and build the prompt
    const ext = path.extname(originalName).toLowerCase();
    let fileContent = content;

    // For PDFs, use charmonator's file conversion first
    if (ext === '.pdf') {
      const formData = new FormData();
      const fileBlob = new Blob([fs.readFileSync(filePath)]);
      formData.append('file', fileBlob, originalName);

      const convResp = await fetch(`${CHARMONATOR_BASE}/conversion/file`, {
        method: 'POST',
        body: formData
      });
      const convResult = await convResp.json();
      fileContent = convResult.markdownContent || content;
    }

    // Step 3: Send to charmonator for FHIR conversion
    const payload = {
      model: 'azure-gpt-5.2-hipaa',
      system: `You are a clinical data interoperability expert. You convert clinical documents to FHIR R4 JSON format. Output valid FHIR Bundle JSON only, no explanation. Include all relevant resources: Patient, Encounter, Conditions, Medications, Allergies, Procedures, Results, Vital Signs, and Immunizations.`,
      temperature: 0.2,
      transcript: {
        messages: [
          {
            role: 'user',
            content: `Convert the following clinical document into a FHIR R4 Bundle (JSON). Output only the FHIR JSON.\n\n${fileContent}`
          }
        ]
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

    const assistantContent = chatResult.messages[0].content;

    // Step 4: Parse the FHIR JSON from the response
    // The model might wrap it in markdown code blocks, so strip those
    let fhirText = assistantContent;
    const jsonMatch = fhirText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) fhirText = jsonMatch[1];

    const fhirBundle = JSON.parse(fhirText.trim());

    // Clean up uploaded file
    fs.unlinkSync(filePath);

    res.json({
      bundle: fhirBundle,
      resourceCount: fhirBundle.entry?.length || 0,
      sourceFile: originalName
    });

  } catch (err) {
    // Clean up on error
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    console.error('Conversion error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Convert raw text/XML content (for portal-captured data)
router.post('/raw', async (req, res) => {
  const { content, sourceName } = req.body;
  if (!content) {
    return res.status(400).json({ error: 'content is required' });
  }

  try {
    const payload = {
      model: 'azure-gpt-5.2-hipaa',
      system: `You are a clinical data interoperability expert. You convert clinical documents to FHIR R4 JSON format. Output valid FHIR Bundle JSON only, no explanation. Include all relevant resources: Patient, Encounter, Conditions, Medications, Allergies, Procedures, Results, Vital Signs, and Immunizations.`,
      temperature: 0.2,
      transcript: {
        messages: [
          {
            role: 'user',
            content: `Convert the following clinical document into a FHIR R4 Bundle (JSON). Output only the FHIR JSON.\n\n${content}`
          }
        ]
      }
    };

    const chatResp = await fetch(`${CHARMONATOR_BASE}/transcript/extension`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const chatResult = await chatResp.json();
    const assistantContent = chatResult.messages[0].content;

    let fhirText = assistantContent;
    const jsonMatch = fhirText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) fhirText = jsonMatch[1];

    const fhirBundle = JSON.parse(fhirText.trim());

    res.json({
      bundle: fhirBundle,
      resourceCount: fhirBundle.entry?.length || 0,
      sourceName: sourceName || 'unknown'
    });

  } catch (err) {
    console.error('Raw conversion error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
