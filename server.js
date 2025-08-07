const express = require('express');
const cors = require('cors');
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

console.log('=== POSTMESSAGE AUTH FIX DEPLOYED - DIRECT TOKEN TRANSFER ===');

// Security middleware
app.use(helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: false
}));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100,
    message: { error: 'Too many requests, please try again later' },
    standardHeaders: true,
    legacyHeaders: false
});
app.use(limiter);

// Stricter rate limiting for expensive operations
const strictLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20,
    message: { error: 'Too many operations, please try again later' }
});

// Google OAuth configuration
const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || 'https://bootleg-expensify-34h3.onrender.com/auth/google/callback'
);

// Session configuration
if (!process.env.SESSION_SECRET) {
    if (isProduction) {
        console.error('❌ SESSION_SECRET is required in production');
        process.exit(1);
    } else {
        console.warn('⚠️  SESSION_SECRET not set - using fallback');
    }
}

app.use(session({
    secret: process.env.SESSION_SECRET || 'expense-gadget-fallback-' + Date.now(),
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: false, // Extensions have issues with secure cookies
        httpOnly: false, // Extension needs access to session cookie  
        maxAge: 4 * 60 * 60 * 1000, // 4 hours
        sameSite: 'none' // Required for cross-origin extension requests
    }
}));

// CORS configuration
const allowedOrigins = [
    'https://bootleg-expensify-34h3.onrender.com',
    /^chrome-extension:\/\/[a-z]{32}$/,
    /^moz-extension:\/\/[a-z0-9-]+$/,
];

if (!isProduction) {
    allowedOrigins.push('http://localhost:3000', 'http://localhost:10000');
}

