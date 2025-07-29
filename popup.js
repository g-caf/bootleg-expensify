// Simple popup.js loading
console.log('=== POPUP.JS STARTING ===');

// Simple DOM ready approach
document.addEventListener('DOMContentLoaded', function () {
    console.log('DOM ready, creating ExpenseGadget...');

    try {
        window.expenseGadget = new ExpenseGadget();
        console.log('ExpenseGadget created');

        window.expenseGadget.init();
        console.log('ExpenseGadget initialized');
    } catch (error) {
        console.error('ExpenseGadget error:', error);
    }
});

// Gmail API client for browser extension
class GmailClient {
    constructor() {
        this.isAuthenticated = false;
        this.accessToken = null;
    }

    async authenticate() {
        try {
            // Use the existing server-side Google OAuth flow
            // This will open the same auth flow that's used for Google Drive
            const authUrl = 'https://your-app-name.onrender.com/auth/google';
            window.open(authUrl, '_blank', 'width=500,height=600');

            // Check for authentication status periodically
            return new Promise((resolve) => {
                const checkInterval = setInterval(async () => {
                    const token = await this.getTokenFromServer();
                    if (token) {
                        this.accessToken = token;
                        this.isAuthenticated = true;
                        await chrome.storage.local.set({ gmailAccessToken: token });
                        clearInterval(checkInterval);
                        resolve(true);
                    }
                }, 2000);

                // Stop checking after 2 minutes
                setTimeout(() => {
                    clearInterval(checkInterval);
                    resolve(false);
                }, 120000);
            });
        } catch (error) {
            console.error('Gmail authentication error:', error);
            return false;
        }
    }

    async getTokenFromServer() {
        try {
            console.log('🔐 DEBUG: Fetching token from server...');
            const response = await fetch('https://bootleg-expensify-34h3.onrender.com/auth/token', {
                credentials: 'include'
            });
            console.log('🔐 DEBUG: Server response status:', response.status);
            if (response.ok) {
                const data = await response.json();
                console.log('🔐 DEBUG: Server response data keys:', Object.keys(data));
                console.log('🔐 DEBUG: Has access_token:', !!data.access_token);
                return data.access_token;
            } else {
                console.log('🔐 DEBUG: Server response not ok:', response.status, response.statusText);
                const errorText = await response.text();
                console.log('🔐 DEBUG: Error response body:', errorText);
            }
        } catch (error) {
            console.error('🔐 DEBUG: Error fetching token from server:', error);
        }
        return null;
    }

    async checkStoredAuth() {
        try {
            console.log('🔐 DEBUG: GmailClient checkStoredAuth started');

            // ONLY trust server token - don't use stored tokens
            // This prevents client/server auth state mismatch
            const serverToken = await this.getTokenFromServer();
            console.log('🔐 DEBUG: GmailClient serverToken result:', serverToken ? 'token received' : 'no token');
            console.log('🔐 DEBUG: Server token preview:', serverToken ? serverToken.substring(0, 20) + '...' : 'null');

            if (serverToken) {
                this.accessToken = serverToken;
                this.isAuthenticated = true;
                await chrome.storage.local.set({ gmailAccessToken: serverToken });
                console.log('🔐 DEBUG: GmailClient authenticated via server token');
                return true;
            } else {
                // Server says not authenticated - clear any stale local data
                console.log('🔐 DEBUG: GmailClient server not authenticated, clearing local storage');
                await chrome.storage.local.remove(['gmailAccessToken']);
                this.accessToken = null;
                this.isAuthenticated = false;
                return false;
            }
        } catch (error) {
            console.error('🔐 DEBUG: Error checking stored auth:', error);
            // Clear stale data on error
            await chrome.storage.local.remove(['gmailAccessToken']);
            this.accessToken = null;
            this.isAuthenticated = false;
            return false;
        }
    }

    async verifyToken() {
        try {
            const response = await fetch(`https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=${this.accessToken}`);
            return response.ok;
        } catch (error) {
            return false;
        }
    }

    async searchEmails(query, maxResults = 20) {
        if (!this.isAuthenticated || !this.accessToken) {
            throw new Error('Not authenticated with Gmail');
        }

        try {
            const searchUrl = `https://www.googleapis.com/gmail/v1/users/me/messages?` +
                `q=${encodeURIComponent(query)}&` +
                `maxResults=${maxResults}`;

            const response = await fetch(searchUrl, {
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                    'Content-Type': 'application/json'
                }
            });

            if (response.status === 401) {
                // Token expired, try to refresh from server or re-authenticate
                console.log('Token expired, attempting to refresh...');
                const newToken = await this.getTokenFromServer();
                if (newToken) {
                    this.accessToken = newToken;
                    await chrome.storage.local.set({ gmailAccessToken: newToken });
                    
                    // Retry the request with new token
                    const retryResponse = await fetch(searchUrl, {
                        headers: {
                            'Authorization': `Bearer ${this.accessToken}`,
                            'Content-Type': 'application/json'
                        }
                    });
                    
                    if (!retryResponse.ok) {
                        throw new Error(`Gmail API error: ${retryResponse.status}`);
                    }
                    
                    const data = await retryResponse.json();
                    if (!data.messages || data.messages.length === 0) {
                        return [];
                    }
                    
                    const emailPromises = data.messages.map(message => this.getMessageDetails(message.id));
                    const emails = await Promise.all(emailPromises);
                    return emails.filter(email => email !== null);
                } else {
                    // No server token available, reset to unauthenticated state
                    console.log('Authentication expired, updating UI to require reconnection');
                    this.isAuthenticated = false;
                    this.accessToken = null;
                    await chrome.storage.local.remove(['gmailAccessToken']);
                    
                    // Update UI to show "Connect to Google" state
                    const expenseGadget = window.expenseGadget;
                    if (expenseGadget) {
                        expenseGadget.updateGmailAuthStatus(false);
                    }
                    
                    // Return empty results - user will see the UI changed to require auth
                    return [];
                }
            }

            if (!response.ok) {
                throw new Error(`Gmail API error: ${response.status}`);
            }

            const data = await response.json();

            if (!data.messages || data.messages.length === 0) {
                return [];
            }

            // Get message details for each result
            const emailPromises = data.messages.map(message => this.getMessageDetails(message.id));
            const emails = await Promise.all(emailPromises);

            return emails.filter(email => email !== null);
        } catch (error) {
            console.error('Gmail search error:', error);
            throw error;
        }
    }

    async getMessageDetails(messageId) {
        try {
            const messageUrl = `https://www.googleapis.com/gmail/v1/users/me/messages/${messageId}?` +
                `format=metadata&` +
                `metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`;

            const response = await fetch(messageUrl, {
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                    'Content-Type': 'application/json'
                }
            });

            if (response.status === 401) {
                // Token expired, try to refresh from server
                const newToken = await this.getTokenFromServer();
                if (newToken) {
                    this.accessToken = newToken;
                    await chrome.storage.local.set({ gmailAccessToken: newToken });
                    
                    // Retry the request with new token
                    const retryResponse = await fetch(messageUrl, {
                        headers: {
                            'Authorization': `Bearer ${this.accessToken}`,
                            'Content-Type': 'application/json'
                        }
                    });
                    
                    if (!retryResponse.ok) {
                        console.error(`Error getting message ${messageId} after retry: ${retryResponse.status}`);
                        return null;
                    }
                    
                    const message = await retryResponse.json();
                    const headers = message.payload.headers || [];
                    
                    const subject = headers.find(h => h.name === 'Subject')?.value || 'No Subject';
                    const from = headers.find(h => h.name === 'From')?.value || 'Unknown Sender';
                    const date = headers.find(h => h.name === 'Date')?.value || 'No Date';
                    
                    return {
                        id: messageId,
                        subject: subject,
                        from: from,
                        date: date
                    };
                } else {
                    // No valid token available
                    this.isAuthenticated = false;
                    this.accessToken = null;
                    await chrome.storage.local.remove(['gmailAccessToken']);
                    return null;
                }
            }

            if (!response.ok) {
                console.error(`Error getting message ${messageId}: ${response.status}`);
                return null;
            }

            const message = await response.json();
            const headers = message.payload.headers || [];

            const subject = headers.find(h => h.name === 'Subject')?.value || 'No Subject';
            const from = headers.find(h => h.name === 'From')?.value || 'Unknown Sender';
            const date = headers.find(h => h.name === 'Date')?.value || 'No Date';

            return {
                id: messageId,
                subject: subject,
                from: from,
                date: date
            };
        } catch (error) {
            console.error(`Error getting message details for ${messageId}:`, error);
            return null;
        }
    }

    async getFullMessageContent(messageId) {
        try {
            console.log('Getting full message content for:', messageId);
            const messageUrl = `https://www.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`;

            const response = await fetch(messageUrl, {
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                console.error(`Error getting full message ${messageId}: ${response.status}`);
                return null;
            }

            const message = await response.json();
            const headers = message.payload.headers || [];

            const subject = headers.find(h => h.name === 'Subject')?.value || 'No Subject';
            const from = headers.find(h => h.name === 'From')?.value || 'Unknown Sender';
            const date = headers.find(h => h.name === 'Date')?.value || 'No Date';

            // Extract email body (HTML or plain text)
            let body = '';
            const payload = message.payload;

            if (payload.body && payload.body.data) {
                // Single part message
                body = this.decodeBase64Url(payload.body.data);
            } else if (payload.parts) {
                // Multi-part message - find HTML or text part
                for (const part of payload.parts) {
                    if (part.mimeType === 'text/html' && part.body && part.body.data) {
                        body = this.decodeBase64Url(part.body.data);
                        break;
                    } else if (part.mimeType === 'text/plain' && part.body && part.body.data && !body) {
                        // Use plain text as fallback
                        const plainText = this.decodeBase64Url(part.body.data);
                        body = plainText.replace(/\n/g, '<br>');
                    } else if (part.parts) {
                        // Nested parts (like multipart/alternative)
                        for (const nestedPart of part.parts) {
                            if (nestedPart.mimeType === 'text/html' && nestedPart.body && nestedPart.body.data) {
                                body = this.decodeBase64Url(nestedPart.body.data);
                                break;
                            } else if (nestedPart.mimeType === 'text/plain' && nestedPart.body && nestedPart.body.data && !body) {
                                const plainText = this.decodeBase64Url(nestedPart.body.data);
                                body = plainText.replace(/\n/g, '<br>');
                            }
                        }
                        if (body) break;
                    }
                }
            }

            console.log('Extracted body length:', body.length);
            console.log('Body preview:', body.substring(0, 200));

            return {
                id: messageId,
                subject: subject,
                from: from,
                date: date,
                body: body || 'No content available'
            };
        } catch (error) {
            console.error(`Error getting full message content for ${messageId}:`, error);
            return null;
        }
    }

    decodeBase64Url(data) {
        try {
            // Gmail uses base64url encoding, convert to regular base64
            const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
            // Add padding if needed
            const padding = '='.repeat((4 - base64.length % 4) % 4);
            return atob(base64 + padding);
        } catch (error) {
            console.error('Error decoding base64:', error);
            return '';
        }
    }

    async logout() {
        this.isAuthenticated = false;
        this.accessToken = null;
        await chrome.storage.local.remove(['gmailAccessToken']);
    }
}

