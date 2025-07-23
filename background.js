// Secure Background Service for Email Monitoring
console.log('🔒 Expense Gadget Background Service Starting (Security-First)');

// Security Configuration
const SECURITY_CONFIG = {
    MAX_STORED_IDS: 100,           // Limit stored email IDs
    CLEANUP_INTERVAL_HOURS: 24,    // Clear old data every 24 hours
    CHECK_INTERVAL_MINUTES: 10,    // Check emails every 10 minutes (not too frequent)
    MAX_EMAILS_PER_CHECK: 100,     // Process max 100 emails per check (increased from 20)
    SESSION_TIMEOUT_MINUTES: 60    // Clear session data after 60 minutes
};

// Secure Email Monitoring Class
class SecureEmailMonitor {
    constructor() {
        this.isMonitoring = false;
        this.lastCheck = null;
        this.processedIds = new Set();
    }

    async init() {
        console.log('🔒 Initializing secure email monitoring...');
        
        // Set up periodic checks with security limits
        chrome.alarms.create('secureEmailCheck', { 
            periodInMinutes: SECURITY_CONFIG.CHECK_INTERVAL_MINUTES 
        });
        
        // Set up daily cleanup
        chrome.alarms.create('securityCleanup', { 
            periodInMinutes: SECURITY_CONFIG.CLEANUP_INTERVAL_HOURS * 60 
        });
        
        // Listen for alarms
        chrome.alarms.onAlarm.addListener((alarm) => {
            if (alarm.name === 'secureEmailCheck') {
                this.checkEmailsSecurely();
            } else if (alarm.name === 'securityCleanup') {
                this.performSecurityCleanup();
            }
        });

        console.log('✅ Secure monitoring initialized');
    }

    async checkEmailsSecurely() {
        if (this.isMonitoring) {
            console.log('⏭️ Email check already in progress, skipping');
            return;
        }

        this.isMonitoring = true;
        console.log('🔍 Starting secure email check...');

        try {
            // Check if user is authenticated (don't store tokens locally)
            const authStatus = await this.checkAuthStatus();
            if (!authStatus.authenticated) {
                console.log('🔐 User not authenticated, skipping check');
                return;
            }

            // Get last check time securely
            const lastCheckTime = await this.getLastCheckTime();
            
            // Call server-side email check (never process emails in extension)
            const checkResult = await this.requestServerEmailCheck(lastCheckTime);
            
            if (checkResult.success) {
                console.log(`📧 Processed ${checkResult.processedCount} new receipts`);
                await this.updateLastCheckTime();
                
                // Notify user if receipts were processed (optional)
                if (checkResult.processedCount > 0) {
                    this.showSecureNotification(
                        `📧 ${checkResult.processedCount} receipts automatically sent to Airbase`
                    );
                }
            }

        } catch (error) {
            console.error('❌ Secure email check failed:', error);
            // Don't expose error details to avoid information leakage
        } finally {
            this.isMonitoring = false;
        }
    }

    async checkAuthStatus() {
        try {
            // Check server-side auth status (don't store tokens in extension)
            const response = await fetch('https://bootleg-expensify-34h3.onrender.com/auth/status', {
                method: 'GET',
                credentials: 'include', // Use HTTP-only cookies for auth
                headers: {
                    'X-Extension-Version': chrome.runtime.getManifest().version
                }
            });

            if (response.ok) {
                const status = await response.json();
                return { authenticated: status.authenticated };
            }
            
            return { authenticated: false };
        } catch (error) {
            console.error('Auth status check failed:', error);
            return { authenticated: false };
        }
    }

