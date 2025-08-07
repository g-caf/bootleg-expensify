// Background script for Gmail monitoring and forwarding
class EmailForwarder {
  constructor() {
    this.isEnabled = true;
    this.forwardedEmails = new Set();
    this.patterns = [
      { vendor: 'Amazon', pattern: /amazon\.com.*receipt|order.*amazon/i },
      { vendor: 'Uber', pattern: /uber.*receipt|trip.*receipt/i },
      { vendor: 'DoorDash', pattern: /doordash.*receipt|order.*delivered/i }
    ];
    this.airbaseEmail = 'receipts@airbase.com';
  }

  async initialize() {
    // Load stored data
    const stored = await chrome.storage.local.get(['isEnabled', 'forwardedEmails']);
    this.isEnabled = stored.isEnabled !== false;
    this.forwardedEmails = new Set(stored.forwardedEmails || []);
    
    // Set up periodic checking
    chrome.alarms.create('checkEmails', { periodInMinutes: 12 });
  }

  async getGmailToken() {
    return new Promise((resolve, reject) => {
      chrome.identity.getAuthToken({ interactive: true }, (token) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          resolve(token);
        }
      });
    });
  }

  async fetchRecentEmails() {
    try {
      const token = await this.getGmailToken();
      const response = await fetch(
        'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=newer_than:1d&maxResults=50',
        {
          headers: { 'Authorization': `Bearer ${token}` }
        }
      );
      
      const data = await response.json();
      return data.messages || [];
    } catch (error) {
      console.error('Failed to fetch emails:', error);
      return [];
    }
  }

  async getEmailDetails(messageId) {
    try {
      const token = await this.getGmailToken();
      const response = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}`,
        {
          headers: { 'Authorization': `Bearer ${token}` }
        }
      );
      
      return await response.json();
    } catch (error) {
      console.error('Failed to get email details:', error);
      return null;
    }
  }

  matchesPattern(subject, body) {
    const text = `${subject} ${body}`.toLowerCase();
    return this.patterns.find(p => p.pattern.test(text));
  }

  async forwardEmail(emailData, matchedPattern) {
    try {
      const token = await this.getGmailToken();
      
      // Create forwarded email
      const forwardedMessage = {
        to: this.airbaseEmail,
        subject: `[Forwarded Receipt - ${matchedPattern.vendor}] ${emailData.subject}`,
        body: `Automatically forwarded receipt from ${matchedPattern.vendor}\n\nOriginal message:\n${emailData.body}`
      };

      // Send via Gmail API (simplified)
      const response = await fetch(
        'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            raw: btoa(unescape(encodeURIComponent(
              `To: ${forwardedMessage.to}\r\nSubject: ${forwardedMessage.subject}\r\n\r\n${forwardedMessage.body}`
            )))
          })
        }
      );

      if (response.ok) {
        this.forwardedEmails.add(emailData.id);
        await this.saveState();
        console.log(`Forwarded ${matchedPattern.vendor} receipt:`, emailData.subject);
        return true;
      }
    } catch (error) {
      console.error('Failed to forward email:', error);
    }
    return false;
  }

  async processEmails() {
    if (!this.isEnabled) return;

    const messages = await this.fetchRecentEmails();
    let forwardedCount = 0;

    for (const message of messages) {
      if (this.forwardedEmails.has(message.id)) continue;

      const emailData = await this.getEmailDetails(message.id);
      if (!emailData) continue;

      const subject = emailData.payload?.headers?.find(h => h.name === 'Subject')?.value || '';
      const body = this.extractBody(emailData.payload);
      
      const match = this.matchesPattern(subject, body);
      if (match) {
        const success = await this.forwardEmail({ id: message.id, subject, body }, match);
        if (success) forwardedCount++;
      }
    }

    if (forwardedCount > 0) {
      chrome.action.setBadgeText({ text: forwardedCount.toString() });
      chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
    }
  }

  extractBody(payload) {
    if (payload.body?.data) {
      return atob(payload.body.data.replace(/-/g, '+').replace(/_/g, '/'));
    }
    if (payload.parts) {
      for (const part of payload.parts) {
        const body = this.extractBody(part);
        if (body) return body;
      }
    }
    return '';
  }

  async saveState() {
    await chrome.storage.local.set({
      isEnabled: this.isEnabled,
      forwardedEmails: Array.from(this.forwardedEmails)
    });
  }

  async toggle() {
    this.isEnabled = !this.isEnabled;
    await this.saveState();
    return this.isEnabled;
  }
}

// Initialize
const forwarder = new EmailForwarder();

chrome.runtime.onInstalled.addListener(() => {
  forwarder.initialize();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'checkEmails') {
    forwarder.processEmails();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'toggle') {
    forwarder.toggle().then(sendResponse);
    return true;
  }
  if (message.action === 'getStatus') {
    sendResponse({ 
      isEnabled: forwarder.isEnabled,
      forwardedCount: forwarder.forwardedEmails.size
    });
  }
});
