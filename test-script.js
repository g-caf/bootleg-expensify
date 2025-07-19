console.log('=== EXTERNAL TEST SCRIPT RUNNING ===');

document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM loaded in external script');
    
    const button = document.getElementById('testBtn');
    if (button) {
        button.addEventListener('click', () => {
            console.log('External script: Button clicked!');
            alert('External script works!');
        });
        console.log('Event listener attached by external script');
    } else {
        console.error('Test button not found');
    }
});