    async requestServerEmailCheck(since, isCatchup = false, maxEmails = null) {
        try {
            const response = await fetch('https://bootleg-expensify-34h3.onrender.com/monitor-emails', {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Extension-Version': chrome.runtime.getManifest().version,
                    'X-Security-Check': 'background-monitor'
                },
                body: JSON.stringify({
                    since: since,
                    maxEmails: maxEmails || SECURITY_CONFIG.MAX_EMAILS_PER_CHECK,
                    securityMode: true,
                    isCatchup: isCatchup
                })
            });

            if (response.ok) {
                return await response.json();
            } else if (response.status === 429) {
                // Handle rate limiting specifically
                const errorData = await response.json();
                return { 
                    success: false, 
                    processedCount: 0,
                    error: errorData.error,
                    waitTime: errorData.waitTime
                };
            } else {
                throw new Error(`Server check failed: ${response.status}`);
            }
        } catch (error) {
            console.error('Server email check failed:', error);
            return { success: false, processedCount: 0 };
        }
    }

    async getLastCheckTime() {
        try {
            const result = await chrome.storage.local.get(['lastEmailCheck']);
            return result.lastEmailCheck || Date.now() - (24 * 60 * 60 * 1000); // Default: 24 hours ago
        } catch (error) {
            console.error('Failed to get last check time:', error);
            return Date.now() - (24 * 60 * 60 * 1000);
        }
    }

    async updateLastCheckTime() {
        try {
            await chrome.storage.local.set({
                lastEmailCheck: Date.now()
            });
        } catch (error) {
            console.error('Failed to update last check time:', error);
        }
    }

    async performSecurityCleanup() {
        console.log('🧹 Performing security cleanup...');
        
        try {
            // Clear old processed email IDs
            await chrome.storage.local.remove(['processedEmailIds']);
            
            // Clear any cached data older than session timeout
            const sessionTimeout = Date.now() - (SECURITY_CONFIG.SESSION_TIMEOUT_MINUTES * 60 * 1000);
            const result = await chrome.storage.local.get(null);
            
            for (const [key, value] of Object.entries(result)) {
                if (value && value.timestamp && value.timestamp < sessionTimeout) {
                    await chrome.storage.local.remove([key]);
                    console.log(`🗑️ Cleaned expired data: ${key}`);
                }
            }
            
            console.log('✅ Security cleanup complete');
        } catch (error) {
            console.error('❌ Security cleanup failed:', error);
        }
    }

    showSecureNotification(message) {
        // Only show notification if user has extension open
        // Don't create persistent notifications that could leak info
        console.log('📱 Notification:', message);
        
        // Store notification for popup to display (expire after 5 minutes)
        chrome.storage.local.set({
            latestNotification: {
                message: message,
                timestamp: Date.now(),
                expires: Date.now() + (5 * 60 * 1000)
            }
        });
    }

    async startMonitoring() {
        console.log('▶️ Starting secure email monitoring...');
        await this.init();
        
        // Perform initial check
        await this.checkEmailsSecurely();
        
        return { success: true, message: 'Secure monitoring started' };
    }

    async stopMonitoring() {
        console.log('⏹️ Stopping email monitoring...');
        
        // Store when monitoring stopped for catchup functionality
        await chrome.storage.local.set({
            lastMonitoringStop: Date.now()
        });
        
        // Clear alarms
        chrome.alarms.clear('secureEmailCheck');
        chrome.alarms.clear('securityCleanup');
        
        // Perform immediate cleanup
        await this.performSecurityCleanup();
        
        return { success: true, message: 'Monitoring stopped and cleaned up' };
    }

    async getMonitoringStatus() {
        const alarms = await chrome.alarms.getAll();
        const isActive = alarms.some(alarm => alarm.name === 'secureEmailCheck');
        const lastCheck = await this.getLastCheckTime();
        const lastStop = await this.getLastStopTime();
        
        return {
            active: isActive,
            lastCheck: new Date(lastCheck).toLocaleString(),
            lastStop: lastStop ? new Date(lastStop).toLocaleString() : null,
            nextCheck: isActive ? 'In ' + SECURITY_CONFIG.CHECK_INTERVAL_MINUTES + ' minutes' : 'Not scheduled'
        };
    }

    async getLastStopTime() {
        try {
            const result = await chrome.storage.local.get(['lastMonitoringStop']);
            return result.lastMonitoringStop || null;
        } catch (error) {
            console.error('Failed to get last stop time:', error);
            return null;
        }
    }

    async catchupEmails(hoursBack = null, maxEmails = 100) {
        console.log('🔄 Starting email catchup...');
        
        try {
            // Check if user is authenticated
            const authStatus = await this.checkAuthStatus();
            if (!authStatus.authenticated) {
                console.log('🔐 User not authenticated, cannot catchup');
                return { success: false, message: 'Not authenticated' };
            }

            let catchupFrom;
            if (hoursBack) {
                // Use specified hours back
                catchupFrom = Date.now() - (hoursBack * 60 * 60 * 1000);
            } else {
                // Use last monitoring stop time, or default to 24 hours ago
                const lastStop = await this.getLastStopTime();
                catchupFrom = lastStop || (Date.now() - (24 * 60 * 60 * 1000));
            }
            
            console.log(`📧 Catching up emails since: ${new Date(catchupFrom).toLocaleString()}`);
            
            // Call server-side email check with catchup flag and higher limit
            const checkResult = await this.requestServerEmailCheck(catchupFrom, true, maxEmails);
            
            if (checkResult.success) {
                console.log(`📧 Catchup processed ${checkResult.processedCount} receipts`);
                
                // Show notification
                if (checkResult.processedCount > 0) {
                    this.showSecureNotification(
                        `🔄 Catchup complete: ${checkResult.processedCount} receipts sent to Airbase`
                    );
                }
                
                return { 
                    success: true, 
                    processedCount: checkResult.processedCount,
                    message: `Processed ${checkResult.processedCount} receipts`
                };
            } else {
                return { 
                    success: false, 
                    message: checkResult.error || 'Server check failed',
                    waitTime: checkResult.waitTime
                };
            }

        } catch (error) {
            console.error('❌ Email catchup failed:', error);
            return { success: false, message: error.message };
        }
    }
}

