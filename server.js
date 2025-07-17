const express = require('express');
const multer = require('multer');
const cors = require('cors');
const pdf = require('pdf-parse');

const app = express();
const PORT = process.env.PORT || 10000;

// CORS configuration for Chrome extensions
app.use(cors({
  origin: true, // Allow all origins
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

// Additional CORS headers for preflight requests
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

app.use(express.json());

// Configure multer for file uploads with much smaller limit
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 } // Reduced to 2MB limit
});

// Extract vendor from text
function extractVendor(text) {
  const vendorPatterns = [
    // Amazon-specific patterns (highest priority)
    /Amazon\.com/i,
    /amazon\.com/i,
    /Order Details[\s\S]*?amazon/i,
    
    // Instacart-specific patterns
    /instacart/i,
    /Instacart/i,
    
    // Other major platforms
    /doordash/i,
    /uber\s*eats/i,
    /grubhub/i,
    
    // Specific companies (case insensitive)
    /(?:^|\s)(starbucks|walmart|target|costco|home depot|best buy|apple|microsoft|google|uber|lyft|mcdonalds|subway|chipotle|safeway|whole foods)(?:\s|$)/i,
    
    // Email-based detection (company from email domain)
    /@([a-zA-Z0-9\-]+)\.(com|net|org)/i,
    
    // Order confirmation patterns
    /([A-Za-z0-9\s&]+)\s+Order\s+Confirmation/i,
    
    // Thank you patterns
    /Thank you for shopping at\s+([A-Za-z0-9\s&]+)/i,
    
    // Generic business patterns (lowest priority)
    /(?:^|\s)([A-Z][a-zA-Z\s&]+?)\s+(?:Store|Inc|LLC|Corp|Co\.)/i
  ];
  
  // Filter out delivery status text and other noise
  const blacklistPatterns = [
    /arriving/i,
    /package/i,
    /delivered/i,
    /shipping/i,
    /out for/i,
    /expected/i,
    /tracking/i,
    /order placed/i,
    /ship to/i,
    /payment method/i
  ];
  
  for (const pattern of vendorPatterns) {
    const match = text.match(pattern);
    if (match) {
      let vendor = match[1] || match[0];
      vendor = vendor.trim();
      
      // Clean up common suffixes and prefixes
      vendor = vendor.replace(/\s+(Inc|LLC|Corp|Co\.|Store|Order|Confirmation)$/i, '');
      vendor = vendor.replace(/^(Order|Details|www\.|https?:\/\/)/i, '');
      
      // Check if this matches any blacklisted terms
      const isBlacklisted = blacklistPatterns.some(blackPattern => 
        blackPattern.test(vendor)
      );
      
      if (!isBlacklisted && vendor.length > 1) {
        // Capitalize properly
        return vendor.charAt(0).toUpperCase() + vendor.slice(1).toLowerCase();
      }
    }
  }
  
  return null;
}

// Extract amount from text
function extractAmount(text) {
  const amountPatterns = [
    // Most specific patterns first
    /Total[:\s]*\$(\d+\.\d{2})/i,
    /Grand Total[:\s]*\$(\d+\.\d{2})/i,
    /total[:\s]*\$(\d+\.\d{2})/i,
    /grand total[:\s]*\$(\d+\.\d{2})/i,
    
    // Payment patterns
    /Payment[:\s]*\$(\d+\.\d{2})/i,
    /Amount[:\s]*\$(\d+\.\d{2})/i,
    
    // Generic dollar patterns (less specific) - removed global flag
    /\$(\d+\.\d{2})/i
  ];
  
  const amounts = [];
  for (const pattern of amountPatterns) {
    const match = pattern.exec(text);
    if (match) {
      const amount = parseFloat(match[1]);
      if (amount > 0) {
        amounts.push(amount);
      }
    }
  }
  
  // Use the largest amount found (likely the total)
  if (amounts.length > 0) {
    return Math.max(...amounts).toFixed(2);
  }
  
  return null;
}

// Parse filename for vendor, amount, and date info
function parseFilename(filename) {
  console.log('  parseFilename called with:', filename);
  const result = { vendor: null, amount: null, date: null };
  
  // Common filename patterns
  const patterns = [
    // "Instacart $304.66.pdf" (vendor space amount)
    /^([A-Za-z\s]+?)\s+\$(\d+\.\d{2})/i,
    
    // "Instacart - $172.51.pdf" (vendor dash amount)
    /^([A-Za-z\s]+?)\s*-\s*\$(\d+\.\d{2})/i,
    
    // "Amazon_2025-07-10_$29.99.pdf"
    /^([A-Za-z\s]+?)_(\d{4}-\d{2}-\d{2})_\$(\d+\.\d{2})/i,
    
    // "Starbucks Receipt $15.67 2025-07-15.pdf"
    /^([A-Za-z\s]+?).*?\$(\d+\.\d{2}).*?(\d{4}-\d{2}-\d{2})/i,
    
    // "Receipt_2025-07-15.pdf" (date only)
    /Receipt.*?(\d{4}-\d{2}-\d{2})/i,
    
    // General vendor patterns (no amount)
    /^([A-Za-z\s]+)/i
  ];
  
  console.log('  Testing', patterns.length, 'patterns...');
  
  for (let i = 0; i < patterns.length; i++) {
    const pattern = patterns[i];
    const match = filename.match(pattern);
    console.log('    Pattern', i + 1, ':', pattern, '-> Match:', match);
    
    if (match) {
      console.log('      Match groups:', match);
      
      if (match[1] && !result.vendor) {
        const rawVendor = match[1].trim()
          .replace(/\s*(receipt|order|invoice)\s*/i, '')
          .replace(/\s+/g, ' ')
          .trim();
        result.vendor = rawVendor;
        console.log('      Set vendor:', rawVendor);
      }
      
      // Look for amount in different capture groups
      if (match[2] && match[2].includes('.') && !result.amount) {
        result.amount = match[2];
        console.log('      Set amount from group 2:', match[2]);
      } else if (match[3] && match[3].includes('.') && !result.amount) {
        result.amount = match[3];
        console.log('      Set amount from group 3:', match[3]);
      }
      
      // Look for date in different capture groups
      if (match[2] && match[2].includes('-') && !result.date) {
        result.date = match[2];
        console.log('      Set date from group 2:', match[2]);
      } else if (match[3] && match[3].includes('-') && !result.date) {
        result.date = match[3];
        console.log('      Set date from group 3:', match[3]);
      } else if (match[1] && match[1].includes('-') && !result.date) {
        result.date = match[1];
        console.log('      Set date from group 1:', match[1]);
      }
      
      console.log('      Result so far:', result);
      
      if (result.vendor || result.amount || result.date) {
        console.log('      Breaking because we found something');
        break;
      }
    }
  }
  
  console.log('  Final parseFilename result:', result);
  return result;
}

