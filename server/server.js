const express = require('express');
const multer = require('multer');
const cors = require('cors');
const pdf = require('pdf-parse');
const session = require('express-session');
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 10000;

// Google OAuth configuration
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI || 'https://bootleg-expensify.onrender.com/auth/google/callback'
);

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'expense-gadget-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false } // Set to true in production with HTTPS
}));

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

// Analyze text context to determine business category
function analyzeContext(text) {
  const contextPatterns = [
    // Grocery delivery (Instacart, etc.)
    {
      category: 'Groceries',
      patterns: [
        /shopper picked items/i,
        /replacements you approved/i,
        /delivered your order/i,
        /farmers market/i,
        /grocery/i,
        /produce/i,
        /organic/i
      ]
    },
    
    // Food delivery (DoorDash, Uber Eats, etc.)
    {
      category: 'Food Delivery',
      patterns: [
        /driver/i,
        /restaurant/i,
        /delivered.*food/i,
        /pickup.*ready/i,
        /estimated delivery/i
      ]
    },
    
    // Coffee shops
    {
      category: 'Coffee',
      patterns: [
        /barista/i,
        /latte/i,
        /cappuccino/i,
        /espresso/i,
        /coffee/i,
        /frappuccino/i
      ]
    },
    
    // Retail/Shopping
    {
      category: 'Retail',
      patterns: [
        /order confirmation/i,
        /shipped/i,
        /tracking/i,
        /warehouse/i,
        /retail/i
      ]
    }
  ];
  
  for (const context of contextPatterns) {
    const matches = context.patterns.filter(pattern => pattern.test(text));
    if (matches.length >= 2) { // Need at least 2 matching patterns for confidence
      console.log(`Context analysis: ${context.category} (${matches.length} matches)`);
      return context.category;
    }
  }
  
  return null;
}

