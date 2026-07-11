const fs = require('fs');
const path = 'd:/projects/Axon/packages/core/src/agentSession.ts';
const content = fs.readFileSync(path, 'utf8');
const lines = content.split('\n');

// Block 1: orphaned dispatchToolCall old body
// Starts with a line that is just "," after a line that is just "}"
let block1Start = -1, block1End = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].trim() === ',' && i > 0 && lines[i - 1].trim() === '}') {
    block1Start = i;
    break;
  }
}
if (block1Start >= 0) {
  for (let i = block1Start; i < lines.length; i++) {
    if (lines[i].trim() === '}' && i + 2 < lines.length && lines[i + 1].trim() === '' && lines[i + 2].includes('执行单个工具调用')) {
      block1End = i;
      break;
    }
  }
}

// Block 2: orphaned recordToolOutcome old body
// Starts with a line that is just "{" after a line that is just "}"
let block2Start = -1, block2End = -1;
for (let i = (block1End !== -1 ? block1End + 1 : 0); i < lines.length; i++) {
  if (lines[i].trim() === '{' && i > 0 && lines[i - 1].trim() === '}') {
    block2Start = i;
    break;
  }
}
if (block2Start >= 0) {
  for (let i = block2Start; i < lines.length; i++) {
    if (lines[i].trim() === '}' && i + 2 < lines.length && lines[i + 1].trim() === '' && lines[i + 2].includes('回合产出')) {
      block2End = i;
      break;
    }
  }
}

console.log(`Block 1: lines ${block1Start + 1} to ${block1End + 1} (${block1End - block1Start + 1} lines)`);
console.log(`Block 2: lines ${block2Start + 1} to ${block2End + 1} (${block2End - block2Start + 1} lines)`);

// Print surrounding context for verification
if (block1Start >= 0) {
  console.log('\n--- Block 1 context ---');
  console.log(`  before: ${JSON.stringify(lines[block1Start - 1])}`);
  console.log(`  start:  ${JSON.stringify(lines[block1Start])}`);
  console.log(`  end:    ${JSON.stringify(lines[block1End])}`);
  console.log(`  after:  ${JSON.stringify(lines[block1End + 2])}`);
}
if (block2Start >= 0) {
  console.log('\n--- Block 2 context ---');
  console.log(`  before: ${JSON.stringify(lines[block2Start - 1])}`);
  console.log(`  start:  ${JSON.stringify(lines[block2Start])}`);
  console.log(`  end:    ${JSON.stringify(lines[block2End])}`);
  console.log(`  after:  ${JSON.stringify(lines[block2End + 2])}`);
}

// Remove blocks
const newLines = lines.filter((_, i) => {
  if (block2End !== -1 && i >= block2Start && i <= block2End) return false;
  if (block1End !== -1 && i >= block1Start && i <= block1End) return false;
  return true;
});

fs.writeFileSync(path, newLines.join('\n'), 'utf8');
console.log(`\nRemoved ${block1End - block1Start + 1 + block2End - block2Start + 1} orphaned lines`);
console.log(`Original: ${lines.length} lines -> New: ${newLines.length} lines`);
