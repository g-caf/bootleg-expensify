// Smart Email Filtering Patterns for Receipt Detection
// Integrates with background.js email monitoring system

class EmailReceiptFilter {
    constructor() {
        this.processedEmailHashes = new Set();
        this.maxHashStorage = 1000;
        this.cleanupThreshold = 0.8;
    }

    // Main filtering function - conservative approach
    async filterEmail(emailData) {
        const { subject, sender, body, date, messageId } = emailData;
        
        // Deduplication check first
        const emailHash = this.generateEmailHash(emailData);
        if (this.processedEmailHashes.has(emailHash)) {
            return { isReceipt: false, reason: 'duplicate', vendor: null };
        }

        // Apply filtering patterns
        const filterResult = this.applyReceiptPatterns(subject, sender, body);
        
        // Store hash if it's a receipt to prevent reprocessing
        if (filterResult.isReceipt) {
            this.addToProcessedHashes(emailHash);
        }

        return {
            ...filterResult,
            emailHash,
            confidence: this.calculateConfidence(filterResult, subject, sender, body)
        };
    }

    // Generate unique hash for deduplication
    generateEmailHash(emailData) {
        const hashString = `${emailData.sender}|${emailData.subject}|${emailData.date}|${emailData.messageId?.slice(-8) || ''}`;
        return btoa(hashString).slice(0, 16);
    }

    // Deduplication management
    addToProcessedHashes(hash) {
        this.processedEmailHashes.add(hash);
        
        // Cleanup when approaching limit
        if (this.processedEmailHashes.size > this.maxHashStorage * this.cleanupThreshold) {
            const hashArray = Array.from(this.processedEmailHashes);
            const keepHashes = hashArray.slice(-Math.floor(this.maxHashStorage * 0.6));
            this.processedEmailHashes = new Set(keepHashes);
        }
    }

    // Main pattern matching logic - conservative filtering
    applyReceiptPatterns(subject, sender, body) {
        const patterns = {
            amazon: this.checkAmazonReceipt(subject, sender, body),
            uber: this.checkUberReceipt(subject, sender, body),
            doordash: this.checkDoorDashReceipt(subject, sender, body),
            generic: this.checkGenericReceipt(subject, sender, body)
        };

        // Find best match with highest confidence
        let bestMatch = { isReceipt: false, vendor: null, matchType: null, indicators: [] };
        let highestScore = 0;

        for (const [vendor, result] of Object.entries(patterns)) {
            if (result.isReceipt && result.score > highestScore) {
                highestScore = result.score;
                bestMatch = {
                    isReceipt: true,
                    vendor,
                    matchType: result.type,
                    indicators: result.indicators,
                    score: result.score
                };
            }
        }

        return bestMatch;
    }

    // Amazon receipt patterns
    checkAmazonReceipt(subject, sender, body) {
        const senderPattern = /@amazon\.(com|ca|co\.uk|de|fr|es|it|in|com\.au|co\.jp)$/i;
        
        // Positive indicators
        const positivePatterns = {
            subject: [
                /your order.*shipped/i,
                /order confirmation/i,
                /your receipt.*amazon/i,
                /order.*has been delivered/i,
                /amazon\.com order/i,
                /shipment.*delivered/i
            ],
            body: [
                /order total:?\s*\$[\d,]+\.\d{2}/i,
                /shipment delivered/i,
                /order #[A-Z0-9-]{10,}/i,
                /billing address/i,
                /payment method.*ending in \d{4}/i
            ]
        };

        // Negative patterns (marketing/non-receipt)
        const negativePatterns = {
            subject: [
                /recommendations for you/i,
                /deals of the day/i,
                /lightning deals/i,
                /amazon prime video/i,
                /kindle unlimited/i,
                /subscribe.*save/i,
                /abandoned.*cart/i
            ],
            body: [
                /unsubscribe/i,
                /promotional/i,
                /this is not a bill/i,
                /marketing communication/i
            ]
        };

        return this.evaluatePatterns('amazon', senderPattern, positivePatterns, negativePatterns, subject, sender, body);
    }

