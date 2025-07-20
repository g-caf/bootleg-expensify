function extractVendor(text) {
    // Simple fallback for common cases where domain extraction might miss
    const commonVendors = [
        { pattern: /amazon/i, name: 'Amazon' },
        { pattern: /starbucks/i, name: 'Starbucks' },
        { pattern: /target/i, name: 'Target' },
        { pattern: /walmart/i, name: 'Walmart' },
        { pattern: /costco/i, name: 'Costco' }
    ];

    for (const vendor of commonVendors) {
        if (vendor.pattern.test(text)) {
            return vendor.name;
        }
    }

    return null;
}
