// Gmail API client for browser extension
class GmailClient {
    constructor() {
        this.isAuthenticated = false;
        this.accessToken = null;
    }

    async authenticate() {
        try {
            // Use Chrome extension identity API for OAuth
            const redirectURL = chrome.identity.getRedirectURL();
            const authURL = `https://accounts.google.com/oauth/authorize?` +
                `client_id=YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com&` +
                `response_type=token&` +
                `redirect_uri=${encodeURIComponent(redirectURL)}&` +
                `scope=${encodeURIComponent('https://www.googleapis.com/auth/gmail.readonly')}`;

            const responseUrl = await new Promise((resolve, reject) => {
                chrome.identity.launchWebAuthFlow(
                    {
                        url: authURL,
                        interactive: true
                    },
                    (responseUrl) => {
                        if (chrome.runtime.lastError) {
                            reject(new Error(chrome.runtime.lastError.message));
                        } else {
                            resolve(responseUrl);
                        }
                    }
                );
            });

            // Extract access token from response URL
            const urlParams = new URLSearchParams(responseUrl.split('#')[1]);
            this.accessToken = urlParams.get('access_token');
            
            if (this.accessToken) {
                this.isAuthenticated = true;
                // Store token for later use
                await chrome.storage.local.set({ gmailAccessToken: this.accessToken });
                return true;
            } else {
                throw new Error('No access token received');
            }
        } catch (error) {
            console.error('Gmail authentication error:', error);
            return false;
        }
    }

    async checkStoredAuth() {
        try {
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

// Export for use in popup
window.GmailClient = GmailClient;
