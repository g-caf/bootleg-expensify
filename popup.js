// Extension setup for sequential PDF processing
console.log('=== POPUP.JS SCRIPT LOADING ===');
console.log('Chrome runtime available:', !!chrome.runtime);
console.log('Extension mode: Sequential PDF processing with progress bar');

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
            // First try to get token from server (most reliable)
            const serverToken = await this.getTokenFromServer();
            if (serverToken) {
                this.accessToken = serverToken;
                this.isAuthenticated = true;
                await chrome.storage.local.set({ gmailAccessToken: serverToken });
                return true;
            }

            // Fallback to stored token
            const result = await chrome.storage.local.get(['gmailAccessToken']);
            if (result.gmailAccessToken) {
                this.accessToken = result.gmailAccessToken;
                // Verify token is still valid
                const isValid = await this.verifyToken();
                if (isValid) {
                    this.isAuthenticated = true;
                    return true;
                }
            }
        } catch (error) {
            console.error('Error checking stored auth:', error);
        }
        return false;
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
        this.init();
    }

    async init() {
        this.setupEventListeners();
        // Initialize Gmail client after everything else is set up
        try {
            this.gmailClient = new GmailClient();
        } catch (error) {
            console.error('Failed to initialize Gmail client:', error);
        }
        await this.checkGmailAuth();
    }

    setupEventListeners() {
        const closeBtn = document.getElementById('closeBtn');
        const searchInput = document.getElementById('searchInput');

        // Close button
        closeBtn.addEventListener('click', () => {
            window.close();
        });


        
        // Gmail scan button
        const gmailScanBtn = document.getElementById('gmailScanBtn');
        gmailScanBtn.addEventListener('click', async () => {
            if (gmailScanBtn.textContent === 'Connect to Google') {
                // Handle connection
                await this.connectGoogleDrive();
            } else {
                // Handle scanning
                this.scanGmail();
            }
        });

        // Search input
        searchInput.addEventListener('input', (e) => {
            this.handleSearchInput(e.target.value);
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
        const isAuthenticated = await this.gmailClient.checkStoredAuth();
        this.updateGmailAuthStatus(isAuthenticated);
        return isAuthenticated;
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
        // Enable search functionality if Gmail is authenticated
        const searchInput = document.getElementById('searchInput');
        if (searchInput) {
            searchInput.disabled = !isAuthenticated;
            searchInput.placeholder = isAuthenticated 
                ? 'Search your email for receipts...'
                : 'Connect to Google to enable search';
        }
        
        // Update scan button based on authentication status
        const gmailScanBtn = document.getElementById('gmailScanBtn');
        if (gmailScanBtn) {
            if (isAuthenticated) {
                gmailScanBtn.textContent = 'Scan Gmail';
                gmailScanBtn.className = 'scan-btn';
                gmailScanBtn.disabled = false;
            } else {
                gmailScanBtn.textContent = 'Connect to Google';
                gmailScanBtn.className = 'scan-btn connect';
                gmailScanBtn.disabled = false;
            }
        }
    }

    connectGoogleDrive() {
        // Open Google authentication in new tab
        const authUrl = 'https://bootleg-expensify.onrender.com/auth/google';
        window.open(authUrl, '_blank', 'width=500,height=600');
        
        // Check Gmail auth status periodically to see when authentication completes
        const checkInterval = setInterval(async () => {
            const isAuthenticated = await this.gmailClient.checkAuthentication();
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

    async scanGmail() {
        console.log('=== GMAIL SCAN STARTED ===');
        
        const gmailScanBtn = document.getElementById('gmailScanBtn');
        const searchResults = document.getElementById('searchResults');
        const loading = document.getElementById('loading');
        
        // Clear search results and show loading
        searchResults.innerHTML = '';
        loading.style.display = 'block';
        
        // Disable button and show loading
        gmailScanBtn.disabled = true;
        gmailScanBtn.textContent = 'Scanning...';
        
        try {
            const response = await fetch('https://bootleg-expensify.onrender.com/scan-gmail', {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/json'
                }
            });
            
            if (!response.ok) {
                throw new Error(`Server error: ${response.status}`);
            }
            
            const result = await response.json();
            console.log('Gmail scan result:', result);
            
            // Hide loading
            loading.style.display = 'none';
            
            // Show success message only
            if (result.receiptsProcessed > 0) {
                this.showStatus(`Found and processed ${result.receiptsProcessed} receipts from ${result.receiptsFound} emails!`);
            } else if (result.receiptsFound > 0) {
                this.showStatus(`Found ${result.receiptsFound} potential receipt emails, but couldn't process them`);
            } else {
                this.showStatus('No recent order confirmation emails found');
            }
            
        } catch (error) {
            console.error('Gmail scan error:', error);
            loading.style.display = 'none';
            this.showStatus('Failed to scan Gmail. Check your connection.');
        } finally {
            // Re-enable button
            gmailScanBtn.disabled = false;
            gmailScanBtn.textContent = 'Scan Gmail';
        }
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
            searchResults.innerHTML = `<div style="color: #dc2626; text-align: center; padding: 20px;">❌ Search failed: ${error.message}</div>`;
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
            
            html += `<div class="search-result-item">`;
            html += `<div class="search-result-header">`;
            html += `<div class="search-result-subject">${this.escapeHtml(subject)}</div>`;
            html += `<div class="search-result-date">${this.formatDate(date)}</div>`;
            html += `</div>`;
            html += `<div class="search-result-from">From: ${this.escapeHtml(from)}</div>`;
            html += `<button class="convert-btn" data-email-id="${emailId}">Convert to PDF</button>`;
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
            // Get the email content from Gmail
            const emailContent = await this.gmailClient.getMessageDetails(emailId);
            console.log('Got email content:', emailContent);
            
            // Send to server for PDF conversion
            const response = await fetch('https://bootleg-expensify.onrender.com/convert-email-to-pdf', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                credentials: 'include',
                body: JSON.stringify({
                    emailId: emailId,
                    emailContent: emailContent
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
                this.showStatus(`✅ Email converted to PDF successfully!`, 'success');
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

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
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

// Initialize the extension
console.log('=== ABOUT TO CREATE EXPENSEGADGET ===');
const expenseGadget = new ExpenseGadget();
console.log('=== EXPENSEGADGET CREATED ===');
