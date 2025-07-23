const express = require('express');
const multer = require('multer');
const cors = require('cors');
// const pdf = require('pdf-parse'); // No longer needed - we forward emails directly
const session = require('express-session');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const validator = require('validator');
const vision = require('@google-cloud/vision');

// AI service for email analysis (using OpenAI for now)
// In production, you'd set OPENAI_API_KEY environment variable
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;



const app = express();
const PORT = process.env.PORT || 10000;
const isProduction = process.env.NODE_ENV === 'production';

console.log('=== FORCING REDEPLOY - AUTH TOKEN ENDPOINT SHOULD BE AVAILABLE ===');

// Security middleware
app.use(helmet({
    crossOriginEmbedderPolicy: false, // Allow extension embedding
    contentSecurityPolicy: false // Let browser handle CSP for extensions
}));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    message: { error: 'Too many requests, please try again later' },
    standardHeaders: true,
    legacyHeaders: false
});
app.use(limiter);

// Stricter rate limiting for expensive operations
const strictLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20, // Limit to 20 PDF operations per 15 minutes
    message: { error: 'Too many PDF operations, please try again later' }
});

// Track processed emails to prevent duplicates - persistent storage
const PROCESSED_EMAILS_FILE = path.join(__dirname, 'processed_emails.json');

// Load processed email IDs from file
function loadProcessedEmails() {
    try {
        if (fs.existsSync(PROCESSED_EMAILS_FILE)) {
            const data = fs.readFileSync(PROCESSED_EMAILS_FILE, 'utf8');
            return new Set(JSON.parse(data));
        }
    } catch (error) {
        console.error('Error loading processed emails:', error);
    }
    return new Set();
}

// Save processed email IDs to file
function saveProcessedEmails(emailIds) {
    try {
        fs.writeFileSync(PROCESSED_EMAILS_FILE, JSON.stringify([...emailIds]));
    } catch (error) {
        console.error('Error saving processed emails:', error);
    }
}

// Initialize processed emails set
const processedEmailIds = loadProcessedEmails();
console.log(`Loaded ${processedEmailIds.size} previously processed email IDs`);

// Basic caches for performance optimization
const gmailMessageCache = new Map(); // Cache Gmail message details for 1 hour
const vendorExtractionCache = new Map(); // Cache vendor extraction results
const amountExtractionCache = new Map(); // Cache amount extraction results

// Clear caches on startup to prevent stale data from affecting results
console.log('Clearing extraction caches on startup...');
vendorExtractionCache.clear();
amountExtractionCache.clear();

// Cache cleanup intervals (1 hour)
const CACHE_TTL = 60 * 60 * 1000;

// Clean up caches periodically
setInterval(() => {
    const now = Date.now();
    
    // Clean Gmail message cache
    for (const [key, value] of gmailMessageCache.entries()) {
        if (now - value.timestamp > CACHE_TTL) {
            gmailMessageCache.delete(key);
        }
    }
    
    // Clean vendor extraction cache
    for (const [key, value] of vendorExtractionCache.entries()) {
        if (now - value.timestamp > CACHE_TTL) {
            vendorExtractionCache.delete(key);
        }
    }
    
    // Clean amount extraction cache
    for (const [key, value] of amountExtractionCache.entries()) {
        if (now - value.timestamp > CACHE_TTL) {
            amountExtractionCache.delete(key);
        }
    }
    
    console.log(`Cache cleanup: Gmail:${gmailMessageCache.size}, Vendor:${vendorExtractionCache.size}, Amount:${amountExtractionCache.size}`);
}, CACHE_TTL);

console.log('Auth token endpoint available at /auth/token');

// Google OAuth configuration
const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || 'https://bootleg-expensify.onrender.com/auth/google/callback'
);

// Session configuration - warn if no proper secret but don't crash
if (!process.env.SESSION_SECRET) {
    console.warn('⚠️  SESSION_SECRET not set - using fallback (set SESSION_SECRET for production)');
}

app.use(session({
    secret: process.env.SESSION_SECRET || 'expense-gadget-fallback-' + Date.now(),
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: false, // Temporarily disable for debugging - extensions need special handling
        httpOnly: false, // Allow extension to access cookie
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
        sameSite: 'lax' // Change from 'none' to 'lax' for better compatibility
    }
}));

// CORS configuration for Chrome extensions - restrict to specific origins
const allowedOrigins = [
    'https://bootleg-expensify.onrender.com', // Your server
    /^chrome-extension:\/\/[a-z]{32}$/, // Chrome extension pattern
    /^moz-extension:\/\/[a-z0-9-]+$/, // Firefox extension pattern
];

if (!isProduction) {
    allowedOrigins.push('http://localhost:3000', 'http://localhost:10000');
}

app.use(cors({
    origin: (origin, callback) => {
        console.log(`🌐 CORS request from origin: ${origin || 'no origin'}`);
        
        // TEMPORARY: Allow all origins for debugging
        console.log(`🔧 Temporarily allowing all origins for debugging`);
        callback(null, true);
        
        // // Allow requests with no origin (mobile apps, etc)
        // if (!origin) return callback(null, true);
        
        // const isAllowed = allowedOrigins.some(allowed => {
        //     if (typeof allowed === 'string') return allowed === origin;
        //     return allowed.test(origin);
        // });
        
        // if (isAllowed) {
        //     callback(null, true);
        // } else {
        //     console.warn(`❌ Blocked CORS request from: ${origin}`);
        //     // Temporarily allow all origins for debugging - REMOVE IN PRODUCTION
        //     if (!isProduction) {
        //         console.warn(`🔧 Debug mode: allowing blocked origin anyway`);
        //         callback(null, true);
        //     } else {
        //         callback(new Error('Not allowed by CORS'));
        //     }
        // }
    },
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

// Request size limits
// Debug middleware to log all requests
app.use((req, res, next) => {
    console.log(`📞 ${req.method} ${req.url}`);
    console.log(`   Path: ${req.path}`);
    console.log(`   Origin: ${req.headers.origin || 'NO ORIGIN'}`);
    console.log(`   Referer: ${req.headers.referer || 'NO REFERER'}`);
    console.log(`   User-Agent: ${req.headers['user-agent']?.substring(0, 50)}...`);
    console.log(`   ----------------------------------------`);
    next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Configure multer for file uploads with much smaller limit
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024 } // Reduced to 2MB limit
});

// Input sanitization functions
function sanitizeText(text) {
    if (!text || typeof text !== 'string') return '';
    return validator.escape(text.trim().substring(0, 10000)); // Limit length and escape HTML
}

function sanitizeEmail(email) {
    if (!email || typeof email !== 'string') return '';
    return validator.isEmail(email) ? validator.normalizeEmail(email) : '';
}

function sanitizeFilename(filename) {
    if (!filename || typeof filename !== 'string') return '';
    // Remove dangerous characters and limit length
    return filename.replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 100);
}

// Error handling - don't leak sensitive information
function sanitizeError(error) {
    if (isProduction) {
        // In production, return generic error messages
        return { error: 'An error occurred processing your request' };
    }
    // In development, return more details but sanitize sensitive data
    const message = error.message || 'Unknown error';
    return { 
        error: message.replace(/\/[^\/\s]+\/[^\/\s]+\.js/g, '[FILE]') // Remove file paths
                     .replace(/api[_-]?key[s]?[:\s=]+[^\s]+/gi, 'API_KEY=[REDACTED]') // Remove API keys
    };
}



// Extract vendor from text (simplified fallback)
function extractVendor(text) {
    console.log('  Extracting vendor from text (fallback)...');
    
    // Check cache first - use a more unique cache key (hash of full text content)
    const textHash = require('crypto').createHash('md5').update(text).digest('hex').substring(0, 12);
    const cacheKey = `vendor_${textHash}`;
    const cached = vendorExtractionCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
        console.log('  📦 Using cached vendor extraction');
        return cached.result;
    }

    // Focus on top section of text where vendor info is most likely
    const topSection = text.split('\n').slice(0, 15).join('\n');
    const fullText = text;

    // Check for common vendors first (important for forwarded emails)
    const commonVendors = [
        { name: 'DoorDash', patterns: [/doordash/i, /door\s*dash/i, /dasher/i] },
        { name: 'Uber Eats', patterns: [/uber\s*eats/i, /ubereats/i] },
        { name: 'Grubhub', patterns: [/grubhub/i, /grub\s*hub/i] },
        { name: 'Instacart', patterns: [/instacart/i, /your shopper/i] },
        { name: 'Amazon', patterns: [/amazon/i, /amazon\.com/i] },
        { name: 'Starbucks', patterns: [/starbucks/i, /sbux/i] },
        { name: 'Target', patterns: [/target/i] },
        { name: 'Walmart', patterns: [/walmart/i, /wal\s*mart/i] }
    ];

    // Check common vendors in full text first
    for (const vendor of commonVendors) {
        for (const pattern of vendor.patterns) {
            if (pattern.test(fullText)) {
                console.log(`      Found common vendor: ${vendor.name}`);
                return vendor.name;
            }
        }
    }

    // Simple business name patterns
    const businessPatterns = [
        /([A-Z][a-zA-Z\s&]+?)\s+(?:Store|Inc|LLC|Corp|Co\.|Restaurant|Cafe)/i,
        /([A-Z][a-zA-Z\s&]+?)\s+Order\s+Confirmation/i,
        /Thank you for shopping at\s+([A-Za-z0-9\s&]+)/i,
        /Receipt from\s+([A-Za-z0-9\s&]+)/i
    ];

    for (const pattern of businessPatterns) {
        const match = topSection.match(pattern);
        if (match && match[1]) {
            let vendor = match[1].trim();
            
            // Clean up common suffixes
            vendor = vendor.replace(/\s+(Inc|LLC|Corp|Co\.|Store|Order|Confirmation|Restaurant|Cafe)$/i, '');
            
            if (vendor.length > 1 && vendor.length < 30) {
                console.log(`      Found business vendor: ${vendor}`);
                const result = vendor.charAt(0).toUpperCase() + vendor.slice(1).toLowerCase();
                
                // Cache the result
                vendorExtractionCache.set(cacheKey, {
                    result: result,
                    timestamp: Date.now()
                });
                
                return result;
            }
        }
    }

    console.log('      No vendor found in text');
    
    // Cache null result too
    vendorExtractionCache.set(cacheKey, {
        result: null,
        timestamp: Date.now()
    });
    
    return null;
}

// Extract amount from text
function extractAmount(text) {
    console.log('  Extracting amount from text...');
    
    // Check cache first - use a more unique cache key (hash of full text content)
    const textHash = require('crypto').createHash('md5').update(text).digest('hex').substring(0, 12);
    const cacheKey = `amount_${textHash}`;
    const cached = amountExtractionCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
        console.log('  📦 Using cached amount extraction');
        return cached.result;
    }

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
                    const result = amount.toFixed(2);
                    
                    // Cache the result
                    amountExtractionCache.set(cacheKey, {
                        result: result,
                        timestamp: Date.now()
                    });
                    
                    return result;
                } else {
                    console.log(`    Skipping amount $${amount.toFixed(2)} (less than subtotal $${subtotalAmount.toFixed(2)})`);
                }
            }
        }

        console.log('    No final total found after subtotal, using subtotal as fallback');
        const result = subtotalMatch[1];
        
        // Cache the result
        amountExtractionCache.set(cacheKey, {
            result: result,
            timestamp: Date.now()
        });
        
        return result;
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
            const result = finalAmount.toFixed(2);
            
            // Cache the result
            amountExtractionCache.set(cacheKey, {
                result: result,
                timestamp: Date.now()
            });
            
            return result;
        }
    }

    console.log('    No amount found');
    
    // Cache null result too
    amountExtractionCache.set(cacheKey, {
        result: null,
        timestamp: Date.now()
    });
    
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



// Debug authentication middleware
function requireDebugAuth(req, res, next) {
    const debugKey = process.env.DEBUG_API_KEY;
    if (!debugKey) {
        return res.status(503).json({ error: 'Debug endpoints not configured' });
    }
    
    const providedKey = req.headers['x-debug-key'] || req.query.key;
    if (providedKey !== debugKey) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    next();
}

