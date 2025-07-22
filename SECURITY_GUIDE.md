# Security-First Gmail Monitoring Setup

## 🔒 Security Principles

This implementation prioritizes security over convenience. Here's how:

### **Data Minimization**
- **No email content stored locally** - everything processed server-side
- **Only metadata cached** - email IDs and timestamps only
- **Automatic cleanup** - old data removed every 24 hours
- **Session-based processing** - no persistent storage of sensitive data

### **Authentication Security**
- **Server-side auth only** - no tokens stored in extension
- **HTTP-only cookies** - prevents JavaScript access to auth tokens
- **Short session timeouts** - automatic re-authentication required
- **Rate limiting** - prevents abuse and excessive API calls

### **Processing Security**
- **AI confidence thresholds** - only high-confidence receipts processed
- **Minimal data exposure** - AI sees only headers for initial classification
- **Server-side processing** - email content never touches browser storage
- **Audit logging** - all processing actions logged server-side

## 📋 Setup Steps

### **Step 1: Enable Background Service Worker**

Update your `manifest.json`:
```json
{
  "background": {
    "service_worker": "background.js",
    "type": "module"
  },
  "permissions": [
    "storage",
    "alarms"
  ]
}
```

### **Step 2: Load the Extension**
1. Open Chrome Extension Developer Mode
2. Click "Load unpacked" 
3. Select your extension directory
4. Verify background service worker is active

### **Step 3: Authenticate with Gmail**
1. Click extension icon
2. Click "Connect to Google" if not already connected
3. Grant Gmail permissions (read-only access)
4. Extension will show "Autoscan" button when ready

### **Step 4: Start Monitoring**
1. Click "Start Monitoring" button
2. Extension begins checking emails every 10 minutes
3. Status shows "📧 Monitoring active"
4. Receipts automatically processed and sent to Airbase

## 🔍 How It Works

### **Secure Monitoring Flow**
```
Every 10 minutes:
1. Background service checks auth status
2. If authenticated, requests server email check
3. Server searches Gmail for new receipts (server-side only)
4. AI analyzes email headers for receipt classification
5. High-confidence receipts are processed with full content
6. Chunked emails created and sent to Airbase
7. Results logged, no email content stored
```

### **Security Checkpoints**
- ✅ User must be authenticated (checked each cycle)
- ✅ Rate limiting (max 1 check per 5 minutes)
- ✅ Email limit (max 20 emails per check)
- ✅ Confidence threshold (only process >70% confidence)
- ✅ No local storage of email content
- ✅ Automatic session cleanup

## 🛡️ Security Features

### **Rate Limiting**
```javascript
// Multiple layers of rate limiting
Extension: 10 minute intervals (not configurable)
Server: 5 minute minimum between requests  
API: 20 requests per 15 minutes maximum
```

### **Data Encryption**
```javascript
// All sensitive data encrypted in transit
HTTPS: All API communications
Session: HTTP-only secure cookies
Storage: Only non-sensitive metadata stored locally
```

### **Access Control**
```javascript
// Minimal permissions model
Gmail: Read-only access to user emails
Server: Session-based authentication only
Extension: No persistent background permissions
```

### **Audit Trail**
```javascript
// Complete audit logging
Server: All email processing logged
Extension: Monitoring status changes logged
Errors: Full error context logged (no email content)
```

## 📊 Monitoring Dashboard

### **Status Indicators**
- 🟢 **Active**: "📧 Monitoring active (last: 2 min ago)"
- 🔴 **Stopped**: "Start email monitoring"
- ⚠️ **Auth Required**: "Connect to Google"
- ❌ **Error**: "Authentication expired - please reconnect"

### **Controls**
- **Start Monitoring**: Begins automatic email checking
- **Stop Monitoring**: Stops checking and cleans up data
- **Manual Screenshot**: Fallback for individual receipts
- **Manual Search**: Search and forward specific emails

## 🚨 Security Alerts

### **When to Be Concerned**
- Extension requests additional permissions
- Monitoring frequency increases unexpectedly
- Large amounts of data stored locally
- Authentication tokens visible in storage
- Email content cached locally

### **Security Best Practices**
1. **Review permissions regularly** - check what access the extension has
2. **Monitor Airbase inbox** - verify only expected receipts are received
3. **Check background activity** - monitor network requests in dev tools
4. **Regular restarts** - restart browser weekly to clear any cached data
5. **Update promptly** - install security updates immediately

## ⚙️ Configuration Options

### **Environment Variables (Server)**
```bash
# Required for AI features (optional)
OPENAI_API_KEY=your_key_here

# Required for Gmail integration
GOOGLE_CLIENT_ID=your_client_id
GOOGLE_CLIENT_SECRET=your_client_secret

# Security settings
SESSION_SECRET=your_secure_secret
NODE_ENV=production
```

### **Security Settings (Built-in)**
```javascript
// These cannot be modified for security
CHECK_INTERVAL: 10 minutes (minimum)
MAX_EMAILS_PER_CHECK: 20
CONFIDENCE_THRESHOLD: 0.7
RATE_LIMIT_INTERVAL: 5 minutes
SESSION_TIMEOUT: 60 minutes
CLEANUP_INTERVAL: 24 hours
```

## 🔧 Troubleshooting

### **Monitoring Not Starting**
1. Check Gmail authentication status
2. Verify server is running and accessible
3. Check browser console for errors
4. Try stopping and restarting monitoring

### **Receipts Not Being Processed**
1. Verify emails contain receipt keywords
2. Check AI confidence scores in server logs
3. Ensure email dates are recent (last 24 hours)
4. Try manual processing to test functionality

### **Authentication Issues**
1. Clear browser cookies for the extension domain
2. Revoke and re-grant Gmail permissions
3. Check Google account 2FA settings
4. Verify server OAuth configuration

## 📝 Privacy Notice

### **Data We Process**
- Email headers (from, subject, date)
- Email content (for receipt analysis only)
- Receipt amounts and vendor information
- Processing timestamps and results

### **Data We DON'T Store**
- Full email content (processed and discarded)
- Email attachments
- Personal communications
- Non-receipt emails
- Authentication tokens (server-side only)

### **Data Retention**
- Email IDs: 24 hours maximum
- Processing logs: Server-side only
- Authentication: Session-based (expires hourly)
- Cleanup: Automatic every 24 hours

This security-first approach ensures your financial data remains protected while providing automated receipt processing.
