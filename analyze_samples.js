const pdf = require('pdf-parse');
const fs = require('fs');
const path = require('path');

async function analyzePDFSample(filePath) {
  try {
    const buffer = fs.readFileSync(filePath);
    const data = await pdf(buffer);
    
    console.log(`\n=== ${path.basename(filePath)} ===`);
    console.log(`Pages: ${data.numpages}`);
    console.log(`Text length: ${data.text.length}`);
    console.log(`First 500 characters:`);
    console.log(data.text.substring(0, 500));
    console.log(`\n--- Looking for dates ---`);
    
    // Test our date patterns
    const datePatterns = [
      /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b/gi,
      /\b\d{1,2}\/\d{1,2}\/\d{4}\b/g,
      /\b\d{4}-\d{1,2}-\d{1,2}\b/g
    ];
    
    datePatterns.forEach((pattern, i) => {
      const matches = data.text.match(pattern);
      console.log(`Pattern ${i + 1}: ${pattern} -> ${matches ? matches.slice(0, 3) : 'no matches'}`);
    });
    
    // Look for amounts
    console.log(`\n--- Looking for amounts ---`);
    const amountMatches = data.text.match(/\$(\d+\.\d{2})/g);
    console.log(`Amounts found: ${amountMatches ? amountMatches.slice(0, 5) : 'none'}`);
    
  } catch (error) {
    console.error(`Error processing ${filePath}:`, error.message);
  }
}

async function main() {
  const sampleFiles = [
    'Receipt Samples/Amazon $179.22.pdf',
    'Receipt Samples/DoorDash $220.56.pdf', 
    'Receipt Samples/Instacart $149.64.pdf'
  ];
  
  for (const file of sampleFiles) {
    await analyzePDFSample(file);
  }
}

main();
