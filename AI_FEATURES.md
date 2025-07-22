# AI-Enhanced Receipt Processing

The Expense Gadget extension now includes AI-powered email analysis for smarter receipt processing.

## Features

### 🤖 AI Email Analysis
- **Receipt Classification**: Distinguishes receipts from promotional emails, shipping updates, etc.
- **Vendor Detection**: Identifies Amazon, Uber, DoorDash, and other vendors
- **Confidence Scoring**: Provides confidence levels for processing decisions
- **Smart Categorization**: Suggests expense categories based on content

### 💰 Intelligent Amount Extraction
- **Context-Aware**: Understands pricing structure (totals vs. individual items)
- **Discount Handling**: Excludes promotional discounts and original prices
- **Tax Logic**: Handles tax-inclusive vs. itemized amounts appropriately
- **Multi-Format Support**: Recognizes various price formats ($123.45, USD 123.45, etc.)

### 🧠 Smart Chunking Decisions
- **Amazon Logic**: Chunks by shipment/delivery, not individual items
- **Restaurant Logic**: Single email even if itemized
- **Hotel Logic**: Single email for entire stay
- **Uber Logic**: Single email per trip

## Setup

### Environment Variables
```bash
# Required for AI features (optional - falls back to pattern matching)
OPENAI_API_KEY=your_openai_api_key_here

# Existing variables
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
# ... other existing variables
```

### Without OpenAI API Key
The system gracefully falls back to pattern-based analysis:
- Basic vendor detection using email domains
- Regular expression amount extraction
- Simple chunking rules

## How It Works

### 1. Email Analysis Pipeline
```
Email received → AI Analysis → Receipt Classification → Amount Extraction → Chunking Decision → Send to Airbase
```

### 2. AI Processing
When an email is processed:
1. **Content Analysis**: AI examines email content, subject, and sender
2. **Receipt Detection**: Determines if this is actually a receipt vs. marketing
3. **Amount Identification**: Extracts transaction amounts (not totals/discounts)
4. **Chunking Strategy**: Decides whether to split into multiple emails
5. **Email Creation**: Generates focused emails for each transaction

### 3. Fallback System
- **No API Key**: Uses pattern matching
- **AI Failure**: Automatically falls back to pattern matching
- **Low Confidence**: Uses conservative pattern-based approach

## Testing

### Test AI Analysis (Development)
```bash
POST /test-ai-analysis
{
  "emailContent": "Your email content here...",
  "emailSubject": "Amazon Order Confirmation",
  "emailFrom": "auto-confirm@amazon.com"
}
```

### Response Example
```json
{
  "success": true,
  "analysis": {
    "isReceipt": true,
    "confidence": 0.95,
    "vendor": "Amazon",
    "amounts": ["$45.67", "$23.45", "$12.34"],
    "transactionCount": 3,
    "shouldChunk": true,
    "category": "office_supplies",
    "reasoning": "Amazon order with multiple shipments detected"
  },
  "hasOpenAI": true
}
```

## Benefits

### For Users
- **Smarter Processing**: AI understands context better than simple patterns
- **Fewer Errors**: Reduces false positives and improves matching accuracy
- **Better Categorization**: Automatic expense category suggestions
- **Cleaner Emails**: More focused, relevant content sent to Airbase

### For Airbase Matching
- **Clear Labels**: Each email clearly labeled with transaction amount
- **Relevant Content**: Only shows content related to specific transaction
- **Better Context**: AI-enhanced descriptions for easier matching

## Examples

### Amazon Order Processing
```
Original email: Amazon order with 3 items, $81.46 total
AI Analysis: Detects 3 shipments at $45.67, $23.45, $12.34
Result: 3 separate emails to Airbase, each clearly labeled
```

### Restaurant Receipt
```
Original email: Restaurant receipt with itemized bill
AI Analysis: Recognizes single dining transaction
Result: 1 email with complete receipt
```

### Marketing Email
```
Original email: "Amazon deals this week!"
AI Analysis: Not a receipt (confidence: 0.1)
Result: Email ignored, not sent to Airbase
```

## Future Enhancements

### Planned Features
- **Learning System**: AI learns from user corrections
- **Receipt Validation**: Flags suspicious or incomplete receipts
- **Duplicate Detection**: Identifies potential duplicate submissions
- **Predictive Processing**: Auto-categorizes based on user patterns

### Integration Opportunities
- **Calendar Integration**: Context from meeting schedules
- **Travel Integration**: Enhanced hotel/flight receipt processing
- **Approval Workflows**: Smart routing based on amount/category
