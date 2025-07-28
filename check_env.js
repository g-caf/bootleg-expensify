// Environment variable checker
console.log('🔧 ENVIRONMENT VARIABLE CHECK\n');

const requiredVars = [
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET', 
    'GOOGLE_REDIRECT_URI',
    'SESSION_SECRET',
    'OPENAI_API_KEY',
    'GOOGLE_SERVICE_ACCOUNT_JSON'
];

const optionalVars = [
    'PORT',
    'NODE_ENV'
];

console.log('✅ REQUIRED VARIABLES:');
requiredVars.forEach(varName => {
    const value = process.env[varName];
    const exists = !!value;
    const masked = exists ? `${value.substring(0, 10)}...${value.substring(value.length - 4)}` : 'NOT SET';
    console.log(`   ${exists ? '✅' : '❌'} ${varName}: ${masked}`);
});

console.log('\n📋 OPTIONAL VARIABLES:');
optionalVars.forEach(varName => {
    const value = process.env[varName];
    console.log(`   ${value ? '✅' : '⚪'} ${varName}: ${value || 'not set'}`);
});

console.log('\n🔍 GOOGLE OAUTH CONFIG:');
console.log(`   Client ID: ${process.env.GOOGLE_CLIENT_ID ? 'Set' : 'Missing'}`);
console.log(`   Client Secret: ${process.env.GOOGLE_CLIENT_SECRET ? 'Set' : 'Missing'}`);
console.log(`   Redirect URI: ${process.env.GOOGLE_REDIRECT_URI || 'https://bootleg-expensify-34h3.onrender.com/auth/google/callback'}`);

console.log('\n🎯 NEXT STEPS:');
const missing = requiredVars.filter(v => !process.env[v]);
if (missing.length > 0) {
    console.log(`❌ Missing required variables: ${missing.join(', ')}`);
    console.log('💡 Set these in your Render.com environment variables');
} else {
    console.log('✅ All required environment variables are set');
    console.log('💡 If emails still not working, check Gmail API quotas and permissions');
}