class ExpenseGadget {
    constructor() {
        console.log('=== EXPENSEGADGET CONSTRUCTOR ===');
        this.currentQueue = [];
        this.isProcessing = false;
        this.currentTab = 'scan';
        this.searchDebounceTimer = null;
        this.gmailClient = null;
        // Don't auto-init, will be called externally
    }

    async init() {
        console.log('=== INITIALIZING EXPENSE GADGET ===');
        this.setupEventListeners();
        // Initialize Gmail client after everything else is set up
        try {
            console.log('Creating Gmail client...');
            this.gmailClient = new GmailClient();
            console.log('Gmail client created successfully');
        } catch (error) {
            console.error('Failed to initialize Gmail client:', error);
        }
        console.log('Checking Gmail authentication...');
        await this.checkGmailAuth();
        console.log('=== EXPENSE GADGET INITIALIZED ===');
    }

    setupEventListeners() {
        const closeBtn = document.getElementById('closeBtn');
        const searchInput = document.getElementById('searchInput');
        const dayRangeMin = document.getElementById('dayRangeMin'); // "from" - newer date (0 = today)
        const dayRangeMax = document.getElementById('dayRangeMax'); // "to" - older date (7 = 7 days ago)
        const dayDisplay = document.getElementById('dayDisplay');
        const rangeProgress = document.getElementById('rangeProgress');

        // Close button
        closeBtn.addEventListener('click', () => {
            window.close();
        });

        // Reset sliders to default values on popup load
        this.resetDateRangeSliders();

        // Dual range slider with auto-scan
        let scanTimeout = null;
        
        // Helper function to get business period days
        const getBusinessPeriodDays = () => {
            const today = new Date();
            const currentMonth = today.getMonth();
            const currentYear = today.getFullYear();
            
            const monthStart = new Date(currentYear, currentMonth, 1);
            const mtd = Math.floor((today - monthStart) / (1000 * 60 * 60 * 24));
            
            const lastMonthStart = new Date(currentYear, currentMonth - 1, 1);
            const lastMonth = Math.floor((today - lastMonthStart) / (1000 * 60 * 60 * 24));
            
            const quarterStartMonth = Math.floor(currentMonth / 3) * 3;
            const quarterStart = new Date(currentYear, quarterStartMonth, 1);
            const qtd = Math.floor((today - quarterStart) / (1000 * 60 * 60 * 24));
            
            // Last quarter: first day of previous quarter
            const lastQuarterStartMonth = quarterStartMonth - 3;
            const lastQuarterStart = lastQuarterStartMonth < 0 
                ? new Date(currentYear - 1, lastQuarterStartMonth + 12, 1)
                : new Date(currentYear, lastQuarterStartMonth, 1);
            const lastQuarter = Math.floor((today - lastQuarterStart) / (1000 * 60 * 60 * 24));
            
            return { mtdDays: mtd, lastMonthDays: lastMonth, qtdDays: qtd, lastQuarterDays: lastQuarter };
        };
        
        // Helper function to convert days to business period names
        const daysToBusinessPeriod = (days, sliderPosition = null) => {
            const { mtdDays, lastMonthDays, qtdDays, lastQuarterDays } = getBusinessPeriodDays();
            
            console.log(`Global daysToBusinessPeriod: input=${days}, sliderPos=${sliderPosition}, mtd=${mtdDays}, lastMonth=${lastMonthDays}, qtd=${qtdDays}, lastQuarter=${lastQuarterDays}`);
            
            if (days === 0) return 'today';
            
            // When MTD and QTD are the same (first month of quarter), use slider position to determine intent
            if (mtdDays === qtdDays && sliderPosition !== null) {
                if (Math.abs(sliderPosition - 75) <= 5) { // Within 5% of QTD position
                    return 'quarter-to-date';
                } else if (Math.abs(sliderPosition - 25) <= 5) { // Within 5% of MTD position
                    return 'month-to-date';
                }
            }
            
            // Use exact matching with consistent tolerance
            const tolerance = 1;
            if (Math.abs(days - mtdDays) <= tolerance) {
                return 'month-to-date';
            }
            if (Math.abs(days - lastMonthDays) <= tolerance) {
                return 'last month'; 
            }
            if (Math.abs(days - qtdDays) <= tolerance) {
                return 'quarter-to-date';
            }
            if (Math.abs(days - lastQuarterDays) <= tolerance) {
                return 'last quarter';
            }
            
            return `${days} day${days > 1 ? 's' : ''} ago`;
        };
        
        // Mapping functions between slider position (0-100) and actual days
        const sliderPositionToDays = (position) => {
            const { mtdDays, lastMonthDays, qtdDays, lastQuarterDays } = getBusinessPeriodDays();
            
            // Define key mapping points: [sliderPosition, actualDays]
            const mappingPoints = [
                [0, 0],                  // 0% = today
                [25, mtdDays],           // 25% = month-to-date  
                [50, lastMonthDays],     // 50% = last month
                [75, qtdDays],           // 75% = quarter-to-date
                [100, lastQuarterDays]   // 100% = last quarter
            ];
            
            // Find the two points to interpolate between
            for (let i = 0; i < mappingPoints.length - 1; i++) {
                const [pos1, days1] = mappingPoints[i];
                const [pos2, days2] = mappingPoints[i + 1];
                
                if (position >= pos1 && position <= pos2) {
                    // Linear interpolation between the two points
                    const ratio = (position - pos1) / (pos2 - pos1);
                    return Math.round(days1 + ratio * (days2 - days1));
                }
            }
            
            // Fallback for values outside range
            return position <= 0 ? 0 : lastQuarterDays;
        };
        
        const daysToSliderPosition = (days) => {
            const { mtdDays, lastMonthDays, qtdDays, lastQuarterDays } = getBusinessPeriodDays();
            
            // Reverse mapping from days to slider position
            const mappingPoints = [
                [0, 0],                  // today = 0%
                [mtdDays, 25],           // MTD = 25%
                [lastMonthDays, 50],     // last month = 50%
                [qtdDays, 75],           // QTD = 75%
                [lastQuarterDays, 100]   // last quarter = 100%
            ];
            
            for (let i = 0; i < mappingPoints.length - 1; i++) {
                const [days1, pos1] = mappingPoints[i];
                const [days2, pos2] = mappingPoints[i + 1];
                
                if (days >= days1 && days <= days2) {
                    const ratio = (days - days1) / (days2 - days1);
                    return Math.round(pos1 + ratio * (pos2 - pos1));
                }
            }
            
            return days <= 0 ? 0 : 100;
        };
        
        const snapToCommonValues = (position) => {
            // Snap to business period positions (0%, 25%, 50%, 75%, 100%)
            const snapPoints = [0, 25, 50, 75, 100];
            const snapThreshold = 4; // Snap within 4% of target
            
            for (const snapPoint of snapPoints) {
                if (Math.abs(position - snapPoint) <= snapThreshold) {
                    return snapPoint;
                }
            }
            return position;
        };

        const updateRangeDisplay = () => {
            // Guard against null elements (when in autoscan mode)
            if (!dayRangeMin || !dayRangeMax || !dayDisplay || !rangeProgress) {
                return;
            }
            
            let minPos = parseInt(dayRangeMin.value); // Slider position (0-100)
            let maxPos = parseInt(dayRangeMax.value); // Slider position (0-100)

            // Apply snapping to common positions
            minPos = snapToCommonValues(minPos);
            maxPos = snapToCommonValues(maxPos);

            // Update the input values to reflect snapping
            dayRangeMin.value = minPos;
            dayRangeMax.value = maxPos;

            // Ensure min <= max
            if (minPos > maxPos) {
                if (dayRangeMin === document.activeElement) {
                    dayRangeMax.value = minPos;
                    maxPos = minPos;
                } else {
                    dayRangeMin.value = maxPos;
                    minPos = maxPos;
                }
            }

            const finalMinPos = Math.min(minPos, maxPos);
            const finalMaxPos = Math.max(minPos, maxPos);

            // Convert slider positions to actual day values
            const finalMinDays = sliderPositionToDays(finalMinPos);
            const finalMaxDays = sliderPositionToDays(finalMaxPos);

            // Update display text with business period names
            const fromText = daysToBusinessPeriod(finalMinDays, finalMinPos);
            const toText = daysToBusinessPeriod(finalMaxDays, finalMaxPos);
            dayDisplay.textContent = `${fromText} to ${toText}`;

            // Update progress bar (use slider positions for visual consistency)
            const progressLeft = finalMinPos;
            const progressWidth = finalMaxPos - finalMinPos;
            rangeProgress.style.left = `${progressLeft}%`;
            rangeProgress.style.width = `${progressWidth}%`;

            // Auto-scan disabled - user must click "Start Scanning" button
            // This prevents auto-scanning when adjusting the slider
        };

        // Only add event listeners if elements exist (they don't exist in autoscan mode)
        if (dayRangeMin && dayRangeMax) {
            dayRangeMin.addEventListener('input', updateRangeDisplay);
            dayRangeMax.addEventListener('input', updateRangeDisplay);
        }

        // Gmail scan button
        const gmailScanBtn = document.getElementById('gmailScanBtn');
        console.log('Setting up click handler for gmailScanBtn:', gmailScanBtn);
        
        if (gmailScanBtn) {
            gmailScanBtn.addEventListener('click', async () => {
                console.log('=== GMAIL SCAN BUTTON CLICKED ===');
                console.log('Button text:', gmailScanBtn.textContent);
                console.log('Button text length:', gmailScanBtn.textContent.length);
                console.log('Button text trimmed:', gmailScanBtn.textContent.trim());
                
                if (gmailScanBtn.textContent === 'Connect to Google') {
                    console.log('Connecting to Google...');
                    // Handle connection
                    await this.connectGoogleDrive();
                } else if (gmailScanBtn.textContent === 'Monitoring') {
                    console.log('Cycling through monitoring modes...');
                    // Cycle between monitoring and autoscan
                    const monitoringContainer = document.getElementById('monitoringContainer');
                    const autoscanContainer = document.getElementById('autoscanContainer');
                    
                    if (monitoringContainer && monitoringContainer.style.display === 'block') {
                        // Switch to autoscan
                        gmailScanBtn.textContent = 'Autoscan';
                        this.showAutoscanInterface();
                    } else if (autoscanContainer && autoscanContainer.style.display === 'block') {
                        // Back to monitoring
                        gmailScanBtn.textContent = 'Monitoring';
                        this.showMonitoringInterface();
                    } else {
                        // Default to monitoring
                        this.showMonitoringInterface();
                    }
                } else if (gmailScanBtn.textContent === 'Autoscan') {
                    console.log('Cycling back to monitoring...');
                    gmailScanBtn.textContent = 'Monitoring';
                    this.showMonitoringInterface();
                } else {
                    console.log('Unknown button state:', gmailScanBtn.textContent);
                }
            });
            console.log('Click handler attached successfully');
        } else {
            console.error('gmailScanBtn element not found!');
        }

        // Search input
        searchInput.addEventListener('input', (e) => {
            this.handleSearchInput(e.target.value);
        });

        // Hide slider when focusing on search input
        searchInput.addEventListener('focus', () => {
            this.hideDateRangeSlider();
        });

        // Event delegation for action buttons (dynamically created)
        document.addEventListener('click', (e) => {
            if (e.target.classList.contains('convert-btn')) {
                const emailId = e.target.getAttribute('data-email-id');
                if (emailId) {
                    this.forwardEmailToAirbase(emailId, e.target);
                }
            }
        });
    }





