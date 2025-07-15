// Extension setup (PDF.js disabled)
console.log('=== POPUP.JS SCRIPT LOADING ===');
console.log('Chrome runtime available:', !!chrome.runtime);
console.log('Extension mode: Simple file renaming (no PDF parsing)');

class ExpenseGadget {
    constructor() {
        console.log('=== EXPENSEGADGET CONSTRUCTOR ===');
        this.receipts = [];
        this.init();
    }

    async init() {
        this.setupEventListeners();
        await this.loadStoredReceipts();
    }

    setupEventListeners() {
        const dropZone = document.getElementById('dropZone');
        const fileInput = document.getElementById('fileInput');
        const closeBtn = document.getElementById('closeBtn');

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
        
        for (const file of files) {
            console.log('Processing file:', file.name, 'type:', file.type);
            if (file.type === 'application/pdf') {
                console.log('File is PDF, calling processReceipt...');
                await this.processReceipt(file);
            } else {
                console.log('File is not PDF, showing error');
                this.showStatus('Only PDF files are supported', 'error');
            }
        }
    }

    async processReceipt(file) {
        console.log('=== START processReceipt ===');
        console.log('File name:', file.name);
        console.log('File size:', file.size);
        console.log('File type:', file.type);
        
        try {
            console.log('About to show status message...');
            this.showStatus('🔄 Processing receipt...', 'success');
            console.log('Status message shown successfully');
            
            // Send PDF to server for processing
            console.log('Sending PDF to server for processing...');
            
            console.log('Creating FormData...');
            const formData = new FormData();
            formData.append('pdf', file);
            console.log('FormData created, file appended');
            
            try {
                console.log('About to make fetch request...');
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 60000); // 60 second timeout
                
                const response = await fetch('https://bootleg-expensify.onrender.com/parse-receipt', {
                    method: 'POST',
                    body: formData,
                    signal: controller.signal
                });
                clearTimeout(timeoutId);
                console.log('Fetch request completed, response status:', response.status);
                
                if (!response.ok) {
                    throw new Error(`Server error: ${response.status}`);
                }
                
                console.log('About to parse JSON response...');
                const result = await response.json();
                console.log('Server response:', result);
                
                // Use the filename from the server
                const newFileName = result.filename || `Receipt_${new Date().toISOString().split('T')[0]}.pdf`;
                this.downloadFile(file, newFileName);
                
                // Show detailed confirmation
                if (result.success) {
                    this.showStatus(`✅ Receipt processed successfully!
📄 File: ${newFileName}
🏪 Vendor: ${result.vendor || 'Not detected'}
💰 Amount: $${result.amount || 'Not detected'}
📅 Date: ${result.receiptDate || 'Not detected'}`, 'success');
                } else {
                    this.showStatus(`⚠️ Partial processing completed
📄 File: ${newFileName}
Some details couldn't be extracted automatically.`, 'warning');
                }
                
            } catch (error) {
                console.error('Server processing failed:', error);
                console.error('Error type:', error.constructor.name);
                console.error('Error stack:', error.stack);
                
                let errorMessage = '';
                if (error.name === 'AbortError') {
                    errorMessage = '❌ Request timed out (60s limit exceeded)';
                } else if (error.message.includes('CORS')) {
                    errorMessage = '❌ CORS error - permission issue';
                } else if (error.message.includes('Failed to fetch')) {
                    errorMessage = '❌ Network error - cannot reach server';
                } else {
                    errorMessage = `❌ Server error: ${error.message}`;
                }
                
                this.showStatus(`${errorMessage}
Details: ${error.toString()}
Check console for more info.`, 'error');
                
                // Fallback to simple renaming
                const today = new Date().toISOString().split('T')[0];
                const newFileName = `Receipt_${today}_${file.name}`;
                this.downloadFile(file, newFileName);
            }
            
            return;
            console.log('PDF parsed successfully, pages:', pdf.numPages);
            
            let fullText = '';
            
            // Extract text from all pages
            for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
                try {
                    const page = await pdf.getPage(pageNum);
                    const textContent = await page.getTextContent();
                    
                    if (textContent && textContent.items && Array.isArray(textContent.items)) {
                        const pageText = textContent.items
                            .filter(item => item && item.str)
                            .map(item => item.str)
                            .join(' ');
                        fullText += pageText + ' ';
                    }
                } catch (pageError) {
                    console.warn(`Error processing page ${pageNum}:`, pageError);
                }
            }
            
            // Extract vendor and amount
            console.log('Extracted text length:', fullText.length);
            console.log('Extracted text preview:', fullText.substring(0, Math.min(500, fullText.length)));
            const metadata = this.extractMetadata(fullText);
            console.log('Extracted metadata:', metadata);
            
