// Extension setup for sequential PDF processing
console.log('=== POPUP.JS SCRIPT LOADING ===');
console.log('Chrome runtime available:', !!chrome.runtime);
console.log('Extension mode: Sequential PDF processing with progress bar');

class ExpenseGadget {
    constructor() {
        console.log('=== EXPENSEGADGET CONSTRUCTOR ===');
        this.currentQueue = [];
        this.isProcessing = false;
        this.currentTab = 'scan';
        this.searchDebounceTimer = null;
        this.gmailClient = new GmailClient();
        this.init();
    }

    async init() {
        this.setupEventListeners();
        this.setupTabs();
        await this.checkGoogleDriveStatus();
        await this.checkGmailAuth();
    }

    setupEventListeners() {
        const dropZone = document.getElementById('dropZone');
        const fileInput = document.getElementById('fileInput');
        const closeBtn = document.getElementById('closeBtn');
        const googleDriveSection = document.getElementById('googleDriveSection');
        const searchInput = document.getElementById('searchInput');

        // Close button
        closeBtn.addEventListener('click', () => {
            window.close();
        });

        // Drop zone events
        dropZone.addEventListener('click', () => fileInput.click());
        dropZone.addEventListener('dragover', this.handleDragOver.bind(this));
        dropZone.addEventListener('drop', this.handleDrop.bind(this));
        dropZone.addEventListener('dragleave', this.handleDragLeave.bind(this));

        // File input change
        fileInput.addEventListener('change', (e) => {
            this.processFiles(e.target.files);
        });

        // Google Drive section (entire section is clickable)
        googleDriveSection.addEventListener('click', () => {
            this.handleDriveCheckboxClick();
        });
        
        // Gmail scan button
        const gmailScanBtn = document.getElementById('gmailScanBtn');
        gmailScanBtn.addEventListener('click', () => {
            this.scanGmail();
        });

        // Search input
        searchInput.addEventListener('input', (e) => {
            this.handleSearchInput(e.target.value);
        });
    }

