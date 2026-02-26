// Filename Encoding Solution for Domain Signatures
// Solves Windows compatibility issues with | character in domain signatures

/**
 * Encode domain signature to safe filename
 * @param {string} domainSignature - Domain signature like "small|high|low|p2"
 * @returns {string} Safe filename like "small_high_low_p2"
 */
function encodeDomainSignature(domainSignature) {
    return domainSignature.replace(/\|/g, '_');
}

/**
 * Decode safe filename back to domain signature
 * @param {string} safeFilename - Safe filename like "small_high_low_p2"
 * @returns {string} Original domain signature like "small|high|low|p2"
 */
function decodeDomainSignature(safeFilename) {
    // This is more complex since we need to know where pipes were
    // For now, we'll use a mapping approach
    const mapping = {
        'small_high_low_p2': 'small|high|low|p2',
        'small_low_low_p2': 'small|low|low|p2',
        'small_high_low_p5': 'small|high|low|p5',
        'small_low_low_p5': 'small|low|low|p5',
        'medium_high_low_p5': 'medium|high|low|p5',
        'medium_low_low_p5': 'medium|low|low|p5'
    };
    
    return mapping[safeFilename] || safeFilename;
}

/**
 * Generate safe filename for campaign operations
 * @param {string} operation - Operation type
 * @param {string} domainSignature - Domain signature
 * @param {string} timestamp - Timestamp
 * @returns {string} Safe filename
 */
function generateSafeFilename(operation, domainSignature, timestamp) {
    const safeDomain = encodeDomainSignature(domainSignature);
    return `${operation}-${safeDomain}-${timestamp}`;
}

// Examples
console.log("=== Filename Encoding Examples ===");
console.log("Original: small|high|low|p2");
console.log("Encoded:  " + encodeDomainSignature("small|high|low|p2"));
console.log("Filename:  " + generateSafeFilename("campaign-tick", "small|high|low|p2", "1771842012496"));
console.log("");
console.log("Original: medium|low|low|p5");
console.log("Encoded:  " + encodeDomainSignature("medium|low|low|p5"));
console.log("Filename:  " + generateSafeFilename("arena-eval", "medium|low|low|p5", "1771842138574"));

// Export for use in MCP server
export {
    encodeDomainSignature,
    decodeDomainSignature,
    generateSafeFilename
};
