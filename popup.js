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
            const authUrl = 'https://bootleg-expensify-34h3.onrender.com/auth/google';
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
            // ONLY trust server token - don't use stored tokens
            const serverToken = await this.getTokenFromServer();
            
            if (serverToken) {
                this.accessToken = serverToken;
                this.isAuthenticated = true;
                await chrome.storage.local.set({ gmailAccessToken: serverToken });
                return true;
            } else {
                // Server says not authenticated - clear any stale local data
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
                    this.isAuthenticated = false;
                    this.accessToken = null;
                    await chrome.storage.local.remove(['gmailAccessToken']);
                    
                    // Update UI to show "Connect to Google" state
                    const expenseGadget = window.expenseGadget;
                    if (expenseGadget) {
                        expenseGadget.updateGmailAuthStatus(false);
                    }
                    
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
        this.gmailClient = null;
        this.searchDebounceTimer = null;
    }

    async init() {
        console.log('=== INITIALIZING EXPENSE GADGET ===');
        this.setupEventListeners();
        
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
        const searchBtn = document.getElementById('searchBtn');

        // Close button
        closeBtn.addEventListener('click', () => {
            window.close();
        });

        // Search button - handles both auth and search
        searchBtn.addEventListener('click', async () => {
            if (!this.gmailClient.isAuthenticated) {
                await this.handleGmailAuth();
            } else {
                await this.handleSearch();
            }
        });

        // Search input with debounce
        searchInput.addEventListener('input', (e) => {
            this.handleSearchInput(e.target.value);
        });

        // Event delegation for send buttons (dynamically created)
        document.addEventListener('click', (e) => {
            if (e.target.classList.contains('send-btn')) {
                const emailId = e.target.getAttribute('data-email-id');
                if (emailId) {
                    this.forwardEmailToAirbase(emailId, e.target);
                }
            }
        });
    }

    async checkGmailAuth() {
        try {
            const isAuthenticated = await this.gmailClient.checkStoredAuth();
            this.updateGmailAuthStatus(isAuthenticated);
        } catch (error) {
            console.error('Error checking Gmail auth:', error);
            this.updateGmailAuthStatus(false);
        }
    }

    updateGmailAuthStatus(isAuthenticated) {
        const searchBtn = document.getElementById('searchBtn');
        const searchInput = document.getElementById('searchInput');
        
        if (isAuthenticated) {
            searchBtn.textContent = 'Search Gmail';
            searchBtn.disabled = false;
            searchBtn.classList.remove('connect');
            searchInput.disabled = false;
            searchInput.placeholder = 'Search your email for receipts...';
        } else {
            searchBtn.textContent = 'Connect to Gmail';
            searchBtn.disabled = false;
            searchBtn.classList.add('connect');
            searchInput.disabled = true;
            searchInput.placeholder = 'Connect to Gmail to search...';
            this.clearSearchResults();
        }
    }

    async handleGmailAuth() {
        try {
            this.showLoading(true);
            const success = await this.gmailClient.authenticate();
            
            if (success) {
                this.updateGmailAuthStatus(true);
                this.showStatusMessage('Connected to Gmail successfully!', 'success');
            } else {
                this.showStatusMessage('Failed to connect to Gmail. Please try again.', 'error');
            }
        } catch (error) {
            console.error('Gmail auth error:', error);
            this.showStatusMessage('Error connecting to Gmail', 'error');
        } finally {
            this.showLoading(false);
        }
    }

    handleSearchInput(query) {
        // Clear existing timer
        if (this.searchDebounceTimer) {
            clearTimeout(this.searchDebounceTimer);
        }

        // Set new timer for debounced search
        if (query.trim() && this.gmailClient.isAuthenticated) {
            this.searchDebounceTimer = setTimeout(() => {
                this.performSearch(query);
            }, 500); // 500ms debounce
        } else if (!query.trim()) {
            this.clearSearchResults();
        }
    }

    async handleSearch() {
        const searchInput = document.getElementById('searchInput');
        const query = searchInput.value.trim();
        
        if (!query) {
            this.showStatusMessage('Please enter a search term', 'error');
            return;
        }

        await this.performSearch(query);
    }

    async performSearch(query) {
        try {
            this.showLoading(true);
            console.log('Searching Gmail for:', query);
            
            const emails = await this.gmailClient.searchEmails(query, 20);
            console.log('Search results:', emails.length, 'emails found');
            
            this.displaySearchResults(emails);
            
            if (emails.length === 0) {
                this.showStatusMessage('No emails found for your search', 'info');
            }
        } catch (error) {
            console.error('Search error:', error);
            this.showStatusMessage('Error searching emails', 'error');
        } finally {
            this.showLoading(false);
        }
    }

    displaySearchResults(emails) {
        const searchResults = document.getElementById('searchResults');
        
        if (!emails || emails.length === 0) {
            searchResults.innerHTML = '<div class="status-message">No results found</div>';
            return;
        }

        let html = '';
        emails.forEach(email => {
            html += `
                <div class="search-result-item">
                    <div class="search-result-header">
                        <div class="search-result-left">
                            <div class="search-result-subject">${this.escapeHtml(email.subject)}</div>
                            <div class="search-result-from">${this.escapeHtml(email.from)}</div>
                        </div>
                        <div class="search-result-right">
                            <div class="search-result-date">${this.formatDate(email.date)}</div>
                            <button class="send-btn" data-email-id="${email.id}">Send to Airbase</button>
                        </div>
                    </div>
                </div>
            `;
        });

        searchResults.innerHTML = html;
    }

    async forwardEmailToAirbase(emailId, buttonElement) {
        try {
            console.log('Forwarding email to Airbase:', emailId);
            
            // Update button state
            buttonElement.disabled = true;
            buttonElement.textContent = 'Sending...';
            
            // Get full email content
            const emailContent = await this.gmailClient.getFullMessageContent(emailId);
            if (!emailContent) {
                throw new Error('Failed to get email content');
            }

            // Send to Airbase
            const response = await fetch('https://bootleg-expensify-34h3.onrender.com/forward-email', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    emailId: emailId,
                    subject: emailContent.subject,
                    from: emailContent.from,
                    date: emailContent.date,
                    body: emailContent.body
                })
            });

            const result = await response.json();

            if (result.success) {
                buttonElement.textContent = '✓ Sent';
                buttonElement.style.background = '#10b981';
                this.showStatusMessage('Email forwarded to Airbase successfully!', 'success');
            } else {
                throw new Error(result.error || 'Failed to forward email');
            }
        } catch (error) {
            console.error('Forward error:', error);
            buttonElement.textContent = 'Error';
            buttonElement.style.background = '#ef4444';
            this.showStatusMessage('Failed to forward email to Airbase', 'error');
        }
    }

    clearSearchResults() {
        const searchResults = document.getElementById('searchResults');
        searchResults.innerHTML = '';
    }

    showLoading(show) {
        const loading = document.getElementById('loading');
        if (show) {
            loading.classList.add('show');
        } else {
            loading.classList.remove('show');
        }
    }

    showStatusMessage(message, type = 'info') {
        const searchResults = document.getElementById('searchResults');
        const statusClass = type === 'success' ? 'status-success' : 
                           type === 'error' ? 'status-error' : '';
        
        const statusHtml = `<div class="status-message ${statusClass}">${message}</div>`;
        
        // If there are existing results, prepend the status message
        if (searchResults.innerHTML.trim() && !searchResults.innerHTML.includes('status-message')) {
            searchResults.innerHTML = statusHtml + searchResults.innerHTML;
        } else if (!searchResults.innerHTML.trim()) {
            searchResults.innerHTML = statusHtml;
        }
        
        // Auto-hide success messages after 3 seconds
        if (type === 'success') {
            setTimeout(() => {
                const statusElement = searchResults.querySelector('.status-message.status-success');
                if (statusElement) {
                    statusElement.remove();
                }
            }, 3000);
        }
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

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}