    setupTabs() {
        const tabs = document.querySelectorAll('.tab');
        const panels = document.querySelectorAll('.tab-panel');

        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                const tabName = tab.getAttribute('data-tab');
                this.switchTab(tabName);
            });
        });
    }

    switchTab(tabName) {
        // Update active tab
        document.querySelectorAll('.tab').forEach(tab => {
            tab.classList.remove('active');
        });
        document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');

        // Update active panel
        document.querySelectorAll('.tab-panel').forEach(panel => {
            panel.classList.remove('active');
        });
        document.getElementById(`${tabName}-panel`).classList.add('active');

        this.currentTab = tabName;
    }

    handleDragOver(e) {
        e.preventDefault();
        e.stopPropagation();
        document.getElementById('dropZone').classList.add('dragover');
    }

    handleDragLeave(e) {
        e.preventDefault();
        e.stopPropagation();
        document.getElementById('dropZone').classList.remove('dragover');
    }

    handleDrop(e) {
        console.log('=== DROP EVENT FIRED ===');
        e.preventDefault();
        e.stopPropagation();
        document.getElementById('dropZone').classList.remove('dragover');
        
        const files = e.dataTransfer.files;
        console.log('Files dropped:', files.length);
        this.processFiles(files);
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

    async checkGoogleDriveStatus() {
        try {
            const response = await fetch('https://bootleg-expensify.onrender.com/auth/status', {
                credentials: 'include'
            });
            const data = await response.json();
            this.updateDriveStatus(data.authenticated);
        } catch (error) {
            console.error('Error checking Google Drive status:', error);
            this.updateDriveStatus(false);
        }
    }

    updateDriveStatus(isConnected) {
        const statusText = document.getElementById('driveStatusText');
        const checkbox = document.getElementById('driveCheckbox');
        const gmailScanBtn = document.getElementById('gmailScanBtn');

        if (isConnected) {
            statusText.textContent = 'Connect to Google';
            statusText.className = 'drive-status-text connected'; // This will hide the text
            checkbox.className = 'drive-checkbox connected';
            gmailScanBtn.disabled = false; // Enable Gmail scan when connected
        } else {
            statusText.textContent = 'Connect to Google';
            statusText.className = 'drive-status-text';
            checkbox.className = 'drive-checkbox';
            gmailScanBtn.disabled = true; // Disable Gmail scan when not connected
        }
    }

    async handleDriveCheckboxClick() {
        const checkbox = document.getElementById('driveCheckbox');
        const isConnected = checkbox.classList.contains('connected');
        
        if (!isConnected) {
            this.connectGoogleDrive();
        }
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
    }

    connectGoogleDrive() {
        // Open Google Drive authentication in new tab
        const authUrl = 'https://bootleg-expensify.onrender.com/auth/google';
        window.open(authUrl, '_blank', 'width=500,height=600');
        
        // Check status periodically to see when authentication completes
        const checkInterval = setInterval(async () => {
            await this.checkGoogleDriveStatus();
            const statusText = document.getElementById('driveStatusText');
            if (statusText.textContent.includes('Connected')) {
                clearInterval(checkInterval);
                this.showStatus('✅ Google Drive connected successfully!', 'success');
                // Also check Gmail auth since we use the same OAuth flow
                await this.checkGmailAuth();
            }
        }, 2000);

        // Stop checking after 2 minutes
        setTimeout(() => {
            clearInterval(checkInterval);
        }, 120000);
    }

    showStatus(message, type) {
        const status = document.getElementById('status');
        status.textContent = message;
        status.className = `status ${type}`;
        status.style.display = 'block';
        
        // Keep messages visible for appropriate duration
        const duration = type === 'success' ? 8000 : 10000;
        setTimeout(() => {
            status.style.display = 'none';
        }, duration);
    }

    async scanGmail() {
        console.log('=== GMAIL SCAN STARTED ===');
        
        const gmailScanBtn = document.getElementById('gmailScanBtn');
        const scanResults = document.getElementById('scanResults');
        
        // Disable button and show loading
        gmailScanBtn.disabled = true;
        gmailScanBtn.textContent = 'Scanning...';
        
        // Show results section
        scanResults.style.display = 'block';
        scanResults.innerHTML = '<div style="color: #6b7280;">🔍 Scanning your email for order confirmations...</div>';
        
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
            
            // Update results display
            this.displayScanResults(result);
            
            // Show success message
            if (result.receiptsProcessed > 0) {
                this.showStatus(`✅ Found and processed ${result.receiptsProcessed} receipts from ${result.receiptsFound} emails!`, 'success');
            } else if (result.receiptsFound > 0) {
                this.showStatus(`⚠️ Found ${result.receiptsFound} potential receipt emails, but couldn't process them`, 'warning');
            } else {
                this.showStatus('📭 No recent order confirmation emails found', 'warning');
            }
            
        } catch (error) {
            console.error('Gmail scan error:', error);
            scanResults.innerHTML = `<div style="color: #dc2626;">❌ Error scanning Gmail: ${error.message}</div>`;
            this.showStatus('❌ Failed to scan Gmail. Check your connection.', 'error');
        } finally {
            // Re-enable button
            gmailScanBtn.disabled = false;
            gmailScanBtn.textContent = 'Scan Gmail';
        }
    }

    displayScanResults(result) {
        const scanResults = document.getElementById('scanResults');
        
        if (result.results.length === 0) {
            scanResults.innerHTML = '<div style="color: #6b7280;">No order confirmation emails found in recent emails</div>';
            return;
        }
        
        let html = `<div style="font-weight: 500; margin-bottom: 8px;">📧 Found ${result.receiptsFound} emails, processed ${result.receiptsProcessed} receipts:</div>`;
        
        result.results.forEach(item => {
            const status = item.processed ? '✅' : '❌';
            const statusClass = item.processed ? 'scan-result-success' : 'scan-result-error';
            
            html += `<div class="scan-result-item">`;
            html += `<div class="${statusClass}">${status} ${item.filename || 'Email receipt'}</div>`;
            
            if (item.processed) {
                html += `<div style="font-size: 11px; color: #6b7280; margin-left: 16px;">`;
                html += `${item.vendor || 'Unknown'} • $${item.amount || '?'} • ${item.receiptDate || 'No date'}`;
                if (item.googleDrive && item.googleDrive.success) {
                    html += ` • 📁 ${item.googleDrive.monthFolder}`;
                }
                html += `</div>`;
            } else if (item.error) {
                html += `<div style="font-size: 11px; color: #dc2626; margin-left: 16px;">${item.error}</div>`;
            }
            
            html += `</div>`;
        });
        
        scanResults.innerHTML = html;
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
            html += `<button class="convert-btn" onclick="expenseGadget.convertEmailToPdf('${emailId}', this)">Convert to PDF</button>`;
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
            // For now, show that we need to implement server-side email processing
            // We'll need to add a new endpoint that takes an email ID and processes it
            this.showStatus('⚠️ Email conversion coming soon - server endpoint needed', 'warning');
            buttonElement.textContent = '⏳ Soon';
            buttonElement.style.background = '#f59e0b';
            
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
