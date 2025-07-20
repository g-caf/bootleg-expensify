const express = require('express');
const multer = require('multer');
const cors = require('cors');
const pdf = require('pdf-parse');
const session = require('express-session');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const validator = require('validator');



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
        secure: isProduction, // Use secure cookies in production
        httpOnly: false, // Allow extension to access cookie (extensions are trusted environment)
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
        sameSite: 'none' // Required for cross-origin requests from extensions
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
                return vendor.charAt(0).toUpperCase() + vendor.slice(1).toLowerCase();
            }
        }
    }

    console.log('      No vendor found in text');
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

// Debug endpoint to test PDFShift with detailed logging
app.get('/debug/test-pdfshift', requireDebugAuth, async (req, res) => {
    try {
        const token = process.env.PDFSHIFT_API_KEY;
        console.log('=== PDFSHIFT DEBUG TEST ===');
        console.log('Token available:', !!token);
        console.log('Token starts with:', token ? token.substring(0, 8) + '...' : 'N/A');

        if (!token || token === 'YOUR_PDFSHIFT_KEY') {
            return res.status(400).json({ error: 'PDFSHIFT_API_KEY not set' });
        }

        const simpleHTML = `<!DOCTYPE html>
<html>
<head><title>Test</title></head>
<body><h1>Test PDF Generation with PDFShift</h1><p>This is a test from ${new Date().toISOString()}.</p></body>
</html>`;

        const requestBody = {
            source: simpleHTML,
            format: 'A4',
            margin: '0.5in'
        };

        console.log('Making request to PDFShift...');
        console.log('Request URL:', 'https://api.pdfshift.io/v3/convert/pdf');
        console.log('Request body size:', JSON.stringify(requestBody).length);

        const authHeader = `Basic ${Buffer.from('api:' + token).toString('base64')}`;
        console.log('Auth header format:', authHeader.substring(0, 20) + '...');

        const response = await fetch('https://api.pdfshift.io/v3/convert/pdf', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': authHeader
            },
            body: JSON.stringify(requestBody)
        });

        console.log('Response status:', response.status);
        console.log('Response headers:', Object.fromEntries(response.headers.entries()));

        if (!response.ok) {
            const errorText = await response.text();
            console.log('Error response body:', errorText);
            return res.status(500).json({
                error: `PDFShift API error: ${response.status}`,
                details: errorText,
                headers: Object.fromEntries(response.headers.entries())
            });
        }

        const arrayBuffer = await response.arrayBuffer();
        const pdfBuffer = Buffer.from(arrayBuffer);
        const pdfHeader = pdfBuffer.toString('ascii', 0, 4);

        console.log('Success! PDF generated, size:', pdfBuffer.length);
        console.log('PDF header:', pdfHeader);

        res.json({
            success: true,
            pdfSize: pdfBuffer.length,
            pdfHeader: pdfHeader,
            isValidPDF: pdfHeader === '%PDF',
            responseHeaders: Object.fromEntries(response.headers.entries())
        });

    } catch (error) {
        console.error('PDFShift test error:', error);
        res.status(500).json({ error: error.message, stack: error.stack });
    }
});

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

        // Focused search for RECEIPTS (not delivery notifications) from Big 3 platforms
        const query = [
            '(',
            // Amazon order confirmations (NOT deliveries)
            'from:amazon.com (subject:"Ordered:" OR subject:"Order Confirmation" OR subject:"Your Amazon.com order")',
            ') OR (',
            // DoorDash receipts
            'from:doordash.com (subject:receipt OR subject:"Order confirmed" OR subject:"Your DoorDash receipt")',
            ') OR (',
            // Instacart receipts  
            'from:instacart.com (subject:receipt OR subject:"Your Instacart order receipt" OR subject:"Order receipt")',
            ')',
            // Exclude delivery/shipping notifications
            '-subject:Shipped: -subject:Delivered: -subject:"Out for delivery" -subject:"Your package"',
            // Exclude refunds and cancellations
            '-subject:refund -subject:cancelled -subject:canceled -subject:"order cancelled"',
            // Use date range - from X days ago to Y days ago (handle today = 0)
            toDays === 0 ? `newer_than:${fromDays}d` : `newer_than:${fromDays}d older_than:${toDays}d`
        ].join(' ');

        console.log('Gmail search query:', query);

        // Scale maxResults based on date range - more days = more potential emails
        const daySpan = fromDays - toDays + 1; // Total days in the range
        const maxResults = Math.min(250, Math.max(25, daySpan * 5)); // 5 emails per day on average, max 250
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

        const results = [];
        let processedCount = 0;
        let emailIndex = 0;

        // Process each email - limit based on date range to avoid overwhelming the system  
        const emailsToProcess = Math.min(50, Math.max(10, Math.floor(daySpan / 2))); // 1 email per 2 days, min 10, max 50
        console.log(`Processing first ${emailsToProcess} emails out of ${searchResponse.data.messages.length} found`);

        for (const message of searchResponse.data.messages.slice(0, emailsToProcess)) {
            emailIndex++;
            try {
                console.log(`\n=== EMAIL ${emailIndex}/${emailsToProcess} ===`);
                console.log(`Processing message ID: ${message.id}`);

                // Check if we've already processed this email
                if (processedEmailIds.has(message.id)) {
                    console.log(`  ❌ SKIPPED: Already processed email: ${message.id}`);
                    continue;
                }

                // Get full message details
                const messageDetails = await gmail.users.messages.get({
                    userId: 'me',
                    id: message.id
                });

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

                // Process the email content itself (convert HTML to PDF)
                try {
                    console.log(`    🔄 Processing email content to PDF`);

                    // Extract email HTML content
                    const emailHTML = extractEmailHTML(msg.payload);
                    if (!emailHTML || emailHTML.trim().length === 0) {
                        console.log(`    ❌ No HTML content found in email`);
                        continue;
                    }

                    console.log(`    ✅ HTML content extracted: ${emailHTML.length} characters`);

                    // Convert HTML email to PDF and process
                    const processed = await processEmailContent(emailHTML, subject, sender, req.session.googleTokens, date, originalSender);

                    console.log(`    📊 Processing result: ${processed.success ? '✅ SUCCESS' : '❌ FAILED'}`);
                    if (processed.vendor) console.log(`       Vendor: ${processed.vendor}`);
                    if (processed.amount) console.log(`       Amount: ${processed.amount}`);
                    if (processed.receiptDate) console.log(`       Date: ${processed.receiptDate}`);
                    if (processed.error) console.log(`       Error: ${processed.error}`);

                    results.push({
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
                    });

                    if (processed.success) {
                        processedCount++;
                        // Mark email as processed to prevent duplicates
                        processedEmailIds.add(message.id);
                        saveProcessedEmails(processedEmailIds);
                        console.log(`    💾 Saved email ID to processed list`);
                    }

                } catch (emailError) {
                    console.error(`Error processing email content:`, emailError);
                    results.push({
                        messageId: message.id,
                        subject: subject,
                        sender: sender,
                        processed: false,
                        error: emailError.message
                    });
                }

            } catch (messageError) {
                console.error(`Error processing message ${message.id}:`, messageError);
                results.push({
                    messageId: message.id,
                    processed: false,
                    error: messageError.message
                });
            }
        }

        console.log(`=== GMAIL SCAN COMPLETE ===`);
        console.log(`Processed ${processedCount} receipts from ${searchResponse.data.messages.length} emails`);

        res.json({
            success: true,
            receiptsFound: searchResponse.data.messages.length,
            receiptsProcessed: processedCount,
            dayRangeFrom: fromDays,
            dayRangeTo: toDays,
            daySpan: daySpan,
            results: results
        });

    } catch (error) {
        console.error('Gmail scan error:', error);
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

        // Extract vendor, amount, and date from email content
        console.log(`    🏪 Extracting vendor...`);
        let vendor = extractVendor(text);
        
        // Try to extract vendor from original sender first, then current sender
        if (!vendor && originalSender) {
            console.log(`    🔄 Trying original sender: ${originalSender}`);
            vendor = extractVendorFromSender(originalSender);
        }
        if (!vendor && sender) {
            vendor = extractVendorFromSender(sender);
        }

        // Try to extract vendor from subject if still not found
        if (!vendor && subject) {
            vendor = extractVendorFromSubject(subject);
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

        // Generate PDF with PDFShift
        const pdfBuffer = await createEmailReceiptPDFWithPDFShift({
            sender,
            subject,
            vendor: vendor || 'Not found',
            amount: amount || 'Not found',
            receiptDate: receiptDate || 'Not found',
            emailContent: text.substring(0, 1500),
            htmlContent: htmlContent // Pass raw HTML for better rendering
        });

        console.log(`    Generated PDF: ${pdfBuffer.length} bytes with PDFShift`);

        // Check if we got a valid PDF or text fallback
        const isPDF = pdfBuffer.toString('ascii', 0, 4) === '%PDF';
        console.log(`    📋 Generated content type: ${isPDF ? 'Valid PDF' : 'Text fallback'}`);

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
        
        // Check if API key is configured
        const apiKey = process.env.PDFSHIFT_API_KEY;
        if (!apiKey || apiKey === 'YOUR_PDFSHIFT_KEY') {
            throw new Error('PDFSHIFT_API_KEY not configured');
        }
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
            throw new Error(`PDFShift API error: ${pdfshiftResponse.status} - ${errorText}`);
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
            'https://www.googleapis.com/auth/gmail.readonly'
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

        // Convert HTML to PDF with PDFShift
        const pdfshiftToken = process.env.PDFSHIFT_API_KEY;
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
            googleDrive: driveUpload
        });

    } catch (error) {
        console.error('Error converting email to PDF:', error);
        res.status(500).json(sanitizeError(error));
    }
});

// Debug endpoint to check PDFShift configuration
app.get('/debug-pdfshift', requireDebugAuth, (req, res) => {
    const apiKey = process.env.PDFSHIFT_API_KEY;
    res.json({
        hasApiKey: !!apiKey,
        keyPrefix: apiKey ? apiKey.substring(0, 8) + '...' : 'No key',
        keyLength: apiKey ? apiKey.length : 0
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
const criticalEnvVars = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'PDFSHIFT_API_KEY'];
const missingCriticalVars = criticalEnvVars.filter(envVar => !process.env[envVar]);
const missingSessionSecret = !process.env.SESSION_SECRET;

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