            if (metadata.vendor && metadata.amount) {
                const newFileName = `${metadata.vendor} - $${metadata.amount}.pdf`;
                
                // Store receipt
                const receipt = {
                    id: Date.now(),
                    originalName: file.name,
                    newName: newFileName,
                    vendor: metadata.vendor,
                    amount: metadata.amount,
                    dateProcessed: new Date().toISOString(),
                    data: arrayBuffer
                };
                
                this.receipts.push(receipt);
                await this.saveReceipts();
                
                // Auto-download the processed receipt
                this.downloadReceipt(receipt);
                
                this.showStatus(`Receipt processed: ${newFileName}`, 'success');
            } else {
                this.showStatus('Could not extract vendor and amount from PDF', 'error');
            }
            
        } catch (error) {
            console.error('Error processing receipt:', error);
            this.showStatus(`Error processing receipt: ${error.message}`, 'error');
        }
    }

    extractMetadata(text) {
        const metadata = { vendor: null, amount: null };
        
        // Enhanced vendor detection patterns
        const vendorPatterns = [
            // Specific companies from your receipts
            /(?:^|\s)(amazon|doordash|2modern|dynamo donut|starbucks|walmart|target|costco|home depot|best buy|apple|microsoft|google|uber|lyft|grubhub|mcdonalds|subway|chipotle)(?:\s|$)/i,
            
            // Email-based detection
            /(?:^|\s)([A-Za-z0-9\s&]+)\s+<[^>]+@([^>]+)>/i,
            
            // Order confirmation patterns
            /([A-Za-z0-9\s&]+)\s+Order\s+Confirmation/i,
            
            // Thank you patterns
            /Thank you for shopping at\s+([A-Za-z0-9\s&]+)/i,
            
            // Generic business patterns
            /(?:^|\s)([A-Z][a-zA-Z\s&]+?)\s+(?:Furniture|Lighting|Food|Delivery|Coffee|Restaurant|Store|Inc|LLC|Corp|Co\.)/i
        ];
        
        // Try to find vendor
        for (const pattern of vendorPatterns) {
            const match = text.match(pattern);
            if (match) {
                let vendor = match[1].trim();
                // Clean up common suffixes
                vendor = vendor.replace(/\s+(Inc|LLC|Corp|Co\.|Furniture|Lighting|Food|Delivery)$/i, '');
                metadata.vendor = vendor;
                break;
            }
        }
        
        // Enhanced amount patterns based on your receipts
        const amountPatterns = [
            // Most specific patterns first
            /Total[:\s]*\$(\d+\.\d{2})/i,
            /Grand Total[:\s]*\$(\d+\.\d{2})/i,
            /total[:\s]*\$(\d+\.\d{2})/i,
            /grand total[:\s]*\$(\d+\.\d{2})/i,
            
            // Payment patterns
            /Payment[:\s]*\$(\d+\.\d{2})/i,
            /Amount[:\s]*\$(\d+\.\d{2})/i,
            
            // Generic dollar patterns (less specific)
            /\$(\d+\.\d{2})/g
        ];
        
        const amounts = [];
        for (const pattern of amountPatterns) {
            let match;
            while ((match = pattern.exec(text)) !== null) {
                const amount = parseFloat(match[1]);
                if (amount > 0) {
                    amounts.push(amount);
                }
            }
        }
        
        // Use the largest amount found (likely the total)
        if (amounts.length > 0) {
            metadata.amount = Math.max(...amounts).toFixed(2);
        }
        
        return metadata;
    }

    async saveReceipts() {
        // Convert ArrayBuffer to base64 for storage
        const receiptsForStorage = this.receipts.map(receipt => ({
            ...receipt,
            data: this.arrayBufferToBase64(receipt.data)
        }));
        
        await chrome.storage.local.set({ receipts: receiptsForStorage });
    }

    async loadStoredReceipts() {
        try {
            // Clear any existing storage first to avoid corruption
            await chrome.storage.local.clear();
            console.log('Storage cleared');
            
            const result = await chrome.storage.local.get(['receipts']);
            if (result.receipts) {
                // Convert base64 back to ArrayBuffer
                this.receipts = result.receipts.map(receipt => ({
                    ...receipt,
                    data: this.base64ToArrayBuffer(receipt.data)
                }));
            }
        } catch (error) {
            console.error('Error loading stored receipts:', error);
            // Clear storage if there's an error
            await chrome.storage.local.clear();
            this.receipts = [];
        }
    }

    arrayBufferToBase64(buffer) {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    base64ToArrayBuffer(base64) {
        const binaryString = atob(base64);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        return bytes.buffer;
    }



    downloadReceipt(receipt) {
        const blob = new Blob([receipt.data], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = receipt.newName;
        a.click();
        URL.revokeObjectURL(url);
    }

    downloadFile(file, newName) {
        const url = URL.createObjectURL(file);
        const a = document.createElement('a');
        a.href = url;
        a.download = newName;
        a.click();
        URL.revokeObjectURL(url);
    }

    showStatus(message, type) {
        const status = document.getElementById('status');
        status.textContent = message;
        status.className = `status ${type}`;
        status.style.display = 'block';
        
        // Keep messages visible much longer, with special handling for multiline messages
        const duration = type === 'success' ? 12000 : 15000;
        setTimeout(() => {
            status.style.display = 'none';
        }, duration);
        
        // Handle multiline messages
        if (message.includes('\n')) {
            status.style.whiteSpace = 'pre-line';
            status.style.fontSize = '12px';
            status.style.lineHeight = '1.4';
        } else {
            status.style.whiteSpace = 'normal';
            status.style.fontSize = '14px';
            status.style.lineHeight = '1.2';
        }
    }
}

// Initialize the extension
console.log('=== ABOUT TO CREATE EXPENSEGADGET ===');
const expenseGadget = new ExpenseGadget();
console.log('=== EXPENSEGADGET CREATED ===');
