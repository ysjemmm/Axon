const fs = require('fs');
const path = 'd:/projects/Axon/packages/core/src/agentSession.ts';
const content = fs.readFileSync(path, 'utf8');
const lines = content.split('\n');

// Find the orphaned block: starts with "/**" right after recordToolOutcome delegate's closing "}",
// ends with "}" right before the real runPipelineTurn comment block.
let orphanStart = -1, orphanEnd = -1;
for (let i = 0; i < lines.length; i++) {
  // Find the recordToolOutcome delegate method closing
  if (lines[i].includes('recordToolOutcome') && lines[i].includes('return this.toolCallExecutor.recordToolOutcome')) {
    // Find the closing } of this method
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === '}') {
        // The orphan starts right after this (next non-empty line should be the misplaced comment)
        orphanStart = j + 1;
        // Skip empty lines
        while (orphanStart < lines.length && lines[orphanStart].trim() === '') orphanStart++;
        break;
      }
    }
    break;
  }
}

if (orphanStart >= 0) {
  // Find the end: the orphaned block ends with "return { mutated, diagnosed };" followed by "}"
  for (let i = orphanStart; i < lines.length; i++) {
    if (lines[i].includes('return { mutated, diagnosed }') || (lines[i].includes('return { mutated') && lines[i].includes('diagnosed'))) {
      // Next line should be "}"
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() === '}') {
          orphanEnd = j;
          break;
        }
      }
      break;
    }
  }
}

console.log(`Orphan block: lines ${orphanStart + 1} to ${orphanEnd + 1}`);
console.log(`  start line: ${JSON.stringify(lines[orphanStart])}`);
console.log(`  end line: ${JSON.stringify(lines[orphanEnd])}`);
console.log(`  line after: ${JSON.stringify(lines[orphanEnd + 1] || 'N/A')}`);
console.log(`  line after+1: ${JSON.stringify(lines[orphanEnd + 2] || 'N/A')}`);

if (orphanStart >= 0 && orphanEnd >= 0) {
  const newLines = lines.filter((_, i) => i < orphanStart || i > orphanEnd);
  fs.writeFileSync(path, newLines.join('\n'), 'utf8');
  console.log(`Removed ${orphanEnd - orphanStart + 1} orphaned lines`);
  console.log(`Original: ${lines.length} lines -> New: ${newLines.length} lines`);
} else {
  console.log('Could not find orphan block boundaries');
}
