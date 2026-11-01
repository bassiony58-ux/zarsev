const { runExtractionTests } = require('./test_extraction');
const { runManufacturerAssignmentTests } = require('./test_manufacturer_assignment');
const { runAuthorizationTests } = require('./test_authorization');
const { runDuplicateDetectionTests } = require('./test_duplicate_detection');
const { runApprovalWorkflowTests } = require('./test_approval_workflow');
const { runE2EVerification } = require('./e2e_flow_verification');
const { runSecurityP0Tests } = require('./test_security_p0');
const { runRemediationTests } = require('./test_phase1_1_remediation');

async function main() {
    console.log('================================================================');
    console.log('⚓ ZARSEV Smart Product Import & AI Catalog Automation Test Suite');
    console.log('================================================================\n');

    const start = Date.now();

    await runExtractionTests();
    await runManufacturerAssignmentTests();
    await runAuthorizationTests();
    await runDuplicateDetectionTests();
    await runApprovalWorkflowTests();
    await runE2EVerification();
    await runSecurityP0Tests();
    await runRemediationTests();

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log('================================================================');
    console.log(`🎉 ALL 8 TEST SUITES (INCLUDING REMEDIATION) PASSED IN ${elapsed}s!`);
    console.log('================================================================');
}

main().catch(err => {
    console.error('Fatal Test Runner Error:', err);
    process.exit(1);
});
