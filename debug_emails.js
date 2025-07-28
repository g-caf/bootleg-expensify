// Debug script to test email monitoring directly
const { google } = require('googleapis');
const fs = require('fs');

// First, let's test a simple Gmail search to see what emails we can find
async function testGmailSearch() {
    console.log('🔍 Testing Gmail search functionality...');
    
    // You'll need to paste your tokens here from the browser storage
    // or we can modify the server to add a debug endpoint
    
    const since = new Date(Date.now() - (24 * 60 * 60 * 1000)); // 24 hours ago
    const formattedDate = since.toISOString().split('T')[0].replace(/-/g, '/');
    
    console.log('📅 Search date:', formattedDate);
    
    // Various test queries
    const queries = [
        `after:${formattedDate} -label:spam -label:trash`,
        `after:${formattedDate} doordash`,
        `after:${formattedDate} receipt`,
        `after:${formattedDate} invoice`,
        `after:${formattedDate} order confirmation`,
        `after:${formattedDate} (from:amazon.com OR from:uber.com OR from:doordash.com)`
    ];
    
    console.log('Test queries to try:');
    queries.forEach((q, i) => {
        console.log(`${i + 1}. ${q}`);
    });
    
    console.log('\n📧 You can test these queries manually in Gmail to see what results you get');
    console.log('💡 Try going to Gmail and using the search bar with these queries');
}

// Test the server directly
async function testServerDirectly() {
    console.log('🖥️ Testing server monitoring endpoint...');
    
    const testData = {
        since: Date.now() - (24 * 60 * 60 * 1000),
        maxEmails: 20,
        securityMode: true,
        isCatchup: true
    };
    
    console.log('📊 Test data:', testData);
    console.log('🔗 Server URL: https://bootleg-expensify-34h3.onrender.com/monitor-emails');
    console.log('\n💡 You can test this with curl:');
    console.log(`curl -X POST https://bootleg-expensify-34h3.onrender.com/monitor-emails \\
  -H "Content-Type: application/json" \\
  -H "Cookie: your-session-cookie-here" \\
  -d '${JSON.stringify(testData)}'`);
}

async function main() {
    console.log('🐛 EMAIL DEBUGGING TOOL\n');
    
    await testGmailSearch();
    console.log('\n' + '='.repeat(50) + '\n');
    await testServerDirectly();
    
    console.log('\n🔧 DEBUGGING STEPS:');
    console.log('1. Check if you have any emails matching the search criteria in Gmail manually');
    console.log('2. Check the browser Network tab when clicking catchup to see the actual server request/response');
    console.log('3. Check the browser Console for any error messages');
    console.log('4. Check if the server is returning any errors (401, 429, 500, etc.)');
}

main().catch(console.error);