    async processFiles(files) {
        console.log('=== PROCESS FILES CALLED ===');
        console.log('Processing', files.length, 'files');

        // Filter for PDF files only
        const pdfFiles = Array.from(files).filter(file => file.type === 'application/pdf');

        if (pdfFiles.length === 0) {
            this.showStatus('❌ No PDF files found. Please select PDF files only.', 'error');
            return;
        }

        if (pdfFiles.length !== files.length) {
            this.showStatus(`⚠️ Only processing ${pdfFiles.length} PDF files (${files.length - pdfFiles.length} non-PDF files ignored)`, 'warning');
        }

        // Don't start new processing if already in progress
        if (this.isProcessing) {
            this.showStatus('⚠️ Already processing files. Please wait for current batch to complete.', 'warning');
            return;
        }

        this.currentQueue = pdfFiles;
        await this.processQueue();
    }

    async processQueue() {
        if (this.currentQueue.length === 0) return;

        this.isProcessing = true;
        const totalFiles = this.currentQueue.length;
        let successCount = 0;
        let errorCount = 0;

        // Show progress section
        this.showProgressSection(true);
        this.hideStatus();

        for (let i = 0; i < totalFiles; i++) {
            const file = this.currentQueue[i];
            const currentIndex = i + 1;

            // Update progress
            this.updateProgress(currentIndex, totalFiles, file.name);

            try {
                console.log(`Processing file ${currentIndex}/${totalFiles}: ${file.name}`);
                const success = await this.processReceipt(file);
                if (success) {
                    successCount++;
                } else {
                    errorCount++;
                }
            } catch (error) {
                console.error(`Error processing file ${file.name}:`, error);
                errorCount++;
            }

            // Small delay between files to prevent overwhelming the server
            if (i < totalFiles - 1) {
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }

        // Hide progress section and show final results
        this.showProgressSection(false);
        this.showFinalResults(successCount, errorCount, totalFiles);

        // Reset state
        this.currentQueue = [];
        this.isProcessing = false;
    }

    updateProgress(current, total, fileName) {
        const progressText = document.getElementById('progressText');
        const progressBar = document.getElementById('progressBar');
        const progressCount = document.getElementById('progressCount');

        const percentage = ((current - 1) / total) * 100;

        progressText.textContent = `Processing: ${fileName}`;
        progressBar.style.width = `${percentage}%`;
        progressCount.textContent = `${current - 1} of ${total} completed`;
    }

    showProgressSection(show) {
        const progressSection = document.getElementById('progressSection');
        progressSection.style.display = show ? 'block' : 'none';
    }

    hideStatus() {
        const status = document.getElementById('status');
        status.style.display = 'none';
    }

    showFinalResults(successCount, errorCount, totalFiles) {
        let message;
        let type;

        if (errorCount === 0) {
            message = `✅ All ${totalFiles} receipts processed successfully!`;
            type = 'success';
        } else if (successCount === 0) {
            message = `❌ All ${totalFiles} receipts failed to process. Check server connection.`;
            type = 'error';
        } else {
            message = `⚠️ Processed ${successCount} receipts successfully, ${errorCount} failed.`;
            type = 'warning';
        }

        this.showStatus(message, type);
    }

    async processReceipt(file) {
        console.log('=== START processReceipt ===');
        console.log('File name:', file.name);
        console.log('File size:', file.size);

        try {
            // Create FormData
            const formData = new FormData();
            formData.append('pdf', file);

            // Make request with timeout
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout per file

            const response = await fetch('https://bootleg-expensify-34h3.onrender.com/parse-receipt', {
                method: 'POST',
                body: formData,
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                console.error(`Server error for ${file.name}: ${response.status} ${response.statusText}`);
                // Fallback to simple renaming
                this.downloadFileWithFallbackName(file);
                return false;
            }

            const result = await response.json();
            console.log(`Server response for ${file.name}:`, result);

            // Use the filename from the server or create a fallback
            const newFileName = result.filename || this.createFallbackFileName(file.name);
            this.downloadFile(file, newFileName);

            return result.success || true; // Consider any successful response as success

        } catch (error) {
            console.error(`Error processing ${file.name}:`, error);

            // Fallback to simple renaming for any error
            this.downloadFileWithFallbackName(file);
            return false;
        }
    }

    createFallbackFileName(originalName) {
        const today = new Date().toISOString().split('T')[0];
        const nameWithoutExt = originalName.replace('.pdf', '');
        return `Receipt_${today}_${nameWithoutExt}.pdf`;
    }

    downloadFileWithFallbackName(file) {
        const fallbackName = this.createFallbackFileName(file.name);
        this.downloadFile(file, fallbackName);
    }

    downloadFile(file, newName) {
        const url = URL.createObjectURL(file);
        const a = document.createElement('a');
        a.href = url;
        a.download = newName;
        a.click();
        URL.revokeObjectURL(url);
    }





    async checkGmailAuth() {
        try {
            if (!this.gmailClient) {
                console.error('Gmail client not initialized');
                this.updateGmailAuthStatus(false);
                return false;
            }
            console.log('🔐 DEBUG: Checking Gmail authentication...');
            const isAuthenticated = await this.gmailClient.checkStoredAuth();
            console.log('🔐 DEBUG: Gmail authentication result:', isAuthenticated);
            this.updateGmailAuthStatus(isAuthenticated);
            console.log('🔐 DEBUG: Updated Gmail auth status in UI');
            return isAuthenticated;
        } catch (error) {
            console.error('🔐 DEBUG: Error checking Gmail auth:', error);
            this.updateGmailAuthStatus(false);
            return false;
        }
    }

    async authenticateGmail() {
        try {
            const success = await this.gmailClient.authenticate();
            this.updateGmailAuthStatus(success);
            if (success) {
                this.showStatus('✅ Gmail access granted!', 'success');
            }
            return success;
        } catch (error) {
            console.error('Gmail authentication error:', error);
            this.showStatus('❌ Gmail authentication failed', 'error');
            return false;
        }
    }

    updateGmailAuthStatus(isAuthenticated) {
        console.log('updateGmailAuthStatus called with:', isAuthenticated);

        // Enable search functionality if Gmail is authenticated
        const searchInput = document.getElementById('searchInput');
        if (searchInput) {
            console.log('Search input before update - disabled:', searchInput.disabled, 'placeholder:', searchInput.placeholder);
            searchInput.disabled = !isAuthenticated;
            searchInput.placeholder = isAuthenticated
                ? 'Search your email for receipts...'
                : 'Connect to Google to enable search';
            console.log('Search input after update - disabled:', searchInput.disabled, 'placeholder:', searchInput.placeholder);
            
            // Ensure search is enabled when authenticated
            if (isAuthenticated) {
                searchInput.disabled = false;
                searchInput.placeholder = 'Search your email for receipts...';
            }
        }

        // Update scan button based on authentication status
        const gmailScanBtn = document.getElementById('gmailScanBtn');
        if (gmailScanBtn) {
            if (isAuthenticated) {
                gmailScanBtn.textContent = 'Monitoring';
                gmailScanBtn.className = 'scan-btn';
                gmailScanBtn.disabled = false;
                console.log('Set button to authenticated state: "Monitoring"');
            } else {
                gmailScanBtn.textContent = 'Connect to Google';
                gmailScanBtn.className = 'scan-btn connect';
                gmailScanBtn.disabled = false;
                console.log('Set button to non-authenticated state: "Connect to Google"');
            }
        } else {
            console.error('Gmail scan button not found!');
        }

        // Initialize monitoring functionality when authenticated
        if (isAuthenticated && !this.monitoringInitialized) {
            this.initializeEmailMonitoring();
            this.initializeAutoscan();
            this.monitoringInitialized = true;
        }
    }

    resetDateRangeSliders() {
        const dayRangeMin = document.getElementById('dayRangeMin');
        const dayRangeMax = document.getElementById('dayRangeMax');
        const dayDisplay = document.getElementById('dayDisplay');
        const rangeProgress = document.getElementById('rangeProgress');

        // Only reset if elements exist (they don't exist in autoscan mode)
        if (dayRangeMin && dayRangeMax && dayDisplay && rangeProgress) {
            // Reset to default values: from today (0%) to month-to-date (25%)
            dayRangeMin.value = '0'; // Today (left dot)
            dayRangeMax.value = '25'; // Month-to-date (right dot)
            dayDisplay.textContent = 'today to month-to-date';

            // Update progress bar
            const progressLeft = 0; // 0% from left
            const progressWidth = 25; // 25% width
            rangeProgress.style.left = `${progressLeft}%`;
            rangeProgress.style.width = `${progressWidth}%`;
        }
    }

    showDateRangeSlider() {
        console.log('=== SHOW DATE RANGE SLIDER ===');
        const dateRangeContainer = document.getElementById('dateRangeContainer');
        const gmailScanBtn = document.getElementById('gmailScanBtn');

        // If dateRangeContainer doesn't exist (autoscan mode), return early
        if (!dateRangeContainer) {
            console.log('dateRangeContainer not found - likely in autoscan mode');
            return;
        }

        console.log('Current button text:', gmailScanBtn.textContent);
        console.log('Slider currently visible:', dateRangeContainer.style.display !== 'none');

        // Show the slider with animation
        dateRangeContainer.style.display = 'block';
        // Force reflow for animation
        dateRangeContainer.offsetHeight;
        dateRangeContainer.classList.add('show');

        // Change button text when slider is shown (only if it's currently "Scan Gmail")
        if (gmailScanBtn.textContent === 'Scan Gmail') {
            console.log('Changing button text to "Start Scanning"');
            gmailScanBtn.textContent = 'Start Scanning';
        } else {
            console.log('NOT changing button text, current text:', gmailScanBtn.textContent);
        }
    }

    hideDateRangeSlider() {
        const dateRangeContainer = document.getElementById('dateRangeContainer');
        const scanResultsArea = document.getElementById('scanResultsArea');
        const gmailScanBtn = document.getElementById('gmailScanBtn');

        // If dateRangeContainer doesn't exist (autoscan mode), return early
        if (!dateRangeContainer) {
            console.log('dateRangeContainer not found - likely in autoscan mode');
            return;
        }

        // Hide the slider with animation
        dateRangeContainer.classList.remove('show');
        setTimeout(() => {
            if (!dateRangeContainer.classList.contains('show')) {
                dateRangeContainer.style.display = 'none';
            }
        }, 300);

        // Don't auto-hide scan results when hiding slider - let them persist
        // (scan results have their own 4-second timer for processing messages)

        // Reset button text when slider is hidden (only if it's not in a scanning state)
        if (gmailScanBtn.textContent === 'Start Scanning') {
            gmailScanBtn.textContent = 'Scan Gmail';
        }
    }

    async autoScanGmail() {
        // Auto-scan triggered by slider changes
        if (this.gmailClient && this.gmailClient.isAuthenticated) {
            await this.scanGmail();
        }
    }

    connectGoogleDrive() {
        // Open Google authentication in new tab
        const authUrl = 'https://bootleg-expensify-34h3.onrender.com/auth/google';
        window.open(authUrl, '_blank', 'width=500,height=600');

        // Check Gmail auth status periodically to see when authentication completes
        const checkInterval = setInterval(async () => {
            const isAuthenticated = await this.gmailClient.checkStoredAuth();
            if (isAuthenticated) {
                clearInterval(checkInterval);
                this.showStatus('✅ Google account connected successfully!', 'success');
                // Update the UI
                this.updateGmailAuthStatus(true);
            }
        }, 2000);

        // Stop checking after 2 minutes
        setTimeout(() => {
            clearInterval(checkInterval);
        }, 120000);
    }

    showStatus(message) {
        const status = document.getElementById('status');
        const searchResults = document.getElementById('searchResults');

        status.textContent = message;
        status.style.display = 'block';

        // Hide search results when showing status
        searchResults.style.opacity = '0.3';

        // Keep messages visible for 8 seconds
        setTimeout(() => {
            status.style.display = 'none';
            searchResults.style.opacity = '1';
        }, 8000);
    }

    showScanResults(message) {
        const scanResultsArea = document.getElementById('scanResultsArea');
        const scanResultsText = document.getElementById('scanResultsText');
        const searchResults = document.getElementById('searchResults');

        scanResultsText.textContent = message;
        scanResultsArea.style.display = 'block';

        // Add class to search results to create space for processing message
        if (searchResults) {
            searchResults.classList.add('processing-active');
        }

        // Force reflow for animation
        scanResultsArea.offsetHeight;
        scanResultsArea.classList.add('show');

        // Keep results visible for 8 seconds
        setTimeout(() => {
            scanResultsArea.classList.remove('show');
            setTimeout(() => {
                if (!scanResultsArea.classList.contains('show')) {
                    scanResultsArea.style.display = 'none';
                }
            }, 300);
        }, 8000);
    }

    hideScanResults() {
        const scanResultsArea = document.getElementById('scanResultsArea');
        const searchResults = document.getElementById('searchResults');
        
        if (scanResultsArea) {
            scanResultsArea.classList.remove('show');
            
            // Remove class from search results to expand back to full space
            if (searchResults) {
                searchResults.classList.remove('processing-active');
            }
            
            setTimeout(() => {
                scanResultsArea.style.display = 'none';
            }, 300);
        }
    }

    // Calculate business period days ago values
    getBusinessPeriodDays() {
        const today = new Date();
        const currentMonth = today.getMonth();
        const currentYear = today.getFullYear();
        
        // Month-to-date: 1st of current month to today
        const monthStart = new Date(currentYear, currentMonth, 1);
        const mtdDays = Math.floor((today - monthStart) / (1000 * 60 * 60 * 24));
        
        // Last month: full previous month
        const lastMonthStart = new Date(currentYear, currentMonth - 1, 1);
        const lastMonthEnd = new Date(currentYear, currentMonth, 0); // Last day of prev month
        const lastMonthDays = Math.floor((today - lastMonthStart) / (1000 * 60 * 60 * 24));
        
        // Quarter-to-date: 1st of current quarter to today
        const quarterStartMonth = Math.floor(currentMonth / 3) * 3; // 0, 3, 6, or 9
        const quarterStart = new Date(currentYear, quarterStartMonth, 1);
        const qtdDays = Math.floor((today - quarterStart) / (1000 * 60 * 60 * 24));
        
        // Last quarter: first day of previous quarter
        const lastQuarterStartMonth = quarterStartMonth - 3;
        const lastQuarterStart = lastQuarterStartMonth < 0 
            ? new Date(currentYear - 1, lastQuarterStartMonth + 12, 1)
            : new Date(currentYear, lastQuarterStartMonth, 1);
        const lastQuarterDays = Math.floor((today - lastQuarterStart) / (1000 * 60 * 60 * 24));
        
        return { mtdDays, lastMonthDays, qtdDays, lastQuarterDays };
    }
    
    // Convert days ago to business period name
    daysToBusinessPeriod(days) {
        const { mtdDays, lastMonthDays, qtdDays, lastQuarterDays } = this.getBusinessPeriodDays();
        
        console.log(`daysToBusinessPeriod: input=${days}, mtd=${mtdDays}, lastMonth=${lastMonthDays}, qtd=${qtdDays}, lastQuarter=${lastQuarterDays}`);
        
        if (days === 0) return 'today';
        
        // Use exact matching with consistent tolerance
        const tolerance = 1;
        if (Math.abs(days - mtdDays) <= tolerance) {
            return 'month-to-date';
        }
        if (Math.abs(days - lastMonthDays) <= tolerance) {
            return 'last month'; 
        }
        if (Math.abs(days - qtdDays) <= tolerance) {
            return 'quarter-to-date';
        }
        if (Math.abs(days - lastQuarterDays) <= tolerance) {
            return 'last quarter';
        }
        
        // For intermediate values, return day count
        return `${days} day${days > 1 ? 's' : ''} ago`;
    }
    
    // Mapping functions between slider position (0-100) and actual days
    sliderPositionToDays(position) {
        const { mtdDays, lastMonthDays, qtdDays, lastQuarterDays } = this.getBusinessPeriodDays();
        
        const mappingPoints = [
            [0, 0],                  // Today
            [25, mtdDays],           // Month-to-date
            [50, lastMonthDays],     // Last month
            [75, qtdDays],           // Quarter-to-date  
            [100, lastQuarterDays]   // Last quarter
        ];
        
        for (let i = 0; i < mappingPoints.length - 1; i++) {
            const [pos1, days1] = mappingPoints[i];
            const [pos2, days2] = mappingPoints[i + 1];
            
            if (position >= pos1 && position <= pos2) {
                const ratio = (position - pos1) / (pos2 - pos1);
                return Math.round(days1 + ratio * (days2 - days1));
            }
        }
        
        return position <= 0 ? 0 : lastQuarterDays;
    }

    async scanGmail() {
        console.log('=== GMAIL SCAN STARTED ===');

        const gmailScanBtn = document.getElementById('gmailScanBtn');
        const searchResults = document.getElementById('searchResults');
        const loading = document.getElementById('loading');
        const dayRangeMin = document.getElementById('dayRangeMin');
        const dayRangeMax = document.getElementById('dayRangeMax');

        // Get selected slider positions and convert to actual day values
        const startPos = parseInt(dayRangeMin.value); // Start position (0-100)
        const endPos = parseInt(dayRangeMax.value); // End position (0-100)
        const startDays = this.sliderPositionToDays(startPos); // Convert to actual days
        const endDays = this.sliderPositionToDays(endPos); // Convert to actual days
        console.log(`Scanning from ${startDays === 0 ? 'today' : startDays + ' days ago'} backward to ${endDays} days ago`);

        // Clear search results and show scan progress in results area
        searchResults.innerHTML = '';
        
        // Show scan results area immediately with initial message
        this.showScanResults('🔍 Looking for receipts...');

        // Keep date range slider visible during scan

        // Disable button and show loading
        gmailScanBtn.disabled = true;
        gmailScanBtn.textContent = 'Scanning...';

        try {
            const response = await fetch('https://bootleg-expensify-34h3.onrender.com/scan-gmail', {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    dayRangeFrom: endDays,   // Server expects "from" as older date (90)
                    dayRangeTo: startDays    // Server expects "to" as newer date (0)
                })
            });

            if (!response.ok) {
                throw new Error(`Server error: ${response.status}`);
            }

            const result = await response.json();
            console.log('Gmail scan result:', result);

            // Handle new async response pattern
            if (result.scanId && result.status === 'processing') {
                // Show initial processing message
                this.showScanResults(`Processing ${result.emailsToProcess} emails in background...`);
                
                // Start polling for results (will clear the message)
                this.pollScanResults(result.scanId, gmailScanBtn);
            } else {
                // Handle old synchronous response (fallback)
                if (result.receiptsProcessed > 0) {
                    this.showScanResults(`Found and processed ${result.receiptsProcessed} receipts from ${result.receiptsFound} emails!`);
                } else if (result.receiptsFound > 0) {
                    this.showScanResults(`Found ${result.receiptsFound} potential receipt emails, but couldn't process them`);
                } else {
                    this.showScanResults(`No receipt emails found`);
                }
            }

        } catch (error) {
            console.error('Gmail scan error:', error);
            this.showScanResults(`❌ Failed to scan Gmail. Check your connection.`);
        } finally {
            // Re-enable button but keep state based on slider visibility
            gmailScanBtn.disabled = false;
            const dateRangeContainer = document.getElementById('dateRangeContainer');
            const sliderVisible = dateRangeContainer && dateRangeContainer.classList.contains('show');
            
            // If slider is still visible, keep it as "Start Scanning", otherwise reset to "Scan Gmail"
            gmailScanBtn.textContent = sliderVisible ? 'Start Scanning' : 'Scan Gmail';
        }
    }

