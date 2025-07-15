const express = require('express');
const multer = require('multer');
const pdf = require('pdf-parse');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Memory limit is handled by package.json start script

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
    // Specific companies
    /(?:^|\s)(amazon|doordash|2modern|dynamo donut|starbucks|walmart|target|costco|home depot|best buy|apple|microsoft|google|uber|lyft|grubhub|mcdonalds|subway|chipotle)(?:\s|$)/i,
    
    // Email-based detection
    /(?:^|\s)([A-Za-z0-9\s&]+)\s+<[^>]+@([^>]+)>/i,
    
    // Order confirmation patterns
    /([A-Za-z0-9\s&]+)\s+Order\s+Confirmation/i,
    
    // Thank you patterns
    /Thank you for shopping at\s+([A-Za-z0-9\s&]+)/i,
    
    // Generic business patterns
    /(?:^|\s)([A-Z][a-zA-Z\s&]+?)\s+(?:Furniture|Lighting|Food|Delivery|Coffee|Restaurant|Store|Inc|LLC|Corp|Co\.)/i
  ];
  
  for (const pattern of vendorPatterns) {
    const match = text.match(pattern);
    if (match) {
      let vendor = match[1].trim();
      // Clean up common suffixes
      vendor = vendor.replace(/\s+(Inc|LLC|Corp|Co\.|Furniture|Lighting|Food|Delivery)$/i, '');
      return vendor;
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
    
    // Generic dollar patterns (less specific)
    /\$(\d+\.\d{2})/g
  ];
  
  const amounts = [];
  for (const pattern of amountPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
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

// Extract date from text
function extractDate(text) {
  const datePatterns = [
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
    
    // Add timeout to prevent hanging
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('PDF parsing timeout')), 30000);
    });
    
    // Parse PDF with ultra memory-efficient options
    const parsePromise = pdf(req.file.buffer, {
      pagerender: false,  // Don't render pages, just extract text
      normalizeWhitespace: false,  // Disable to save memory
      disableCombineTextItems: true,
      max: 1  // Only process first page for extreme memory saving
    });
    
    const data = await Promise.race([parsePromise, timeoutPromise]);
    const text = data.text;
    
    // Clear the buffer from memory immediately
    req.file.buffer = null;
    
    console.log('Extracted text length:', text.length);
    console.log('Text preview:', text.substring(0, 500));
    
    // Extract vendor, amount, and date
    const vendor = extractVendor(text);
    const amount = extractAmount(text);
    const receiptDate = extractDate(text);
    
    console.log('Extracted:', { vendor, amount, receiptDate });
    
    // Create filename with proper format
    let filename = '';
    if (vendor && amount) {
      const dateStr = receiptDate || new Date().toISOString().split('T')[0];
      filename = `${vendor}_${dateStr}_$${amount}.pdf`;
    } else {
      // Fallback naming
      const dateStr = receiptDate || new Date().toISOString().split('T')[0];
      filename = `Receipt_${dateStr}.pdf`;
    }
    
    // Force garbage collection if available
    if (global.gc) {
      global.gc();
    }
    
    res.json({ 
      vendor, 
      amount,
      receiptDate,
      filename,
      success: !!(vendor && amount),
      textLength: text.length
    });
    
  } catch (error) {
    console.error('Error processing PDF:', error);
    
    // Force garbage collection on error
    if (global.gc) {
      global.gc();
    }
    
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Receipt parser server running on port ${PORT}`);
});