app.use(cors({
    origin: (origin, callback) => {
        console.log(`🌐 CORS request from origin: ${origin || 'no origin'}`);
        
        if (!origin) return callback(null, true);
        
        const isAllowed = allowedOrigins.some(allowed => {
            if (typeof allowed === 'string') return allowed === origin;
            return allowed.test(origin);
        });
        
        if (isAllowed) {
            console.log(`✅ Allowed CORS request from: ${origin}`);
            callback(null, true);
        } else {
            console.warn(`❌ Blocked CORS request from: ${origin}`);
            if (!isProduction) {
                console.warn(`🔧 Debug mode: allowing blocked origin anyway`);
                callback(null, true);
            } else {
                callback(new Error('Not allowed by CORS'));
            }
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Debug-Key', 'X-Extension-Version']
}));

// Request logging middleware
app.use((req, res, next) => {
    console.log(`📞 ${req.method} ${req.url}`);
    console.log(`   Origin: ${req.headers.origin || 'NO ORIGIN'}`);
    next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Input sanitization functions
function sanitizeText(text) {
    if (!text || typeof text !== 'string') return '';
    return validator.escape(text.trim().substring(0, 10000));
}

function sanitizeEmail(email) {
    if (!email || typeof email !== 'string') return '';
    return validator.isEmail(email) ? validator.normalizeEmail(email) : '';
}

// Error handling
function sanitizeError(error) {
    if (isProduction) {
        return { error: 'An error occurred processing your request' };
    }
    const message = error.message || 'Unknown error';
    return { 
        error: message.replace(/\/[^\/\s]+\/[^\/\s]+\.js/g, '[FILE]')
                      .replace(/api[_-]?key[s]?[:\s=]+[^\s]+/gi, 'API_KEY=[REDACTED]')
    };
}

// ===========================================
// CORE GMAIL SEARCH FUNCTIONALITY
// ===========================================

// Gmail search endpoint
app.post('/scan-gmail', strictLimiter, async (req, res) => {
    try {
        if (!req.session.googleTokens) {
            return res.status(401).json({ error: 'Not authenticated with Google' });
        }

        const { fromDays = 30, toDays = 0, maxEmails = 50 } = req.body;
        
        if (maxEmails > 100) {
            return res.status(400).json({ error: 'Maximum 100 emails per request' });
        }

        console.log(`\n=== GMAIL SEARCH ===`);
        console.log(`Date range: ${fromDays} to ${toDays} days ago`);
        console.log(`Max emails: ${maxEmails}`);

        oauth2Client.setCredentials(req.session.googleTokens);
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

        // Build search query
        const fromDate = new Date();
        fromDate.setDate(fromDate.getDate() - fromDays);
        const toDate = new Date();
        toDate.setDate(toDate.getDate() - toDays);

        const fromFormatted = fromDate.toISOString().split('T')[0].replace(/-/g, '/');
        const toFormatted = toDate.toISOString().split('T')[0].replace(/-/g, '/');

        const query = [
            `after:${fromFormatted}`,
            `before:${toFormatted}`,
            '(subject:"receipt" OR subject:"order" OR subject:"invoice" OR subject:"confirmation")',
            '-in:sent',
            '-label:spam',
            '-label:trash'
        ].join(' ');

        console.log('Search query:', query);

        const searchResponse = await gmail.users.messages.list({
            userId: 'me',
            q: query,
            maxResults: maxEmails
        });

        if (!searchResponse.data.messages) {
            return res.json({
                success: true,
                receiptsFound: 0,
                receiptsProcessed: 0,
                results: []
            });
        }

        console.log(`Found ${searchResponse.data.messages.length} potential receipt emails`);
        
        const results = [];
        let processedCount = 0;

        // Process first 10 emails to avoid timeout
        const emailsToProcess = Math.min(10, searchResponse.data.messages.length);
        
        for (let i = 0; i < emailsToProcess; i++) {
            const message = searchResponse.data.messages[i];
            
            try {
                console.log(`\n=== EMAIL ${i + 1}/${emailsToProcess} ===`);
                
                const messageDetails = await gmail.users.messages.get({
                    userId: 'me',
                    id: message.id
                });

                const msg = messageDetails.data;
                const subject = getHeader(msg.payload.headers, 'Subject') || 'Unknown Subject';
                const sender = getHeader(msg.payload.headers, 'From') || 'Unknown Sender';
                const date = getHeader(msg.payload.headers, 'Date') || 'Unknown Date';

                console.log(`  📧 Subject: ${subject}`);
                console.log(`  👤 From: ${sender}`);
                console.log(`  📅 Date: ${date}`);

                // Extract email content
                const emailHTML = extractEmailHTML(msg.payload);
                if (!emailHTML || emailHTML.trim().length === 0) {
                    console.log(`    ❌ No HTML content found`);
                    continue;
                }

                // Basic data extraction
                const text = emailHTML.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
                const vendor = extractVendorFromSender(sender) || extractBasicVendor(text);
                const amount = extractBasicAmount(text);
                const receiptDate = extractBasicDate(date);

                console.log(`    💰 Amount: ${amount || 'Not found'}`);
                console.log(`    🏪 Vendor: ${vendor || 'Not found'}`);

                const result = {
                    messageId: message.id,
                    subject: subject,
                    sender: sender,
                    processed: !!(vendor && amount),
                    vendor: vendor,
                    amount: amount,
                    receiptDate: receiptDate,
                    emailContent: text.substring(0, 500) + '...'
                };

                results.push(result);
                if (result.processed) processedCount++;

            } catch (error) {
                console.error(`Error processing message ${message.id}:`, error);
                results.push({
                    messageId: message.id,
                    processed: false,
                    error: error.message
                });
            }
        }

        console.log(`\n=== SEARCH COMPLETE ===`);
        console.log(`Processed ${processedCount} receipts from ${searchResponse.data.messages.length} emails`);

        res.json({
            success: true,
            receiptsFound: searchResponse.data.messages.length,
            receiptsProcessed: processedCount,
            results: results
        });

    } catch (error) {
        console.error('Gmail scan error:', error);
        res.status(500).json(sanitizeError(error));
    }
});

// ===========================================
// SEND-TO-AIRBASE FUNCTIONALITY
// ===========================================

// Forward email to Airbase
app.post('/forward-to-airbase', async (req, res) => {
    try {
        if (!req.session.googleTokens) {
            return res.status(401).json({ error: 'Not authenticated with Google' });
        }

        const { emailId } = req.body;
        
        if (!emailId) {
            return res.status(400).json({ error: 'Email ID required' });
        }

        console.log('Forwarding email ID:', emailId);

        oauth2Client.setCredentials(req.session.googleTokens);
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

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
        let foundTo = false;

        for (const line of lines) {
            if (inHeaders && line.trim() === '') {
                if (!foundTo) {
                    newLines.push('To: adrienne.caffarel-sourcegraph@airbase.com');
                }
                newLines.push('');
                inHeaders = false;
                continue;
            }

            if (inHeaders) {
                if (line.toLowerCase().startsWith('to:')) {
                    newLines.push('To: adrienne.caffarel-sourcegraph@airbase.com');
                    foundTo = true;
                } else if (line.toLowerCase().startsWith('subject:')) {
                    newLines.push(line);
                } else if (!line.toLowerCase().startsWith('bcc:') && 
                          !line.toLowerCase().startsWith('cc:')) {
                    newLines.push(line);
                }
            } else {
                newLines.push(line);
            }
        }

        const modifiedEmail = newLines.join('\n');
        
        const encodedEmail = Buffer.from(modifiedEmail).toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');

        // Send the modified email
        const result = await gmail.users.messages.send({
            userId: 'me',
            requestBody: {
                raw: encodedEmail
            }
        });

        console.log('Email forwarded to Airbase successfully!');
        console.log('Message ID:', result.data.id);
        
        res.json({
            success: true,
            messageId: result.data.id,
            recipient: 'adrienne.caffarel-sourcegraph@airbase.com'
        });

    } catch (error) {
        console.error('Error forwarding to Airbase:', error);
        res.status(500).json(sanitizeError(error));
    }
});

// ===========================================
// AUTHENTICATION SYSTEM
// ===========================================

// Google OAuth routes
app.get('/auth/google', (req, res) => {
    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: [
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
        req.session.googleTokens = tokens;

        // Generate a simple auth code for the extension
        const authCode = 'auth_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        
        // Store token with auth code (in-memory, 10 minute expiry)
        global.authTokens = global.authTokens || {};
        global.authTokens[authCode] = {
            access_token: tokens.access_token,
            expires: Date.now() + (10 * 60 * 1000) // 10 minutes
        };
        
        res.send(`
            <html>
                <body>
                    <h2>✅ Authentication Successful!</h2>
                    <script>
                        // Redirect to extension with auth code
                        window.location.href = 'chrome-extension://redirect?auth=${authCode}';
                    </script>
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

// Authentication status
app.get('/auth/status', (req, res) => {
    const isAuthenticated = !!(req.session.googleTokens);
    console.log(`🔍 Auth status check: ${isAuthenticated ? 'AUTHENTICATED' : 'NOT AUTHENTICATED'}`);
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

// Get token by auth key (for extension)
app.get('/auth/token/:authKey', (req, res) => {
    const { authKey } = req.params;
    
    if (!global.tempAuthTokens || !global.tempAuthTokens[authKey]) {
        return res.status(404).json({ error: 'Token not found or expired' });
    }
    
    const tokenData = global.tempAuthTokens[authKey];
    
    // Check if expired
    if (Date.now() > tokenData.expires) {
        delete global.tempAuthTokens[authKey];
        return res.status(410).json({ error: 'Token expired' });
    }
    
    // Return token and delete it (one-time use)
    const token = tokenData.token;
    delete global.tempAuthTokens[authKey];
    
    res.json({
        access_token: token
    });
});

// ===========================================
// DEBUG ENDPOINTS
// ===========================================

// Debug authentication
app.get('/debug/auth', strictLimiter, (req, res) => {
    try {
        console.log('🔍 Debug auth check requested');
        
        const authStatus = {
            sessionExists: !!req.session,
            sessionId: req.sessionID?.substring(0, 8),
            hasGoogleTokens: !!(req.session.googleTokens),
            tokenType: req.session.googleTokens?.token_type || 'none',
            environment: isProduction ? 'production' : 'development',
            timestamp: new Date().toISOString()
        };

        console.log('🔍 Auth debug info:', authStatus);
        
        res.json({
            success: true,
            auth: authStatus
        });
    } catch (error) {
        console.error('Debug auth error:', error);
        res.status(500).json(sanitizeError(error));
    }
});

// Debug Gmail test
app.get('/debug/gmail-test', strictLimiter, async (req, res) => {
    try {
        if (!req.session.googleTokens) {
            return res.status(401).json({ error: 'Not authenticated with Google' });
        }

        console.log('🔍 Testing Gmail connection...');
        
        oauth2Client.setCredentials(req.session.googleTokens);
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

        // Test basic Gmail access
        const profile = await gmail.users.getProfile({ userId: 'me' });
        
        // Test search capability
        const testSearch = await gmail.users.messages.list({
            userId: 'me',
            q: 'in:inbox',
            maxResults: 5
        });

        console.log('✅ Gmail connection test successful');
        
        res.json({
            success: true,
            profile: {
                emailAddress: profile.data.emailAddress,
                messagesTotal: profile.data.messagesTotal,
                threadsTotal: profile.data.threadsTotal
            },
            testSearch: {
                found: testSearch.data.messages?.length || 0,
                hasNextPage: !!testSearch.data.nextPageToken
            },
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Gmail test error:', error);
        res.status(500).json(sanitizeError(error));
    }
});

// ===========================================
// HELPER FUNCTIONS
// ===========================================

function getHeader(headers, name) {
    const header = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
    return header ? header.value : null;
}

function extractEmailHTML(payload) {
    let htmlContent = '';

    function searchParts(parts) {
        if (!parts) return;

        for (const part of parts) {
            if (part.mimeType === 'text/html' && part.body && part.body.data) {
                const decoded = Buffer.from(part.body.data, 'base64url').toString('utf-8');
                htmlContent += decoded;
            }
            if (part.parts) {
                searchParts(part.parts);
            }
        }
    }

    if (payload.mimeType === 'text/html' && payload.body && payload.body.data) {
        htmlContent = Buffer.from(payload.body.data, 'base64url').toString('utf-8');
    } else {
        searchParts(payload.parts || []);
    }

    return htmlContent;
}

function extractVendorFromSender(sender) {
    const emailMatch = sender.match(/@([^>.\s]+\.[^>.\s]+)/);
    if (!emailMatch) return null;
    
    const domain = emailMatch[1].toLowerCase();
    
    // Skip forwarding domains
    const forwardingDomains = ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com'];
    if (forwardingDomains.includes(domain)) {
        return null;
    }

    // Domain-to-vendor mapping
    const domainMappings = {
        'amazon.com': 'Amazon',
        'target.com': 'Target',
        'walmart.com': 'Walmart',
        'doordash.com': 'DoorDash',
        'uber.com': 'Uber',
        'starbucks.com': 'Starbucks',
        'paypal.com': 'PayPal'
    };

    if (domainMappings[domain]) {
        return domainMappings[domain];
    }

    // Fallback: extract company name from domain
    const companyName = domain.split('.')[0];
    if (companyName && companyName.length > 2) {
        return companyName.charAt(0).toUpperCase() + companyName.slice(1);
    }

    return null;
}

function extractBasicVendor(text) {
    const businessPatterns = [
        /([A-Z][a-zA-Z\s&]+?)\s+(?:Store|Inc|LLC|Corp|Co\.|Restaurant|Cafe)/i,
        /Thank you for shopping at\s+([A-Za-z0-9\s&]+)/i,
        /Receipt from\s+([A-Za-z0-9\s&]+)/i
    ];

    for (const pattern of businessPatterns) {
        const match = text.match(pattern);
        if (match && match[1]) {
            let vendor = match[1].trim();
            vendor = vendor.replace(/\s+(Inc|LLC|Corp|Co\.|Store|Restaurant|Cafe)$/i, '');
            if (vendor.length > 1 && vendor.length < 30) {
                return vendor.charAt(0).toUpperCase() + vendor.slice(1).toLowerCase();
            }
        }
    }
    return null;
}

function extractBasicAmount(text) {
    // Look for dollar amounts
    const amountPatterns = [
        /(?:Total|Amount|Charged)[:\s]*\$(\d+\.\d{2})/i,
        /\$(\d+\.\d{2})/g
    ];

    for (const pattern of amountPatterns) {
        const match = text.match(pattern);
        if (match) {
            const amount = parseFloat(match[1] || match[0].replace('$', ''));
            if (amount > 0 && amount < 10000) {
                return '$' + amount.toFixed(2);
            }
        }
    }
    return null;
}

function extractBasicDate(emailDate) {
    if (!emailDate || emailDate === 'Unknown Date') {
        return new Date().toISOString().split('T')[0];
    }
    
    try {
        const date = new Date(emailDate);
        if (isNaN(date.getTime())) {
            return new Date().toISOString().split('T')[0];
        }
        return date.toISOString().split('T')[0];
    } catch (error) {
        return new Date().toISOString().split('T')[0];
    }
}

// ===========================================
// ENVIRONMENT VALIDATION & SERVER START
// ===========================================

const criticalEnvVars = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'];
const missingCriticalVars = criticalEnvVars.filter(envVar => !process.env[envVar]);

if (missingCriticalVars.length > 0) {
    console.error('❌ Missing critical environment variables:', missingCriticalVars.join(', '));
    if (isProduction) {
        console.error('❌ Cannot start in production without critical environment variables');
        process.exit(1);
    } else {
        console.warn('⚠️  Development mode: continuing with missing critical variables');
    }
}

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Minimal server running on port ${PORT}`);
    console.log(`🔒 Security: ${isProduction ? 'Production' : 'Development'} mode`);
    console.log(`📊 Features: Gmail search + Send-to-Airbase only`);
    console.log(`🛡️  Rate limiting: ${limiter.max} requests per ${limiter.windowMs / 60000} minutes`);
    console.log('=== BACKEND SURGERY COMPLETE ===');
});