    // Poll scan results until completion
    async pollScanResults(scanId, gmailScanBtn) {
        const maxPollTime = 5 * 60 * 1000; // 5 minutes max
        const pollInterval = 3000; // 3 seconds
        const startTime = Date.now();
        let pollCount = 0;

        // Clear the processing message after 4 seconds
        setTimeout(() => {
            this.hideScanResults();
        }, 4000);

        const poll = async () => {
            try {
                pollCount++;
                console.log(`Polling scan ${scanId} (attempt ${pollCount})`);
                
                const response = await fetch(`https://bootleg-expensify-34h3.onrender.com/scan-status/${scanId}`, {
                    method: 'GET',
                    credentials: 'include'
                });

                if (response.status === 404) {
                    // Scan ID not found - likely expired or invalid
                    console.log('Scan ID not found, stopping polling');
                    gmailScanBtn.disabled = false;
                    const sliderContainer = document.getElementById('dateRangeContainer');
                    const sliderVisible = sliderContainer && sliderContainer.style.display !== 'none';
                    gmailScanBtn.textContent = sliderVisible ? 'Start Scanning' : 'Scan Gmail';
                    // No expired session messages in popup - scan fails silently
                    return;
                }
                
                if (response.status === 500) {
                    // Server error - log but continue polling (background process might still be running)
                    console.log('Server error during status check, continuing to poll...');
                    setTimeout(poll, pollInterval);
                    return;
                }
                
                if (!response.ok) {
                    throw new Error(`Status check failed: ${response.status}`);
                }

                const result = await response.json();
                console.log('Scan status:', result);

                if (result.completed) {
                    // Scan finished silently
                    gmailScanBtn.disabled = false;
                    
                    const sliderVisible = document.getElementById('dateRangeContainer').style.display !== 'none';
                    gmailScanBtn.textContent = sliderVisible ? 'Start Scanning' : 'Scan Gmail';

                    // No completion messages - scan finishes silently
                    return;
                }

                // Still processing - check if we should continue polling
                if (Date.now() - startTime > maxPollTime) {
                    // Timeout - stop polling silently
                    gmailScanBtn.disabled = false;
                    const sliderVisible = document.getElementById('dateRangeContainer').style.display !== 'none';
                    gmailScanBtn.textContent = sliderVisible ? 'Start Scanning' : 'Scan Gmail';
                    // No timeout messages in popup - just stop polling
                    return;
                }

                // Continue polling silently (no progress updates)
                setTimeout(poll, pollInterval);

            } catch (error) {
                console.error('Polling error:', error);
                gmailScanBtn.disabled = false;
                const sliderContainer = document.getElementById('dateRangeContainer');
                const sliderVisible = sliderContainer && sliderContainer.style.display !== 'none';
                gmailScanBtn.textContent = sliderVisible ? 'Start Scanning' : 'Scan Gmail';
                // No error messages in popup - scan fails silently
            }
        };

        // Start polling
        setTimeout(poll, pollInterval);
    }