    // Uber receipt patterns  
    checkUberReceipt(subject, sender, body) {
        const senderPattern = /@uber\.(com|info)$/i;
        
        const positivePatterns = {
            subject: [
                /your.*trip.*receipt/i,
                /ride with.*uber/i,
                /your uber eats receipt/i,
                /trip completed/i,
                /uber.*receipt/i
            ],
            body: [
                /trip fare:?\s*\$[\d,]+\.\d{2}/i,
                /total.*\$[\d,]+\.\d{2}/i,
                /driver.*rating/i,
                /pickup.*drop.?off/i,
                /payment method.*\*\d{4}/i,
                /order total.*\$[\d,]+\.\d{2}/i
            ]
        };

        const negativePatterns = {
            subject: [
                /invite.*friends/i,
                /promo.*code/i,
                /ride.*credits/i,
                /driver.*update/i
            ],
            body: [
                /promotional offer/i,
                /invite friends/i,
                /marketing/i
            ]
        };

        return this.evaluatePatterns('uber', senderPattern, positivePatterns, negativePatterns, subject, sender, body);
    }

    // DoorDash receipt patterns
    checkDoorDashReceipt(subject, sender, body) {
        const senderPattern = /@doordash\.com$/i;
        
        const positivePatterns = {
            subject: [
                /your.*order.*delivered/i,
                /order.*receipt/i,
                /doordash.*receipt/i,
                /order.*completed/i,
                /delivery.*complete/i
            ],
            body: [
                /order total:?\s*\$[\d,]+\.\d{2}/i,
                /subtotal.*\$[\d,]+\.\d{2}/i,
                /delivery fee.*\$[\d,]+\.\d{2}/i,
                /dasher.*tip/i,
                /payment method.*ending.*\d{4}/i,
                /order #\d{7,}/i
            ]
        };

        const negativePatterns = {
            subject: [
                /dashpass/i,
                /special.*offer/i,
                /free.*delivery/i,
                /recommended.*you/i
            ],
            body: [
                /promotional/i,
                /marketing/i,
                /unsubscribe/i
            ]
        };

        return this.evaluatePatterns('doordash', senderPattern, positivePatterns, negativePatterns, subject, sender, body);
    }

    // Generic receipt patterns for other vendors
    checkGenericReceipt(subject, sender, body) {
        // No specific sender pattern - relies heavily on content
        const senderPattern = null;
        
        const positivePatterns = {
            subject: [
                /receipt/i,
                /order.*confirmation/i,
                /payment.*confirmation/i,
                /purchase.*confirmation/i,
                /transaction.*complete/i,
                /invoice/i
            ],
            body: [
                /total.*paid:?\s*\$[\d,]+\.\d{2}/i,
                /amount.*charged:?\s*\$[\d,]+\.\d{2}/i,
                /transaction.*amount:?\s*\$[\d,]+\.\d{2}/i,
                /order.*total:?\s*\$[\d,]+\.\d{2}/i,
                /payment.*method.*\*\d{4}/i,
                /transaction.*id:?\s*[A-Za-z0-9]{8,}/i,
                /confirmation.*number:?\s*[A-Za-z0-9]{6,}/i
            ]
        };

        const negativePatterns = {
            subject: [
                /newsletter/i,
                /promotion/i,
                /deal/i,
                /sale/i,
                /marketing/i,
                /unsubscribe/i,
                /survey/i,
                /welcome/i,
                /account.*created/i,
                /password.*reset/i
            ],
            body: [
                /this.*not.*bill/i,
                /promotional.*purpose/i,
                /marketing.*communication/i,
                /unsubscribe/i,
                /survey/i,
                /account.*verification/i,
                /password.*reset/i
            ]
        };

        return this.evaluatePatterns('generic', senderPattern, positivePatterns, negativePatterns, subject, sender, body);
    }