// Main parsing endpoint
app.post('/parse-receipt', strictLimiter, upload.single('pdf'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No PDF file uploaded' });
        }

        // Sanitize filename
        const originalname = sanitizeFilename(req.file.originalname || 'unknown.pdf');
        console.log('Processing PDF:', originalname, 'Size:', req.file.size);

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
        // Use current date for PDF receipts since they don't have email metadata
        let receiptDate = new Date().toISOString().split('T')[0];
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

            if (!hasValidVendor && !hasValidFilenameVendor) {
                console.log('No valid vendor found through standard extraction');
            } else {
                console.log('Valid vendor found through standard extraction');
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

        res.status(500).json(sanitizeError(error));
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Debug endpoint to check processed emails
app.get('/debug/processed-emails', requireDebugAuth, (req, res) => {
    res.json({
        processedEmailsCount: processedEmailIds.size,
        processedEmailIds: [...processedEmailIds]
    });
});

// Debug endpoint to clear processed emails (for testing)
app.post('/debug/clear-processed', requireDebugAuth, (req, res) => {
    processedEmailIds.clear();
    saveProcessedEmails(processedEmailIds);
    res.json({ message: 'Cleared processed emails', count: 0 });
});

// Debug endpoint to test date extraction
app.post('/debug/test-date-extraction', requireDebugAuth, (req, res) => {
    const { text, subject, sender, emailDate } = req.body;

    if (!text) {
        return res.status(400).json({ error: 'Text is required' });
    }
    
    // Sanitize inputs
    const sanitizedText = sanitizeText(text);
    const sanitizedSubject = sanitizeText(subject || '');
    const sanitizedSender = sanitizeText(sender || '');
    const sanitizedEmailDate = sanitizeText(emailDate || '');

    const result = {
        extractEmailDate: extractEmailDate(text, subject || '', sender || ''), // Legacy complex extraction
        extractDateFromEmail: extractDateFromEmail(emailDate || ''), // New simple extraction
        extractVendor: extractVendor(text),
        extractAmount: extractAmount(text)
    };

    res.json(result);
});

// Legacy PDF endpoints removed - we now forward emails directly

// Gmail scanning endpoint
app.post('/scan-gmail', strictLimiter, async (req, res) => {
    try {
        if (!req.session.googleTokens) {
            return res.status(401).json({ error: 'Not authenticated with Google' });
        }

        console.log('=== GMAIL SCAN STARTED ===');

        // Extract and validate date range from request body
        const { dayRangeFrom, dayRangeTo } = req.body;
        const fromDays = Math.max(1, Math.min(90, parseInt(dayRangeFrom) || 7)); // Limit to 1-90 days
        const toDays = Math.max(0, Math.min(89, parseInt(dayRangeTo) || 1)); // Limit to 0-89 days
        console.log(`Scanning from ${fromDays} to ${toDays} days ago`);

        // Set credentials
        oauth2Client.setCredentials(req.session.googleTokens);
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

        // Focused search for RECEIPTS (not delivery notifications) from Big 3 platforms + forwarded emails
        const query = [
            '(',
            // Amazon order confirmations (NOT deliveries)
            'from:amazon.com (subject:"Ordered:" OR subject:"Order Confirmation" OR subject:"Your Amazon.com order")',
            ') OR (',
            // DoorDash receipts - direct from DoorDash
            'from:doordash.com (subject:receipt OR subject:"Order confirmed" OR subject:"Your DoorDash receipt")',
            ') OR (',
            // Forwarded DoorDash emails from specific sender
            'from:jack.caffarel@gmail.com',
            ') OR (',
            // Instacart receipts  
            'from:instacart.com (subject:receipt OR subject:"Your Instacart order receipt" OR subject:"Order receipt")',
            ')',
            // Temporarily disable exclusions to test jack.caffarel emails
            // '-subject:Shipped: -subject:Delivered: -subject:"Out for delivery" -subject:"Your package"',
            // '-subject:refund -subject:cancelled -subject:canceled -subject:"order cancelled"',
            // Use date range - from X days ago to Y days ago (handle today = 0)
            toDays === 0 ? `newer_than:${fromDays}d` : `newer_than:${fromDays}d older_than:${toDays}d`
        ].join(' ');

        console.log('Gmail search query:', query);

        // Scale maxResults based on date range - more days = more potential emails
        const daySpan = fromDays - toDays + 1; // Total days in the range
        const maxResults = Math.min(500, Math.max(50, daySpan * 10)); // Increased for debugging
        console.log(`Using maxResults: ${maxResults} for ${daySpan} day range (${fromDays} to ${toDays} days ago)`);

        const searchResponse = await gmail.users.messages.list({
            userId: 'me',
            q: query,
            maxResults: maxResults
        });

        if (!searchResponse.data.messages) {
            console.log('No receipt emails found');
            return res.json({
                success: true,
                receiptsFound: 0,
                receiptsProcessed: 0,
                dayRangeFrom: fromDays,
                dayRangeTo: toDays,
                daySpan: daySpan,
                results: []
            });
        }

        console.log(`Found ${searchResponse.data.messages.length} potential receipt emails`);
        
        // Debug: Log first few message IDs and basic info
        if (searchResponse.data.messages && searchResponse.data.messages.length > 0) {
            console.log('First few messages found:');
            for (let i = 0; i < Math.min(5, searchResponse.data.messages.length); i++) {
                const msg = searchResponse.data.messages[i];
                console.log(`  ${i + 1}. Message ID: ${msg.id}`);
            }
        }

        const results = [];
        let processedCount = 0;
        let emailIndex = 0;

        // Process emails in parallel - limit based on date range to avoid overwhelming the system  
        const emailsToProcess = Math.min(50, Math.max(10, Math.floor(daySpan / 2))); // 1 email per 2 days, min 10, max 50
        console.log(`Processing first ${emailsToProcess} emails out of ${searchResponse.data.messages.length} found`);

        // Process emails in parallel with concurrency limit
        const processEmail = async (message, index) => {
            try {
                console.log(`\n=== EMAIL ${index + 1}/${emailsToProcess} ===`);
                console.log(`Processing message ID: ${message.id}`);

                // Check if we've already processed this email (skip check for debugging)
                // Temporarily disable to allow reprocessing
                // if (processedEmailIds.has(message.id)) {
                //     console.log(`  ❌ SKIPPED: Already processed email: ${message.id}`);
                //     return null;
                // }

                // Get full message details (with caching)
                let messageDetails;
                const cacheKey = `gmail_${message.id}`;
                const cachedMessage = gmailMessageCache.get(cacheKey);
                
                if (cachedMessage && (Date.now() - cachedMessage.timestamp) < CACHE_TTL) {
                    messageDetails = cachedMessage.data;
                    console.log(`  📦 Using cached message details`);
                } else {
                    messageDetails = await gmail.users.messages.get({
                        userId: 'me',
                        id: message.id
                    });
                    
                    // Cache the result
                    gmailMessageCache.set(cacheKey, {
                        data: messageDetails,
                        timestamp: Date.now()
                    });
                    console.log(`  💾 Cached message details`);
                }

                const msg = messageDetails.data;
                const subject = getHeader(msg.payload.headers, 'Subject') || 'Unknown Subject';
                const sender = getHeader(msg.payload.headers, 'From') || 'Unknown Sender';
                const date = getHeader(msg.payload.headers, 'Date') || 'Unknown Date';
                
                // Check for original sender in forwarded emails
                const originalSender = getHeader(msg.payload.headers, 'X-Forwarded-From') ||
                                     getHeader(msg.payload.headers, 'X-Original-Sender') ||
                                     getHeader(msg.payload.headers, 'Reply-To') ||
                                     getHeader(msg.payload.headers, 'Return-Path');

                console.log(`  📧 Subject: ${subject}`);
                console.log(`  👤 From: ${sender}`);
                console.log(`  📅 Date: ${date}`);
                if (originalSender) {
                    console.log(`  🔄 Original sender: ${originalSender}`);
                }

                // Extract email HTML content
                const emailHTML = extractEmailHTML(msg.payload);
                if (!emailHTML || emailHTML.trim().length === 0) {
                    console.log(`    ❌ No HTML content found in email`);
                    return null;
                }

                console.log(`    ✅ HTML content extracted: ${emailHTML.length} characters`);

                // Convert HTML email to PDF and process
                console.log(`    🔄 Processing email content to PDF`);
                let processed;
                try {
                    processed = await processEmailContent(emailHTML, subject, sender, req.session.googleTokens, date, originalSender);
                } catch (processingError) {
                    console.error(`    ❌ Failed to process email ${message.id}:`, processingError);
                    processed = {
                        success: false,
                        error: `Processing failed: ${processingError.message}`,
                        processed: false
                    };
                }

                console.log(`    📊 Processing result: ${processed.success ? '✅ SUCCESS' : '❌ FAILED'}`);
                if (processed.vendor) console.log(`       Vendor: ${processed.vendor}`);
                if (processed.amount) console.log(`       Amount: ${processed.amount}`);
                if (processed.receiptDate) console.log(`       Date: ${processed.receiptDate}`);
                if (processed.error) console.log(`       Error: ${processed.error}`);

                const result = {
                    messageId: message.id,
                    subject: subject,
                    sender: sender,
                    processed: processed.success,
                    vendor: processed.vendor,
                    amount: processed.amount,
                    receiptDate: processed.receiptDate,
                    filename: processed.filename,
                    emailContent: processed.emailContent,
                    htmlContent: processed.htmlContent,
                    googleDrive: processed.googleDrive,
                    error: processed.error
                };

                if (processed.success) {
                    // Mark email as processed to prevent duplicates
                    processedEmailIds.add(message.id);
                    saveProcessedEmails(processedEmailIds);
                    console.log(`    💾 Saved email ID to processed list`);
                }

                return result;

            } catch (error) {
                console.error(`Error processing message ${message.id}:`, error);
                return {
                    messageId: message.id,
                    processed: false,
                    error: error.message
                };
            }
        };

        // Return immediate response and process in background
        const scanId = `scan_${Date.now()}_${Math.random().toString(36).substring(2)}`;
        
        // Store initial scan status immediately
        if (!global.scanResults) global.scanResults = new Map();
        global.scanResults.set(scanId, {
            completed: false,
            status: 'processing',
            receiptsFound: searchResponse.data.messages.length,
            emailsToProcess: emailsToProcess,
            dayRangeFrom: fromDays,
            dayRangeTo: toDays,
            daySpan: daySpan,
            startedAt: new Date()
        });
        
        // Send immediate response
        res.json({
            success: true,
            scanId: scanId,
            status: 'processing',
            receiptsFound: searchResponse.data.messages.length,
            emailsToProcess: emailsToProcess,
            message: 'Scan started. Processing emails in background.',
            dayRangeFrom: fromDays,
            dayRangeTo: toDays,
            daySpan: daySpan
        });

        // Continue processing in background (don't await)
        (async () => {
            try {
                console.log(`\n🚀 Background processing started for scan ${scanId}`);
                
                // Process emails in parallel with concurrency limit of 5 to avoid overwhelming APIs
                const batchSize = 5;
                const emailsToProcessArray = searchResponse.data.messages.slice(0, emailsToProcess);
                
                for (let i = 0; i < emailsToProcessArray.length; i += batchSize) {
                    const batch = emailsToProcessArray.slice(i, i + batchSize);
                    const batchPromises = batch.map((message, index) => processEmail(message, i + index));
                    
                    try {
                        const batchResults = await Promise.all(batchPromises);
                        const validResults = batchResults.filter(result => result !== null);
                        results.push(...validResults);
                        
                        // Count successful processes
                        const successfulInBatch = validResults.filter(result => result.processed).length;
                        processedCount += successfulInBatch;
                        
                        console.log(`\n🏁 Batch ${Math.floor(i/batchSize) + 1} complete: ${successfulInBatch}/${batch.length} successful`);
                    } catch (batchError) {
                        console.error(`Error processing batch starting at index ${i}:`, batchError);
                        // Add error results for failed batch
                        batch.forEach((message, index) => {
                            results.push({
                                messageId: message.id,
                                processed: false,
                                error: `Batch processing failed: ${batchError.message}`
                            });
                        });
                    }
                }

                console.log(`=== GMAIL SCAN COMPLETE ===`);
                console.log(`Scan ${scanId}: Processed ${processedCount} receipts from ${searchResponse.data.messages.length} emails`);
                
                // Store results for later retrieval (simple in-memory cache)
                if (!global.scanResults) global.scanResults = new Map();
                global.scanResults.set(scanId, {
                    completed: true,
                    completedAt: new Date(),
                    receiptsFound: searchResponse.data.messages.length,
                    receiptsProcessed: processedCount,
                    dayRangeFrom: fromDays,
                    dayRangeTo: toDays,
                    daySpan: daySpan,
                    results: results
                });
                
                // Clean up old results (keep only last 10)
                if (global.scanResults.size > 10) {
                    const oldestKey = global.scanResults.keys().next().value;
                    global.scanResults.delete(oldestKey);
                }
                
            } catch (backgroundError) {
                console.error(`Background processing error for scan ${scanId}:`, backgroundError);
                // Store error result
                if (!global.scanResults) global.scanResults = new Map();
                global.scanResults.set(scanId, {
                    completed: true,
                    completedAt: new Date(),
                    error: backgroundError.message
                });
            }
        })();

    } catch (error) {
        console.error('Gmail scan error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Endpoint to check scan status and get results
app.get('/scan-status/:scanId', (req, res) => {
    try {
        if (!req.session.googleTokens) {
            return res.status(401).json({ error: 'Not authenticated with Google' });
        }
        
        const { scanId } = req.params;
        
        if (!global.scanResults || !global.scanResults.has(scanId)) {
            return res.status(404).json({
                success: false,
                error: 'Scan not found'
            });
        }
        
        const scanResult = global.scanResults.get(scanId);
        
        res.json({
            success: true,
            scanId: scanId,
            ...scanResult
        });
        
    } catch (error) {
        console.error('Scan status error:', error);
        res.status(500).json({ error: sanitizeError(error) });
    }
});

// Debug endpoint to clear processed emails cache
app.post('/debug/clear-processed', (req, res) => {
    try {
        const beforeCount = processedEmailIds.size;
        processedEmailIds.clear();
        saveProcessedEmails(processedEmailIds);
        console.log(`Cleared ${beforeCount} processed email IDs`);
        
        res.json({
            success: true,
            message: `Cleared ${beforeCount} processed email IDs`
        });
    } catch (error) {
        console.error('Error clearing processed emails:', error);
        res.status(500).json({ error: error.message });
    }
});

// Helper function to get email header
function getHeader(headers, name) {
    const header = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
    return header ? header.value : null;
}

// Helper function to extract HTML content from email
function extractEmailHTML(payload) {
    let htmlContent = '';

    function searchParts(parts) {
        if (!parts) return;

        for (const part of parts) {
            // Look for HTML content
            if (part.mimeType === 'text/html' && part.body && part.body.data) {
                // Decode base64url content
                const decoded = Buffer.from(part.body.data, 'base64url').toString('utf-8');
                htmlContent += decoded;
            }

            // Recursively search nested parts
            if (part.parts) {
                searchParts(part.parts);
            }
        }
    }

    // Check main payload first
    if (payload.mimeType === 'text/html' && payload.body && payload.body.data) {
        htmlContent = Buffer.from(payload.body.data, 'base64url').toString('utf-8');
    } else {
        // Search through parts
        searchParts(payload.parts || []);
    }

    return htmlContent;
}

// Helper function to process email content (convert to text receipt and extract data)
async function processEmailContent(htmlContent, subject, sender, tokens, emailDate, originalSender) {
    try {
        console.log(`    🔍 Processing email HTML content (${htmlContent.length} characters)`);

        // Extract text content for data extraction
        const text = htmlContent.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        console.log(`    📝 Extracted text length: ${text.length}`);
        console.log(`    📄 Text sample: "${text.substring(0, 200)}..."`);

        // Extract vendor - prioritize domain names, only use text for Gmail
        console.log(`    🏪 Extracting vendor...`);
        let vendor = null;
        
        // First try to extract vendor from original sender, then current sender
        if (originalSender) {
            console.log(`    🔄 Trying original sender: ${originalSender}`);
            vendor = extractVendorFromSender(originalSender);
        }
        if (!vendor && sender) {
            vendor = extractVendorFromSender(sender);
        }

        // Only use text extraction if sender is Gmail (forwarded emails)
        if (!vendor) {
            const isFromGmail = sender && sender.toLowerCase().includes('@gmail.com');
            if (isFromGmail) {
                console.log(`    📧 Gmail sender detected, using text extraction`);
                vendor = extractVendor(text);
                
                // Try subject as fallback for Gmail
                if (!vendor && subject) {
                    vendor = extractVendorFromSubject(subject);
                }
            } else {
                console.log(`    🏢 Non-Gmail sender, skipping text extraction`);
            }
        }
        
        console.log(`    💰 Extracting amount...`);
        let amount = extractAmount(text);
        console.log(`    📅 Extracting date...`);
        let receiptDate = extractDateFromEmail(emailDate);

        console.log(`    Initial extraction: vendor=${vendor}, amount=${amount}, date=${receiptDate}`);

        // Apply fallback logic if needed
        if (!vendor || !amount) {
            if (!vendor) {
                console.log('    ⚠️  No vendor found through standard extraction');
            }
        }

        console.log(`    Final extraction: vendor=${vendor}, amount=${amount}, date=${receiptDate}`);

        // Skip emails without amounts - they're not receipts
        if (!amount) {
            console.log(`    ❌ No amount found - skipping as this is not a receipt`);
            return {
                success: false,
                error: 'No amount found - not a receipt'
            };
        }

        // Create output filename
        let outputFilename;
        if (vendor && amount) {
            const dateStr = formatDateForFilename(receiptDate);
            outputFilename = `${vendor} ${dateStr} $${amount}.pdf`;
        } else {
            const dateStr = formatDateForFilename(receiptDate);
            outputFilename = `Email Receipt ${dateStr}.pdf`;
        }

        // Create a proper PDF receipt with PDFShift
        console.log(`    📋 Creating PDF receipt...`);

        // PDF generation removed - we now forward emails directly
        console.log('Skipping PDF generation - forwarding email directly instead');
        const pdfBuffer = null; // Legacy PDF generation disabled

        console.log(`    PDF generation skipped - using direct email forwarding`);

        // PDF generation disabled - using email forwarding instead
        const isPDF = false;
        console.log(`    📋 Using email forwarding instead of PDF generation`);

        // Upload to Google Drive only if we have a valid PDF
        let driveUpload = null;
        if (isPDF && tokens) {
            try {
                driveUpload = await uploadToGoogleDrive(pdfBuffer, outputFilename, receiptDate, tokens);
                console.log(`    📤 Google Drive upload: ${driveUpload.success ? 'SUCCESS' : 'FAILED'}`);
            } catch (driveError) {
                console.error(`    ❌ Google Drive upload error:`, driveError);
                driveUpload = { success: false, error: driveError.message };
            }
        } else if (!isPDF) {
            console.log(`    ⚠️  Skipping Google Drive upload - text fallback, not valid PDF`);
            driveUpload = { success: false, error: 'PDF generation failed, text fallback used' };
        }

        return {
            success: !!(vendor && amount), // Success if we extracted data, regardless of PDF status
            vendor,
            amount,
            receiptDate,
            filename: outputFilename,
            emailContent: text, // Include full email text content
            htmlContent: htmlContent, // Include original HTML content
            pdfGenerated: isPDF,
            error: isPDF ? null : 'PDF generation used text fallback - check PDFShift configuration',
            googleDrive: driveUpload
        };

    } catch (error) {
        console.error(`    Email processing error:`, error);

        return {
            success: false,
            error: error.message
        };
    }
}

// Helper function to format dates for PDF filenames (MM.DD.YY format)
function formatDateForFilename(dateInput) {
    let date;
    if (dateInput && typeof dateInput === 'string') {
        // Try to parse existing date string
        date = new Date(dateInput);
    } else {
        // Use current date
        date = new Date();
    }
    
    // Get month, day, year
    const month = date.getMonth() + 1; // No leading zero
    const day = date.getDate(); // No leading zero  
    const year = date.getFullYear().toString().slice(-2); // Last 2 digits
    
    return `${month}.${day}.${year}`;
}

// Helper function to extract vendor from email sender
function extractVendorFromSender(sender) {
    // Extract domain from email address
    const emailMatch = sender.match(/@([^>.\s]+\.[^>.\s]+)/);
    if (!emailMatch) return null;
    
    const domain = emailMatch[1].toLowerCase();
    
    // Skip forwarding domains - let text extraction find the real vendor
    const forwardingDomains = ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com'];
    if (forwardingDomains.includes(domain)) {
        console.log(`    Skipping forwarding domain: ${domain}`);
        return null;
    }

    // Comprehensive domain-to-vendor mapping
    const domainMappings = {
        // Major retailers
        'amazon.com': 'Amazon',
        'amazon.ca': 'Amazon',
        'amazon.co.uk': 'Amazon',
        'target.com': 'Target',
        'walmart.com': 'Walmart',
        'costco.com': 'Costco',
        'samsclub.com': 'Sam\'s Club',
        'homedepot.com': 'Home Depot',
        'lowes.com': 'Lowe\'s',
        'bestbuy.com': 'Best Buy',
        
        // Food delivery
        'doordash.com': 'DoorDash',
        'ubereats.com': 'Uber Eats',
        'uber.com': 'Uber',
        'grubhub.com': 'Grubhub',
        'postmates.com': 'Postmates',
        'seamless.com': 'Seamless',
        
        // Grocery delivery
        'instacart.com': 'Instacart',
        'shipt.com': 'Shipt',
        'freshdirect.com': 'FreshDirect',
        
        // Food & Coffee
        'starbucks.com': 'Starbucks',
        'dunkindonuts.com': 'Dunkin\'',
        'mcdonalds.com': 'McDonald\'s',
        'chipotle.com': 'Chipotle',
        'dominos.com': 'Domino\'s',
        'pizzahut.com': 'Pizza Hut',
        
        // Airlines
        'delta.com': 'Delta',
        'united.com': 'United Airlines',
        'american.com': 'American Airlines',
        'southwest.com': 'Southwest',
        'jetblue.com': 'JetBlue',
        
        // Subscription services
        'netflix.com': 'Netflix',
        'spotify.com': 'Spotify',
        'apple.com': 'Apple',
        'microsoft.com': 'Microsoft',
        'adobe.com': 'Adobe',
        
        // Other common vendors
        'paypal.com': 'PayPal',
        'venmo.com': 'Venmo',
        'square.com': 'Square',
        'stripe.com': 'Stripe'
    };

    // Check exact domain match first
    if (domainMappings[domain]) {
        return domainMappings[domain];
    }

    // Check if domain contains known vendor names
    for (const [vendorDomain, vendorName] of Object.entries(domainMappings)) {
        if (domain.includes(vendorDomain.split('.')[0])) {
            return vendorName;
        }
    }

    // Fallback: extract company name from domain
    const companyName = domain.split('.')[0];
    if (companyName && companyName.length > 2) {
        const vendor = companyName.charAt(0).toUpperCase() + companyName.slice(1);
        return vendor;
    }

    return null;
}

// Helper function to extract vendor from email subject
function extractVendorFromSubject(subject) {
    console.log(`    Extracting vendor from subject: ${subject}`);

    const patterns = [
        /Your ([A-Za-z]+) order/i,
        /([A-Za-z]+) order confirmation/i,
        /Thank you for shopping at ([A-Za-z]+)/i,
        /Your ([A-Za-z]+) delivery/i,
        /([A-Za-z]+) receipt/i
    ];

    for (const pattern of patterns) {
        const match = subject.match(pattern);
        if (match && match[1]) {
            const vendor = match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase();
            console.log(`      Found vendor from subject: ${vendor}`);
            return vendor;
        }
    }

    return null;
}

// Simple date extraction from email metadata
function extractDateFromEmail(emailDate) {
    if (!emailDate || emailDate === 'Unknown Date') {
        // Use a recent date as fallback (1-3 days ago)
        const pastDate = new Date();
        pastDate.setDate(pastDate.getDate() - Math.floor(Math.random() * 3 + 1));
        return pastDate.toISOString().split('T')[0];
    }
    
    try {
        const date = new Date(emailDate);
        if (isNaN(date.getTime())) {
            console.log(`    ⚠️  Invalid email date: ${emailDate}, using fallback`);
            const pastDate = new Date();
            pastDate.setDate(pastDate.getDate() - 2);
            return pastDate.toISOString().split('T')[0];
        }
        
        const formattedDate = date.toISOString().split('T')[0];
        console.log(`    ✅ Email date extracted: ${formattedDate} (from ${emailDate})`);
        return formattedDate;
    } catch (error) {
        console.log(`    ❌ Error parsing email date: ${error.message}, using fallback`);
        const pastDate = new Date();
        pastDate.setDate(pastDate.getDate() - 2);
        return pastDate.toISOString().split('T')[0];
    }
}

// Enhanced date extraction specifically for emails (DEPRECATED - keeping for debug endpoint)
function extractEmailDate(text, subject, sender, htmlContent) {
    console.log('  Extracting date from email...');
    console.log(`    Subject: ${subject}`);
    console.log(`    Sender: ${sender}`);
    console.log(`    Text sample: ${text.substring(0, 300)}...`);

    // For Amazon delivery emails, try to extract from HTML first
    if (sender && sender.toLowerCase().includes('amazon') && htmlContent) {
        console.log(`    🔍 Checking Amazon HTML for dates...`);
        const amazonDateMatch = htmlContent.match(/arriving|delivered|shipped.*?(\w+\s+\d{1,2},?\s+\d{4})/gi);
        if (amazonDateMatch) {
            console.log(`    🎯 Found Amazon date pattern: ${amazonDateMatch[0]}`);
            const dateStr = amazonDateMatch[0].match(/(\w+\s+\d{1,2},?\s+\d{4})/i);
            if (dateStr) {
                const date = parseEmailDate(dateStr[1]);
                if (date) {
                    console.log(`    ✅ Amazon date extracted: ${date.toISOString().split('T')[0]}`);
                    return date.toISOString().split('T')[0];
                }
            }
        }
    }

    const dates = [];

    // Email-specific date patterns (more common in emails)
    const emailDatePatterns = [
        // Order placed/shipped patterns
        /(?:order placed|placed on|shipped on|delivered on|ordered on)\s*:?\s*([A-Za-z]+\s+\d{1,2},?\s+\d{4})/gi,
        /(?:order placed|placed on|shipped on|delivered on|ordered on)\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{4})/gi,
        /(?:order placed|placed on|shipped on|delivered on|ordered on)\s*:?\s*(\d{4}-\d{1,2}-\d{1,2})/gi,

        // Date in subject line
        /(\d{1,2}\/\d{1,2}\/\d{4})/g,
        /(\d{4}-\d{1,2}-\d{1,2})/g,

        // Common email date formats
        /((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4})/gi,
        /((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s+\d{4})/gi,

        // Date with ordinals (common in emails)
        /((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th),?\s+\d{4})/gi,

        // Delivery date patterns
        /delivery date[:\s]+([A-Za-z]+\s+\d{1,2},?\s+\d{4})/gi,
        /delivery date[:\s]+(\d{1,2}\/\d{1,2}\/\d{4})/gi,

        // Expected delivery patterns
        /expected[:\s]+([A-Za-z]+\s+\d{1,2},?\s+\d{4})/gi,
        /arriving[:\s]+([A-Za-z]+\s+\d{1,2},?\s+\d{4})/gi,

        // Additional Amazon-specific patterns
        /Delivery:\s*([A-Za-z]+\s+\d{1,2},?\s+\d{4})/gi,
        /Arriving\s*([A-Za-z]+\s+\d{1,2},?\s+\d{4})/gi,
        /([A-Za-z]+\s+\d{1,2},?\s+\d{4})\s*by.*pm/gi, // "July 15, 2025 by 10pm"

        // Generic date patterns as last resort
        /\b([A-Za-z]+\s+\d{1,2},?\s+\d{4})\b/gi,
        /\b(\d{1,2}\/\d{1,2}\/\d{4})\b/g,
        /\b(\d{4}-\d{1,2}-\d{1,2})\b/g
    ];

    // Check subject line first (often has the most relevant date)
    if (subject) {
        console.log(`    Checking subject for dates...`);
        for (const pattern of emailDatePatterns) {
            let match;
            while ((match = pattern.exec(subject)) !== null) {
                const dateStr = match[1];
                console.log(`      Found date in subject: "${dateStr}"`);
                const date = parseEmailDate(dateStr);
                if (date) {
                    dates.push({ date, source: 'subject', confidence: 10 });
                }
            }
        }
    }

    // Check email content
    console.log(`    Checking email content for dates...`);
    for (const pattern of emailDatePatterns) {
        let match;
        while ((match = pattern.exec(text)) !== null) {
            const dateStr = match[1];
            console.log(`      Found date in content: "${dateStr}"`);
            const date = parseEmailDate(dateStr);
            if (date) {
                // Give higher confidence to dates near order/delivery keywords
                const beforeText = text.substring(Math.max(0, match.index - 50), match.index).toLowerCase();
                const afterText = text.substring(match.index, Math.min(text.length, match.index + 50)).toLowerCase();
                const contextText = beforeText + afterText;

                let confidence = 5;
                if (contextText.includes('order') || contextText.includes('placed') || contextText.includes('shipped')) {
                    confidence = 8;
                }
                if (contextText.includes('delivery') || contextText.includes('delivered')) {
                    confidence = 9;
                }

                dates.push({ date, source: 'content', confidence });
            }
        }
    }

    console.log(`    📊 Found ${dates.length} potential dates`);
    dates.forEach((item, i) => {
        console.log(`      ${i + 1}. ${item.date.toISOString().split('T')[0]} (${item.source}, confidence: ${item.confidence})`);
    });

    // If no dates found, let's see what we're working with
    if (dates.length === 0) {
        console.log(`    🔍 No dates found. Debugging...`);
        console.log(`    📧 Subject: "${subject}"`);
        console.log(`    👤 Sender: "${sender}"`);
        console.log(`    📄 Text sample (first 500 chars): "${text.substring(0, 500)}"`);

        // Test some common date patterns manually
        const testPatterns = [
            /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b/gi,
            /\b\d{1,2}\/\d{1,2}\/\d{4}\b/g,
            /\b\d{4}-\d{1,2}-\d{1,2}\b/g
        ];

        testPatterns.forEach((pattern, i) => {
            const matches = text.match(pattern);
            console.log(`    🧪 Test pattern ${i + 1}: ${pattern} -> ${matches ? matches.slice(0, 3) : 'no matches'}`);
        });
    }

    if (dates.length === 0) {
        console.log('    ⚠️  No dates found in email content');

        // Final fallback: use a date from the past week instead of today
        // This is more realistic for receipts than today's date
        const pastDate = new Date();
        pastDate.setDate(pastDate.getDate() - Math.floor(Math.random() * 7 + 1)); // 1-7 days ago
        const fallbackDate = pastDate.toISOString().split('T')[0];
        console.log(`    📅 Using fallback date (recent past): ${fallbackDate}`);
        return fallbackDate;
    }

    // Sort by confidence (highest first), then by recency
    dates.sort((a, b) => {
        if (a.confidence !== b.confidence) {
            return b.confidence - a.confidence;
        }
        return b.date.getTime() - a.date.getTime();
    });

    const bestDate = dates[0].date;
    const formattedDate = bestDate.toISOString().split('T')[0];
    console.log(`    Best date: ${formattedDate} (${dates[0].source}, confidence: ${dates[0].confidence})`);

    return formattedDate;
}

// Helper to parse various email date formats
function parseEmailDate(dateStr) {
    try {
        // Remove ordinal suffixes
        const cleanDateStr = dateStr.replace(/(\d{1,2})(st|nd|rd|th)/g, '$1');

        const date = new Date(cleanDateStr);

        // Check if date is valid and not in the future (with 1 day tolerance)
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);

        if (!isNaN(date.getTime()) && date <= tomorrow) {
            return date;
        }
    } catch (error) {
        console.log(`      Error parsing date "${dateStr}": ${error.message}`);
    }

    return null;
}

// PDFShift PDF generation
async function createEmailReceiptPDFWithPDFShift(data) {
    try {
        console.log(`    📄 Starting PDFShift PDF generation...`);
        
        // PDFShift disabled - functionality removed
        throw new Error('PDF generation disabled - we now forward emails directly');
        console.log(`    🔑 API key configured: ${apiKey.substring(0, 8)}...`);

        // Create email-like HTML for natural rendering
        const emailHtml = createEmailHTML(data);
        console.log(`    📄 Generated HTML: ${emailHtml.length} characters`);

        console.log(`    📝 Sending request to PDFShift...`);

        const pdfshiftResponse = await fetch('https://api.pdfshift.io/v3/convert/pdf', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Basic ${Buffer.from('api:' + apiKey).toString('base64')}`
            },
            body: JSON.stringify({
                source: emailHtml,
                format: 'A4',
                margin: '0.2in'
            })
        });

        console.log(`    📡 PDFShift response status: ${pdfshiftResponse.status}`);
        
        if (!pdfshiftResponse.ok) {
            const errorText = await pdfshiftResponse.text();
            console.error('    ❌ PDFShift API error:', pdfshiftResponse.status, errorText);
            
            // Add specific handling for common errors
            if (pdfshiftResponse.status === 429) {
                throw new Error(`PDFShift rate limit exceeded. Please try again later.`);
            } else if (pdfshiftResponse.status === 402) {
                throw new Error(`PDFShift quota exceeded. Please check your account.`);
            } else if (pdfshiftResponse.status === 401) {
                throw new Error(`PDFShift authentication failed. Please check API key.`);
            } else {
                throw new Error(`PDFShift API error: ${pdfshiftResponse.status} - ${errorText}`);
            }
        }

        const pdfBuffer = Buffer.from(await pdfshiftResponse.arrayBuffer());
        console.log(`    ✅ PDFShift PDF generated successfully: ${pdfBuffer.length} bytes`);
        
        // Verify it's actually a PDF
        const pdfHeader = pdfBuffer.toString('ascii', 0, 4);
        console.log(`    🔍 PDF header check: "${pdfHeader}"`);
        
        return pdfBuffer;

    } catch (error) {
        console.error('    ❌ PDFShift PDF generation failed:', error.message);
        throw error;
    }
}

// Create natural email HTML for PDF rendering
function createEmailHTML(data) {
    // Use the actual HTML content if available, otherwise create a clean email layout
    const htmlContent = data.htmlContent || '';

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Email Receipt</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      margin: 0;
      padding: 8px;
      background: white;
      color: #333;
      line-height: 1.1;
      font-size: 9px;
    }
    .email-header {
      border-bottom: 1px solid #ddd;
      padding-bottom: 4px;
      margin-bottom: 6px;
      font-size: 8px;
      color: #666;
    }
    .email-subject {
      font-size: 11px;
      font-weight: 600;
      color: #333;
      margin: 4px 0;
    }
    .receipt-badge {
      background: #f0f9ff;
      border: 1px solid #0ea5e9;
      border-radius: 3px;
      padding: 3px 6px;
      margin: 4px 0;
      font-size: 8px;
      color: #0369a1;
      display: inline-block;
    }
    .email-content {
      font-size: 9px;
      line-height: 1.1;
    }
    .email-content table {
      width: 100%;
      border-collapse: collapse;
    }
    .email-content td {
      padding: 2px;
      vertical-align: top;
      font-size: 8px;
    }
    .email-content th {
      padding: 2px;
      font-size: 8px;
    }
    .email-content img {
      max-width: 100%;
      height: auto;
    }
    .email-content h1, .email-content h2, .email-content h3 {
      font-size: 10px;
      margin: 3px 0;
      line-height: 1.1;
    }
    .email-content p {
      margin: 2px 0;
      font-size: 9px;
    }
    .email-content div {
      font-size: 9px;
    }
    /* Force small text everywhere */
    .email-content * {
      max-width: 100% !important;
      font-size: 9px !important;
      line-height: 1.1 !important;
      margin: 1px 0 !important;
      padding: 1px !important;
    }
  </style>
</head>
<body>
  <div class="email-header">
    <div><strong>From:</strong> ${data.sender}</div>
    <div><strong>Date:</strong> ${new Date().toLocaleDateString()}</div>
  </div>
  
  <div class="email-subject">${data.subject}</div>
  
  <div class="receipt-badge">
    📧 ${data.vendor} • ${data.amount} • ${data.receiptDate}
  </div>
  
  <div class="email-content">
    ${htmlContent || data.emailContent.replace(/\n/g, '<br>')}
  </div>
</body>
</html>`;
}



// Google Drive authentication routes
app.get('/auth/google', (req, res) => {
    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: [
            'https://www.googleapis.com/auth/drive.file',
            'https://www.googleapis.com/auth/gmail.readonly',
            'https://www.googleapis.com/auth/gmail.send'
        ],
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
    console.log(`🔍 Auth status check: ${isAuthenticated ? 'AUTHENTICATED' : 'NOT AUTHENTICATED'}`);
    console.log(`   Origin: ${req.headers.origin || 'no origin'}`);
    console.log(`   User-Agent: ${req.headers['user-agent']?.substring(0, 50)}...`);
    console.log(`   Session ID: ${req.sessionID?.substring(0, 8)}...`);
    res.json({ 
        authenticated: isAuthenticated,
        sessionId: req.sessionID?.substring(0, 8),
        hasTokens: !!(req.session.googleTokens)
    });
});

// Token endpoint for extension
app.get('/auth/token', (req, res) => {
    if (req.session.googleTokens) {
        res.json({
            access_token: req.session.googleTokens.access_token
        });
    } else {
        res.status(401).json({ error: 'Not authenticated' });
    }
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

// Convert email to PDF endpoint
app.post('/convert-email-to-pdf', strictLimiter, async (req, res) => {
    try {
        const { emailId, emailContent } = req.body;

        if (!emailId || !emailContent) {
            return res.status(400).json({ error: 'Email ID and content are required' });
        }
        
        // Sanitize inputs
        const sanitizedEmailId = sanitizeText(emailId);
        if (!sanitizedEmailId) {
            return res.status(400).json({ error: 'Invalid email ID' });
        }

        console.log('Converting email to PDF:', emailId);

        // Extract data for smart naming (same logic as scan, but more permissive)
        const htmlContent = emailContent.body || 'No content available';
        const text = htmlContent.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        
        // Try to extract vendor, amount, and date for better naming
        let vendor = extractVendor(text);
        
        // Enhanced vendor extraction
        if (!vendor && emailContent.from) {
            vendor = extractVendorFromSender(emailContent.from);
        }
        if (!vendor && emailContent.subject) {
            vendor = extractVendorFromSubject(emailContent.subject);
        }
        
        let amount = extractAmount(text);
        let receiptDate = extractEmailDate(text, emailContent.subject, emailContent.from, htmlContent);

        // Create smart filename
        
        let outputFilename;
        if (vendor && amount) {
            const dateStr = formatDateForFilename(receiptDate);
            outputFilename = `${vendor} ${dateStr} $${amount}.pdf`;
        } else if (vendor) {
            const dateStr = formatDateForFilename(receiptDate);
            outputFilename = `${vendor} ${dateStr}.pdf`;
        } else {
            const dateStr = formatDateForFilename(receiptDate);
            const subject = emailContent.subject || 'Email';
            outputFilename = `${subject.substring(0, 30)} ${dateStr}.pdf`;
        }

        // Clean and process email body
        let cleanBody = htmlContent;

        // If body contains HTML, try to clean it up
        if (cleanBody.includes('<') && cleanBody.includes('>')) {
            // Remove style tags and their content
            cleanBody = cleanBody.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
            // Remove script tags and their content
            cleanBody = cleanBody.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
            // Remove excessive whitespace and line breaks
            cleanBody = cleanBody.replace(/\s+/g, ' ').trim();
        }

        // Create HTML from email content
        const pdfHtmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Email Receipt - ${emailContent.subject || 'No Subject'}</title>
        <style>
          body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; 
            margin: 40px; 
            line-height: 1.6;
            color: #333;
          }
          .receipt-header { 
            text-align: center;
            border-bottom: 2px solid #007bff; 
            padding-bottom: 20px; 
            margin-bottom: 30px; 
          }
          .receipt-title {
            color: #007bff;
            font-size: 28px;
            font-weight: bold;
            margin-bottom: 10px;
          }
          .email-info { 
            background: #f8f9fa;
            padding: 20px;
            border-radius: 8px;
            margin-bottom: 20px;
          }
          .email-info h3 {
            color: #007bff;
            margin-top: 0;
            border-left: 4px solid #007bff;
            padding-left: 10px;
          }
          .info-item { margin-bottom: 8px; }
          .email-content { 
            background: white;
            padding: 20px;
            border: 1px solid #dee2e6;
            border-radius: 8px;
            max-width: 100%;
            overflow-wrap: break-word;
          }
          .email-content h3 {
            color: #007bff;
            border-left: 4px solid #007bff;
            padding-left: 10px;
          }
          table { border-collapse: collapse; width: 100%; margin: 10px 0; }
          td, th { border: 1px solid #ddd; padding: 8px; text-align: left; }
          th { background-color: #f2f2f2; }
          img { max-width: 100%; height: auto; }
        </style>
      </head>
      <body>
        <div class="receipt-header">
          <div class="receipt-title">EMAIL RECEIPT</div>
        </div>
        
        <div class="email-info">
          <h3>Email Information</h3>
          <div class="info-item"><strong>From:</strong> ${emailContent.from || 'Unknown'}</div>
          <div class="info-item"><strong>Subject:</strong> ${emailContent.subject || 'No Subject'}</div>
          <div class="info-item"><strong>Generated:</strong> ${new Date().toLocaleDateString()}</div>
        </div>
        
        <div class="email-content">
          <h3>Email Content</h3>
          ${cleanBody}
        </div>
      </body>
      </html>
    `;

        // PDFShift disabled - functionality removed
        throw new Error('PDF generation disabled - we now forward emails directly');
        const response = await fetch('https://api.pdfshift.io/v3/convert/pdf', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Basic ${Buffer.from('api:' + pdfshiftToken).toString('base64')}`
            },
            body: JSON.stringify({
                source: pdfHtmlContent,
                format: 'A4',
                margin: '0.2in'
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`PDFShift API error: ${response.status} - ${errorText}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        const pdfBuffer = Buffer.from(arrayBuffer);

        // Upload to Google Drive if user is authenticated
        const date = formatDateForFilename(receiptDate);
        let driveUpload = null;
        if (req.session.googleTokens) {
            try {
                driveUpload = await uploadToGoogleDrive(pdfBuffer, outputFilename, date, req.session.googleTokens);
            } catch (driveError) {
                console.error('Google Drive upload failed:', driveError);
                driveUpload = { success: false, error: driveError.message };
            }
        }

        res.json({
            success: true,
            filename: outputFilename,
            vendor: vendor,
            amount: amount,
            receiptDate: receiptDate,
            pdfBase64: pdfBuffer.toString('base64'),
            googleDrive: driveUpload
        });

    } catch (error) {
        console.error('Error converting email to PDF:', error);
        res.status(500).json(sanitizeError(error));
    }
});

// Legacy PDFShift endpoint disabled
app.get('/debug-pdfshift', requireDebugAuth, (req, res) => {
    res.json({
        status: 'disabled',
        message: 'PDFShift functionality removed - we now forward emails directly'
    });
});

// Debug endpoint to inspect email headers
app.get('/debug/email-headers/:messageId', requireDebugAuth, async (req, res) => {
    try {
        if (!req.session.googleTokens) {
            return res.status(401).json({ error: 'Not authenticated with Google' });
        }

        oauth2Client.setCredentials(req.session.googleTokens);
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

        const messageDetails = await gmail.users.messages.get({
            userId: 'me',
            id: req.params.messageId
        });

        const headers = messageDetails.data.payload.headers.map(h => ({
            name: h.name,
            value: h.value
        }));

        res.json({
            messageId: req.params.messageId,
            headers: headers,
            headerCount: headers.length
        });

    } catch (error) {
        console.error('Error fetching email headers:', error);
        res.status(500).json(sanitizeError(error));
    }
});

// Validate critical environment variables
const criticalEnvVars = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'];
const missingCriticalVars = criticalEnvVars.filter(envVar => !process.env[envVar]);
const missingSessionSecret = !process.env.SESSION_SECRET;

// Extract transactions from Airbase screenshots
app.post('/extract-transactions', async (req, res) => {
    try {
        const { imageData } = req.body;
        
        if (!imageData) {
            return res.status(400).json({
                success: false,
                error: 'No image data provided'
            });
        }

        // Initialize Vision client
        let clientConfig;
        console.log('Initializing Google Vision client...');
        console.log('GOOGLE_SERVICE_ACCOUNT_JSON available:', !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
        
        if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
            try {
                const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
                console.log('Service account project ID:', credentials.project_id);
                clientConfig = {
                    projectId: credentials.project_id,
                    credentials: credentials
                };
            } catch (parseError) {
                console.error('Failed to parse GOOGLE_SERVICE_ACCOUNT_JSON:', parseError);
                throw new Error('Invalid service account credentials');
            }
        } else {
            console.log('Using local keyfile...');
            clientConfig = {
                projectId: 'sourcegraph-dev',
                keyFilename: './sourcegraph-dev-0fb0280dc0e5.json'
            };
        }

        const client = new vision.ImageAnnotatorClient(clientConfig);
        console.log('Vision client created successfully');
        
        // Extract text from image
        console.log('Processing image data...');
        console.log('Image data length:', imageData.length);
        console.log('Image data type:', typeof imageData);
        console.log('Image data starts with:', imageData.substring(0, 50));
        
        const imageBuffer = Buffer.from(imageData.replace(/^data:image\/[a-z]+;base64,/, ''), 'base64');
        console.log('Image buffer created, size:', imageBuffer.length);
        
        console.log('Calling Google Vision API...');
        const [result] = await client.textDetection({
            image: { content: imageBuffer }
        });
        console.log('Vision API call successful');

        if (!result.textAnnotations || result.textAnnotations.length === 0) {
            console.log('No text annotations found in Vision API result');
            return res.json({
                success: false,
                error: 'No text detected in image'
            });
        }

        console.log('Text annotations found:', result.textAnnotations.length);
        console.log('First annotation text preview:', result.textAnnotations[0]?.description?.substring(0, 200) + '...');

        // Parse transactions from detected text
        console.log('Parsing transactions...');
        const transactions = parseAirbaseTransactions(result.textAnnotations);
        console.log('Transactions parsed successfully, count:', transactions.length);
        
        console.log('Building response...');
        const response = {
            success: true,
            transactions: transactions,
            rawText: result.textAnnotations[0]?.description, // Full text for debugging
            detectedBlocks: result.textAnnotations.length
        };
        
        console.log('Response built, sending...');
        res.json(response);
        console.log('Response sent successfully');

    } catch (error) {
        console.error('Transaction extraction error:', error);
        console.error('Error stack:', error.stack);
        console.error('Error details:', {
            name: error.name,
            message: error.message,
            code: error.code,
            details: error.details
        });
        
        res.status(500).json({
            success: false,
            error: `Vision API Error: ${error.message}`,
            errorType: error.name || 'Unknown',
            errorCode: error.code || 'N/A'
        });
    }
});

// Image validation and utility functions
function validateImageData(imageData) {
    console.log('Validating image data...');
    
    if (!imageData || typeof imageData !== 'string') {
        throw new Error('Invalid image data format');
    }
    
    // Check if it's a valid base64 data URL
    const dataUrlPattern = /^data:image\/(png|jpeg|jpg|gif|webp);base64,/i;
    if (!dataUrlPattern.test(imageData)) {
        throw new Error('Invalid image format. Supported formats: PNG, JPEG, GIF, WebP');
    }
    
    // Extract the base64 part
    const base64Data = imageData.split(',')[1];
    if (!base64Data) {
        throw new Error('No image data found');
    }
    
    // Check file size (limit to 10MB)
    const sizeInBytes = (base64Data.length * 3) / 4;
    const maxSizeInBytes = 10 * 1024 * 1024; // 10MB
    
    if (sizeInBytes > maxSizeInBytes) {
        throw new Error(`Image too large. Maximum size: 10MB, received: ${Math.round(sizeInBytes / 1024 / 1024)}MB`);
    }
    
    console.log(`Image validation passed. Size: ${Math.round(sizeInBytes / 1024)}KB`);
    return {
        base64Data,
        mimeType: imageData.match(dataUrlPattern)[0].split(';')[0].split(':')[1],
        sizeInBytes
    };
}

function getImageExtension(imageData) {
    const mimeTypeMatch = imageData.match(/^data:image\/([a-z]+);base64,/i);
    if (!mimeTypeMatch) return 'png';
    
    const mimeType = mimeTypeMatch[1].toLowerCase();
    switch (mimeType) {
        case 'jpeg':
        case 'jpg':
            return 'jpg';
        case 'png':
            return 'png';
        case 'gif':
            return 'gif';
        case 'webp':
            return 'webp';
        default:
            return 'png';
    }
}

function generateScreenshotFilename(originalName, imageData, metadata = {}) {
    const timestamp = new Date().toISOString().split('T')[0];
    const extension = getImageExtension(imageData);
    
    if (originalName && originalName.trim()) {
        // Use provided name, ensure it has correct extension
        const nameWithoutExt = originalName.replace(/\.[^/.]+$/, '');
        return `${nameWithoutExt}.${extension}`;
    }
    
    // Generate descriptive filename
    let prefix = 'receipt';
    if (metadata.vendor) {
        const cleanVendor = metadata.vendor.replace(/[^a-zA-Z0-9]/g, '').substring(0, 20);
        prefix = cleanVendor.toLowerCase() || 'receipt';
    }
    
    return `${prefix}-${timestamp}.${extension}`;
}

// Parse Airbase transaction data from Vision API text
function parseAirbaseTransactions(textAnnotations) {
    console.log('parseAirbaseTransactions called with', textAnnotations.length, 'annotations');
    
    const fullText = textAnnotations[0]?.description || '';
    console.log('Full text length:', fullText.length);
    console.log('Full text preview:', fullText.substring(0, 300) + '...');
    
    const lines = fullText.split('\n').filter(line => line.trim());
    console.log('Lines found:', lines.length);
    
    // Extract vendors, amounts, and dates separately
    const vendors = [];
    const amounts = [];
    const dates = [];
    
    for (const line of lines) {
        const trimmedLine = line.trim();
        
        // Skip common non-transaction text
        if (!trimmedLine || 
            trimmedLine.toLowerCase().includes('sourcegraph') ||
            trimmedLine.toLowerCase().includes('department') ||
            trimmedLine.toLowerCase().includes('completed') ||
            trimmedLine.toLowerCase().includes('physical card') ||
            trimmedLine.length < 3) {
            continue;
        }
        
        // Check if this line is a vendor (looks like a merchant name)
        if (isVendorLine(trimmedLine)) {
            vendors.push(trimmedLine);
        }
        
        // Check if this line contains an amount
        const amountMatch = trimmedLine.match(/(\d+\.\d{2})\s*USD/);
        if (amountMatch) {
            amounts.push('$' + amountMatch[1]);
        }
        
        // Check if this line contains a date
        const dateMatch = trimmedLine.match(/\b(Jul|Jun|Aug|Sep|Oct|Nov|Dec|Jan|Feb|Mar|Apr|May)\s+\d{1,2},?\s+\d{4}\b/);
        if (dateMatch) {
            dates.push(dateMatch[0]);
        }
    }
    
    // Match vendors with amounts and dates
    const transactions = [];
    const maxItems = Math.min(vendors.length, amounts.length);
    
    for (let i = 0; i < maxItems; i++) {
        transactions.push({
            vendor: vendors[i],
            amount: amounts[i],
            date: dates[i] || dates[Math.min(i, dates.length - 1)] || null,
            rawLine: `${vendors[i]} ${amounts[i]} ${dates[i] || ''}`,
            confidence: calculateConfidence(vendors[i], amounts[i], dates[i])
        });
    }

    console.log('Parsed results:', {
        vendorsFound: vendors.length,
        amountsFound: amounts.length,  
        datesFound: dates.length,
        transactionsCreated: transactions.length
    });
    console.log('Final transactions:', transactions);

    return transactions;
}

// Check if a line looks like a vendor/merchant name
function isVendorLine(line) {
    // Skip if it's clearly not a vendor
    if (line.match(/^\d+\.\d{2}/) || // Starts with amount
        line.match(/^(Jul|Jun|Aug|Sep|Oct|Nov|Dec|Jan|Feb|Mar|Apr|May)/) || // Starts with date
        line.includes('(') || // Contains parentheses (likely descriptions)
        line.length > 50) { // Too long to be a vendor name
        return false;
    }
    
    // Looks like a vendor if it has merchant-like patterns
    return line.match(/^[A-Z*\s]+/) || // All caps (common for merchants)
           line.includes('*') || // Contains * (common in merchant names)
           line.match(/^(AMAZON|UBER|DD|TST|SQ|IC)/) || // Known merchant prefixes
           (line.length > 5 && line.length < 35); // Reasonable vendor name length
}

// Parse individual transaction line
function parseTransactionLine(line) {
    // Amount patterns: $123.45, $1,234.56
    const amountMatch = line.match(/\$[\d,]+\.?\d*/);
    
    // Date patterns: Jan 15, 2025, 1/15/2025, 01/15/25
    const dateMatch = line.match(/\b(\w{3}\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})\b/);
    
    if (!amountMatch) {
        return null; // Must have an amount to be a transaction
    }

    // Extract vendor (everything before the amount, cleaned up)
    const amountIndex = line.indexOf(amountMatch[0]);
    let vendor = line.substring(0, amountIndex).trim();
    
    // Clean up vendor name
    vendor = vendor.replace(/^[•\-\*\s]+/, '').trim(); // Remove bullets/dashes
    vendor = vendor.replace(/\s+/g, ' ').trim(); // Normalize spaces
    
    if (!vendor || vendor.length < 2) {
        return null; // Must have a reasonable vendor name
    }

    return {
        vendor: vendor,
        amount: amountMatch[0],
        date: dateMatch ? dateMatch[0] : null,
        rawLine: line,
        confidence: calculateConfidence(vendor, amountMatch[0], dateMatch)
    };
}

// Calculate confidence score for transaction parsing
function calculateConfidence(vendor, amount, dateMatch) {
    let score = 0.3; // Base score
    
    if (vendor.length > 2) score += 0.3;
    if (amount.includes('.')) score += 0.2; // Has cents
    if (dateMatch) score += 0.2;
    
    return Math.min(score, 1.0);
}

// AI-Enhanced Email Analysis Functions
async function analyzeEmailWithAI(emailContent, emailSubject = '', emailFrom = '') {
    console.log('🤖 Starting AI analysis of email...');
    
    if (!OPENAI_API_KEY) {
        console.log('⚠️ No OpenAI API key - falling back to pattern matching');
        return fallbackEmailAnalysis(emailContent, emailSubject, emailFrom);
    }

    try {
        const analysisPrompt = `
Analyze this email for expense/receipt processing:

From: ${emailFrom}
Subject: ${emailSubject}
Content: ${emailContent.substring(0, 2000)}

Return a JSON object with:
{
  "isReceipt": boolean,
  "confidence": number (0-1),
  "vendor": string or null,
  "amounts": array of dollar amounts found,
  "transactionCount": number,
  "shouldChunk": boolean,
  "category": string or null,
  "reasoning": string
}

Focus on:
- Is this actually a receipt/invoice (not marketing/shipping updates)?
- What dollar amounts represent actual transactions vs totals/discounts?
- For Amazon: should this be split into multiple transaction emails?
- What expense category might this be?

Be conservative - when uncertain, set lower confidence.`;

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: 'gpt-4',
                messages: [{
                    role: 'user',
                    content: analysisPrompt
                }],
                max_tokens: 500,
                temperature: 0.1
            })
        });

        if (!response.ok) {
            throw new Error(`OpenAI API error: ${response.status}`);
        }

        const result = await response.json();
        const aiAnalysis = JSON.parse(result.choices[0].message.content);
        
        console.log('🎯 AI Analysis Result:', {
            isReceipt: aiAnalysis.isReceipt,
            confidence: aiAnalysis.confidence,
            vendor: aiAnalysis.vendor,
            amountCount: aiAnalysis.amounts?.length || 0,
            shouldChunk: aiAnalysis.shouldChunk
        });

        return aiAnalysis;

    } catch (error) {
        console.error('❌ AI analysis failed:', error);
        console.log('🔄 Falling back to pattern matching...');
        return fallbackEmailAnalysis(emailContent, emailSubject, emailFrom);
    }
}

function fallbackEmailAnalysis(emailContent, emailSubject = '', emailFrom = '') {
    console.log('🔍 Using fallback pattern analysis...');
    
    const lowerContent = emailContent.toLowerCase();
    const lowerSubject = emailSubject.toLowerCase();
    const lowerFrom = emailFrom.toLowerCase();
    
    // Basic receipt detection
    const receiptIndicators = [
        'receipt', 'invoice', 'order confirmation', 'purchase', 
        'payment confirmation', 'trip completed', 'booking confirmation'
    ];
    
    const isReceipt = receiptIndicators.some(indicator => 
        lowerContent.includes(indicator) || lowerSubject.includes(indicator)
    );
    
    // Vendor detection
    let vendor = null;
    if (lowerFrom.includes('amazon')) vendor = 'Amazon';
    else if (lowerFrom.includes('uber')) vendor = 'Uber';
    else if (lowerFrom.includes('doordash')) vendor = 'DoorDash';
    
    // Basic amount extraction
    const amountMatches = emailContent.match(/\$\d+\.\d{2}/g) || [];
    const amounts = [...new Set(amountMatches)]; // Remove duplicates
    
    return {
        isReceipt,
        confidence: isReceipt ? 0.7 : 0.3,
        vendor,
        amounts,
        transactionCount: amounts.length,
        shouldChunk: vendor === 'Amazon' && amounts.length > 1,
        category: null,
        reasoning: 'Pattern-based analysis (no AI available)'
    };
}

async function extractAmountsWithAI(emailContent, vendor = null) {
    console.log('💰 AI-enhanced amount extraction...');
    
    if (!OPENAI_API_KEY) {
        return extractAmountsFromAmazonEmail(emailContent); // Fallback to existing function
    }

    try {
        const extractionPrompt = `
Extract transaction amounts from this ${vendor || 'receipt'} email:

${emailContent.substring(0, 2000)}

Return JSON array of amounts that represent ACTUAL TRANSACTIONS (not totals, discounts, or savings):
{
  "transactionAmounts": ["$45.67", "$23.45"],
  "totalAmount": "$69.12",
  "excludedAmounts": {
    "$15.00": "shipping (already included in item prices)",
    "$5.99": "discount (not a transaction)"
  },
  "reasoning": "explanation of extraction logic"
}

For Amazon: Extract individual item prices or shipment totals, NOT the overall order total.
For restaurants: Extract the final total, NOT individual items.
Exclude: discounts, savings, original prices, tax-inclusive totals when itemized.`;

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: 'gpt-4',
                messages: [{ role: 'user', content: extractionPrompt }],
                max_tokens: 400,
                temperature: 0.1
            })
        });

        const result = await response.json();
        const extraction = JSON.parse(result.choices[0].message.content);
        
        console.log('💰 AI Amount Extraction:', {
            found: extraction.transactionAmounts?.length || 0,
            amounts: extraction.transactionAmounts,
            excluded: Object.keys(extraction.excludedAmounts || {}).length
        });

        return extraction.transactionAmounts || [];

    } catch (error) {
        console.error('❌ AI amount extraction failed:', error);
        return extractAmountsFromAmazonEmail(emailContent);
    }
}

async function intelligentChunkingDecision(emailContent, amounts, vendor) {
    console.log('🧠 AI chunking decision analysis...');
    
    if (!OPENAI_API_KEY || !amounts.length) {
        return amounts.length > 1; // Simple fallback
    }

    try {
        const chunkingPrompt = `
Decide how to split this ${vendor} email for expense processing:

Amounts found: ${amounts.join(', ')}
Email preview: ${emailContent.substring(0, 1000)}

Should each amount become a separate email for expense matching?

Return JSON:
{
  "shouldChunk": boolean,
  "chunkingStrategy": "by_shipment" | "by_item" | "single_email",
  "amountsToProcess": ["$45.67", "$23.45"],
  "reasoning": "explanation"
}

Consider:
- Amazon: Usually chunk by shipment/delivery, not by individual items
- Restaurants: Single email even if itemized
- Hotels: Single email for entire stay
- Uber: Single email per trip`;

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: 'gpt-4',
                messages: [{ role: 'user', content: chunkingPrompt }],
                max_tokens: 300,
                temperature: 0.1
            })
        });

        const result = await response.json();
        const decision = JSON.parse(result.choices[0].message.content);
        
        console.log('🧠 AI Chunking Decision:', {
            shouldChunk: decision.shouldChunk,
            strategy: decision.chunkingStrategy,
            amountCount: decision.amountsToProcess?.length || 0
        });

        return decision;

    } catch (error) {
        console.error('❌ AI chunking decision failed:', error);
        return {
            shouldChunk: amounts.length > 1,
            chunkingStrategy: 'by_amount',
            amountsToProcess: amounts,
            reasoning: 'Fallback: chunk if multiple amounts found'
        };
    }
}

// Amazon email detection and parsing functions
function isAmazonEmail(emailContent) {
    const lowerContent = emailContent.toLowerCase();
    
    // Check for Amazon domains and sender patterns
    const amazonDomains = [
        'amazon.com',
        'amazon.ca', 
        'amazon.co.uk',
        '@amazon.',
        'from: amazon',
        'amazon order',
        'order confirmation',
        'shipment notification'
    ];
    
    const hasAmazonIndicator = amazonDomains.some(domain => lowerContent.includes(domain));
    
    // Also check for typical Amazon subject patterns
    const amazonSubjectPatterns = [
        'your order',
        'order confirmation',
        'shipment',
        'delivery',
        'invoice'
    ];
    
    const hasAmazonSubject = amazonSubjectPatterns.some(pattern => 
        lowerContent.includes('subject:') && lowerContent.includes(pattern)
    );
    
    return hasAmazonIndicator || (hasAmazonSubject && lowerContent.includes('amazon'));
}

function extractAmountsFromAmazonEmail(emailContent) {
    console.log('Extracting amounts from Amazon email...');
    
    // Find all dollar amounts in various formats, prioritizing Amazon-specific patterns
    const amountRegexes = [
        // Common Amazon patterns
        /Item\s+price:\s*\$(\d+\.\d{2})/gi,      // Item price: $123.45
        /Price:\s*\$(\d+\.\d{2})/gi,             // Price: $123.45
        /Total:\s*\$(\d+\.\d{2})/gi,             // Total: $123.45
        /Subtotal:\s*\$(\d+\.\d{2})/gi,          // Subtotal: $123.45
        /Order\s+total:\s*\$(\d+\.\d{2})/gi,     // Order total: $123.45
        /Amount:\s*\$(\d+\.\d{2})/gi,            // Amount: $123.45
        /Shipping:\s*\$(\d+\.\d{2})/gi,          // Shipping: $123.45
        /Tax:\s*\$(\d+\.\d{2})/gi,               // Tax: $123.45
        
        // Generic patterns (lower priority)
        /\$(\d+\.\d{2})/g,                       // $123.45
        /USD\s*(\d+\.\d{2})/gi,                  // USD 123.45
        /(\d+\.\d{2})\s*USD/gi,                  // 123.45 USD
    ];
    
    const amounts = new Set(); // Use Set to avoid duplicates
    const excludePatterns = [
        /free shipping/i,
        /\$0\.00/,
        /\$0\.01/,  // Sometimes used for authorization checks
        /save \$/i,
        /discount/i
    ];
    
    for (const regex of amountRegexes) {
        let match;
        while ((match = regex.exec(emailContent)) !== null) {
            const fullMatch = match[0];
            const amount = match[1] || match[0].replace(/[^\d.]/g, '');
            const amountNum = parseFloat(amount);
            
            // Skip if amount is invalid or should be excluded
            if (amountNum <= 0 || amountNum > 10000) continue; // Reasonable bounds
            
            // Check if this match should be excluded
            const shouldExclude = excludePatterns.some(pattern => 
                pattern.test(fullMatch) || pattern.test(emailContent.substring(Math.max(0, match.index - 50), match.index + 50))
            );
            
            if (!shouldExclude) {
                amounts.add('$' + amountNum.toFixed(2));
            }
        }
    }
    
    const amountArray = Array.from(amounts).sort((a, b) => {
        const aNum = parseFloat(a.replace('$', ''));
        const bNum = parseFloat(b.replace('$', ''));
        return bNum - aNum; // Sort descending
    });
    
    console.log('Extracted amounts:', amountArray);
    return amountArray;
}

function matchTransactionAmounts(airbaseAmounts, amazonAmounts) {
    console.log('Matching transaction amounts...');
    console.log('Airbase amounts:', airbaseAmounts);
    console.log('Amazon amounts:', amazonAmounts);
    
    const matches = [];
    const usedAmazonAmounts = new Set();
    
    for (const airbaseAmount of airbaseAmounts) {
        // Find exact match in Amazon amounts
        const exactMatch = amazonAmounts.find(amazonAmount => 
            amazonAmount === airbaseAmount && !usedAmazonAmounts.has(amazonAmount)
        );
        
        if (exactMatch) {
            matches.push({
                airbaseAmount,
                amazonAmount: exactMatch,
                confidence: 1.0
            });
            usedAmazonAmounts.add(exactMatch);
        } else {
            // No exact match found
            matches.push({
                airbaseAmount,
                amazonAmount: null,
                confidence: 0.0
            });
        }
    }
    
    console.log('Amount matches:', matches);
    return matches;
}

function createAIEnhancedChunkedEmail(originalEmailContent, targetAmount, vendor, reasoning) {
    console.log('📧 Creating AI-enhanced chunked email for:', targetAmount);
    
    // Parse the original email to extract headers and body
    const lines = originalEmailContent.split('\n');
    const headerLines = [];
    const bodyLines = [];
    let inHeaders = true;
    
    for (const line of lines) {
        if (inHeaders && line.trim() === '') {
            inHeaders = false;
            continue;
        }
        
        if (inHeaders) {
            headerLines.push(line);
        } else {
            bodyLines.push(line);
        }
    }
    
    // Modify subject line to include transaction amount and AI context
    const modifiedHeaders = [];
    for (const line of headerLines) {
        if (line.toLowerCase().startsWith('subject:')) {
            const originalSubject = line.substring(8).trim();
            modifiedHeaders.push(`Subject: ${originalSubject} - Transaction ${targetAmount} [AI-Processed]`);
        } else if (line.toLowerCase().startsWith('to:')) {
            modifiedHeaders.push('To: adrienne.caffarel-sourcegraph@airbase.com');
        } else if (!line.toLowerCase().startsWith('bcc:') && 
                  !line.toLowerCase().startsWith('cc:')) {
            modifiedHeaders.push(line);
        }
    }
    
    // Create enhanced body content
    const bodyContent = bodyLines.join('\n');
    
    // Add AI processing header
    const aiHeader = `
[EXPENSE GADGET - AI-ENHANCED PROCESSING]
🤖 This email was automatically processed using AI analysis
💰 Transaction Amount: ${targetAmount}
🏪 Vendor: ${vendor || 'Detected from email'}
🧠 Processing Logic: ${reasoning}
📧 Optimized for Airbase matching

---
RELEVANT CONTENT FOR ${targetAmount}:
${findRelevantContentForAmount(bodyContent, targetAmount)}

---
FULL ORIGINAL EMAIL:
`;
    
    const modifiedBody = aiHeader + bodyContent;
    
    // Combine headers and body
    const chunkedEmail = modifiedHeaders.join('\n') + '\n\n' + modifiedBody;
    
    return chunkedEmail;
}

function createChunkedAmazonEmail(originalEmailContent, targetAmount, orderInfo = {}) {
    console.log('Creating chunked email for amount:', targetAmount);
    
    // Parse the original email to extract headers and body
    const lines = originalEmailContent.split('\n');
    const headerLines = [];
    const bodyLines = [];
    let inHeaders = true;
    
    for (const line of lines) {
        if (inHeaders && line.trim() === '') {
            inHeaders = false;
            continue;
        }
        
        if (inHeaders) {
            headerLines.push(line);
        } else {
            bodyLines.push(line);
        }
    }
    
    // Modify subject line to include transaction amount
    const modifiedHeaders = [];
    for (const line of headerLines) {
        if (line.toLowerCase().startsWith('subject:')) {
            const originalSubject = line.substring(8).trim(); // Remove "Subject: "
            modifiedHeaders.push(`Subject: ${originalSubject} - Transaction ${targetAmount}`);
        } else if (line.toLowerCase().startsWith('to:')) {
            modifiedHeaders.push('To: adrienne.caffarel-sourcegraph@airbase.com');
        } else if (!line.toLowerCase().startsWith('bcc:') && 
                  !line.toLowerCase().startsWith('cc:')) {
            modifiedHeaders.push(line);
        }
    }
    
    // Create focused body content that highlights the relevant transaction
    const bodyContent = bodyLines.join('\n');
    
    // Add a header explaining this is a chunked transaction
    const chunkHeader = `
[EXPENSE GADGET - TRANSACTION MATCH]
This email has been processed to match Airbase transaction: ${targetAmount}
Original order may contain multiple transactions.

---
TRANSACTION DETAILS FOR ${targetAmount}:
${findRelevantContentForAmount(bodyContent, targetAmount)}

---
FULL ORIGINAL EMAIL CONTENT:
`;
    
    const modifiedBody = chunkHeader + bodyContent;
    
    // Combine headers and body
    const chunkedEmail = modifiedHeaders.join('\n') + '\n\n' + modifiedBody;
    
    return chunkedEmail;
}

function findRelevantContentForAmount(emailContent, targetAmount) {
    // Find lines in the email that contain or are near the target amount
    const lines = emailContent.split('\n');
    const relevantLines = [];
    const amountWithoutDollar = targetAmount.replace('$', '');
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        // Check if this line contains the target amount
        if (line.includes(targetAmount) || line.includes(amountWithoutDollar)) {
            // Include this line and surrounding context
            const start = Math.max(0, i - 2);
            const end = Math.min(lines.length - 1, i + 2);
            
            for (let j = start; j <= end; j++) {
                if (!relevantLines.includes(lines[j])) {
                    relevantLines.push(lines[j]);
                }
            }
        }
    }
    
    return relevantLines.length > 0 ? relevantLines.join('\n') : 'Amount found in email content';
}

// Forward email to Airbase inbox via Gmail
app.post('/forward-to-airbase', async (req, res) => {
    try {
        console.log('=== FORWARD TO AIRBASE REQUEST ===');
        console.log('Request body:', req.body);
        
        if (!req.session.googleTokens) {
            console.log('No Google tokens in session');
            return res.status(401).json({ error: 'Not authenticated with Google' });
        }

        const { emailId, airbaseAmounts } = req.body;
        
        if (!emailId) {
            console.log('No email ID provided');
            return res.status(400).json({ error: 'Email ID required' });
        }

        console.log('Forwarding email ID:', emailId);

        // Set credentials
        oauth2Client.setCredentials(req.session.googleTokens);
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
        console.log('Gmail client configured');

        // Get the original email
        console.log('Fetching original email...');
        const messageDetails = await gmail.users.messages.get({
            userId: 'me',
            id: emailId,
            format: 'raw'
        });
        console.log('Email fetched successfully');

        // Get the raw email content
        const rawEmail = messageDetails.data.raw;
        const emailBuffer = Buffer.from(rawEmail, 'base64');
        const emailContent = emailBuffer.toString();
        console.log('Email content length:', emailContent.length);
        console.log('Email preview:', emailContent.substring(0, 200) + '...');

        // Extract email headers for AI analysis
        let emailFrom = '';
        let emailSubject = '';
        const headerLines = emailContent.split('\n');
        for (const line of headerLines) {
            if (line.toLowerCase().startsWith('from:')) {
                emailFrom = line.substring(5).trim();
            } else if (line.toLowerCase().startsWith('subject:')) {
                emailSubject = line.substring(8).trim();
            }
            if (line.trim() === '') break; // End of headers
        }

        console.log('📧 Email metadata:', { from: emailFrom, subject: emailSubject });

        // AI-powered email analysis
        const aiAnalysis = await analyzeEmailWithAI(emailContent, emailSubject, emailFrom);
        console.log('🤖 AI Analysis complete:', aiAnalysis);

        // Check if we should process with AI-enhanced chunking
        const shouldUseAIChunking = (aiAnalysis.isReceipt && aiAnalysis.confidence > 0.6) || 
                                   (airbaseAmounts && airbaseAmounts.length > 0);

        if (shouldUseAIChunking) {
            console.log('=== AI-ENHANCED EMAIL PROCESSING ===');
            
            // Use AI to extract amounts (falls back to pattern matching if no API key)
            let emailAmounts = [];
            if (aiAnalysis.amounts && aiAnalysis.amounts.length > 0) {
                emailAmounts = aiAnalysis.amounts;
                console.log('📊 Using AI-extracted amounts:', emailAmounts);
            } else {
                // Fallback to pattern-based extraction
                emailAmounts = await extractAmountsWithAI(emailContent, aiAnalysis.vendor);
                console.log('📊 Using pattern-extracted amounts:', emailAmounts);
            }
            
            // Determine chunking strategy
            let amountsToProcess = [];
            let chunkingReason = '';
            
            if (airbaseAmounts && airbaseAmounts.length > 0) {
                // We have Airbase amounts to match against
                const matches = matchTransactionAmounts(airbaseAmounts, emailAmounts);
                amountsToProcess = matches.filter(m => m.amazonAmount).map(m => m.airbaseAmount);
                chunkingReason = 'Matching Airbase transaction amounts';
                console.log('🎯 Matching mode:', amountsToProcess.length, 'matches found');
            } else {
                // Use AI to decide how to chunk
                const chunkingDecision = await intelligentChunkingDecision(emailContent, emailAmounts, aiAnalysis.vendor);
                
                if (chunkingDecision.shouldChunk) {
                    amountsToProcess = chunkingDecision.amountsToProcess;
                    chunkingReason = chunkingDecision.reasoning;
                    console.log('🧠 AI chunking decision:', chunkingDecision.chunkingStrategy);
                } else {
                    amountsToProcess = []; // Process as single email
                    chunkingReason = 'AI recommends single email';
                    console.log('📧 AI recommends no chunking');
                }
            }
            
            // Process emails based on AI decision
            const results = [];
            let sentCount = 0;
            
            if (amountsToProcess.length > 0) {
                // Send chunked emails
                for (const amount of amountsToProcess) {
                    console.log(`📨 Creating chunked email for ${amount}`);
                    
                    // Create chunked email content with AI context
                    const chunkedEmail = createAIEnhancedChunkedEmail(
                        emailContent, 
                        amount, 
                        aiAnalysis.vendor,
                        chunkingReason
                    );
                    
                    // Encode and send
                    const encodedEmail = Buffer.from(chunkedEmail).toString('base64')
                        .replace(/\+/g, '-')
                        .replace(/\//g, '_')
                        .replace(/=+$/, '');
                    
                    try {
                        const result = await gmail.users.messages.send({
                            userId: 'me',
                            requestBody: {
                                raw: encodedEmail
                            }
                        });
                        
                        results.push({
                            amount: amount,
                            messageId: result.data.id,
                            success: true,
                            method: 'ai_chunked'
                        });
                        sentCount++;
                        
                        console.log(`✅ Sent AI-chunked email for ${amount}, Message ID: ${result.data.id}`);
                        
                    } catch (sendError) {
                        console.error(`❌ Failed to send chunked email for ${amount}:`, sendError);
                        results.push({
                            amount: amount,
                            success: false,
                            error: sendError.message,
                            method: 'ai_chunked'
                        });
                    }
                }
            } else {
                // Send single email (AI recommends no chunking)
                console.log('📧 AI recommends single email - continuing to regular forwarding');
            }
            
            // If we processed chunked emails, return the results
            if (sentCount > 0) {
                console.log(`=== AI PROCESSING COMPLETE: ${sentCount} emails sent ===`);
                
                res.json({
                    success: true,
                    chunked: true,
                    aiProcessed: true,
                    vendor: aiAnalysis.vendor,
                    confidence: aiAnalysis.confidence,
                    totalTransactions: amountsToProcess.length,
                    sentEmails: sentCount,
                    results: results,
                    recipient: 'adrienne.caffarel-sourcegraph@airbase.com'
                });
                return; // Exit early, we're done
            }
            
            // If AI recommended no chunking, fall through to regular forwarding
            
        } else {
            // Regular email forwarding (existing logic)
            console.log('=== REGULAR EMAIL FORWARDING ===');
            
            // Parse the email to modify headers
            const lines = emailContent.split('\n');
            const newLines = [];
            let inHeaders = true;
            let foundTo = false;

            for (const line of lines) {
                if (inHeaders && line.trim() === '') {
                    // End of headers, add our recipient and continue with body
                    if (!foundTo) {
                        newLines.push('To: adrienne.caffarel-sourcegraph@airbase.com');
                    }
                    newLines.push(''); // Empty line to separate headers from body
                    inHeaders = false;
                    continue;
                }

                if (inHeaders) {
                    // Modify headers
                    if (line.toLowerCase().startsWith('to:')) {
                        newLines.push('To: adrienne.caffarel-sourcegraph@airbase.com');
                        foundTo = true;
                    } else if (line.toLowerCase().startsWith('subject:')) {
                        // Keep original subject but could prefix with [Receipt] if needed
                        newLines.push(line);
                    } else if (!line.toLowerCase().startsWith('bcc:') && 
                              !line.toLowerCase().startsWith('cc:')) {
                        // Keep other headers except BCC/CC
                        newLines.push(line);
                    }
                } else {
                    // Keep body as-is
                    newLines.push(line);
                }
            }

            const modifiedEmail = newLines.join('\n');
            console.log('Modified email length:', modifiedEmail.length);
            console.log('Modified email preview:', modifiedEmail.substring(0, 300) + '...');
            
            const encodedEmail = Buffer.from(modifiedEmail).toString('base64')
                .replace(/\+/g, '-')
                .replace(/\//g, '_')
                .replace(/=+$/, '');

            console.log('Sending email to Gmail API...');
            // Send the modified email
            const result = await gmail.users.messages.send({
                userId: 'me',
                requestBody: {
                    raw: encodedEmail
                }
            });

            console.log('Email forwarded to Airbase successfully!');
            console.log('Message ID:', result.data.id);
            console.log('Thread ID:', result.data.threadId);
            
            res.json({
                success: true,
                messageId: result.data.id,
                recipient: 'adrienne.caffarel-sourcegraph@airbase.com'
            });
        }

    } catch (error) {
        console.error('Error forwarding to Airbase:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Send screenshot receipt to Airbase inbox via Gmail
app.post('/send-screenshot-to-airbase', strictLimiter, async (req, res) => {
    try {
        console.log('=== SEND SCREENSHOT TO AIRBASE REQUEST ===');
        
        if (!req.session.googleTokens) {
            console.log('No Google tokens in session');
            return res.status(401).json({ error: 'Not authenticated with Google' });
        }

        const { imageData, filename, description, amount, vendor } = req.body;
        
        if (!imageData) {
            console.log('No image data provided');
            return res.status(400).json({ error: 'Image data required' });
        }

        console.log('Processing screenshot upload...');
        
        // Validate image data
        const validatedImage = validateImageData(imageData);
        console.log('Image validation successful');

        // Generate filename
        const finalFilename = generateScreenshotFilename(filename, imageData, { vendor });
        console.log('Generated filename:', finalFilename);

        // Set Gmail credentials
        oauth2Client.setCredentials(req.session.googleTokens);
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
        console.log('Gmail client configured');

        // Create email content
        const airbaseEmail = 'adrienne.caffarel-sourcegraph@airbase.com';
        const timestamp = new Date().toLocaleString();
        
        // Build subject line
        let subjectParts = ['Receipt Screenshot'];
        if (vendor) subjectParts.push(vendor);
        if (amount) subjectParts.push(amount);
        subjectParts.push(new Date().toISOString().split('T')[0]); // Add date
        const subject = subjectParts.join(' - ');

        // Build email body
        const bodyParts = [
            'Automated receipt submission from Expense Gadget',
            '',
            `Description: ${description || 'Receipt screenshot'}`,
        ];
        
        if (vendor) bodyParts.push(`Vendor: ${vendor}`);
        if (amount) bodyParts.push(`Amount: ${amount}`);
        bodyParts.push(`Submitted: ${timestamp}`);
        bodyParts.push(`Filename: ${finalFilename}`);
        
        const body = bodyParts.join('\n');

        console.log('Email subject:', subject);
        console.log('Email body preview:', body.substring(0, 200));

        // Create multipart email with image attachment
        const boundary = '----=_Part_' + Date.now();
        const rawEmail = [
            `To: ${airbaseEmail}`,
            `Subject: ${subject}`,
            `MIME-Version: 1.0`,
            `Content-Type: multipart/mixed; boundary="${boundary}"`,
            '',
            `--${boundary}`,
            `Content-Type: text/plain; charset=utf-8`,
            '',
            body,
            '',
            `--${boundary}`,
            `Content-Type: ${validatedImage.mimeType}`,
            `Content-Disposition: attachment; filename="${finalFilename}"`,
            `Content-Transfer-Encoding: base64`,
            '',
            validatedImage.base64Data,
            '',
            `--${boundary}--`
        ].join('\n');

        console.log('Sending email to Gmail API...');
        console.log('Email size:', rawEmail.length, 'characters');

        // Send email via Gmail API
        const result = await gmail.users.messages.send({
            userId: 'me',
            requestBody: {
                raw: Buffer.from(rawEmail).toString('base64')
                    .replace(/\+/g, '-')
                    .replace(/\//g, '_')
                    .replace(/=+$/, '')
            }
        });

        console.log('Screenshot email sent successfully!');
        console.log('Message ID:', result.data.id);

        res.json({
            success: true,
            messageId: result.data.id,
            filename: finalFilename,
            recipient: airbaseEmail,
            subject: subject
        });

    } catch (error) {
        console.error('Error sending screenshot to Airbase:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            type: 'screenshot_upload_error'
        });
    }
});

// Secure email monitoring endpoint
app.post('/monitor-emails', strictLimiter, async (req, res) => {
    try {
        console.log('🔒 SECURE EMAIL MONITORING REQUEST');
        
        // Security checks
        if (!req.session.googleTokens) {
            console.log('❌ No authentication - monitoring denied');
            return res.status(401).json({ 
                success: false, 
                error: 'Authentication required for email monitoring' 
            });
        }

        // Rate limiting check (additional security)
        const userSession = req.session.id || 'unknown';
        const lastMonitorCheck = req.session.lastMonitorCheck || 0;
        const { isCatchup = false } = req.body;
        
        // Different rate limits for different operations
        const minInterval = isCatchup ? (30 * 1000) : (2 * 60 * 1000); // 30s for catchup, 2min for regular monitoring
        
        if (Date.now() - lastMonitorCheck < minInterval) {
            const waitTime = Math.ceil((minInterval - (Date.now() - lastMonitorCheck)) / 1000);
            console.log(`⏰ Rate limit: Too frequent monitoring requests (wait ${waitTime}s)`);
            return res.status(429).json({
                success: false,
                error: `Please wait ${waitTime} seconds before trying again`,
                waitTime: waitTime
            });
        }

        const { since, maxEmails = 10, securityMode = false } = req.body;
        
        // Security validation
        if (maxEmails > 50) {
            return res.status(400).json({
                success: false,
                error: 'Email limit too high for security'
            });
        }

        console.log('📧 Secure email monitoring parameters:', {
            since: new Date(since).toISOString(),
            maxEmails,
            securityMode
        });

        // Configure Gmail client
        oauth2Client.setCredentials(req.session.googleTokens);
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

        // Build secure search query
        const sinceDate = new Date(since);
        const formattedDate = sinceDate.toISOString().split('T')[0].replace(/-/g, '/');
        
        const secureQuery = [
            `after:${formattedDate}`,
            '(from:amazon.com OR from:uber.com OR from:doordash.com OR subject:receipt OR subject:invoice)',
            '-label:spam',
            '-label:trash'
        ].join(' ');

        console.log('🔍 Secure search query:', secureQuery);

        // Search for receipt emails (server-side only)
        const searchResponse = await gmail.users.messages.list({
            userId: 'me',
            q: secureQuery,
            maxResults: maxEmails
        });

        const emails = searchResponse.data.messages || [];
        console.log(`📨 Found ${emails.length} potential receipts`);

        let processedCount = 0;
        const results = [];

        // Process each email securely
        for (const email of emails) {
            try {
                // Get email metadata only (not full content initially)
                const emailData = await gmail.users.messages.get({
                    userId: 'me',
                    id: email.id,
                    format: 'metadata'
                });

                // Extract headers securely
                const headers = emailData.data.payload.headers;
                const from = headers.find(h => h.name.toLowerCase() === 'from')?.value || '';
                const subject = headers.find(h => h.name.toLowerCase() === 'subject')?.value || '';
                const date = headers.find(h => h.name.toLowerCase() === 'date')?.value || '';

                console.log(`📧 Analyzing: ${subject.substring(0, 50)}... from ${from.substring(0, 30)}`);

                // Quick AI analysis for security (minimal data exposure)
                const quickAnalysis = await analyzeEmailWithAI('', subject, from);
                
                if (quickAnalysis.isReceipt && quickAnalysis.confidence > 0.7) {
                    // Only process high-confidence receipts
                    
                    // Get full email content for processing
                    const fullEmailData = await gmail.users.messages.get({
                        userId: 'me',
                        id: email.id,
                        format: 'raw'
                    });

                    const rawEmail = fullEmailData.data.raw;
                    const emailBuffer = Buffer.from(rawEmail, 'base64');
                    const emailContent = emailBuffer.toString();

                    // Process with AI enhancement
                    const enhancedAnalysis = await analyzeEmailWithAI(emailContent, subject, from);
                    
                    if (enhancedAnalysis.shouldChunk && enhancedAnalysis.amounts.length > 1) {
                        // Process chunked emails
                        const chunkingDecision = await intelligentChunkingDecision(
                            emailContent, 
                            enhancedAnalysis.amounts, 
                            enhancedAnalysis.vendor
                        );

                        for (const amount of chunkingDecision.amountsToProcess) {
                            const chunkedEmail = createAIEnhancedChunkedEmail(
                                emailContent,
                                amount,
                                enhancedAnalysis.vendor,
                                'Automated monitoring with AI analysis'
                            );

                            await sendEmailToAirbase(chunkedEmail, gmail);
                            processedCount++;
                        }
                    } else {
                        // Process as single email
                        await forwardEmailToAirbase(email.id, gmail);
                        processedCount++;
                    }

                    results.push({
                        emailId: email.id,
                        subject: subject.substring(0, 50),
                        processed: true,
                        vendor: enhancedAnalysis.vendor
                    });

                } else {
                    console.log(`⏭️ Skipping non-receipt: ${subject.substring(0, 50)} (confidence: ${quickAnalysis.confidence})`);
                }

            } catch (emailError) {
                console.error(`❌ Failed to process email ${email.id}:`, emailError);
                results.push({
                    emailId: email.id,
                    processed: false,
                    error: 'Processing failed'
                });
            }
        }

        // Update session tracking
        req.session.lastMonitorCheck = Date.now();

        console.log(`✅ Secure monitoring complete: ${processedCount} receipts processed`);

        res.json({
            success: true,
            processedCount,
            totalChecked: emails.length,
            results: securityMode ? [] : results, // Don't return detailed results in security mode
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('❌ Secure email monitoring error:', error);
        res.status(500).json({
            success: false,
            error: 'Email monitoring failed',
            timestamp: new Date().toISOString()
        });
    }
});

// Send email to Airbase (helper for monitoring)
async function sendEmailToAirbase(emailContent, gmail) {
    const encodedEmail = Buffer.from(emailContent).toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

    return await gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw: encodedEmail }
    });
}

// Forward email to Airbase (helper for monitoring)
async function forwardEmailToAirbase(emailId, gmail) {
    // Get the original email
    const messageDetails = await gmail.users.messages.get({
        userId: 'me',
        id: emailId,
        format: 'raw'
    });

    const rawEmail = messageDetails.data.raw;
    const emailBuffer = Buffer.from(rawEmail, 'base64');
    const emailContent = emailBuffer.toString();

    // Modify headers for Airbase
    const lines = emailContent.split('\n');
    const newLines = [];
    let inHeaders = true;

    for (const line of lines) {
        if (inHeaders && line.trim() === '') {
            newLines.push('To: adrienne.caffarel-sourcegraph@airbase.com');
            newLines.push('');
            inHeaders = false;
            continue;
        }

        if (inHeaders) {
            if (line.toLowerCase().startsWith('to:')) {
                newLines.push('To: adrienne.caffarel-sourcegraph@airbase.com');
            } else if (!line.toLowerCase().startsWith('bcc:') && 
                      !line.toLowerCase().startsWith('cc:')) {
                newLines.push(line);
            }
        } else {
            newLines.push(line);
        }
    }

    const modifiedEmail = newLines.join('\n');
    return await sendEmailToAirbase(modifiedEmail, gmail);
}

// Authentication status endpoint (for background monitoring)
app.get('/auth/status', (req, res) => {
    res.json({
        authenticated: !!req.session.googleTokens,
        timestamp: new Date().toISOString()
    });
});

// Test endpoint for screenshot functionality (development only)
if (!isProduction) {
    app.post('/test-screenshot-validation', (req, res) => {
        try {
            const { imageData } = req.body;
            console.log('Testing screenshot validation...');
            
            const validatedImage = validateImageData(imageData);
            const filename = generateScreenshotFilename(null, imageData, {});
            
            res.json({
                success: true,
                validation: {
                    mimeType: validatedImage.mimeType,
                    sizeKB: Math.round(validatedImage.sizeInBytes / 1024),
                    filename: filename
                },
                message: 'Image validation successful'
            });
        } catch (error) {
            res.status(400).json({
                success: false,
                error: error.message
            });
        }
    });

    // Test endpoint for AI email analysis
    app.post('/test-ai-analysis', async (req, res) => {
        try {
            const { emailContent, emailSubject, emailFrom } = req.body;
            console.log('Testing AI email analysis...');
            
            const aiAnalysis = await analyzeEmailWithAI(emailContent, emailSubject, emailFrom);
            
            res.json({
                success: true,
                analysis: aiAnalysis,
                hasOpenAI: !!OPENAI_API_KEY,
                message: 'AI analysis complete'
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    });
}

// Send PDF receipt to Airbase inbox via Gmail (legacy - can be removed)
app.post('/send-to-airbase', async (req, res) => {
    try {
        if (!req.session.googleTokens) {
            return res.status(401).json({ error: 'Not authenticated with Google' });
        }

        const { pdfBase64, filename, vendor, amount, receiptDate } = req.body;
        
        if (!pdfBase64 || !filename) {
            return res.status(400).json({ error: 'PDF data and filename required' });
        }

        // Set credentials
        oauth2Client.setCredentials(req.session.googleTokens);
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

        // Create email with PDF attachment
        const airbaseEmail = 'adrienne.caffarel-sourcegraph@airbase.com';
        const subject = `Receipt: ${vendor || 'Unknown'} - ${amount || ''} - ${receiptDate || ''}`.trim();
        const body = `Automated receipt submission from Expense Gadget\n\nVendor: ${vendor || 'Unknown'}\nAmount: ${amount || 'Unknown'}\nDate: ${receiptDate || 'Unknown'}\nFilename: ${filename}`;

        // Create multipart email with attachment
        const boundary = '----=_Part_' + Date.now();
        const rawEmail = [
            `To: ${airbaseEmail}`,
            `Subject: ${subject}`,
            `MIME-Version: 1.0`,
            `Content-Type: multipart/mixed; boundary="${boundary}"`,
            '',
            `--${boundary}`,
            `Content-Type: text/plain; charset=utf-8`,
            '',
            body,
            '',
            `--${boundary}`,
            `Content-Type: application/pdf`,
            `Content-Disposition: attachment; filename="${filename}"`,
            `Content-Transfer-Encoding: base64`,
            '',
            pdfBase64,
            '',
            `--${boundary}--`
        ].join('\n');

        // Send email
        const result = await gmail.users.messages.send({
            userId: 'me',
            requestBody: {
                raw: Buffer.from(rawEmail).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
            }
        });

        console.log('Email sent to Airbase:', result.data.id);
        
        res.json({
            success: true,
            messageId: result.data.id,
            recipient: airbaseEmail
        });

    } catch (error) {
        console.error('Error sending to Airbase:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Experimental Vision API endpoint for testing
app.post('/vision-test', async (req, res) => {
    try {
        // Initialize Vision client - use environment variables in production, JSON file locally
        let clientConfig;
        
        if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
            // Production: use environment variable
            const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
            clientConfig = {
                projectId: credentials.project_id,
                credentials: credentials
            };
        } else {
            // Local development: use JSON file
            clientConfig = {
                projectId: 'sourcegraph-dev',
                keyFilename: './sourcegraph-dev-0fb0280dc0e5.json'
            };
        }
        
        const client = new vision.ImageAnnotatorClient(clientConfig);
        console.log('Vision API client initialized successfully');
        
        // Test with a simple text detection on a sample image (base64 encoded text)
        const testImageBase64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=';
        
        const [result] = await client.textDetection({
            image: { content: Buffer.from(testImageBase64, 'base64') }
        });
        
        res.json({
            success: true,
            message: 'Vision API connected and working',
            projectId: clientConfig.projectId,
            timestamp: new Date().toISOString(),
            environment: process.env.GOOGLE_SERVICE_ACCOUNT_JSON ? 'production' : 'development',
            testResult: result.textAnnotations ? 'Text detection working' : 'No text detected in test image'
        });
        
    } catch (error) {
        console.error('Vision API test error:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            errorType: error.code || 'unknown'
        });
    }
});

if (missingCriticalVars.length > 0) {
    console.error('❌ Missing critical environment variables:', missingCriticalVars.join(', '));
    if (isProduction) {
        console.error('❌ Cannot start in production without critical environment variables');
        process.exit(1);
    } else {
        console.warn('⚠️  Development mode: continuing with missing critical variables');
    }
}

if (missingSessionSecret && isProduction) {
    console.warn('⚠️  Production deployment should set SESSION_SECRET for security');
}

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Receipt parser server running on port ${PORT}`);
    console.log(`🔒 Security enabled: ${isProduction ? 'Production' : 'Development'} mode`);
    console.log(`🛡️  Rate limiting: ${limiter.windowMs / 60000} minutes window, ${limiter.max} requests max`);
});