// Initialize secure monitor
const secureMonitor = new SecureEmailMonitor();

// Handle messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log('📨 Background received message:', request.action);
    
    try {
        if (request.action === 'startMonitoring') {
            secureMonitor.startMonitoring()
                .then(sendResponse)
                .catch(error => {
                    console.error('❌ Start monitoring error:', error);
                    sendResponse({ success: false, message: error.message });
                });
            return true; // Async response
        } else if (request.action === 'stopMonitoring') {
            secureMonitor.stopMonitoring()
                .then(sendResponse)
                .catch(error => {
                    console.error('❌ Stop monitoring error:', error);
                    sendResponse({ success: false, message: error.message });
                });
            return true;
        } else if (request.action === 'getMonitoringStatus') {
            secureMonitor.getMonitoringStatus()
                .then(sendResponse)
                .catch(error => {
                    console.error('❌ Get status error:', error);
                    sendResponse({ active: false, error: error.message });
                });
            return true;
        } else if (request.action === 'catchupEmails') {
            secureMonitor.catchupEmails(request.hoursBack, request.maxEmails)
                .then(sendResponse)
                .catch(error => {
                    console.error('❌ Catchup error:', error);
                    sendResponse({ success: false, message: error.message });
                });
            return true;
        } else {
            console.log('❓ Unknown action:', request.action);
            sendResponse({ success: false, message: 'Unknown action' });
        }
    } catch (error) {
        console.error('❌ Message handler error:', error);
        sendResponse({ success: false, message: error.message });
    }
});

// Handle extension startup
chrome.runtime.onStartup.addListener(() => {
    console.log('🔄 Extension startup - checking monitoring status...');
    // Don't auto-start monitoring for security - require user action
});

console.log('✅ Secure background service ready');
