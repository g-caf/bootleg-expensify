# Expense Gadget - Browser Extension Specification

## Overview
A Chrome browser extension that automatically processes PDF receipts, extracts vendor and amount information, renames files using a consistent format, and stores them locally for easy access during expense reporting.

## Core Requirements

### 1. File Processing
- **Input**: PDF files (receipts, invoices)
- **Output**: Renamed PDF files with format "Vendor - $Amount.pdf"
- **Method**: Drag-and-drop or file browser selection
- **Supported formats**: PDF only

### 2. Data Extraction
- **Primary data**: Vendor name and amount
- **Vendor detection**: Common merchant names (Amazon, Starbucks, etc.)
- **Amount detection**: Currency symbols, totals, various formats
- **Fallback**: Manual entry if extraction fails

### 3. Storage
- **Type**: Local browser storage (chrome.storage.local)
- **Data**: Original filename, new filename, vendor, amount, processing date, PDF binary
- **Size limit**: ~5-10GB per browser
- **Persistence**: Survives browser restarts

### 4. User Interface
- **Popup**: 350px wide, clean design
- **Drag zone**: Visual feedback for file drops
- **Receipt list**: View processed receipts with download options
- **Status messages**: Success/error feedback
- **Clear function**: Remove all stored receipts

## Technical Architecture

### Components
1. **manifest.json** - Extension configuration
2. **popup.html** - Main interface
3. **popup.js** - Core logic and PDF processing
4. **pdf.min.js** - PDF.js library for text extraction
5. **Icons** - Extension icons (16px, 48px, 128px)

### Data Flow
1. User drops PDF → File read as ArrayBuffer
2. PDF.js extracts text content
3. Regex patterns identify vendor and amount
4. File renamed and stored locally
5. UI updates with new receipt

### Security Considerations
- No external network requests (except PDF.js CDN)
- Local storage only
- No sensitive data transmission
- Minimal permissions (storage only)

## Deployment Strategy

### Individual Install
1. Load unpacked extension in Chrome developer mode
2. Pin to toolbar for easy access

### Team Deployment
1. Package as .crx file
2. Chrome Enterprise policy deployment
3. Or shared installation instructions

## Success Criteria
- Successfully extracts vendor/amount from 80%+ of common receipts
- Processes files in under 5 seconds
- Stores unlimited receipts within browser limits
- Zero data leakage outside local storage
- Works across team members independently

## Future Enhancements
- Google Drive integration
- OCR for scanned receipts
- Expense category detection
- Export to CSV/Excel
- Receipt search functionality