    handleSearchInput(query) {
        // Clear previous debounce timer
        if (this.searchDebounceTimer) {
            clearTimeout(this.searchDebounceTimer);
        }

        // Debounce search to avoid too many requests
        this.searchDebounceTimer = setTimeout(() => {
            if (query.trim().length > 0) {
                this.searchEmails(query.trim());
            } else {
                this.clearSearchResults();
            }
        }, 500);
    }

    async searchEmails(query) {
        console.log('=== EMAIL SEARCH STARTED ===');
        console.log('Query:', query);

        const searchResults = document.getElementById('searchResults');

        // Check if Gmail is authenticated
        if (!this.gmailClient.isAuthenticated) {
            searchResults.innerHTML = '<div style="color: #dc2626; text-align: center; padding: 20px;">❌ Please connect to Google first</div>';
            return;
        }

        // Show loading state
        searchResults.innerHTML = '<div style="color: #6b7280; text-align: center; padding: 20px;">🔍 Searching...</div>';

        try {
            const results = await this.gmailClient.searchEmails(query);
            console.log('Search results:', results);

            this.displaySearchResults(results);

        } catch (error) {
            console.error('Search error:', error);
            
            // Check if authentication expired
            if (error.message.includes('Authentication expired') || error.message.includes('401')) {
                // Update UI to show disconnected state
                this.updateGmailAuthStatus(false);
                searchResults.innerHTML = '<div style="color: #dc2626; text-align: center; padding: 20px;">🔐 Authentication expired. Please reconnect to Google.</div>';
            } else {
                searchResults.innerHTML = `<div style="color: #dc2626; text-align: center; padding: 20px;">❌ Search failed: ${error.message}</div>`;
            }
        }
    }

