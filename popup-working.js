// Minimal working popup script
console.log('=== POPUP SCRIPT LOADED ===');

// Wait for DOM to be ready
document.addEventListener('DOMContentLoaded', function() {
    console.log('DOM loaded, initializing...');
    
    // Find the scan button
    const scanBtn = document.getElementById('gmailScanBtn');
    if (scanBtn) {
        console.log('Found scan button:', scanBtn.textContent);
        
        // Set to connect state initially
        scanBtn.textContent = 'Connect to Google';
        scanBtn.className = 'scan-btn connect';
        scanBtn.disabled = false;
        
        scanBtn.addEventListener('click', function() {
            console.log('Scan button clicked');
            if (scanBtn.textContent === 'Connect to Google') {
                // Open auth window
                const authUrl = 'https://bootleg-expensify-34h3.onrender.com/auth/google';
                window.open(authUrl, '_blank', 'width=500,height=600');
            }
        });
        
        console.log('Button event listener added');
    } else {
        console.error('Scan button not found');
    }
});

console.log('=== POPUP SCRIPT END ===');
