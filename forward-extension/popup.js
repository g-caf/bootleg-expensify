// Popup controls for the Email Receipt Forwarder extension

class PopupController {
  constructor() {
    this.toggleSwitch = document.getElementById('toggleSwitch');
    this.statusText = document.getElementById('statusText');
    this.forwardedCount = document.getElementById('forwardedCount');
    
    this.initialize();
  }

  async initialize() {
    // Get current status from background script
    await this.updateStatus();
    
    // Set up event listeners
    this.toggleSwitch.addEventListener('click', () => this.handleToggle());
    
    // Update status every few seconds while popup is open
    this.statusInterval = setInterval(() => this.updateStatus(), 3000);
  }

  async updateStatus() {
    try {
      const response = await chrome.runtime.sendMessage({ action: 'getStatus' });
      
      if (response) {
        this.updateUI(response.isEnabled, response.forwardedCount);
      }
    } catch (error) {
      console.error('Failed to get status:', error);
    }
  }

  updateUI(isEnabled, count) {
    // Update toggle switch
    if (isEnabled) {
      this.toggleSwitch.classList.add('enabled');
      this.statusText.textContent = 'Monitoring enabled';
    } else {
      this.toggleSwitch.classList.remove('enabled');
      this.statusText.textContent = 'Disabled';
    }
    
    // Update forwarded count
    this.forwardedCount.textContent = count || 0;
  }

  async handleToggle() {
    try {
      // Disable the switch temporarily to prevent rapid clicks
      this.toggleSwitch.style.pointerEvents = 'none';
      
      const response = await chrome.runtime.sendMessage({ action: 'toggle' });
      
      // Update UI based on new state
      this.updateUI(response, parseInt(this.forwardedCount.textContent));
      
      // Re-enable the switch
      setTimeout(() => {
        this.toggleSwitch.style.pointerEvents = 'auto';
      }, 500);
      
    } catch (error) {
      console.error('Failed to toggle:', error);
      this.toggleSwitch.style.pointerEvents = 'auto';
    }
  }

  cleanup() {
    if (this.statusInterval) {
      clearInterval(this.statusInterval);
    }
  }
}

// Initialize popup when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  const popup = new PopupController();
  
  // Clean up when popup closes
  window.addEventListener('beforeunload', () => popup.cleanup());
});
