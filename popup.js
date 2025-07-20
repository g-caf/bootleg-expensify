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
            const authUrl = 'https://bootleg-expensify.onrender.com/auth/google';
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
            const response = await fetch('https://bootleg-expensify.onrender.com/auth/token', {
                credentials: 'include'
            });
            if (response.ok) {
                const data = await response.json();
                return data.access_token;
            }
        } catch (error) {
            // Ignore errors, we're just checking
        }
        return null;
    }

    async checkStoredAuth() {
        try {
            console.log('GmailClient: checkStoredAuth started');

            // ONLY trust server token - don't use stored tokens
            // This prevents client/server auth state mismatch
            const serverToken = await this.getTokenFromServer();
            console.log('GmailClient: serverToken result:', serverToken ? 'token received' : 'no token');

            if (serverToken) {
                this.accessToken = serverToken;
                this.isAuthenticated = true;
                await chrome.storage.local.set({ gmailAccessToken: serverToken });
                console.log('GmailClient: authenticated via server token');
                return true;
            } else {
                // Server says not authenticated - clear any stale local data
                console.log('GmailClient: server not authenticated, clearing local storage');
                await chrome.storage.local.remove(['gmailAccessToken']);
                this.accessToken = null;
                this.isAuthenticated = false;
                return false;
            }
        } catch (error) {
            console.error('Error checking stored auth:', error);
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
                // Token expired, try to refresh from server
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
                    // No valid token available, user needs to re-authenticate
                    this.isAuthenticated = false;
                    this.accessToken = null;
                    await chrome.storage.local.remove(['gmailAccessToken']);
                    throw new Error('Authentication expired. Please reconnect to Gmail.');
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
        
        // Mapping functions between slider position (0-100) and actual days
        const sliderPositionToDays = (position) => {
            // Define key mapping points: [sliderPosition, actualDays]
            const mappingPoints = [
                [0, 0],    // 0% = today
                [20, 7],   // 20% = 7 days  
                [40, 15],  // 40% = 15 days
                [60, 30],  // 60% = 30 days
                [80, 60],  // 80% = 60 days
                [100, 90]  // 100% = 90 days
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
            return position <= 0 ? 0 : 90;
        };
        
        const daysToSliderPosition = (days) => {
            // Reverse mapping from days to slider position
            const mappingPoints = [
                [0, 0],    // today = 0%
                [7, 20],   // 7 days = 20%
                [15, 40],  // 15 days = 40%
                [30, 60],  // 30 days = 60%
                [60, 80],  // 60 days = 80%
                [90, 100]  // 90 days = 100%
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
            // Snap to common slider positions (20%, 40%, 60%, 80%)
            const snapPoints = [20, 40, 60, 80];
            const snapThreshold = 3; // Snap within 3% of target
            
            for (const snapPoint of snapPoints) {
                if (Math.abs(position - snapPoint) <= snapThreshold) {
                    return snapPoint;
                }
            }
            return position;
        };

        const updateRangeDisplay = () => {
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

            // Update display text with actual day values
            const fromText = finalMinDays === 0 ? 'today' : `${finalMinDays} day${finalMinDays > 1 ? 's' : ''} ago`;
            const toText = `${finalMaxDays} day${finalMaxDays > 1 ? 's' : ''} ago`;
            dayDisplay.textContent = `${fromText} to ${toText}`;

            // Update progress bar (use slider positions for visual consistency)
            const progressLeft = finalMinPos;
            const progressWidth = finalMaxPos - finalMinPos;
            rangeProgress.style.left = `${progressLeft}%`;
            rangeProgress.style.width = `${progressWidth}%`;

            // Auto-scan disabled - user must click "Start Scanning" button
            // This prevents auto-scanning when adjusting the slider
        };

        dayRangeMin.addEventListener('input', updateRangeDisplay);
        dayRangeMax.addEventListener('input', updateRangeDisplay);

        // Gmail scan button
        const gmailScanBtn = document.getElementById('gmailScanBtn');
        gmailScanBtn.addEventListener('click', async () => {
            console.log('=== GMAIL SCAN BUTTON CLICKED ===');
            console.log('Button text:', gmailScanBtn.textContent);
            
            if (gmailScanBtn.textContent === 'Connect to Google') {
                console.log('Connecting to Google...');
                // Handle connection
                await this.connectGoogleDrive();
            } else if (gmailScanBtn.textContent === 'Scan Gmail') {
                console.log('Showing date range slider...');
                // Show date range slider and change button to "Start Scanning"
                this.showDateRangeSlider();
            } else if (gmailScanBtn.textContent === 'Start Scanning') {
                console.log('Starting Gmail scan...');
                // Execute the scan
                await this.scanGmail();
            } else {
                console.log('Unknown button state:', gmailScanBtn.textContent);
            }
        });

        // Search input
        searchInput.addEventListener('input', (e) => {
            this.handleSearchInput(e.target.value);
        });

        // Hide slider when focusing on search input
        searchInput.addEventListener('focus', () => {
            this.hideDateRangeSlider();
        });

        // Event delegation for convert buttons (dynamically created)
        document.addEventListener('click', (e) => {
            if (e.target.classList.contains('convert-btn')) {
                const emailId = e.target.getAttribute('data-email-id');
                if (emailId) {
                    this.convertEmailToPdf(emailId, e.target);
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

            const response = await fetch('https://bootleg-expensify.onrender.com/parse-receipt', {
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
            console.log('Checking Gmail authentication...');
            const isAuthenticated = await this.gmailClient.checkStoredAuth();
            console.log('Gmail authentication result:', isAuthenticated);
            this.updateGmailAuthStatus(isAuthenticated);
            console.log('Updated Gmail auth status in UI');
            return isAuthenticated;
        } catch (error) {
            console.error('Error checking Gmail auth:', error);
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
            searchInput.disabled = !isAuthenticated;
            searchInput.placeholder = isAuthenticated
                ? 'Search your email for receipts...'
                : 'Connect to Google to enable search';
            console.log('Updated search input. Disabled:', !isAuthenticated, 'Placeholder:', searchInput.placeholder);
        }

        // Update scan button based on authentication status
        const gmailScanBtn = document.getElementById('gmailScanBtn');
        if (gmailScanBtn) {
            if (isAuthenticated) {
                gmailScanBtn.textContent = 'Scan Gmail';
                gmailScanBtn.className = 'scan-btn';
                gmailScanBtn.disabled = false;
                console.log('Set button to authenticated state: "Scan Gmail"');
            } else {
                gmailScanBtn.textContent = 'Connect to Google';
                gmailScanBtn.className = 'scan-btn connect';
                gmailScanBtn.disabled = false;
                console.log('Set button to non-authenticated state: "Connect to Google"');
            }
        } else {
            console.error('Gmail scan button not found!');
        }
    }

    resetDateRangeSliders() {
        const dayRangeMin = document.getElementById('dayRangeMin');
        const dayRangeMax = document.getElementById('dayRangeMax');
        const dayDisplay = document.getElementById('dayDisplay');
        const rangeProgress = document.getElementById('rangeProgress');

        // Reset to default values: from today (0%) to 7 days ago (20%)
        dayRangeMin.value = '0'; // Today (left dot)
        dayRangeMax.value = '20'; // 7 days ago (right dot)
        dayDisplay.textContent = 'today to 7 days ago';

        // Update progress bar
        const progressLeft = 0; // 0% from left
        const progressWidth = 20; // 20% width
        rangeProgress.style.left = `${progressLeft}%`;
        rangeProgress.style.width = `${progressWidth}%`;
    }

    showDateRangeSlider() {
        console.log('=== SHOW DATE RANGE SLIDER ===');
        const dateRangeContainer = document.getElementById('dateRangeContainer');
        const gmailScanBtn = document.getElementById('gmailScanBtn');

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

        // Hide the slider with animation
        dateRangeContainer.classList.remove('show');
        setTimeout(() => {
            if (!dateRangeContainer.classList.contains('show')) {
                dateRangeContainer.style.display = 'none';
            }
        }, 300);

        // Also hide scan results
        scanResultsArea.classList.remove('show');
        setTimeout(() => {
            if (!scanResultsArea.classList.contains('show')) {
                scanResultsArea.style.display = 'none';
            }
        }, 300);

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
        const authUrl = 'https://bootleg-expensify.onrender.com/auth/google';
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

        scanResultsText.textContent = message;
        scanResultsArea.style.display = 'block';

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

    // Mapping functions between slider position (0-100) and actual days
    sliderPositionToDays(position) {
        const mappingPoints = [
            [0, 0], [20, 7], [40, 15], [60, 30], [80, 60], [100, 90]
        ];
        
        for (let i = 0; i < mappingPoints.length - 1; i++) {
            const [pos1, days1] = mappingPoints[i];
            const [pos2, days2] = mappingPoints[i + 1];
            
            if (position >= pos1 && position <= pos2) {
                const ratio = (position - pos1) / (pos2 - pos1);
                return Math.round(days1 + ratio * (days2 - days1));
            }
        }
        
        return position <= 0 ? 0 : 90;
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
            const response = await fetch('https://bootleg-expensify.onrender.com/scan-gmail', {
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
                // Show processing message
                this.showScanResults(`Processing ${result.emailsToProcess} emails in background...`);
                
                // Start polling for results
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
            const sliderVisible = dateRangeContainer.classList.contains('show');
            
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

        const poll = async () => {
            try {
                pollCount++;
                console.log(`Polling scan ${scanId} (attempt ${pollCount})`);
                
                const response = await fetch(`https://bootleg-expensify.onrender.com/scan-status/${scanId}`, {
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
                    this.showScanResults(`Scan session expired. Please try again.`);
                    return;
                }
                
                if (!response.ok) {
                    throw new Error(`Status check failed: ${response.status}`);
                }

                const result = await response.json();
                console.log('Scan status:', result);

                if (result.completed) {
                    // Scan finished
                    gmailScanBtn.disabled = false;
                    
                    const sliderVisible = document.getElementById('dateRangeContainer').style.display !== 'none';
                    gmailScanBtn.textContent = sliderVisible ? 'Start Scanning' : 'Scan Gmail';

                    if (result.error) {
                        this.showScanResults(`Scan failed: ${result.error}`);
                    } else if (result.receiptsProcessed > 0) {
                        this.showScanResults(`✅ Processed ${result.receiptsProcessed} receipts from ${result.receiptsFound} emails!`);
                    } else if (result.receiptsFound > 0) {
                        this.showScanResults(`Found ${result.receiptsFound} emails, but no receipts were processed`);
                    } else {
                        this.showScanResults(`No receipt emails found`);
                    }
                    return;
                }

                // Still processing - check if we should continue polling
                if (Date.now() - startTime > maxPollTime) {
                    // Timeout
                    gmailScanBtn.disabled = false;
                    const sliderVisible = document.getElementById('dateRangeContainer').style.display !== 'none';
                    gmailScanBtn.textContent = sliderVisible ? 'Start Scanning' : 'Scan Gmail';
                    this.showScanResults(`⏱️ Scan taking longer than expected. Check back later.`);
                    return;
                }

                // Update progress message
                const elapsed = Math.floor((Date.now() - startTime) / 1000);
                this.showScanResults(`🔄 Processing emails... (${elapsed}s elapsed)`);

                // Continue polling
                setTimeout(poll, pollInterval);

            } catch (error) {
                console.error('Polling error:', error);
                gmailScanBtn.disabled = false;
                const sliderContainer = document.getElementById('dateRangeContainer');
                const sliderVisible = sliderContainer && sliderContainer.style.display !== 'none';
                gmailScanBtn.textContent = sliderVisible ? 'Start Scanning' : 'Scan Gmail';
                this.showScanResults(`❌ Error checking scan progress: ${error.message}`);
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
            if (error.message.includes('Authentication expired')) {
                // Update UI to show disconnected state
                this.updateUI(false);
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
            html += `<button class="convert-btn" data-email-id="${emailId}">Convert to PDF</button>`;
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

    async convertEmailToPdf(emailId, buttonElement) {
        console.log('=== CONVERT EMAIL TO PDF ===');
        console.log('Email ID:', emailId);

        // Disable button and show loading
        buttonElement.disabled = true;
        buttonElement.textContent = 'Converting...';

        try {
            // Get the full email content from Gmail (including body)
            const emailContent = await this.gmailClient.getFullMessageContent(emailId);
            console.log('Got full email content:', emailContent);

            // Clean the email content to remove images and reduce size
            const cleanedEmailContent = this.cleanEmailContentForPdf(emailContent);
            console.log('Cleaned email content for PDF conversion');

            // Send to server for PDF conversion
            const response = await fetch('https://bootleg-expensify.onrender.com/convert-email-to-pdf', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                credentials: 'include',
                body: JSON.stringify({
                    emailId: emailId,
                    emailContent: cleanedEmailContent
                })
            });

            if (!response.ok) {
                throw new Error(`Server error: ${response.status}`);
            }

            const result = await response.json();
            console.log('Conversion result:', result);

            if (result.success) {
                buttonElement.textContent = '✅ Done';
                buttonElement.style.background = '#10b981';
                // No overlay message - just button state change
            } else {
                throw new Error(result.error || 'Conversion failed');
            }

        } catch (error) {
            console.error('Convert error:', error);
            buttonElement.textContent = '❌ Failed';
            buttonElement.style.background = '#dc2626';
            this.showStatus(`❌ Failed to convert email: ${error.message}`, 'error');
        }

        // Re-enable button after a delay
        setTimeout(() => {
            buttonElement.disabled = false;
            if (buttonElement.textContent === '❌ Failed') {
                buttonElement.textContent = 'Convert to PDF';
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
}

// Extension initialization is handled by initializeExtension() function above
