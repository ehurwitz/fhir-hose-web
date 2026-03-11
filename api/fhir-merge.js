// fhir-merge.js
// Deduplicates and merges FHIR resources into a master bundle.
// Uses clinical fingerprints (not LLM-generated IDs) to detect duplicates.

import crypto from 'crypto';

// Generate a fingerprint for a FHIR resource based on its clinical identity
function fingerprint(resource) {
  const rt = resource.resourceType;
  let parts = [rt];

  switch (rt) {
    case 'Patient':
      parts.push(
        resource.name?.[0]?.family || '',
        resource.name?.[0]?.given?.[0] || '',
        resource.birthDate || '',
        resource.gender || ''
      );
      break;

    case 'Condition':
      parts.push(
        getCodeValue(resource.code),
        resource.onsetDateTime || resource.onsetPeriod?.start || ''
      );
      break;

    case 'Observation':
      parts.push(
        getCodeValue(resource.code),
        resource.effectiveDateTime || resource.effectivePeriod?.start || '',
        getObservationValue(resource)
      );
      break;

    case 'Procedure':
      parts.push(
        getCodeValue(resource.code),
        resource.performedDateTime || resource.performedPeriod?.start || ''
      );
      break;

    case 'MedicationStatement':
    case 'MedicationRequest':
      parts.push(
        getCodeValue(resource.medicationCodeableConcept) || resource.medicationReference?.reference || '',
        resource.dateAsserted || resource.authoredOn || ''
      );
      break;

    case 'AllergyIntolerance':
      parts.push(
        getCodeValue(resource.code),
        resource.clinicalStatus?.coding?.[0]?.code || ''
      );
      break;

    case 'Immunization':
      parts.push(
        getCodeValue(resource.vaccineCode),
        resource.occurrenceDateTime || ''
      );
      break;

    case 'Encounter':
      parts.push(
        resource.period?.start || '',
        resource.type?.[0]?.coding?.[0]?.code || ''
      );
      break;

    case 'Composition':
      parts.push(resource.date || '', resource.title || '');
      break;

    case 'Practitioner':
      parts.push(
        resource.name?.[0]?.family || '',
        resource.name?.[0]?.given?.[0] || ''
      );
      break;

    case 'Organization':
      parts.push(resource.name || '');
      break;

    case 'Location':
      parts.push(resource.name || '', resource.address?.city || '');
      break;

    default:
      // Fallback: hash the whole resource
      parts.push(JSON.stringify(resource));
  }

  const key = parts.join('|').toLowerCase().trim();
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function getCodeValue(codeableConcept) {
  if (!codeableConcept) return '';
  const coding = codeableConcept.coding?.[0];
  if (coding) return `${coding.system || ''}#${coding.code || ''}`;
  return codeableConcept.text || '';
}

function getObservationValue(obs) {
  if (obs.valueQuantity) return `${obs.valueQuantity.value}`;
  if (obs.valueString) return obs.valueString;
  if (obs.valueCodeableConcept) return getCodeValue(obs.valueCodeableConcept);
  return '';
}

// Merge new FHIR bundle entries into the master bundle
// Returns { updatedBundle, changelog }
export function mergeBundles(masterBundle, newBundle, sourceName, portalId) {
  const changelog = { added: [], updated: [], unchanged: 0, source: sourceName };

  // Build fingerprint index of existing master entries
  const masterIndex = new Map();
  for (let i = 0; i < masterBundle.entry.length; i++) {
    const entry = masterBundle.entry[i];
    if (entry.resource) {
      const fp = fingerprint(entry.resource);
      masterIndex.set(fp, i);
    }
  }

  const newEntries = newBundle.entry || [];

  for (const newEntry of newEntries) {
    if (!newEntry.resource) continue;

    const fp = fingerprint(newEntry.resource);
    const rt = newEntry.resource.resourceType;

    // Tag the resource with source info
    if (!newEntry.resource.meta) newEntry.resource.meta = {};
    newEntry.resource.meta.source = sourceName;
    newEntry.resource.meta.lastUpdated = new Date().toISOString();
    if (portalId) {
      if (!newEntry.resource.meta.tag) newEntry.resource.meta.tag = [];
      // Remove old portal tag if present, then add current
      newEntry.resource.meta.tag = newEntry.resource.meta.tag.filter(t => t.system !== 'fhir-hose:portalId');
      newEntry.resource.meta.tag.push({ system: 'fhir-hose:portalId', code: portalId });
    }

    if (masterIndex.has(fp)) {
      // Resource exists — update it (keep newer version)
      const existingIdx = masterIndex.get(fp);
      const existingResource = masterBundle.entry[existingIdx].resource;

      // Check if the content actually changed
      const existingJson = JSON.stringify(existingResource, keysExcludingMeta);
      const newJson = JSON.stringify(newEntry.resource, keysExcludingMeta);

      if (existingJson !== newJson) {
        masterBundle.entry[existingIdx] = newEntry;
        changelog.updated.push({
          type: rt,
          description: describeResource(newEntry.resource)
        });
      } else {
        changelog.unchanged++;
      }
    } else {
      // New resource — append
      masterBundle.entry.push(newEntry);
      masterIndex.set(fp, masterBundle.entry.length - 1);
      changelog.added.push({
        type: rt,
        description: describeResource(newEntry.resource)
      });
    }
  }

  masterBundle.timestamp = new Date().toISOString();

  return { updatedBundle: masterBundle, changelog };
}

// JSON replacer that excludes meta fields for comparison
function keysExcludingMeta(key, value) {
  if (key === 'meta') return undefined;
  if (key === 'id') return undefined;
  if (key === 'fullUrl') return undefined;
  return value;
}

// Human-readable description of a resource
function describeResource(resource) {
  const rt = resource.resourceType;
  switch (rt) {
    case 'Patient':
      return `${resource.name?.[0]?.given?.[0] || ''} ${resource.name?.[0]?.family || ''}`.trim();
    case 'Condition':
      return resource.code?.text || resource.code?.coding?.[0]?.display || 'Unknown condition';
    case 'Observation':
      const val = resource.valueQuantity
        ? `${resource.valueQuantity.value} ${resource.valueQuantity.unit || ''}`
        : resource.valueString || '';
      return `${resource.code?.text || resource.code?.coding?.[0]?.display || 'Observation'}: ${val}`.trim();
    case 'Procedure':
      return resource.code?.text || resource.code?.coding?.[0]?.display || 'Unknown procedure';
    case 'MedicationStatement':
    case 'MedicationRequest':
      return resource.medicationCodeableConcept?.text ||
        resource.medicationCodeableConcept?.coding?.[0]?.display || 'Unknown medication';
    case 'AllergyIntolerance':
      return resource.code?.text || resource.code?.coding?.[0]?.display || 'Unknown allergy';
    case 'Immunization':
      return resource.vaccineCode?.text || resource.vaccineCode?.coding?.[0]?.display || 'Unknown vaccine';
    case 'Encounter':
      return `${resource.period?.start || 'Unknown date'} — ${resource.type?.[0]?.text || resource.type?.[0]?.coding?.[0]?.display || ''}`.trim();
    default:
      return resource.id || rt;
  }
}

export { fingerprint, describeResource };