// Extract vendor from text
function extractVendor(text) {
  console.log('  Extracting vendor from text...');
  
  // Split text into sections to prioritize header/top content
  const lines = text.split('\n');
  const topSection = lines.slice(0, Math.min(10, lines.length)).join('\n'); // First 10 lines
  const fullText = text;
  
  console.log('    Top section:', topSection.substring(0, 200));
  
  // Platform-specific patterns (highest priority) - look for these first
  const platformPatterns = [
    {
      name: 'Instacart',
      patterns: [
        /instacart/i,
        /your shopper/i,
        /shopper.*picked/i,
        /delivery.*instacart/i,
        /instacart.*delivery/i
      ],
      confirmationPatterns: [
        /shopper/i,
        /delivery/i,
        /groceries/i,
        /replacement/i
      ]
    },
    {
      name: 'Amazon',
      patterns: [
        /amazon\.com/i,
        /amazon/i,
        /order.*amazon/i,
        /amazon.*order/i
      ],
      confirmationPatterns: [
        /order/i,
        /shipped/i,
        /prime/i,
        /fulfillment/i
      ]
    },
    {
      name: 'DoorDash',
      patterns: [
        /doordash/i,
        /door.*dash/i,
        /dasher/i
      ],
      confirmationPatterns: [
        /restaurant/i,
        /delivery/i,
        /dasher/i
      ]
    },
    {
      name: 'Uber Eats',
      patterns: [
        /uber\s*eats/i,
        /ubereats/i
      ],
      confirmationPatterns: [
        /delivery/i,
        /restaurant/i,
        /driver/i
      ]
    },
    {
      name: 'Grubhub',
      patterns: [
        /grubhub/i,
        /grub.*hub/i
      ],
      confirmationPatterns: [
        /delivery/i,
        /restaurant/i,
        /driver/i
      ]
    }
  ];
  
  // Check platform-specific patterns first
  for (const platform of platformPatterns) {
    console.log(`    Checking for ${platform.name}...`);
    
    // Check if any platform pattern matches
    const hasMainPattern = platform.patterns.some(pattern => pattern.test(fullText));
    
    if (hasMainPattern) {
      console.log(`      Found ${platform.name} main pattern`);
      
      // Confirm with secondary patterns
      const confirmationMatches = platform.confirmationPatterns.filter(pattern => pattern.test(fullText));
      console.log(`      Confirmation patterns matched: ${confirmationMatches.length}/${platform.confirmationPatterns.length}`);
      
      if (confirmationMatches.length >= 1) {
        console.log(`      Confirmed ${platform.name}!`);
        return platform.name;
      }
    }
  }
  
  // Store-specific patterns (medium priority) - look in top section first
  const storePatterns = [
    // Coffee shops
    { name: 'Starbucks', patterns: [/starbucks/i, /sbux/i] },
    { name: 'Dunkin', patterns: [/dunkin/i, /dunkin.*donuts/i] },
    
    // Grocery stores
    { name: 'Walmart', patterns: [/walmart/i, /wal.*mart/i] },
    { name: 'Target', patterns: [/target/i] },
    { name: 'Costco', patterns: [/costco/i] },
    { name: 'Safeway', patterns: [/safeway/i] },
    { name: 'Whole Foods', patterns: [/whole\s*foods/i, /wholefoods/i] },
    
    // Fast food
    { name: 'McDonalds', patterns: [/mcdonald/i, /mcdonalds/i] },
    { name: 'Subway', patterns: [/subway/i] },
    { name: 'Chipotle', patterns: [/chipotle/i] },
    
    // Retail
    { name: 'Home Depot', patterns: [/home\s*depot/i, /homedepot/i] },
    { name: 'Best Buy', patterns: [/best\s*buy/i, /bestbuy/i] },
    
    // Tech companies (be careful with these)
    { name: 'Apple Store', patterns: [/apple\s*store/i, /apple.*retail/i] },
    { name: 'Microsoft Store', patterns: [/microsoft\s*store/i] }
  ];
  
  // Check store patterns in top section first, then full text
  for (const searchText of [topSection, fullText]) {
    for (const store of storePatterns) {
      for (const pattern of store.patterns) {
        if (pattern.test(searchText)) {
          console.log(`      Found store: ${store.name} in ${searchText === topSection ? 'top section' : 'full text'}`);
          return store.name;
        }
      }
    }
  }
  
  // Email-based detection patterns
  const emailPattern = /@([a-zA-Z0-9\-]+)\.(com|net|org)/i;
  const emailMatch = topSection.match(emailPattern);
  if (emailMatch) {
    const domain = emailMatch[1];
    // Convert domain to readable name
    const domainToName = {
      'amazon': 'Amazon',
      'instacart': 'Instacart',
      'doordash': 'DoorDash',
      'uber': 'Uber Eats',
      'grubhub': 'Grubhub',
      'starbucks': 'Starbucks',
      'target': 'Target',
      'walmart': 'Walmart'
    };
    
    if (domainToName[domain.toLowerCase()]) {
      console.log(`      Found vendor from email domain: ${domainToName[domain.toLowerCase()]}`);
      return domainToName[domain.toLowerCase()];
    }
  }
  
  // Generic business patterns (lowest priority) - only in top section
  const businessPatterns = [
    /([A-Z][a-zA-Z\s&]+?)\s+(?:Store|Inc|LLC|Corp|Co\.|Restaurant|Cafe)/i,
    /([A-Z][a-zA-Z\s&]+?)\s+Order\s+Confirmation/i,
    /Thank you for shopping at\s+([A-Za-z0-9\s&]+)/i
  ];
  
  for (const pattern of businessPatterns) {
    const match = topSection.match(pattern);
    if (match && match[1]) {
      let vendor = match[1].trim();
      
      // Clean up common suffixes and prefixes
      vendor = vendor.replace(/\s+(Inc|LLC|Corp|Co\.|Store|Order|Confirmation|Restaurant|Cafe)$/i, '');
      vendor = vendor.replace(/^(Order|Details|www\.|https?:\/\/)/i, '');
      
      // Filter out common product names and noise
      const productBlacklist = [
        /apple/i, // Common product, not the company
        /banana/i,
        /orange/i,
        /chicken/i,
        /beef/i,
        /pork/i,
        /fish/i,
        /bread/i,
        /milk/i,
        /cheese/i,
        /arriving/i,
        /package/i,
        /delivered/i,
        /shipping/i,
        /tracking/i,
        /payment/i,
        /total/i,
        /subtotal/i,
        /tax/i,
        /fee/i,
        /tip/i
      ];
      
      const isProduct = productBlacklist.some(blackPattern => blackPattern.test(vendor));
      
      if (!isProduct && vendor.length > 1 && vendor.length < 30) {
        console.log(`      Found business vendor: ${vendor}`);
        return vendor.charAt(0).toUpperCase() + vendor.slice(1).toLowerCase();
      }
    }
  }
  
  console.log('      No vendor found');
  return null;
}