    displaySearchResults(results) {
        const searchResults = document.getElementById('searchResults');

        if (!results || results.length === 0) {
            searchResults.innerHTML = '<div style="color: #6b7280; text-align: center; padding: 20px;">No emails found</div>';
            return;
        }

        let html = '';
        results.forEach(email => {
            const emailId = email.id;
            const subject = email.subject || 'No Subject';
            const from = email.from || 'Unknown Sender';
            const date = email.date || 'No Date';

            // Extract just the email address from from field
            const emailAddress = this.extractEmailAddress(from);

            html += `<div class="search-result-item">`;
            html += `<div class="search-result-header">`;
            html += `<div class="search-result-left">`;
            html += `<div class="search-result-subject">${this.escapeHtml(subject)}</div>`;
            html += `<div class="search-result-from">From: ${this.escapeHtml(emailAddress)}</div>`;
            html += `</div>`;
            html += `<div class="search-result-right">`;
            html += `<div class="search-result-date">${this.formatDate(date)}</div>`;
            html += `<button class="convert-btn" data-email-id="${emailId}">Send to Airbase</button>`;
            html += `</div>`;
            html += `</div>`;
            html += `</div>`;
        });

        searchResults.innerHTML = html;
    }

    displayScanResults(results) {
        const searchResults = document.getElementById('searchResults');

        if (!results || results.length === 0) {
            searchResults.innerHTML = '<div style="color: #6b7280; text-align: center; padding: 20px;">No scan results found</div>';
            return;
        }

        let html = '';
        results.forEach(result => {
            const messageId = result.messageId;
            const subject = result.subject || 'No Subject';
            const sender = result.sender || 'Unknown Sender';
            const processed = result.processed;
            const vendor = result.vendor || 'Not found';
            const amount = result.amount || 'Not found';
            const receiptDate = result.receiptDate || 'Not found';
            const emailContent = result.emailContent || 'No content available';
            const error = result.error;

            // Extract just the email address from sender field
            const emailAddress = this.extractEmailAddress(sender);

            html += `<div class="search-result-item ${processed ? 'processed-success' : 'processed-error'}">`;
            html += `<div class="search-result-header">`;
            html += `<div class="search-result-left">`;
            html += `<div class="search-result-subject">${this.escapeHtml(subject)}</div>`;
            html += `<div class="search-result-from">From: ${this.escapeHtml(emailAddress)}</div>`;
            if (processed) {
                html += `<div class="extraction-data">`;
                html += `<span class="vendor-badge">🏪 ${this.escapeHtml(vendor)}</span>`;
                html += `<span class="amount-badge">💰 ${this.escapeHtml(amount)}</span>`;
                html += `<span class="date-badge">📅 ${this.escapeHtml(receiptDate)}</span>`;
                html += `</div>`;
            }
            html += `</div>`;
            html += `<div class="search-result-right">`;
            html += `<div class="process-status ${processed ? 'status-success' : 'status-error'}">`;
            html += processed ? '✅ Processed' : '❌ Failed';
            html += `</div>`;
            if (result.pdfGenerated === false) {
                html += `<div class="warning-message">⚠️ Text fallback used</div>`;
            }
            if (error) {
                html += `<div class="error-message">Error: ${this.escapeHtml(error)}</div>`;
            }
            html += `</div>`;
            html += `</div>`;

            // Show email content preview
            html += `<div class="email-content-preview">`;
            html += `<div class="content-header">Email Content:</div>`;
            html += `<div class="content-text">${this.escapeHtml(emailContent.substring(0, 500))}`;
            if (emailContent.length > 500) {
                html += `<span class="content-truncated">... (content truncated)</span>`;
            }
            html += `</div>`;
            html += `</div>`;

            html += `</div>`;
        });

        searchResults.innerHTML = html;
    }

    clearSearchResults() {
        const searchResults = document.getElementById('searchResults');
        searchResults.innerHTML = '';
    }

    async forwardEmailToAirbase(emailId, buttonElement, airbaseAmounts = null) {
        console.log('=== FORWARD EMAIL TO AIRBASE ===');
        console.log('Email ID:', emailId);
        console.log('Airbase amounts for chunking:', airbaseAmounts);

        // Disable button and show loading
        buttonElement.disabled = true;
        buttonElement.textContent = 'Sending...';

        try {
            // Forward email directly to Airbase inbox
            const requestBody = { emailId: emailId };
            
            // Include Airbase amounts for Amazon chunking if provided
            if (airbaseAmounts && airbaseAmounts.length > 0) {
                requestBody.airbaseAmounts = airbaseAmounts;
            }
            
            const response = await fetch('https://bootleg-expensify-34h3.onrender.com/forward-to-airbase', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                credentials: 'include',
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
                throw new Error(`Server error: ${response.status}`);
            }

            const result = await response.json();
            console.log('Forward result:', result);

            if (result.success) {
                if (result.chunked) {
                    // Amazon email was chunked into multiple emails
                    buttonElement.textContent = `✅ ${result.sentEmails} emails sent`;
                    buttonElement.style.background = '#10b981';
                    console.log(`Amazon email chunked: ${result.sentEmails}/${result.totalTransactions} transactions sent`);
                } else {
                    // Regular email forwarding
                    buttonElement.textContent = '✅ Sent to Airbase';
                    buttonElement.style.background = '#10b981';
                }
            } else {
                throw new Error(result.error || 'Forward failed');
            }

        } catch (error) {
            console.error('Forward error:', error);
            buttonElement.textContent = '❌ Failed';
            buttonElement.style.background = '#dc2626';
        }

        // Re-enable button after a delay
        setTimeout(() => {
            buttonElement.disabled = false;
            if (buttonElement.textContent === '❌ Failed') {
                buttonElement.textContent = 'Send to Airbase';
                buttonElement.style.background = '#f44e40';
            }
        }, 3000);
    }



    cleanEmailContentForPdf(emailContent) {
        // Create a copy to avoid modifying the original
        const cleaned = { ...emailContent };
        
        if (cleaned.body) {
            console.log(`Original email body size: ${cleaned.body.length} characters`);
            
            // Remove all image tags and their content
            cleaned.body = cleaned.body.replace(/<img[^>]*>/gi, '[Image removed]');
            
            // Remove base64 embedded images 
            cleaned.body = cleaned.body.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+\/=]+/g, '[Embedded image removed]');
            