// Extract date from text
function extractDate(text) {
  const datePatterns = [
    // "June 23rd, 2025" format (with ordinal)
    /((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th),\s+\d{4})/gi,
    
    // "placed on June 23rd, 2025" format
    /placed on\s+((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th),\s+\d{4})/gi,
    
    // "delivered on June 23rd, 2025" format
    /delivered on\s+((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th),\s+\d{4})/gi,
    
    // MM/DD/YYYY format
    /(\d{1,2}\/\d{1,2}\/\d{4})/g,
    // MM-DD-YYYY format
    /(\d{1,2}-\d{1,2}-\d{4})/g,
    // YYYY-MM-DD format
    /(\d{4}-\d{1,2}-\d{1,2})/g,
    // Month DD, YYYY format
    /((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4})/gi,
    // Mon DD, YYYY format
    /((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4})/gi,
    // DD/MM/YYYY format (less common in US)
    /(\d{1,2}\/\d{1,2}\/\d{4})/g
  ];
  
  const dates = [];
  for (const pattern of datePatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const dateStr = match[1];
      const date = new Date(dateStr);
      
      // Check if date is valid and not in the future
      if (!isNaN(date.getTime()) && date <= new Date()) {
        dates.push(date);
      }
    }
  }
  
  // Return the most recent valid date found
  if (dates.length > 0) {
    const mostRecentDate = new Date(Math.max(...dates.map(d => d.getTime())));
    return mostRecentDate.toISOString().split('T')[0]; // Return YYYY-MM-DD format
  }
  
  return null;
}

// Main parsing endpoint
app.post('/parse-receipt', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No PDF file uploaded' });
    }
    
    console.log('Processing PDF:', req.file.originalname, 'Size:', req.file.size);
    
    // Parse PDF to extract text
    console.log('Parsing PDF content...');
    const pdfData = await pdf(req.file.buffer, {
      max: 3, // Try more pages to get complete text
      version: 'v1.10.100',
      normalizeWhitespace: true
    });
    
    const text = pdfData.text;
    console.log('Extracted text length:', text.length);
    console.log('First 200 chars:', text.substring(0, 200));
    
    // Clear buffer to free memory
    req.file.buffer = null;
    
    // Extract vendor, amount, and date from PDF text
    console.log('--- PDF TEXT EXTRACTION ---');
    let vendor = extractVendor(text);
    let amount = extractAmount(text);
    let receiptDate = extractDate(text);
    console.log('PDF extraction results:', { vendor, amount, receiptDate });
    
    // Check fallback condition
    console.log('--- FALLBACK CHECK ---');
    console.log('Vendor found:', !!vendor, 'Amount found:', !!amount);
    console.log('Should trigger fallback:', !vendor || !amount);
    
    // If PDF text extraction failed to find vendor/amount, try filename parsing
    if (!vendor || !amount) {
      console.log('--- FILENAME PARSING FALLBACK ---');
      console.log('Original filename:', req.file.originalname);
      const filenameInfo = parseFilename(req.file.originalname);
      console.log('Filename parsing result:', filenameInfo);
      
      const oldVendor = vendor;
      const oldAmount = amount;
      const oldDate = receiptDate;
      
      vendor = vendor || filenameInfo.vendor;
      amount = amount || filenameInfo.amount;
      receiptDate = receiptDate || filenameInfo.date;
      
      console.log('Fallback applied:');
      console.log('  Vendor:', oldVendor, '->', vendor);
      console.log('  Amount:', oldAmount, '->', amount);
      console.log('  Date:', oldDate, '->', receiptDate);
    } else {
      console.log('--- NO FALLBACK NEEDED ---');
    }
    
    console.log('--- FINAL RESULTS ---');
    console.log('Extracted:', { vendor, amount, receiptDate });
    
    // Create output filename with proper format
    let outputFilename = '';
    if (vendor && amount) {
      const dateStr = receiptDate || new Date().toISOString().split('T')[0];
      outputFilename = `${vendor} ${dateStr} $${amount}.pdf`;
    } else {
      // Fallback naming
      const dateStr = receiptDate || new Date().toISOString().split('T')[0];
      outputFilename = `Receipt ${dateStr}.pdf`;
    }
    
    // Memory cleanup
    req.file = null;
    
    res.json({ 
      vendor, 
      amount,
      receiptDate,
      filename: outputFilename,
      success: !!(vendor && amount),
      textLength: text.length
    });
    
  } catch (error) {
    console.error('Error processing PDF:', error);
    
    // Memory cleanup on error
    req.file = null;
    
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Receipt parser server running on port ${PORT}`);
});