// Extract amount from text
function extractAmount(text) {
  console.log('  Extracting amount from text...');
  
  // First, look for subtotal as an indicator
  const subtotalMatch = text.match(/(?:Sub\s*)?total[:\s]*\$(\d+\.\d{2})/i);
  if (subtotalMatch) {
    console.log('    Found subtotal:', subtotalMatch[1]);
    console.log('    Looking for final total after subtotal...');
    
    // Extract text after the subtotal to focus search
    const subtotalIndex = text.indexOf(subtotalMatch[0]);
    const textAfterSubtotal = text.substring(subtotalIndex);
    console.log('    Text after subtotal (first 200 chars):', textAfterSubtotal.substring(0, 200));
    
    // Look for final total patterns in the text after subtotal
    const finalTotalPatterns = [
      /(?:Grand\s+|Final\s+|Order\s+)Total[:\s]*\$(\d+\.\d{2})/i, // Requires prefix to avoid "Subtotal"
      /\bTotal\$(\d+\.\d{2})/i, // Word boundary to avoid "Subtotal"
      /(?:Amount\s+)?Charged[:\s]*\$(\d+\.\d{2})/i,
      /(?:Total\s+)?charged[:\s]*\$(\d+\.\d{2})/i,
      /You\s+(?:paid|owe)[:\s]*\$(\d+\.\d{2})/i,
      /(?:Card\s+)?Charged[:\s]*\$(\d+\.\d{2})/i,
      /(?:Total\s+)?Due[:\s]*\$(\d+\.\d{2})/i
    ];
    
    for (let i = 0; i < finalTotalPatterns.length; i++) {
      const pattern = finalTotalPatterns[i];
      const match = pattern.exec(textAfterSubtotal);
      console.log(`      Final total pattern ${i + 1}: ${pattern} -> ${match ? '$' + match[1] : 'no match'}`);
      
      if (match) {
        const amount = parseFloat(match[1]);
        const subtotalAmount = parseFloat(subtotalMatch[1]);
        
        // Final total should be >= subtotal (with taxes, fees, etc.)
        if (amount >= subtotalAmount) {
          console.log(`    Found final total: $${amount.toFixed(2)} (subtotal was $${subtotalAmount.toFixed(2)})`);
          return amount.toFixed(2);
        } else {
          console.log(`    Skipping amount $${amount.toFixed(2)} (less than subtotal $${subtotalAmount.toFixed(2)})`);
        }
      }
    }
    
    console.log('    No final total found after subtotal, using subtotal as fallback');
    return subtotalMatch[1];
  }
  
  // If no subtotal found, use the original priority-based approach
  console.log('    No subtotal found, using standard extraction...');
  
  // High-priority patterns (most likely to be the actual total)
  const highPriorityPatterns = [
    // Various total formats (excluding subtotal)
    /(?:Grand\s+)?Total[:\s]*\$(\d+\.\d{2})/i,
    /(?:Order\s+)?Total[:\s]*\$(\d+\.\d{2})/i,
    /(?:Final\s+)?Total[:\s]*\$(\d+\.\d{2})/i,
    
    // Payment and charge patterns
    /(?:Amount\s+)?Charged[:\s]*\$(\d+\.\d{2})/i,
    /(?:Total\s+)?Amount[:\s]*\$(\d+\.\d{2})/i,
    /(?:Final\s+)?Payment[:\s]*\$(\d+\.\d{2})/i,
    
    // Receipt-specific patterns
    /You\s+(?:paid|owe)[:\s]*\$(\d+\.\d{2})/i,
    /(?:Card\s+)?Charged[:\s]*\$(\d+\.\d{2})/i,
    /(?:Total\s+)?Due[:\s]*\$(\d+\.\d{2})/i
  ];
  
  // Medium-priority patterns
  const mediumPriorityPatterns = [
    // Context-aware patterns (look for $ near total indicators)
    /total.*?\$(\d+\.\d{2})/i,
    /\$(\d+\.\d{2}).*?total/i,
    /paid.*?\$(\d+\.\d{2})/i,
    /\$(\d+\.\d{2}).*?paid/i
  ];
  
  // Low-priority patterns (last resort)
  const lowPriorityPatterns = [
    /\$(\d+\.\d{2})/i
  ];
  
  const patternGroups = [
    { name: 'high-priority', patterns: highPriorityPatterns },
    { name: 'medium-priority', patterns: mediumPriorityPatterns },
    { name: 'low-priority', patterns: lowPriorityPatterns }
  ];
  
  // Try each group in order, return first successful match
  for (const group of patternGroups) {
    console.log(`    Trying ${group.name} patterns...`);
    const amounts = [];
    
    for (let i = 0; i < group.patterns.length; i++) {
      const pattern = group.patterns[i];
      const match = pattern.exec(text);
      console.log(`      Pattern ${i + 1}: ${pattern} -> ${match ? '$' + match[1] : 'no match'}`);
      
      if (match) {
        const amount = parseFloat(match[1]);
        if (amount > 0) {
          amounts.push(amount);
        }
      }
    }
    
    if (amounts.length > 0) {
      // For high-priority patterns, use the first match (most specific)
      // For others, use the largest amount
      const finalAmount = group.name === 'high-priority' ? amounts[0] : Math.max(...amounts);
      console.log(`    Found ${group.name} amount: $${finalAmount.toFixed(2)}`);
      return finalAmount.toFixed(2);
    }
  }
  
  console.log('    No amount found');
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
        
        // Don't set vendor if it looks like a date (YYYY-MM-DD format)
        if (!/^\d{4}-\d{2}-\d{2}$/.test(rawVendor)) {
          result.vendor = rawVendor;
          console.log('      Set vendor:', rawVendor);
        } else {
          console.log('      Skipping vendor (looks like date):', rawVendor);
        }
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
  console.log('  Extracting date from text...');
  
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
    // Month DD, YYYY format (without ordinal)
    /((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4})/gi,
    // Mon DD, YYYY format
    /((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4})/gi
  ];
  
  const dates = [];
  for (let i = 0; i < datePatterns.length; i++) {
    const pattern = datePatterns[i];
    console.log(`    Testing pattern ${i + 1}: ${pattern}`);
    
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const dateStr = match[1];
      console.log(`      Found date string: "${dateStr}"`);
      
      // Remove ordinal suffixes before parsing
      const cleanDateStr = dateStr.replace(/(\d{1,2})(st|nd|rd|th)/g, '$1');
      console.log(`      Cleaned date string: "${cleanDateStr}"`);
      
      const date = new Date(cleanDateStr);
      console.log(`      Parsed date: ${date}`);
      
      // Check if date is valid and not in the future
      if (!isNaN(date.getTime()) && date <= new Date()) {
        console.log(`      Valid date found: ${date.toISOString().split('T')[0]}`);
        dates.push(date);
      } else {
        console.log(`      Invalid or future date, skipping`);
      }
    }
  }
  
  console.log(`  Total valid dates found: ${dates.length}`);
  
  // Return the most recent valid date found
  if (dates.length > 0) {
    const mostRecentDate = new Date(Math.max(...dates.map(d => d.getTime())));
    const formattedDate = mostRecentDate.toISOString().split('T')[0];
    console.log(`  Returning most recent date: ${formattedDate}`);
    return formattedDate;
  }
  
  console.log('  No valid dates found');
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
      max: 5, // Scan multiple pages to find totals (usually on last page)
      version: 'v1.10.100',
      normalizeWhitespace: false, // Try without normalization
      verbosity: 0 // Reduce noise
    });
    
    const text = pdfData.text;
    console.log('Extracted text length:', text.length);
    console.log('First 200 chars:', text.substring(0, 200));
    
    // Search for date patterns in the entire text
    const dateKeywords = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December', 'placed', 'delivered', 'rd', 'th', 'st', 'nd'];
    const foundKeywords = dateKeywords.filter(keyword => text.toLowerCase().includes(keyword.toLowerCase()));
    console.log('Date-related keywords found:', foundKeywords);
    
    if (foundKeywords.length > 0) {
      console.log('Full text (searching for dates):', text);
    }
    
    // Store original buffer for Google Drive upload
    const originalBuffer = req.file.buffer;
    
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
    
    // If PDF text extraction failed to find vendor/amount, try fallback methods
    if (!vendor || !amount) {
      console.log('--- FALLBACK METHODS ---');
      
      // Try filename parsing first
      console.log('Trying filename parsing...');
      console.log('Original filename:', req.file.originalname);
      const filenameInfo = parseFilename(req.file.originalname);
      console.log('Filename parsing result:', filenameInfo);
      
      // If still no vendor (or bad vendor), try context analysis
      const hasValidVendor = vendor && vendor.length > 0;
      const hasValidFilenameVendor = filenameInfo.vendor && filenameInfo.vendor.length > 0;
      
      if (!hasValidVendor && !hasValidFilenameVendor && text.length > 50) {
        console.log('Trying context analysis...');
        const contextVendor = analyzeContext(text);
        if (contextVendor) {
          filenameInfo.vendor = contextVendor;
          console.log('Context analysis result:', contextVendor);
        }
      } else {
        console.log('Skipping context analysis - valid vendor found');
      }
      
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
    
    // Upload to Google Drive if user is authenticated
    let driveUpload = null;
    if (req.session.googleTokens) {
      console.log('Uploading to Google Drive...');
      try {
        driveUpload = await uploadToGoogleDrive(originalBuffer, outputFilename, receiptDate, req.session.googleTokens);
        console.log('Google Drive upload result:', driveUpload);
      } catch (driveError) {
        console.error('Google Drive upload failed:', driveError);
        driveUpload = { success: false, error: driveError.message };
      }
    }
    
    // Memory cleanup
    req.file = null;
    
    res.json({ 
      vendor, 
      amount,
      receiptDate,
      filename: outputFilename,
      success: !!(vendor && amount),
      textLength: text.length,
      googleDrive: driveUpload
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

// Google Drive authentication routes
app.get('/auth/google', (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/drive.file'],
    prompt: 'consent'
  });
  res.redirect(authUrl);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    
    // Store tokens in session
    req.session.googleTokens = tokens;
    
    res.send(`
      <html>
        <body>
          <h2>✅ Google Drive Connected Successfully!</h2>
          <p>You can now close this window and return to the extension.</p>
          <script>window.close();</script>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('Error getting Google tokens:', error);
    res.status(500).send(`
      <html>
        <body>
          <h2>❌ Authentication Failed</h2>
          <p>Error: ${error.message}</p>
        </body>
      </html>
    `);
  }
});

// Check authentication status
app.get('/auth/status', (req, res) => {
  const isAuthenticated = !!(req.session.googleTokens);
  res.json({ authenticated: isAuthenticated });
});

// Create Google Drive folder and upload file
async function uploadToGoogleDrive(fileBuffer, fileName, receiptDate, tokens) {
  try {
    // Set credentials
    oauth2Client.setCredentials(tokens);
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    
    // Find or create "Expense Receipts" folder
    let mainFolderId;
    
    // Search for existing main folder
    const mainFolderSearch = await drive.files.list({
      q: "name='Expense Receipts' and mimeType='application/vnd.google-apps.folder'",
      fields: 'files(id, name)'
    });
    
    if (mainFolderSearch.data.files.length > 0) {
      mainFolderId = mainFolderSearch.data.files[0].id;
    } else {
      // Create main folder
      const mainFolderMetadata = {
        name: 'Expense Receipts',
        mimeType: 'application/vnd.google-apps.folder'
      };
      
      const mainFolder = await drive.files.create({
        resource: mainFolderMetadata,
        fields: 'id'
      });
      mainFolderId = mainFolder.data.id;
    }
    
    // Create month/year folder name
    const date = receiptDate ? new Date(receiptDate) : new Date();
    const monthNames = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ];
    const monthFolderName = `${monthNames[date.getMonth()]} ${date.getFullYear()}`;
    
    console.log(`Looking for month folder: ${monthFolderName}`);
    
    // Find or create month folder within main folder
    let monthFolderId;
    
    // Search for existing month folder
    const monthFolderSearch = await drive.files.list({
      q: `name='${monthFolderName}' and mimeType='application/vnd.google-apps.folder' and '${mainFolderId}' in parents`,
      fields: 'files(id, name)'
    });
    
    if (monthFolderSearch.data.files.length > 0) {
      monthFolderId = monthFolderSearch.data.files[0].id;
      console.log(`Found existing month folder: ${monthFolderName}`);
    } else {
      // Create month folder
      const monthFolderMetadata = {
        name: monthFolderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [mainFolderId]
      };
      
      const monthFolder = await drive.files.create({
        resource: monthFolderMetadata,
        fields: 'id'
      });
      monthFolderId = monthFolder.data.id;
      console.log(`Created new month folder: ${monthFolderName}`);
    }
    
    // Upload file to month folder
    const fileMetadata = {
      name: fileName,
      parents: [monthFolderId]
    };
    
    const media = {
      mimeType: 'application/pdf',
      body: require('stream').Readable.from(fileBuffer)
    };
    
    const file = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id, name, webViewLink'
    });
    
    console.log(`Uploaded ${fileName} to ${monthFolderName} folder`);
    
    return {
      success: true,
      fileId: file.data.id,
      fileName: file.data.name,
      monthFolder: monthFolderName,
      webViewLink: file.data.webViewLink
    };
    
  } catch (error) {
    console.error('Error uploading to Google Drive:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Receipt parser server running on port ${PORT}`);
});
