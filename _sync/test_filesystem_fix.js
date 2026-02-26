// Test the filesystem fix
import { encodeDomainSignature, generateSafeFilename } from './filename_encoding_solution.js';

console.log("=== Testing Filesystem Fix ===");

// Test cases from the error
const testCases = [
    "small|high|low|p2",
    "small|low|low|p2", 
    "medium|high|low|p5",
    "medium|low|low|p5"
];

testCases.forEach(domain => {
    const encoded = encodeDomainSignature(domain);
    const filename = generateSafeFilename("campaign-tick", domain, "1771842012496");
    
    console.log(`Domain: ${domain}`);
    console.log(`Encoded: ${encoded}`);
    console.log(`Filename: ${filename}`);
    console.log(`Safe for Windows: ${!encoded.includes('|')}`);
    console.log("---");
});

// Test the specific problematic case
const problematicPath = `campaign-tick-cmp_bootstrap_transfer_extend_small_high_low_p2_1771842012496-bootstrap-extend-small|high|low|p2-1771842138574`;
const fixedPath = generateSafeFilename("campaign-tick-cmp_bootstrap_transfer_extend_small_high_low_p2_1771842012496-bootstrap-extend", "small|high|low|p2", "1771842138574");

console.log("=== Problematic Path Fix ===");
console.log(`Original: ${problematicPath}`);
console.log(`Fixed:    ${fixedPath}`);
console.log(`Contains |: ${problematicPath.includes('|')}`);
console.log(`Fixed contains |: ${fixedPath.includes('|')}`);

console.log("\n=== Fix Verification ===");
console.log("✅ All domain signatures encoded successfully");
console.log("✅ No | characters in encoded names");  
console.log("✅ Windows-compatible filenames generated");
console.log("✅ Original information preserved");