    // Pattern evaluation engine
    evaluatePatterns(vendor, senderPattern, positivePatterns, negativePatterns, subject, sender, body) {
        let score = 0;
        let indicators = [];
        let matchType = 'content';

        // Check sender first (high weight)
        if (senderPattern && senderPattern.test(sender)) {
            score += 40;
            indicators.push(`trusted_sender_${vendor}`);
            matchType = 'sender_content';
        }

        // Check negative patterns first (immediate disqualification)
        const negativeSubjectMatch = negativePatterns.subject?.some(pattern => pattern.test(subject));
        const negativeBodyMatch = negativePatterns.body?.some(pattern => pattern.test(body));
        
        if (negativeSubjectMatch || negativeBodyMatch) {
            return { 
                isReceipt: false, 
                score: 0, 
                type: 'rejected',
                indicators: negativeSubjectMatch ? ['negative_subject'] : ['negative_body']
            };
        }

        // Check positive patterns
        let subjectMatches = 0;
        let bodyMatches = 0;

        // Subject patterns (medium weight)
        positivePatterns.subject?.forEach(pattern => {
            if (pattern.test(subject)) {
                subjectMatches++;
                score += 15;
                indicators.push('subject_match');
            }
        });

        // Body patterns (lower weight, but multiple matches increase confidence)  
        positivePatterns.body?.forEach(pattern => {
            if (pattern.test(body)) {
                bodyMatches++;
                score += 10;
                indicators.push('body_match');
            }
        });

        // Confidence thresholds (conservative)
        const isReceipt = score >= 50 || (senderPattern && senderPattern.test(sender) && score >= 25);

        return {
            isReceipt,
            score,
            type: matchType,
            indicators,
            subjectMatches,
            bodyMatches
        };
    }

    // Calculate overall confidence score
    calculateConfidence(filterResult, subject, sender, body) {
        if (!filterResult.isReceipt) return 0;

        let confidence = filterResult.score;
        
        // Boost confidence for specific vendor matches
        if (filterResult.vendor !== 'generic') {
            confidence += 10;
        }

        // Boost for multiple indicators
        if (filterResult.indicators.length >= 3) {
            confidence += 15;
        }

        // Cap at 100
        return Math.min(confidence, 100);
    }

    // Get filtering statistics
    getStats() {
        return {
            processedHashes: this.processedEmailHashes.size,
            maxStorage: this.maxHashStorage,
            storageUsage: (this.processedEmailHashes.size / this.maxHashStorage * 100).toFixed(1) + '%'
        };
    }

    // Clear deduplication cache
    clearCache() {
        this.processedEmailHashes.clear();
        return { success: true, message: 'Filter cache cleared' };
    }
}

// Integration with background.js
class SecureEmailFilterIntegration {
    constructor() {
        this.filter = new EmailReceiptFilter();
    }

    // Main function called by background.js email monitor
    async processEmailBatch(emails) {
        const results = [];
        
        for (const email of emails) {
            try {
                const filterResult = await this.filter.filterEmail(email);
                
                if (filterResult.isReceipt) {
                    results.push({
                        messageId: email.messageId,
                        vendor: filterResult.vendor,
                        confidence: filterResult.confidence,
                        matchType: filterResult.matchType,
                        processed: true
                    });
            
                    // Log for debugging (remove in production)
                    console.log(`📧 Receipt detected: ${filterResult.vendor} (${filterResult.confidence}% confidence)`);
                }
            } catch (error) {
                console.error('❌ Filter error for email:', email.messageId, error);
                // Continue processing other emails
            }
        }

        return {
            totalEmails: emails.length,
            receiptsDetected: results.length,
            results: results,
            filterStats: this.filter.getStats()
        };
    }

    // Test single email (for debugging)
    async testEmail(emailData) {
        return await this.filter.filterEmail(emailData);
    }
}

// Export for use in background.js
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { EmailReceiptFilter, SecureEmailFilterIntegration };
} else {
    // Browser environment
    window.EmailReceiptFilter = EmailReceiptFilter;
    window.SecureEmailFilterIntegration = SecureEmailFilterIntegration;
}
