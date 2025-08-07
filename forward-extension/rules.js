// Smart Filtering Rules Engine for Email Forwarding Extension

class ReceiptFilterEngine {
    constructor() {
        this.vendorPatterns = {
            amazon: {
                domains: ['amazon.com', 'amazon.ca', 'amazon.co.uk'],
                subjects: [
                    /your.*order.*has shipped/i,
                    /order confirmation/i,
                    /your.*amazon.*order/i,
                    /shipment.*delivered/i
                ],
                positiveContent: [
                    /order.*total/i,
                    /charged.*\$\d+/i,
                    /payment.*method/i,
                    /order.*#\s*\d/i
                ],
                negativeContent: [
                    /recommendation/i,
                    /deal of the day/i,
                    /subscribe.*save/i
                ]
            },
            uber: {
                domains: ['uber.com', 'ubereats.com'],
                subjects: [
                    /trip receipt/i,
                    /uber.*receipt/i,
                    /your.*ride.*\$\d+/i,
                    /order.*delivered/i
                ],
                positiveContent: [
                    /total.*\$\d+/i,
                    /payment.*charged/i,
                    /trip.*fare/i,
                    /order.*total/i
                ]
            },
            doordash: {
                domains: ['doordash.com'],
                subjects: [
                    /order.*delivered/i,
                    /receipt.*order/i,
                    /doordash.*order/i
                ],
                positiveContent: [
                    /total.*\$\d+/i,
                    /order.*#\d+/i,
                    /delivered.*to/i
                ]
            }
        };
        
        this.globalNegativePatterns = [
            /unsubscribe/i,
            /marketing/i,
            /newsletter/i,
            /promotion/i,
            /survey/i,
            /password.*reset/i,
            /account.*suspended/i,
            /verify.*email/i
        ];
    }

    analyzeEmail(email) {
        const sender = email.from || '';
        const subject = email.subject || '';
        const content = email.body || '';
        
        // Quick negative filter
        if (this.isDefinitelyNotReceipt(subject, content)) {
            return {
                isReceipt: false,
                confidence: 0,
                reason: 'Excluded by negative patterns',
                vendor: null
            };
        }
        
        // Check each vendor
        for (const [vendorName, patterns] of Object.entries(this.vendorPatterns)) {
            const analysis = this.checkVendorMatch(vendorName, patterns, sender, subject, content);
            if (analysis.isMatch) {
                return {
                    isReceipt: true,
                    confidence: analysis.confidence,
                    reason: `Matched ${vendorName} patterns`,
                    vendor: vendorName
                };
            }
        }
        
        // Generic receipt check
        const genericMatch = this.checkGenericReceipt(subject, content);
        return {
            isReceipt: genericMatch.isMatch,
            confidence: genericMatch.confidence,
            reason: genericMatch.reason,
            vendor: 'unknown'
        };
    }

    checkVendorMatch(vendorName, patterns, sender, subject, content) {
        let confidence = 0;
        
        // Domain match
        const domainMatch = patterns.domains?.some(domain => sender.includes(domain));
        if (domainMatch) confidence += 0.4;
        
        // Subject patterns
        const subjectMatch = patterns.subjects?.some(pattern => pattern.test(subject));
        if (subjectMatch) confidence += 0.3;
        
        // Positive content patterns
        const positiveMatch = patterns.positiveContent?.some(pattern => pattern.test(content));
        if (positiveMatch) confidence += 0.3;
        
        // Negative content check
        const negativeMatch = patterns.negativeContent?.some(pattern => pattern.test(content));
        if (negativeMatch) confidence -= 0.5;
        
        return {
            isMatch: confidence >= 0.6, // Conservative threshold
            confidence: Math.max(0, Math.min(1, confidence))
        };
    }

    checkGenericReceipt(subject, content) {
        let confidence = 0;
        
        // Generic receipt indicators
        const receiptKeywords = [
            /receipt/i,
            /invoice/i,
            /order.*confirmation/i,
            /payment.*received/i,
            /transaction.*complete/i,
            /purchase.*summary/i
        ];
        
        const keywordMatch = receiptKeywords.some(pattern => 
            pattern.test(subject) || pattern.test(content)
        );
        if (keywordMatch) confidence += 0.4;
        
        // Amount patterns
        const hasAmount = /\$\d+\.?\d*/.test(content);
        if (hasAmount) confidence += 0.3;
        
        // Order/transaction numbers
        const hasOrderNumber = /(order|transaction|invoice).*#?\s*\d+/i.test(content);
        if (hasOrderNumber) confidence += 0.2;
        
        return {
            isMatch: confidence >= 0.5,
            confidence: confidence,
            reason: confidence >= 0.5 ? 'Generic receipt patterns' : 'Insufficient receipt indicators'
        };
    }

    isDefinitelyNotReceipt(subject, content) {
        return this.globalNegativePatterns.some(pattern => 
            pattern.test(subject) || pattern.test(content)
        );
    }
}

// Deduplication system
class EmailDeduplicator {
    constructor() {
        this.forwardedIds = new Set();
        this.loadForwardedIds();
    }

    async loadForwardedIds() {
        try {
            const stored = await chrome.storage.local.get(['forwardedEmails']);
            if (stored.forwardedEmails) {
                this.forwardedIds = new Set(stored.forwardedEmails);
            }
        } catch (error) {
            console.error('Failed to load forwarded email IDs:', error);
        }
    }

    async saveForwardedIds() {
        try {
            await chrome.storage.local.set({
                forwardedEmails: Array.from(this.forwardedIds)
            });
        } catch (error) {
            console.error('Failed to save forwarded email IDs:', error);
        }
    }

    isAlreadyForwarded(emailId) {
        return this.forwardedIds.has(emailId);
    }

    markAsForwarded(emailId) {
        this.forwardedIds.add(emailId);
        this.saveForwardedIds();
        
        // Cleanup old entries (keep last 1000)
        if (this.forwardedIds.size > 1000) {
            const idsArray = Array.from(this.forwardedIds);
            this.forwardedIds = new Set(idsArray.slice(-1000));
            this.saveForwardedIds();
        }
    }
}

// Export for use in background.js
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ReceiptFilterEngine, EmailDeduplicator };
}
