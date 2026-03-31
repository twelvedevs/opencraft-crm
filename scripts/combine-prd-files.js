#!/usr/bin/env node
// Combines all prd-phase-*.json files into a single prd-combined.json
// Stories are renumbered sequentially across phases in phase order.

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ralphDir = join(__dirname, 'ralph');

// Find and sort all phase files
const phaseFiles = readdirSync(ralphDir)
  .filter(f => /^prd-phase-\d+\.json$/.test(f))
  .sort((a, b) => {
    const numA = parseInt(a.match(/\d+/)[0], 10);
    const numB = parseInt(b.match(/\d+/)[0], 10);
    return numA - numB;
  });

if (phaseFiles.length === 0) {
  console.error('No prd-phase-*.json files found in', ralphDir);
  process.exit(1);
}

console.log(`Found ${phaseFiles.length} phase files:`, phaseFiles);

// Use metadata from the first phase file
const firstPhase = JSON.parse(readFileSync(join(ralphDir, phaseFiles[0]), 'utf8'));

const combined = {
  project: firstPhase.project.replace(/\s+Phase\s+\d+$/i, ''),
  branchName: firstPhase.branchName.replace(/-phase-\d+$/, ''),
  description: firstPhase.description,
  userStories: [],
};

let globalCounter = 1;
let priority = 0;

for (const file of phaseFiles) {
  const phase = JSON.parse(readFileSync(join(ralphDir, file), 'utf8'));
  const phaseNum = parseInt(file.match(/\d+/)[0], 10);

  for (const story of phase.userStories) {
    const id = `US-${String(globalCounter).padStart(3, '0')}`;
    combined.userStories.push({
      ...story,
      id,
      notes: story.notes
        ? `[Phase ${phaseNum}, originally ${story.id}] ${story.notes}`
        : `[Phase ${phaseNum}, originally ${story.id}]`,
      priority: priority + story.priority,
    });
    globalCounter++;
  }

  const priorities = phase.userStories.map(s => s.priority);
  priority += Math.max(...priorities);
}

const outputPath = join(ralphDir, 'prd-combined.json');
writeFileSync(outputPath, JSON.stringify(combined, null, 2) + '\n');

console.log(`Combined ${combined.userStories.length} stories into ${outputPath}`);
