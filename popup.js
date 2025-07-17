// Extension setup for sequential PDF processing
console.log('=== POPUP.JS SCRIPT LOADING ===');
console.log('Chrome runtime available:', !!chrome.runtime);
console.log('Extension mode: Sequential PDF processing with progress bar');

class ExpenseGadget {
    constructor() {
        console.log('=== EXPENSEGADGET CONSTRUCTOR ===');
        this.currentQueue = [];
        this.isProcessing = false;
        this.init();
    }

    async init() {
        this.setupEventListeners();
        await this.checkGoogleDriveStatus();
    }

    setupEventListeners() {
        const dropZone = document.getElementById('dropZone');
        const fileInput = document.getElementById('fileInput');
        const closeBtn = document.getElementById('closeBtn');
        const driveConnectBtn = document.getElementById('driveConnectBtn');

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

        // Google Drive connect button
        driveConnectBtn.addEventListener('click', () => {
            this.connectGoogleDrive();
        });
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
        const connectBtn = document.getElementById('driveConnectBtn');

        if (isConnected) {
            statusText.textContent = 'Google Drive: Connected';
            statusText.className = 'drive-status-text drive-connected';
            connectBtn.style.display = 'none';
        } else {
            statusText.textContent = 'Google Drive: Not connected';
            statusText.className = 'drive-status-text';
            connectBtn.style.display = 'block';
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
}

// Initialize the extension
console.log('=== ABOUT TO CREATE EXPENSEGADGET ===');
const expenseGadget = new ExpenseGadget();
console.log('=== EXPENSEGADGET CREATED ===');