            // Remove background images from CSS
            cleaned.body = cleaned.body.replace(/background-image:\s*url\([^)]+\)/gi, '');
            
            // Remove other large data URLs
            cleaned.body = cleaned.body.replace(/data:[^;]+;base64,[A-Za-z0-9+\/=]{100,}/g, '[Large data removed]');
            
            // Remove excessive whitespace and line breaks
            cleaned.body = cleaned.body.replace(/\s+/g, ' ').trim();
            
            // Truncate if still too large (keep under 100KB)
            if (cleaned.body.length > 100000) {
                cleaned.body = cleaned.body.substring(0, 100000) + '... [Content truncated]';
            }
            
            console.log(`Cleaned email body size: ${cleaned.body.length} characters`);
        }
        
        return cleaned;
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    extractEmailAddress(fromField) {
        // Extract email from formats like "Name <email@domain.com>" or just "email@domain.com"
        const emailMatch = fromField.match(/<([^>]+)>/) || fromField.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
        return emailMatch ? emailMatch[1] : fromField;
    }

    formatDate(dateString) {
        try {
            const date = new Date(dateString);
            return date.toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric'
            });
        } catch (e) {
            return dateString;
        }
    }

    showMonitoringInterface() {
        console.log('=== SHOW MONITORING INTERFACE ===');
        
        // Hide search results and autoscan if any
        const searchResults = document.getElementById('searchResults');
        if (searchResults) {
            searchResults.innerHTML = '';
        }
        
        const autoscanContainer = document.getElementById('autoscanContainer');
        if (autoscanContainer) {
            autoscanContainer.style.display = 'none';
        }
        
        const monitoringContainer = document.getElementById('monitoringContainer');
        if (monitoringContainer) {
            monitoringContainer.style.display = 'block';
            setTimeout(() => monitoringContainer.classList.add('show'), 50);
            console.log('Set monitoring container display to block and added show class');
        }
        
        // Update monitoring status
        this.updateMonitoringStatus();
    }

    showAutoscanInterface() {
        console.log('=== SHOW AUTOSCAN INTERFACE ===');
        
        // Hide monitoring container
        const monitoringContainer = document.getElementById('monitoringContainer');
        if (monitoringContainer) {
            monitoringContainer.style.display = 'none';
        }
        
        // Show the autoscan container
        const autoscanContainer = document.getElementById('autoscanContainer');
        console.log('autoscanContainer:', autoscanContainer);
        if (autoscanContainer) {
            autoscanContainer.style.display = 'block';
            autoscanContainer.classList.add('show'); // Add the 'show' class for visibility
            console.log('Set autoscan container display to block and added show class');
        } else {
            console.error('autoscanContainer element not found!');
        }
        
        // Hide search results
        this.clearSearchResults();
        this.hideScanResults();
    }

    // Secure Email Monitoring Controls
    async initializeEmailMonitoring() {
        console.log('🔒 Initializing secure email monitoring controls...');
        
        // Check if monitoring is already active
        const status = await this.getMonitoringStatus();
        this.updateMonitoringUI(status);
        
        // Set up monitoring controls
        this.setupMonitoringControls();
    }

    setupMonitoringControls() {
        // Start monitoring button
        const startBtn = document.getElementById('startMonitoringBtn');
        if (startBtn) {
            startBtn.addEventListener('click', () => this.startEmailMonitoring());
        }

        // Stop monitoring button
        const stopBtn = document.getElementById('stopMonitoringBtn');
        if (stopBtn) {
            stopBtn.addEventListener('click', () => this.stopEmailMonitoring());
        }

        // Catchup buttons
        const catchup24h = document.getElementById('catchup24h');
        if (catchup24h) {
            catchup24h.addEventListener('click', () => this.catchupEmails(24));
        }

        const catchup3d = document.getElementById('catchup3d');
        if (catchup3d) {
            catchup3d.addEventListener('click', () => this.catchupEmails(72));
        }

        const catchup1w = document.getElementById('catchup1w');
        if (catchup1w) {
            catchup1w.addEventListener('click', () => this.catchupEmails(168));
        }

        const catchupSinceStop = document.getElementById('catchupSinceStop');
        if (catchupSinceStop) {
            catchupSinceStop.addEventListener('click', () => this.catchupEmails());
        }
    }

    async updateMonitoringStatus() {
        const status = await this.getMonitoringStatus();
        this.updateMonitoringUI(status);
    }

    async getMonitoringStatus() {
        try {
            const response = await chrome.runtime.sendMessage({ action: 'getMonitoringStatus' });
            return response || { active: false };
        } catch (error) {
            console.error('Failed to get monitoring status:', error);
            return { active: false };
        }
    }

    async startEmailMonitoring() {
        try {
            console.log('🔄 Attempting to start email monitoring...');
            
            // Check if background script is available
            if (!chrome.runtime) {
                throw new Error('Chrome runtime not available');
            }
            
            const response = await chrome.runtime.sendMessage({ action: 'startMonitoring' });
            console.log('📧 Background response:', response);
            
            if (response && response.success) {
                this.showStatus('📧 Email monitoring started - receipts will be processed automatically');
                const status = await this.getMonitoringStatus();
                this.updateMonitoringUI(status);
            } else {
                throw new Error(response?.message || 'Unknown error starting monitoring');
            }
        } catch (error) {
            console.error('❌ Failed to start monitoring:', error);
            this.showStatus(`❌ Failed to start email monitoring: ${error.message}`);
            
            // Fallback: Show instructions for manual reload
            if (error.message.includes('runtime') || error.message.includes('receiving')) {
                this.showStatus('🔄 Please reload the extension in chrome://extensions and try again');
            }
        }
    }

    async stopEmailMonitoring() {
        try {
            const response = await chrome.runtime.sendMessage({ action: 'stopMonitoring' });
            if (response.success) {
                this.showStatus('⏹️ Email monitoring stopped');
                const status = await this.getMonitoringStatus();
                this.updateMonitoringUI(status);
            }
        } catch (error) {
            console.error('Failed to stop monitoring:', error);
            this.showStatus('❌ Failed to stop email monitoring');
        }
    }

    updateMonitoringUI(status) {
        const monitoringStatus = document.getElementById('monitoringStatus');
        const startBtn = document.getElementById('startMonitoringBtn');
        const stopBtn = document.getElementById('stopMonitoringBtn');
        
        if (monitoringStatus) {
            if (status.active) {
                // Format date more compactly: 7/28, 5:22 PM
                const lastCheckDate = new Date(status.lastCheck);
                const formattedDate = lastCheckDate.toLocaleDateString('en-US', { 
                    month: 'numeric', 
                    day: 'numeric' 
                }) + ', ' + lastCheckDate.toLocaleTimeString('en-US', { 
                    hour: 'numeric', 
                    minute: '2-digit', 
                    hour12: true 
                });
                monitoringStatus.textContent = `Active (last: ${formattedDate})`;
                monitoringStatus.style.color = '#ffffff';
            } else {
                monitoringStatus.textContent = 'Stopped';
                monitoringStatus.style.color = '#ef4444';
                if (status.lastStop) {
                    const stopDate = new Date(status.lastStop);
                    const formattedStop = stopDate.toLocaleDateString('en-US', { 
                        month: 'numeric', 
                        day: 'numeric' 
                    }) + ', ' + stopDate.toLocaleTimeString('en-US', { 
                        hour: 'numeric', 
                        minute: '2-digit', 
                        hour12: true 
                    });
                    monitoringStatus.textContent += ` (${formattedStop})`;
                }
            }
        }
        
        // Update button states
        if (startBtn) {
            startBtn.disabled = status.active;
            startBtn.style.opacity = status.active ? '0.5' : '1';
        }
        
        if (stopBtn) {
            stopBtn.disabled = !status.active;
            stopBtn.style.opacity = !status.active ? '0.5' : '1';
        }
    }

    async catchupEmails(hoursBack = null) {
        try {
            console.log(`🔄 Starting email catchup (${hoursBack ? hoursBack + ' hours' : 'since last stop'})...`);
            
            const monitoringResults = document.getElementById('monitoringResults');
            if (monitoringResults) {
                monitoringResults.style.display = 'block';
                monitoringResults.innerHTML = '🔄 Processing missed emails...';
            }
            
            const response = await chrome.runtime.sendMessage({ 
                action: 'catchupEmails', 
                hoursBack: hoursBack,
                maxEmails: hoursBack ? 200 : 100  // Higher limit for time-based catchup
            });
            
            if (response && response.success) {
                const message = `✅ Catchup complete: ${response.processedCount} receipts processed`;
                if (monitoringResults) {
                    monitoringResults.innerHTML = message;
                    monitoringResults.style.color = '#10b981';
                }
                this.showStatus(message);
            } else {
                const errorMsg = response?.message || 'Catchup failed';
                if (response?.waitTime) {
                    throw new Error(`${errorMsg} (wait ${response.waitTime}s)`);
                } else {
                    throw new Error(errorMsg);
                }
            }
        } catch (error) {
            console.error('❌ Catchup failed:', error);
            const monitoringResults = document.getElementById('monitoringResults');
            if (monitoringResults) {
                monitoringResults.style.display = 'block';
                monitoringResults.innerHTML = `❌ Catchup failed: ${error.message}`;
                monitoringResults.style.color = '#ef4444';
            }
            this.showStatus(`❌ Email catchup failed: ${error.message}`);
        }
    }

    // Autoscan functionality  
    initializeAutoscan() {

        // Handle paste events
        document.addEventListener('paste', (e) => {
            // Only handle image paste if not in an input field
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
                return;
            }
            
            const items = e.clipboardData.items;
            
            for (let i = 0; i < items.length; i++) {
                if (items[i].type.indexOf('image') !== -1) {
                    e.preventDefault();
                    const file = items[i].getAsFile();
                    this.handleImageFile(file);
                    break;
                }
            }
        });

        // Handle drag and drop
        pasteArea.addEventListener('dragover', (e) => {
            e.preventDefault();
            pasteArea.classList.add('dragover');
        });

        pasteArea.addEventListener('dragleave', (e) => {
            e.preventDefault();
            pasteArea.classList.remove('dragover');
        });

        pasteArea.addEventListener('drop', (e) => {
            e.preventDefault();
            pasteArea.classList.remove('dragover');
            
            const files = e.dataTransfer.files;
            if (files.length > 0 && files[0].type.startsWith('image/')) {
                this.handleImageFile(files[0]);
            }
        });

        // Button handlers
        processBtn.addEventListener('click', () => this.processAirbaseImage());
        clearBtn.addEventListener('click', () => this.clearPastedImage());
    }

    handleImageFile(file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            const pastePlaceholder = document.getElementById('pastePlaceholder');
            const pastePreview = document.getElementById('pastePreview');
            const previewImage = document.getElementById('previewImage');
            
            previewImage.src = e.target.result;
            pastePlaceholder.style.display = 'none';
            pastePreview.style.display = 'block';
            
            // Show buttons outside the paste area
            const pasteButtons = document.getElementById('pasteButtons');
            pasteButtons.style.display = 'flex';
            
            // Store image data for processing
            this.currentImageData = e.target.result;
        };
        reader.readAsDataURL(file);
    }

    clearPastedImage() {
        const pastePlaceholder = document.getElementById('pastePlaceholder');
        const pastePreview = document.getElementById('pastePreview');
        const pasteButtons = document.getElementById('pasteButtons');
        
        pastePlaceholder.style.display = 'block';
        pastePreview.style.display = 'none';
        pasteButtons.style.display = 'none';
        this.currentImageData = null;
    }

    async processAirbaseImage() {
        if (!this.currentImageData) {
            return;
        }

        const autoscanStatus = document.getElementById('autoscanStatus');
        const autoscanResults = document.getElementById('autoscanResults');
        const processBtn = document.getElementById('processBtn');

        try {
            // Update status
            autoscanStatus.textContent = 'Analyzing...';
            processBtn.disabled = true;

            // Send image to backend for processing
            const response = await fetch('https://bootleg-expensify-34h3.onrender.com/extract-transactions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    imageData: this.currentImageData
                })
            });

            const result = await response.json();

            if (!result.success) {
                throw new Error(result.error || 'Failed to extract transactions');
            }

            // Show debug info in console only
            console.log('Vision API Raw Text:', result.rawText);
            console.log('Detected blocks:', result.detectedBlocks);
            console.log('Parsed transactions:', result.transactions);
            
            // Start automated processing immediately (no UI display of individual transactions)
            if (result.transactions.length > 0) {
                autoscanStatus.textContent = `Processing ${result.transactions.length} transactions...`;
                
                // Automatically process all transactions
                await this.processAllTransactions(result.transactions);
            } else {
                autoscanStatus.textContent = 'No transactions found';
                autoscanResults.innerHTML = '<div style="color: #6b7280;">No transactions detected in the image</div>';
                autoscanResults.style.display = 'block';
            }

        } catch (error) {
            console.error('Autoscan error:', error);
            autoscanStatus.textContent = 'Error analyzing image';
            autoscanResults.innerHTML = `<div style="color: #ef4444;">Error: ${error.message}</div>`;
            autoscanResults.style.display = 'block';
        } finally {
            processBtn.disabled = false;
        }
    }

    displayExtractedTransactions(transactions) {
        const autoscanResults = document.getElementById('autoscanResults');
        
        if (!transactions || transactions.length === 0) {
            autoscanResults.innerHTML = '<div style="color: #6b7280;">No transactions found in image</div>';
            return;
        }

        let html = '<div style="color: #d1d5db; font-size: 13px; margin-bottom: 8px;">Extracted Transactions:</div>';
        
        transactions.forEach((transaction, index) => {
            const confidence = Math.round(transaction.confidence * 100);
            html += `
                <div style="background: #1f2937; border: 1px solid #374151; border-radius: 4px; padding: 8px; margin-bottom: 6px;">
                    <div style="color: #f3f4f6; font-weight: 500;">${transaction.vendor}</div>
                    <div style="color: #9ca3af; font-size: 12px;">
                        ${transaction.amount} ${transaction.date ? '• ' + transaction.date : ''} • ${confidence}% confidence
                    </div>
                    <button class="process-btn find-receipt-btn" style="margin-top: 4px; font-size: 11px; padding: 4px 8px;" 
                            data-transaction-index="${index}">
                        Find Receipt
                    </button>
                </div>
            `;
        });

        autoscanResults.innerHTML = html;
        
        // Store transactions for searching
        this.extractedTransactions = transactions;
        
        // Add event listeners for Find Receipt buttons
        const findButtons = autoscanResults.querySelectorAll('.find-receipt-btn');
        findButtons.forEach(button => {
            button.addEventListener('click', (e) => {
                const index = parseInt(e.target.getAttribute('data-transaction-index'));
                this.searchForTransaction(index);
            });
        });
    }

    async searchForTransaction(index) {
        const transaction = this.extractedTransactions[index];
        if (!transaction) return;

        try {
            console.log('Searching for transaction:', transaction);
            
            // Build search query for this transaction
            const query = this.buildTransactionSearchQuery(transaction);
            console.log('Search query:', query);
            
            // Use existing search functionality
            const searchInput = document.getElementById('searchInput');
            searchInput.value = query;
            
            // Trigger search
            await this.handleSearch();
            
        } catch (error) {
            console.error('Transaction search error:', error);
        }
    }

    buildTransactionSearchQuery(transaction) {
        // Extract core vendor name from merchant codes
        let vendor = transaction.vendor;
        
        // Clean up vendor name to make it more searchable
        if (vendor.includes('AMAZON')) {
            vendor = 'Amazon';
        } else if (vendor.includes('UBER')) {
            vendor = 'Uber';
        } else if (vendor.includes('DOORDASH') || vendor.includes('DD *')) {
            vendor = 'DoorDash';
        } else if (vendor.includes('TASKRABBIT')) {
            vendor = 'TaskRabbit';
        } else if (vendor.includes('COSTCO')) {
            vendor = 'Costco';
        } else {
            // Extract first word and remove common merchant prefixes
            vendor = vendor.replace(/^(TST\*|SQ \*|IC\*|DD \*)/, '').trim();
            vendor = vendor.split(' ')[0]; // Take first word
            vendor = vendor.replace(/[*]/g, ''); // Remove asterisks
        }
        
        // Build search query with vendor and amount
        let query = vendor;
        
        // Add amount in multiple formats to increase match probability
        if (transaction.amount) {
            const amount = transaction.amount.replace('$', '').trim();
            // Search for amount in common email formats: $48.27, 48.27, $48, etc.
            query += ` ("$${amount}" OR "${amount}" OR "$${amount.split('.')[0]}")`;
        }
        
        // Add date range if available
        if (transaction.date) {
            const transactionDate = new Date(transaction.date);
            const dayBefore = new Date(transactionDate);
            dayBefore.setDate(dayBefore.getDate() - 1);
            const dayAfter = new Date(transactionDate);
            dayAfter.setDate(dayAfter.getDate() + 1);
            
            const formatDate = (date) => {
                return date.getFullYear() + '/' + (date.getMonth() + 1) + '/' + date.getDate();
            };
            
            query += ` after:${formatDate(dayBefore)} before:${formatDate(dayAfter)}`;
        }
        
        console.log(`Original: ${transaction.vendor} → Cleaned: ${vendor} → Query: ${query}`);
        return query;
    }

    async processAllTransactions(transactions) {
        const scanResultsArea = document.getElementById('scanResultsArea');
        const scanResultsText = document.getElementById('scanResultsText');
        const autoscanStatus = document.getElementById('autoscanStatus');
        
        // Show scan results area with progress
        this.showScanResults(`🔍 Searching Gmail and converting receipts...`);
        
        // Add progress text element if it doesn't exist
        if (!document.getElementById('progressText')) {
            scanResultsText.innerHTML += '<div id="progressText" style="color: #9ca3af; font-size: 12px; margin-top: 8px;">Starting...</div>';
        }
        
        let totalProcessed = 0;
        let totalFound = 0;
        let totalConverted = 0;
        
        // Process all transactions in background
        this.processTransactionsInBackground(transactions, autoscanStatus).then(results => {
            // Final summary in scan results format
            this.showScanResults(`📧 Processing complete: ${results.converted} receipts forwarded to Airbase`);
            autoscanStatus.textContent = `Complete: ${results.found}/${results.total} receipts found`;
            
            const progressText = document.getElementById('progressText');
            if (progressText) {
                progressText.innerHTML = `
                    📧 <strong>${results.found} emails</strong> found out of <strong>${results.total} transactions</strong><br>
                    ✅ <strong>${results.converted} receipts</strong> successfully forwarded to Airbase
                `;
                progressText.style.color = '#10b981';
            }
        }).catch(error => {
            console.error('Background processing error:', error);
            this.showScanResults('❌ Error during processing');
            autoscanStatus.textContent = 'Error occurred';
        });
    }

    async processTransactionsInBackground(transactions, autoscanStatus) {
        let totalFound = 0;
        let totalConverted = 0;
        
        for (let i = 0; i < transactions.length; i++) {
            const transaction = transactions[i];
            
            // Update simple progress
            autoscanStatus.textContent = `Processing ${i + 1}/${transactions.length} transactions...`;
            
            const progressText = document.getElementById('progressText');
            if (progressText) {
                progressText.textContent = `Searching for ${transaction.vendor.split(' ')[0]} receipts...`;
            }
            
            try {
                // Search Gmail for this transaction
                const query = this.buildTransactionSearchQuery(transaction);
                console.log(`🔍 Searching for transaction: ${transaction.vendor} - ${transaction.amount}`);
                console.log(`📧 Search query: ${query}`);
                
                let emails;
                try {
                    emails = await this.gmailClient.searchEmails(query, 3);
                    console.log(`📬 Search result: ${emails ? emails.length : 0} emails found`);
                } catch (searchError) {
                    console.error(`❌ Gmail search error for ${transaction.vendor}:`, searchError);
                    
                    // Check if this is a 401 authentication error
                    if (searchError.message && searchError.message.includes('401')) {
                        console.log('🔑 Authentication expired - stopping autoscan and updating UI');
                        // Update the autoscan status to indicate auth issue
                        autoscanStatus.textContent = 'Authentication expired - please reconnect';
                        
                        // The Gmail client should have already updated the UI to show "Connect to Google"
                        // Stop processing and return early
                        return {
                            total: transactions.length,
                            found: 0,
                            converted: 0
                        };
                    }
                    
                    continue; // Skip this transaction and continue with next
                }
                
                if (emails && emails.length > 0) {
                    totalFound++;
                    
                    // Process first email only
                    const email = emails[0];
                    try {
                        if (progressText) {
                            progressText.textContent = `Forwarding ${transaction.vendor.split(' ')[0]} receipt to Airbase...`;
                        }
                        
                        const fakeButton = document.createElement('button');
                        // Pass all transaction amounts for Amazon chunking
                        const allAmounts = transactions.map(t => t.amount).filter(amount => amount);
                        await this.forwardEmailToAirbase(email.id, fakeButton, allAmounts);
                        totalConverted++;
                        
                        console.log(`✅ Forwarded: ${transaction.vendor}`);
                    } catch (error) {
                        console.error(`❌ Forward failed for ${transaction.vendor}:`, error);
                    }
                }
                
            } catch (error) {
                console.error(`Error processing transaction ${transaction.vendor}:`, error);
            }
            
            // Small delay to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 300));
        }
        
        return {
            total: transactions.length,
            found: totalFound,
            converted: totalConverted
        };
    }
}

// Extension initialization is handled by initializeExtension() function above
